// 诊断端点：严格照官方示例（子目录 + onRequestGet + WebSocketPair）
//
// 官方 WebSocket 示例的文件路径是 cloud-functions/api/ws.js，
// 用 onRequestGet，挂在子目录下。本文件放在子目录 wsprobe/ 下复刻该结构，
// 用于验证「根目录 vs 子目录」是否是差异所在。
// 诊断完成后删除。

export function onRequestGet(context) {
  const { request } = context;

  const upgradeHeader = request.headers.get("Upgrade");
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
    return new Response("wsprobe: use WebSocket (path /wsprobe)", { status: 200 });
  }

  const { socket, response } = new WebSocketPair();

  socket.addEventListener("message", (event) => {
    socket.send(`Echo: ${event.data}`);
  });

  socket.addEventListener("close", () => {});

  return response;
}
