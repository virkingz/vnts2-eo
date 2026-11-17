// Catch-all 入口
//
// EdgeOne 是「文件即路由」：
//   cloud-functions/index.js     → 只映射到 /
//   cloud-functions/[[default]].js → 兜底所有未被更具体路由匹配的路径
//
// 没有它，/health、/admin/* 这些路径会去找不存在的文件、掉进静态 404。
// 本文件与 index.js 共用 _vnt/ws.js 与 _vnt/http.js 的同一份逻辑。

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
