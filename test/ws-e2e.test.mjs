// 通过 index.js 的 onRequest 走完整 WebSocket 链路，验证接入层串联
import { onRequest } from "../cloud-functions/index.js";
import { Writer } from "../cloud-functions/_vnt/protobuf.js";
import { ipToU32, buildPacket, MsgType, parseHeaderFast, HEAD_LENGTH } from "../cloud-functions/_vnt/packet.js";

function regFrame({ networkCode, deviceId, ip, name = "pc" }) {
  const reg = new Writer();
  reg.writeString(1, networkCode);
  reg.writeString(2, deviceId);
  if (ip) reg.writeFixed32Always(3, ip);
  reg.writeString(4, name);
  reg.writeString(5, "2.0.12");
  reg.writeUInt32(15, 0);
  const req = new Writer();
  req.writeMessage(1, reg);
  return req.finish();
}

async function connect(env) {
  const ctx = { request: new Request("https://x/", { headers: { upgrade: "websocket" } }), env };
  const { websocket } = await onRequest(ctx);
  const inbox = [];
  const ws = { send: (b) => inbox.push(b), close: () => {} };
  websocket.onopen(ws, ctx.request);
  return { websocket, ws, inbox };
}

const env = {};

// A 连接
const a = await connect(env);
a.websocket.onmessage(a.ws, regFrame({ networkCode: "e2e-ws", deviceId: "A" }), true);
console.log("A 收到注册响应字节数:", a.inbox[0].length);

// B 连接，指定 IP
const b = await connect(env);
b.websocket.onmessage(b.ws, regFrame({ networkCode: "e2e-ws", deviceId: "B", ip: ipToU32("10.26.0.3") }), true);

// 解析 A 注册响应里的 ip 字段
function parseRegResp(bytes) {
  let pos = 0;
  const rv = () => { let v=0n,s=0n; while(true){const x=bytes[pos++]; v|=BigInt(x&0x7f)<<s; s+=7n; if(!(x&0x80)) return Number(v);} };
  const tag = rv(); const f = tag>>3;
  if (f !== 1) return null;
  const len = rv();
  const end = pos + len;
  const out = {};
  while (pos < end) {
    const t = rv(); const ff = t>>3, w = t&7;
    if (w === 5) { out[ff] = (bytes[pos]|(bytes[pos+1]<<8)|(bytes[pos+2]<<16)|(bytes[pos+3]<<24))>>>0; pos+=4; }
    else if (w === 2) { const L = rv(); out[ff] = new TextDecoder().decode(bytes.subarray(pos,pos+L)); pos+=L; }
    else if (w === 0) { out[ff] = rv(); }
    else if (w === 1) { pos += 8; }
  }
  return out;
}
const resp = parseRegResp(a.inbox[0]);
const ipU32 = (v) => `${(v>>>24)&255}.${(v>>>16)&255}.${(v>>>8)&255}.${v&255}`;
console.log("A 分配 IP:", ipU32(resp[1]), "prefix:", resp[2], "gateway:", ipU32(resp[3]));
console.log("B 分配 IP:", ipU32(parseRegResp(b.inbox[0])[1]));

// A -> B 数据中继（Turn）
const turn = buildPacket({
  msgType: MsgType.Turn, ttl: 15, seq: 7, src: resp[1], dest: ipToU32("10.26.0.3"),
  payload: new Uint8Array([0xca, 0xfe]),
}).toUint8Array();
b.inbox.length = 0;
a.websocket.onmessage(a.ws, turn, true);
console.log("B 收到中继包数:", b.inbox.length, "→ dest:", ipU32(parseHeaderFast(b.inbox[0]).dest), "ttl:", parseHeaderFast(b.inbox[0]).ttl);

// 关闭 A，验证 B 的列表推送里 A 变为离线
a.websocket.onclose(a.ws);
console.log("A 关闭后 registry 网络数:", (await import("../cloud-functions/_vnt/state.js")).registry.networks.size);
console.log("e2e-ws 完成");
