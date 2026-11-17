// 诊断端点：收到 WebSocket 升级请求时**不做任何 WebSocket 操作**，
// 直接返回一个普通 Response 并打印日志。
//
// 逻辑：如果这个也返回 502，说明平台在「带 Connection: Upgrade 的请求」
// 这条路径上、进入我的代码之前/之外就失败了 —— 与 WebSocketPair 无关。
// 如果它返回 200（我的 Response 生效），说明是 WebSocketPair/回调对象本身的问题。

export function onRequest(context) {
  const h = context.request.headers;
  const upgrade = h.get("Upgrade");
  const conn = h.get("Connection");

  // 无论什么请求都返回 JSON，描述看到的头
  return new Response(
    JSON.stringify({
      note: "此为诊断端点，不执行任何 WebSocket 操作",
      upgradeHeader: upgrade,
      connectionHeader: conn,
      userAgent: h.get("User-Agent"),
      looksLikeUpgrade:
        !!upgrade && upgrade.toLowerCase() === "websocket" &&
        !!conn && conn.toLowerCase().includes("upgrade"),
    }),
    {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    },
  );
}
