// 诊断：完全复刻官方 WS 模板的结构
//   node-functions/websocket.js  → 路径 /websocket
//   async onRequest
//   返回 { websocket: {...} } 回调对象
// 对照我的 /（根路径 + cloud-functions/），验证路径与目录是否是差异所在。

export const onRequest = async (context) => {
  const upgradeHeader = context.request.headers.get("upgrade");

  if (upgradeHeader?.toLowerCase() === "websocket") {
    return { websocket: createWsHandler() };
  }

  return new Response("node-fn websocket: connect via WebSocket at /websocket", {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
};

function createWsHandler() {
  return {
    async onopen(ws) {
      try {
        ws.send("tpl-open");
      } catch {
        /* ignore */
      }
    },
    async onmessage(ws, message) {
      try {
        ws.send(message);
      } catch {
        /* ignore */
      }
    },
    onclose() {},
    onerror() {},
  };
}
