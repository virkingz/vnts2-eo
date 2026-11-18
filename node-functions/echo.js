// 纯回显端点 —— 仅用于区分「平台数据面」与「协议拒绝」：
// 收到任何消息都原样回显，不做协议校验。
// 若这里能收到回显 → 数据面正常，主端点的 1006 是协议拒绝（预期）
// 若这里也收不到 → 平台数据面确实不中继（与 edgetunnel 记录一致）
export const onRequest = async (context) => {
  const upgrade = context.request.headers.get("upgrade");
  if (upgrade?.toLowerCase() === "websocket") {
    const wsRef = { current: null };
    return {
      websocket: {
        async onopen(ws) { wsRef.current = ws; },
        async onmessage(ws, message) {
          try { ws.send(message); } catch { /* ignore */ }
        },
        onclose() {},
        onerror() {},
      },
    };
  }
  return new Response("echo endpoint", { status: 200 });
};
