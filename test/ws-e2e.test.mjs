// 接入层端到端测试：走 index.js 的 onRequest，覆盖
//   * WebSocket 升级（WebSocketPair 与回调对象两种形态）
//   * /admin 设备登记 API
//   * /health
//   * 客户端注册（含登记校验）
//   * 打洞信令转发、业务流量不中转
//
// 运行：node test/ws-e2e.test.mjs

import { resetBackend, createMemoryBackend } from "../cloud-functions/_vnt/shared-store.js";

// 必须在 import index.js 之前装好共享后端
globalThis.__VNT_SHARED_BACKEND__ = createMemoryBackend();
resetBackend();

const { onRequest } = await import("../cloud-functions/index.js");
const { Writer } = await import("../cloud-functions/_vnt/protobuf.js");
const { ipToU32, u32ToIp, buildPacket, MsgType, HEAD_LENGTH } = await import(
  "../cloud-functions/_vnt/packet.js"
);

const NET = "e2e-net";
const GATEWAY = "10.26.2.1";
const TOKEN = "test-admin-token";
const ENV = { VNT_NETWORK: NET, VNT_GATEWAY: GATEWAY, VNT_ADMIN_TOKEN: TOKEN };

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// 最小 socket 替身
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
  receive(bytes) {
    this.emit("message", { data: bytes });
  }
  drain() {
    const out = this.sent.slice();
    this.sent.length = 0;
    return out;
  }
}

let lastSocket = null;
globalThis.WebSocketPair = class {
  constructor() {
    this.socket = new FakeSocket();
    // Node 的 Response 不接受 101，这里只做占位
    this.response = new Response(null, { status: 200 });
    this[0] = new FakeSocket();
    this[1] = this.socket;
    lastSocket = this.socket;
  }
};

/** 建立一条 WS 连接（走真实 onRequest） */
async function connect(env = ENV) {
  const ctx = {
    request: new Request("https://x/", { headers: { upgrade: "websocket" } }),
    env,
  };
  const resp = await onRequest(ctx);
  return { resp, socket: lastSocket };
}

/** 让排队的帧处理完（帧是串行链式执行的） */
const settle = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------
// 帧构造
// ---------------------------------------------------------------------------
function regFrame({ networkCode = NET, deviceId, ip, name = "pc" }) {
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

function pingTurn(dataVersion = 0) {
  const payload = new Uint8Array(16);
  const view = new DataView(payload.buffer);
  view.setBigInt64(0, BigInt(Date.now()), false);
  view.setBigUint64(8, BigInt(dataVersion), false);
  return buildPacket({ msgType: MsgType.PingTurn, ttl: 1, gateway: true, payload }).toUint8Array();
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------
function parseFields(bytes) {
  const out = [];
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
  while (pos < bytes.length) {
    const tag = rv();
    const field = tag >> 3;
    const wire = tag & 7;
    if (wire === 0) out.push({ field, wire, value: rv() });
    else if (wire === 5) {
      out.push({
        field,
        wire,
        value: (bytes[pos] | (bytes[pos + 1] << 8) | (bytes[pos + 2] << 16) | (bytes[pos + 3] << 24)) >>> 0,
      });
      pos += 4;
    } else if (wire === 1) {
      pos += 8;
      out.push({ field, wire, value: null });
    } else if (wire === 2) {
      const len = rv();
      out.push({ field, wire, value: bytes.subarray(pos, pos + len) });
      pos += len;
    } else break;
  }
  return out;
}

function parseRegResp(bytes) {
  const reg = parseFields(bytes).find((f) => f.field === 1 && f.value instanceof Uint8Array);
  return reg ? parseFields(reg.value) : null;
}

/** 按字段号取值（不要用数组下标——字段可能被 proto3 跳过） */
function fieldOf(fields, no) {
  return fields.find((f) => f.field === no);
}

function decodeClientList(payload) {
  const out = { isAll: false, ips: [] };
  for (const f of parseFields(payload)) {
    if (f.field === 3) out.isAll = f.value !== 0;
    if (f.field === 2 && f.value instanceof Uint8Array) {
      const ipField = parseFields(f.value).find((x) => x.field === 1);
      if (ipField) out.ips.push(u32ToIp(ipField.value));
    }
  }
  return out;
}

async function admin(path, init = {}) {
  const headers = new Headers(init.headers || {});
  if (!headers.has("Authorization") && TOKEN) headers.set("Authorization", `Bearer ${TOKEN}`);
  const req = new Request(`https://x${path}`, { ...init, headers });
  return onRequest({ request: req, env: ENV });
}

// ===========================================================================
console.log("管理 API：设备登记");

{
  const res = await admin("/admin");
  check("GET /admin 返回说明与设备列表", res.status === 200);
  const body = await res.json();
  check("说明页带网络编号", body.networkCode === NET, JSON.stringify(body.networkCode));
}

{
  const req = new Request("https://x/admin/devices");
  const res = await onRequest({ request: req, env: { ...ENV, VNT_ADMIN_TOKEN: "" } });
  check("未配置 VNT_ADMIN_TOKEN 时管理接口不可用（503）", res.status === 503, `实际 ${res.status}`);
}

{
  const req = new Request("https://x/admin/devices", { headers: { Authorization: "Bearer wrong" } });
  const res = await onRequest({ request: req, env: ENV });
  check("token 错误返回 401", res.status === 401, `实际 ${res.status}`);
}

{
  const res = await admin("/admin/devices", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: "lede", ip: "10.26.2.2", name: "路由器" }),
  });
  check("登记设备返回 201", res.status === 201, `实际 ${res.status}`);
  const body = await res.json();
  check("返回登记详情", body.device?.deviceId === "lede" && body.device?.ip === "10.26.2.2");
  check("提示无需等待缓存过期", typeof body.hint === "string" && body.hint.includes("立即"));
}

{
  const res = await admin("/admin/devices", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: "dup", ip: "10.26.2.2" }),
  });
  check("重复 ip 登记返回 409", res.status === 409, `实际 ${res.status}`);
}

{
  const res = await admin("/admin/devices", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: "bad", ip: "10.26.2.1" }),
  });
  check("网关地址不可登记（409）", res.status === 409, `实际 ${res.status}`);
}

{
  const res = await admin("/admin/devices", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: "pc2", ip: "10.26.2.3", name: "笔记本" }),
  });
  check("登记第二台设备成功", res.status === 201);
}

{
  const res = await admin("/admin/devices");
  const body = await res.json();
  check("列表包含两台已登记设备", body.devices.length === 2, `实际 ${body.devices.length}`);
  check("已登记未连接的设备 online=false", body.devices.every((d) => d.online === false));
}

// ===========================================================================
console.log("\n客户端注册（需先登记）");

{
  const { resp, socket } = await connect();
  check("升级请求返回 Response", resp instanceof Response);

  socket.receive(regFrame({ deviceId: "nobody", ip: ipToU32("10.26.2.9") }));
  await settle();
  const frames = socket.drain();
  check("未登记设备被拒绝", frames.length >= 1, `收到 ${frames.length} 帧`);
  const text = new TextDecoder().decode(frames[0]);
  check("错误信息提示需要先登记", text.includes("未登记"), text.slice(0, 80));
}

{
  const { socket } = await connect();
  socket.receive(regFrame({ deviceId: "lede", ip: ipToU32("10.26.2.99") }));
  await settle();
  const text = new TextDecoder().decode(socket.drain()[0]);
  check("ip 与登记不符被拒绝", text.includes("不符"), text.slice(0, 80));
}

{
  const { socket } = await connect();
  socket.receive(regFrame({ deviceId: "lede", ip: ipToU32("10.26.2.2") }));
  await settle();
  const frames = socket.drain();
  const reg = parseRegResp(frames[0]);
  check("已登记设备注册成功", !!reg);
  const ipField = fieldOf(reg, 1);
  check("分配的 ip 与登记一致", ipField && u32ToIp(ipField.value) === "10.26.2.2", ipField ? u32ToIp(ipField.value) : "(缺 ip 字段)");
  const sid = reg.find((f) => f.field === 8 && f.value instanceof Uint8Array);
  check("server_instance_id 恰好 32 字节", sid?.value.length === 32, `实际 ${sid?.value.length}`);
  check("未声明 multi_link_supported", reg.find((f) => f.field === 9) === undefined);
}

// ===========================================================================
console.log("\n节点列表与打洞信令");

let sockA;
let sockB;
const ipA = ipToU32("10.26.2.2");
const ipB = ipToU32("10.26.2.3");

{
  const a = await connect();
  a.socket.receive(regFrame({ deviceId: "lede", ip: ipA }));
  await settle();
  a.socket.drain();
  sockA = a.socket;

  const b = await connect();
  b.socket.receive(regFrame({ deviceId: "pc2", ip: ipB }));
  await settle();
  sockB = b.socket;

  const bFrames = sockB.drain();
  const push = bFrames.find((f) => (f[0] & 0x7f) === MsgType.PushClientIps);
  check("新设备注册后立刻收到节点列表", !!push);
  if (push) {
    const list = decodeClientList(push.subarray(HEAD_LENGTH));
    check("推送为全量 is_all=true", list.isAll === true);
    check("列表含已在线的 lede", list.ips.includes("10.26.2.2"), list.ips.join(","));
  }

  const aPush = sockA.drain().find((f) => (f[0] & 0x7f) === MsgType.PushClientIps);
  check("已有设备无需等心跳即收到新成员", !!aPush);
}

{
  sockB.drain();
  const punch = buildPacket({
    msgType: MsgType.PunchStart1,
    ttl: 2,
    src: ipA,
    dest: ipB,
    payload: new Uint8Array([1, 2, 3]),
  }).toUint8Array();
  sockA.receive(punch);
  await settle();
  const got = sockB.drain();
  check("打洞信令被转发到对端", got.length === 1, `收到 ${got.length} 帧`);
  if (got[0]) {
    check("转发的是 PunchStart1", (got[0][0] & 0x7f) === MsgType.PunchStart1);
    check("TTL 已递减 2→1", (got[0][1] & 0x0f) === 1, `实际 ${got[0][1] & 0x0f}`);
  }
}

{
  sockB.drain();
  const turn = buildPacket({
    msgType: MsgType.Turn,
    ttl: 15,
    src: ipA,
    dest: ipB,
    payload: new Uint8Array([0xde, 0xad]),
  }).toUint8Array();
  sockA.receive(turn);
  await settle();
  check("业务流量 Turn 不被中转（纯打洞模式）", sockB.drain().length === 0);
}

{
  sockA.drain();
  sockA.receive(pingTurn(0));
  await settle();
  const push = sockA.drain().find((f) => (f[0] & 0x7f) === MsgType.PushClientIps);
  check("心跳返回节点列表", !!push);
  if (push) {
    check("心跳推送为全量", decodeClientList(push.subarray(HEAD_LENGTH)).isAll === true);
  }
}

// ===========================================================================
console.log("\n下线与重连");

{
  sockB.drain();
  sockA.close();
  await settle();
  await settle();
  const push = sockB.drain().find((f) => (f[0] & 0x7f) === MsgType.PushClientIps);
  check("设备断线后对端收到更新", !!push);

  const res = await admin("/admin/devices/lede");
  check("断线后登记仍保留（可随时重连）", res.status === 200, `实际 ${res.status}`);
}

{
  const res = await admin("/admin/devices/pc2", { method: "DELETE" });
  check("可删除登记", res.status === 200);

  const { socket } = await connect();
  socket.receive(regFrame({ deviceId: "pc2", ip: ipB }));
  await settle();
  const text = new TextDecoder().decode(socket.drain()[0]);
  check("删除登记后无法再连接", text.includes("未登记"), text.slice(0, 80));
}

// ===========================================================================
console.log("\n运行时形态自适应");

{
  const saved = globalThis.WebSocketPair;
  delete globalThis.WebSocketPair;
  try {
    const ctx = {
      request: new Request("https://x/", { headers: { upgrade: "websocket" } }),
      env: ENV,
    };
    const result = await onRequest(ctx);
    check(
      "无 WebSocketPair 时回落到回调对象形态",
      !!result?.websocket && typeof result.websocket.onmessage === "function",
      Object.keys(result || {}).join(","),
    );

    const ws = new FakeSocket();
    result.websocket.onopen(ws);
    result.websocket.onmessage(ws, regFrame({ deviceId: "lede", ip: ipA }));
    await settle();
    const frames = ws.drain();
    check("回退形态同样能完成注册", frames.length >= 1);
    if (frames[0]) {
      const reg = parseRegResp(frames[0]);
      check("回退形态的 server_instance_id 也是 32 字节", reg.find((f) => f.field === 8)?.value.length === 32);
    }
  } finally {
    globalThis.WebSocketPair = saved;
  }
}

// ===========================================================================
console.log("\n健康检查");

{
  const res = await onRequest({ request: new Request("https://x/health"), env: ENV });
  check("GET /health 返回 200", res.status === 200);
  const body = await res.json();
  check("健康检查标明纯打洞模式", body.mode === "p2p-punch-only", body.mode);
  check("健康检查带网络编号", body.network === NET);
  check("健康检查统计已登记设备数", body.registeredDevices === 1, String(body.registeredDevices));
}

console.log("");
if (failed > 0) {
  console.log(`失败 ${failed} 项，通过 ${passed} 项`);
  process.exit(1);
}
console.log(`e2e 全部通过（${passed} 项）`);
