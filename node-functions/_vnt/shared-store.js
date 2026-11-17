// 跨实例共享状态（EdgeOne Blob）
//
// 为什么是 Blob 而不是 KV：
//   KV 官方明确「**仅 Edge Functions 支持**」，而 Edge Functions 的 V8 运行时
//   **不支持 WebSocket** —— 本服务端必须跑在 Cloud Functions，所以 KV 用不了。
//   Blob 提供官方 Node SDK（@edgeone/pages-blob），是 Cloud Functions 唯一可用的
//   持久化存储，并且支持 { consistency: "strong" } 强一致读。
//
// 存储布局（**每个设备一个 key**）：
//   dev/{net}/{deviceId}     → 设备登记：{ id, ip, n(name), t(type), seen, k }
//   sig/{net}/{hexIp}/{seq}  → 待投递的打洞信令
//
// 为什么不把整张设备表存成一个大 JSON：
//   并发写会互相覆盖 ——
//     A 读全表(无 d1) → 加 d1 → 写回
//     B 读全表(无 d1) → 加 d2 → 写回     ← d1 被覆盖，设备凭空消失
//   按设备分 key 后各写各的，不会丢。
//
// 写入者与冲突面：
//   * 管理 API 写「登记信息」（增删改设备）
//   * 客户端心跳只改自己那条的 seen
//   两者都只碰自己那一个 key，不跨设备，因此不会互相覆盖。

export const DEVICE_PREFIX = "dev/";
export const SIGNAL_PREFIX = "sig/";

/** 信令在信箱里的存活时间；超过即视为投递失败并清理 */
export const SIGNAL_TTL_MS = 30_000;

/** 设备被视为在线的心跳窗口（毫秒）。VNT 客户端心跳 5 秒，留足余量 */
export const ONLINE_WINDOW_MS = 30_000;

/** 本实例标识：模块加载（≈每个函数实例）生成一次，用于诊断设备落在哪个实例 */
export const INSTANCE_TOKEN = Math.random().toString(36).slice(2, 10);

/**
 * network_code 与 device_id 都来自客户端，可能含 `/` 等字符。
 * 直接拼进 key 会破坏目录层级、让前缀匹配串味，因此统一编码。
 */
function enc(s) {
  return encodeURIComponent(String(s));
}

function hexIp(ipU32) {
  return (Number(ipU32) >>> 0).toString(16).padStart(8, "0");
}

export function deviceKey(code, deviceId) {
  return `${DEVICE_PREFIX}${enc(code)}/${enc(deviceId)}`;
}

export function devicePrefixFor(code) {
  return `${DEVICE_PREFIX}${enc(code)}/`;
}

export function signalKey(code, destIpU32, seq) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${SIGNAL_PREFIX}${enc(code)}/${hexIp(destIpU32)}/${seq}-${rand}`;
}

export function signalPrefixFor(code, ipU32) {
  return `${SIGNAL_PREFIX}${enc(code)}/${hexIp(ipU32)}/`;
}

/** 从 deviceKey 反解 deviceId（list 只返回 key，需要还原身份） */
export function deviceIdFromKey(key) {
  const parts = String(key).split("/");
  const last = parts[parts.length - 1] || "";
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

// ---------------------------------------------------------------------------
// 后端
// ---------------------------------------------------------------------------

/** 强一致读失败时回落到默认读，避免个别套餐/SDK 版本不支持该选项时功能整体挂掉 */
async function getText(store, key, strong) {
  try {
    return await store.get(key, strong ? { type: "text", consistency: "strong" } : { type: "text" });
  } catch (error) {
    if (strong) return store.get(key, { type: "text" });
    throw error;
  }
}

async function listKeys(store, prefix, strong) {
  try {
    const { blobs } = await store.list(strong ? { prefix, consistency: "strong" } : { prefix });
    return (blobs || []).map((b) => b.key);
  } catch (error) {
    if (strong) {
      const { blobs } = await store.list({ prefix });
      return (blobs || []).map((b) => b.key);
    }
    throw error;
  }
}

function blobBackend(store) {
  return {
    kind: "blob",
    async get(key) {
      // 强一致读：注册前必须看到最新的登记信息，否则可能放行未授权的设备
      return getText(store, key, true);
    },
    async put(key, text) {
      await store.set(key, text);
    },
    async del(key) {
      await store.delete(key);
    },
    async list(prefix) {
      return listKeys(store, prefix, true);
    },
  };
}

/**
 * 内存后端。用于：
 *   - 单元测试注入（globalThis.__VNT_SHARED_BACKEND__）
 *   - 未安装 `@edgeone/pages-blob` 时的降级：退化成单实例行为，
 *     功能降级但不会崩（本地 `edgeone pages dev` 也能跑）
 */
export function createMemoryBackend() {
  const objects = new Map();
  return {
    kind: "memory",
    async get(key) {
      return objects.has(key) ? objects.get(key) : null;
    },
    async put(key, text) {
      objects.set(key, text);
    },
    async del(key) {
      objects.delete(key);
    },
    async list(prefix) {
      return [...objects.keys()].filter((k) => k.startsWith(prefix));
    },
  };
}

let backendPromise = null;

/**
 * 取得共享存储后端。
 * 优先用外部注入（测试），其次尝试装载 Blob SDK，都没有就退化成内存后端。
 */
export function getBackend() {
  if (!backendPromise) {
    backendPromise = (async () => {
      if (globalThis.__VNT_SHARED_BACKEND__) return globalThis.__VNT_SHARED_BACKEND__;
      try {
        const mod = await import("@edgeone/pages-blob");
        return blobBackend(mod.getStore({ name: "vnts2", consistency: "strong" }));
      } catch {
        return createMemoryBackend();
      }
    })();
  }
  return backendPromise;
}

/** 测试用：重置后端缓存 */
export function resetBackend() {
  backendPromise = null;
}
