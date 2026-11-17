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
| 入口 | `export default { fetch }` | `export const onRequest` 返回 **`WebSocketPair` 的 `response`** |

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
   - Cloud Functions 单次执行默认上限 30s，本项目在 `edgeone.json` 中设为 **120s**（可配置上限）；
   - EdgeOne 站点层 WebSocket 空闲超时最长 **300s**；
   - 只支持 HTTP/1.1 的 WebSocket，**不支持 HTTP/2 的 WebSocket**。
   长连接会被平台按上述阈值回收；VNT 客户端会自动重连，但重连后可能落到新实例。
   **建议客户端把心跳间隔设在 60s 以内**，避免触发空闲超时。

4. **不含多服务端互联、IKEv2、WireGuard、订阅托管、子网同步。**
   这些在官方 vnts2 里依赖持久化数据库与多机协调，超出纯 EdgeOne 单实例的内存模型。

> 如果你的诉求是「稳定可用的生产级 VNT 服务端」，仍推荐直接部署官方 vnts2
> （任意可运行二进制的 VPS/容器）。本项目的定位是**零成本、免运维的边缘尝试**。

---

## 踩过的坑（部署前务必看）

这些都是实际调试 VNT 真实客户端时踩到的，不是理论风险。按「症状 → 原因」排列。

### 1. 客户端一直「未连接」，服务端毫无日志

**地址没带端口。** 见上面「客户端接入」——必须 `wss://域名:443`。
这种错客户端连握手都不会发，所以服务端完全看不到请求，最容易误判成「edgeone 挂了」。

### 2. 握手失败，返回 200 HTML 或直接报错

**WebSocket 升级的返回值形态写错了。**
EdgeOne Node Functions 只认这一种：

```js
const { socket, response } = new WebSocketPair();
socket.addEventListener("message", ...);
return response;   // ← 返回 Response
```

返回 `{ websocket: { onopen, onmessage } }` 这种自定义对象是**别的平台**的约定，
EdgeOne 会直接当作非法返回。本仓库的 `cloud-functions/index.js`
同时兼容了 EdgeOne 的 `{socket, response}` 与 Cloudflare 的 `[client, server]` 两种形态。

### 3. 部署后 `/` 访问不到函数，返回静态文件或 404

**别在仓库根目录放 `index.html`。** EdgeOne 的路由规则是
「**静态资源优先于 Cloud Functions**」——只要根目录有 `index.html`，
访问 `/` 永远命中静态文件，WebSocket 升级请求也被它吃掉。
本仓库根目录刻意不放任何 HTML，状态页由函数自己生成。

### 4. 注册成功后立刻断连

**`server_instance_id` 长度不对。**
客户端（vnt-core `control_message.rs`）硬性校验该字段：
非空时**必须恰好 32 字节**，否则直接 `bail!` 并断开。原来写 16 字节，
现象就是「客户端显示已连接，一秒后掉线，无限重试」。

### 5. 客户端显示「在线 0 / 离线 N」，但服务端看全都在线

**节点列表用了增量语义（`is_all=false`）。**
客户端 `update_client_simple_list` 对 `is_all=false` 走的是 `map.extend(...)`
—— **只增不删**。已经下线的设备、换网段前的旧 IP 会永远留在客户端缓存里显示成离线。
必须每次都发 `is_all=true` 的全量快照，客户端才会整体替换。

### 6. 对端上下线后，这边要等很久才刷新

**上下线没有主动广播。** 只靠客户端下次心跳带旧版本号去「碰」才推送，
一旦某次丢包或连接切换，对端就长期停在陈旧快照上。
本仓库在注册成功、连接断开时都会立即向同网络其它设备推一次全量列表。

### 7. 客户端重连后马上又变离线

**旧连接的 close 回调把新连接打下了线。**
客户端重连的时序常常是「新连接先注册成功，旧连接的 close 才姗姗来迟」。
如果 `offline()` 只按 `device_id` 定位，就会把刚上线的新连接一起标成离线。
本仓库给每次注册分配了 `connToken`，close 时比对令牌，不匹配就忽略。

### 8. 云函数报「执行超时」或进程被回收

`edgeone.json` 里 `cloudFunctions.nodejs.maxDuration` 默认 **30 秒**，
可配范围 10–120。WebSocket 长连接必须调到上限 120，否则连接会被打断。

### 9. 国内访问慢或连不上

EdgeOne 的默认测试域名（`*.edgeone.app`）走**海外节点**。
要在中国大陆有低延迟，必须绑定**已备案**的自定义域名并选择中国大陆加速区域。

### 10. 两台设备互相看不见（最常见，也最难解）

**这是平台形态的固有限制，不是 bug。** edgeone 没有 Durable Object 那样的全局单例，
同一 `network_code` 的两个客户端可能被调度到**不同函数实例**，各自维护一份房间表。
现象是：各自都显示「已连接」，但设备列表里只有自己。
即使同实例，连接因 300s 空闲超时被回收后重连，也可能换到别的实例。

**缓解**：设备数少（2~5 台）、心跳间隔 60s 以内、尽量同一地区；
**根治**：换用 Durable Object 形态（见同作者的 Cloudflare Worker 版），
或按「扩展」一节接入共享存储 + 发布订阅。

---

## 与真实客户端的兼容性核对清单

改协议相关代码后，建议逐条确认（都是客户端的硬约束）：

| 约束 | 值 | 校验位置 |
|---|---|---|
| `server_instance_id` | 空或**恰好 32 字节** | `vnt-core/src/protocol/control_message.rs` |
| `multi_link_supported` | 建议 `false`（本实现按单连接建模） | 同上，客户端据此决定开几条连接 |
| `MultiLink` 数据包 | **不要发** | 客户端 `multi_link_supported=false` 时会拒绝 |
| `ClientSimpleInfoList.is_all` | 推送时恒为 `true` | `context/mod.rs::update_client_simple_list` |
| 帧头长度 | 16 字节（VNT 2.x） | `ip_packet_protocol.rs` |
| 消息类型编号 | `PushClientIps = 13` 等 | 同上，见 `packet.js` 的 `MsgType` |

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
├── test/ws-e2e.test.mjs        # 接入层 e2e（含真实客户端硬约束的回归）
├── edgeone.json                # EdgeOne 项目配置
└── package.json
```

> **根目录不要放 `index.html`。** 见「踩过的坑」第 3 条：静态资源优先于函数，
> 放了就会把 `/` 的 WebSocket 升级请求一起吃掉。

## 部署

### 方式一：Git 集成（推荐，也是唯一免交互的方式）

1. 把本目录推到 GitHub 仓库（本仓库：`git@github.com:virkingz/vnts2-eo.git`）；
2. 登录 [EdgeOne Makers 控制台](https://console.cloud.tencent.com/edgeone/pages) →
   新建项目 → 关联该仓库 → 直接部署。
   - 构建命令：留空
   - 输出目录：留空（本项目没有静态产物）
3. 部署完成后先验证非 WS 部分：浏览器打开 `https://你的域名/health`，应返回 JSON。
4. 再验证 WS 部分：浏览器控制台执行
   ```js
   const ws = new WebSocket("wss://你的域名:443");
   ws.onopen = () => console.log("open ok");
   ws.onerror = (e) => console.log("failed", e);
   ```
   能打印 `open ok` 说明 WebSocket 通了（随后会因为不是合法 VNT 注册帧被服务端忽略，属正常）。
5. 最后接真实客户端：`vnt -s wss://你的域名:443 -n my-net -d my-pc`。

> **关于 WebSocket 开关**：EdgeOne 的**站点级**加速里有一个 WebSocket 开关
> （默认关闭，超时可配 1–300s）。这个开关属于「站点加速」配置，与 Pages 项目本身
> 不是同一层。如果第 4 步连不上，先确认这一点；
> 使用 `*.edgeone.app` 默认域名时该开关不可改，只能保证默认行为。

### 方式二：CLI

```bash
npm install -g edgeone
edgeone login               # 交互式登录，需在本地终端执行
edgeone pages link          # 关联项目（同步环境变量时需要）
edgeone pages dev           # 本地开发，http://localhost:8088
edgeone pages deploy        # 部署
```

### 本地验证

```bash
npm test
```

包含两组：
- `test/protocol.test.js` —— 27 项协议/流程自测（编解码、IP 分配、白名单、中继）
- `test/ws-e2e.test.mjs` —— 20 项接入层 e2e，覆盖 `server_instance_id` 长度、
  `is_all` 语义、上下线主动广播、心跳、重连竞态这些**只有真实客户端才会暴露**的约束

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

> ⚠️ **地址必须带端口。** 客户端解析地址时强制要求 `host:port` 形式，
> 写成 `wss://你的域名` 会直接报
> `invalid server address "...": address has no port`，
> 而且**根本不发起连接**（连握手都没有，服务端日志里一片空白）。
> 必须写成 **`wss://你的域名:443`**。端口用标准 443，EdgeOne 负责 TLS 终结。
> 尾部的 `/` 也会被当成主机名的一部分，同样报 "has no port"。

```bash
# 命令行客户端
vnt -s wss://你的域名:443 \
    --network-code my-net \
    --device-id my-pc \
    --device-mode tun
```

对应 `config.toml`：

```toml
server = ["wss://你的域名:443"]
network_code = "my-net"
device_id = "my-pc"
device_mode = "tun"
```

> 注意：`wss://` 默认走 443，EdgeOne 会自动提供 HTTPS。**不要**写成 `wss://域名:29872`
> ——那是原生 vnts 的 TLS 端口，EdgeOne 不监听该端口。

### 验证服务是否正常

浏览器打开 `https://你的域名/health`，应返回：

```json
{
  "ok": true,
  "service": "vnts2-edgeone",
  "protocol": "vnt2",
  "networks": 1,
  "connectionsTotal": 2,
  "uptimeSeconds": 37,
  "detail": [ { "networkCode": "my-net", "gateway": "10.26.0.1", "devices": [ ... ] } ]
}
```

访问 `https://你的域名/` 可看到一个状态页，列出当前实例内的网络与设备。

> `networks` / `connectionsTotal` 都是**当前函数实例**的计数。
> 多次刷新数字不一致，或者刷新后归零，说明请求落到了不同实例 —— 这是第 10 条限制的
> 直接体现，不是 bug。**判断服务是否活着只看 `ok: true`**，不要拿设备数当健康指标。

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
