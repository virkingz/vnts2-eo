// vnts2 for EdgeOne — WebSocket 接入层
//
// EdgeOne Cloud Functions(Node.js 20) 的 WebSocket 约定：
//   export const onRequest = async (context) => {
//     if (是 upgrade 请求) return { websocket: { onopen, onmessage, onclose, onerror } };
//     return new Response(...);
//   }
//
// VNT 2.x 客户端的 WSS 地址由 `wss://host:port` 构造（不带路径），
// 因此 WebSocket 必须挂在站点根路径 `/`。非 upgrade 的 GET / 返回状态页。

import { Session } from "./_vnt/server.js";
import { registry } from "./_vnt/state.js";
import { decodeRequestMessage } from "./_vnt/control-messages.js";

/** 每个 WebSocket 连接一个 Session（挂在 ws 上，跟随连接生命周期） */
function createHandler(env) {
  return {
    onopen(ws, request) {
      try {
        const session = new Session(env || {});
        ws.__vnt = session;
        registry.stats.connectionsTotal++;
      } catch (e) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
    },

    onmessage(ws, message, isBinary) {
      const session = ws.__vnt;
      if (!session) return;

      const bytes = normalize(message);
      if (!bytes) return;

      const send = (data) => {
        try {
          ws.send(data);
        } catch {
          /* 连接已断开，忽略 */
        }
      };

      try {
        if (!session.registered) {
          // 首帧：裸 protobuf RequestMessage
          session.handleFirstFrame(bytes, send);
          return;
        }
        if (session.pendingConfirm) {
          // 预注册第二阶段：等待 ConfirmReg
          const { kind } = safeDecodeRequest(bytes);
          if (kind === "confirm_reg") {
            session.handleConfirm(send);
            return;
          }
          // 其它帧在待确认阶段忽略
          return;
        }
        session.handleDataPacket(bytes, send);
      } catch {
        // 单帧异常不应断开连接；交由上层超时/心跳回收
      }
    },

    onclose(ws) {
      const session = ws.__vnt;
      if (session) {
        session.onClose();
        ws.__vnt = null;
      }
    },

    onerror(ws) {
      const session = ws.__vnt;
      if (session) {
        session.onClose();
        ws.__vnt = null;
      }
    },
  };
}

function normalize(message) {
  if (message instanceof Uint8Array) return message;
  if (message instanceof ArrayBuffer) return new Uint8Array(message);
  if (Array.isArray(message)) return new Uint8Array(message);
  if (typeof message === "string") return new TextEncoder().encode(message);
  if (message && message.buffer) {
    return new Uint8Array(message.buffer, message.byteOffset || 0, message.byteLength);
  }
  return null;
}

function safeDecodeRequest(bytes) {
  try {
    return decodeRequestMessage(bytes);
  } catch {
    return { kind: "unknown" };
  }
}

export const onRequest = async (context) => {
  const { request, env } = context;
  const upgrade = request.headers.get("upgrade") || request.headers.get("Upgrade");

  if (upgrade && upgrade.toLowerCase() === "websocket") {
    return { websocket: createHandler(env) };
  }

  // 非 upgrade 请求：给人看的说明页 / 健康检查
  const url = new URL(request.url);
  if (url.pathname === "/health" || url.pathname === "/healthz") {
    return Response.json({
      ok: true,
      service: "vnts2-edgeone",
      protocol: "vnt2",
      networks: registry.networks.size,
      connectionsTotal: registry.stats.connectionsTotal,
      uptimeSeconds: Math.floor((Date.now() - registry.startedAt) / 1000),
    });
  }

  return new Response(statusHtml(), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
};

function statusHtml() {
  const nets = [];
  for (const net of registry.networks.values()) nets.push(net.toJSON());
  const body = JSON.stringify({ networks: nets, stats: registry.stats }, null, 2);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>vnts2 · EdgeOne</title>
<style>
  :root { color-scheme: light; }
  body { margin:0; padding:32px; font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif; background:#f7f8fa; color:#1f2328; }
  h1 { font-size:20px; margin:0 0 4px; }
  .sub { color:#656d76; margin-bottom:20px; }
  code { background:#eef1f4; padding:2px 6px; border-radius:4px; }
  pre { background:#0d1117; color:#e6edf3; padding:16px; border-radius:8px; overflow:auto; font-size:12px; }
  .card { background:#fff; border:1px solid #d8dee4; border-radius:8px; padding:16px 20px; margin-bottom:16px; }
</style>
</head>
<body>
  <h1>vnts2 · EdgeOne</h1>
  <div class="sub">VNT 2.x 服务端（WebSocket 中继）。客户端连接：<code>-s wss://你的域名</code></div>
  <div class="card">
    <div>健康检查：<code>GET /health</code></div>
    <div>当前实例网络数：<b>${registry.networks.size}</b>，累计连接：<b>${registry.stats.connectionsTotal}</b></div>
  </div>
  <pre>${escapeHtml(body)}</pre>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
