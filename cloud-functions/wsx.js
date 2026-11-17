// 最小对照：与主代码**完全相同**的回调对象形态，但挂在子路径 /wsx（而非根 /）
export function onRequest(context) {
  const upgrade = context.request.headers.get("Upgrade");
  if (!upgrade || upgrade.toLowerCase() !== "websocket") {
    return new Response("wsx: callback-object at /wsx", { status: 200 });
  }
  return {
    websocket: {
      onopen(ws) { try { ws.send("wsx-open"); } catch {} },
      onmessage(ws, m) { try { ws.send(m); } catch {} },
      onclose() {},
      onerror() {},
    },
  };
}
