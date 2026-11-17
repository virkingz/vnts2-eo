// WebSocket 接入
//
// ── 只用「回调对象」形态 ────────────────────────────────────────────────
// 这是官方 WebSocket 模板（pages-ai-voice-chat）的写法，也是实测能返回
// 101 Switching Protocols 的写法：
//
//   export const onRequest = async (context) => {
//     if (context.request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
//       return { websocket: { onopen, onmessage, onclose, onerror } };
//     }
//   };
//
// 注入的 ws 对象**只有 send 与 close**，没有 addEventListener / on / readyState；
// 事件由平台通过这些回调推给我们。
//
// ── 为什么不用 WebSocketPair（踩过的坑）────────────────────────────────
// 别处文档（含官方 Node Functions 的 WebSocket 示例）写的是
//   const { socket, response } = new WebSocketPair();
//   return response;
// 但实测本项目运行时**没有 WebSocketPair 全局**：
//   GET /health/ws → {"hasGlobal":false,"ctorType":"undefined"}
// 所以任何 `new WebSocketPair()` 都会抛 ReferenceError，被平台包成
//   502 CLOUD_FUNCTION_INVOCATION_FAILED
//
// 对照实验（curl，相同升级头）：
//   官方模板 /websocket → HTTP/1.1 101 Switching Protocols
//   本项目（用 WebSocketPair）→ HTTP/1.1 502
// 差异只在形态。改用回调对象后即与官方模板一致。
//
// ⚠️ 本文件不再有任何 WebSocketPair 调用，也不要再加回来。

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

function safeDecodeRequest(bytes) {
  try {
    return decodeRequestMessage(bytes);
  } catch {
    return { kind: "unknown" };
  }
}

/** 向 ws 发送，兼容 send / write；都不可用则静默丢弃 */
function sendTo(ws, data) {
  try {
    if (typeof ws?.send === "function") {
      ws.send(data);
      return true;
    }
    if (typeof ws?.write === "function") {
      ws.write(data);
      return true;
    }
  } catch {
    /* 连接已断开，忽略 */
  }
  return false;
}

/**
 * 兜底映射：某些运行时的 ws 是只读/冻结对象，挂不上自定义属性。
 * 用 WeakMap 保存「ws → 连接」，避免依赖属性写入成功。
 */
const connections = new WeakMap();

/** 一条连接的完整状态机，与具体 ws 实现解耦 */
function createConnection(ws, env) {
  let session;
  try {
    session = new Session(env || {});
    registry.stats.connectionsTotal++;
  } catch (e) {
    try {
      ws?.close?.();
    } catch {
      /* ignore */
    }
    registry.stats.lastError = `Session 构造失败: ${e?.message || e}`;
    return null;
  }

  const send = (data) => sendTo(ws, data);

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
      .catch((e) => {
        // 单帧异常不应断开连接；但记下来，便于线上排查
        registry.stats.lastError = `处理帧失败: ${e?.message || e}`;
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

function registerConnection(ws, env) {
  const conn = createConnection(ws, env);
  if (!conn) return null;
  connections.set(ws, conn);
  try {
    ws.__vnt = conn;
  } catch {
    // ws 可能不可写，WeakMap 已兜底
  }
  return conn;
}

function connOf(ws) {
  return ws?.__vnt || connections.get(ws) || null;
}

/**
 * 形态 B：回调对象。
 * 注入的 ws 只有 send/close，事件由平台通过这些回调推给我们。
 */
export function createWebSocketHandler(env) {
  return {
    async onopen(ws) {
      registerConnection(ws, env);
    },
    async onmessage(ws, message) {
      connOf(ws)?.feed(message);
    },
    onclose(ws) {
      const conn = connOf(ws);
      if (conn) {
        void conn.close();
        connections.delete(ws);
      }
    },
    onerror(ws) {
      const conn = connOf(ws);
      if (conn) {
        void conn.close();
        connections.delete(ws);
      }
    },
  };
}

export function probeWebSocket() {
  const info = {
    hasGlobal: typeof WebSocketPair !== "undefined",
    ctorType: typeof WebSocketPair,
  };
  return info;
}

/**
 * 接受一个 WebSocket 升级请求，返回可直接作为 handler 返回值的对象。
 *
 * 只走回调对象形态 —— 原因见文件头关于 WebSocketPair 的说明。
 */
export function acceptWebSocket(env) {
  return { websocket: createWebSocketHandler(env) };
}
