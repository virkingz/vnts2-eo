// 单实例内存态：网络（房间）注册表
//
// EdgeOne Cloud Functions 没有 Durable Object 那样的全局唯一对象。
// 同一函数实例在存活期间（WebSocket 连接期间）会复用模块级状态，
// 因此同一实例内、同一 network_code 的客户端可以互相发现与转发。
//
// 已知限制（README 中详述）：不同实例之间不共享状态。若同网络的客户端
// 落在不同实例上，会表现为「看不到对方」，且各实例独立分配 IP 可能重复。
// 这是纯 EdgeOne 部署形态下无法回避的约束。

import { ipToU32, u32ToIp, prefixLenToMask, maskToPrefixLen } from "./packet.js";

/** 默认网络配置（可用环境变量覆盖） */
export const DEFAULTS = {
  gateway: "10.26.0.1",
  netmask: "255.255.255.0",
  leaseSeconds: 7 * 24 * 3600,
  serverVersion: "vnts2-edgeone/1.0.0",
};

let serverInstanceIdCache = null;

export function serverInstanceId() {
  if (!serverInstanceIdCache) {
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    serverInstanceIdCache = bytes;
  }
  return serverInstanceIdCache;
}

/**
 * 全局（进程内）注册表。
 * networks: network_code -> NetworkState
 */
class Registry {
  constructor() {
    this.networks = new Map();
    this.startedAt = Date.now();
    this.stats = { connectionsTotal: 0, bytesRelayed: 0, packetsRelayed: 0 };
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

class NetworkState {
  constructor(code, config) {
    this.code = code;
    this.gateway = ipToU32(config.gateway);
    this.prefixLen = maskToPrefixLen(config.netmask);
    this.netmask = ipToU32(config.netmask);
    this.leaseSeconds = config.leaseSeconds;
    // device_id -> DeviceEntry
    this.devices = new Map();
    // ip(u32) -> device_id
    this.ipToDevice = new Map();
    // 数据版本：任何设备上下线都会自增，用于增量推送
    this.dataVersion = 1;
    this.fullSyncVersion = 1;
  }

  /** 网络地址 */
  get networkAddr() {
    return (this.gateway & this.netmask) >>> 0;
  }

  /** 广播地址 */
  get broadcastAddr() {
    return (this.networkAddr | (~this.netmask >>> 0)) >>> 0;
  }

  /** 该 IP 是否属于本网络 */
  contains(ip) {
    return ((ip & this.netmask) >>> 0) === this.networkAddr;
  }

  /**
   * 注册或更新设备。
   * 优先复用同一 device_id 的既有 IP（除非客户端显式要求换址）。
   * @returns {{entry: object, reused: boolean}}
   */
  registerDevice({ deviceId, clientType, requestedIp, name, version, keySign, instanceId, ipVariable }) {
    const now = Date.now();
    let entry = this.devices.get(deviceId);
    let ip;

    if (entry && entry.ip && !ipVariable) {
      // 同设备复用旧地址
      ip = entry.ip;
    } else if (requestedIp && this.contains(requestedIp) && requestedIp !== this.gateway) {
      // 客户端指定且未被他人占用
      const holder = this.ipToDevice.get(requestedIp);
      if (!holder || holder === deviceId) ip = requestedIp;
    }
    if (!ip) ip = this.allocateIp();

    if (entry && entry.ip && entry.ip !== ip) {
      this.ipToDevice.delete(entry.ip);
    }

    const isNew = !entry;
    entry = {
      deviceId,
      ip,
      clientType,
      name: name || "",
      version: version || "",
      keySign: keySign || undefined,
      online: true,
      ipVariable: !!ipVariable,
      lastConnectedTime: Math.floor(now / 1000),
      connectedAt: now,
      leaseExpireAt: now + this.leaseSeconds * 1000,
      instanceId: instanceId || "",
      sender: entry ? entry.sender : null,
      // 本设备最后一次变更的全局版本号，用于增量推送
      versionAt: 0,
    };
    this.devices.set(deviceId, entry);
    this.ipToDevice.set(ip, deviceId);
    this.dataVersion++;
    entry.versionAt = this.dataVersion;
    if (isNew) this.fullSyncVersion = this.dataVersion;
    return { entry, reused: !isNew };
  }

  /** 分配一个空闲虚拟 IP（跳过网关、网络号、广播地址） */
  allocateIp() {
    const start = this.networkAddr + 1;
    const end = this.broadcastAddr; // 不含广播地址本身
    for (let raw = start; raw < end; raw++) {
      const ip = raw >>> 0;
      if (ip === this.gateway) continue;
      const holder = this.ipToDevice.get(ip);
      const holderEntry = holder ? this.devices.get(holder) : null;
      if (holderEntry && holderEntry.online) continue; // 在线占用
      if (holderEntry && !holderEntry.online) {
        // 离线设备保留租期内的地址，只有租期过期才回收
        if (holderEntry.leaseExpireAt && holderEntry.leaseExpireAt > Date.now()) continue;
      }
      return ip;
    }
    throw new Error("Address Exhausted");
  }

  /** 标记离线（连接关闭时调用） */
  offline(deviceId) {
    const entry = this.devices.get(deviceId);
    if (!entry) return null;
    entry.online = false;
    entry.disconnectedAt = Date.now();
    entry.sender = null;
    this.dataVersion++;
    entry.versionAt = this.dataVersion;
    return entry;
  }

  /** 释放过期离线设备 */
  reap() {
    const now = Date.now();
    let changed = false;
    for (const [deviceId, entry] of this.devices) {
      if (!entry.online && entry.leaseExpireAt && entry.leaseExpireAt <= now) {
        this.ipToDevice.delete(entry.ip);
        this.devices.delete(deviceId);
        changed = true;
      }
    }
    if (changed) {
      this.dataVersion++;
      this.fullSyncVersion = this.dataVersion;
    }
  }

  /** 完整节点列表（排除指定 IP） */
  fullList(excludeIp, dataVersion, time) {
    const list = [];
    for (const entry of this.devices.values()) {
      if (entry.ip === excludeIp) continue;
      list.push({ ip: entry.ip, online: entry.online, clientType: entry.clientType });
    }
    return { dataVersion, list, isAll: true, time };
  }

  /** 增量节点列表；无变化返回 null */
  changedList(excludeIp, sinceVersion, time) {
    if (sinceVersion === this.dataVersion) return null;
    // 版本号跳跃或过旧：退化为全量，避免客户端状态错乱
    if (sinceVersion > this.dataVersion || sinceVersion < this.fullSyncVersion) {
      return this.fullList(excludeIp, this.dataVersion, time);
    }
    const list = [];
    for (const entry of this.devices.values()) {
      if (entry.ip === excludeIp) continue;
      if (entry.versionAt <= sinceVersion) continue;
      list.push({ ip: entry.ip, online: entry.online, clientType: entry.clientType });
    }
    return { dataVersion: this.dataVersion, list, isAll: false, time };
  }

  /** 设备计数 */
  count() {
    let online = 0;
    for (const e of this.devices.values()) if (e.online) online++;
    return { total: this.devices.size, online };
  }

  toJSON() {
    const devices = [];
    for (const e of this.devices.values()) {
      devices.push({
        deviceId: e.deviceId,
        ip: u32ToIp(e.ip),
        online: e.online,
        name: e.name,
        version: e.version,
        clientType: e.clientType,
        lastConnectedTime: e.lastConnectedTime,
      });
    }
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

/** 从环境变量解析网络默认配置 */
export function resolveConfig(env = {}) {
  return {
    gateway: env.VNT_GATEWAY || DEFAULTS.gateway,
    netmask: env.VNT_NETMASK || DEFAULTS.netmask,
    leaseSeconds: Number(env.VNT_LEASE_SECONDS || DEFAULTS.leaseSeconds),
    serverVersion: DEFAULTS.serverVersion,
  };
}

export { prefixLenToMask, maskToPrefixLen };
