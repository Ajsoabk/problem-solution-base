/* ============================================================
   tools/build.mjs
   1. 读取 problems/*.json
   2. 按 schema 校验（错在哪一行、哪个字段，直接说清楚）
   3. 生成 assets/data.js（打包给浏览器用）
   ============================================================ */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DIR = path.join(ROOT, "problems");
const OUT = path.join(ROOT, "assets", "data.js");

const errors = [];
const warnings = [];

const isStr = (v) => typeof v === "string" && v.trim() !== "";
const isArr = (v) => Array.isArray(v);

function need(cond, file, field, msg) {
  if (!cond) errors.push(`${file} → ${field}：${msg}`);
}

function check(p, file) {
  need(isStr(p.id), file, "id", "必须是非空字符串，如 P17827");
  need(/^[A-Za-z]+\d+$/.test(p.id || ""), file, "id", "建议用「字母 + 数字」的题号，如 P17827");
  need(isStr(p.title), file, "title", "题目名不能为空");
  need(isStr(p.oneLiner), file, "oneLiner", "一句话结论不能为空");
  need(isStr(p.code), file, "code", "代码不能为空");
  need(isStr(p.codeNote), file, "codeNote", "代码说明不能为空（写清怎么交、注意什么）");

  need(isArr(p.summary) && p.summary.length >= 1, file, "summary", "至少 1 段题意");
  need(isArr(p.summary) && p.summary.length <= 8, file, "summary", "题意别超过 8 段，长了就拆到 keyPoints");
  (p.summary || []).forEach((s, i) => need(isStr(s), file, `summary[${i}]`, "必须是非空字符串"));

  need(isArr(p.knowledge) && p.knowledge.length >= 1, file, "knowledge", "至少 1 个知识点标签");
  need(isArr(p.knowledge) && p.knowledge.length <= 4, file, "knowledge", "知识点最多 4 个（多了就不是标签了）");
  (p.knowledge || []).forEach((k, i) => {
    need(isStr(k), file, `knowledge[${i}]`, "必须是非空字符串");
    if (isStr(k) && k.length > 12) warnings.push(`${file} → knowledge[${i}]：标签“${k}”偏长，标签应短`);
  });

  need(p.keyPoints && isStr(p.keyPoints.title), file, "keyPoints.title", "缺少小标题，如「四个判断」");
  need(p.keyPoints && isArr(p.keyPoints.items) && p.keyPoints.items.length >= 1, file, "keyPoints.items", "至少 1 条");
  ((p.keyPoints && p.keyPoints.items) || []).forEach((it, i) => {
    need(isStr(it.name), file, `keyPoints.items[${i}].name`, "缺少名称");
    need(isStr(it.note), file, `keyPoints.items[${i}].note`, "缺少说明");
  });

  if (p.partial) {
    const st = p.partial.subtasks;
    need(isArr(st) && st.length >= 1, file, "partial.subtasks", "至少 1 条");
    let sum = 0;
    (st || []).forEach((t, i) => {
      need(isStr(t.range), file, `partial.subtasks[${i}].range`, "缺少测试点范围");
      need(Number.isFinite(t.pts), file, `partial.subtasks[${i}].pts`, "分值必须是数字");
      need(isStr(t.how), file, `partial.subtasks[${i}].how`, "缺少「最省力的写法」");
      need(isArr(t.props), file, `partial.subtasks[${i}].props`, "props 必须是数组，没有特殊性质就写 []");
      sum += Number(t.pts) || 0;
    });
    if (st && st.length && sum !== 100) warnings.push(`${file} → partial.subtasks：分值和为 ${sum}，通常应为 100`);
  }

  const s = p.solution || {};
  need(isArr(s.steps) && s.steps.length >= 1, file, "solution.steps", "至少 1 步");
  if (s.beginner) {
    need(isArr(s.beginner.steps) && s.beginner.steps.length >= 1, file, "solution.beginner.steps", "白话版至少 1 步");
    need(isStr(s.beginner.title), file, "solution.beginner.title", "白话版缺少标题");
  }

  need(isArr(p.pitfalls) && p.pitfalls.length >= 1, file, "pitfalls", "至少 1 条易错点");
  (p.pitfalls || []).forEach((x, i) => {
    need(isStr(x.title), file, `pitfalls[${i}].title`, "缺少标题");
    need(["高", "中", "低"].includes(x.severity), file, `pitfalls[${i}].severity`, "只能是 高 / 中 / 低");
    need(isStr(x.desc), file, `pitfalls[${i}].desc`, "缺少说明");
  });

  need(isArr(p.statement) && p.statement.length >= 1, file, "statement", "至少 1 段题面原文");

  (p.tests || []).forEach((t, i) => {
    need(isStr(t.input), file, `tests[${i}].input`, "缺少输入");
    need(isStr(t.expect), file, `tests[${i}].expect`, "缺少期望输出");
  });
}

/* ---------- 读 ---------- */
if (!fs.existsSync(DIR)) {
  console.error("找不到 problems/ 目录");
  process.exit(1);
}

const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".json"));
if (!files.length) {
  console.error("problems/ 里没有 JSON");
  process.exit(1);
}

const problems = [];
for (const f of files) {
  const file = `problems/${f}`;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
  } catch (e) {
    errors.push(`${file} → JSON 解析失败：${e.message}`);
    continue;
  }
  check(data, file);
  problems.push(data);
}

/* ---------- 查重 ---------- */
const seen = new Map();
for (const p of problems) {
  if (!p.id) continue;
  if (seen.has(p.id)) errors.push(`id 重复：${p.id}（${seen.get(p.id)} 与 ${p.id}.json）`);
  seen.set(p.id, p.id + ".json");
}

/* ---------- 输出 ---------- */
if (errors.length) {
  console.error(`\n✘ ${errors.length} 个问题：`);
  for (const e of errors) console.error("  " + e);
  process.exit(1);
}

problems.sort((a, b) => {
  const na = parseInt((a.id || "").replace(/\D/g, ""), 10) || 0;
  const nb = parseInt((b.id || "").replace(/\D/g, ""), 10) || 0;
  return na - nb || (a.id || "").localeCompare(b.id || "");
});

const banner =
  "/* 自动生成，请勿手改。\n" +
  "   源文件：problems/*.json\n" +
  "   重新生成：node tools/build.mjs */\n";
fs.writeFileSync(OUT, banner + "window.__PROBLEMS__ = " + JSON.stringify(problems) + ";\n", "utf8");

console.log(`✔ ${problems.length} 道题 → assets/data.js（${(fs.statSync(OUT).size / 1024).toFixed(1)} KB）`);
for (const p of problems) {
  console.log(`  ${p.id.padEnd(8)} ${p.title.padEnd(16)} ${(p.knowledge || []).join(" / ")}`);
}
if (warnings.length) {
  console.log(`\n⚠ ${warnings.length} 条提醒：`);
  for (const w of warnings) console.log("  " + w);
}
