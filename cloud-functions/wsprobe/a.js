// 诊断端点：子目录 + onRequest（非 Get 专用）+ 回调对象形态
export function onRequest(context) {
  const upgrade = context.request.headers.get("Upgrade");
  if (!upgrade || upgrade.toLowerCase() !== "websocket") {
    return new Response("wsprobe-a: use WebSocket (path /wsprobe/a)", { status: 200 });
  }
  return {
    websocket: {
      onopen(ws) { try { ws.send("wsprobe-a-open"); } catch {} },
      onmessage(ws, m) { try { ws.send(m); } catch {} },
      onclose() {},
      onerror() {},
    },
  };
}
