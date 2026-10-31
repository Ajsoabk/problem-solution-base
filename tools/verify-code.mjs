/* ============================================================
   tools/verify-code.mjs
   编译某道题的 C++ 代码，跑一遍 tests，确认题解里的代码真的能过。
   用法：node tools/verify-code.mjs P17827
        node tools/verify-code.mjs --all
   依赖：g++ 在 PATH 里（没有就跳过编译，只报告）
   ============================================================ */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const DIR = path.join(ROOT, "problems");
const TMP = path.join(ROOT, "tools", ".tmp");

const args = process.argv.slice(2);
const all = args.includes("--all");
const ids = args.filter((a) => !a.startsWith("--"));

if (!all && !ids.length) {
  console.log("用法：node tools/verify-code.mjs <题号> [题号...] | --all");
  process.exit(1);
}

const gpp = spawnSync("g++", ["--version"], { encoding: "utf8" });
if (gpp.error) {
  console.error("✘ 找不到 g++，无法编译校验（可跳过这一步，但请保证代码已在本机编译过）");
  process.exit(1);
}

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const files = all
  ? fs.readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => path.join(DIR, f))
  : ids.map((id) => path.join(DIR, id + ".json"));

let failed = 0;

for (const file of files) {
  if (!fs.existsSync(file)) {
    console.error(`✘ 找不到 ${file}`);
    failed++;
    continue;
  }
  const p = JSON.parse(fs.readFileSync(file, "utf8"));
  const tests = p.tests || [];
  if (!tests.length) {
    console.log(`- ${p.id}：没有 tests，跳过`);
    continue;
  }

  const cpp = path.join(TMP, p.id + ".cpp");
  const exe = path.join(TMP, p.id + (process.platform === "win32" ? ".exe" : ""));
  fs.writeFileSync(cpp, p.code, "utf8");

  const build = spawnSync("g++", ["-O2", "-std=c++17", "-o", exe, cpp], { encoding: "utf8" });
  if (build.status !== 0) {
    console.error(`✘ ${p.id} 编译失败：\n${(build.stderr || "").split("\n").slice(0, 6).join("\n")}`);
    failed++;
    continue;
  }

  let bad = 0;
  for (const t of tests) {
    const run = spawnSync(exe, [], { input: t.input + "\n", encoding: "utf8", timeout: 5000 });
    const got = (run.stdout || "").trim();
    if (got !== String(t.expect).trim()) {
      bad++;
      console.error(`  ✘ ${p.id} ${t.name || t.input}: 期望 ${t.expect}，实际 ${got || "(空)"}`);
    }
  }
  if (bad) {
    console.error(`✘ ${p.id}：${bad}/${tests.length} 个用例失败`);
    failed++;
  } else {
    console.log(`✔ ${p.id}：${tests.length}/${tests.length} 个用例通过`);
  }
}

fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
