/* ============================================================
   tools/lib/schema.mjs
   题解 JSON 的校验规则。build.mjs 与后台服务共用同一份，
   避免「后台能存、构建却失败」的两套标准。
   ============================================================ */

export const SEVERITIES = ["高", "中", "低"];

const isStr = (v) => typeof v === "string" && v.trim() !== "";
const isArr = (v) => Array.isArray(v);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * 校验一道题的解析卡。
 * @param {unknown} p
 * @param {{file?: string}} [opts]
 * @returns {{errors: string[], warnings: string[]}}
 */
export function validateProblem(p, opts = {}) {
  const errors = [];
  const warnings = [];
  const prefix = opts.file ? `${opts.file} → ` : "";

  const need = (cond, field, msg) => {
    if (!cond) errors.push(prefix + field + "：" + msg);
  };
  const warn = (cond, field, msg) => {
    if (cond) warnings.push(prefix + field + "：" + msg);
  };

  if (!isObj(p)) {
    return { errors: [prefix + "根节点：必须是一个 JSON 对象"], warnings };
  }

  /* ---------- 基本信息 ---------- */
  need(isStr(p.id), "id", "必须是非空字符串，如 P17827");
  need(/^[A-Za-z]+\d+$/.test(typeof p.id === "string" ? p.id : ""), "id", "建议用「字母 + 数字」的题号，如 P17827");
  need(isStr(p.title), "title", "题目名不能为空");
  need(isStr(p.oneLiner), "oneLiner", "一句话结论不能为空");
  need(isStr(p.code), "code", "代码不能为空");
  need(isStr(p.codeNote), "codeNote", "代码说明不能为空（写清怎么交、注意什么）");

  if (isStr(p.code)) {
    const lines = p.code.split("\n").length;
    warn(lines > 60, "code", `代码 ${lines} 行，题解代码建议控制在 60 行以内`);
    warn(/freopen\s*\(/.test(p.code) && /["']r["']|"r"/.test(p.code), "code", "代码里出现了 freopen，题解应放提交版（标准输入输出）");
    warn(!/^#include\s*<bits\/stdc\+\+\.h>/.test(p.code.trim()), "code", "建议只使用 #include<bits/stdc++.h>");
  }

  /* ---------- 题意 ---------- */
  need(isArr(p.summary) && p.summary.length >= 1, "summary", "至少 1 段题意");
  need(isArr(p.summary) && p.summary.length <= 8, "summary", "题意别超过 8 段，长了就拆到 keyPoints");
  (isArr(p.summary) ? p.summary : []).forEach((s, i) => need(isStr(s), `summary[${i}]`, "必须是非空字符串"));

  /* ---------- 示意图（可选） ---------- */
  if (p.figure !== undefined) {
    need(isObj(p.figure), "figure", "必须是对象，如 { lines: [...], note: '' }");
    if (isObj(p.figure)) {
      need(isArr(p.figure.lines) && p.figure.lines.length >= 1, "figure.lines", "至少 1 行");
      (isArr(p.figure.lines) ? p.figure.lines : []).forEach((s, i) => need(isStr(s), `figure.lines[${i}]`, "必须是非空字符串"));
      if (p.figure.note !== undefined) need(typeof p.figure.note === "string", "figure.note", "必须是字符串");
      warn(isArr(p.figure.lines) && p.figure.lines.length > 16, "figure.lines", "示意图行数偏多，建议不超过 16 行");
    }
  }

  /* ---------- 知识点 ---------- */
  need(isArr(p.knowledge) && p.knowledge.length >= 1, "knowledge", "至少 1 个知识点标签");
  need(isArr(p.knowledge) && p.knowledge.length <= 4, "knowledge", "知识点最多 4 个（多了就不是标签了）");
  (isArr(p.knowledge) ? p.knowledge : []).forEach((k, i) => {
    need(isStr(k), `knowledge[${i}]`, "必须是非空字符串");
    warn(isStr(k) && k.length > 12, `knowledge[${i}]`, `标签“${k}”偏长，标签应短`);
  });

  /* ---------- 关键结论 ---------- */
  need(isObj(p.keyPoints) && isStr(p.keyPoints.title), "keyPoints.title", "缺少小标题，如「四个判断」");
  need(isObj(p.keyPoints) && isArr(p.keyPoints.items) && p.keyPoints.items.length >= 1, "keyPoints.items", "至少 1 条");
  const kpItems = isObj(p.keyPoints) && isArr(p.keyPoints.items) ? p.keyPoints.items : [];
  warn(kpItems.length > 5, "keyPoints.items", `有 ${kpItems.length} 条，通常 2~5 条就够`);
  kpItems.forEach((it, i) => {
    need(isObj(it), `keyPoints.items[${i}]`, "必须是对象");
    if (!isObj(it)) return;
    need(isStr(it.name), `keyPoints.items[${i}].name`, "缺少名称");
    need(isStr(it.note), `keyPoints.items[${i}].note`, "缺少说明");
    if (it.code !== undefined) need(typeof it.code === "string", `keyPoints.items[${i}].code`, "必须是字符串，没有就写空字符串");
  });

  /* ---------- 部分分（可选） ---------- */
  if (p.partial !== undefined && p.partial !== null) {
    need(isObj(p.partial), "partial", "必须是对象");
    if (isObj(p.partial)) {
      const st = p.partial.subtasks;
      need(isArr(st) && st.length >= 1, "partial.subtasks", "至少 1 条");
      let sum = 0;
      (isArr(st) ? st : []).forEach((t, i) => {
        need(isObj(t), `partial.subtasks[${i}]`, "必须是对象");
        if (!isObj(t)) return;
        need(isStr(t.range), `partial.subtasks[${i}].range`, "缺少测试点范围");
        need(Number.isFinite(t.pts), `partial.subtasks[${i}].pts`, "分值必须是数字");
        need(isStr(t.how), `partial.subtasks[${i}].how`, "缺少「最省力的写法」");
        need(isArr(t.props), `partial.subtasks[${i}].props`, "props 必须是数组，没有特殊性质就写 []");
        if (t.branch !== undefined) need(typeof t.branch === "boolean", `partial.subtasks[${i}].branch`, "必须是布尔值");
        sum += Number(t.pts) || 0;
      });
      if (isArr(st) && st.length) warn(sum !== 100, "partial.subtasks", `分值和为 ${sum}，通常应为 100`);
      if (p.partial.note !== undefined) need(typeof p.partial.note === "string", "partial.note", "必须是字符串");
      if (p.partial.warning !== undefined) need(typeof p.partial.warning === "string", "partial.warning", "必须是字符串");
    }
  }

  /* ---------- 正解 ---------- */
  const s = isObj(p.solution) ? p.solution : {};
  need(isObj(p.solution), "solution", "必须是对象");
  need(isArr(s.steps) && s.steps.length >= 1, "solution.steps", "至少 1 步");
  (isArr(s.steps) ? s.steps : []).forEach((x, i) => need(isStr(x), `solution.steps[${i}]`, "必须是非空字符串"));
  if (s.beginner !== undefined && s.beginner !== null) {
    need(isObj(s.beginner), "solution.beginner", "必须是对象");
    if (isObj(s.beginner)) {
      need(isArr(s.beginner.steps) && s.beginner.steps.length >= 1, "solution.beginner.steps", "白话版至少 1 步");
      need(isStr(s.beginner.title), "solution.beginner.title", "白话版缺少标题");
      (isArr(s.beginner.steps) ? s.beginner.steps : []).forEach((x, i) =>
        need(isStr(x), `solution.beginner.steps[${i}]`, "必须是非空字符串")
      );
      if (s.beginner.punch !== undefined) need(typeof s.beginner.punch === "string", "solution.beginner.punch", "必须是字符串");
    }
  }
  if (s.correctness !== undefined) need(typeof s.correctness === "string", "solution.correctness", "必须是字符串");
  if (s.complexity !== undefined) need(typeof s.complexity === "string", "solution.complexity", "必须是字符串");

  /* ---------- 易错点 ---------- */
  need(isArr(p.pitfalls) && p.pitfalls.length >= 1, "pitfalls", "至少 1 条易错点");
  const pits = isArr(p.pitfalls) ? p.pitfalls : [];
  warn(pits.length > 6, "pitfalls", `有 ${pits.length} 条，通常 3~6 条就够`);
  pits.forEach((x, i) => {
    need(isObj(x), `pitfalls[${i}]`, "必须是对象");
    if (!isObj(x)) return;
    need(isStr(x.title), `pitfalls[${i}].title`, "缺少标题");
    need(SEVERITIES.includes(x.severity), `pitfalls[${i}].severity`, "只能是 高 / 中 / 低");
    need(isStr(x.desc), `pitfalls[${i}].desc`, "缺少说明");
  });

  /* ---------- 题面 ---------- */
  need(isArr(p.statement) && p.statement.length >= 1, "statement", "至少 1 段题面原文");
  (isArr(p.statement) ? p.statement : []).forEach((x, i) => need(isStr(x), `statement[${i}]`, "必须是非空字符串"));

  /* ---------- 测试用例（可选） ---------- */
  if (p.tests !== undefined) {
    need(isArr(p.tests), "tests", "必须是数组");
    (isArr(p.tests) ? p.tests : []).forEach((t, i) => {
      need(isObj(t), `tests[${i}]`, "必须是对象");
      if (!isObj(t)) return;
      need(isStr(t.input), `tests[${i}].input`, "缺少输入");
      need(isStr(t.expect), `tests[${i}].expect`, "缺少期望输出");
      if (t.name !== undefined) need(typeof t.name === "string", `tests[${i}].name`, "必须是字符串");
      if (t.why !== undefined) need(typeof t.why === "string", `tests[${i}].why`, "必须是字符串");
    });
  }

  return { errors, warnings };
}
