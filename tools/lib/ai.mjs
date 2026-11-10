/* ============================================================
   tools/lib/ai.mjs
   把「题面 + AC 代码」变成一张可渲染的题解解析卡。

   流程：查状态 → 组装提示 → 调网关 → 抽 JSON → 归一化 → 校验
        → 不合格就带着错误让模型修复（最多 2 轮）
   所有错误按网关约定分类重试，免费池按串行使用。
   ============================================================ */
import {
  GatewayError,
  gatewayComplete,
  gatewayStatus,
  sleep,
} from "./gateway.mjs";
import { validateProblem } from "./schema.mjs";

const MAX_REPAIRS = 2;
const MAX_INPUT_CHARS = 32000;

/* ---------------- 文本工具 ---------------- */

const clip = (s, n = MAX_INPUT_CHARS) => {
  const t = String(s || "");
  return t.length > n ? t.slice(0, n) + `\n…（已截断，原长 ${t.length} 字符）` : t;
};

function fmtDuration(ms) {
  const s = Math.max(0, Math.round(Number(ms) / 1000));
  if (s < 60) return `${s} 秒`;
  return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new GatewayError("cancelled", "任务已取消");
}

/** 从模型输出里取出一个 JSON 对象；允许被 ``` 围栏或解释文字包住。 */
export function extractJson(text) {
  let s = String(text || "").replace(/^\uFEFF/, "").trim();
  if (!s) return { ok: false, error: "输出为空" };

  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) s = fence[1].trim();

  const start = s.indexOf("{");
  if (start < 0) return { ok: false, error: "没有找到 JSON 对象" };

  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return { ok: false, error: "JSON 大括号不配对，可能被截断" };

  const raw = s.slice(start, end + 1);
  try {
    return { ok: true, value: JSON.parse(raw), raw };
  } catch (e) {
    // 常见小毛病：尾逗号。做一次「字符串外」的清理后再试。
    try {
      const cleaned = stripTrailingCommas(raw);
      return { ok: true, value: JSON.parse(cleaned), raw: cleaned };
    } catch {
      return { ok: false, error: e.message, raw };
    }
  }
}

function parseOutput(text) {
  const r = extractJson(text);
  if (r.ok && (!r.value || typeof r.value !== "object" || Array.isArray(r.value))) {
    return { ok: false, error: "顶层必须是 JSON 对象，不能是数组或标量", raw: r.raw };
  }
  return r;
}

function stripTrailingCommas(src) {
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src[j] === "}" || src[j] === "]") continue;
    }
    out += ch;
  }
  return out;
}

/* ---------------- 归一化：修掉模型常见的小偏差 ---------------- */

function asStringArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    return v.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  }
  return v;
}

const text = (v) => (typeof v === "string" ? v.trim() : "");

/** 取第一小句，用于给缺标题的条目兜底。 */
function firstClause(s, max) {
  const t = text(s).replace(/\s+/g, " ");
  if (!t) return "";
  const cut = t.split(/[。；;！!？?\n，,]/)[0].trim() || t;
  return cut.length > max ? cut.slice(0, max) : cut;
}

function asNumber(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return v;
}

const SEV_MAP = { high: "高", medium: "中", mid: "中", low: "低", 高: "高", 中: "中", 低: "低" };

/**
 * 把模型产出的对象收拾成 schema 期望的形状。
 * 只做类型层面的修补，不改写内容事实。
 */
export function normalizeProblem(raw, input = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new GatewayError("invalid_json", "模型输出的顶层不是 JSON 对象");
  }
  const p = raw;

  if (input.id) p.id = input.id;
  for (const k of ["title", "contest", "suffix", "url", "limits"]) {
    if (typeof input[k] === "string" && input[k].trim()) p[k] = input[k].trim();
  }
  if (!p.fetchedAt) {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    p.fetchedAt = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  p.summary = asStringArray(p.summary ?? p.description ?? p.problemSummary ?? p["题目大意"]);
  p.statement = asStringArray(p.statement);

  // 题面原文直接从输入回填，避免模型偷懒省略。
  if (!Array.isArray(p.statement) || !p.statement.length) {
    const src =
      (typeof input.statement === "string" && input.statement.trim()) ||
      (Array.isArray(input.existing?.statement) ? input.existing.statement.join("\n\n") : "");
    if (src) {
      p.statement = src
        .split(/\n{2,}/)
        .map((x) => x.trim())
        .filter(Boolean);
    }
  }
  if (!Array.isArray(p.summary) || !p.summary.length) {
    const src =
      (typeof input.statement === "string" && input.statement.trim()) ||
      (Array.isArray(p.statement) ? p.statement.join("\n\n") : "");
    if (src) {
      p.summary = src
        .split(/\n{2,}/)
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, 3);
    }
  }

  if (!p.oneLiner) {
    p.oneLiner = text(p.one_liner || p.oneliner || p.conclusion || p.keyIdea || p["一句话结论"]);
  }
  if (!p.oneLiner && Array.isArray(p.summary) && p.summary.length) {
    p.oneLiner = firstClause(p.summary[0], 60);
  }

  if (typeof p.knowledge === "string") p.knowledge = p.knowledge.split(/[,，、]/);
  if (!Array.isArray(p.knowledge)) p.knowledge = p.tags || p["知识点"];
  if (typeof p.knowledge === "string") p.knowledge = p.knowledge.split(/[,，、]/);
  if (Array.isArray(p.knowledge)) p.knowledge = p.knowledge.map((x) => String(x).trim()).filter(Boolean);

  if (p.figure) {
    if (typeof p.figure.lines === "string") p.figure.lines = p.figure.lines.split(/\r?\n/);
    if (!Array.isArray(p.figure.lines) || !p.figure.lines.length) delete p.figure;
    else if (typeof p.figure.note !== "string") p.figure.note = "";
  }

  if (Array.isArray(p.keyPoints)) p.keyPoints = { title: "关键结论", items: p.keyPoints };
  if (p.keyPoints && typeof p.keyPoints === "object") {
    if (typeof p.keyPoints.title !== "string" || !p.keyPoints.title.trim()) p.keyPoints.title = "关键结论";
    if (!Array.isArray(p.keyPoints.items)) p.keyPoints.items = [];
    p.keyPoints.items = p.keyPoints.items.map((it) => {
      if (typeof it === "string") it = { note: it };
      if (!it || typeof it !== "object") return it;
      it.name = text(it.name || it.heading || it.title || it.key);
      it.note = text(it.note || it.content || it.text || it.desc || it.description || it.why);
      it.code = text(it.code || it.expr || it.formula);
      if (!it.name && it.note) it.name = firstClause(it.note, 12);
      for (const k of ["heading", "title", "key", "content", "text", "desc", "description", "why", "expr", "formula"]) {
        delete it[k];
      }
      return it;
    });
  }

  if (p.partial) {
    if (!Array.isArray(p.partial.subtasks) || !p.partial.subtasks.length) {
      delete p.partial;
    } else {
      for (const t of p.partial.subtasks) {
        if (!t || typeof t !== "object") continue;
        t.pts = asNumber(t.pts);
        if (typeof t.props === "string") t.props = t.props.split(/[,，、]/).map((x) => x.trim()).filter(Boolean);
        if (!Array.isArray(t.props)) t.props = [];
        if (t.branch === "true" || t.branch === "false") t.branch = t.branch === "true";
        else if (t.branch == null) t.branch = false;
      }
    }
  }

  if (Array.isArray(p.solution)) p.solution = { steps: p.solution };
  if (p.solution && typeof p.solution === "object") {
    let steps = p.solution.steps ?? p.solution.approach ?? p.solution["思路"];
    if (typeof steps === "string") steps = asStringArray(steps);
    if (Array.isArray(steps)) {
      steps = steps
        .map((x) =>
          typeof x === "string" ? x : text(x?.content || x?.step || x?.text || x?.desc || x?.description)
        )
        .filter(Boolean);
    }
    p.solution.steps = steps;
    p.solution.correctness = text(p.solution.correctness || p.solution.proof || p.solution["正确性"]);
    p.solution.complexity = text(p.solution.complexity || p.solution["复杂度"]);
    if (!p.solution.correctness) delete p.solution.correctness;
    if (!p.solution.complexity) delete p.solution.complexity;

    if (p.solution.beginner && typeof p.solution.beginner === "object") {
      const b = p.solution.beginner;
      if (typeof b.steps === "string") b.steps = asStringArray(b.steps);
      if (!Array.isArray(b.steps) || !b.steps.length) delete p.solution.beginner;
      else {
        b.title = text(b.title) || "白话版";
        if (!text(b.punch)) delete b.punch;
      }
    }
  }

  if (typeof p.pitfalls === "string") p.pitfalls = p.pitfalls.split(/\n+/).map((s) => ({ desc: s }));
  if (Array.isArray(p.pitfalls)) {
    p.pitfalls = p.pitfalls.map((x) => {
      if (typeof x === "string") x = { desc: x };
      if (!x || typeof x !== "object") return x;
      x.title = text(x.title || x.name || x.heading);
      x.desc = text(x.desc || x.content || x.text || x.description);
      if (!x.title && x.desc) x.title = firstClause(x.desc, 20);
      const k = String(x.severity || "").trim().toLowerCase();
      x.severity = SEV_MAP[k] || (["高", "中", "低"].includes(x.severity) ? x.severity : "中");
      for (const key of ["name", "heading", "content", "text", "description"]) delete x[key];
      return x;
    });
  }

  if (p.tests === undefined && (p.cases || p.samples)) p.tests = p.cases || p.samples;
  if (typeof p.tests === "object" && !Array.isArray(p.tests) && p.tests) {
    p.tests = p.cases || p.samples || null;
  }
  if (typeof p.tests === "string") p.tests = null;
  if (Array.isArray(p.tests)) {
    p.tests = p.tests.map((t) => {
      if (!t || typeof t !== "object") return t;
      if (Array.isArray(t.input)) t.input = t.input.join("\n");
      if (Array.isArray(t.expect)) t.expect = t.expect.join("\n");
      if (typeof t.input === "number") t.input = String(t.input);
      if (typeof t.expect === "number") t.expect = String(t.expect);
      if (t.name == null) t.name = "";
      if (t.why == null) t.why = text(t.note || t.desc);
      return t;
    });
    if (!p.tests.length) delete p.tests;
  }

  if (!text(p.codeNote)) p.codeNote = "洛谷提交用这一版：标准输入输出，不要写 freopen。";

  if (typeof p.code === "string") {
    p.code = p.code.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").replace(/\s+$/, "") + "\n";
  }
  if (typeof p.codeNote === "string") p.codeNote = p.codeNote.trim();

  for (const k of ["title", "contest", "suffix", "url", "limits", "oneLiner", "codeNote"]) {
    if (typeof p[k] === "string") p[k] = p[k].trim();
  }

  return p;
}

/* ---------------- 提示组装 ---------------- */

function renderUserPrompt(input) {
  const meta = [
    ["id", input.id],
    ["title", input.title],
    ["contest", input.contest],
    ["suffix", input.suffix],
    ["url", input.url],
    ["limits", input.limits],
  ]
    .filter(([, v]) => typeof v === "string" && v.trim())
    .map(([k, v]) => `- ${k}：${v.trim()}`)
    .join("\n");

  const parts = [];
  parts.push(
    input.mode === "repair"
      ? "【任务】下面是题目原件和一份已经写好的解析卡。请按规范修正它，返回一份完整、合法的解析卡 JSON。"
      : "【任务】根据下面的题面与 AC 代码，写一份完整、可直接发布的题解解析卡。"
  );
  if (meta) parts.push("【题目元信息】\n" + meta);
  parts.push(
    "【题面原文】\n" +
      clip(input.statement || "（未提供题面原文，请仅依据代码和额外要求推断，并在拿不准处标注「待确认」）")
  );
  parts.push(
    "【AC 代码】\n```cpp\n" + clip(input.code || "（未提供代码，请自行给出符合题意的 C++ 提交版）") + "\n```"
  );

  if (input.existing && typeof input.existing === "object") {
    parts.push(
      "【已有解析卡（" +
        (input.mode === "repair" ? "待修正" : "供参考") +
        "）】\n```json\n" +
        clip(JSON.stringify(input.existing, null, 2), 24000) +
        "\n```"
    );
  }
  if (input.validationErrors?.length) {
    parts.push("【已有解析卡的校验错误（必须逐条修复）】\n- " + input.validationErrors.join("\n- "));
  }
  if (input.extra) parts.push("【额外要求】\n" + clip(input.extra, 4000));

  parts.push(
    "【输出】只输出一个 JSON 对象。不要解释，不要 Markdown 代码围栏，不要输出 JSON 以外的任何字符。\n" +
      "键名必须逐字使用下面这套，不要用 heading/content 之类的同义词：\n" +
      '{"id","title","oneLiner","summary":[],"knowledge":[],' +
      '"keyPoints":{"title","items":[{"name","code","note"}]},' +
      '"solution":{"steps":[],"correctness","complexity","beginner":{"title","steps":[],"punch"}},' +
      '"code","codeNote","pitfalls":[{"title","severity","desc"}],' +
      '"tests":[{"name","input","expect","why"}],"statement":[]}\n' +
      "特别注意：`keyPoints.items` 的键是 name/code/note；`pitfalls` 的键是 title/severity/desc，severity 只能是 高/中/低；`oneLiner` 和 `statement` 不能省略。"
  );
  return parts.join("\n\n");
}

function repairInstruction(why, errors) {
  return [
    "你上一次的输出没有被接受。",
    "【问题】" + why,
    errors?.length ? "【必须修复的字段】\n- " + errors.join("\n- ") : "",
    "【要求】",
    "1. 重新输出**完整** JSON 对象（不是补丁、不是片段）。",
    "2. 保留上次已经正确的内容，只修正错误字段。",
    "3. 不要输出 Markdown 代码围栏、解释或任何 JSON 以外的文字。",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildPayload(cfg, system, messages, state) {
  // 实测：本机网关对顶层 system 字段支持不稳定，放进 messages 的 system 角色最可靠。
  const body = {
    messages: [{ role: "system", content: system }, ...messages],
    max_tokens: state.maxTokens,
    temperature: cfg.temperature,
  };
  if (cfg.agentId) body.agent_id = cfg.agentId;
  if (cfg.model) body.model = cfg.model;
  if (cfg.pool) body.pool = cfg.pool;
  if (state.timeoutMs) body.timeout_ms = state.timeoutMs;
  if (cfg.waitTimeoutMs) body.wait_timeout_ms = cfg.waitTimeoutMs;
  return body;
}

function bumpMaxTokens(t) {
  if (t < 16384) return 16384;
  return Math.min(Math.max(t * 2, 16384), 65536);
}

function describeStatus(st) {
  const d = st.data || {};
  const bits = [];
  if (typeof d.available === "boolean") bits.push(d.available ? "available" : "不可用");
  const q = d.queue || {};
  if (q.length != null) bits.push(`排队 ${q.length}`);
  if (q.estimated_wait_ms != null) bits.push(`预计 ${fmtDuration(q.estimated_wait_ms)}`);
  return bits.length ? bits.join("，") : "已连接";
}

/* ---------------- 主流程 ---------------- */

/**
 * @param {{cfg: object, rules: string, input: object, signal?: AbortSignal, log?: (msg: string, level?: string) => void}} args
 */
export async function generateSolution({ cfg, rules, input, signal, log }) {
  const say = (msg, level = "info") => {
    try {
      log?.(msg, level);
    } catch {
      /* 日志失败不影响生成 */
    }
  };

  if (!rules || !String(rules).trim()) {
    throw new GatewayError("bad_config", "写作规范为空，请先在「写作规范」里填写或恢复默认");
  }
  const system = String(rules).trim();

  /* 1. 发之前先看状态 */
  say(`检查网关 ${cfg.baseUrl} …`);
  let st = await gatewayStatus(cfg.baseUrl, cfg.token, 6000);
  if (!st.reachable) {
    throw new GatewayError(
      "gateway_down",
      `连不上 LLM 网关 ${cfg.baseUrl}：${st.error || "连接失败"}。请先启动网关（本后台不会直连模型厂商）。`
    );
  }
  if (st.data && st.data.available === false) {
    throw new GatewayError("unavailable", "网关当前 available=false，按约定不发送请求，请稍后再试");
  }
  say(`网关状态：${describeStatus(st)}`);

  const wait = Number(st.data?.queue?.estimated_wait_ms || 0);
  if (wait > 60000) {
    say(`队列预计等待 ${fmtDuration(wait)}，先等 30 秒再检查一次`, "warn");
    await sleep(Math.min(wait, 30000), signal);
    st = await gatewayStatus(cfg.baseUrl, cfg.token, 6000);
    if (!st.reachable) throw new GatewayError("gateway_down", `等待期间网关断开：${st.error || ""}`);
    if (st.data && st.data.available === false) {
      throw new GatewayError("unavailable", "等待后网关仍不可用，请稍后再试");
    }
    say(`重新检查：${describeStatus(st)}`);
  }

  /* 2. 组装提示 */
  const userPrompt = renderUserPrompt(input);
  const baseMessages = [{ role: "user", content: userPrompt }];
  const state = {
    maxTokens: Number(cfg.maxTokens) || 16384,
    timeoutMs: Number(cfg.timeoutMs) || 300000,
  };
  const maxAttempts = Math.min(Math.max(Number(cfg.maxAttempts) || 4, 1), 6);
  let lastError = null;

  attemptLoop: for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    throwIfAborted(signal);
    say(
      `第 ${attempt}/${maxAttempts} 次请求：max_tokens=${state.maxTokens}，timeout=${Math.round(
        state.timeoutMs / 1000
      )}s，pool=${cfg.pool || "默认"}，agent=${cfg.agentId || "自动"}`
    );

    const started = Date.now();
    let response;
    try {
      response = await gatewayComplete(
        { ...cfg, baseUrl: cfg.baseUrl },
        buildPayload(cfg, system, baseMessages, state),
        { signal, fetchTimeoutMs: state.timeoutMs + 120000 }
      );
    } catch (e) {
      if (e.type === "cancelled" || signal?.aborted) throw new GatewayError("cancelled", "任务已取消");
      lastError = e;
      say(`失败：[${e.type}] ${e.message}`, "error");

      if (["auth", "no_agent", "bad_config", "bad_request"].includes(e.type)) throw e;

      if (e.type === "empty_content") {
        const finish = e.body?.finish_reason || "未知";
        const alog = e.body?.attempt_log ? JSON.stringify(e.body.attempt_log).slice(0, 800) : "";
        say(`空内容：finish_reason=${finish}${alog ? `，attempt_log=${alog}` : ""}`, "warn");
        if (finish === "length" || finish === "reasoning" || finish === "reasoning_exhausted") {
          const next = bumpMaxTokens(state.maxTokens);
          if (next !== state.maxTokens) {
            state.maxTokens = next;
            say(`推理吃掉了 token，max_tokens 调到 ${state.maxTokens} 后重试`, "warn");
            continue;
          }
        }
        if (attempt < maxAttempts) {
          await sleep(2000, signal);
          continue;
        }
        throw e;
      }

      if (e.type === "busy") {
        if (attempt >= maxAttempts) break;
        const ms = 3000 + Math.floor(Math.random() * 2000);
        say(`闸门排队满（busy），退避 ${(ms / 1000).toFixed(1)} 秒后重试`, "warn");
        await sleep(ms, signal);
        continue;
      }

      if (e.type === "wait_timeout") {
        if (attempt >= maxAttempts) break;
        say("排队超时（wait_timeout），等 10 秒后重试", "warn");
        await sleep(10000, signal);
        continue;
      }

      if (e.type === "rate_limited") {
        if (attempt >= maxAttempts) break;
        say("上游限流（rate_limited），退避 12 秒后重试；必要时请在设置里换 agent/pool", "warn");
        await sleep(12000, signal);
        continue;
      }

      if (e.type === "timeout") {
        if (attempt >= maxAttempts) break;
        state.timeoutMs = Math.min(Math.max(Math.round(state.timeoutMs * 1.5), 120000), 900000);
        say(`请求超时，把本次 timeout_ms 调到 ${state.timeoutMs} 后重试`, "warn");
        continue;
      }

      if (e.type === "reasoning_exhausted") {
        if (attempt >= maxAttempts) break;
        const next = bumpMaxTokens(state.maxTokens);
        if (next === state.maxTokens) {
          throw new GatewayError(
            "reasoning_exhausted",
            "max_tokens 已经很大仍被推理吃光，建议换 agent 或降低推理强度"
          );
        }
        state.maxTokens = next;
        say(`reasoning_exhausted，max_tokens 调到 ${state.maxTokens} 后重试`, "warn");
        continue;
      }

      if (["network", "upstream_error", "http_error", "bad_response"].includes(e.type)) {
        if (attempt >= maxAttempts) break;
        say("网关临时异常，等 3 秒后重试", "warn");
        await sleep(3000, signal);
        continue;
      }

      throw e;
    }

    /* 3. 取 content，解析 + 校验 + 修复 */
    let content = response.content;
    let parsed = parseOutput(content);
    let problem = null;
    let validation = { errors: [], warnings: [] };

    if (parsed.ok) {
      problem = normalizeProblem(parsed.value, input);
      validation = validateProblem(problem);
    } else {
      validation = { errors: [`JSON 解析失败：${parsed.error}`], warnings: [] };
    }

    say(
      `返回 ${content.length} 字符，finish_reason=${response.finish_reason || "未知"}，` +
        `耗时 ${fmtDuration(response.duration_ms || Date.now() - started)}` +
        (response.attempts ? `，网关内部尝试 ${response.attempts} 次` : "")
    );

    if (!parsed.ok && response.finish_reason === "length") {
      const next = bumpMaxTokens(state.maxTokens);
      if (next !== state.maxTokens && attempt < maxAttempts) {
        state.maxTokens = next;
        say(`输出被截断（finish_reason=length），max_tokens 调到 ${state.maxTokens} 后重试`, "warn");
        continue attemptLoop;
      }
    }

    let repairs = 0;
    while (repairs < MAX_REPAIRS) {
      const parseFailed = !parsed.ok;
      const hasFieldErrors = parsed.ok && validation.errors.length > 0;
      if (!parseFailed && !hasFieldErrors) break;

      repairs++;
      const why = parseFailed
        ? `JSON 解析失败：${parsed.error}`
        : `字段校验未通过（${validation.errors.length} 条）`;
      say(`输出不合格（${why}），发起第 ${repairs}/${MAX_REPAIRS} 次修复…`, "warn");

      const repairMessages = [
        ...baseMessages,
        { role: "assistant", content: content },
        {
          role: "user",
          content: repairInstruction(why, parseFailed ? [] : validation.errors),
        },
      ];

      throwIfAborted(signal);
      try {
        response = await gatewayComplete(
          { ...cfg, baseUrl: cfg.baseUrl },
          buildPayload(cfg, system, repairMessages, state),
          { signal, fetchTimeoutMs: state.timeoutMs + 120000 }
        );
      } catch (e) {
        // 修复请求本身失败：交给外层重试逻辑（重新走一次完整生成）
        if (e.type === "cancelled" || signal?.aborted) throw new GatewayError("cancelled", "任务已取消");
        say(`修复请求失败：[${e.type}] ${e.message}`, "error");
        lastError = e;
        if (e.type === "auth" || e.type === "no_agent") throw e;
        if (attempt < maxAttempts) {
          await sleep(3000, signal);
          continue attemptLoop;
        }
        throw e;
      }

      content = response.content;
      parsed = parseOutput(content);
      if (parsed.ok) {
        problem = normalizeProblem(parsed.value, input);
        validation = validateProblem(problem);
      } else {
        validation = { errors: [`JSON 解析失败：${parsed.error}`], warnings: [] };
      }
    }

    if (!parsed.ok) {
      throw new GatewayError(
        "invalid_json",
        `模型输出无法解析为 JSON：${parsed.error}。原始输出已保留，可在后台查看。`,
        { body: { raw: content.slice(0, 20000), finish_reason: response.finish_reason } }
      );
    }

    if (validation.errors.length) {
      say(`修复 ${MAX_REPAIRS} 轮后仍有 ${validation.errors.length} 条校验错误，请人工检查`, "warn");
    } else {
      say("解析与校验通过 ✓");
    }

    return {
      problem,
      errors: validation.errors,
      warnings: validation.warnings,
      raw: content,
      meta: {
        agent_id: response.agent_id,
        finish_reason: response.finish_reason,
        attempts: response.attempts,
        duration_ms: response.duration_ms,
        usage: response.usage,
        attempt_log: response.attempt_log,
      },
    };
  }

  throw (
    lastError ||
    new GatewayError("failed", `生成失败：已尝试 ${maxAttempts} 次仍未得到有效结果`)
  );
}
