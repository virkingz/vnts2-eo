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

export const onRequest = async (context) => {
  const { request, env } = context;
  const upgrade = request.headers.get("Upgrade") || request.headers.get("upgrade");

  if (upgrade && upgrade.toLowerCase() === "websocket") {
    return acceptWebSocket(env);
  }

  return handleHttp(request, env);
};
