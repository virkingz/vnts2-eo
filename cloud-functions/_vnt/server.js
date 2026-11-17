// VNT 2.x 服务端核心逻辑（EdgeOne · 纯打洞模式）
//
// 定位：**只做注册、节点发现与打洞信令转发，不做数据中继。**
// 客户端之间通过 P2P 直连传输业务流量；服务端只负责让它们"互相看得见"，
// 并把打洞协商（PunchStart1/2 等）送到对面。
//
// 这一定位是有意为之：
//   * EdgeOne 没有 Durable Object，服务端不承载数据面就不必保证同房间同实例；
//   * 中继要求实时双向转发，而跨实例投递只能靠轮询（Blob 无推送语义），
//     轮询的秒级延迟不适合数据面，但对打洞协商（客户端每 5 秒重试）够用。
//
// 已实现：
//   * 注册（普通 / 预注册确认 / 快速注册）—— 客户端指定静态 IP，服务端只校验登记
//   * 节点列表推送（PushClientIps，恒为全量 is_all=true）
//   * 打洞信令转发（PunchStart1/2、PunchReq/Res、NodeAnnouncement、DirectConnect*）
//   * 服务端 Ping/Pong（PingTurn -> PongTurn）与网关 ICMP Echo
//   * RPC 客户端列表查询
//
// 不含：数据中继（Turn/Broadcast 等业务流量）、多服务端互联、IKEv2、
//       WireGuard、订阅托管、子网同步。

import {
  NetPacket,
  MsgType,
  HEAD_LENGTH,
  parseHeaderFast,
  ipToU32,
  u32ToIp,
  buildPacket,
  P2P_SIGNAL_TYPES,
  RELAY_TYPES,
} from "./packet.js";
import {
  decodeRequestMessage,
  encodeRegResponse,
  encodeErrorResponse,
  encodeConfirmRegResponse,
  encodeFastRegResponse,
  encodeClientSimpleInfoList,
  decodeRpcRequest,
  encodeRpcResponse,
  RegistrationMode,
  ClientType,
} from "./control-messages.js";
import {
  registry,
  resolveConfig,
  serverInstanceId,
  REG_NOT_REGISTERED,
  REG_IP_MISMATCH,
  REG_IP_INVALID,
} from "./state.js";

/** 错误码（与 vnts 的 ErrorResponseMsg.code 语义一致） */
const ERR = {
  BAD_REQUEST: 400,
  TOKEN_ERROR: 401,
  FORBIDDEN: 403,
  SERVER_ERROR: 500,
};

/** 是否允许中转业务流量。默认关闭 —— 本项目定位就是纯打洞辅助 */
function relayEnabled(env) {
  const v = String(env?.VNT_ALLOW_RELAY ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

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
    this.allowRelay = relayEnabled(env);
    this.registered = false;
    this.networkCode = "";
    this.deviceId = "";
    this.ip = 0;
    this.clientType = ClientType.VNT;
    this.closed = false;
    this.connToken = undefined;
    this.net = null;
    this.createdAt = Date.now();
  }

  /**
   * 白名单校验（旧接口，保留用于兼容）。
   * 现在的准入控制已改为「设备登记制」+ 网络编号来自环境变量，
   * 不再依赖共享口令 VNT_NETWORK_WHITELIST。
   */
  checkNetworkAllowed(code) {
    const allowed = (this.env.VNT_NETWORK_WHITELIST || "").trim();
    if (!allowed) return true;
    return allowed === code;
  }

  /** 处理首帧注册请求。注册要读写共享存储，因此是异步的 */
  async handleFirstFrame(bytes, send) {
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

  /** 把注册失败原因翻译成给用户看的话 */
  _regErrorText(result, ip) {
    const ipStr = ip ? u32ToIp(ip) : "(未提供)";
    switch (result.reason) {
      case REG_NOT_REGISTERED:
        return "该 device_id 未登记。请先在服务端登记设备（device_id + ip + 名字）后再连接";
      case REG_IP_MISMATCH:
        return `ip 与登记不符（${result.detail || ""}）`;
      case REG_IP_INVALID:
        return result.detail || `ip ${ipStr} 无效`;
      default:
        return "注册失败";
    }
  }

  async handleRegister(reg, send) {
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

    // 网络编号**只来自环境变量**（VNT_NETWORK），客户端必须完全一致。
    // 这样「网络名」从共享口令变成了服务端配置，不依赖保密性。
    if (!this.config.networkCode) {
      send(
        encodeErrorResponse(
          ERR.SERVER_ERROR,
          "服务端未配置网络编号，请在项目环境变量中设置 VNT_NETWORK",
        ),
      );
      return false;
    }
    if (networkCode !== this.config.networkCode) {
      send(encodeErrorResponse(ERR.TOKEN_ERROR, "network_code 与服务端配置不一致"));
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
      result = await net.registerDevice({
        deviceId,
        clientType: reg.clientType,
        requestedIp: reg.ip,
        send,
      });
    } catch (e) {
      send(encodeErrorResponse(ERR.SERVER_ERROR, `注册失败: ${e.message}`));
      return false;
    }

    if (!result.ok) {
      send(encodeErrorResponse(ERR.TOKEN_ERROR, this._regErrorText(result, reg.ip)));
      return false;
    }

    this.registered = true;
    this.networkCode = networkCode;
    this.deviceId = deviceId;
    this.ip = result.ip >>> 0;
    this.ipU32 = this.ip;
    this.clientType = reg.clientType;
    this.net = net;
    this.connToken = result.connToken;

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
    this._pushClientIps(send, { time: Date.now() });
    // 其它在线设备也要立即知道有新成员，而不是等它们下次心跳
    await this._broadcastClientIps();
    return true;
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

  /**
   * 向本连接推送节点列表。
   *
   * 恒发全量（is_all=true）：客户端对 is_all=false 走 `map.extend`（只增不删），
   * 已下线的设备、换过的旧 IP 会永久留在客户端缓存里显示成离线。
   */
  _pushClientIps(send, { time = 0 } = {}) {
    if (!this.net) return false;
    const list = this.net.exportList(this.ip, time);
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
   * 把最新节点列表广播给本网络其它**在线**设备。
   * 只推给本实例持有的连接 —— 别的实例由它们自己的心跳周期自行拉取。
   */
  async _broadcastClientIps() {
    if (!this.net) return 0;
    let sent = 0;
    for (const [deviceId, send] of this.net.local) {
      if (deviceId === this.deviceId) continue;
      const rec = this.net.shared.get(deviceId);
      if (!rec || !this.net.isOnline(rec)) continue;
      try {
        const list = this.net.exportList(rec.ip, 0);
        const payload = encodeClientSimpleInfoList(list);
        const pkt = buildPacket({
          msgType: MsgType.PushClientIps,
          ttl: 1,
          gateway: true,
          src: this.net.gateway,
          dest: rec.ip,
          payload,
        });
        send(pkt.toUint8Array());
        sent++;
      } catch {
        // 单个对端发送失败不影响其它对端
      }
    }
    return sent;
  }

  /** 处理数据阶段帧（16 字节头 + payload） */
  async handleDataPacket(bytes, send) {
    if (!this.registered || !this.net) return;
    if (bytes.length < HEAD_LENGTH) return;

    const head = parseHeaderFast(bytes);

    // 发往服务端网关
    if (head.gateway) {
      await this._handleGatewayPacket(bytes, head, send);
      return;
    }

    // 校验源地址与会话一致，防止伪造
    if (head.src !== this.ip) return;

    const type = head.msgType;

    // 打洞信令：转发给目标（本地直发，跨实例走共享信箱）
    if (P2P_SIGNAL_TYPES.has(type)) {
      if (!_decrTtl(bytes)) return;
      await this._forwardSignal(head.dest, bytes);
      return;
    }

    // 业务流量：默认不中转（纯打洞模式）
    if (RELAY_TYPES.has(type)) {
      if (!this.allowRelay) return;
      if (!_decrTtl(bytes)) return;
      await this._forwardSignal(head.dest, bytes);
      return;
    }
  }

  /** 转发一个包到目标虚拟 IP */
  async _forwardSignal(dest, bytes) {
    const how = await this.net.deliverSignal(dest, bytes);
    if (how === "local") {
      registry.stats.signalsRelayed++;
    } else {
      registry.stats.signalsForwarded++;
    }
    registry.stats.bytesSignaled += bytes.length;
  }

  /** 处理网关包 */
  async _handleGatewayPacket(bytes, head, send) {
    switch (head.msgType) {
      case MsgType.PingTurn: {
        const payloadLen = bytes.length - HEAD_LENGTH;
        // 8 字节：简单探测，原样回 PongTurn
        if (payloadLen === 8) {
          send(_pongOf(bytes));
          return;
        }
        // 16 字节：[now(8)][data_version(8)]，版本变化则携带节点列表
        if (payloadLen === 16) {
          const now = _readI64(bytes, HEAD_LENGTH);
          let pushed = await this._onHeartbeat(now, send);
          if (!pushed) send(_pongOf(bytes));
          return;
        }
        return;
      }
      case MsgType.FastReg: {
        // 快速注册：本实现不做地址变更，直接回成功
        const pkt = buildPacket({
          msgType: MsgType.FastReg,
          ttl: 1,
          gateway: true,
          payload: encodeFastRegResponse(true),
        });
        send(pkt.toUint8Array());
        return;
      }
      case MsgType.RpcReq: {
        // 客户端列表查询
        if (!this.net) return;
        const req = decodeRpcRequest(bytes.subarray(HEAD_LENGTH));
        const list = [];
        for (const rec of this.net.shared.values()) {
          list.push({
            name: rec.n,
            version: rec.v,
            ip: rec.ip,
            keySign: rec.k,
            online: this.net.isOnline(rec),
            lastConnectedTime: Math.floor((rec.seen || 0) / 1000),
            id: rec.id,
            clientType: rec.t,
          });
        }
        const pkt = buildPacket({
          msgType: MsgType.RpcRes,
          ttl: 1,
          gateway: true,
          src: this.net.gateway,
          dest: this.ip,
          payload: encodeRpcResponse({ id: req.id, list }),
        });
        send(pkt.toUint8Array());
        return;
      }
      case MsgType.PunchReq:
      case MsgType.PunchRes: {
        // 这两个是 P2P 通道上的套接字探针。正常情况下客户端直接打到对方公网地址，
        // 不经服务端；若走了服务端，原样转交给目标。
        const dest = head.dest;
        if (dest && dest !== this.net.gateway) {
          if (!_decrTtl(bytes)) return;
          await this._forwardSignal(dest, bytes);
        }
        return;
      }
      case MsgType.Turn: {
        // 发往网关的 ICMP Echo，直接在本机应答
        const reply = _icmpEchoReply(bytes, this.net.gateway);
        if (reply) send(reply);
        return;
      }
      case MsgType.Pong:
        return;
      default:
        return;
    }
  }

  /**
   * 心跳处理：拉取共享视图 → 收信令信箱 → 按需推列表。
   *
   * 这是本实现唯一的"轮询入口"。Blob 没有推送语义，跨实例投递只能靠轮询，
   * 而客户端每 5 秒的心跳正好是天然的轮询周期，不需要后台定时器
   * （函数实例随时可能被回收，定时器不可靠）。
   *
   * @returns {Promise<boolean>} 是否已用列表推送替代了 PongTurn
   */
  async _onHeartbeat(now, send) {
    if (!this.net) return false;

    // 1) 刷新自己的心跳，并同步共享视图（内含 1.2s 节流）
    await this.net.touch(this.deviceId);
    await this.net.sync();

    // 2) 取走写给自己的打洞信令（可能来自别的实例）
    await this.net.drainSignals(this.ip, send);

    // 3) 视图有变化就推一份全量列表
    return this._pushClientIps(send, { time: now });
  }

  /** 连接关闭清理 */
  async onClose() {
    if (this.closed) return;
    this.closed = true;
    if (!this.net || !this.deviceId) return;
    // connToken 不匹配时 offline() 返回 false —— 说明设备已被新连接接管，
    // 此时绝不能广播「它离线了」，否则会把刚上线的新连接一起打掉。
    const changed = await this.net.offline(this.deviceId, this.connToken);
    if (changed) await this._broadcastClientIps();
  }

  peekNetworkCode() {
    return this.networkCode;
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 原地递减 TTL；返回 false 表示应丢弃 */
export function _decrTtl(bytes) {
  const curr = bytes[1] & 0x0f;
  if (curr <= 1) return false;
  bytes[1] = (bytes[1] & 0xf0) | (curr - 1);
  return true;
}

function _pongOf(bytes) {
  const reply = new Uint8Array(bytes);
  reply[0] = (MsgType.PongTurn & 0x7f) | 0x80;
  return reply;
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

  inner[12] = (dstIp >>> 24) & 0xff;
  inner[13] = (dstIp >>> 16) & 0xff;
  inner[14] = (dstIp >>> 8) & 0xff;
  inner[15] = dstIp & 0xff;
  inner[16] = (srcIp >>> 24) & 0xff;
  inner[17] = (srcIp >>> 16) & 0xff;
  inner[18] = (srcIp >>> 8) & 0xff;
  inner[19] = srcIp & 0xff;

  inner[ihl] = 0;
  inner[ihl + 1] = 0;
  inner[ihl + 2] = 0;
  inner[ihl + 3] = 0;
  const icmpSum = _checksum(inner.subarray(ihl));
  inner[ihl + 2] = (icmpSum >> 8) & 0xff;
  inner[ihl + 3] = icmpSum & 0xff;

  inner[10] = 0;
  inner[11] = 0;
  const ipSum = _checksum(inner.subarray(0, ihl));
  inner[10] = (ipSum >> 8) & 0xff;
  inner[11] = ipSum & 0xff;

  const pkt = buildPacket({
    msgType: MsgType.Turn,
    ttl: bytes[1] >> 4 || 15,
    gateway: false,
    seq: ((bytes[4] << 24) | (bytes[5] << 16) | (bytes[6] << 8) | bytes[7]) >>> 0,
    src: dstIp,
    dest: srcIp,
    payload: inner,
  });
  return pkt.toUint8Array();
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
