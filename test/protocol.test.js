// 协议编解码与注册/中继流程的自测
// 运行：node test/protocol.test.js
// 不依赖任何第三方库，使用 Node 内置 assert。

import assert from "node:assert/strict";

import { Reader, Writer, decodePacked } from "../node-functions/_vnt/protobuf.js";
import {
  NetPacket,
  MsgType,
  HEAD_LENGTH,
  ipToU32,
  u32ToIp,
  buildPacket,
  parseHeaderFast,
  maskToPrefixLen,
  prefixLenToMask,
  decrTtlInPlace,
} from "../node-functions/_vnt/packet.js";
import {
  decodeRequestMessage,
  encodeRegResponse,
  encodeErrorResponse,
  encodeClientSimpleInfoList,
  decodeSelectiveBroadcast,
  decodeRpcRequest,
  encodeRpcResponse,
  ClientType,
} from "../node-functions/_vnt/control-messages.js";
import { registry, resolveConfig } from "../node-functions/_vnt/state.js";
import { Session } from "../node-functions/_vnt/server.js";

let passed = 0;
let failed = 0;
const pending = [];

/**
 * 登记一个用例。**支持 async** ——
 * 早期版本直接调用 fn()，异步用例的 rejection 会逃出 try/catch 变成
 * 未捕获异常，失败被静默算作通过。这里统一收集后按序 await。
 */
function test(name, fn) {
  pending.push({ name, fn });
}

async function runAll() {
  for (const { name, fn } of pending) {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (e) {
      failed++;
      console.error(`  ✗ ${name}\n    ${e.message}`);
      process.exitCode = 1;
    }
  }
}

// ---------------------------------------------------------------------------
// 1. protobuf varint 往返
// ---------------------------------------------------------------------------
console.log("protobuf 基础");
test("varint 往返 (小值)", () => {
  for (const v of [0, 1, 127, 128, 300, 16383, 16384, 70000]) {
    const w = new Writer();
    w.writeVarint(v);
    const r = new Reader(w.finish());
    assert.equal(r.readVarint(), v);
  }
});
test("varint 往返 (u64 大值)", () => {
  const big = 18446744073709551615n; // u64 max
  const w = new Writer();
  w.writeVarint(big);
  const r = new Reader(w.finish());
  assert.equal(r.readVarint(), Number(big));
});
test("fixed32 小端", () => {
  const w = new Writer();
  w.writeFixed32(0x0a1a0001);
  const bytes = w.finish();
  assert.deepEqual(Array.from(bytes), [0x01, 0x00, 0x1a, 0x0a]);
  assert.equal(new Reader(bytes).readFixed32(), 0x0a1a0001);
});

// ---------------------------------------------------------------------------
// 2. IPv4 与掩码换算
// ---------------------------------------------------------------------------
console.log("IP 工具");
test("ipToU32 / u32ToIp 往返", () => {
  for (const s of ["10.26.0.1", "192.168.1.254", "255.255.255.0", "0.0.0.0"]) {
    assert.equal(u32ToIp(ipToU32(s)), s);
  }
  assert.equal(ipToU32("10.26.0.1"), 0x0a1a0001);
});
test("掩码 <-> 前缀长度", () => {
  assert.equal(maskToPrefixLen("255.255.255.0"), 24);
  assert.equal(maskToPrefixLen("255.255.0.0"), 16);
  assert.equal(maskToPrefixLen("255.255.255.255"), 32);
  assert.equal(prefixLenToMask(24), ipToU32("255.255.255.0"));
  assert.equal(prefixLenToMask(16), ipToU32("255.255.0.0"));
});

// ---------------------------------------------------------------------------
// 3. VNT 2.x 帧头
// ---------------------------------------------------------------------------
console.log("VNT 2.x 帧头");
test("构造并解析 16 字节头", () => {
  const pkt = buildPacket({
    msgType: MsgType.Turn,
    ttl: 15,
    gateway: false,
    seq: 42,
    src: ipToU32("10.26.0.2"),
    dest: ipToU32("10.26.0.3"),
    payload: new Uint8Array([1, 2, 3]),
  });
  const raw = pkt.toUint8Array();
  assert.equal(raw.length, HEAD_LENGTH + 3);
  assert.equal(raw[0], (MsgType.Turn & 0x7f) | 0x80);
  body: {
    const h = parseHeaderFast(raw);
    assert.equal(h.msgType, MsgType.Turn);
    assert.equal(h.ttl, 15);
    assert.equal(h.maxTtl, 15);
    assert.equal(h.gateway, false);
    assert.equal(h.seq, 42);
    assert.equal(u32ToIp(h.src), "10.26.0.2");
    assert.equal(u32ToIp(h.dest), "10.26.0.3");
  }
  assert.deepEqual(Array.from(raw.subarray(HEAD_LENGTH)), [1, 2, 3]);
});
test("网关标志位", () => {
  const pkt = buildPacket({ msgType: MsgType.PingTurn, ttl: 1, gateway: true, payload: new Uint8Array(8) });
  assert.equal(pkt.gateway, true);
  assert.equal(pkt.buffer[2] & 0x40, 0x40);
});
test("TTL 递减到 1 时停止", () => {
  const raw = new Uint8Array(HEAD_LENGTH);
  raw[1] = 0x22; // max=2 curr=2
  assert.equal(decrTtlInPlace(raw), true);
  assert.equal(raw[1] & 0x0f, 1);
  assert.equal(decrTtlInPlace(raw), false);
});

// ---------------------------------------------------------------------------
// 4. 注册消息解码
// ---------------------------------------------------------------------------
console.log("控制消息");
// 手工编码一个 RegRequestMsg：network_code=1, device_id=2, name=4,
// version=5, ip=3(fixed32), client_type=15
function encodeRegRequestFixture({
  networkCode = "mynet",
  deviceId = "dev-1",
  ip = ipToU32("10.26.0.2"),
  name = "pc",
  version = "2.0.12",
  clientType = ClientType.VNT,
  instanceId = new Uint8Array(32),
  registrationMode = 0,
} = {}) {
  const reg = new Writer();
  reg.writeString(1, networkCode);
  reg.writeString(2, deviceId);
  reg.writeFixed32Always(3, ip);
  reg.writeString(4, name);
  reg.writeString(5, version);
  reg.writeUInt32(9, registrationMode);
  if (instanceId && instanceId.length) reg.writeLengthDelimited(14, instanceId);
  reg.writeUInt32(15, clientType);
  const req = new Writer();
  req.writeMessage(1, reg);
  return req.finish();
}

test("解码 RegRequestMsg", () => {
  const bytes = encodeRegRequestFixture();
  const { kind, value } = decodeRequestMessage(bytes);
  assert.equal(kind, "reg");
  assert.equal(value.networkCode, "mynet");
  assert.equal(value.deviceId, "dev-1");
  assert.equal(value.name, "pc");
  assert.equal(value.version, "2.0.12");
  assert.equal(value.ip, ipToU32("10.26.0.2"));
  assert.equal(value.clientType, ClientType.VNT);
  assert.equal(value.clientInstanceId.length, 32);
});

test("确认识别 confirm_reg 与 fast_reg", () => {
  const confirm = new Writer();
  confirm.writeMessage(2, new Writer());
  assert.equal(decodeRequestMessage(confirm.finish()).kind, "confirm_reg");

  const fastInner = new Writer();
  fastInner.writeFixed32Always(1, ipToU32("10.26.0.9"));
  const fast = new Writer();
  fast.writeMessage(3, fastInner);
  const d = decodeRequestMessage(fast.finish());
  assert.equal(d.kind, "fast_reg");
  assert.equal(d.value.ip, ipToU32("10.26.0.9"));
});

test("RegResponseMsg 可解码回字段", () => {
  const bytes = encodeRegResponse({
    ip: ipToU32("10.26.0.5"),
    prefixLen: 24,
    gateway: ipToU32("10.26.0.1"),
    serverVersion: "test",
    serverInstanceId: new Uint8Array([1, 2, 3]),
    subnetSyncSupported: false,
    multiLinkSupported: false,
  });
  const r = new Reader(bytes);
  r.each((field, wire, rr) => {
    if (field === 1 && wire === 2) {
      const inner = rr.readMessage();
      const got = {};
      inner.each((f, _w, ss) => {
        if (f === 1) got.ip = ss.readFixed32();
        else if (f === 2) got.prefixLen = ss.readVarint();
        else if (f === 3) got.gateway = ss.readFixed32();
        else if (f === 4) got.serverVersion = ss.readString();
        else if (f === 8) got.serverInstanceId = Array.from(ss.readBytes());
        else return false;
        return true;
      });
      assert.equal(u32ToIp(got.ip), "10.26.0.5");
      assert.equal(got.prefixLen, 24);
      assert.equal(u32ToIp(got.gateway), "10.26.0.1");
      assert.equal(got.serverVersion, "test");
      assert.deepEqual(got.serverInstanceId, [1, 2, 3]);
      return true;
    }
    return false;
  });
});

test("ErrorResponseMsg code/message", () => {
  const bytes = encodeErrorResponse(401, "Token Error");
  const r = new Reader(bytes);
  r.each((field, wire, rr) => {
    if (field === 2 && wire === 2) {
      const inner = rr.readMessage();
      const got = {};
      inner.each((f, _w, ss) => {
        if (f === 1) got.code = ss.readVarint();
        else if (f === 2) got.message = ss.readString();
        else return false;
        return true;
      });
      assert.equal(got.code, 401);
      assert.equal(got.message, "Token Error");
      return true;
    }
    return false;
  });
});

test("ClientSimpleInfoList 编码", () => {
  const bytes = encodeClientSimpleInfoList({
    dataVersion: 5,
    list: [
      { ip: ipToU32("10.26.0.2"), online: true, clientType: 0 },
      { ip: ipToU32("10.26.0.3"), online: false, clientType: 0 },
    ],
    isAll: true,
    time: 1234,
  });
  const r = new Reader(bytes);
  const out = { list: [] };
  r.each((field, wire, rr) => {
    if (field === 1) {
      out.dataVersion = rr.readVarint();
      return true;
    }
    if (field === 2) {
      const inner = rr.readMessage();
      const item = {};
      inner.each((f, _w, ss) => {
        if (f === 1) item.ip = ss.readFixed32();
        else if (f === 2) item.online = ss.readVarint() !== 0;
        else return false;
        return true;
      });
      out.list.push(item);
      return true;
    }
    if (field === 3) {
      out.isAll = rr.readVarint() !== 0;
      return true;
    }
    if (field === 4) {
      out.time = rr.readVarint();
      return true;
    }
    return false;
  });
  assert.equal(out.dataVersion, 5);
  assert.equal(out.isAll, true);
  assert.equal(out.time, 1234);
  assert.equal(out.list.length, 2);
  assert.equal(u32ToIp(out.list[0].ip), "10.26.0.2");
  assert.equal(Boolean(out.list[0].online), true);
  assert.equal(Boolean(out.list[1].online), false); // proto3 默认值 false 不写入线路
});

test("SelectiveBroadcast 往返", () => {
  const data = new Uint8Array([0x80 | MsgType.Turn, 0x22, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const w = new Writer();
  w.writeFixed32Field(1, ipToU32("10.26.0.9"));
  w.writeFixed32Field(1, ipToU32("10.26.0.7"));
  w.writeLengthDelimited(2, data);
  const sel = decodeSelectiveBroadcast(w.finish());
  assert.deepEqual(sel.ips.map(u32ToIp), ["10.26.0.9", "10.26.0.7"]);
  assert.equal(sel.data.length, data.length);
  assert.equal(sel.data[0], data[0]);
});

test("RpcReq 解码 / RpcRes 编码", () => {
  const w = new Writer();
  w.writeInt64(1, 99);
  w.writeMessage(2, new Writer());
  const req = decodeRpcRequest(w.finish());
  assert.equal(req.id, 99);

  const resp = encodeRpcResponse({
    id: 99,
    list: [{ name: "a", version: "2.0.12", ip: ipToU32("10.26.0.2"), online: true, lastConnectedTime: 1700000000, id: "dev-1", clientType: 0 }],
  });

  // 逐字节解析，验证与 RpcMessageResponse 定义一致
  const fields = parseAllFields(resp);
  assert.equal(fields.length, 2);
  assert.equal(fields[0].field, 1);
  assert.equal(fields[0].value, 99);

  assert.equal(fields[1].field, 2);
  const respBody = parseAllFields(fields[1].value);
  assert.equal(respBody.length, 1);
  assert.equal(respBody[0].field, 1); // ClientListResponse.list
  const ci = parseAllFields(respBody[0].value);
  const map = Object.fromEntries(ci.map((f) => [f.field, f.value]));
  const asText = (v) => new TextDecoder().decode(v);
  assert.equal(asText(map[1]), "a"); // name
  assert.equal(asText(map[2]), "2.0.12"); // version
  assert.equal(u32ToIp(map[3]), "10.26.0.2"); // ip (fixed32)
  assert.equal(map[5], 1); // online
  assert.equal(map[6], 1700000000); // last_connected_time
  assert.equal(asText(map[7]), "dev-1"); // id
});

/**
 * 通用 protobuf 逐字段解析（仅用于测试断言）。
 * 返回 [{ field, wire, value }]，其中 length-delimited 返回 Uint8Array，
 * 需要时可由调用方递归解析。
 */
function parseAllFields(bytes) {
  const out = [];
  let pos = 0;
  const readVarint = () => {
    let big = 0n;
    let shift = 0n;
    for (let i = 0; i < 10; i++) {
      const b = bytes[pos++];
      big |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return Number(big);
      shift += 7n;
    }
    throw new Error("varint 过长");
  };
  while (pos < bytes.length) {
    const tag = readVarint();
    const field = tag >> 3;
    const wire = tag & 7;
    let value;
    if (wire === 0) {
      value = readVarint();
    } else if (wire === 5) {
      value = (bytes[pos] | (bytes[pos + 1] << 8) | (bytes[pos + 2] << 16) | (bytes[pos + 3] << 24)) >>> 0;
      pos += 4;
    } else if (wire === 1) {
      pos += 8;
      value = null;
    } else if (wire === 2) {
      const len = readVarint();
      value = bytes.subarray(pos, pos + len);
      pos += len;
    } else {
      throw new Error(`未知 wire ${wire}`);
    }
    out.push({ field, wire, value });
  }
  return out;
}

test("解析器本身可信：Writer 输出能被 parseAllFields 还原", () => {
  const w = new Writer();
  w.writeString(1, "hello");
  w.writeUInt32(2, 300);
  w.writeFixed32Field(3, 0x0a1a0002);
  const f = parseAllFields(w.finish());
  assert.equal(f[0].field, 1);
  assert.equal(new TextDecoder().decode(f[0].value), "hello");
  assert.equal(f[1].value, 300);
  assert.equal(u32ToIp(f[2].value), "10.26.0.2");
});
// ---------------------------------------------------------------------------
// 5. 设备登记（管理 API 侧）+ 静态 IP 校验
// ---------------------------------------------------------------------------
console.log("设备登记");

/** 每个用例用独立网络，避免互相干扰 */
let netSeq = 0;
function freshNet(env = {}) {
  netSeq += 1;
  const cfg = resolveConfig({ VNT_NETWORK: `net-${netSeq}`, ...env });
  return cfg;
}

test("登记设备后可按登记的 ip 注册", async () => {
  const cfg = freshNet();
  const net = registry.network(cfg.networkCode, cfg);
  const entry = await net.registerEntry({ deviceId: "pc-a", ip: ipToU32("10.26.0.2"), name: "客厅PC" });
  assert.equal(entry.ok, true);

  const sent = [];
  const r = await net.registerDevice({
    deviceId: "pc-a",
    clientType: 0,
    requestedIp: ipToU32("10.26.0.2"),
    send: (b) => sent.push(b),
  });
  assert.equal(r.ok, true);
  assert.equal(u32ToIp(r.ip), "10.26.0.2");
});

test("未登记的设备无法注册", async () => {
  const cfg = freshNet();
  const net = registry.network(cfg.networkCode, cfg);
  const r = await net.registerDevice({
    deviceId: "stranger",
    clientType: 0,
    requestedIp: ipToU32("10.26.0.9"),
    send: () => {},
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "not_registered");
});

test("ip 与登记不符时拒绝（防止冒用他人地址）", async () => {
  const cfg = freshNet();
  const net = registry.network(cfg.networkCode, cfg);
  await net.registerEntry({ deviceId: "pc-b", ip: ipToU32("10.26.0.3") });
  const r = await net.registerDevice({
    deviceId: "pc-b",
    clientType: 0,
    requestedIp: ipToU32("10.26.0.99"),
    send: () => {},
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "ip_mismatch");
});

test("同一 ip 不能登记给两台设备", async () => {
  const cfg = freshNet();
  const net = registry.network(cfg.networkCode, cfg);
  assert.equal((await net.registerEntry({ deviceId: "d1", ip: ipToU32("10.26.0.5") })).ok, true);
  const dup = await net.registerEntry({ deviceId: "d2", ip: ipToU32("10.26.0.5") });
  assert.equal(dup.ok, false);
});

test("保留地址（网关/网络号/广播）拒绝登记", async () => {
  const cfg = freshNet();
  const net = registry.network(cfg.networkCode, cfg);
  for (const bad of ["10.26.0.1", "10.26.0.0", "10.26.0.255"]) {
    const r = await net.registerEntry({ deviceId: `x-${bad}`, ip: ipToU32(bad) });
    assert.equal(r.ok, false, `${bad} 不应被接受`);
  }
});

test("网段外的 ip 拒绝登记", async () => {
  const cfg = freshNet();
  const net = registry.network(cfg.networkCode, cfg);
  const r = await net.registerEntry({ deviceId: "outside", ip: ipToU32("192.168.1.5") });
  assert.equal(r.ok, false);
});

test("删除登记后该设备无法再注册", async () => {
  const cfg = freshNet();
  const net = registry.network(cfg.networkCode, cfg);
  await net.registerEntry({ deviceId: "temp", ip: ipToU32("10.26.0.7") });
  assert.equal(await net.removeEntry("temp"), true);
  const r = await net.registerDevice({
    deviceId: "temp",
    clientType: 0,
    requestedIp: ipToU32("10.26.0.7"),
    send: () => {},
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "not_registered");
});

test("登记的 ip 可以改，改后旧地址失效", async () => {
  const cfg = freshNet();
  const net = registry.network(cfg.networkCode, cfg);
  await net.registerEntry({ deviceId: "m", ip: ipToU32("10.26.0.8") });
  await net.registerEntry({ deviceId: "m", ip: ipToU32("10.26.0.9") });

  const bad = await net.registerDevice({
    deviceId: "m", clientType: 0, requestedIp: ipToU32("10.26.0.8"), send: () => {},
  });
  assert.equal(bad.ok, false, "旧地址应失效");

  const good = await net.registerDevice({
    deviceId: "m", clientType: 0, requestedIp: ipToU32("10.26.0.9"), send: () => {},
  });
  assert.equal(good.ok, true);
});

test("未连接的已登记设备显示为离线但 everConnected=false", async () => {
  const cfg = freshNet();
  const net = registry.network(cfg.networkCode, cfg);
  await net.registerEntry({ deviceId: "idle", ip: ipToU32("10.26.0.10"), name: "待机" });
  const list = await net.listEntries();
  const one = list.find((d) => d.deviceId === "idle");
  assert.equal(one.online, false);
  assert.equal(one.everConnected, false);
});

// ---------------------------------------------------------------------------
// 6. 端到端：注册 + 打洞信令转发（不中转业务流量）
// ---------------------------------------------------------------------------
console.log("端到端（纯打洞）");

/** 预登记三台设备并把 Session 拉起来 */
async function setupNet(code, specs) {
  const cfg = resolveConfig({ VNT_NETWORK: code });
  const net = registry.network(code, cfg);
  for (const s of specs) {
    await net.registerEntry({ deviceId: s.id, ip: ipToU32(s.ip), name: s.name || s.id });
  }
  return { cfg, net };
}

function regFrameFor({ networkCode, deviceId, ip, name = "pc" }) {
  return encodeRegRequestFixture({ networkCode, deviceId, ip, name });
}

test("登记设备注册成功，且注册响应里 server_instance_id 恰好 32 字节", async () => {
  const code = "e2e-reg";
  await setupNet(code, [{ id: "A", ip: "10.26.0.2" }]);
  const out = [];
  const sa = new Session({ VNT_NETWORK: code });
  const ok = await sa.handleFirstFrame(
    regFrameFor({ networkCode: code, deviceId: "A", ip: ipToU32("10.26.0.2") }),
    (b) => out.push(b),
  );
  assert.equal(ok, true);
  assert.ok(out.length >= 1);
  // 解出 RegResponseMsg 的 field 8 必须是 32 字节（客户端硬校验）
  const bytes = out[0];
  const fields = parseAllFields(bytes);
  const reg = fields.find((f) => f.field === 1 && f.value instanceof Uint8Array);
  assert.ok(reg, "应有 reg 字段");
  const innerFields = parseAllFields(reg.value);
  const sid = innerFields.find((f) => f.field === 8 && f.value instanceof Uint8Array);
  assert.ok(sid, `应有 server_instance_id，实际字段: ${innerFields.map((f) => f.field).join(",")}`);
  assert.equal(sid.value.length, 32, "server_instance_id 必须恰好 32 字节");
});

test("未登记设备被拒绝，且错误信息提示先登记", async () => {
  const code = "e2e-deny";
  await setupNet(code, []);
  const out = [];
  const s = new Session({ VNT_NETWORK: code });
  const ok = await s.handleFirstFrame(
    regFrameFor({ networkCode: code, deviceId: "nobody", ip: ipToU32("10.26.0.2") }),
    (b) => out.push(b),
  );
  assert.equal(ok, false);
  const text = new TextDecoder().decode(out[0]);
  assert.ok(text.includes("未登记"), `错误信息应提到未登记，实际: ${text}`);
});

test("网络编号与服务端环境变量不一致时拒绝", async () => {
  const code = "e2e-netid";
  await setupNet(code, [{ id: "A", ip: "10.26.0.2" }]);
  const out = [];
  const s = new Session({ VNT_NETWORK: code });
  const ok = await s.handleFirstFrame(
    regFrameFor({ networkCode: "wrong-net", deviceId: "A", ip: ipToU32("10.26.0.2") }),
    (b) => out.push(b),
  );
  assert.equal(ok, false);
});

test("打洞信令被转发给目标设备（本实例内直发）", async () => {
  const code = "e2e-punch";
  await setupNet(code, [
    { id: "A", ip: "10.26.0.2" },
    { id: "B", ip: "10.26.0.3" },
  ]);
  const outA = [];
  const outB = [];
  const sa = new Session({ VNT_NETWORK: code });
  await sa.handleFirstFrame(regFrameFor({ networkCode: code, deviceId: "A", ip: ipToU32("10.26.0.2") }), (b) => outA.push(b));
  const sb = new Session({ VNT_NETWORK: code });
  await sb.handleFirstFrame(regFrameFor({ networkCode: code, deviceId: "B", ip: ipToU32("10.26.0.3") }), (b) => outB.push(b));

  outB.length = 0;
  const punch = buildPacket({
    msgType: MsgType.PunchStart1,
    ttl: 2,
    src: sa.ip,
    dest: sb.ip,
    payload: new Uint8Array([1, 2, 3, 4]),
  }).toUint8Array();
  await sa.handleDataPacket(punch, () => {});

  assert.equal(outB.length, 1, "B 应收到打洞信令");
  assert.equal(parseHeaderFast(outB[0]).msgType, MsgType.PunchStart1);
  assert.equal(outB[0][1] & 0x0f, 1, "TTL 应被递减（2 -> 1）");
});

test("业务流量默认不中转（纯打洞模式）", async () => {
  const code = "e2e-norelay";
  await setupNet(code, [
    { id: "A", ip: "10.26.0.2" },
    { id: "B", ip: "10.26.0.3" },
  ]);
  const outA = [];
  const outB = [];
  const sa = new Session({ VNT_NETWORK: code });
  await sa.handleFirstFrame(regFrameFor({ networkCode: code, deviceId: "A", ip: ipToU32("10.26.0.2") }), (b) => outA.push(b));
  const sb = new Session({ VNT_NETWORK: code });
  await sb.handleFirstFrame(regFrameFor({ networkCode: code, deviceId: "B", ip: ipToU32("10.26.0.3") }), (b) => outB.push(b));

  outB.length = 0;
  const turn = buildPacket({
    msgType: MsgType.Turn, ttl: 15, src: sa.ip, dest: sb.ip, payload: new Uint8Array([0xde, 0xad]),
  }).toUint8Array();
  await sa.handleDataPacket(turn, () => {});
  assert.equal(outB.length, 0, "Turn 业务流量不应被中转");
});

test("注册后主动推送全量邻居列表（is_all=true）", async () => {
  const code = "e2e-push";
  await setupNet(code, [
    { id: "A", ip: "10.26.0.2" },
    { id: "B", ip: "10.26.0.3" },
  ]);
  const outA = [];
  const sa = new Session({ VNT_NETWORK: code });
  await sa.handleFirstFrame(regFrameFor({ networkCode: code, deviceId: "A", ip: ipToU32("10.26.0.2") }), (b) => outA.push(b));

  const outB = [];
  const sb = new Session({ VNT_NETWORK: code });
  await sb.handleFirstFrame(regFrameFor({ networkCode: code, deviceId: "B", ip: ipToU32("10.26.0.3") }), (b) => outB.push(b));

  // A 应收到 B 上线的推送（无需等心跳）
  const push = outA.find((f) => (f[0] & 0x7f) === MsgType.PushClientIps);
  assert.ok(push, "A 应收到节点列表推送");
  const list = decodeClientSimpleInfoList(list_of(push));
  assert.equal(list.isAll, true, "必须是全量（is_all=true）");
  assert.ok(list.ips.includes("10.26.0.3"), `列表应包含 B，实际 ${list.ips.join(",")}`);
});

/** 从 PushClientIps 帧里取出 payload */
function list_of(frame) {
  return frame.subarray(HEAD_LENGTH);
}

/** 解 ClientSimpleInfoList：返回 { isAll, ips } */
function decodeClientSimpleInfoList(payload) {
  const r = new Reader(payload);
  const out = { isAll: false, ips: [], dataVersion: 0 };
  r.each((field, wire, rr) => {
    if (field === 1) { out.dataVersion = rr.readVarint(); return true; }
    if (field === 3) { out.isAll = rr.readVarint() !== 0; return true; }
    if (field === 4) { rr.readVarint(); return true; }
    if (field === 2 && wire === 2) {
      const inner = rr.readMessage();
      let ip = 0;
      inner.each((f, _w, ss) => {
        if (f === 1) { ip = ss.readFixed32(); return true; }
        return false;
      });
      out.ips.push(u32ToIp(ip));
      return true;
    }
    return false;
  });
  return out;
}

await runAll();
console.log(`\n通过 ${passed} 项测试${failed ? `，失败 ${failed} 项` : ""}`);
