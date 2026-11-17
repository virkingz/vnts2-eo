// 设备登记管理 API
//
// 本服务端不做 DHCP：设备必须**先登记**（device_id + ip + 名字），
// 之后客户端才能用这三个值连接，且 device_id 与 ip 必须与登记一致。
//
// 路由（挂在站点根的 /admin/*，与 WebSocket 的 / 互不干扰）：
//   POST   /admin/devices        新增/更新登记  { deviceId, ip, name?, networkCode? }
//   GET    /admin/devices        列出登记
//   DELETE /admin/devices/{id}   删除登记
//   GET    /admin                说明页
//
// 鉴权：环境变量 VNT_ADMIN_TOKEN。所有 /admin 请求必须带
//   Authorization: Bearer <token>
// 未配置 token 时**拒绝所有管理请求**（而不是放开）——
// 否则任何人都能往你的虚拟网络里添设备。

import { registry, resolveConfig } from "./state.js";
import { ipToU32, u32ToIp } from "./packet.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: JSON_HEADERS });
}

/** 从环境变量取管理员令牌；未配置则视为不可用 */
function adminToken(env) {
  return String(env?.VNT_ADMIN_TOKEN || "").trim();
}

function authorized(request, env) {
  const token = adminToken(env);
  if (!token) return false;
  const header = request.headers.get("Authorization") || "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (m && m[1].trim() === token) return true;
  // 也允许 ?token= 便于浏览器直接点（GET 场景）
  const url = new URL(request.url);
  return url.searchParams.get("token") === token;
}

/**
 * 统一入口。返回 Response，或 null 表示「不是 /admin 请求」，
 * 由调用方继续走 WebSocket / 状态页逻辑。
 */
export async function handleAdmin(request, env) {
  const url = new URL(request.url);
  if (url.pathname !== "/admin" && !url.pathname.startsWith("/admin/")) return null;

  if (!adminToken(env)) {
    return json(
      {
        error: "管理接口未启用",
        hint: "请在项目环境变量中设置 VNT_ADMIN_TOKEN 后再使用 /admin 接口",
      },
      503,
    );
  }
  if (!authorized(request, env)) {
    return json({ error: "unauthorized", hint: "请在 Authorization 头中提供 Bearer <VNT_ADMIN_TOKEN>" }, 401);
  }

  const cfg = resolveConfig(env);
  if (!cfg.networkCode) {
    return json(
      {
        error: "未配置网络编号",
        hint: "请在项目环境变量中设置 VNT_NETWORK（本服务端只支持一个网络）",
      },
      503,
    );
  }
  const net = registry.network(cfg.networkCode, cfg);

  // ---- 说明页 ----
  if (url.pathname === "/admin" || url.pathname === "/admin/") {
    if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
    const devices = await net.listEntries();
    return json({
      networkCode: cfg.networkCode,
      gateway: u32ToIp(net.gateway),
      prefixLen: net.prefixLen,
      count: devices.length,
      devices,
      endpoints: {
        "POST /admin/devices": "新增/更新登记，body: { deviceId, ip, name }",
        "GET /admin/devices": "列出全部登记",
        "DELETE /admin/devices/{deviceId}": "删除登记",
      },
    });
  }

  // ---- /admin/devices ----
  if (url.pathname === "/admin/devices" || url.pathname === "/admin/devices/") {
    if (request.method === "GET") {
      return json({ networkCode: cfg.networkCode, devices: await net.listEntries() });
    }

    if (request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "请求体必须是 JSON" }, 400);
      }
      const deviceId = String(body?.deviceId ?? "").trim();
      const ipStr = String(body?.ip ?? "").trim();
      const name = String(body?.name ?? "").trim();

      if (!deviceId) return json({ error: "deviceId 不能为空" }, 400);
      if (deviceId.length > 64) return json({ error: "deviceId 长度不能超过 64" }, 400);
      if (!ipStr) return json({ error: "ip 不能为空" }, 400);

      let ip;
      try {
        ip = ipToU32(ipStr);
      } catch (e) {
        return json({ error: `ip 格式错误：${e.message}` }, 400);
      }

      const result = await net.registerEntry({ deviceId, ip, name });
      if (!result.ok) return json({ error: result.error }, 409);

      return json(
        {
          ok: true,
          networkCode: cfg.networkCode,
          device: result.device,
          // 说明这一点，避免用户以为要等缓存过期
          hint: "登记已生效，客户端可立即连接（本服务端使用强一致读，无需等待）",
        },
        201,
      );
    }

    return json({ error: "method not allowed" }, 405);
  }

  // ---- /admin/devices/{id} ----
  const prefix = "/admin/devices/";
  if (url.pathname.startsWith(prefix)) {
    const raw = url.pathname.slice(prefix.length).replace(/\/$/, "");
    const deviceId = decodeURIComponent(raw);
    if (!deviceId) return json({ error: "deviceId 不能为空" }, 400);

    if (request.method === "DELETE") {
      const existed = await net.removeEntry(deviceId);
      if (!existed) return json({ error: `设备 '${deviceId}' 未登记` }, 404);
      return json({ ok: true, removed: deviceId });
    }

    if (request.method === "GET") {
      const devices = await net.listEntries();
      const one = devices.find((d) => d.deviceId === deviceId);
      if (!one) return json({ error: `设备 '${deviceId}' 未登记` }, 404);
      return json(one);
    }

    return json({ error: "method not allowed" }, 405);
  }

  return json({ error: "not found" }, 404);
}
