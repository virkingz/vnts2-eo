// Node Functions 目录（node-functions/）—— 官方对照表标注 WebSocket ✅ 只在此支持
// 路径 /nfws 是独有的，避免与 cloud-functions/ 的任何路径冲突（上次实验的失误）
export const onRequest = async (context) => {
  const upgrade = context.request.headers.get("upgrade");
  if (upgrade?.toLowerCase() === "websocket") {
    return {
      websocket: {
        async onopen(ws) { try { ws.send("nf-open"); } catch {} },
        async onmessage(ws, m) { try { ws.send(m); } catch {} },
        onclose() {},
        onerror() {},
      },
    };
  }
  return new Response("nfws-node-functions-OK", { status: 200 });
};
