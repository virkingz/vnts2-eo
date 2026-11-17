# vnts2 · EdgeOne（纯 P2P 打洞辅助）

把 VNT 的服务端 **vnts2** 用纯 JavaScript 实现，部署到**腾讯 EdgeOne（Makers）**，
借助 Cloud Functions（Node.js）的 WebSocket 能力，为 [VNT](https://github.com/vnt-dev/vnt)
客户端提供**注册、虚拟 IP 校验、节点发现与 P2P 打洞信令转发**。

> **本项目不中转业务流量。** 客户端之间通过 P2P 直连传输数据，
> 服务端只负责让它们"互相看得见"，并把打洞协商送到对面。
> 这既是定位，也是平台约束下的必然选择（见下方说明）。

参考实现：
- [vnt-dev/vnts](https://github.com/vnt-dev/vnts) —— 官方 Rust 服务端 vnts2（协议权威来源）

---

## 一句话说明为什么服务端做不了中继

EdgeOne 的 Cloud Functions 是**请求级无状态**的，没有 Durable Object 那样的全局单例。
同一网络的客户端可能被调度到**不同函数实例**上，而跨实例投递只能靠轮询
（Blob 对象存储没有推送语义）。轮询的秒级延迟对"打洞协商"够用
（客户端每 5 秒重试一轮），但对"数据中继"不够 —— 中继要求实时双向转发。

所以本项目**只做控制面**。这反而更贴近 VNT 的设计初衷：
P2P 直连才是主路径，服务端中继只是打不通时的兜底。

---

## 架构

```
                         ┌──────────────────────────────┐
   设备 A ──WSS──┐       │  EdgeOne Cloud Function 实例  │
                 ├──────▶│  （本项目的 index.js）         │
   设备 B ──WSS──┘       └──────────┬───────────────────┘
                                    │ 读写
                          ┌─────────▼─────────┐
                          │  EdgeOne Blob     │  ← 跨实例共享
                          │  设备登记 + 信令信箱 │
                          └───────────────────┘

   打洞成功后：设备 A ◀═══════ P2P 直连 ═══════▶ 设备 B
                          （完全不经过 EdgeOne）
```

三个要点：

1. **设备登记制**。设备由管理 API 预先登记（`deviceId` + `ip` + 名字），
   客户端注册时必须报出已登记的 `deviceId` 与 `ip` 且**完全匹配**。
2. **共享设备表**。所有实例读写同一份 Blob，因此设备**跨实例可见**，
   不存在"两台设备各自连到不同实例、互相看不见"的问题。
3. **信令信箱**。打洞信令（`PunchStart1/2` 等）若目标不在本实例，
   就写进共享信箱，由对端实例在心跳时取走投递。

---

## 为什么用 Blob 而不是 KV

| | KV | Blob |
|---|---|---|
| **运行环境** | **仅 Edge Functions** | Edge Functions / **Cloud Functions** |
| 一致性 | 最终一致（边缘缓存最长 60s） | 可选**强一致读** `{consistency:"strong"}` |
| 单值上限 | 1 MB | 25 MB |

**KV 用不了** —— Edge Functions 的 V8 运行时不支持 WebSocket，
而本服务端必须跑在 Cloud Functions 上。Blob 是 Cloud Functions 唯一可用的持久化存储。

强一致读这一项也很关键：登记设备后客户端**可以立即连接**，不需要等 60 秒缓存过期。

---

## 快速开始

### 1. 部署

推到 GitHub 后在 [EdgeOne Makers 控制台](https://console.cloud.tencent.com/edgeone/pages)
新建项目并关联仓库 `virkingz/vnts2-eo`。

**「构建部署配置」四栏这样填：**

| 字段 | 填什么 | 为什么 |
|---|---|---|
| 框架预设 | `Other` | 不是前端框架项目 |
| 根目录 | `/`（保持默认） | 仓库根就是项目根 |
| 输出目录 | **留空** | 本项目没有静态产物，函数直接部署 |
| 编译命令 | **留空** | 无需构建 |
| 安装命令 | `npm install` | **必须填**，见下方说明 |

`edgeone.json` 里已经把 `installCommand` / `nodeVersion` / `maxDuration` 写死了，
所以在控制台留空也会以文件为准。但**安装命令建议在界面上也填上**，双重保险。

> ⚠️ **为什么安装命令必须执行**：本项目依赖 `@edgeone/pages-blob`。
> 如果不装，代码会**静默降级到内存后端** —— 服务看起来完全正常，
> 但设备表无法跨实例共享（表现为设备互相看不见）。
> 部署后请访问 `/health` 确认 `"storage": "blob"`；若显示 `memory`，
> 说明依赖没装上，`storageHint` 字段会给出提示。

> ⚠️ **根目录不能放 `index.html`。** EdgeOne 的路由规则是「静态资源优先于函数」，
> 放了就会把 `/` 的 WebSocket 升级请求一起吃掉。本仓库根目录刻意不放任何 HTML。

### 2. 配置环境变量

在「项目设置 → 环境变量」中配置：

| 变量 | 必填 | 说明 |
|---|---|---|
| `VNT_NETWORK` | ✅ | **网络编号，只支持一个**。客户端配置里的 `network_code` 必须与它完全一致 |
| `VNT_ADMIN_TOKEN` | ✅ | 管理接口令牌。**不配置则 `/admin` 完全不可用**（不会放开） |
| `VNT_GATEWAY` | | 虚拟网关，默认 `10.26.0.1` |
| `VNT_NETMASK` | | 虚拟子网掩码，默认 `255.255.255.0` |
| `VNT_ALLOW_RELAY` | | 设为 `1` 时中继业务流量（默认关闭） |

### 3. 登记设备

**这是与其它 VNT 服务端最大的不同：不做 DHCP，设备必须预先登记。**

```bash
# 登记一台设备
curl -X POST "https://你的域名/admin/devices" \
  -H "Authorization: Bearer 你的VNT_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"deviceId":"lede","ip":"10.26.2.2","name":"路由器"}'

# 查看已登记设备
curl "https://你的域名/admin/devices" -H "Authorization: Bearer 你的VNT_ADMIN_TOKEN"

# 删除登记
curl -X DELETE "https://你的域名/admin/devices/lede" -H "Authorization: Bearer 你的VNT_ADMIN_TOKEN"
```

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/admin/devices` | 新增/更新登记，body: `{ deviceId, ip, name }` |
| `GET` | `/admin/devices` | 列出全部登记（含在线状态） |
| `GET` | `/admin/devices/{id}` | 查询单台 |
| `DELETE` | `/admin/devices/{id}` | 删除登记（之后该设备连不上） |
| `GET` | `/admin` | 说明页 + 设备列表 |

登记后**立即生效**（Blob 强一致读），无需等待。

### 4. 客户端接入

```toml
# config.toml
server = ["wss://你的域名:443"]
network_code = "你的VNT_NETWORK"     # 必须与服务端一致
device_id = "lede"                   # 必须与登记的一致
device_mode = "tun"
ip = "10.26.2.2"                     # 必须与登记的一致（静态 IP）
```

对应命令行：

```bash
vnt -s wss://你的域名:443 \
    -n 你的VNT_NETWORK \
    -d lede \
    -i 10.26.2.2
```

---

## ⚠️ 地址必须带端口

客户端解析地址时强制要求 `host:port` 形式。写成 `wss://你的域名` 会直接报
`invalid server address "...": address has no port`，而且**根本不发起连接**
（连握手都没有，服务端日志一片空白）。

必须写成 **`wss://你的域名:443`**。尾部的 `/` 也会被当成主机名的一部分，报同样的错。

---

## 踩过的坑

都是实际对接真实 VNT 客户端时踩到的，不是理论风险。

### 1. 客户端一直「未连接」，服务端毫无日志
地址没带端口。见上一节。

### 2. 握手失败，返回 200 HTML 或直接报错
WebSocket 升级的返回值形态写错了。EdgeOne 上见过两种约定，**两边不通用**：

```js
// A) 官方 Node Functions 文档 / 官方模板
const { socket, response } = new WebSocketPair();
socket.addEventListener("message", ...);
return response;

// B) 回调对象
return { websocket: { onopen, onmessage, onclose, onerror } };
```

本仓库**做能力探测**：有 `WebSocketPair` 用 A，否则回落 B。
`/health` 的 `wsMode` 字段会告诉你线上走的是哪一种。

### 3. 部署后 `/` 访问不到函数
根目录有 `index.html`。静态资源优先于函数，把 `/` 的升级请求吃掉了。

### 4. 注册成功后立刻断连
`server_instance_id` 长度不对。客户端硬校验该字段：
**非空时必须恰好 32 字节**，否则直接断开。现象是"显示已连接，一秒后掉线，无限重试"。

### 5. 客户端显示「在线 0 / 离线 N」，但服务端看全都在线
节点列表用了增量语义（`is_all=false`）。客户端对 `is_all=false` 走
`map.extend(...)` —— **只增不删**，已下线的设备、换过的旧 IP 会永久留在缓存里
显示成离线。必须每次都发 `is_all=true` 的全量快照。

### 6. 对端上下线后很久才刷新
上下线没有主动广播，只靠客户端下次心跳带旧版本号去"碰"。本仓库在注册成功、
连接断开时都会立即向同网络其它设备推一次全量列表。

### 7. 客户端重连后马上又变离线
旧连接的 close 回调把新连接打下了线。客户端重连的时序常常是
"新连接先注册成功，旧连接的 close 才姗姗来迟"。本仓库给每次注册分配了
`connToken`，close 时比对令牌，不匹配就忽略。

### 8. 云函数报执行超时
`edgeone.json` 里 `cloudFunctions.nodejs.maxDuration` 默认 **30 秒**，
可配 10–120。WebSocket 长连接必须调到上限。

### 9. 国内访问慢
默认测试域名（`*.edgeone.app`）走**海外节点**。要在中国大陆有低延迟，
必须绑定**已备案**的自定义域名并选择中国大陆加速区域。

### 10. `/health` 或 `/admin` 返回 404
EdgeOne 是**文件即路由**：`node-functions/index.js` **只映射到 `/`**，
不会处理 `/health`、`/admin/*` —— 这些路径会去找不存在的同名文件然后掉进静态 404。
必须有一个 catch-all 入口 `node-functions/[[default]].js` 兜底。
本仓库两个入口共用 `_vnt/http.js` 与 `_vnt/ws.js` 的同一份实现。

### 11. 部署后设备互相看不见
存储降级为内存后端了 —— 十有八九是构建时没执行 `npm install`，
`@edgeone/pages-blob` 没装上。**这种情况下服务不会报错**，只是跨实例共享失效。
访问 `/health` 看 `storage` 字段：`blob` 才对，`memory` 就是降级了。

### 12. 消息类型编号不要杜撰
VNT 2.x 的 `MsgType` 里，**33 号是未分配的**（客户端 `try_from(33u8)` 会报错）。
早期版本这里写了 `Application: 33`，属杜撰 —— 多发一个非法类型比少一个更危险。

---

## 兼容性核对清单

改协议相关代码后，建议逐条确认（都是客户端的硬约束）：

| 约束 | 值 |
|---|---|
| `server_instance_id` | 空或**恰好 32 字节** |
| `multi_link_supported` | 建议 `false`（本实现按单连接建模） |
| `ClientSimpleInfoList.is_all` | 推送时恒为 `true` |
| 帧头长度 | 16 字节（VNT 2.x） |
| `MsgType` 取值 | 必须与 vnt-core 一致，33 号未分配 |
| 打洞信令 | `PunchStart1/2` 等必须由服务端转发（`ttl=2`，只够一跳） |

---

## 目录结构

```
vnts2-edgeone/
├── node-functions/              # EdgeOne 函数目录（目录前缀不进 URL）
│   ├── index.js                  # 根路径入口（文件即路由 → 只映射 /）
│   ├── [[default]].js            # catch-all 入口 → /health、/admin/* 等
│   └── _vnt/                     # 下划线开头 = 内部模块，不生成路由
│       ├── ws.js                 # WebSocket 接入（两种运行时形态）
│       ├── http.js               # HTTP 路由分发 + /health + 状态页
│       ├── admin.js              # 设备登记管理 API
│       ├── protobuf.js           # 最小 protobuf3 读写
│       ├── packet.js             # VNT 2.x 16 字节帧头 + MsgType
│       ├── control-messages.js   # 控制消息编解码
│       ├── shared-store.js       # Blob 后端（含内存降级）
│       ├── state.js              # 共享设备表 + 本实例连接表
│       └── server.js             # 服务端核心逻辑
├── test/
│   ├── protocol.test.js          # 协议 + 登记 + 端到端（31 项）
│   ├── shared-state.test.js      # 跨实例共享（11 项）
│   ├── ws-e2e.test.mjs           # 接入层 e2e（41 项）
│   └── routes.test.mjs           # 双入口路由分发（12 项）
├── edgeone.json
├── package.json
└── README.md
```

---

## 测试

```bash
npm test
```

- `protocol.test.js` —— 编解码、设备登记、保留地址校验、打洞信令、不中转业务流量
- `shared-state.test.js` —— **跨实例**：设备表共享、并发写不丢数据、信令经信箱投递
- `ws-e2e.test.mjs` —— 接入层：`/admin` API、注册校验、两种 WS 形态、健康检查
- `routes.test.mjs` —— 两个入口各自负责哪些路径（`/` vs `/health` vs `/admin/*`）

本地跑时 Blob 会降级为内存后端（没有 EdgeOne 凭据），跨实例测试用共享的内存后端模拟。

---

## 限制（平台约束，非代码问题）

1. **连接时长受限**。单次执行上限 120 秒（已配置）；站点层 WebSocket 空闲超时最长 300 秒。
   建议客户端心跳间隔设在 60 秒以内。客户端会自动重连。
2. **只支持 HTTP/1.1 的 WebSocket**，不支持 HTTP/2。
3. **只能有一个网络**（`VNT_NETWORK` 单值）。
4. **不含**服务端数据中继、多服务端互联、IKEv2、WireGuard、订阅托管、子网同步。

当双方都是对称 NAT、打洞失败时，**没有任何兜底**（这是纯打洞模式的代价）。
如果这种场景常见，建议改用带 Durable Object 的部署形态，或把 `VNT_ALLOW_RELAY=1`
打开（但跨实例中继因轮询延迟体验不佳，仅在双方恰好同实例时较快）。

---

## 免责声明

本项目仅供学习交流与自建组网使用，请勿用于任何商业或非法用途。
使用本项目代码产生的后果由使用者自行承担。
