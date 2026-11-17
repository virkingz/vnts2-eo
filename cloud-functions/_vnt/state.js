// 跨实例共享设备表 + 本实例连接表
//
// EdgeOne 没有 Durable Object，同一 network_code 的客户端可能落在不同函数实例。
// 本文件解决两件事：
//   1. 共享设备表 —— 所有实例看到同一批设备
//   2. 打洞信令跨实例投递 —— PunchStart1/2 必须送达对端
//
// 【地址模型：设备登记制，不做 DHCP】
// 设备由**管理 API 预先登记**（deviceId + ip + name），客户端注册时必须
// 报出已登记的 deviceId 与 ip 且完全匹配，否则拒绝连接。
//
// 这样做的三个好处：
//   * 不存在并发分配 → 没有 IP 冲突窗口（Blob 没有 compare-and-swap，
//     服务端动态分配必须靠「写-回读核对」绕路，登记制直接绕开了这个问题）
//   * 天然是设备白名单 → 只知道 network_code 无法加入网络
//   * 服务端掌握权威 → 不再是「客户端报什么就是什么」
//
// ⚠️ 存储布局：**每设备一个 key**。两个实例并发写不同的设备时若共用一个大 JSON
// 会互相覆盖（A 读全表 → 加 d1 → 写回；B 读全表 → 加 d2 → 写回，d1 丢失）。
// 按设备分 key 后各写各的。管理 API 与心跳也只碰自己那一条，不跨设备。

import { ipToU32, u32ToIp, maskToPrefixLen } from "./packet.js";
import {
  getBackend,
  deviceKey,
  devicePrefixFor,
  deviceIdFromKey,
  signalKey,
  signalPrefixFor,
  ONLINE_WINDOW_MS,
  SIGNAL_TTL_MS,
  INSTANCE_TOKEN,
} from "./shared-store.js";

/** 默认网络配置（可用环境变量覆盖） */
export const DEFAULTS = {
  gateway: "10.26.0.1",
  netmask: "255.255.255.0",
  leaseSeconds: 7 * 24 * 3600,
  serverVersion: "vnts2-edgeone/1.2.0",
};

/**
 * 服务端实例标识。
 *
 * 客户端（vnt-core `control_message.rs`）硬校验：非空时必须**恰好 32 字节**，
 * 否则直接 bail 并断开注册。用固定常量而非随机值 —— 该字段一旦变化，
 * 客户端会当成「换了服务器」并清空本地节点缓存，表现为在线数归零。
 */
const SERVER_INSTANCE_ID = (() => {
  const seed = "VNTS2-EDGEONE-SERVER-INSTANCE-01";
  const bytes = new Uint8Array(32);
  bytes.set(new TextEncoder().encode(seed).subarray(0, 32), 0);
  return bytes;
})();

export function serverInstanceId() {
  return SERVER_INSTANCE_ID;
}

/** 注册拒绝原因 */
export const REG_NOT_REGISTERED = "not_registered";
export const REG_IP_MISMATCH = "ip_mismatch";
export const REG_IP_INVALID = "ip_invalid";

export class Registry {
  constructor() {
    this.networks = new Map();
    this.startedAt = Date.now();
    this.stats = {
      connectionsTotal: 0,
      signalsRelayed: 0,
      signalsForwarded: 0,
      signalsQueued: 0,
      bytesSignaled: 0,
    };
  }

  network(code, config) {
    let net = this.networks.get(code);
    if (!net) {
      net = new NetworkState(code, config);
      this.networks.set(code, net);
    }
    return net;
  }

  find(code) {
    return this.networks.get(code) || null;
  }
}

export class NetworkState {
  constructor(code, config) {
    this.code = code;
    this.gateway = ipToU32(config.gateway);
    this.prefixLen = maskToPrefixLen(config.netmask);
    this.netmask = ipToU32(config.netmask);

    /** 当前视图：deviceId -> 登记记录（含 seen，来自共享存储） */
    this.shared = new Map();
    /** 本地连接表：deviceId -> send（只有本实例持有的连接才有） */
    this.local = new Map();
    /** deviceId -> connToken，用于识别「已被新连接接管」 */
    this.connTokens = new Map();

    this.dataVersion = 1;
    this.connSeq = 0;
    this.lastSyncedAt = 0;
    this.syncInFlight = null;
  }

  get networkAddr() {
    return (this.gateway & this.netmask) >>> 0;
  }

  get broadcastAddr() {
    return (this.networkAddr | (~this.netmask >>> 0)) >>> 0;
  }

  contains(ip) {
    return ((ip & this.netmask) >>> 0) === this.networkAddr;
  }

  isOnline(rec, now = Date.now()) {
    return (rec.seen || 0) > 0 && now - rec.seen <= ONLINE_WINDOW_MS;
  }

  /** 校验地址是否可分配给设备（保留地址一律拒绝） */
  checkAssignableIp(ip) {
    if (!ip) return { ok: false, detail: "缺少 ip" };
    if (!this.contains(ip)) {
      return { ok: false, detail: `不在网段 ${u32ToIp(this.networkAddr)}/${this.prefixLen} 内` };
    }
    if (ip === this.networkAddr) return { ok: false, detail: "网络号" };
    if (ip === this.broadcastAddr) return { ok: false, detail: "广播地址" };
    if (ip === this.gateway) return { ok: false, detail: "网关地址" };
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // 共享表读写
  // -------------------------------------------------------------------------

  _parse(raw) {
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /** 拉取本网络全部登记记录 */
  async _fetchAll(backend) {
    let keys;
    try {
      keys = await backend.list(devicePrefixFor(this.code));
    } catch {
      return [];
    }
    const out = [];
    for (const k of keys) {
      const rec = this._parse(await backend.get(k));
      if (rec && typeof rec.ip === "number") {
        if (!rec.id) rec.id = deviceIdFromKey(k);
        out.push(rec);
      }
    }
    return out;
  }

  /**
   * 从共享存储刷新本地视图。
   * @returns {Promise<boolean>} 是否有变化（有变化才需要推列表）
   */
  async sync({ force = false, minIntervalMs = 1200 } = {}) {
    const now = Date.now();
    if (!force && now - this.lastSyncedAt < minIntervalMs) return false;
    if (this.syncInFlight) return this.syncInFlight;

    this.syncInFlight = (async () => {
      const before = this._fingerprint();
      const backend = await getBackend();
      const records = await this._fetchAll(backend);
      const next = new Map();
      for (const rec of records) next.set(rec.id, rec);
      this.shared = next;
      this.lastSyncedAt = now;
      const changed = this._fingerprint() !== before;
      if (changed) this.dataVersion++;
      return changed;
    })();

    try {
      return await this.syncInFlight;
    } finally {
      this.syncInFlight = null;
    }
  }

  _fingerprint() {
    const parts = [];
    const now = Date.now();
    for (const [id, rec] of this.shared) {
      parts.push(`${id}:${rec.ip}:${this.isOnline(rec, now) ? 1 : 0}`);
    }
    return parts.sort().join("|");
  }

  /** 当前设备列表（含离线），排除指定 IP */
  exportList(excludeIpU32, time = 0, now = Date.now()) {
    const list = [];
    for (const rec of this.shared.values()) {
      if (rec.ip === excludeIpU32) continue;
      list.push({ ip: rec.ip, online: this.isOnline(rec, now), clientType: rec.t || 0 });
    }
    return { dataVersion: this.dataVersion, list, isAll: true, time };
  }

  count() {
    let online = 0;
    const now = Date.now();
    for (const rec of this.shared.values()) if (this.isOnline(rec, now)) online++;
    return { total: this.shared.size, online };
  }

  // -------------------------------------------------------------------------
  // 管理 API：设备登记
  // -------------------------------------------------------------------------

  /** 登记（或更新）一台设备。ip 冲突时拒绝 */
  async registerEntry({ deviceId, ip, name = "", clientType = 0 }) {
    if (!deviceId) return { ok: false, error: "device_id 不能为空" };
    const check = this.checkAssignableIp(ip);
    if (!check.ok) return { ok: false, error: `ip 无效：${check.detail}` };

    const backend = await getBackend();
    await this.sync({ force: true });

    // 同一 IP 不允许登记给两台不同设备
    for (const rec of this.shared.values()) {
      if (rec.id !== deviceId && rec.ip === (ip >>> 0)) {
        return { ok: false, error: `ip ${u32ToIp(ip)} 已登记给设备 '${rec.id}'` };
      }
    }

    const previous = this.shared.get(deviceId);
    const record = {
      id: deviceId,
      ip: ip >>> 0,
      n: name || "",
      t: clientType || 0,
      // seen=0 表示「当前不在线」；ever 记录历史上是否连接过
      seen: previous?.seen || 0,
      ever: previous?.ever || 0,
    };
    await backend.put(deviceKey(this.code, deviceId), JSON.stringify(record));
    this.shared.set(deviceId, record);
    this.dataVersion++;
    return { ok: true, device: this._deviceView(record) };
  }

  /** 删除登记，并断开该设备的本地连接 */
  async removeEntry(deviceId) {
    const backend = await getBackend();
    await backend.del(deviceKey(this.code, deviceId));
    const existed = this.shared.delete(deviceId);
    this.local.delete(deviceId);
    this.connTokens.delete(deviceId);
    if (existed) this.dataVersion++;
    return existed;
  }

  /** 列出全部登记 */
  async listEntries() {
    await this.sync({ force: true });
    return [...this.shared.values()].map((r) => this._deviceView(r));
  }

  _deviceView(rec) {
    const online = this.isOnline(rec);
    return {
      deviceId: rec.id,
      ip: u32ToIp(rec.ip),
      ipU32: rec.ip,
      name: rec.n || "",
      online,
      everConnected: !!rec.ever,
      local: this.local.has(rec.id),
      instance: online ? rec.inst || "" : "",
    };
  }

  // -------------------------------------------------------------------------
  // 客户端注册：与登记信息严格比对
  // -------------------------------------------------------------------------

  /**
   * 注册：必须与已登记信息匹配。
   *
   * 校验 device_id（身份）与 ip（地址）；**设备名不参与校验** ——
   * 名字只用于展示，客户端改名换名很常见，强制匹配会让用户莫名其妙连不上。
   *
   * @returns {Promise<{ok:boolean, ip?:number, reason?:string, detail?:string, connToken?:number}>}
   */
  async registerDevice({ deviceId, clientType, requestedIp, send }) {
    const backend = await getBackend();
    const now = Date.now();
    // 强制同步：必须看到最新登记信息，否则可能放行刚被删除的设备
    await this.sync({ force: true });

    const entry = this.shared.get(deviceId);
    if (!entry) {
      return { ok: false, reason: REG_NOT_REGISTERED };
    }
    if (!requestedIp) {
      return { ok: false, reason: REG_IP_INVALID, detail: "注册必须携带 ip 字段" };
    }
    if ((requestedIp >>> 0) !== entry.ip) {
      return {
        ok: false,
        reason: REG_IP_MISMATCH,
        detail: `期望 ${u32ToIp(entry.ip)}，实际 ${u32ToIp(requestedIp)}`,
      };
    }

    // ever 一旦置位就不再清除：离线会把 seen 归零，不能靠 seen 反推"是否连接过"
    const record = { ...entry, t: clientType || entry.t || 0, seen: now, ever: 1, inst: INSTANCE_TOKEN };
    await backend.put(deviceKey(this.code, deviceId), JSON.stringify(record));

    this.shared.set(deviceId, record);
    this.local.set(deviceId, send);
    this.connSeq += 1;
    this.connTokens.set(deviceId, this.connSeq);

    this.dataVersion++;
    this.lastSyncedAt = now;
    return { ok: true, ip: record.ip, connToken: this.connSeq };
  }

  /**
   * 刷新心跳时间（节流落盘，减少 Blob 写次数）。
   * 只改自己那一条的 seen，不碰 IP/名字等登记信息。
   */
  async touch(deviceId, { force = false } = {}) {
    const now = Date.now();
    const prev = this.shared.get(deviceId);
    if (!prev) return false;
    if (!force && prev.seen && now - prev.seen < 15_000) {
      prev.seen = now;
      return false;
    }
    const backend = await getBackend();
    const rec = { ...prev, seen: now };
    await backend.put(deviceKey(this.code, deviceId), JSON.stringify(rec));
    this.shared.set(deviceId, rec);
    this.lastSyncedAt = now;
    return true;
  }

  /**
   * 标记离线（seen=0）。**登记信息保留** —— 设备可以随时重连。
   * @returns {Promise<boolean>} 是否真的发生变更（决定要不要广播）
   */
  async offline(deviceId, connToken) {
    // 令牌不匹配 = 该设备已被新连接接管（重连常见时序），忽略这次 close
    if (connToken !== undefined && this.connTokens.get(deviceId) !== connToken) return false;

    const backend = await getBackend();
    const rec = this.shared.get(deviceId);
    if (rec) {
      // seen=0 表示离线；ever 保留，用于区分"登记了从没连过"与"连过但当前离线"
      const dead = { ...rec, seen: 0, ever: rec.ever || (rec.seen ? 1 : 0) };
      await backend.put(deviceKey(this.code, deviceId), JSON.stringify(dead));
      this.shared.set(deviceId, dead);
    }
    this.local.delete(deviceId);
    this.connTokens.delete(deviceId);
    this.dataVersion++;
    return true;
  }

  // -------------------------------------------------------------------------
  // 信令投递
  // -------------------------------------------------------------------------

  localSenderForIp(ipU32) {
    for (const rec of this.shared.values()) {
      if (rec.ip === ipU32) return this.local.get(rec.id) || null;
    }
    return null;
  }

  findRecordByIp(ipU32) {
    for (const rec of this.shared.values()) {
      if (rec.ip === ipU32) return rec;
    }
    return null;
  }

  /** 投递打洞信令：本地直发；否则写进对端的共享信箱 */
  async deliverSignal(destIp, bytes) {
    const sender = this.localSenderForIp(destIp);
    if (typeof sender === "function") {
      try {
        sender(bytes);
        return "local";
      } catch {
        // 连接可能已断，落到信箱让对端实例重试
      }
    }
    const backend = await getBackend();
    const seq = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    await backend.put(
      signalKey(this.code, destIp, seq),
      JSON.stringify({ dest: destIp >>> 0, at: Date.now(), data: Array.from(bytes) }),
    );
    return "forwarded";
  }

  /**
   * 取走写给本设备的信令。
   *
   * Blob 没有推送语义，只能轮询。这里把轮询挂在客户端心跳上
   * （VNT 客户端每 5 秒一次），不依赖后台定时器 —— 函数实例随时可能被回收。
   */
  async drainSignals(myIp, send) {
    const backend = await getBackend();
    let keys;
    try {
      keys = await backend.list(signalPrefixFor(this.code, myIp));
    } catch {
      return 0;
    }
    let delivered = 0;
    const now = Date.now();
    for (const key of keys) {
      const payload = this._parse(await backend.get(key));
      // 无论成功与否都移除：过期的留着只会越积越多
      try {
        await backend.del(key);
      } catch {
        /* ignore */
      }
      if (!payload || payload.dest !== (myIp >>> 0)) continue;
      if (now - payload.at > SIGNAL_TTL_MS) continue;
      try {
        send(new Uint8Array(payload.data));
        delivered++;
      } catch {
        /* 连接已断，丢弃 */
      }
    }
    return delivered;
  }

  toJSON() {
    const devices = [...this.shared.values()].map((r) => this._deviceView(r));
    return {
      networkCode: this.code,
      gateway: u32ToIp(this.gateway),
      prefixLen: this.prefixLen,
      netmask: u32ToIp(this.netmask),
      dataVersion: this.dataVersion,
      devices,
    };
  }
}

export const registry = new Registry();

/**
 * 解析网络配置。
 *
 * 网络编号**只来自环境变量**（VNT_NETWORK），不接收客户端传入 ——
 * 客户端传的 network_code 必须与它一致才允许接入。
 */
export function resolveConfig(env = {}) {
  return {
    networkCode: String(env.VNT_NETWORK || "").trim(),
    gateway: env.VNT_GATEWAY || DEFAULTS.gateway,
    netmask: env.VNT_NETMASK || DEFAULTS.netmask,
    serverVersion: DEFAULTS.serverVersion,
  };
}
