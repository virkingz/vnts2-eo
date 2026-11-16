// VNT 2.x 控制消息（protobuf）编解码
// 对齐 vnts2/proto/control_message.proto 与 rpc.proto。
//
// 只实现无外部存储的纯 EdgeOne 版本所需的字段子集：
//   - 正常注册 / 预注册确认 / 快速注册
//   - 错误响应
//   - 节点列表（ClientSimpleInfoList）与 RPC 客户端列表
//   - 选择性广播（SelectiveBroadcast）
// 订阅（subscription）相关消息仅做「忽略」处理，不实现。

import { Writer, Reader, WIRE, decodePacked } from "./protobuf.js";

/** ClientType 枚举 */
export const ClientType = {
  VNT: 0,
  IKEV2: 1,
  WIREGUARD: 2,
  REMOTE_DESKTOP: 3,
};

/** RegistrationMode 枚举 */
export const RegistrationMode = {
  NORMAL: 0,
  PRE_REGISTER: 1,
};

const textEncoder = new TextEncoder();

// ---------------------------------------------------------------------------
// RequestMessage（客户端 -> 服务端，注册连接上的第一帧，裸 protobuf 不带帧头）
//   message RequestMessage {
//     oneof request_payload {
//       RegRequestMsg reg = 1;
//       ConfirmRegMsg confirm_reg = 2;
//       FastRegRequestMsg fast_reg = 3;
//       SubscriptionConfigFetchRequest subscription_config = 4;
//       SubscriptionRegisterRequest subscription_register = 5;
//       SubscriptionConfigAck subscription_ack = 6;
//       SubscriptionPing subscription_ping = 7;
//     }
//   }
// ---------------------------------------------------------------------------

/**
 * 解码 RegRequestMsg
 *   client_type=15, connection_id=16, network_code=1, device_id=2, ip=3,
 *   name=4, version=5, key_sign=6, ip_variable=7, server_id=8,
 *   registration_mode=9, advertised_subnets=10, allow_ikev2=11,
 *   allow_wireguard=12, subscription=13, client_instance_id=14
 */
function decodeRegRequest(bytes) {
  const r = new Reader(bytes);
  const out = {
    clientType: 0,
    connectionId: undefined,
    networkCode: "",
    deviceId: "",
    ip: undefined,
    name: "",
    version: "",
    keySign: undefined,
    ipVariable: false,
    serverId: 0,
    registrationMode: 0,
    advertisedSubnets: [],
    allowIkev2: false,
    allowWireguard: false,
    clientInstanceId: new Uint8Array(0),
  };
  r.each((field, wire, rr) => {
    switch (field) {
      case 1:
        out.networkCode = rr.readString();
        return true;
      case 2:
        out.deviceId = rr.readString();
        return true;
      case 3:
        out.ip = rr.readFixed32() >>> 0;
        return true;
      case 4:
        out.name = rr.readString();
        return true;
      case 5:
        out.version = rr.readString();
        return true;
      case 6:
        out.keySign = rr.readString();
        return true;
      case 7:
        out.ipVariable = rr.readVarint() !== 0;
        return true;
      case 8:
        out.serverId = rr.readFixed32() >>> 0;
        return true;
      case 9:
        out.registrationMode = rr.readVarint();
        return true;
      case 10:
        out.advertisedSubnets.push(decodeIpv4Subnet(rr.readBytes()));
        return true;
      case 11:
        out.allowIkev2 = rr.readVarint() !== 0;
        return true;
      case 12:
        out.allowWireguard = rr.readVarint() !== 0;
        return true;
      case 13:
        // subscription：本实现忽略
        rr.skip(wire);
        return true;
      case 14:
        out.clientInstanceId = new Uint8Array(rr.readBytes());
        return true;
      case 15:
        out.clientType = rr.readVarint();
        return true;
      case 16:
        out.connectionId = rr.readFixed32() >>> 0;
        return true;
      default:
        return false;
    }
  });
  return out;
}

function decodeIpv4Subnet(bytes) {
  const r = new Reader(bytes);
  const out = { network: 0, prefixLen: 0 };
  r.each((field, _wire, rr) => {
    if (field === 1) {
      out.network = rr.readFixed32() >>> 0;
      return true;
    }
    if (field === 2) {
      out.prefixLen = rr.readVarint();
      return true;
    }
    return false;
  });
  return out;
}

/**
 * 解码注册连接上传入的 RequestMessage，返回 { kind, value }。
 * kind ∈ reg | confirm_reg | fast_reg | subscription_* | unknown
 */
export function decodeRequestMessage(bytes) {
  const r = new Reader(bytes);
  let kind = "unknown";
  let value = null;
  r.each((field, wire, rr) => {
    if (field === 1 && wire === WIRE.LEN) {
      kind = "reg";
      value = decodeRegRequest(rr.readBytes());
      return true;
    }
    if (field === 2 && wire === WIRE.LEN) {
      kind = "confirm_reg";
      void rr.readBytes();
      value = {};
      return true;
    }
    if (field === 3 && wire === WIRE.LEN) {
      kind = "fast_reg";
      const sub = new Reader(rr.readBytes());
      const out = { ip: 0 };
      sub.each((f, _w, ss) => {
        if (f === 1) {
          out.ip = ss.readFixed32() >>> 0;
          return true;
        }
        return false;
      });
      value = out;
      return true;
    }
    if (field === 4) {
      kind = "subscription_config";
      rr.skip(wire);
      return true;
    }
    if (field === 5) {
      kind = "subscription_register";
      rr.skip(wire);
      return true;
    }
    if (field === 6) {
      kind = "subscription_ack";
      rr.skip(wire);
      return true;
    }
    if (field === 7) {
      kind = "subscription_ping";
      rr.skip(wire);
      return true;
    }
    return false;
  });
  return { kind, value };
}

// ---------------------------------------------------------------------------
// ResponseMessage（服务端 -> 客户端）
//   oneof response_payload {
//     RegResponseMsg reg = 1;
//     ErrorResponseMsg error = 2;
//     ConfirmRegResponseMsg confirm_reg = 3;
//     FastRegResponseMsg fast_reg = 4;
//     SubscriptionConfigEnvelope subscription_config = 5;
//     SubscriptionRegisterResponse subscription_register = 6;
//     SubscriptionConfigEnvelope subscription_push = 7;
//     SubscriptionPong subscription_pong = 8;
//   }
// ---------------------------------------------------------------------------

/**
 * RegResponseMsg:
 *   connection_id=11, application_channel_supported=10, ip=1, prefix_len=2,
 *   gateway=3, server_version=4, subnet_sync_supported=5,
 *   subscription_config_supported=6, subscription=7, server_instance_id=8,
 *   multi_link_supported=9
 */
export function encodeRegResponse({
  ip,
  prefixLen,
  gateway,
  serverVersion,
  serverInstanceId,
  subnetSyncSupported = true,
  multiLinkSupported = true,
  applicationChannelSupported = false,
}) {
  const w = new Writer();
  const inner = new Writer();
  if (ip) inner.writeFixed32Field(1, ip);
  if (prefixLen) inner.writeUInt32(2, prefixLen);
  if (gateway) inner.writeFixed32Field(3, gateway);
  if (serverVersion) inner.writeString(4, serverVersion);
  if (subnetSyncSupported) inner.writeBool(5, true);
  if (multiLinkSupported) inner.writeBool(9, true);
  if (applicationChannelSupported) inner.writeBool(10, true);
  if (serverInstanceId && serverInstanceId.length) {
    inner.writeLengthDelimited(8, serverInstanceId);
  }
  w.writeMessage(1, inner);
  return w.finish();
}

/** ErrorResponseMsg: code=1, message=2 */
export function encodeErrorResponse(code, message) {
  const w = new Writer();
  const inner = new Writer();
  inner.writeUInt32(1, code);
  inner.writeString(2, message || "");
  w.writeMessage(2, inner);
  return w.finish();
}

/** ConfirmRegResponseMsg: success=1 */
export function encodeConfirmRegResponse(success) {
  const w = new Writer();
  const inner = new Writer();
  if (success) inner.writeBool(1, true);
  w.writeMessage(3, inner);
  return w.finish();
}

/** FastRegResponseMsg: success=1 */
export function encodeFastRegResponse(success) {
  const w = new Writer();
  const inner = new Writer();
  if (success) inner.writeBool(1, true);
  w.writeMessage(4, inner);
  return w.finish();
}

// ---------------------------------------------------------------------------
// ClientSimpleInfoList（节点列表推送，MsgType::PushClientIps 的 payload）
//   data_version=1(u64), list=2(repeated ClientSimpleInfo), is_all=3, time=4(i64)
//   ClientSimpleInfo { ip=1(fixed32), online=2, client_type=3 }
// ---------------------------------------------------------------------------
export function encodeClientSimpleInfoList({ dataVersion, list, isAll, time }) {
  const w = new Writer();
  w.writeInt64(1, dataVersion);
  for (const item of list) {
    const sub = new Writer();
    sub.writeFixed32Field(1, item.ip);
    if (item.online) sub.writeBool(2, true);
    if (item.clientType) sub.writeUInt32(3, item.clientType);
    w.writeMessage(2, sub);
  }
  if (isAll) w.writeBool(3, true);
  w.writeInt64(4, time || 0);
  return w.finish();
}

// ---------------------------------------------------------------------------
// SelectiveBroadcast（ExcludeBroadcast / TargetBroadcast 的 payload）
//   ips=1(repeated fixed32), data=2(bytes)
// ---------------------------------------------------------------------------
export function decodeSelectiveBroadcast(bytes) {
  const r = new Reader(bytes);
  const ips = [];
  let data = new Uint8Array(0);
  r.each((field, _wire, rr) => {
    if (field === 1) {
      ips.push(rr.readFixed32() >>> 0);
      return true;
    }
    if (field === 2) {
      data = new Uint8Array(rr.readBytes());
      return true;
    }
    return false;
  });
  return { ips, data };
}

// ---------------------------------------------------------------------------
// RPC（客户端列表查询，MsgType::RpcReq / RpcRes 的 payload）
//   RpcMessageRequest  { id=1(u64), client_list_req=2 }
//   RpcMessageResponse { id=1(u64), client_list_res=2 }
//   ClientListResponse { list=1(repeated ClientInfo) }
//   ClientInfo { name=1, version=2, ip=3(fixed32), key_sign=4, online=5,
//                last_connected_time=6(i64), id=7, client_type=8 }
// ---------------------------------------------------------------------------
export function decodeRpcRequest(bytes) {
  const r = new Reader(bytes);
  const out = { id: 0 };
  r.each((field, wire, rr) => {
    if (field === 1) {
      out.id = rr.readVarint();
      return true;
    }
    if (field === 2) {
      rr.skip(wire);
      return true;
    }
    return false;
  });
  return out;
}

export function encodeRpcResponse({ id, list }) {
  const w = new Writer();
  w.writeInt64(1, id);
  const respBody = new Writer();
  for (const item of list) {
    const ci = new Writer();
    if (item.name) ci.writeString(1, item.name);
    if (item.version) ci.writeString(2, item.version);
    if (item.ip) ci.writeFixed32Field(3, item.ip);
    if (item.keySign) ci.writeString(4, item.keySign);
    if (item.online) ci.writeBool(5, true);
    if (item.lastConnectedTime) ci.writeInt64(6, item.lastConnectedTime);
    if (item.id) ci.writeString(7, item.id);
    if (item.clientType) ci.writeUInt32(8, item.clientType);
    respBody.writeMessage(1, ci);
  }
  w.writeMessage(2, respBody);
  return w.finish();
}

// 保留导出以便测试与调试
export { decodePacked };
