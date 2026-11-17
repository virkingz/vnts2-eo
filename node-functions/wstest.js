// 诊断：把 WebSocket 端点放到 node-functions/ 目录下（而非 cloud-functions/）
//
// 依据：官方 WebSocket 模板 pages-ai-voice-chat 与 Bark 项目都用 node-functions/。
// 怀疑 WS 长连接只在该目录下被平台识别。
// 诊断完成后删除。

export function onRequest(context) {
  const upgrade = context.request.headers.get("Upgrade");

  if (!upgrade || upgrade.toLowerCase() !== "websocket") {
    return new Response("node-fn wstest: use WebSocket (path /wstest)", { status: 200 });
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
