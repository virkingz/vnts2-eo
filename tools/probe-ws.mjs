// 用真实 WebSocket 客户端连线上服务，验证握手与注册链路
//
// 用途：判断客户端「未连接」是握手失败还是被注册校验拒绝。
// 连接能建立 + 收到服务端响应 = 握手正常。
//
// 运行：node tools/probe-ws.mjs <wss地址> <network_code> <device_id> <ip>

import { Writer } from "../cloud-functions/_vnt/protobuf.js";

const [, , urlArg, netArg, devArg, ipArg] = process.argv;
const url = urlArg || "wss://eovnts2.virking.top:443";
const net = netArg || "wangzhang";
const dev = devArg || "vnt-sugon";
const ip = ipArg || "10.26.2.205";

function ipToU32(str) {
  const p = String(str).split(".").map(Number);
  return (((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0);
}

function regFrame({ networkCode, deviceId, ip }) {
  const reg = new Writer();
  reg.writeString(1, networkCode);
  reg.writeString(2, deviceId);
  reg.writeFixed32Always(3, ipToU32(ip));
  reg.writeString(5, "2.0.12");
  reg.writeUInt32(15, 0); // client_type = VNT
  const req = new Writer();
  req.writeMessage(1, reg);
  return req.finish();
}

/** 从 ResponseMessage 里抽出 ErrorResponseMsg 的 message 字段（人工可读） */
function extractText(bytes) {
  // 先看外层 field 号：1=reg, 2=error, 3=confirm_reg, 4=fast_reg
  if (bytes.length < 2) return "(空)";
  const outerField = bytes[0] >> 3;
  const kind = { 1: "RegResponse", 2: "ErrorResponse", 3: "ConfirmRegResponse", 4: "FastRegResponse" }[outerField] || `field${outerField}`;
  // 直接在整个字节流里找 UTF-8 可打印片段，够诊断用
  const printable = [];
  for (const b of bytes) {
    if (b >= 0x20 && b < 0x7f) printable.push(String.fromCharCode(b));
    else if (b >= 0xe0) printable.push("?");
    else printable.push(".");
  }
  const decoded = Buffer.from(bytes).toString("utf8").replace(/[\u0000-\u001f]+/g, " ").trim();
  return `${kind} | ${decoded.slice(0, 200)}`;
}

console.log(`连接 ${url}`);
console.log(`  network_code=${net}  device_id=${dev}  ip=${ip}`);
console.log("");

const ws = new WebSocket(url);
ws.binaryType = "arraybuffer";

const timer = setTimeout(() => {
  console.log("结果：超时（15 秒内没有完成握手或没有响应）");
  try {
    ws.close();
  } catch {
    /* ignore */
  }
  process.exit(2);
}, 15000);

ws.onopen = () => {
  console.log("✅ WebSocket 握手成功（连接已建立）");
  const frame = regFrame({ networkCode: net, deviceId: dev, ip });
  console.log(`→ 发送注册帧（${frame.length} 字节）`);
  ws.send(frame);
};

ws.onmessage = (event) => {
  const bytes = new Uint8Array(event.data);
  console.log(`← 收到 ${bytes.length} 字节`);
  console.log("   " + extractText(bytes));
  console.log("");
  console.log("结论：握手与注册链路都通，服务端已处理请求。");
  console.log("      若上面是 ErrorResponse 且提到「未登记」，说明需要先在 /admin 登记该设备。");
  clearTimeout(timer);
  ws.close();
  process.exit(0);
};

ws.onerror = (event) => {
  console.log("❌ WebSocket 错误：", event?.message || event?.error?.message || "(无详情)");
};

ws.onclose = (event) => {
  if (event.code !== 1005 && event.code !== 1000 && event.code !== 1006) {
    console.log(`连接关闭：code=${event.code} reason=${event.reason || "(无)"}`);
  } else if (event.code === 1006) {
    console.log("❌ 异常关闭（1006）—— 通常意味着握手阶段就被拒绝，或连接被中途切断");
  }
  clearTimeout(timer);
};
