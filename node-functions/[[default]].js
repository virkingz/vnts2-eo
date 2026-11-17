// Catch-all 入口
//
// EdgeOne 是「文件即路由」：
//   node-functions/index.js     → 只映射到 /
//   node-functions/[[default]].js → 兜底所有未被更具体路由匹配的路径
//
// 没有它，/health、/admin/* 这些路径会去找不存在的文件、掉进静态 404。
// 本文件与 index.js 共用 _vnt/ws.js 与 _vnt/http.js 的同一份逻辑。

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
