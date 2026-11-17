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
}

{
  const res = await call(catchAllHandler, "/health");
  const body = await res.json();
  check("catch-all 处理 /health", res.status === 200 && body.ok === true, `${res.status}`);
  check("/health 报告模式为纯打洞", body.mode === "p2p-punch-only", body.mode);
  check("/health 报告网络编号", body.network === "routes-net", String(body.network));
  check(
    "/health 暴露存储后端（blob 才对）",
    typeof body.storage === "string",
    String(body.storage),
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

// Node 环境没有 WebSocketPair，此时应回落到回调对象形态 ——
// 两种形态都必须能接受升级，否则线上换形态就握手失败。
function fakePair() {
  class FakeSocket {
    constructor() {
      this.listeners = new Map();
    }
    addEventListener(n, f) {
      if (!this.listeners.has(n)) this.listeners.set(n, []);
      this.listeners.get(n).push(f);
    }
    accept() {}
    send() {}
  }
  globalThis.WebSocketPair = class {
    constructor() {
      this.socket = new FakeSocket();
      this.response = new Response(null, { status: 200 });
    }
  };
}

{
  const saved = globalThis.WebSocketPair;
  fakePair();
  try {
    const res = await rootHandler({
      request: new Request("https://x/", { headers: { upgrade: "websocket" } }),
      env: ENV,
    });
    check("index.js 以 WebSocketPair 形态接受 / 的升级", res instanceof Response, String(res));
  } finally {
    globalThis.WebSocketPair = saved;
  }
}

{
  const saved = globalThis.WebSocketPair;
  fakePair();
  try {
    const res = await catchAllHandler({
      request: new Request("https://x/some/path", { headers: { upgrade: "websocket" } }),
      env: ENV,
    });
    check("catch-all 以 WebSocketPair 形态接受升级", res instanceof Response, String(res));
  } finally {
    globalThis.WebSocketPair = saved;
  }
}

{
  // 没有 WebSocketPair 时必须回落，而不是抛错
  const saved = globalThis.WebSocketPair;
  delete globalThis.WebSocketPair;
  try {
    const res = await rootHandler({
      request: new Request("https://x/", { headers: { upgrade: "websocket" } }),
      env: ENV,
    });
    check(
      "无 WebSocketPair 时回落为回调对象",
      !!res?.websocket && typeof res.websocket.onmessage === "function",
      Object.keys(res || {}).join(","),
    );
  } finally {
    globalThis.WebSocketPair = saved;
  }
}

console.log("");
if (failed > 0) {
  console.log(`失败 ${failed} 项，通过 ${passed} 项`);
  process.exit(1);
}
console.log(`路由测试全部通过（${passed} 项）`);
