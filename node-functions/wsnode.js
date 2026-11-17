// A/B 实验 A：node-functions/ 目录下的最小 WS 处理器 → 路径 /wsnode
export function onRequest(context) {
  const upgrade = context.request.headers.get("Upgrade");
  if (!upgrade || upgrade.toLowerCase() !== "websocket") {
    return new Response("A:node-functions", { status: 200 });
  }
  const { socket, response } = new WebSocketPair();
  socket.addEventListener("message", (e) => {
    try { socket.send(e.data); } catch {}
  });
  socket.addEventListener("close", () => {});
  socket.addEventListener("error", () => {});
  return response;
}
