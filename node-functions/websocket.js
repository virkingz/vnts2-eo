// 专用文件（非 catch-all）：路径 /websocket
// 官方模板用 node-functions/websocket.ts + 路径 /websocket；
// 此前测不了 —— cloud-functions/ 优先级更高，把请求全接管了。
// 现已移除 cloud-functions/，本次可有效验证。
export const onRequest = async (context) => {
  const upgrade = context.request.headers.get('upgrade');
  if (upgrade?.toLowerCase() === 'websocket') {
    return {
      websocket: {
        async onopen(ws) { try { ws.send('dedicated-open'); } catch {} },
        async onmessage(ws, m) { try { ws.send(m); } catch {} },
        onclose() {}, onerror() {},
      },
    };
  }
  return new Response('dedicated websocket file at /websocket', { status: 200 });
};
