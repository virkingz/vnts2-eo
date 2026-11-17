// 跨实例共享的回归测试
//
// 这是 Blob 方案的核心价值所在，也是最容易出错的地方：
// EdgeOne 没有 Durable Object，同一网络的客户端可能落在**不同函数实例**。
// 本文件用两个独立的 Registry/NetworkState（模拟两个实例，共享同一个后端）
// 验证：
//   * 设备表跨实例可见
//   * 打洞信令能跨实例投递（A 在实例1，B 在实例2）
//   * 心跳能取走写给自己的信令
//   * 过期信令被清理，不会无限堆积
//
// 运行：node test/shared-state.test.js

import assert from "node:assert/strict";

import { ipToU32, u32ToIp, buildPacket, MsgType, parseHeaderFast, HEAD_LENGTH } from "../node-functions/_vnt/packet.js";
import {
  createMemoryBackend,
  resetBackend,
  signalPrefixFor,
} from "../node-functions/_vnt/shared-store.js";
import { Registry, resolveConfig } from "../node-functions/_vnt/state.js";
import { Session } from "../node-functions/_vnt/server.js";

/** 本测试统一用 10.26.2.0/24，与项目推荐网段一致 */
const GATEWAY = "10.26.2.1";

let passed = 0;
let failed = 0;
const pending = [];

function test(name, fn) {
  pending.push({ name, fn });
}

async function runAll() {
  for (const { name, fn } of pending) {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (e) {
      failed++;
      console.error(`  ✗ ${name}\n    ${e.message}`);
      process.exitCode = 1;
    }
  }
}

/** 全局共享一个后端，模拟 Blob；两个 Registry 模拟两个实例 */
function useSharedBackend() {
  const backend = createMemoryBackend();
  globalThis.__VNT_SHARED_BACKEND__ = backend;
  resetBackend();
  return backend;
}

/** 造一个"实例"：独立的 Registry + 独立配置 */
function makeInstance() {
  const reg = new Registry();
  return {
    registry: reg,
    net(code, env = {}) {
      const cfg = resolveConfig({ VNT_NETWORK: code, VNT_GATEWAY: GATEWAY, ...env });
      return reg.network(cfg.networkCode, cfg);
    },
  };
}

// ---------------------------------------------------------------------------
console.log("跨实例：设备表共享");

test("实例1 登记的设备，实例2 也能看到", async () => {
  useSharedBackend();
  const code = "x-net-1";
  const i1 = makeInstance();
  const i2 = makeInstance();

  const net1 = i1.net(code);
  await net1.registerEntry({ deviceId: "pc-1", ip: ipToU32("10.26.2.2"), name: "书房" });

  const net2 = i2.net(code);
  const seen = await net2.listEntries();
  assert.equal(seen.length, 1, "实例2 应看到实例1 登记的设备");
  assert.equal(seen[0].deviceId, "pc-1");
  assert.equal(seen[0].ip, "10.26.2.2");
});

test("两个实例并发登记不同设备，不会互相覆盖", async () => {
  useSharedBackend();
  const code = "x-net-2";
  const i1 = makeInstance();
  const i2 = makeInstance();
  const n1 = i1.net(code);
  const n2 = i2.net(code);

  // 并发写：这正是"整表存成一个大 JSON"会丢数据的场景
  await Promise.all([
    n1.registerEntry({ deviceId: "a", ip: ipToU32("10.26.2.2") }),
    n2.registerEntry({ deviceId: "b", ip: ipToU32("10.26.2.3") }),
  ]);

  const list = await n1.listEntries();
  assert.equal(list.length, 2, `两台设备都应存在，实际 ${list.map((d) => d.deviceId).join(",")}`);
});

test("同一 ip 跨实例登记会被拒绝", async () => {
  useSharedBackend();
  const code = "x-net-3";
  const i1 = makeInstance();
  const i2 = makeInstance();
  const n1 = i1.net(code);
  const n2 = i2.net(code);

  assert.equal((await n1.registerEntry({ deviceId: "a", ip: ipToU32("10.26.2.5") })).ok, true);
  const dup = await n2.registerEntry({ deviceId: "b", ip: ipToU32("10.26.2.5") });
  assert.equal(dup.ok, false, "实例2 不应允许重复登记同一 ip");
});

test("设备在实例1 上线，实例2 能看到它在线", async () => {
  useSharedBackend();
  const code = "x-net-4";
  const i1 = makeInstance();
  const i2 = makeInstance();
  const n1 = i1.net(code);
  const n2 = i2.net(code);

  await n1.registerEntry({ deviceId: "a", ip: ipToU32("10.26.2.2") });
  await n1.registerDevice({
    deviceId: "a", clientType: 0, requestedIp: ipToU32("10.26.2.2"), send: () => {},
  });

  const list = await n2.listEntries();
  const a = list.find((d) => d.deviceId === "a");
  assert.equal(a.online, true, "实例2 应看到实例1 的设备在线");
  assert.equal(a.local, false, "但该连接不在实例2，local 应为 false");
});

// ---------------------------------------------------------------------------
console.log("跨实例：打洞信令投递");

test("A 在实例1、B 在实例2 时，打洞信令经信箱送达 B", async () => {
  useSharedBackend();
  const code = "x-sig-1";
  const i1 = makeInstance();
  const i2 = makeInstance();
  const n1 = i1.net(code);
  const n2 = i2.net(code);

  // 分别登记
  await n1.registerEntry({ deviceId: "A", ip: ipToU32("10.26.2.2") });
  await n1.registerEntry({ deviceId: "B", ip: ipToU32("10.26.2.3") });

  // A 连到实例1
  const outA = [];
  await n1.registerDevice({
    deviceId: "A", clientType: 0, requestedIp: ipToU32("10.26.2.2"), send: (b) => outA.push(b),
  });

  // B 连到实例2（不同实例！）
  const outB = [];
  await n2.registerDevice({
    deviceId: "B", clientType: 0, requestedIp: ipToU32("10.26.2.3"), send: (b) => outB.push(b),
  });

  // A 发打洞信令给 B —— 本地没有 B 的连接，必须走信箱
  const punch = buildPacket({
    msgType: MsgType.PunchStart1,
    ttl: 2,
    src: ipToU32("10.26.2.2"),
    dest: ipToU32("10.26.2.3"),
    payload: new Uint8Array([9, 9, 9]),
  }).toUint8Array();

  const how = await n1.deliverSignal(ipToU32("10.26.2.3"), punch);
  assert.equal(how, "forwarded", "B 不在本实例，应走信箱转发");

  // B 在实例2 心跳时取走
  const delivered = await n2.drainSignals(ipToU32("10.26.2.3"), (b) => outB.push(b));
  assert.equal(delivered, 1, "B 应取到 1 条信令");
  assert.equal(outB.length, 1);
  assert.equal(parseHeaderFast(outB[0]).msgType, MsgType.PunchStart1);
  assert.deepEqual(Array.from(outB[0].subarray(HEAD_LENGTH)), [9, 9, 9]);
});

test("同实例内直发，不写信箱", async () => {
  useSharedBackend();
  const code = "x-sig-2";
  const i1 = makeInstance();
  const n1 = i1.net(code);
  await n1.registerEntry({ deviceId: "A", ip: ipToU32("10.26.2.2") });
  await n1.registerEntry({ deviceId: "B", ip: ipToU32("10.26.2.3") });

  const outB = [];
  await n1.registerDevice({ deviceId: "A", clientType: 0, requestedIp: ipToU32("10.26.2.2"), send: () => {} });
  await n1.registerDevice({ deviceId: "B", clientType: 0, requestedIp: ipToU32("10.26.2.3"), send: (b) => outB.push(b) });

  const how = await n1.deliverSignal(ipToU32("10.26.2.3"), new Uint8Array(16));
  assert.equal(how, "local", "B 在本实例，应直发");
  assert.equal(outB.length, 1);

  const backend = await globalThis.__VNT_SHARED_BACKEND__;
  const keys = await backend.list(signalPrefixFor(code, ipToU32("10.26.2.3")));
  assert.equal(keys.length, 0, "直发不应在信箱里留下记录");
});

test("取走的信令会被清理，不重复投递", async () => {
  useSharedBackend();
  const code = "x-sig-3";
  const i1 = makeInstance();
  const n1 = i1.net(code);
  await n1.registerEntry({ deviceId: "B", ip: ipToU32("10.26.2.3") });

  await n1.deliverSignal(ipToU32("10.26.2.3"), new Uint8Array(16).fill(7));

  const out = [];
  const first = await n1.drainSignals(ipToU32("10.26.2.3"), (b) => out.push(b));
  const second = await n1.drainSignals(ipToU32("10.26.2.3"), (b) => out.push(b));
  assert.equal(first, 1);
  assert.equal(second, 0, "第二次不应再取到同一条");
  assert.equal(out.length, 1);
});

test("过期信令被丢弃且清理", async () => {
  useSharedBackend();
  const code = "x-sig-4";
  const i1 = makeInstance();
  const n1 = i1.net(code);
  const backend = globalThis.__VNT_SHARED_BACKEND__;

  // 手工塞一条 60 秒前的信令
  const { signalKey } = await import("../node-functions/_vnt/shared-store.js");
  await backend.put(
    signalKey(code, ipToU32("10.26.2.3"), "old"),
    JSON.stringify({ dest: ipToU32("10.26.2.3"), at: Date.now() - 60_000, data: [1, 2, 3] }),
  );

  const out = [];
  const delivered = await n1.drainSignals(ipToU32("10.26.2.3"), (b) => out.push(b));
  assert.equal(delivered, 0, "过期信令不应投递");
  assert.equal(out.length, 0);

  const left = await backend.list(signalPrefixFor(code, ipToU32("10.26.2.3")));
  assert.equal(left.length, 0, "过期信令应被清理，避免无限堆积");
});

// ---------------------------------------------------------------------------
console.log("跨实例：Session 全链路");

test("Session 心跳会取走别处投来的信令", async () => {
  useSharedBackend();
  const code = "x-full-1";

  // 实例1：登记并让 A 上线
  const i1 = makeInstance();
  const n1 = i1.net(code);
  await n1.registerEntry({ deviceId: "A", ip: ipToU32("10.26.2.2") });

  // 实例2：B 用 Session 连接
  const outB = [];
  const sb = new Session({ VNT_NETWORK: code, VNT_GATEWAY: GATEWAY });
  const payloadLen = outB.length;
  void payloadLen;
  const { Writer } = await import("../node-functions/_vnt/protobuf.js");
  const reg = new Writer();
  reg.writeString(1, code);
  reg.writeString(2, "B");
  reg.writeFixed32Always(3, ipToU32("10.26.2.3"));
  reg.writeString(5, "2.0.12");
  reg.writeUInt32(15, 0);
  const req = new Writer();
  req.writeMessage(1, reg);

  // B 尚未登记 -> 应被拒
  const denied = await sb.handleFirstFrame(req.finish(), (b) => outB.push(b));
  assert.equal(denied, false, "未登记的 B 应被拒绝");

  // 登记后重试
  const i2 = makeInstance();
  const n2 = i2.net(code);
  await n2.registerEntry({ deviceId: "B", ip: ipToU32("10.26.2.3") });

  const sb2 = new Session({ VNT_NETWORK: code, VNT_GATEWAY: GATEWAY });
  const outB2 = [];
  const ok = await sb2.handleFirstFrame(req.finish(), (b) => outB2.push(b));
  assert.equal(ok, true, "登记后应能注册");

  // 实例1 的 A 发一条打洞信令给 B
  await n1.deliverSignal(
    ipToU32("10.26.2.3"),
    buildPacket({
      msgType: MsgType.PunchStart1,
      ttl: 2,
      src: ipToU32("10.26.2.2"),
      dest: ipToU32("10.26.2.3"),
      payload: new Uint8Array([5, 5]),
    }).toUint8Array(),
  );

  // B 心跳（PingTurn 16 字节）应把信令取出来
  outB2.length = 0;
  const hbPayload = new Uint8Array(16);
  new DataView(hbPayload.buffer).setBigInt64(0, BigInt(Date.now()), false);
  new DataView(hbPayload.buffer).setBigUint64(8, 0n, false);
  const hb = buildPacket({ msgType: MsgType.PingTurn, ttl: 1, gateway: true, payload: hbPayload }).toUint8Array();
  await sb2.handleDataPacket(hb, (b) => outB2.push(b));

  const gotPunch = outB2.some((f) => (f[0] & 0x7f) === MsgType.PunchStart1);
  assert.ok(gotPunch, `心跳应取走跨实例投来的打洞信令，实际收到类型: ${outB2.map((f) => f[0] & 0x7f).join(",")}`);
});

test("重连后旧连接的 close 不会把新连接打下线", async () => {
  useSharedBackend();
  const code = "x-full-2";
  const i1 = makeInstance();
  const n1 = i1.net(code);
  await n1.registerEntry({ deviceId: "A", ip: ipToU32("10.26.2.2") });

  const r1 = await n1.registerDevice({
    deviceId: "A", clientType: 0, requestedIp: ipToU32("10.26.2.2"), send: () => {},
  });
  // 重连：新连接注册成功
  const r2 = await n1.registerDevice({
    deviceId: "A", clientType: 0, requestedIp: ipToU32("10.26.2.2"), send: () => {},
  });
  assert.notEqual(r1.connToken, r2.connToken);

  // 旧连接的 close 姗姗来迟 —— 必须被忽略
  const changed = await n1.offline("A", r1.connToken);
  assert.equal(changed, false, "旧连接 close 不应改变状态");

  const list = await n1.listEntries();
  assert.equal(list[0].online, true, "新连接应保持在线");
});

test("已登记设备离线后仍保留登记（可随时重连）", async () => {
  useSharedBackend();
  const code = "x-full-3";
  const i1 = makeInstance();
  const n1 = i1.net(code);
  await n1.registerEntry({ deviceId: "A", ip: ipToU32("10.26.2.2"), name: "书房电脑" });
  const r = await n1.registerDevice({
    deviceId: "A", clientType: 0, requestedIp: ipToU32("10.26.2.2"), send: () => {},
  });
  await n1.offline("A", r.connToken);

  const list = await n1.listEntries();
  assert.equal(list.length, 1, "登记不应被删除");
  assert.equal(list[0].name, "书房电脑", "名字等登记信息应保留");
  assert.equal(list[0].online, false);
  assert.equal(list[0].everConnected, true);
});

await runAll();
console.log(`\n通过 ${passed} 项测试${failed ? `，失败 ${failed} 项` : ""}`);
