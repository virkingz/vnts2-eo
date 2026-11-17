// VNT 2.x 服务端核心逻辑（纯 EdgeOne 版）
//
// 对照 vnts2 的 src/server/control_server/handler.rs 与
// src/server/network_state_provider.rs，实现单实例可用的功能子集：
//   * 注册（普通 / 预注册确认 / 快速注册）与虚拟 IP 分配
//   * 节点列表推送（PushClientIps）
//   * Turn 数据中继、广播与选择性广播
//   * 打洞信令转发（PunchStart1/2、PunchReq/Res）
//   * 服务端 Ping/Pong（PingTurn -> PongTurn）与网关 ICMP Echo
//   * RPC 客户端列表查询
//
// 不含：多服务端互联、IKEv2、WireGuard、订阅托管、子网同步。

import {
  NetPacket,
  MsgType,
  HEAD_LENGTH,
  parseHeaderFast,
  ipToU32,
  u32ToIp,
  buildPacket,
} from "./packet.js";
import {
  decodeRequestMessage,
  encodeRegResponse,
  encodeErrorResponse,
  encodeConfirmRegResponse,
  encodeFastRegResponse,
  encodeClientSimpleInfoList,
  decodeSelectiveBroadcast,
  decodeRpcRequest,
  encodeRpcResponse,
  RegistrationMode,
  ClientType,
} from "./control-messages.js";
import { registry, resolveConfig, serverInstanceId } from "./state.js";

/** 错误码（与 vnts 的 ErrorResponseMsg.code 语义一致） */
const ERR = {
  BAD_REQUEST: 400,
  TOKEN_ERROR: 401,
  FORBIDDEN: 403,
  SERVER_ERROR: 500,
};

function normalizeBinary(message) {
  if (message instanceof Uint8Array) return message;
  if (message instanceof ArrayBuffer) return new Uint8Array(message);
  if (typeof message === "string") return new TextEncoder().encode(message);
  // Buffer（Node 的子类）或其它 ArrayBufferView
  if (message && message.buffer) {
    return new Uint8Array(message.buffer, message.byteOffset || 0, message.byteLength);
  }
  return null;
}

/**
 * 一个客户端连接对应一个 Session。
 * 首帧为裸 protobuf 的 RequestMessage；注册成功后进入数据阶段。
 */
export class Session {
  constructor(env) {
    this.env = env;
    this.config = resolveConfig(env);
    this.registered = false;
    this.networkCode = "";
    this.deviceId = "";
    this.ip = 0;
    this.clientType = ClientType.VNT;
    this.instanceId = "";
    this.inviteCode = ""; // 可选白名单（VNT_VISIT_CODE）
    this.closed = false;
    this.connToken = undefined;
    this.net = null;
    this.createdAt = Date.now();
  }

  /**
   * 白名单校验：VNT_NETWORK_WHITELIST 只能填一个 network_code。
   * 留空表示不限制；填入后必须完全一致才允许接入。
   * 不做逗号拆分——多值会被当作一个整体字符串，从而永远匹配不上。
   */
  checkNetworkAllowed(code) {
    const allowed = (this.env.VNT_NETWORK_WHITELIST || "").trim();
    if (!allowed) return true;
    return allowed === code;
  }

  /** 处理首帧注册请求（同步：解码 + 分配 + 回响应，无需 await） */
  handleFirstFrame(bytes, send) {
    let decoded;
    try {
      decoded = decodeRequestMessage(bytes);
    } catch (e) {
      send(encodeErrorResponse(ERR.BAD_REQUEST, `请求帧解析失败: ${e.message}`));
      return false;
    }

    if (decoded.kind === "reg") {
      return this.handleRegister(decoded.value, send);
    }
    if (decoded.kind === "subscription_register" || decoded.kind === "subscription_config") {
      send(encodeErrorResponse(ERR.FORBIDDEN, "本服务端未启用订阅托管"));
      return false;
    }
    if (decoded.kind === "subscription_ping") {
      send(encodeErrorResponse(ERR.BAD_REQUEST, "尚未注册"));
      return false;
    }
    send(encodeErrorResponse(ERR.BAD_REQUEST, "首帧必须是注册请求"));
    return false;
  }

  handleRegister(reg, send) {
    const { networkCode, deviceId } = reg;
    if (!networkCode) {
      send(encodeErrorResponse(ERR.BAD_REQUEST, "network_code 不能为空"));
      return false;
    }
    if (networkCode.length > 32) {
      send(encodeErrorResponse(ERR.BAD_REQUEST, "network_code 长度超过 32"));
      return false;
    }
    if (!deviceId) {
      send(encodeErrorResponse(ERR.BAD_REQUEST, "device_id 不能为空"));
      return false;
    }
    if (deviceId.length > 64) {
      send(encodeErrorResponse(ERR.BAD_REQUEST, "device_id 长度超过 64"));
      return false;
    }
    if (!this.checkNetworkAllowed(networkCode)) {
      send(encodeErrorResponse(ERR.TOKEN_ERROR, `network_code '${networkCode}' 不在白名单`));
      return false;
    }
    // 仅接受普通 VNT 客户端（无 IKEv2 / WireGuard / 远程桌面）
    if (reg.clientType !== ClientType.VNT) {
      send(encodeErrorResponse(ERR.FORBIDDEN, "本服务端仅接受 VNT 客户端"));
      return false;
    }

    const net = registry.network(networkCode, this.config);
    let result;
    try {
      result = net.registerDevice({
        deviceId,
        clientType: reg.clientType,
        requestedIp: reg.ip,
        name: reg.name,
        version: reg.version,
        keySign: reg.keySign,
        instanceId: this._instanceIdString(reg.clientInstanceId),
        ipVariable: reg.ipVariable,
      });
    } catch (e) {
      send(encodeErrorResponse(ERR.SERVER_ERROR, `注册失败: ${e.message}`));
      return false;
    }

    this.registered = true;
    this.networkCode = networkCode;
    this.deviceId = deviceId;
    this.ip = result.entry.ip;
    this.ipU32 = result.entry.ip;
    this.clientType = reg.clientType;
    this.net = net;
    this.instanceId = result.entry.instanceId;
    this.connToken = result.entry.connToken;
    result.entry.sender = send;

    const isPreRegister = reg.registrationMode === RegistrationMode.PRE_REGISTER;
    if (isPreRegister) {
      // 预注册：先回注册响应，等待客户端 ConfirmReg
      this.awaitingConfirm = true;
    }

    send(
      encodeRegResponse({
        ip: this.ip,
        prefixLen: net.prefixLen,
        gateway: net.gateway,
        serverVersion: this.config.serverVersion,
        serverInstanceId: serverInstanceId(),
        subnetSyncSupported: false,
        multiLinkSupported: false,
        applicationChannelSupported: false,
      }),
    );

    // 注册后立刻推一次全量邻居列表，客户端据此建立打洞目标
    this._pushClientIps(send, { force: true });
    // 其它在线设备也要立即知道有新成员，而不是等它们下次心跳
    this._broadcastClientIps();
    return true;
  }

  /**
   * 向本连接推送节点列表。
   * @param {(bytes: Uint8Array) => void} send
   */
  _pushClientIps(send, { force = false, time = 0 } = {}) {
    if (!this.net) return false;
    const list = this.net.fullList(this.ip, this.net.dataVersion, time);
    if (!list) return false;
    void force;
    const payload = encodeClientSimpleInfoList(list);
    const pkt = buildPacket({
      msgType: MsgType.PushClientIps,
      ttl: 1,
      gateway: true,
      src: this.net.gateway,
      dest: this.ip,
      payload,
    });
    send(pkt.toUint8Array());
    return true;
  }

  /**
   * 把最新节点列表广播给本网络其它在线设备。
   *
   * 之前只在客户端自己心跳时按 data_version 判断要不要推：一旦某次推送
   * 因链路抖动丢失，对端就会长期停在陈旧快照上（表现为「明明在线却显示离线」）。
   * 上下线属于低频事件，直接主动推全量最省事也最可靠。
   */
  _broadcastClientIps() {
    if (!this.net) return;
    for (const peer of this.net.onlineEntries()) {
      if (peer.deviceId === this.deviceId) continue;
      if (typeof peer.sender !== "function") continue;
      try {
        const list = this.net.fullList(peer.ip, this.net.dataVersion, 0);
        const payload = encodeClientSimpleInfoList(list);
        const pkt = buildPacket({
          msgType: MsgType.PushClientIps,
          ttl: 1,
          gateway: true,
          src: this.net.gateway,
          dest: peer.ip,
          payload,
        });
        peer.sender(pkt.toUint8Array());
      } catch {
        // 单个对端发送失败不影响其它对端
      }
    }
  }

  _instanceIdString(bytes) {
    if (!bytes || bytes.length === 0) return "";
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
    return s;
  }

  /** 是否处于等待预注册确认状态 */
  get pendingConfirm() {
    return this.awaitingConfirm === true;
  }

  /** 处理确认注册 */
  handleConfirm(send) {
    if (!this.pendingConfirm) {
      send(encodeErrorResponse(ERR.BAD_REQUEST, "会话不处于待确认状态"));
      return false;
    }
    this.awaitingConfirm = false;
    send(encodeConfirmRegResponse(true));
    return true;
  }

  /** 处理数据阶段帧（16 字节头 + payload） */
  handleDataPacket(bytes, send) {
    if (!this.registered || !this.net) return;
    if (bytes.length < HEAD_LENGTH) return;

    const head = parseHeaderFast(bytes);
    const src = head.src;
    const dest = head.dest;

    // 发往服务端网关
    if (head.gateway) {
      this._handleGatewayPacket(bytes, head, send);
      return;
    }

    // 校验源地址与会话一致，防止伪造
    if (src !== this.ip) return;

    switch (head.msgType) {
      case MsgType.Turn:
      case MsgType.Ping:
      case MsgType.Pong:
      case MsgType.PunchStart1:
      case MsgType.PunchStart2:
      case MsgType.PunchReq:
      case MsgType.PunchRes:
      case MsgType.Quic: {
        if (!_decrTtl(bytes)) return;
        this._relayTo(dest, bytes);
        break;
      }
      case MsgType.Broadcast: {
        if (!_decrTtl(bytes)) return;
        this._broadcast(bytes, src, null);
        break;
      }
      case MsgType.ExcludeBroadcast: {
        const sel = decodeSelectiveBroadcast(bytes.subarray(HEAD_LENGTH));
        const inner = new Uint8Array(sel.data);
        if (inner.length < HEAD_LENGTH) return;
        if (!_decrTtl(inner)) return;
        this._broadcast(inner, src, new Set(sel.ips));
        break;
      }
      case MsgType.TargetBroadcast: {
        const sel = decodeSelectiveBroadcast(bytes.subarray(HEAD_LENGTH));
        const inner = new Uint8Array(sel.data);
        if (inner.length < HEAD_LENGTH) return;
        if (!_decrTtl(inner)) return;
        const targets = new Set(sel.ips);
        this._broadcast(inner, src, null, (ip) => targets.has(ip));
        break;
      }
      default:
        break;
    }
  }

  /**
   * 广播。
   * @param {Uint8Array} bytes 已递减 TTL 的完整包
   * @param {number} src 发送者虚拟 IP
   * @param {Set<number>|null} exclude 排除集合
   * @param {(ip:number)=>boolean} [predicate] 额外目标过滤
   */
  _broadcast(bytes, src, exclude, predicate) {
    for (const entry of this.net.devices.values()) {
      if (entry.ip === src) continue;
      if (exclude && exclude.has(entry.ip)) continue;
      if (predicate && !predicate(entry.ip)) continue;
      if (!entry.online || typeof entry.sender !== "function") continue;
      entry.sender(bytes);
      registry.stats.packetsRelayed++;
      registry.stats.bytesRelayed += bytes.length;
    }
  }

  /** 单播中继到目标虚拟 IP */
  _relayTo(dest, bytes) {
    const deviceId = this.net.ipToDevice.get(dest);
    if (!deviceId) return;
    const target = this.net.devices.get(deviceId);
    if (!target || !target.online || typeof target.sender !== "function") return;
    target.sender(bytes);
    registry.stats.packetsRelayed++;
    registry.stats.bytesRelayed += bytes.length;
  }

  /** 处理网关包 */
  _handleGatewayPacket(bytes, head, send) {
    switch (head.msgType) {
      case MsgType.PingTurn: {
        const payloadLen = bytes.length - HEAD_LENGTH;
        // 8 字节：简单探测，原样回 PongTurn
        if (payloadLen === 8) {
          const reply = new Uint8Array(bytes);
          reply[0] = (MsgType.PongTurn & 0x7f) | 0x80;
          send(reply);
          return;
        }
        // 16 字节：[now(8)][data_version(8)]，可选携带节点列表
        if (payloadLen === 16) {
          const dataVersion = _readU64(bytes, HEAD_LENGTH + 8);
          let pushed = false;
          const net = this.net;
          // 版本没变就只回 PongTurn（省流）；变了推全量快照。
          // 增量（is_all=false）会让客户端 extend 合并、只增不删，
          // 历史条目永远留在缓存里显示成离线，所以这里一律发全量。
          if (dataVersion !== net.dataVersion) {
            const now = _readI64(bytes, HEAD_LENGTH);
            pushed = this._pushClientIps(send, { time: now });
          }
          if (!pushed) {
            const reply = new Uint8Array(bytes);
            reply[0] = (MsgType.PongTurn & 0x7f) | 0x80;
            send(reply);
          }
          return;
        }
        return;
      }
      case MsgType.FastReg: {
        // 快速注册：仅允许在已确认后切换 IP；本实现做最小化处理
        const resp = encodeFastRegResponse(true);
        const pkt = buildPacket({
          msgType: MsgType.FastReg,
          ttl: 1,
          gateway: true,
          payload: resp,
        });
        send(pkt.toUint8Array());
        return;
      }
      case MsgType.RpcReq: {
        const req = decodeRpcRequest(bytes.subarray(HEAD_LENGTH));
        const list = [];
        for (const entry of this.net.devices.values()) {
          list.push({
            name: entry.name,
            version: entry.version,
            ip: entry.ip,
            keySign: entry.keySign,
            online: entry.online,
            lastConnectedTime: entry.lastConnectedTime,
            id: entry.deviceId,
            clientType: entry.clientType,
          });
        }
        const payload = encodeRpcResponse({ id: req.id, list });
        const pkt = buildPacket({
          msgType: MsgType.RpcRes,
          ttl: 1,
          gateway: true,
          src: this.net.gateway,
          dest: this.ip,
          payload,
        });
        send(pkt.toUint8Array());
        return;
      }
      case MsgType.Turn: {
        // 发往网关的 ICMP Echo，直接在本机应答
        const reply = _icmpEchoReply(bytes, this.net.gateway);
        if (reply) send(reply);
        return;
      }
      case MsgType.Pong: {
        // 可选：用于延迟统计，当前仅忽略
        return;
      }
      default:
        return;
    }
  }

  /** 连接关闭清理 */
  onClose() {
    if (this.closed) return;
    this.closed = true;
    if (this.net && this.deviceId) {
      // connToken 不匹配时 offline() 返回 null —— 说明设备已被新连接接管，
      // 此时绝不能广播「它离线了」，否则会把刚上线的新连接一起打掉。
      const entry = this.net.offline(this.deviceId, this.connToken);
      if (entry) this._broadcastClientIps();
    }
  }

  peekNetworkCode() {
    return this.networkCode;
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 原地递减 TTL；返回 false 表示应丢弃 */
function _decrTtl(bytes) {
  const curr = bytes[1] & 0x0f;
  if (curr <= 1) return false;
  bytes[1] = (bytes[1] & 0xf0) | (curr - 1);
  return true;
}

/**
 * 读取大端 u64。
 * 必须转成 Number 再参与比较：BigInt 与 Number 用 `!==` 比较时因类型不同恒为 true，
 * 会让「版本号未变化」被误判为变化。
 */
function _readU64(bytes, off) {
  const view = new DataView(bytes.buffer, bytes.byteOffset + off, 8);
  return Number(view.getBigUint64(0, false));
}

function _readI64(bytes, off) {
  const view = new DataView(bytes.buffer, bytes.byteOffset + off, 8);
  return Number(view.getBigInt64(0, false));
}

/**
 * 为发往网关的 ICMP Echo Request 生成 Echo Reply。
 * 返回完整的 VNT 包（16 字节头 + IPv4/ICMP），或 null。
 */
function _icmpEchoReply(bytes, gatewayU32) {
  const payload = bytes.subarray(HEAD_LENGTH);
  if (payload.length < 20) return null;
  const version = payload[0] >> 4;
  if (version !== 4) return null;
  const ihl = (payload[0] & 0x0f) * 4;
  if (ihl < 20 || ihl > payload.length) return null;
  const totalLen = (payload[2] << 8) | payload[3];
  if (totalLen > payload.length || totalLen < ihl) return null;
  if (payload[9] !== 1) return null; // 非 ICMP

  const icmp = payload.subarray(ihl, totalLen);
  if (icmp.length < 8 || icmp[0] !== 8) return null; // 非 Echo Request

  const srcIp = payload[12] * 16777216 + payload[13] * 65536 + payload[14] * 256 + payload[15];
  const dstIp = payload[16] * 16777216 + payload[17] * 65536 + payload[18] * 256 + payload[19];
  if (dstIp !== gatewayU32) return null;

  // 构造回包：交换源/目的，ICMP type=0，重算校验和
  const inner = new Uint8Array(totalLen);
  inner.set(payload.subarray(0, totalLen));

  // 交换 IP 地址
  inner[12] = (dstIp >>> 24) & 0xff;
  inner[13] = (dstIp >>> 16) & 0xff;
  inner[14] = (dstIp >>> 8) & 0xff;
  inner[15] = dstIp & 0xff;
  inner[16] = (srcIp >>> 24) & 0xff;
  inner[17] = (srcIp >>> 16) & 0xff;
  inner[18] = (srcIp >>> 8) & 0xff;
  inner[19] = srcIp & 0xff;

  // ICMP Echo Reply
  inner[ihl] = 0;
  inner[ihl + 1] = 0;
  inner[ihl + 2] = 0;
  inner[ihl + 3] = 0;
  const icmpSum = _checksum(inner.subarray(ihl));
  inner[ihl + 2] = (icmpSum >> 8) & 0xff;
  inner[ihl + 3] = icmpSum & 0xff;

  // 重算 IPv4 头校验和
  inner[10] = 0;
  inner[11] = 0;
  const ipSum = _checksum(inner.subarray(0, ihl));
  inner[10] = (ipSum >> 8) & 0xff;
  inner[11] = ipSum & 0xff;

  const pkt = buildPacket({
    msgType: MsgType.Turn,
    ttl: _maxTtl(bytes),
    gateway: false,
    seq: ((bytes[4] << 24) | (bytes[5] << 16) | (bytes[6] << 8) | bytes[7]) >>> 0,
    src: dstIp,
    dest: srcIp,
    payload: inner,
  });
  return pkt.toUint8Array();
}

function _maxTtl(bytes) {
  return bytes[1] >> 4 || 15;
}

function _checksum(data) {
  let sum = 0;
  for (let i = 0; i + 1 < data.length; i += 2) {
    sum += (data[i] << 8) | data[i + 1];
  }
  if (data.length % 2 === 1) sum += data[data.length - 1] << 8;
  sum = (sum >>> 16) + (sum & 0xffff);
  sum += sum >>> 16;
  return ~sum & 0xffff;
}

export { ERR, u32ToIp, ipToU32, NetPacket, MsgType };
