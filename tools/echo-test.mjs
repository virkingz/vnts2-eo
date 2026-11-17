// 对指定路径做 WebSocket 回显测试（用真实 WS 客户端）
const url = process.argv[2];
if (!url) { console.error("用法: node tools/echo-test.mjs <wss-url>"); process.exit(1); }
console.log("连接", url);
const ws = new WebSocket(url);
ws.binaryType = "arraybuffer";
const t = setTimeout(() => { console.log("结果: 超时（未完成握手）"); try{ws.close()}catch{}; process.exit(2); }, 20000);
ws.onopen = () => {
  console.log("✅ 握手成功");
  ws.send("hello-from-probe");
  console.log("→ 已发送 hello-from-probe");
};
ws.onmessage = (e) => {
  const s = typeof e.data === "string" ? e.data : `<${e.data?.byteLength ?? "?"} bytes>`;
  console.log("← 收到:", s);
  console.log("结论: WebSocket 双向通信正常 ✅");
  clearTimeout(t); ws.close(); process.exit(0);
};
ws.onerror = (e) => console.log("❌ 错误:", e?.message || "(无详情)");
ws.onclose = (e) => { if (e.code === 1006) console.log("❌ 异常关闭 1006（握手被拒）"); clearTimeout(t); };
