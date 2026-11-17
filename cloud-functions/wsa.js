// 诊断端点 A：回调对象形态（官方 WebSocket 模板 pages-ai-voice-chat 的写法）
//
// 官方模板里注入的 ws 只有 send/close，事件由平台通过 onopen/onmessage/... 回调推送。
// 本文件是那个写法的最小实现，用于验证该形态能否握手成功。

export function onRequest(context) {
  const { request } = context;
  const upgrade = request.headers.get("Upgrade") || request.headers.get("upgrade");

  if (!upgrade || upgrade.toLowerCase() !== "websocket") {
    return new Response("wsa: use WebSocket to connect (path /wsa)", {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  return {
    websocket: {
      onopen(ws) {
        try {
          ws.send("wsa-open");
        } catch {
          /* ignore */
        }
      },
      onmessage(ws, message) {
        try {
          ws.send(message);
        } catch {
          /* ignore */
        }
      },
      onclose() {},
      onerror() {},
    },
  };
}
