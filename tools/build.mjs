/* ============================================================
   tools/build.mjs
   1. 读取 problems/*.json
   2. 按 schema 校验（错在哪一行、哪个字段，直接说清楚）
   3. 生成 assets/data.js（打包给浏览器用）

   也可以被后台服务 import：buildAll() 不退出进程，返回结果对象。
   ============================================================ */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateProblem } from "./lib/schema.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const DIR = path.join(ROOT, "problems");
const OUT = path.join(ROOT, "assets", "data.js");

function sortProblems(a, b) {
  const na = parseInt((a.id || "").replace(/\D/g, ""), 10) || 0;
  const nb = parseInt((b.id || "").replace(/\D/g, ""), 10) || 0;
  return na - nb || (a.id || "").localeCompare(b.id || "");
}

/**
 * 全量校验并打包。
 * @param {{write?: boolean}} [opts] write=false 时只校验，不写 data.js
 * @returns {{ok: boolean, count: number, problems: object[], errors: string[], warnings: string[], size?: number}}
 */
export function buildAll(opts = {}) {
  const write = opts.write !== false;
  const errors = [];
  const warnings = [];

  if (!fs.existsSync(DIR)) {
    return { ok: false, count: 0, problems: [], errors: ["找不到 problems/ 目录"], warnings };
  }

  const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".json"));
  if (!files.length) {
    return { ok: false, count: 0, problems: [], errors: ["problems/ 里没有 JSON"], warnings };
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
    const { errors: errs, warnings: warns } = validateProblem(data, { file });
    errors.push(...errs);
    warnings.push(...warns);
    problems.push(data);
  }

  /* ---------- 查重 ---------- */
  const seen = new Map();
  for (const p of problems) {
    if (!p || !p.id) continue;
    if (seen.has(p.id)) errors.push(`id 重复：${p.id}（${seen.get(p.id)} 与 ${p.id}.json）`);
    seen.set(p.id, p.id + ".json");
  }

  if (errors.length) {
    return { ok: false, count: problems.length, problems: [], errors, warnings };
  }

  problems.sort(sortProblems);

  const banner =
    "/* 自动生成，请勿手改。\n" +
    "   源文件：problems/*.json\n" +
    "   重新生成：node tools/build.mjs */\n";
  const text = banner + "window.__PROBLEMS__ = " + JSON.stringify(problems) + ";\n";

  if (write) fs.writeFileSync(OUT, text, "utf8");

  return {
    ok: true,
    count: problems.length,
    problems,
    errors,
    warnings,
    size: Buffer.byteLength(text, "utf8"),
  };
}

function cli() {
  const r = buildAll();
  if (!r.ok) {
    console.error(`\n✘ ${r.errors.length} 个问题：`);
    for (const e of r.errors) console.error("  " + e);
    process.exit(1);
  }
  const kb = (r.size / 1024).toFixed(1);
  console.log(`✔ ${r.count} 道题 → assets/data.js（${kb} KB）`);
  for (const p of r.problems) {
    console.log(`  ${String(p.id).padEnd(8)} ${String(p.title).padEnd(16)} ${(p.knowledge || []).join(" / ")}`);
  }
  if (r.warnings.length) {
    console.log(`\n⚠ ${r.warnings.length} 条提醒：`);
    for (const w of r.warnings) console.log("  " + w);
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) cli();
