// WebSocket 接入
//
// ── 为什么同时支持两种形态 ───────────────────────────────────────────────
// EdgeOne 上存在两套写法，且**运行时能力随上下文不同**：
//
//   A) WebSocketPair（官方 Node Functions 文档的 WebSocket 示例）：
//        const { socket, response } = new WebSocketPair();
//        socket.addEventListener("message", (e) => { ... });
//        return response;                       ← 返回 Response
//
//   B) 回调对象（官方 WebSocket 模板 pages-ai-voice-chat）：
//        return { websocket: { onopen, onmessage, onclose, onerror } };
//        // 且注入的 ws 只有 send / close，事件靠回调推给我们
//
// 关键教训：**`typeof WebSocketPair` 在普通 HTTP 请求里可能是 undefined**，
// 而在 WebSocket 升级请求里却存在（或反之）。早期版本我在 HTTP 上下文里
// 探测一次就决定用哪种形态，导致升级路径走了错的分支 —— 表现为
// 502 CLOUD_FUNCTION_INVOCATION_FAILED（返回值平台不认）。
//
// 现在：升级时**优先用 WebSocketPair**（返回 Response，任何平台都合法），
// 不可用才回落回调对象。两条路径共用同一个连接状态机。
//
// 另：升级路径整体包 try/catch，失败时返回可读的 500 而不是让平台报 502，
// 便于线上定位（502 会把真实原因完全吞掉）。

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
 * 形态 A：WebSocketPair。
 * 官方 Node Functions 文档的写法，返回值是标准 Response —— 优先级最高。
 *
 * 同时兼容 EdgeOne 的 `{ socket, response }` 与 Cloudflare 的 `[client, server]`。
 */
function acceptWithPair(env) {
  const pair = new WebSocketPair();

  // EdgeOne：解构出 socket / response
  if (pair && pair.socket && pair.response) {
    // 注意：官方示例没有 socket.accept() 这一步（那是 Cloudflare 的写法），
    // 这里也严格不调用 —— 多调一次可能破坏升级握手。
    const socket = pair.socket;
    const conn = registerConnection(socket, env);
    if (conn) {
      bindSocketEvents(socket, conn);
    }
    return pair.response;
  }

  // Cloudflare：数组形态
  if (typeof pair[0] !== "undefined") {
    const client = pair[0];
    const server = pair[1];
    server.accept?.(); // Cloudflare 形态才需要
    const conn = registerConnection(server, env);
    if (conn) {
      bindSocketEvents(server, conn);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  throw new Error(
    "WebSocketPair 返回值形态未知（既不是 {socket,response} 也不是 [client,server]）",
  );
}

/** 给 WebSocketPair 风格的 socket 绑事件（这类对象通常有 addEventListener/on） */
function bindSocketEvents(socket, conn) {
  const bind = (name, handler) => {
    try {
      if (typeof socket.addEventListener === "function") {
        socket.addEventListener(name, handler);
        return true;
      }
      if (typeof socket.on === "function") {
        socket.on(name, (arg) => handler({ data: arg }));
        return true;
      }
      const prop = `on${name}`;
      socket[prop] = handler;
      return true;
    } catch {
      return false;
    }
  };

  bind("message", (event) => {
    const data = event && typeof event === "object" && "data" in event ? event.data : event;
    conn.feed(data);
  });
  bind("close", () => {
    void conn.close();
  });
  bind("error", () => {
    void conn.close();
  });
}

/**
 * 形态 B：回调对象。
 * 注入的 ws 只有 send/close，事件由平台通过这些回调推给我们。
 */
export function createWebSocketHandler(env) {
  return {
    onopen(ws) {
      registerConnection(ws, env);
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

/**
 * 探测 WebSocketPair 的真实形态。仅用于诊断，不参与正常流程。
 *
 * 返回可 JSON 序列化的描述 —— 注意不能把 socket 本身塞进去（无法序列化，
 * 且会导致 JSON.stringify 抛错），只看结构与可用方法。
 */
export function probeWebSocket() {
  const info = {
    hasGlobal: typeof WebSocketPair !== "undefined",
    ctorType: typeof WebSocketPair,
    constructOk: false,
    shape: null,
    shapeError: null,
  };
  if (!info.hasGlobal) return info;

  try {
    const pair = new WebSocketPair();
    info.constructOk = true;
    const parts = [];
    if (pair && typeof pair === "object") {
      if (pair.socket && pair.response) {
        parts.push("object-form:{socket,response}");
        parts.push(`socketMethods:${describeMethods(pair.socket)}`);
        parts.push(`responseIsResponse:${pair.response instanceof Response}`);
      }
      if (typeof pair[0] !== "undefined") {
        parts.push("array-form");
      }
      parts.push(`ownKeys:${safeKeys(pair)}`);
    }
    info.shape = parts.join(" | ");
  } catch (e) {
    info.shapeError = `${e?.name || "Error"}: ${e?.message || e}`;
  }
  return info;
}

function describeMethods(obj) {
  if (!obj) return "(null)";
  const names = [];
  for (const n of ["send", "close", "accept", "addEventListener", "on", "readyState"]) {
    if (typeof obj[n] === "function") names.push(`${n}()`);
    else if (n in obj) names.push(`${n}=${typeof obj[n]}`);
  }
  return names.join(",") || "(none)";
}

function safeKeys(obj) {
  try {
    return Object.keys(obj).join(",") || "(none)";
  } catch {
    return "(unavailable)";
  }
}

/**
 * 接受一个 WebSocket 升级请求。
 *
 * ⚠️ 本函数**绝不抛错**：抛错会被 EdgeOne 包成
 * 502 CLOUD_FUNCTION_INVOCATION_FAILED，真实原因完全丢失。
 * 出问题时返回可读的 500 Response，便于用 curl 直接看到原因。
 */
export function acceptWebSocket(env, request) {
  // ── 升级上下文探测 ──
  // 关键：HTTP 上下文里没有 WebSocketPair，不代表升级上下文也没有。
  // 前两次我拿 HTTP 上下文的探测结果去决定升级走哪条路，都猜错了。
  // 这里在**升级上下文内部**探测，返回 JSON 供 curl 查看。
  try {
    const url = request ? new URL(request.url) : null;
    if (url && url.searchParams.has("wsprobe")) {
      const globals = [];
      try {
        for (const k of Object.keys(globalThis)) {
          const lk = k.toLowerCase();
          if (lk.includes("socket") || lk.includes("web") || lk.includes("upgrade")) {
            globals.push(`${k}:${typeof globalThis[k]}`);
          }
        }
      } catch {
        globals.push("(无法枚举 globalThis)");
      }
      return Response.json(
        {
          inUpgradeContext: true,
          hasWebSocketPair: typeof WebSocketPair !== "undefined",
          wsPairType: typeof WebSocketPair,
          globals,
          requestHeaders: (() => {
            try {
              return Object.fromEntries(request.headers);
            } catch {
              return "(不可读)";
            }
          })(),
        },
        { headers: { "cache-control": "no-store" } },
      );
    }
  } catch (e) {
    // 探测失败不影响正常流程
    void e;
  }

  const notes = [];

  // 优先 WebSocketPair（官方 Node Functions 文档的写法，返回标准 Response）
  if (typeof WebSocketPair !== "undefined") {
    try {
      return acceptWithPair(env);
    } catch (e) {
      notes.push(`WebSocketPair 路径失败: ${e?.name || "Error"}: ${e?.message || e}`);
    }
  } else {
    notes.push("运行时没有 WebSocketPair 全局");
  }

  // 回落回调对象（官方 WebSocket 模板的写法）
  try {
    return { websocket: createWebSocketHandler(env) };
  } catch (e) {
    notes.push(`回调对象路径失败: ${e?.name || "Error"}: ${e?.message || e}`);
  }

  // 两条都失败：返回可读错误，而不是让平台报 502
  return new Response(
    JSON.stringify(
      {
        error: "WebSocket 升级失败",
        notes,
        probe: probeWebSocket(),
      },
      null,
      2,
    ),
    {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    },
  );
}
