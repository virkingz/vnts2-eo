// VNT 2.x 数据包帧头（与 vnts2 / vnt-core 的 ip_packet_protocol.rs 对齐）
//
/*
   0                                            15                                              31
   0  1  2  3  4  5  6  7  8  9  0  1  2  3  4  5  6  7  8  9  0  1  2  3  4  5  6  7  8  9  0  1
  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
  | 1 |    msg_type(7)  |max ttl(4) |curr ttl(4)| C | G | R |           reserve(13)             |
  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
  |                                            seq(32)                                          |
  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
  |                                         src ID(32)                                          |
  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
  |                                         dest ID(32)                                         |
  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
  |                                         payload(n)                                         |
  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
*/
//
// 注意：这是 VNT 2.x 的 16 字节头，与 1.x（vnts-cf 用的 12 字节头）完全不同。
// src/dest 是「虚拟 IPv4 地址」按大端序存放的 32 位值。

export const HEAD_LENGTH = 16;

/** 标志位掩码（对齐 vnt-core 的 ip_packet_protocol.rs） */
export const FLAG_COMPRESSED = 0x80; // C
export const FLAG_GATEWAY = 0x40; // G
export const FLAG_FEC = 0x20; // F
export const FLAG_ETHERNET = 0x10; // E

/**
 * 消息类型（MsgType::*）—— 数值必须与 vnt-core 严格一致。
 *
 * 注意 33 号在真实协议里是**未分配**的（vnt-core 的 msg_type_round_trip
 * 测试明确断言 `try_from(33u8).is_err()`）。早期版本这里写了
 * `Application: 33`，属杜撰；客户端的 `try_from` 遇到未知类型会直接报错，
 * 所以多发一个非法类型比少一个更危险。
 */
export const MsgType = {
  Turn: 1,
  Broadcast: 2,
  ExcludeBroadcast: 3,
  TargetBroadcast: 4,

  Ping: 5,
  Pong: 6,
  PingTurn: 7,
  PongTurn: 8,

  PunchStart1: 9,
  PunchStart2: 10,
  PunchReq: 11,
  PunchRes: 12,

  PushClientIps: 13,

  RpcReq: 14,
  RpcRes: 15,

  Quic: 17,
  DirectConnectReq: 20,
  DirectConnectRes: 21,

  FastReg: 22,
  SubnetSyncReq: 23,
  SubnetSyncRes: 24,
  Ikev2Relay: 25,
  WireGuardRelay: 26,

  NodeAnnouncement: 29,
  DestinationUnreachable: 30,

  SubscriptionConfigPush: 31,
  SubscriptionConfigAck: 32,
};

/**
 * P2P 打洞信令。纯打洞模式下只放行这些 + 必要的控制帧，
 * 业务流量（Turn/Broadcast/Quic）一律不转。
 *
 * 依据 vnt-core：打洞链路是
 *   PunchStart1/2      交换 PunchInfo（各自 NAT 信息）
 *   NodeAnnouncement   交换节点身份（gossip，打洞的前提）
 *   DirectConnectReq/Res 直连协商
 *   PunchReq/Res       底层套接字探针（走 P2P 通道，正常不经服务端，
 *                      这里保留放行以防对端仍走服务端路径）
 */
export const P2P_SIGNAL_TYPES = new Set([
  MsgType.PunchStart1,
  MsgType.PunchStart2,
  MsgType.PunchReq,
  MsgType.PunchRes,
  MsgType.NodeAnnouncement,
  MsgType.DirectConnectReq,
  MsgType.DirectConnectRes,
]);

/** 业务流量（纯打洞模式下不中转） */
export const RELAY_TYPES = new Set([
  MsgType.Turn,
  MsgType.Broadcast,
  MsgType.ExcludeBroadcast,
  MsgType.TargetBroadcast,
  MsgType.Quic,
]);

/** IPv4 字符串 -> u32（大端语义，即 10.26.0.1 -> 0x0A1A0001） */
export function ipToU32(str) {
  const parts = String(str).split(".");
  if (parts.length !== 4) throw new Error(`无效 IPv4: ${str}`);
  let v = 0;
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) throw new Error(`无效 IPv4: ${str}`);
    v = (v * 256 + n) >>> 0;
  }
  return v >>> 0;
}

/** u32 -> IPv4 字符串 */
export function u32ToIp(v) {
  const n = Number(v) >>> 0;
  return `${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`;
}

/** 解析 netmask（255.255.255.0）-> 前缀长度 */
export function maskToPrefixLen(mask) {
  const v = ipToU32(mask);
  let len = 0;
  for (let i = 31; i >= 0; i--) {
    if ((v >>> i) & 1) len++;
    else break;
  }
  return len;
}

/** 前缀长度 -> netmask u32 */
export function prefixLenToMask(prefixLen) {
  const n = Number(prefixLen);
  if (n <= 0) return 0;
  if (n >= 32) return 0xffffffff >>> 0;
  return ((0xffffffff << (32 - n)) >>> 0) >>> 0;
}

/**
 * 一个 VNT 2.x 数据包。
 * 用 Uint8Array 承载，偏移常量与 Rust 端保持一致。
 */
export class NetPacket {
  constructor(buffer) {
    if (!(buffer instanceof Uint8Array)) buffer = new Uint8Array(buffer);
    if (buffer.length < HEAD_LENGTH) throw new Error(`数据包过短: ${buffer.length} < ${HEAD_LENGTH}`);
    this.buffer = buffer;
  }

  /** 创建指定 payload 长度的新包（头尾都清零） */
  static alloc(payloadLen = 0) {
    return new NetPacket(new Uint8Array(HEAD_LENGTH + payloadLen));
  }

  static from(buffer) {
    return new NetPacket(buffer);
  }

  get msgType() {
    return this.buffer[0] & 0x7f;
  }

  setMsgType(t) {
    // bit7 恒为 1
    this.buffer[0] = (t & 0x7f) | 0x80;
  }

  get maxTtl() {
    return this.buffer[1] >> 4;
  }

  get ttl() {
    return this.buffer[1] & 0x0f;
  }

  setTtl(ttl) {
    this.buffer[1] = ((ttl & 0x0f) << 4) | (ttl & 0x0f);
  }

  /** 递减 TTL；返回 true 表示仍可转发 */
  decrTtl() {
    const curr = this.ttl;
    if (curr <= 1) return false;
    this.buffer[1] = (this.buffer[1] & 0xf0) | (curr - 1);
    return true;
  }

  get gateway() {
    return (this.buffer[2] & FLAG_GATEWAY) !== 0;
  }

  setGateway(v) {
    if (v) this.buffer[2] |= FLAG_GATEWAY;
    else this.buffer[2] &= ~FLAG_GATEWAY;
  }

  get compressed() {
    return (this.buffer[2] & FLAG_COMPRESSED) !== 0;
  }

  setCompressed(v) {
    if (v) this.buffer[2] |= FLAG_COMPRESSED;
    else this.buffer[2] &= ~FLAG_COMPRESSED;
  }

  get seq() {
    return this._readU32(4) >>> 0;
  }

  setSeq(v) {
    this._writeU32(4, v);
  }

  get srcId() {
    return this._readU32(8) >>> 0;
  }

  setSrcId(v) {
    this._writeU32(8, v);
  }

  get destId() {
    return this._readU32(12) >>> 0;
  }

  setDestId(v) {
    this._writeU32(12, v);
  }

  get payload() {
    return this.buffer.subarray(HEAD_LENGTH);
  }

  _readU32(off) {
    const b = this.buffer;
    return ((b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]) >>> 0;
  }

  _writeU32(off, v) {
    const n = Number(v) >>> 0;
    this.buffer[off] = (n >>> 24) & 0xff;
    this.buffer[off + 1] = (n >>> 16) & 0xff;
    this.buffer[off + 2] = (n >>> 8) & 0xff;
    this.buffer[off + 3] = n & 0xff;
  }

  toUint8Array() {
    return this.buffer;
  }
}

/** 构造一个简单的 16 字节头包 */
export function buildPacket({ msgType, ttl = 1, gateway = false, seq = 0, src = 0, dest = 0, payload }) {
  const body = payload
    ? payload instanceof Uint8Array
      ? payload
      : new Uint8Array(payload)
    : new Uint8Array(0);
  const p = NetPacket.alloc(body.length);
  p.setMsgType(msgType);
  p.setTtl(ttl);
  p.setGateway(gateway);
  p.setSeq(seq);
  p.setSrcId(src);
  p.setDestId(dest);
  p.buffer.set(body, HEAD_LENGTH);
  return p;
}

/** 16 字节头快速解析（避免构造完整 NetPacket，用于热路径） */
export function parseHeaderFast(buffer) {
  return {
    msgType: buffer[0] & 0x7f,
    maxTtl: buffer[1] >> 4,
    ttl: buffer[1] & 0x0f,
    gateway: (buffer[2] & FLAG_GATEWAY) !== 0,
    compressed: (buffer[2] & FLAG_COMPRESSED) !== 0,
    seq: ((buffer[4] << 24) | (buffer[5] << 16) | (buffer[6] << 8) | buffer[7]) >>> 0,
    src: ((buffer[8] << 24) | (buffer[9] << 16) | (buffer[10] << 8) | buffer[11]) >>> 0,
    dest: ((buffer[12] << 24) | (buffer[13] << 16) | (buffer[14] << 8) | buffer[15]) >>> 0,
  };
}

/** 原地递减 TTL；返回 false 表示应丢弃 */
export function decrTtlInPlace(buffer) {
  const curr = buffer[1] & 0x0f;
  if (curr <= 1) return false;
  buffer[1] = (buffer[1] & 0xf0) | (curr - 1);
  return true;
}
