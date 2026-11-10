/* ============================================================
   tools/lib/gateway.mjs
   本机 LLM 网关客户端（http://127.0.0.1:8765）。

   只做三件事：
   - 校验地址必须是回环地址，避免把网关暴露到公网；
   - 调 GET /v1/status；
   - 调 POST /v1/complete，并把失败翻译成可处理的 error_type。

   不读取任何厂商 API Key。可选的网关 token 由后台从环境变量注入。
   ============================================================ */

export class GatewayError extends Error {
  /**
   * @param {string} type busy | wait_timeout | rate_limited | timeout |
   *   reasoning_exhausted | no_agent | empty_content | network | cancelled | ...
   * @param {string} message
   * @param {{status?: number, body?: any}} [extra]
   */
  constructor(type, message, extra = {}) {
    super(message);
    this.name = "GatewayError";
    this.type = type;
    this.status = extra.status || 0;
    this.body = extra.body ?? null;
  }
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new GatewayError("cancelled", "任务已取消"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new GatewayError("cancelled", "任务已取消"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** 只允许 http(s)://127.0.0.1 / localhost / ::1，返回去掉尾部斜杠的地址。 */
export function assertLoopback(baseUrl) {
  let u;
  try {
    u = new URL(String(baseUrl || "").trim());
  } catch {
    throw new GatewayError("bad_config", "网关地址不是合法 URL");
  }
  if (!["http:", "https:"].includes(u.protocol)) {
    throw new GatewayError("bad_config", "网关地址必须以 http:// 或 https:// 开头");
  }
  if (!LOOPBACK.has(u.hostname)) {
    throw new GatewayError("bad_config", "网关只允许 127.0.0.1 / localhost / ::1，不能指向公网地址");
  }
  return (u.origin + u.pathname).replace(/\/+$/, "");
}

function guessType(status, data) {
  if (data && typeof data.error_type === "string" && data.error_type) return data.error_type;
  if (status === 429) return "busy";
  if (status === 503) return "wait_timeout";
  if (status === 502) return "upstream_error";
  if (status === 404) return "no_agent";
  if (status === 401 || status === 403) return "auth";
  if (status === 408) return "timeout";
  return "http_error";
}

async function request(url, init, { signal, timeoutMs }) {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    if (signal?.aborted) throw new GatewayError("cancelled", "任务已取消");
    if (timedOut) throw new GatewayError("timeout", `请求超过 ${Math.round(timeoutMs / 1000)} 秒仍未返回`);
    throw new GatewayError("network", `连不上网关：${e?.message || e}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * GET /v1/status。网络失败不抛异常，返回 reachable:false，方便后台展示。
 */
export async function gatewayStatus(baseUrl, token, timeoutMs = 6000) {
  const at = Date.now();
  let base;
  try {
    base = assertLoopback(baseUrl);
  } catch (e) {
    return { reachable: false, ok: false, error: e.message, at };
  }

  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const res = await request(base + "/v1/status", { method: "GET", headers }, { timeoutMs });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* 非 JSON 也照样报告，前端只展示摘要 */
    }
    return {
      reachable: true,
      ok: res.ok && (!data || data.ok !== false),
      httpStatus: res.status,
      data,
      text: data ? undefined : text.slice(0, 500),
      at,
    };
  } catch (e) {
    return { reachable: false, ok: false, error: e.message, type: e.type, at };
  }
}

/**
 * POST /v1/complete。成功返回网关的完整 JSON（含 content）；
 * 失败抛 GatewayError，type 已按约定的错误类型归一。
 */
export async function gatewayComplete(cfg, payload, { signal, fetchTimeoutMs } = {}) {
  const base = assertLoopback(cfg.baseUrl);
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;

  const timeout = Math.max(Number(fetchTimeoutMs) || 120000, 30000);
  const res = await request(
    base + "/v1/complete",
    { method: "POST", headers, body: JSON.stringify(payload) },
    { signal, timeoutMs: timeout }
  );

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* 下面统一按错误处理 */
  }

  if (!res.ok || (data && data.ok === false)) {
    const type = guessType(res.status, data);
    const msg =
      (data && typeof data.error === "string" && data.error) ||
      (text ? `HTTP ${res.status}：${text.slice(0, 300)}` : `HTTP ${res.status}`);
    throw new GatewayError(type, msg, { status: res.status, body: data ?? text.slice(0, 4000) });
  }

  if (!data || typeof data.content !== "string") {
    throw new GatewayError("bad_response", "网关返回里没有 content 字段", {
      status: res.status,
      body: data ?? text.slice(0, 4000),
    });
  }

  if (!data.content.trim()) {
    throw new GatewayError(
      "empty_content",
      `网关返回空内容（finish_reason=${data.finish_reason || "未知"}）`,
      { status: res.status, body: data }
    );
  }

  return data;
}
