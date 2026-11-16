# vnts2 · EdgeOne

把 VNT 的服务端 **vnts2** 用纯 JavaScript 实现，直接部署到**腾讯 EdgeOne（EdgeOne Makers / Pages）**，
借助其 Cloud Functions（Node.js 运行时）的 WebSocket 能力，为 [VNT](https://github.com/vnt-dev/vnt)
客户端提供注册、虚拟 IP 分配、节点发现、P2P 打洞信令与数据中继。

参考实现：
- [vnt-dev/vnts](https://github.com/vnt-dev/vnts) —— 官方 Rust 服务端 vnts2（协议权威来源）
- [Teariy/vnts-cf](https://github.com/Teariy/vnts-cf) —— Cloudflare Worker 版 vnts（本项目的思路来源）

> 本项目对齐的是**当前 VNT 2.x 协议**（客户端 vnt-core 2.0.12 / 服务端 vnts2 2.0.9），
> 不是 vnts-cf 使用的 1.x 老协议。

---

## 与 vnts-cf 的关键差异

| 维度 | vnts-cf | 本项目 |
|---|---|---|
| 运行平台 | Cloudflare Worker + **Durable Object** | EdgeOne **Cloud Functions**（Node.js） |
| 房间状态 | Durable Object 保证全局唯一、同房间必定同一实例 | **无等价原语**，只能依赖单实例内存（见下方限制） |
| 协议版本 | VNT 1.x（12 字节头 + RSA 握手） | **VNT 2.x**（16 字节头 + 裸 protobuf 控制消息） |
| 依赖 | protobufjs、wrangler | **零运行时依赖**，自制最小 protobuf 编解码 |
| 入口 | `export default { fetch }` | `export const onRequest` 返回 `{ websocket }` |

**为什么不能照搬 vnts-cf 的架构？**
Cloudflare Durable Object 能用 `idFromName(roomId)` 把同一网络的客户端**强制定位到同一个进程**，
房间状态（`Map<ip, connection>`）天然全局一致。EdgeOne 没有这个原语——官方文档明确说明
Cloud Functions 是**请求级无状态**：「每次请求独立分配执行环境，用完即回收，
请求之间不保留任何内存状态」。因此本项目只能在**单个函数实例内**维护房间状态。

---

## ⚠️ 必读：EdgeOne 形态下的固有限制

在「纯 EdgeOne、零外部依赖」的前提下，以下限制**无法通过代码消除**，请在部署前确认可接受：

1. **同一网络的客户端可能落在不同实例上。**
   每个实例各自维护一份房间表。若 A、B 两客户端连到不同实例，它们**互相看不见**，
   也无法通过服务端中继互通。缓解手段：
   - 小规模自用（同一网络 2~5 台设备）时，EdgeOne 通常复用同一实例，实测多数情况可用；
   - 若必须保证汇聚，请**升级部署形态**：把 `CLOUDFLARE` 那类架构换成 Cloudflare，或
     在 `state.js` 的注册表外挂一个共享存储（本项目预留了扩展点，见「扩展」一节）。

2. **虚拟 IP 可能重复。**
   两个实例各自分配 IP，都可能给出 `10.26.0.2`。这是限制 1 的直接后果。

3. **连接生命周期受限。**
   - Cloud Functions 单次请求默认上限 30s，本项目在 `edgeone.json` 中设为 **120s**（可配置上限）；
   - EdgeOne 站点层 WebSocket 空闲超时最长 300s。
   长连接会被平台按上述阈值回收；VNT 客户端会自动重连，但重连后可能落到新实例。
   **建议客户端把心跳间隔设在 60s 以内**，避免触发空闲超时。

4. **不含多服务端互联、IKEv2、WireGuard、订阅托管、子网同步。**
   这些在官方 vnts2 里依赖持久化数据库与多机协调，超出纯 EdgeOne 单实例的内存模型。

> 如果你的诉求是「稳定可用的生产级 VNT 服务端」，仍推荐直接部署官方 vnts2
> （任意可运行二进制的 VPS/容器）。本项目的定位是**零成本、免运维的边缘尝试**。

---

## 目录结构

```
vnts2-edgeone/
├── cloud-functions/            # EdgeOne 函数目录（目录前缀不进 URL）
│   ├── index.js                # WebSocket 入口 + 状态页 + /health
│   └── _vnt/                   # 以下划线开头 = 内部模块，不生成路由
│       ├── protobuf.js         # 最小 protobuf3 读写
│       ├── packet.js           # VNT 2.x 16 字节帧头
│       ├── control-messages.js # 控制消息编解码
│       ├── state.js            # 网络（房间）注册表
│       └── server.js           # 服务端核心逻辑
├── test/protocol.test.js       # 协议自测（Node 内置 assert，无依赖）
├── edgeone.json                # EdgeOne 项目配置
└── package.json
```

## 部署

### 方式一：Git 集成（推荐）

1. Fork / 上传本目录到你的 GitHub 仓库；
2. 登录 [EdgeOne Makers 控制台](https://console.cloud.tencent.com/edgeone/pages)，
   新建项目 → 选择该仓库 → 直接部署；
3. 部署完成后，在「域名管理」绑定自定义域名（**必须启用 HTTPS**，VNT 客户端用 `wss://`）。

### 方式二：CLI

```bash
npm install -g edgeone
edgeone login
edgeone pages link          # 关联项目（同步环境变量时需要）
edgeone pages dev           # 本地开发，http://localhost:8088
edgeone pages deploy        # 部署
```

### 本地验证

```bash
node test/protocol.test.js   # 25 项协议/流程自测
```

---

## 环境变量

在 EdgeOne 控制台「项目设置 → 环境变量」中配置（均为可选）：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `VNT_GATEWAY` | `10.26.0.1` | 虚拟网关地址 |
| `VNT_NETMASK` | `255.255.255.0` | 虚拟子网掩码（决定地址池大小） |
| `VNT_LEASE_SECONDS` | `604800` | 离线设备地址租期（秒），到期后才回收 |
| `VNT_NETWORK_WHITELIST` | 空 | **只能填一个** `network_code`。留空表示不限制；填入后必须完全一致才允许接入 |

---

## 客户端接入

VNT 2.x 客户端的 WebSocket 地址由 `wss://host:port` 构造，**不带路径**，
因此服务端 WS 入口挂在站点根路径 `/`。

```bash
# 命令行客户端
vnt -s wss://你的域名 \
    --network-code my-net \
    --device-id my-pc \
    --device-mode tun

# 若要跳过自签证书校验（EdgeOne 用的是正式证书时可省略）
#   cert_mode = "skip"
```

对应 `config.toml`：

```toml
server = ["wss://你的域名"]
network_code = "my-net"
device_id = "my-pc"
device_mode = "tun"
```

> 注意：`wss://` 默认走 443，EdgeOne 会自动提供 HTTPS。**不要**写成 `wss://域名:29872`
> ——那是原生 vnts 的 TLS 端口，EdgeOne 不监听该端口。

### 验证服务是否正常

浏览器打开 `https://你的域名/health`，应返回：

```json
{ "ok": true, "service": "vnts2-edgeone", "protocol": "vnt2", "networks": 1, ... }
```

访问 `https://你的域名/` 可看到一个状态页，列出当前实例内的网络与设备。

---

## 协议实现范围

已实现（对齐 vnts2 `src/server/control_server/handler.rs`）：

- **注册**：普通注册、预注册 + `ConfirmReg`、`FastReg`
- **虚拟 IP 分配**：按 `device_id` 复用、网段校验、跳过网关/网络号/广播地址、租期回收
- **节点发现**：`PingTurn`(16B) → `PushClientIps`，支持全量与增量（`data_version`）
- **数据面**：`Turn` 单播中继、`Broadcast`、`ExcludeBroadcast`、`TargetBroadcast`
- **打洞信令**：`PunchStart1/2`、`PunchReq/Res` 转发
- **网关能力**：`PingTurn`→`PongTurn`、`Turn` 中的 ICMP Echo 应答、`RpcReq`→`RpcRes` 客户端列表

未实现：多服务端互联（`ServerMessage`）、`IKEv2`、`WireGuard`、订阅托管（`Subscription*`）、
子网同步（`SubnetSync*`）、`Application` 通道。

## 扩展：如需跨实例一致

若你的场景必须突破「单实例」限制，最小改动点是 `cloud-functions/_vnt/state.js`：

1. 把 `registry` 的设备表读写改为走共享存储（EdgeOne 的 KV、或任意外部 Redis/Upstash）；
2. 把 `_relayTo` / `_broadcast` 的「直接 `sender(bytes)`」改为「发布到共享通道 + 各实例订阅投递」。

接口边界已经收敛在 `NetworkState` 与 `Session` 两处，改造不需要触碰协议层。

---

## 免责声明

本项目仅供学习交流与自建组网使用，请勿用于任何商业或非法用途。
使用本项目代码产生的后果由使用者自行承担。
