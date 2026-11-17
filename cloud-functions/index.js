// vnts2 for EdgeOne — WebSocket 接入层
//
// EdgeOne 上见过两种 WebSocket 约定，本项目**两种都支持**，按运行时能力自动选择：
//
//   A) 官方 Node Functions 文档 & 官方模板的写法：
//        const { socket, response } = new WebSocketPair();
//        socket.addEventListener("message", (e) => { ... });
//        return response;
//
//   B) 回调对象写法（部分文档 / 边缘函数形态）：
//        return { websocket: { onopen, onmessage, onclose, onerror } };
//
// 注意：把 A 的对象形态（`return { websocket }`）当返回值交给只认 WebSocketPair 的
// 运行时会直接判为非法返回，握手失败 —— 反过来也一样。所以这里做能力探测，
// 而不是赌某一种。
//
// VNT 2.x 客户端的 WSS 地址由 `wss://host:port` 构造（不带路径），
// 因此 WebSocket 必须挂在站点根路径 `/`（即本文件）。
// 非 upgrade 的 GET / 返回状态页，`/health` 返回 JSON 健康检查。

import { Session } from "./_vnt/server.js";
import { registry, resolveConfig } from "./_vnt/state.js";
import { decodeRequestMessage } from "./_vnt/control-messages.js";
import { handleAdmin } from "./_vnt/admin.js";

/** 把一帧数据统一成 Uint8Array */
function normalize(message) {
  if (!message) return null;
  if (message instanceof Uint8Array) return message;
  if (message instanceof ArrayBuffer) return new Uint8Array(message);
  if (Array.isArray(message)) return new Uint8Array(message);
  if (typeof Buffer !== "undefined" && Buffer.isBuffer?.(message)) {
    return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
  }
  if (typeof message === "string") return new TextEncoder().encode(message);
  if (message.buffer) {
    return new Uint8Array(message.buffer, message.byteOffset || 0, message.byteLength);
  }
  return null;
}

/** 从 message 事件里取出裸数据（Event 形态取 .data，其余原样） */
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

/**
 * 一条连接的完整状态机。与具体 socket 实现解耦：
 * 只要给它 `rawSend(bytes)` 和一个「收到一帧」的入口就能工作。
 */
function createConnection(socket, env) {
  let session;
  try {
    session = new Session(env || {});
    registry.stats.connectionsTotal++;
  } catch {
    try {
      socket?.close?.();
    } catch {
      /* ignore */
    }
    return null;
  }

  const send = (data) => {
    try {
      socket.send(data);
    } catch {
      /* 连接已断开，忽略 */
    }
  };

  /**
   * 处理一帧。
   *
   * 注册与心跳都要读写共享存储（Blob），所以是异步的。
   * 帧之间**必须串行**：客户端可能在注册响应到达前就发出下一帧，
   * 并发处理会让「首帧注册」与「数据帧」乱序，导致未注册就丢包。
   */
  let chain = Promise.resolve();
  const feed = (raw) => {
    const bytes = normalize(raw);
    if (!bytes || bytes.length === 0) return;
    chain = chain
      .then(async () => {
        if (!session.registered) {
          // 首帧：裸 protobuf RequestMessage
          await session.handleFirstFrame(bytes, send);
          return;
        }
        if (session.pendingConfirm) {
          // 预注册第二阶段：等待 ConfirmReg
          const { kind } = safeDecodeRequest(bytes);
          if (kind === "confirm_reg") session.handleConfirm(send);
          return;
        }
        await session.handleDataPacket(bytes, send);
      })
      .catch(() => {
        // 单帧异常不应断开连接；交由上层超时/心跳回收
      });
  };

  /** 连接结束：等排队的帧处理完，再标记离线并通知对端 */
  const close = () =>
    chain
      .then(() => session.onClose())
      .catch(() => {
        /* 忽略 */
      });

  return { session, send, feed, close };
}

/** 尽可能广泛地兼容不同运行时的 socket 事件绑定方式 */
function on(socket, name, handler) {
  if (typeof socket.addEventListener === "function") {
    socket.addEventListener(name, handler);
    return true;
  }
  if (typeof socket.on === "function") {
    socket.on(name, (arg, isBinary) => handler({ data: arg, binary: isBinary }));
    return true;
  }
  const prop = `on${name}`;
  if (typeof socket[prop] !== "function") {
    socket[prop] = handler;
    return true;
  }
  return false;
}

/** 形态 B：回调对象 */
function legacyHandler(env) {
  return {
    onopen(ws) {
      ws.__vnt = createConnection(ws, env);
    },
    onmessage(ws, message) {
      ws.__vnt?.feed(message);
    },
    onclose(ws) {
      ws.__vnt?.session.onClose();
      ws.__vnt = null;
    },
    onerror(ws) {
      ws.__vnt?.session.onClose();
      ws.__vnt = null;
    },
  };
}

/**
 * 形态 A：WebSocketPair。
 * EdgeOne 解构出 `{ socket, response }`；Cloudflare 风格返回 `[client, server]`。
 */
function acceptWithPair(env) {
  const pair = new WebSocketPair();

  if (pair && pair.socket && pair.response) {
    pair.socket.accept?.();
    bindSocket(pair.socket, env);
    return pair.response;
  }

  if (typeof pair[0] !== "undefined") {
    const client = pair[0];
    const server = pair[1];
    server.accept?.();
    bindSocket(server, env);
    return new Response(null, { status: 101, webSocket: client });
  }

  throw new Error("WebSocketPair 返回值形态未知（既不是 {socket,response} 也不是 [client,server]）");
}

function bindSocket(socket, env) {
  const conn = createConnection(socket, env);
  if (!conn) return;

  on(socket, "message", (event) => conn.feed(eventData(event)));
  on(socket, "close", () => {
    void conn.close();
  });
  on(socket, "error", () => {
    void conn.close();
  });
}

export const onRequest = async (context) => {
  const { request, env } = context;
  const upgrade = request.headers.get("Upgrade") || request.headers.get("upgrade");

  if (upgrade && upgrade.toLowerCase() === "websocket") {
    if (typeof WebSocketPair !== "undefined") return acceptWithPair(env);
    return { websocket: legacyHandler(env) };
  }

  // 管理接口（设备登记）优先于状态页
  const adminResp = await handleAdmin(request, env);
  if (adminResp) return adminResp;

  const url = new URL(request.url);
  if (url.pathname === "/health" || url.pathname === "/healthz") {
    const cfg = resolveConfig(env);
    const net = cfg.networkCode ? registry.find(cfg.networkCode) : null;
    const nets = [];
    for (const n of registry.networks.values()) nets.push(n.toJSON());
    return Response.json({
      ok: true,
      service: "vnts2-edgeone",
      protocol: "vnt2",
      mode: "p2p-punch-only",
      wsMode: typeof WebSocketPair !== "undefined" ? "websocket-pair" : "callback-object",
      network: cfg.networkCode || null,
      registeredDevices: net ? net.shared.size : 0,
      onlineDevices: net ? net.count().online : 0,
      connectionsTotal: registry.stats.connectionsTotal,
      bytesSignaled: registry.stats.bytesSignaled,
      uptimeSeconds: Math.floor((Date.now() - registry.startedAt) / 1000),
      detail: nets,
    });
  }

  return new Response(statusHtml(env), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
};

function statusHtml(env) {
  const cfg = resolveConfig(env);
  const net = cfg.networkCode ? registry.find(cfg.networkCode) : null;
  const devices = net ? net.toJSON().devices : [];
  const body = JSON.stringify(
    {
      networkCode: cfg.networkCode || "(未配置 VNT_NETWORK)",
      gateway: net ? u32Fallback(net.gateway) : "-",
      devices,
      stats: registry.stats,
    },
    null,
    2,
  );
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>vnts2 · EdgeOne · P2P</title>
<style>
  :root { color-scheme: light; }
  body { margin:0; padding:32px; font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif; background:#f7f8fa; color:#1f2328; }
  h1 { font-size:20px; margin:0 0 4px; }
  .sub { color:#656d76; margin-bottom:20px; }
  code { background:#eef1f4; padding:2px 6px; border-radius:4px; }
  pre { background:#0d1117; color:#e6edf3; padding:16px; border-radius:8px; overflow:auto; font-size:12px; }
  .card { background:#fff; border:1px solid #d8dee4; border-radius:8px; padding:16px 20px; margin-bottom:16px; }
  .warn { background:#fff8e5; border-color:#e6d9a8; }
</style>
</head>
<body>
  <h1>vnts2 · EdgeOne</h1>
  <div class="sub">VNT 2.x 服务端 —— <b>纯 P2P 打洞辅助</b>，不中转数据</div>
  <div class="card">
    <div>客户端连接：<code>server = ["wss://你的域名:443"]</code></div>
    <div>网络编号：<code>${cfg.networkCode || "未配置 VNT_NETWORK"}</code>（仅来自环境变量）</div>
    <div>已登记设备：<b>${devices.length}</b>　在线：<b>${net ? net.count().online : 0}</b></div>
    <div>健康检查：<code>GET /health</code>　设备登记：<code>/admin</code></div>
  </div>
  ${cfg.networkCode ? "" : '<div class="card warn">尚未配置 <code>VNT_NETWORK</code>，客户端无法注册。</div>'}
  <div class="card" style="color:#656d76">
    不同实例各自维护连接视图，本页只反映当前实例；设备表与打洞信令经 Blob 共享，
    因此设备可见性不受影响。
  </div>
  <pre>${escapeHtml(body)}</pre>
</body>
</html>`;
}

/** 仅用于状态页展示，避免为了格式化再引一次模块 */
function u32Fallback(v) {
  const n = Number(v) >>> 0;
  return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
