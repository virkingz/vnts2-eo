// 诊断用：最小 WebSocket 回显端点（严格照抄官方示例）
//
// 用途：如果这个端点的 WebSocket 能连通，说明平台与开关都没问题，
// 问题出在主代码里；如果它也连不上，就是更底层的配置问题。
// 诊断完成后删除。

export function onRequest(context) {
  const { request } = context;
  const upgrade = request.headers.get("Upgrade") || request.headers.get("upgrade");

  if (!upgrade || upgrade.toLowerCase() !== "websocket") {
    return new Response("wstest: use WebSocket to connect (path /wstest)", {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const { socket, response } = new WebSocketPair();
  socket.addEventListener("message", (event) => {
    try {
      socket.send(event.data);
    } catch {
      /* ignore */
    }
  });
  socket.addEventListener("close", () => {});
  socket.addEventListener("error", () => {});
  return response;
}
