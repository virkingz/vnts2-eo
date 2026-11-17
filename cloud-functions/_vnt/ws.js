// WebSocket 接入
//
// EdgeOne Node Functions 上见过两种 WebSocket 约定，本项目**两种都支持**，
// 按运行时能力探测：
//
//   A) 官方 Node Functions 文档 & 官方模板的写法：
//        const { socket, response } = new WebSocketPair();
//        socket.addEventListener("message", (e) => { ... });
//        return response;
//
//   B) 回调对象写法（部分文档 / 边缘函数形态）：
//        return { websocket: { onopen, onmessage, onclose, onerror } };
//
// 把 A 的对象形态交给只认 WebSocketPair 的运行时会直接判为非法返回、握手失败
// —— 反过来也一样。所以这里做能力探测，而不是赌某一种。
//
// 单独成模块的原因：入口有两个（`index.js` 映射 `/`、
// `[[default]].js` 接 catch-all），WebSocket 逻辑必须只有一份。

import { Session } from "./server.js";
import { registry } from "./state.js";
import { decodeRequestMessage } from "./control-messages.js";

/** 把一帧数据统一成 Uint8Array */
export function normalize(message) {
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
 * 一条连接的完整状态机，与具体 socket 实现解耦。
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
   * 处理一帧。注册与心跳要读写共享存储（Blob），所以是异步的。
   *
   * 帧之间**必须串行**：客户端可能在注册响应到达前就发下一帧，
   * 并发处理会让「首帧注册」与「数据帧」乱序，导致未注册就丢包。
   */
  let chain = Promise.resolve();
  const feed = (raw) => {
    const bytes = normalize(raw);
    if (!bytes || bytes.length === 0) return;
    chain = chain
      .then(async () => {
        if (!session.registered) {
          await session.handleFirstFrame(bytes, send);
          return;
        }
        if (session.pendingConfirm) {
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
      void ws.__vnt?.close();
      ws.__vnt = null;
    },
    onerror(ws) {
      void ws.__vnt?.close();
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

  throw new Error(
    "WebSocketPair 返回值形态未知（既不是 {socket,response} 也不是 [client,server]）",
  );
}

/** 接受一个 WebSocket 升级请求，返回可直接作为 handler 返回值的对象 */
export function acceptWebSocket(env) {
  if (typeof WebSocketPair !== "undefined") return acceptWithPair(env);
  return { websocket: legacyHandler(env) };
}
