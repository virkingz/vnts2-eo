// vnts2 for EdgeOne — WebSocket 接入层
//
// EdgeOne Pages · Cloud Functions（Node.js 20）的 WebSocket 约定：
//
//   export function onRequest(context) {
//     const { socket, response } = new WebSocketPair();
//     socket.addEventListener("message", (e) => { ... });
//     return response;
//   }
//
// 注意：**不能**返回 `{ websocket: {...} }` 这类自定义对象 —— 那是别的平台的
// 约定，EdgeOne 会把它当成非法返回值，握手直接失败。
//
// VNT 2.x 客户端的 WSS 地址由 `wss://host:port` 构造（不带路径），
// 因此 WebSocket 必须挂在站点根路径 `/`（即本文件）。
// 非 upgrade 的 GET / 返回状态页，`/health` 返回 JSON 健康检查。

import { Session } from "./_vnt/server.js";
import { registry } from "./_vnt/state.js";
import { decodeRequestMessage } from "./_vnt/control-messages.js";

/** 尽可能广泛地兼容不同运行时的 socket 事件绑定方式 */
function on(socket, name, handler) {
  if (typeof socket.addEventListener === "function") {
    socket.addEventListener(name, handler);
    return true;
  }
  if (typeof socket.on === "function") {
    // 部分 Node 实现把 message 回调签名为 (data, isBinary)
    socket.on(name, (arg, isBinary) => handler({ data: arg, isBinary }));
    return true;
  }
  const prop = `on${name}`;
  if (prop in socket || typeof socket[prop] !== "function") {
    socket[prop] = handler;
    return true;
  }
  return false;
}

/** 把一帧数据统一成 Uint8Array */
function normalize(message) {
  if (!message) return null;
  if (message instanceof Uint8Array) return message;
  if (message instanceof ArrayBuffer) return new Uint8Array(message);
  if (Array.isArray(message)) return new Uint8Array(message);
  if (typeof message === "string") return new TextEncoder().encode(message);
  if (typeof Buffer !== "undefined" && Buffer.isBuffer?.(message)) {
    return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
  }
  if (message.buffer) {
    return new Uint8Array(message.buffer, message.byteOffset || 0, message.byteLength);
  }
  return null;
}

/** 从 message 事件里取出裸数据 */
function eventData(event) {
  if (event == null) return null;
  if (typeof event === "object" && "data" in event) return event.data;
  return event;
}

function safeDecodeRequest(bytes) {
  try {
    return decodeRequestMessage(bytes);
  } catch {
    return { kind: "unknown" };
  }
}

/** 全部连接处理逻辑都挂在这个 socket 上，生命周期跟随连接 */
function bindSocket(socket, env) {
  let session;
  try {
    session = new Session(env || {});
    registry.stats.connectionsTotal++;
  } catch {
    try {
      socket.close();
    } catch {
      /* ignore */
    }
    return;
  }

  const send = (data) => {
    try {
      socket.send(data);
    } catch {
      /* 连接已断开，忽略 */
    }
  };

  on(socket, "message", (event) => {
    const bytes = normalize(eventData(event));
    if (!bytes || bytes.length === 0) return;

    try {
      if (!session.registered) {
        // 首帧：裸 protobuf RequestMessage
        session.handleFirstFrame(bytes, send);
        return;
      }
      if (session.pendingConfirm) {
        // 预注册第二阶段：等待 ConfirmReg
        const { kind } = safeDecodeRequest(bytes);
        if (kind === "confirm_reg") session.handleConfirm(send);
        return;
      }
      session.handleDataPacket(bytes, send);
    } catch {
      // 单帧异常不应断开连接；交由上层超时/心跳回收
    }
  });

  on(socket, "close", () => {
    session.onClose();
  });

  on(socket, "error", () => {
    session.onClose();
  });
}

/**
 * 建立 WebSocket。
 *
 * EdgeOne 的 `WebSocketPair` 解构出 `{ socket, response }`；
 * Cloudflare 风格则返回 `[client, server]`。两种都支持，避免换平台后静默失败。
 */
function acceptWebSocket(env) {
  if (typeof WebSocketPair === "undefined") {
    throw new Error("当前运行时不提供 WebSocketPair，无法接受 WebSocket 连接");
  }
  const pair = new WebSocketPair();

  // EdgeOne 形态：{ socket, response }
  if (pair && pair.socket && pair.response) {
    pair.socket.accept?.();
    bindSocket(pair.socket, env);
    return pair.response;
  }

  // Cloudflare Worker 形态：[client, server]
  if (Array.isArray(pair) || typeof pair[0] !== "undefined") {
    const client = pair[0];
    const server = pair[1];
    server.accept?.();
    bindSocket(server, env);
    return new Response(null, { status: 101, webSocket: client });
  }

  throw new Error("WebSocketPair 返回值形态未知");
}

export const onRequest = async (context) => {
  const { request, env } = context;
  const upgrade = request.headers.get("Upgrade") || request.headers.get("upgrade");

  if (upgrade && upgrade.toLowerCase() === "websocket") {
    return acceptWebSocket(env);
  }

  const url = new URL(request.url);
  if (url.pathname === "/health" || url.pathname === "/healthz") {
    const nets = [];
    for (const net of registry.networks.values()) nets.push(net.toJSON());
    return Response.json({
      ok: true,
      service: "vnts2-edgeone",
      protocol: "vnt2",
      networks: registry.networks.size,
      connectionsTotal: registry.stats.connectionsTotal,
      bytesRelayed: registry.stats.bytesRelayed,
      uptimeSeconds: Math.floor((Date.now() - registry.startedAt) / 1000),
      detail: nets,
    });
  }

  return new Response(statusHtml(), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
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
  <div class="sub">VNT 2.x 服务端（WebSocket 中继）。客户端连接：<code>server = ["wss://你的域名:443"]</code></div>
  <div class="card">
    <div>健康检查：<code>GET /health</code></div>
    <div>当前实例网络数：<b>${registry.networks.size}</b>，累计连接：<b>${registry.stats.connectionsTotal}</b></div>
    <div style="color:#656d76;margin-top:8px">注意：EdgeOne 无全局单例原语，不同实例各自维护房间表；本页只反映当前实例。</div>
  </div>
  <pre>${escapeHtml(body)}</pre>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
