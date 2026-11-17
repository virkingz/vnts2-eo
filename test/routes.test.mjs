// 路由分发验证：确认两个入口各自负责哪些路径
//
// EdgeOne 的优先级：静态路由 > [param] > [[catch-all]]
//   "/"        → cloud-functions/index.js
//   "/health"  → cloud-functions/[[default]].js（因为不存在 health.js）
//
// 运行：node test/routes.test.mjs

import { createMemoryBackend, resetBackend } from "../cloud-functions/_vnt/shared-store.js";

globalThis.__VNT_SHARED_BACKEND__ = createMemoryBackend();
resetBackend();

const { onRequest: rootHandler } = await import("../cloud-functions/index.js");
const { onRequest: catchAllHandler } = await import("../cloud-functions/[[default]].js");

const ENV = { VNT_NETWORK: "routes-net", VNT_GATEWAY: "10.26.2.1", VNT_ADMIN_TOKEN: "tok" };

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

async function call(handler, path, init = {}) {
  const headers = new Headers(init.headers || {});
  if (!headers.has("Authorization")) headers.set("Authorization", "Bearer tok");
  const request = new Request(`https://x${path}`, { ...init, headers });
  return handler({ request, env: ENV });
}

console.log("路由分发");

{
  const res = await call(rootHandler, "/");
  const body = await res.text();
  check("index.js 处理 / （返回状态页）", res.status === 200 && body.includes("vnts2"), `${res.status}`);
  check("状态页不泄露网络编号", !body.includes("routes-net"));
  check("状态页不渲染设备列表", !body.includes("deviceId"));
}

{
  // 先登记一台设备，确认它不会出现在任何公开页面上
  await call(catchAllHandler, "/admin/devices", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: "secret-device", ip: "10.26.2.9", name: "机密机器" }),
  });
  const res = await call(rootHandler, "/");
  const body = await res.text();
  check("状态页不泄露已登记设备的 id", !body.includes("secret-device"));
  check("状态页不泄露已登记设备的名字", !body.includes("机密机器"));
}

{
  const res = await call(catchAllHandler, "/health");
  const body = await res.json();
  check("catch-all 处理 /health", res.status === 200 && body.ok === true, `${res.status}`);
  check("/health 报告模式为纯打洞", body.mode === "p2p-punch-only", body.mode);
  check(
    "/health 暴露存储后端（blob 才对）",
    typeof body.storage === "string",
    String(body.storage),
  );
  // ── 公开端点不得泄露任何配置值或设备信息 ──
  check("/health 不泄露网络编号", body.network === undefined, JSON.stringify(body.network));
  check("/health 不泄露设备数量", body.registeredDevices === undefined && body.onlineDevices === undefined);
  check("/health 不泄露设备明细", body.detail === undefined);
  check(
    "/health 不泄露网关/掩码",
    body.gateway === undefined && body.prefixLen === undefined && body.netmask === undefined,
  );
  check("/health 只回答配置与否（布尔值）", typeof body.configured === "boolean", String(body.configured));

  // 兜底：响应体里不能出现网络编号这个字符串
  const raw = JSON.stringify(body);
  check(
    "/health 响应体里搜不到网络编号字面量",
    !raw.includes("routes-net"),
    raw.slice(0, 120),
  );
}

{
  const res = await call(catchAllHandler, "/healthz");
  check("catch-all 也处理 /healthz", res.status === 200, `${res.status}`);
}

{
  const res = await call(catchAllHandler, "/admin");
  check("catch-all 处理 /admin", res.status === 200, `${res.status}`);
}

{
  const res = await call(catchAllHandler, "/admin/devices", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: "d1", ip: "10.26.2.2", name: "一号机" }),
  });
  check("catch-all 处理 POST /admin/devices", res.status === 201, `${res.status}`);
}

{
  // 未配置 token 时必须拒绝，不能放开
  const res = await catchAllHandler({
    request: new Request("https://x/admin/devices"),
    env: { ...ENV, VNT_ADMIN_TOKEN: "" },
  });
  check("未配置 VNT_ADMIN_TOKEN 时 /admin 不可用", res.status === 503, `${res.status}`);
}

console.log("\nWebSocket 升级（两个入口都应支持）");

// 升级路径有两条，优先级：WebSocketPair（返回 Response）> 回调对象。
// 早期版本只在 HTTP 上下文探测一次，导致升级时走错分支 → 平台报 502。
// 这里两条都测。

function assertHandler(res, label) {
  const h = res?.websocket;
  check(
    `${label} 返回 websocket 回调对象`,
    !!h &&
      typeof h.onopen === "function" &&
      typeof h.onmessage === "function" &&
      typeof h.onclose === "function" &&
      typeof h.onerror === "function",
    Object.keys(res || {}).join(","),
  );
}

function fakePair() {
  class FakeSocket {
    constructor() {
      this.listeners = new Map();
      this.sent = [];
    }
    addEventListener(n, f) {
      if (!this.listeners.has(n)) this.listeners.set(n, []);
      this.listeners.get(n).push(f);
    }
    accept() {}
    send(d) {
      this.sent.push(d);
    }
    close() {}
  }
  const sockets = [];
  globalThis.WebSocketPair = class {
    constructor() {
      this.socket = new FakeSocket();
      this.response = new Response(null, { status: 200 });
      sockets.push(this.socket);
    }
  };
  return sockets;
}

// ── 无 WebSocketPair 时：必须回落回调对象（当前线上就是这种） ──
{
  // 升级路径用 async 也可以 —— 官方 WebSocket 模板就是 async onRequest，
  // 实测能给 101。曾经误以为必须同步返回、并据此改过代码，是错的。
  // 这里有 WebSocketPair 不被使用这一条就够了（见下）。
}

{
  const saved = globalThis.WebSocketPair;
  delete globalThis.WebSocketPair;
  try {
    const res = await rootHandler({
      request: new Request("https://x/", { headers: { upgrade: "websocket" } }),
      env: ENV,
    });
    assertHandler(res, "无 WebSocketPair 时 index.js 处理 / 的升级，");
  } finally {
    if (saved !== undefined) globalThis.WebSocketPair = saved;
  }
}

{
  const saved = globalThis.WebSocketPair;
  delete globalThis.WebSocketPair;
  try {
    const res = await catchAllHandler({
      request: new Request("https://x/some/path", { headers: { upgrade: "websocket" } }),
      env: ENV,
    });
    assertHandler(res, "无 WebSocketPair 时 catch-all 处理升级，");
  } finally {
    if (saved !== undefined) globalThis.WebSocketPair = saved;
  }
}

// ── 即使运行时*提供* WebSocketPair，也绝不能使用它 ──
// 本项目的运行时不保证有 WebSocketPair，一旦调用 new WebSocketPair() 就抛
// ReferenceError → 502。所以必须恒定返回回调对象，与是否存在该全局无关。
{
  const saved = globalThis.WebSocketPair;
  let constructed = 0;
  globalThis.WebSocketPair = class {
    constructor() {
      constructed++;
      throw new Error("绝不能调用 new WebSocketPair()");
    }
  };
  try {
    const res = await rootHandler({
      request: new Request("https://x/", { headers: { upgrade: "websocket" } }),
      env: ENV,
    });
    check(
      "存在 WebSocketPair 时仍返回回调对象（不用它）",
      !!res?.websocket && typeof res.websocket.onmessage === "function",
      Object.keys(res || {}).join(","),
    );
    check("完全没有构造 WebSocketPair（那是 502 的来源）", constructed === 0, `构造了 ${constructed} 次`);
  } finally {
    if (saved === undefined) delete globalThis.WebSocketPair;
    else globalThis.WebSocketPair = saved;
  }
}

// ── WebSocketPair 抛错也必须能正常工作（我们根本不碰它）──
{
  const saved = globalThis.WebSocketPair;
  globalThis.WebSocketPair = class {
    constructor() {
      throw new Error("运行时不支持 WebSocketPair");
    }
  };
  try {
    const res = await rootHandler({
      request: new Request("https://x/", { headers: { upgrade: "websocket" } }),
      env: ENV,
    });
    assertHandler(res, "WebSocketPair 抛错时，");
  } finally {
    if (saved === undefined) delete globalThis.WebSocketPair;
    else globalThis.WebSocketPair = saved;
  }
}

// ── 注入的 ws 只有 send/close（官方模板形态）──
{
  const saved = globalThis.WebSocketPair;
  delete globalThis.WebSocketPair;
  try {
    const res = await rootHandler({
      request: new Request("https://x/", { headers: { upgrade: "websocket" } }),
      env: ENV,
    });
    const ws = {
      sent: [],
      send(d) {
        this.sent.push(d);
      },
      close() {},
    };
    res.websocket.onopen(ws, new Request("https://x/"));
    check("ws 只有 send/close 时也能 onopen（不依赖 addEventListener）", true);
  } finally {
    if (saved !== undefined) globalThis.WebSocketPair = saved;
  }
}

console.log("");
if (failed > 0) {
  console.log(`失败 ${failed} 项，通过 ${passed} 项`);
  process.exit(1);
}
console.log(`路由测试全部通过（${passed} 项）`);
