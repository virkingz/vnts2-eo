// vnts2 for EdgeOne — WebSocket 接入层（根路径入口）
//
// EdgeOne 是「文件即路由」：
//   本文件             → 只映射到 /
//   [[default]].js     → 兜底其它路径（/health、/admin/* 等）
//
// WebSocket 与 HTTP 的具体处理都在 _vnt/ 下，两个入口共用同一份实现，
// 避免「同一个逻辑写两遍、改一处漏一处」。
//
// VNT 2.x 客户端的 WSS 地址由 `wss://host:port` 构造（不带路径），
// 因此 WebSocket 必须挂在站点根路径 `/`。

import { handleHttp } from "./_vnt/http.js";
import { acceptWebSocket } from "./_vnt/ws.js";

/**
 * ⚠️ 这个函数**不能是 async**。
 *
 * WebSocket 升级握手要求**同步**拿到 Response：升级请求走 async 函数时，
 * 平台拿到的是 Promise 而非 Response，握手失败并报
 * 502 CLOUD_FUNCTION_INVOCATION_FAILED —— 而普通 HTTP 请求能正常处理
 * Promise，所以 /health 一直是 200，只有 wss:// 连不上。
 * 官方 WebSocket 示例同样是同步的 `export function onRequestGet`。
 *
 * 因此这里刻意不写 async：升级路径同步返回，HTTP 路径返回 Promise<Response> 即可。
 */
export const onRequest = async (context) => {
  const { request, env } = context;
  const upgrade = request.headers.get("Upgrade") || request.headers.get("upgrade");

  if (upgrade && upgrade.toLowerCase() === "websocket") {
    return acceptWebSocket(env);
  }

  return handleHttp(request, env);
};
