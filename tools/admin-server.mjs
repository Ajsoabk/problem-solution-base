/* ============================================================
   tools/admin-server.mjs
   题解后台：只监听 127.0.0.1，负责
   - 托管静态站点与后台页面
   - 读写 problems/*.json，并调用 build.mjs 重新打包
   - 代理本机 LLM 网关（不直连任何厂商，不读取厂商密钥）
   - 管理写作规范 / 网关设置 / AI 生成任务

   启动：node tools/admin-server.mjs
   打开：http://127.0.0.1:8790/admin/
   ============================================================ */
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { buildAll } from "./build.mjs";
import { validateProblem } from "./lib/schema.mjs";
import { GatewayError, assertLoopback, gatewayStatus } from "./lib/gateway.mjs";
import { generateSolution } from "./lib/ai.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const PROBLEMS_DIR = path.join(ROOT, "problems");
const DATA_FILE = path.join(ROOT, "assets", "data.js");
const ADMIN_DIR = path.join(ROOT, "admin");
const RULES_FILE = path.join(ADMIN_DIR, "ai-rules.md");
const RULES_DEFAULT_FILE = path.join(ADMIN_DIR, "ai-rules.default.md");
const SETTINGS_FILE = path.join(ADMIN_DIR, "settings.json");
const TOKEN_FILE = path.join(ADMIN_DIR, "gateway-token.txt");
const TMP_DIR = path.join(ROOT, "tools", ".tmp");
const TRASH_DIR = path.join(TMP_DIR, "trash");
const PORT = Number(process.env.ADMIN_PORT || 8790);

const DEFAULT_SETTINGS = {
  baseUrl: "http://127.0.0.1:8765",
  maxTokens: 16384,
  temperature: 0.3,
  pool: "free",
  agentId: "",
  model: "",
  timeoutMs: 300000,
  waitTimeoutMs: 0,
  maxAttempts: 4,
};

/* ============================================================
   基础工具
   ============================================================ */

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const nowIso = () => new Date().toISOString();
const pad = (n) => String(n).padStart(2, "0");
const localDate = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const trimStr = (v) => (typeof v === "string" ? v.trim() : "");

async function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, text, "utf8");
  try {
    await fsp.rename(tmp, file);
  } catch {
    await fsp.copyFile(tmp, file);
    await fsp.rm(tmp, { force: true });
  }
}

function ensureDirs() {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.mkdirSync(TRASH_DIR, { recursive: true });
}

/* ============================================================
   设置 / 规范 / token
   ============================================================ */

function readToken() {
  const env = trimStr(process.env.LLM_GATEWAY_TOKEN);
  if (env) return env;
  try {
    return trimStr(fs.readFileSync(TOKEN_FILE, "utf8"));
  } catch {
    return "";
  }
}

function readSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    return normalizeSettings(raw, true);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function normalizeSettings(raw, lenient = false) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HttpError(400, "设置必须是一个 JSON 对象");
  }
  const s = { ...DEFAULT_SETTINGS };

  if (raw.baseUrl !== undefined) {
    try {
      s.baseUrl = assertLoopback(raw.baseUrl);
    } catch (e) {
      throw new HttpError(400, e.message);
    }
  }

  const intIn = (key, min, max) => {
    if (raw[key] === undefined) return;
    const n = Number(raw[key]);
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new HttpError(400, `${key} 必须是 ${min}~${max} 之间的整数`);
    }
    s[key] = n;
  };
  intIn("maxTokens", 1024, 65536);
  intIn("timeoutMs", 30000, 900000);
  intIn("waitTimeoutMs", 0, 900000);
  intIn("maxAttempts", 1, 6);

  if (raw.temperature !== undefined) {
    const t = Number(raw.temperature);
    if (!Number.isFinite(t) || t < 0 || t > 2) throw new HttpError(400, "temperature 必须在 0~2 之间");
    s.temperature = t;
  }

  for (const [key, max] of [
    ["pool", 40],
    ["agentId", 120],
    ["model", 120],
  ]) {
    if (raw[key] === undefined) continue;
    const v = String(raw[key]).trim();
    if (v.length > max) throw new HttpError(400, `${key} 太长（最多 ${max} 字符）`);
    s[key] = v;
  }

  if (lenient) return s;
  return s;
}

function saveSettings(raw) {
  const s = normalizeSettings(raw);
  fs.mkdirSync(ADMIN_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2) + "\n", "utf8");
  return s;
}

function readRulesDefault() {
  try {
    return fs.readFileSync(RULES_DEFAULT_FILE, "utf8");
  } catch {
    return "# 题解生成规范\n\n（默认规范文件缺失，请恢复 admin/ai-rules.default.md）\n";
  }
}

function readRules() {
  try {
    const text = fs.readFileSync(RULES_FILE, "utf8");
    if (text.trim()) return text;
  } catch {
    /* 没保存过就用默认 */
  }
  return readRulesDefault();
}

/* ============================================================
   题库读写
   ============================================================ */

function problemPath(id) {
  if (!/^[A-Za-z]+\d+$/.test(String(id || ""))) {
    throw new HttpError(400, "题号格式不合法，应为「字母 + 数字」，如 P17827");
  }
  return path.join(PROBLEMS_DIR, id + ".json");
}

function problemSummary(p) {
  return {
    id: p.id,
    title: p.title,
    contest: p.contest || "",
    suffix: p.suffix || "",
    knowledge: Array.isArray(p.knowledge) ? p.knowledge : [],
  };
}

function listProblems() {
  const files = fs.existsSync(PROBLEMS_DIR)
    ? fs.readdirSync(PROBLEMS_DIR).filter((f) => f.endsWith(".json"))
    : [];
  const items = [];
  let newest = 0;

  for (const f of files) {
    const file = path.join(PROBLEMS_DIR, f);
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    newest = Math.max(newest, st.mtimeMs);
    const base = {
      file: `problems/${f}`,
      updatedAt: st.mtimeMs,
      size: st.size,
    };
    try {
      const p = JSON.parse(fs.readFileSync(file, "utf8"));
      const v = validateProblem(p);
      items.push({
        ...base,
        ...problemSummary(p),
        errors: v.errors.length,
        warnings: v.warnings.length,
      });
    } catch (e) {
      items.push({
        ...base,
        id: f.replace(/\.json$/, ""),
        title: "（JSON 解析失败）",
        contest: "",
        suffix: "",
        knowledge: [],
        errors: 1,
        warnings: 0,
        parseError: e.message,
      });
    }
  }

  items.sort((a, b) => {
    const na = parseInt(String(a.id || "").replace(/\D/g, ""), 10) || 0;
    const nb = parseInt(String(b.id || "").replace(/\D/g, ""), 10) || 0;
    return na - nb || String(a.id).localeCompare(String(b.id));
  });

  let dataAt = 0;
  try {
    dataAt = fs.statSync(DATA_FILE).mtimeMs;
  } catch {
    /* data.js 还没生成 */
  }

  return {
    items,
    count: items.length,
    dataUpdatedAt: dataAt || null,
    stale: newest > 0 && (dataAt === 0 || newest > dataAt + 1000),
  };
}

function readProblem(id) {
  const file = problemPath(id);
  if (!fs.existsSync(file)) throw new HttpError(404, `题目 ${id} 不存在`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new HttpError(500, `problems/${id}.json 解析失败：${e.message}`);
  }
}

async function saveProblem(id, p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) {
    throw new HttpError(400, "解析卡必须是一个 JSON 对象");
  }
  if (p.id !== id) throw new HttpError(400, `body.id（${p.id || "空"}）与路径题号（${id}）不一致`);

  const { errors, warnings } = validateProblem(p);
  if (errors.length) {
    throw new HttpError(422, "字段校验未通过，未写入", { errors, warnings });
  }

  const file = problemPath(id);
  const prev = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  const text = JSON.stringify(p, null, 2) + "\n";

  await writeAtomic(file, text);
  const build = buildAll();
  if (!build.ok) {
    if (prev === null) await fsp.rm(file, { force: true });
    else await writeAtomic(file, prev);
    buildAll();
    throw new HttpError(409, "保存后构建失败，已回滚到上一版", { errors: build.errors });
  }

  return {
    warnings: [...warnings, ...build.warnings.filter((w) => w.startsWith(`problems/${id}.json`))],
    build: { count: build.count, size: build.size },
  };
}

function draftProblem(id, title) {
  return {
    id,
    title: title || "未命名题目",
    contest: "",
    suffix: "",
    url: "",
    fetchedAt: localDate(),
    limits: "未标注",
    oneLiner: "待补充：一句话说清做法。",
    summary: ["待补充：题目给了什么、要输出什么。", "待补充：关键规则与容易误读的定义。", "待补充：把任务压成一句话。"],
    knowledge: ["待补充"],
    keyPoints: {
      title: "关键结论",
      items: [{ name: "待补充", code: "", note: "待补充：为什么成立。" }],
    },
    solution: {
      steps: ["待补充：第一步。", "待补充：第二步。"],
    },
    code:
      "#include<bits/stdc++.h>\nusing namespace std;\n\nint main(){\n    ios::sync_with_stdio(0);\n    cin.tie(0);\n\n    // 待补充\n\n    return 0;\n}\n",
    codeNote: "待补充：洛谷提交用这一版，标准输入输出，不要写 freopen。",
    pitfalls: [{ title: "待补充", severity: "中", desc: "待补充：什么输入会错、错成什么、怎么防。" }],
    tests: [],
    statement: ["待补充：题面原文。"],
  };
}

async function createProblem(body) {
  const id = trimStr(body?.id);
  const title = trimStr(body?.title);
  if (!/^[A-Za-z]+\d+$/.test(id)) {
    throw new HttpError(400, "题号格式不合法，应为「字母 + 数字」，如 P12345");
  }
  const file = problemPath(id);
  if (fs.existsSync(file)) throw new HttpError(409, `题目 ${id} 已存在`);

  const p = draftProblem(id, title);
  const v = validateProblem(p);
  if (v.errors.length) throw new HttpError(500, "草稿模板校验失败", { errors: v.errors });

  await writeAtomic(file, JSON.stringify(p, null, 2) + "\n");
  return { problem: p, warnings: ["已创建草稿，不会自动打包；补全并保存后才会出现在前台。"] };
}

async function deleteProblem(id) {
  const file = problemPath(id);
  if (!fs.existsSync(file)) throw new HttpError(404, `题目 ${id} 不存在`);

  const trash = path.join(TRASH_DIR, `${id}-${Date.now()}.json`);
  await fsp.mkdir(TRASH_DIR, { recursive: true });
  await fsp.rename(file, trash);
  const build = buildAll();
  if (!build.ok) {
    await fsp.rename(trash, file);
    buildAll();
    throw new HttpError(409, "删除后构建失败，已恢复该题", { errors: build.errors });
  }
  return { trashed: path.relative(ROOT, trash), build: { count: build.count, size: build.size } };
}

/* ============================================================
   AI 任务队列（免费池串行，任务也串行）
   ============================================================ */

const jobs = new Map();
const jobQueue = [];
let jobRunning = false;
let jobSeq = 0;

function pushLog(job, msg, level = "info") {
  job.log.push({ t: Date.now(), level, msg: String(msg).slice(0, 3000) });
  if (job.log.length > 500) job.log.splice(0, job.log.length - 500);
}

function serializeJob(job) {
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    elapsedMs: (job.finishedAt || Date.now()) - (job.startedAt || job.createdAt),
    log: job.log.slice(-200),
    result: job.result,
    error: job.error,
    input: {
      id: job.input.id,
      title: job.input.title,
      mode: job.input.mode,
    },
  };
}

function createJob(input) {
  const id = crypto.randomUUID();
  jobSeq++;
  const job = {
    id,
    seq: jobSeq,
    status: "queued",
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    log: [],
    result: null,
    error: null,
    input,
    controller: new AbortController(),
  };
  jobs.set(id, job);
  jobQueue.push(id);
  pushLog(job, `任务已创建：${input.id}（${input.mode === "repair" ? "修复" : "完整生成"}）`);
  if (jobQueue.length > 1) pushLog(job, `前面还有 ${jobQueue.length - 1} 个任务，免费池串行执行`);
  pumpJobs();
  return job;
}

async function pumpJobs() {
  if (jobRunning) return;
  jobRunning = true;
  try {
    while (jobQueue.length) {
      const job = jobs.get(jobQueue.shift());
      if (!job || job.status !== "queued") continue;

      job.status = "running";
      job.startedAt = Date.now();
      pushLog(job, "开始执行");

      try {
        const settings = readSettings();
        const token = readToken();
        const rules = readRules();
        const result = await generateSolution({
          cfg: { ...settings, token },
          rules,
          input: job.input,
          signal: job.controller.signal,
          log: (msg, level) => pushLog(job, msg, level),
        });
        job.result = result;
        job.status = result.errors?.length ? "done_with_errors" : "done";
        if (result.errors?.length) {
          pushLog(job, `已生成，但有 ${result.errors.length} 条字段错误，需要人工修正`, "warn");
        }
      } catch (e) {
        if (job.controller.signal.aborted || e.type === "cancelled") {
          job.status = "cancelled";
          pushLog(job, "任务已取消", "warn");
        } else {
          job.status = "error";
          const raw = typeof e.body?.raw === "string" ? e.body.raw : "";
          job.error = {
            type: e.type || "error",
            message: e.message || String(e),
            finishReason: e.body?.finish_reason || null,
            raw: raw ? raw.slice(0, 20000) : null,
          };
          pushLog(job, `失败：[${job.error.type}] ${job.error.message}`, "error");
          if (raw) {
            const dump = path.join(TMP_DIR, `ai-last-${job.id}.txt`);
            try {
              fs.mkdirSync(TMP_DIR, { recursive: true });
              fs.writeFileSync(dump, raw, "utf8");
              job.error.rawFile = path.relative(ROOT, dump);
              pushLog(job, `原始输出已保存：${job.error.rawFile}`, "warn");
            } catch {
              /* 写不了也不影响主流程 */
            }
          }
        }
      } finally {
        job.finishedAt = Date.now();
        pushLog(job, `任务结束：${job.status}`);
      }
    }
  } finally {
    jobRunning = false;
  }
}

function cancelJob(id) {
  const job = jobs.get(id);
  if (!job) throw new HttpError(404, "任务不存在");
  if (["done", "done_with_errors", "error", "cancelled"].includes(job.status)) {
    return { cancelled: false, status: job.status };
  }
  const i = jobQueue.indexOf(id);
  if (i >= 0) jobQueue.splice(i, 1);
  job.controller.abort();
  if (job.status === "queued") {
    job.status = "cancelled";
    job.finishedAt = Date.now();
    pushLog(job, "已从队列移除", "warn");
  }
  return { cancelled: true, status: job.status };
}

function validateJobInput(body) {
  const mode = body?.mode === "repair" ? "repair" : "full";
  const existing =
    body?.existing && typeof body.existing === "object" && !Array.isArray(body.existing) ? body.existing : null;

  const input = {
    mode,
    id: trimStr(body?.id),
    title: trimStr(body?.title) || trimStr(existing?.title),
    contest: trimStr(body?.contest) || trimStr(existing?.contest),
    suffix: trimStr(body?.suffix) || trimStr(existing?.suffix),
    url: trimStr(body?.url) || trimStr(existing?.url),
    limits: trimStr(body?.limits) || trimStr(existing?.limits),
    statement: String(body?.statement || "").trim(),
    code: String(body?.code || "").trim(),
    existing,
    validationErrors: [],
    extra: String(body?.extra || "").trim(),
  };

  if (existing) {
    if (!input.statement) input.statement = (existing.statement || []).join("\n\n");
    if (!input.code) input.code = typeof existing.code === "string" ? existing.code : "";
  }

  if (!/^[A-Za-z]+\d+$/.test(input.id)) {
    throw new HttpError(400, "题号格式不合法，应为「字母 + 数字」，如 P17827");
  }
  if (mode === "repair" && !existing) {
    throw new HttpError(400, "修复模式需要提供 existing（已有解析卡）");
  }
  if (!input.statement && !input.code && !existing) {
    throw new HttpError(400, "至少提供题面原文或 AC 代码");
  }
  if (existing) {
    input.validationErrors = validateProblem(existing).errors;
  }
  return input;
}

setInterval(() => {
  const now = Date.now();
  const finished = [...jobs.values()]
    .filter((j) => j.finishedAt && now - j.finishedAt > 3600_000)
    .sort((a, b) => a.finishedAt - b.finishedAt);
  for (const j of finished) jobs.delete(j.id);
  while (jobs.size > 50) {
    const oldest = [...jobs.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!oldest) break;
    jobs.delete(oldest.id);
  }
}, 600_000).unref();

/* ============================================================
   HTTP 工具
   ============================================================ */

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  res.end(text);
}

function fail(res, status, message, details) {
  json(res, status, { ok: false, error: message, details: details ?? null });
}

async function readJsonBody(req, limit = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      req.destroy();
      throw new HttpError(413, `请求体超过 ${Math.round(limit / 1024 / 1024)} MB`);
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new HttpError(400, "请求体不是合法 JSON：" + e.message);
  }
}

function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return u.host === req.headers.host && (u.protocol === "http:" || u.protocol === "https:");
  } catch {
    return false;
  }
}

/* ============================================================
   API
   ============================================================ */

async function handleApi(req, res, url) {
  const p = url.pathname;
  const method = req.method || "GET";

  if (method !== "GET" && method !== "HEAD" && !checkOrigin(req)) {
    return fail(res, 403, "拒绝跨站请求");
  }

  if (p === "/api/health" && method === "GET") {
    return json(res, 200, { ok: true, at: nowIso(), port: PORT });
  }

  if (p === "/api/problems" && method === "GET") {
    return json(res, 200, { ok: true, ...listProblems() });
  }

  if (p === "/api/problems" && method === "POST") {
    const body = await readJsonBody(req);
    const result = await createProblem(body);
    return json(res, 201, { ok: true, ...result });
  }

  const problemMatch = p.match(/^\/api\/problems\/([A-Za-z0-9]+)$/);
  if (problemMatch) {
    const id = problemMatch[1];
    if (method === "GET") {
      const problem = readProblem(id);
      const v = validateProblem(problem);
      return json(res, 200, { ok: true, problem, errors: v.errors, warnings: v.warnings });
    }
    if (method === "PUT") {
      const body = await readJsonBody(req);
      const problem = body?.problem ?? body;
      const result = await saveProblem(id, problem);
      return json(res, 200, { ok: true, ...result });
    }
    if (method === "DELETE") {
      const result = await deleteProblem(id);
      return json(res, 200, { ok: true, ...result });
    }
    throw new HttpError(405, "不支持的方法");
  }

  if (p === "/api/validate" && method === "POST") {
    const body = await readJsonBody(req);
    const problem = body?.problem ?? body;
    const v = validateProblem(problem);
    return json(res, 200, { ok: v.errors.length === 0, errors: v.errors, warnings: v.warnings });
  }

  if (p === "/api/build" && method === "POST") {
    const build = buildAll();
    return json(res, build.ok ? 200 : 400, {
      ok: build.ok,
      count: build.count,
      size: build.size,
      errors: build.errors,
      warnings: build.warnings,
    });
  }

  if (p === "/api/ai-rules" && method === "GET") {
    const useDefault = url.searchParams.get("default") === "1";
    const text = useDefault ? readRulesDefault() : readRules();
    const isDefault = text === readRulesDefault();
    return json(res, 200, { ok: true, text, isDefault });
  }

  if (p === "/api/ai-rules" && method === "PUT") {
    const body = await readJsonBody(req);
    const text = typeof body?.text === "string" ? body.text : "";
    if (text.trim().length < 50) throw new HttpError(400, "规范太短，至少 50 个字符");
    if (text.length > 400_000) throw new HttpError(413, "规范超过 400 KB");
    fs.mkdirSync(ADMIN_DIR, { recursive: true });
    await writeAtomic(RULES_FILE, text);
    return json(res, 200, { ok: true, chars: text.length, savedAt: nowIso() });
  }

  if (p === "/api/settings" && method === "GET") {
    const settings = readSettings();
    return json(res, 200, {
      ok: true,
      settings,
      tokenConfigured: Boolean(readToken()),
      tokenSource: trimStr(process.env.LLM_GATEWAY_TOKEN)
        ? "env"
        : fs.existsSync(TOKEN_FILE)
          ? "file"
          : null,
      defaults: DEFAULT_SETTINGS,
    });
  }

  if (p === "/api/settings" && method === "PUT") {
    const body = await readJsonBody(req);
    const settings = saveSettings(body?.settings ?? body);
    return json(res, 200, { ok: true, settings });
  }

  if (p === "/api/gateway/status" && method === "GET") {
    const settings = readSettings();
    const st = await gatewayStatus(settings.baseUrl, readToken(), 6000);
    return json(res, 200, { ok: true, baseUrl: settings.baseUrl, tokenConfigured: Boolean(readToken()), ...st });
  }

  if (p === "/api/ai/jobs" && method === "POST") {
    const body = await readJsonBody(req);
    const input = validateJobInput(body);
    const job = createJob(input);
    return json(res, 202, { ok: true, job: serializeJob(job) });
  }

  const jobCancel = p.match(/^\/api\/ai\/jobs\/([0-9a-fA-F-]+)\/cancel$/);
  if (jobCancel && method === "POST") {
    return json(res, 200, { ok: true, ...cancelJob(jobCancel[1]) });
  }

  const jobMatch = p.match(/^\/api\/ai\/jobs\/([0-9a-fA-F-]+)$/);
  if (jobMatch && method === "GET") {
    const job = jobs.get(jobMatch[1]);
    if (!job) throw new HttpError(404, "任务不存在");
    return json(res, 200, { ok: true, job: serializeJob(job) });
  }

  throw new HttpError(404, "接口不存在");
}

/* ============================================================
   静态文件
   ============================================================ */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

function resolveStatic(pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (rel === "/") rel = "/index.html";
  if (rel.endsWith("/")) rel += "index.html";

  const allowed =
    rel === "/index.html" ||
    rel === "/problem.html" ||
    rel.startsWith("/assets/") ||
    rel.startsWith("/problems/") ||
    rel.startsWith("/admin/");
  if (!allowed) return null;

  // 运行期文件不通过静态服务暴露（只走 API）
  if (
    rel.startsWith("/admin/") &&
    (rel.endsWith("/settings.json") ||
      rel.endsWith("/ai-rules.md") ||
      rel.endsWith("/ai-rules.default.md") ||
      rel.endsWith("/gateway-token.txt"))
  ) {
    return null;
  }
  if (rel.includes("/../") || rel.includes("\\")) return null;

  const abs = path.resolve(ROOT, "." + rel);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return null;
  return abs;
}

async function serveStatic(req, res, url) {
  if (url.pathname === "/admin") {
    res.writeHead(301, { Location: "/admin/" });
    return res.end();
  }
  const abs = resolveStatic(url.pathname);
  if (!abs) return fail(res, 404, "页面不存在");

  let st;
  try {
    st = await fsp.stat(abs);
  } catch {
    return fail(res, 404, "页面不存在");
  }
  if (st.isDirectory()) {
    return serveStatic(req, res, new URL(url.pathname.replace(/\/?$/, "/index.html"), "http://x"));
  }
  if (!st.isFile()) return fail(res, 404, "页面不存在");

  const type = MIME[path.extname(abs).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": st.size,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(abs)
    .on("error", () => {
      try {
        res.destroy();
      } catch {
        /* ignore */
      }
    })
    .pipe(res);
}

/* ============================================================
   服务器
   ============================================================ */

function isLoopbackHost(hostHeader) {
  let hostname;
  try {
    hostname = new URL("http://" + (hostHeader || "")).hostname;
  } catch {
    return false;
  }
  return ["127.0.0.1", "localhost", "[::1]", "::1"].includes(hostname);
}

async function handler(req, res) {
  try {
    // 防 DNS rebinding：只接受回环 Host
    if (!isLoopbackHost(req.headers.host)) {
      return fail(res, 403, "只允许通过 127.0.0.1 / localhost 访问");
    }

    const url = new URL(req.url || "/", `http://${req.headers.host || `127.0.0.1:${PORT}`}`);
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);

    if (req.method !== "GET" && req.method !== "HEAD") {
      return fail(res, 405, "不支持的方法");
    }
    return await serveStatic(req, res, url);
  } catch (e) {
    if (e instanceof HttpError) {
      return fail(res, e.status, e.message, e.details);
    }
    if (e instanceof GatewayError) {
      return fail(res, 502, e.message, { type: e.type });
    }
    console.error("[admin]", e);
    if (!res.headersSent) return fail(res, 500, e?.message || "服务器内部错误");
    try {
      res.destroy();
    } catch {
      /* ignore */
    }
  }
}

ensureDirs();
fs.mkdirSync(ADMIN_DIR, { recursive: true });

const server = http.createServer(handler);

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`✘ 端口 ${PORT} 已被占用。可以换端口：$env:ADMIN_PORT=8791; node tools/admin-server.mjs`);
  } else {
    console.error("✘ 后台启动失败：", e);
  }
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  const addr = server.address();
  const actual = typeof addr === "object" && addr ? addr.port : PORT;
  const settings = readSettings();
  console.log("題解后台已启动");
  console.log(`  地址：http://127.0.0.1:${actual}/admin/`);
  console.log(`  网关：${settings.baseUrl}${readToken() ? "（已配置 token）" : "（未配置 token）"}`);
  console.log("  只监听 127.0.0.1，不暴露到公网；Ctrl+C 停止。");
});

function shutdown() {
  console.log("\n正在停止后台…");
  for (const job of jobs.values()) {
    if (job.status === "running" || job.status === "queued") {
      try {
        job.controller.abort();
      } catch {
        /* ignore */
      }
    }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
