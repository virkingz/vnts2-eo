// B：cloud-functions/ 目录 + **回调对象**形态（不碰 WebSocketPair）
// 验证：运行时没有 WebSocketPair，用它必然抛 ReferenceError → 502；
// 改用官方模板的回调对象形态应当能 101。
export function onRequest(context) {
  const upgrade = context.request.headers.get("Upgrade");
  if (!upgrade || upgrade.toLowerCase() !== "websocket") {
    return new Response("B2:cloud-functions(callback-object)", { status: 200 });
  }
  return {
    websocket: {
      onopen(ws) { try { ws.send("B2-open"); } catch {} },
      onmessage(ws, m) { try { ws.send(m); } catch {} },
      onclose() {},
      onerror() {},
    },
  };
}
