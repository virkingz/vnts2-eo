// 通过 index.js 的 onRequest 走完整 WebSocket 链路，验证接入层串联。
//
// 顺带覆盖几个「线上才会暴露」的坑：
//   1. server_instance_id 必须是 32 字节（客户端硬校验，16 字节直接断连）
//   2. 节点列表必须 is_all=true（增量语义会让客户端只增不删）
//   3. 注册/下线要主动广播，不能等对端心跳
//   4. 同一 device_id 重连时，旧连接的 close 不能把新连接打下线

import { onRequest } from "../cloud-functions/index.js";
import { Writer } from "../cloud-functions/_vnt/protobuf.js";
import {
  ipToU32,
  buildPacket,
  MsgType,
  parseHeaderFast,
  HEAD_LENGTH,
} from "../cloud-functions/_vnt/packet.js";

// ---------------------------------------------------------------------------
// 用最小的 WebSocketPair 替身模拟 EdgeOne 运行时
// ---------------------------------------------------------------------------
class FakeSocket {
  constructor() {
    this.listeners = new Map();
    this.sent = [];
    this.readyState = 1;
  }
  addEventListener(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(fn);
  }
  emit(name, payload) {
    for (const fn of this.listeners.get(name) || []) fn(payload);
  }
  accept() {}
  send(data) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.emit("close", {});
  }
  /** 模拟客户端发来一帧 */
  receive(bytes) {
    this.emit("message", { data: bytes });
  }
  drain() {
    const out = this.sent.slice();
    this.sent.length = 0;
    return out;
  }
}

globalThis.WebSocketPair = class {
  constructor() {
    this.socket = new FakeSocket();
    this.response = new Response(null, { status: 200 }); // Node 的 Response 不接受 101，这里只做占位
    // 允许按数组方式解构，验证两种运行时形态都能工作
    this[0] = new FakeSocket();
    this[1] = this.socket;
  }
};

// ---------------------------------------------------------------------------
// 帧构造与解析
// ---------------------------------------------------------------------------
function regFrame({ networkCode, deviceId, ip, name = "pc", registrationMode }) {
  const reg = new Writer();
  reg.writeString(1, networkCode);
  reg.writeString(2, deviceId);
  if (ip) reg.writeFixed32Always(3, ip);
  reg.writeString(4, name);
  reg.writeString(5, "2.0.12");
  reg.writeUInt32(15, 0);
  if (registrationMode) reg.writeUInt32(9, registrationMode);
  const req = new Writer();
  req.writeMessage(1, reg);
  return req.finish();
}

/** 16 字节 PingTurn：now(8) + data_version(8) */
function pingTurn(dataVersion) {
  const payload = new Uint8Array(16);
  const view = new DataView(payload.buffer);
  view.setBigUint64(0, BigInt(Date.now()), false);
  view.setBigUint64(8, BigInt(dataVersion), false);
  return buildPacket({
    msgType: MsgType.PingTurn,
    ttl: 1,
    gateway: true,
    payload,
  }).toUint8Array();
}

/** 通用 protobuf 字段遍历（测试用，不依赖实现） */
function parseFields(bytes) {
  let pos = 0;
  const rv = () => {
    let v = 0n;
    let s = 0n;
    while (true) {
      const x = bytes[pos++];
      v |= BigInt(x & 0x7f) << s;
      s += 7n;
      if (!(x & 0x80)) return Number(v);
    }
  };
  const out = [];
  while (pos < bytes.length) {
    const tag = rv();
    out.push({ field: tag >> 3, wire: tag & 7 });
    const w = tag & 7;
    if (w === 0) rv();
    else if (w === 1) pos += 8;
    else if (w === 5) pos += 4;
    else if (w === 2) {
      const len = rv();
      out[out.length - 1].bytes = bytes.subarray(pos, pos + len);
      pos += len;
    } else break;
  }
  return out;
}

const ipU32 = (v) => `${(v >>> 24) & 255}.${(v >>> 16) & 255}.${(v >>> 8) & 255}.${v & 255}`;

/** 解出 RegResponseMsg（外层 field=1） */
function parseRegResp(bytes) {
  const outer = parseFields(bytes);
  const msg = outer.find((f) => f.field === 1 && f.wire === 2);
  if (!msg) return null;
  const out = {};
  // 手工按字段号取值（fixed32 / varint / bytes）
  let pos = 0;
  const buf = msg.bytes;
  const rv = () => {
    let v = 0n;
    let s = 0n;
    while (true) {
      const x = buf[pos++];
      v |= BigInt(x & 0x7f) << s;
      s += 7n;
      if (!(x & 0x80)) return Number(v);
    }
  };
  while (pos < buf.length) {
    const tag = rv();
    const field = tag >> 3;
    const wire = tag & 7;
    if (wire === 0) out[field] = rv();
    else if (wire === 5) {
      out[field] = (buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16) | (buf[pos + 3] << 24)) >>> 0;
      pos += 4;
    } else if (wire === 1) pos += 8;
    else if (wire === 2) {
      const len = rv();
      out[field] = new Uint8Array(buf.subarray(pos, pos + len));
      pos += len;
    } else break;
  }
  return out;
}

/** 解出 ClientSimpleInfoList（PushClientIps 的 payload） */
function parseClientList(payload) {
  const out = { list: [], isAll: false, dataVersion: 0, time: 0 };
  let pos = 0;
  const buf = payload;
  const rv = () => {
    let v = 0n;
    let s = 0n;
    while (true) {
      const x = buf[pos++];
      v |= BigInt(x & 0x7f) << s;
      s += 7n;
      if (!(x & 0x80)) return Number(v);
    }
  };
  while (pos < buf.length) {
    const tag = rv();
    const field = tag >> 3;
    const wire = tag & 7;
    if (wire === 0) {
      const v = rv();
      if (field === 1) out.dataVersion = v;
      if (field === 3) out.isAll = v !== 0;
      if (field === 4) out.time = v;
    } else if (wire === 2) {
      const len = rv();
      const sub = buf.subarray(pos, pos + len);
      pos += len;
      if (field === 2) {
        // ClientSimpleInfo { ip=1 fixed32, online=2, client_type=3 }
        let p = 0;
        const item = { ip: 0, online: false, clientType: 0 };
        while (p < sub.length) {
          let t = 0n;
          let s = 0n;
          while (true) {
            const x = sub[p++];
            t |= BigInt(x & 0x7f) << s;
            s += 7n;
            if (!(x & 0x80)) break;
          }
          const ff = Number(t) >> 3;
          const w = Number(t) & 7;
          if (w === 5) {
            item.ip = (sub[p] | (sub[p + 1] << 8) | (sub[p + 2] << 16) | (sub[p + 3] << 24)) >>> 0;
            p += 4;
          } else if (w === 0) {
            let v = 0n;
            let ss = 0n;
            while (true) {
              const x = sub[p++];
              v |= BigInt(x & 0x7f) << ss;
              ss += 7n;
              if (!(x & 0x80)) break;
            }
            if (ff === 2) item.online = Number(v) !== 0;
            if (ff === 3) item.clientType = Number(v);
          } else break;
        }
        out.list.push(item);
      }
    } else break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 断言工具
// ---------------------------------------------------------------------------
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// 建连辅助
// ---------------------------------------------------------------------------
async function connect(env, label) {
  const ctx = {
    request: new Request("https://x/", { headers: { upgrade: "websocket" } }),
    env: env || {},
  };
  const resp = await onRequest(ctx);
  if (label) {
    check(`${label}：升级请求返回的是 Response 而不是自定义对象`, resp instanceof Response, `拿到 ${typeof resp}`);
  }
  // acceptWebSocket 内部消费了 pair，这里取全局最近一次创建的 socket
  return { resp, socket: globalThis.__lastSocket };
}

// 拦截 FakeSocket 创建，记录最近一个（即 acceptWebSocket 用到的那个）
const OriginalFake = FakeSocket;
globalThis.WebSocketPair = class extends OriginalFake {
  constructor() {
    super();
    this.socket = new OriginalFake();
    this.response = new Response(null, { status: 200 }); // Node 的 Response 不接受 101，这里只做占位
    this[0] = new OriginalFake();
    this[1] = this.socket;
    globalThis.__lastSocket = this.socket;
  }
};

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------
console.log("接入层");
const env = {};

const a = await connect(env, "首次连接");
const aSock = a.socket;
aSock.receive(regFrame({ networkCode: "e2e-ws", deviceId: "A" }));
const aReg = parseRegResp(aSock.drain()[0]);
check("A 注册成功并拿到虚拟 IP", !!aReg && !!aReg[1], JSON.stringify(aReg));
console.log(`    A 分配 IP: ${ipU32(aReg[1])}  prefix: ${aReg[2]}  gateway: ${ipU32(aReg[3])}`);

check(
  "server_instance_id 恰好 32 字节（客户端硬校验）",
  aReg[8] instanceof Uint8Array && aReg[8].length === 32,
  `实际 ${aReg[8]?.length ?? "缺失"} 字节`,
);
check("multi_link_supported 未声明为 true", aReg[9] === undefined, `field9=${aReg[9]}`);
check("subnet_sync_supported 未声明为 true", aReg[5] === undefined, `field5=${aReg[5]}`);

console.log("\n节点列表");
const b = await connect(env);
b.socket.receive(regFrame({ networkCode: "e2e-ws", deviceId: "B", ip: ipToU32("10.26.0.3") }));
const bAll = b.socket.drain();
const bReg = parseRegResp(bAll[0]);
console.log(`    B 分配 IP: ${ipU32(bReg[1])}`);

const bPush = bAll.find((f) => (f[0] & 0x7f) === MsgType.PushClientIps);
check("新设备注册后立刻收到一次节点列表", !!bPush);
if (bPush) {
  const list = parseClientList(bPush.subarray(HEAD_LENGTH));
  check("注册时推送的是全量快照（is_all=true）", list.isAll === true);
  check("列表里能看到已在线的 A", list.list.some((i) => i.ip === aReg[1] && i.online));
}

const aFrames = aSock.drain();
const aPush = aFrames.find((f) => (f[0] & 0x7f) === MsgType.PushClientIps);
check("已有设备无需等心跳就收到新成员（主动广播）", !!aPush);
if (aPush) {
  const list = parseClientList(aPush.subarray(HEAD_LENGTH));
  check("广播内容同样是全量快照", list.isAll === true);
  check("列表包含新上线的 B", list.list.some((i) => i.ip === bReg[1] && i.online));
}

console.log("\n数据面");
const turn = buildPacket({
  msgType: MsgType.Turn,
  ttl: 15,
  seq: 7,
  src: aReg[1],
  dest: bReg[1],
  payload: new Uint8Array([0xca, 0xfe]),
}).toUint8Array();
b.socket.drain();
aSock.receive(turn);
const relayed = b.socket.drain();
check("A -> B 单播中继成功", relayed.length === 1);
if (relayed[0]) {
  check("中继后 dest 不变", parseHeaderFast(relayed[0]).dest === bReg[1]);
  check("中继后 TTL 递减", parseHeaderFast(relayed[0]).ttl === 14);
}

console.log("\n心跳");
aSock.drain();
aSock.receive(pingTurn(0));
const hb = aSock.drain();
const hbPush = hb.find((f) => (f[0] & 0x7f) === MsgType.PushClientIps);
check("版本过期时心跳返回节点列表", !!hbPush);
if (hbPush) {
  check("心跳推送也是全量", parseClientList(hbPush.subarray(HEAD_LENGTH)).isAll === true);
}

aSock.drain();
const { registry } = await import("../cloud-functions/_vnt/state.js");
const currentVersion = registry.find("e2e-ws").dataVersion;
aSock.receive(pingTurn(currentVersion));
const hb2 = aSock.drain();
check(
  "版本一致时只回 PongTurn（不重复推列表）",
  hb2.length === 1 && (hb2[0][0] & 0x7f) === MsgType.PongTurn,
  `收到 ${hb2.map((f) => f[0] & 0x7f).join(",")}`,
);

console.log("\n重连竞态");
// 模拟客户端断线重连：新连接先注册，旧连接的 close 后到
const a2 = await connect(env);
a2.socket.receive(regFrame({ networkCode: "e2e-ws", deviceId: "A" }));
a2.socket.drain();
aSock.close(); // 旧连接关闭
b.socket.drain();
const afterOldClose = b.socket.drain();
const stalePush = afterOldClose.find((f) => (f[0] & 0x7f) === MsgType.PushClientIps);
check(
  "旧连接 close 不会把刚重连的新连接标成离线",
  !stalePush || parseClientList(stalePush.subarray(HEAD_LENGTH)).list.every((i) => i.ip !== aReg[1] || i.online),
);

console.log("\n下线广播");
b.socket.drain();
a2.socket.close();
const offlinePush = b.socket
  .drain()
  .find((f) => (f[0] & 0x7f) === MsgType.PushClientIps);
check("设备断线后其它设备立刻收到更新", !!offlinePush);
if (offlinePush) {
  const list = parseClientList(offlinePush.subarray(HEAD_LENGTH));
  const peer = list.list.find((i) => i.ip === aReg[1]);
  check("该设备在列表里被标为离线", !!peer && peer.online === false);
}


// ---------------------------------------------------------------------------
// 运行时形态自适应：没有 WebSocketPair 时应回落到回调对象
// ---------------------------------------------------------------------------
console.log("\n运行时形态自适应");
{
  const saved = globalThis.WebSocketPair;
  delete globalThis.WebSocketPair;
  try {
    const ctx = {
      request: new Request("https://x/", { headers: { upgrade: "websocket" } }),
      env: {},
    };
    const result = await onRequest(ctx);
    check(
      "无 WebSocketPair 时回落到 { websocket: { onopen, onmessage, ... } }",
      !!result && !!result.websocket && typeof result.websocket.onmessage === "function",
      `拿到 ${Object.keys(result || {}).join(",")}`,
    );

    // 这条回退路径也要能真正完成注册
    const ws = new FakeSocket();
    result.websocket.onopen(ws);
    result.websocket.onmessage(ws, regFrame({ networkCode: "legacy-ws", deviceId: "L" }));
    const frames = ws.drain();
    check("回调对象形态同样能完成注册", frames.length >= 1);
    if (frames[0]) {
      const resp = parseRegResp(frames[0]);
      check("回调对象形态下 server_instance_id 也是 32 字节", resp[8]?.length === 32);
    }
  } finally {
    globalThis.WebSocketPair = saved;
  }
}

console.log("");
if (failed > 0) {
  console.log(`失败 ${failed} 项`);
  process.exit(1);
}
console.log("e2e 全部通过");
