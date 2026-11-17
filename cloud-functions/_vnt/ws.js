// WebSocket 接入
//
// ── EdgeOne 上唯一被官方模板验证过的写法 ──────────────────────────────────
// 官方 WebSocket 模板（pages-ai-voice-chat，Node Functions）用的是**回调对象**：
//
//   export const onRequest = async (context) => {
//     if (context.request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
//       return { websocket: { onopen, onmessage, onclose, onerror } };
//     }
//     return new Response('...', { status: 426 });
//   };
//
// 而**注入的 ws 对象只有 `send` 与 `close`** —— 没有 addEventListener，
// 也没有 readyState。事件由平台通过 onopen/onmessage/... 回调推给我们。
//
// 早期版本我按另一处文档的写法（`const { socket, response } = new WebSocketPair()`）
// 实现，并加了「没有 WebSocketPair 就回落到回调对象」的探测。实测线上：
//   * 运行时**没有** WebSocketPair → 走了回退分支
//   * 但回退分支里我用 addEventListener/on 绑定事件 → 全部绑定失败
//   * 结果：握手后收不到任何消息、发不出任何东西，客户端一直显示「未连接」
//
// 现在按官方模板的确切形态实现；对 ws 的方法（send/write）与事件绑定
// 都做宽松兼容，不依赖任何特定成员存在。

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

/**
 * 一条连接的完整状态机，与具体 ws 实现解耦。
 */
function createConnection(ws, env) {
  let session;
  try {
    session = new Session(env || {});
    registry.stats.connectionsTotal++;
  } catch {
    try {
      ws?.close?.();
    } catch {
      /* ignore */
    }
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

function connOf(ws) {
  return ws?.__vnt || connections.get(ws) || null;
}

/**
 * 建立回调对象形态的 handler。
 *
 * onmessage 的第三个参数 `isBinary` 只用于诊断 —— VNT 协议全程二进制，
 * 但有些运行时会把它递成字符串，normalize() 两种都吃。
 */
export function createWebSocketHandler(env) {
  return {
    onopen(ws) {
      const conn = createConnection(ws, env);
      if (!conn) return;
      connections.set(ws, conn);
      try {
        ws.__vnt = conn;
      } catch {
        // ws 可能不可写，WeakMap 已兜底
      }
    },

    onmessage(ws, message) {
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

/** 接受一个 WebSocket 升级请求，返回可直接作为 handler 返回值的对象 */
export function acceptWebSocket(env) {
  return { websocket: createWebSocketHandler(env) };
}
