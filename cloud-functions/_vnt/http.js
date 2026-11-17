// HTTP 路由分发（与 WebSocket 接入层分开）
//
// 为什么要单独一个文件：EdgeOne 是**文件即路由**——
//   cloud-functions/index.js  → 只映射到 /
//   cloud-functions/x.js      → 只映射到 /x
// 所以 /health、/admin/* 这些路径**不会**被 index.js 处理。
// 本项目把这些非 WS 的路由集中在这里，由 catch-all 入口
// （cloud-functions/[[default]].js）与 index.js 共用同一份逻辑，
// 避免两处各写一遍而长歪。

import { registry, resolveConfig } from "./state.js";
import { handleAdmin } from "./admin.js";
import { getBackend } from "./shared-store.js";

/** 仅用于状态页展示，避免为了格式化再引一次模块 */
function ipOf(v) {
  const n = Number(v) >>> 0;
  return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/**
 * 处理一个非 WebSocket 请求。
 * 返回 Response；调用方负责在拿到 null 时继续走自己的兜底逻辑。
 */
export async function handleHttp(request, env) {
  // 管理接口（设备登记）优先
  const adminResp = await handleAdmin(request, env);
  if (adminResp) return adminResp;

  const url = new URL(request.url);
  if (url.pathname === "/health" || url.pathname === "/healthz") {
    return healthResponse(env);
  }

  return new Response(statusHtml(env), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function healthResponse(env) {
  const cfg = resolveConfig(env);
  const net = cfg.networkCode ? registry.find(cfg.networkCode) : null;
  const nets = [];
  for (const n of registry.networks.values()) nets.push(n.toJSON());
  const backend = await getBackend();
  const storageOk = backend.kind === "blob";

  return Response.json(
    {
      ok: true,
      service: "vnts2-edgeone",
      protocol: "vnt2",
      mode: "p2p-punch-only",
      wsMode: typeof WebSocketPair !== "undefined" ? "websocket-pair" : "callback-object",
      // storage=blob 才是期望值；memory 说明 Blob SDK 没装上，
      // 此时服务仍能工作，但**跨实例共享失效**（设备互相看不见）。
      storage: backend.kind,
      storageOk,
      ...(storageOk
        ? {}
        : {
            storageHint:
              "存储降级为内存，跨实例共享失效。请确认 package.json 里有 @edgeone/pages-blob 依赖，且构建时执行了 npm install。",
          }),
      network: cfg.networkCode || null,
      registeredDevices: net ? net.shared.size : 0,
      onlineDevices: net ? net.count().online : 0,
      connectionsTotal: registry.stats.connectionsTotal,
      bytesSignaled: registry.stats.bytesSignaled,
      uptimeSeconds: Math.floor((Date.now() - registry.startedAt) / 1000),
      detail: nets,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export function statusHtml(env) {
  const cfg = resolveConfig(env);
  const net = cfg.networkCode ? registry.find(cfg.networkCode) : null;
  const devices = net ? net.toJSON().devices : [];
  const body = JSON.stringify(
    {
      networkCode: cfg.networkCode || "(未配置 VNT_NETWORK)",
      gateway: net ? ipOf(net.gateway) : "-",
      devices,
      stats: registry.stats,
    },
    null,
    2,
  );
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>vnts2 · EdgeOne · P2P</title>
<style>
  :root { color-scheme: light; }
  body { margin:0; padding:32px; font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif; background:#f7f8fa; color:#1f2328; }
  h1 { font-size:20px; margin:0 0 4px; }
  .sub { color:#656d76; margin-bottom:20px; }
  code { background:#eef1f4; padding:2px 6px; border-radius:4px; }
  pre { background:#0d1117; color:#e6edf3; padding:16px; border-radius:8px; overflow:auto; font-size:12px; }
  .card { background:#fff; border:1px solid #d8dee4; border-radius:8px; padding:16px 20px; margin-bottom:16px; }
  .warn { background:#fff8e5; border-color:#e6d9a8; }
</style>
</head>
<body>
  <h1>vnts2 · EdgeOne</h1>
  <div class="sub">VNT 2.x 服务端 —— <b>纯 P2P 打洞辅助</b>，不中转数据</div>
  <div class="card">
    <div>客户端连接：<code>server = ["wss://你的域名:443"]</code></div>
    <div>网络编号：<code>${cfg.networkCode || "未配置 VNT_NETWORK"}</code>（仅来自环境变量）</div>
    <div>已登记设备：<b>${devices.length}</b>　在线：<b>${net ? net.count().online : 0}</b></div>
    <div>健康检查：<code>GET /health</code>　设备登记：<code>/admin</code></div>
  </div>
  ${cfg.networkCode ? "" : '<div class="card warn">尚未配置 <code>VNT_NETWORK</code>，客户端无法注册。</div>'}
  <div class="card" style="color:#656d76">
    不同实例各自维护连接视图，本页只反映当前实例；设备表与打洞信令经 Blob 共享，
    因此设备可见性不受影响。
  </div>
  <pre>${escapeHtml(body)}</pre>
</body>
</html>`;
}
