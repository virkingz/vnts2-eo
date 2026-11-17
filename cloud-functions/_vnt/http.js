// HTTP 路由分发（与 WebSocket 接入层分开）
//
// 为什么要单独一个文件：EdgeOne 是**文件即路由**——
//   cloud-functions/index.js  → 只映射到 /
//   cloud-functions/x.js      → 只映射到 /x
// 所以 /health、/admin/* 这些路径**不会**被 index.js 处理。
// 本项目把这些非 WS 的路由集中在这里，由 catch-all 入口
// （cloud-functions/[[default]].js）与 index.js 共用同一份逻辑，
// 避免两处各写一遍而长歪。
//
// ═══════════════════════════════════════════════════════════════════════════
// 公开面最小化原则
// ═══════════════════════════════════════════════════════════════════════════
// 本服务端有一个**完全公开**的探针端点 /health 和一个根路径状态页。
// 它们绝不能暴露任何可用于接入或侦察的信息：
//
//   ❌ network_code —— 这是接入凭据。虽然注册还需要已登记的设备，
//                      但泄露网络编号等于交出一半钥匙，也会告诉别人
//                      "这里有个 VNT 服务端"。
//   ❌ deviceId / ip / name —— 设备清单，等于内网拓扑 + 设备命名习惯。
//   ❌ gateway / netmask / 设备数量 —— 网络规模与结构。
//
// 因此：
//   * /health     只回答"活着吗、能不能用"，不含任何配置值
//   * /           只给一句说明，不渲染设备列表
//   * 详情（设备表、网络编号等）一律走 /admin/*，需 Bearer 令牌
// ═══════════════════════════════════════════════════════════════════════════

import { registry, resolveConfig } from "./state.js";
import { handleAdmin } from "./admin.js";
import { getBackend } from "./shared-store.js";
import { probeWebSocket } from "./ws.js";

/**
 * 构建标记。每次改动部署时手动更新，用于从 /health 判断部署是否生效。
 * 换成一个单调递增的时间戳字符串。
 */
const BUILD_REV = "1.0.2-nf";

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/**
 * 处理一个非 WebSocket 请求。
 * 返回 Response；调用方负责在拿到 null 时继续走自己的兜底逻辑。
 */
export async function handleHttp(request, env) {
  // 管理接口（设备登记 + 详情）优先，且它是唯一需要鉴权的入口
  const adminResp = await handleAdmin(request, env);
  if (adminResp) return adminResp;

  const url = new URL(request.url);
  if (url.pathname === "/health" || url.pathname === "/healthz") {
    return healthResponse(env);
  }

  // 诊断端点：探测当前运行时对 WebSocket 的支持情况。
  // 不含任何敏感信息，可安全公开（就是几个 typeof 结果）。
  if (url.pathname === "/health/ws") {
    return Response.json(
      {
        runtime: typeof process !== "undefined" ? process.version : "(no process)",
        probe: probeWebSocket(),
      },
      { headers: { "cache-control": "no-store" } },
    );
  }

  return new Response(statusHtml(), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * 健康探针。**公开**，因此只返回非敏感信息。
 *
 * 保留这几项是为了让部署者能自助排查（尤其是 storage 降级那条，
 * 失败时没有任何报错，最难发现）。它们都不构成敏感信息：
 *   ok / service / protocol —— 服务身份
 *   mode                    —— 固定值，说明定位
 *   storage / storageOk     —— Blob 是否真的生效
 *   configured              —— 布尔值，只回答"配没配"，不给值
 *
 * 刻意**不**返回：network_code、gateway、netmask、deviceId、ip、name、
 * 设备数量、连接数、流量统计。要看这些请用 /admin。
 */
export async function healthResponse(env) {
  const cfg = resolveConfig(env);
  const backend = await getBackend();
  const storageOk = backend.kind === "blob";

  const body = {
    ok: true,
    // 版本标记：用于确认「代码是否真的部署上去了」。
    // 曾经的排查盲区 —— /health 每次返回完全一致，无法判断部署是否生效。
    rev: BUILD_REV,
    service: "vnts2-edgeone",
    protocol: "vnt2",
    mode: "p2p-punch-only",
    // storage=blob 才是期望值；memory 说明 Blob SDK 没装上，
    // 此时服务仍能工作，但**跨实例共享失效**（设备互相看不见）。
    storage: backend.kind,
    storageOk,
    // 只回答"配没配"，不透露值
    configured: !!cfg.networkCode,
  };

  if (!storageOk) {
    body.storageHint =
      "存储降级为内存，跨实例共享失效。请确认 package.json 里有 @edgeone/pages-blob 依赖，且构建时执行了 npm install。";
  }

  // 诊断用：仅在与 WebSocket 相关的地方出错才会有值。
  // 只放错误摘要，不含网络编号、设备等信息。
  if (registry.stats.lastError) {
    body.lastError = registry.stats.lastError;
  }

  return Response.json(body, { headers: { "cache-control": "no-store" } });
}

/**
 * 根路径状态页。**公开**，因此不渲染任何设备信息。
 * 需要查看设备表请访问 `/admin`（需 Bearer 令牌）。
 */
export function statusHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>vnts2 · EdgeOne</title>
<style>
  :root { color-scheme: light; }
  body { margin:0; padding:32px; font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif; background:#f7f8fa; color:#1f2328; }
  h1 { font-size:20px; margin:0 0 4px; }
  .sub { color:#656d76; margin-bottom:20px; }
  code { background:#eef1f4; padding:2px 6px; border-radius:4px; }
  .card { background:#fff; border:1px solid #d8dee4; border-radius:8px; padding:16px 20px; margin-bottom:16px; }
  .muted { color:#656d76; }
</style>
</head>
<body>
  <h1>vnts2 · EdgeOne</h1>
  <div class="sub">VNT 2.x 服务端 —— <b>纯 P2P 打洞辅助</b></div>
  <div class="card">
    <div>这是个 WebSocket 服务端，供 VNT 客户端连接使用。</div>
    <div class="muted" style="margin-top:8px">
      健康检查：<code>GET /health</code><br>
      管理接口（需鉴权）：<code>/admin</code>
    </div>
  </div>
  <div class="card muted">
    出于安全考虑，本页不展示任何设备或网络信息。
  </div>
</body>
</html>`;
}
