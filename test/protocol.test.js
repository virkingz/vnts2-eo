// 协议编解码与注册/中继流程的自测
// 运行：node test/protocol.test.js
// 不依赖任何第三方库，使用 Node 内置 assert。

import assert from "node:assert/strict";

import { Reader, Writer, decodePacked } from "../cloud-functions/_vnt/protobuf.js";
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
} from "../cloud-functions/_vnt/packet.js";
import {
  decodeRequestMessage,
  encodeRegResponse,
  encodeErrorResponse,
  encodeClientSimpleInfoList,
  decodeSelectiveBroadcast,
  decodeRpcRequest,
  encodeRpcResponse,
  ClientType,
} from "../cloud-functions/_vnt/control-messages.js";
import { registry, resolveConfig } from "../cloud-functions/_vnt/state.js";
import { Session } from "../cloud-functions/_vnt/server.js";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    process.exitCode = 1;
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
// 5. 网络状态与 IP 分配
// ---------------------------------------------------------------------------
console.log("网络状态");
test("注册分配 IP 并复用", () => {
  const net = registry.network("test-net-1", resolveConfig({}));
  const a = net.registerDevice({ deviceId: "a", clientType: 0, requestedIp: 0, name: "A" });
  assert.equal(u32ToIp(a.entry.ip), "10.26.0.2");
  const b = net.registerDevice({ deviceId: "b", clientType: 0, requestedIp: 0, name: "B" });
  assert.equal(u32ToIp(b.entry.ip), "10.26.0.3");
  // 同设备重连应复用旧 IP
  net.offline("a");
  const a2 = net.registerDevice({ deviceId: "a", clientType: 0, requestedIp: 0, name: "A" });
  assert.equal(u32ToIp(a2.entry.ip), "10.26.0.2");
});
test("拒绝非本网段 IP 并重新分配", () => {
  const net = registry.network("test-net-2", resolveConfig({}));
  const r = net.registerDevice({ deviceId: "x", clientType: 0, requestedIp: ipToU32("192.168.5.5"), name: "X" });
  assert.ok(net.contains(r.entry.ip));
  assert.equal(u32ToIp(r.entry.ip), "10.26.0.2");
});
test("网关地址不会被分配", () => {
  const net = registry.network("test-net-3", resolveConfig({}));
  const r = net.registerDevice({ deviceId: "g", clientType: 0, requestedIp: ipToU32("10.26.0.1"), name: "G" });
  assert.notEqual(u32ToIp(r.entry.ip), "10.26.0.1");
});
test("dataVersion 随上下线变化", () => {
  const net = registry.network("test-net-4", resolveConfig({}));
  const v0 = net.dataVersion;
  net.registerDevice({ deviceId: "p", clientType: 0, requestedIp: 0, name: "P" });
  assert.ok(net.dataVersion > v0);
  const v1 = net.dataVersion;
  net.offline("p");
  assert.ok(net.dataVersion > v1);
});

// ---------------------------------------------------------------------------
// 6. 端到端：注册 + 双向中继
// ---------------------------------------------------------------------------
console.log("端到端");
test("两个客户端注册后可通过服务端中继互发数据", () => {
  const env = {};
  const netCode = "e2e-net";

  const outA = [];
  const outB = [];

  const sa = new Session(env);
  const okA = sa.handleFirstFrame(encodeRegRequestFixture({ networkCode: netCode, deviceId: "A" }), (b) => outA.push(b));
  assert.equal(okA, true);
  // 第一帧必须是注册响应；其后可能紧跟一次节点列表推送（注册后主动推送）
  assert.ok(outA.length >= 1, `至少应有一帧注册响应，实际 ${outA.length}`);
  assert.equal(outA[0][0] >> 3, 1, "首帧应是 ResponseMessage 的 reg（field 1）");

  const sb = new Session(env);
  const okB = sb.handleFirstFrame(
    encodeRegRequestFixture({ networkCode: netCode, deviceId: "B", ip: ipToU32("10.26.0.3") }),
    (b) => outB.push(b),
  );
  assert.equal(okB, true);

  assert.equal(u32ToIp(sa.ip), "10.26.0.2");
  assert.equal(u32ToIp(sb.ip), "10.26.0.3");

  // A -> B 的 Turn 包
  const turn = buildPacket({
    msgType: MsgType.Turn,
    ttl: 15,
    seq: 1,
    src: sa.ip,
    dest: sb.ip,
    payload: new Uint8Array([0xde, 0xad]),
  }).toUint8Array();

  outB.length = 0;
  sa.handleDataPacket(turn, (b) => outA.push(b));
  assert.equal(outB.length, 1, "B 应收到 1 个包");
  const got = outB[0];
  assert.equal(u32ToIp(parseHeaderFast(got).dest), "10.26.0.3");
  assert.equal(got[1] & 0x0f, 14, "TTL 应被递减");
});

test("广播会发给除发送者外的所有在线节点", () => {
  const env = {};
  const netCode = "bcast-net";
  const outA = [];
  const outB = [];
  const outC = [];
  const sa = new Session(env);
  sa.handleFirstFrame(encodeRegRequestFixture({ networkCode: netCode, deviceId: "A" }), (b) => outA.push(b));
  const sb = new Session(env);
  sb.handleFirstFrame(encodeRegRequestFixture({ networkCode: netCode, deviceId: "B", ip: ipToU32("10.26.0.3") }), (b) => outB.push(b));
  const sc = new Session(env);
  sc.handleFirstFrame(encodeRegRequestFixture({ networkCode: netCode, deviceId: "C", ip: ipToU32("10.26.0.4") }), (b) => outC.push(b));

  outA.length = 0; outB.length = 0; outC.length = 0;
  const bcast = buildPacket({
    msgType: MsgType.Broadcast,
    ttl: 15,
    src: sa.ip,
    dest: 0xffffffff >>> 0,
    payload: new Uint8Array([1]),
  }).toUint8Array();
  sa.handleDataPacket(bcast, () => {});
  assert.equal(outA.length, 0, "发送者不应收到自己的广播");
  assert.equal(outB.length, 1);
  assert.equal(outC.length, 1);
});

test("PingTurn(16字节) 在版本变化时返回节点列表", () => {
  const env = {};
  const netCode = "ping-net";
  const outA = [];
  const sa = new Session(env);
  sa.handleFirstFrame(encodeRegRequestFixture({ networkCode: netCode, deviceId: "A" }), (b) => outA.push(b));
  const sb = new Session(env);
  sb.handleFirstFrame(encodeRegRequestFixture({ networkCode: netCode, deviceId: "B", ip: ipToU32("10.26.0.3") }), () => {});

  outA.length = 0;
  const payload = new Uint8Array(16);
  new DataView(payload.buffer).setBigInt64(0, BigInt(Date.now()), false);
  new DataView(payload.buffer).setBigUint64(8, 0n, false); // data_version=0 -> 全量
  const ping = buildPacket({ msgType: MsgType.PingTurn, ttl: 1, gateway: true, payload }).toUint8Array();
  sa.handleDataPacket(ping, (b) => outA.push(b));

  assert.equal(outA.length, 1);
  const resp = outA[0];
  assert.equal(parseHeaderFast(resp).msgType, MsgType.PushClientIps);
  // 列表中应含 B
  const list = resp.subarray(HEAD_LENGTH);
  const r = new Reader(list);
  const ips = [];
  r.each((field, wire, rr) => {
    if (field === 2 && wire === 2) {
      const inner = rr.readMessage();
      let ip = 0;
      inner.each((f, _w, ss) => {
        if (f === 1) {
          ip = ss.readFixed32();
          return true;
        }
        return false;
      });
      ips.push(u32ToIp(ip));
      return true;
    }
    return false;
  });
  assert.ok(ips.includes("10.26.0.3"), `节点列表应包含 B，实际: ${ips.join(",")}`);
});

test("白名单：只放行唯一匹配的 network_code", () => {
  const env = { VNT_NETWORK_WHITELIST: "allowed-net" };
  const out = [];

  // 不匹配 -> 拒绝
  const s1 = new Session(env);
  assert.equal(s1.handleFirstFrame(encodeRegRequestFixture({ networkCode: "other-net", deviceId: "A" }), (b) => out.push(b)), false);
  assert.equal(out.length, 1);

  // 完全一致 -> 放行
  const s2 = new Session(env);
  assert.equal(s2.handleFirstFrame(encodeRegRequestFixture({ networkCode: "allowed-net", deviceId: "B" }), () => {}), true);
});

test("白名单：不支持逗号分隔的多值（多值视为整体，一律拒绝）", () => {
  const env = { VNT_NETWORK_WHITELIST: "net1,net2" };
  const s1 = new Session(env);
  assert.equal(s1.handleFirstFrame(encodeRegRequestFixture({ networkCode: "net1", deviceId: "A" }), () => {}), false);
  const s2 = new Session(env);
  assert.equal(s2.handleFirstFrame(encodeRegRequestFixture({ networkCode: "net2", deviceId: "B" }), () => {}), false);
});

test("白名单：留空表示不限制", () => {
  const env = { VNT_NETWORK_WHITELIST: "   " };
  const s = new Session(env);
  assert.equal(s.handleFirstFrame(encodeRegRequestFixture({ networkCode: "any-net", deviceId: "A" }), () => {}), true);
});

test("错误：非 VNT 客户端类型被拒绝", () => {
  const env = {};
  const out = [];
  const s = new Session(env);
  const ok = s.handleFirstFrame(
    encodeRegRequestFixture({ networkCode: "n", deviceId: "A", clientType: ClientType.WIREGUARD }),
    (b) => out.push(b),
  );
  assert.equal(ok, false);
});

console.log(`\n通过 ${passed} 项测试`);
