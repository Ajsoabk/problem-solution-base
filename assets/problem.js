/* ============================================================
   详情页：problem.html?id=P17827
   一份通用渲染器，所有内容来自 assets/data.js，不含任何题目专属逻辑。
   ============================================================ */
(function () {
  "use strict";

  const { esc, md, initTheme, toast } = window.PA;
  const LIST = window.__PROBLEMS__ || [];
  const $ = (id) => document.getElementById(id);

  const qid = new URLSearchParams(location.search).get("id");
  const index = qid ? LIST.findIndex((x) => x.id === qid) : 0;
  const p = index >= 0 ? LIST[index] : null;

  if (!p) {
    document.querySelector("main").innerHTML =
      '<div class="hero"><h1>没有这道题</h1><p class="lede">' +
      "链接里的题号 <code>" + esc(qid || "") + '</code> 在题库里找不到。<a href="index.html">回到题解集 →</a></p></div>';
    return;
  }

  /* ---------------- 顶栏 / 头部 ---------------- */
  document.title = p.id + " " + p.title + " · 题解";
  $("pid").textContent = p.id;
  $("crumb").textContent = [p.contest, p.suffix].filter(Boolean).join(" · ");
  $("title").textContent = p.title;
  if (p.url) $("srcLink").href = p.url;
  else $("srcLink").hidden = true;

  /* ---------------- 题意 ---------------- */
  $("summaryBody").innerHTML = (p.summary || []).map((s) => "<p>" + md(s) + "</p>").join("");
  if (p.figure && p.figure.lines && p.figure.lines.length) {
    $("figure").innerHTML =
      '<div class="figure"><pre>' + esc(p.figure.lines.join("\n")) + "</pre>" +
      (p.figure.note ? '<p class="fig-note">' + md(p.figure.note) + "</p>" : "") +
      "</div>";
  }

  /* ---------------- 知识点 ---------------- */
  $("tagRow").innerHTML = (p.knowledge || []).map((k) => '<span class="tag">' + esc(k) + "</span>").join("");

  /* ---------------- 关键结论 ---------------- */
  $("pointsTitle").textContent = (p.keyPoints && p.keyPoints.title) || "关键结论";
  $("pointsBody").innerHTML =
    (p.oneLiner ? '<p class="points-intro">' + md(p.oneLiner) + "</p>" : "") +
    ((p.keyPoints && p.keyPoints.items) || [])
      .map(
        (it, i) =>
          '<div class="jrow"><div class="jn">' + (i + 1) + "</div><div><b>" + esc(it.name) + "</b>" +
          (it.code ? "<code>" + esc(it.code) + "</code>" : "") +
          '<p>' + md(it.note) + "</p></div></div>"
      )
      .join("");

  /* ---------------- 部分分 ---------------- */
  if (p.partial && p.partial.subtasks && p.partial.subtasks.length) {
    const st = p.partial.subtasks;
    const total = st.reduce((a, t) => a + (Number(t.pts) || 0), 0);
    $("partial").hidden = false;
    $("partialBody").innerHTML =
      '<table><thead><tr><th>测试点</th><th>分值</th><th>性质 / 考什么</th><th>最省力的写法</th></tr></thead><tbody>' +
      st
        .map(
          (t) =>
            '<tr><td class="mono">' + esc(t.range) + '</td><td class="num">' + t.pts + "</td><td>" +
            ((t.props && t.props.length
              ? t.props.map((x) => '<span class="ptag">' + esc(x) + "</span>").join("")
              : "")) +
            '<div class="ftag" style="margin-top:3px">' + esc(t.focus || "") + "</div></td>" +
            '<td class="how">' + md(t.how) + (t.branch ? ' <span style="color:var(--dim)">// 支线</span>' : "") + "</td></tr>"
        )
        .join("") +
      "</tbody></table>" +
      '<p class="small-note">共 ' + total + " 分。" + md(p.partial.note || "") + "</p>" +
      (p.partial.warning ? '<div class="note"><b>注意：</b>' + md(p.partial.warning) + "</div>" : "");
  }

  /* ---------------- 正解 ---------------- */
  const s = p.solution || {};
  let sol = "";
  if (s.beginner) {
    sol +=
      '<div class="beginner"><div class="beginner-head"><span>白话版</span>' + esc(s.beginner.title) + "</div>" +
      "<ol>" + s.beginner.steps.map((x) => "<li>" + md(x) + "</li>").join("") + "</ol>" +
      (s.beginner.punch ? "<p>" + md(s.beginner.punch) + "</p>" : "") +
      "</div>";
  }
  sol += '<ol class="steps">' + (s.steps || []).map((x) => "<li>" + md(x) + "</li>").join("") + "</ol>";
  if (s.correctness) sol += '<p class="small-note" style="margin-top:20px"><b>为什么一定对：</b>' + md(s.correctness) + "</p>";
  if (s.complexity) sol += '<p class="small-note"><b>复杂度：</b>' + md(s.complexity) + "</p>";
  $("solutionBody").innerHTML = sol;

  /* ---------------- 代码 ---------------- */
  const CPP_RE = new RegExp(
    [
      "(\\/\\/[^\\n]*)",
      "(\\/\\*[\\s\\S]*?\\*\\/)",
      '("(?:[^"\\\\\\n]|\\\\.)*")',
      "('(?:[^'\\\\\\n]|\\\\.)*')",
      "(^[ \\t]*#[a-z]+)",
      "\\b(int|bool|char|void|const|return|if|else|for|while|using|namespace|auto|true|false|string|set|pair|vector|size_t|abs|snprintf|freopen|stoi|continue|break|struct|class|long|double|unsigned|static|inline)\\b",
      "\\b(\\d+)\\b",
    ].join("|"),
    "gm"
  );

  function hlCpp(src) {
    let out = "", last = 0, m;
    CPP_RE.lastIndex = 0;
    while ((m = CPP_RE.exec(src))) {
      out += esc(src.slice(last, m.index));
      let cls = "kw";
      if (m[1] || m[2]) cls = "com";
      else if (m[3] || m[4]) cls = "str";
      else if (m[5]) cls = "pre";
      else if (m[7]) cls = "num";
      out += '<span class="tk-' + cls + '">' + esc(m[0]) + "</span>";
      last = m.index + m[0].length;
      if (m[0].length === 0) CPP_RE.lastIndex++;
    }
    return out + esc(src.slice(last));
  }

  $("codeBody").innerHTML =
    '<div class="code-box"><div class="code-head">' +
    '<span class="fname">' + esc(p.id) + '.cpp</span><span class="lang">cpp</span>' +
    '<button class="copy" id="btnCopy">复制</button></div>' +
    "<pre><code>" + hlCpp(p.code) + "</code></pre></div>" +
    '<p class="code-note">' + md(p.codeNote) + "</p>";

  $("btnCopy").addEventListener("click", async () => {
    const btn = $("btnCopy");
    try {
      await navigator.clipboard.writeText(p.code);
    } catch (e) {
      const ta = document.createElement("textarea");
      ta.value = p.code;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    btn.textContent = "已复制";
    btn.classList.add("ok");
    toast("已复制");
    setTimeout(() => {
      btn.textContent = "复制";
      btn.classList.remove("ok");
    }, 1500);
  });

  /* ---------------- 易错点 ---------------- */
  const SEV = { 高: "high", 中: "mid", 低: "low" };
  $("pitfallBody").innerHTML = (p.pitfalls || [])
    .map((x, i) => {
      const c = SEV[x.severity] || "mid";
      return (
        '<div class="pit"><div class="idx">' + String(i + 1).padStart(2, "0") + "</div>" +
        "<div><b>" + esc(x.title) + '</b><span class="sev ' + c + '">' + esc(x.severity) + "</span>" +
        "<p>" + md(x.desc) + "</p></div></div>"
      );
    })
    .join("");

  /* ---------------- 题面 ---------------- */
  $("statementBody").innerHTML = (p.statement || []).map((x) => "<p>" + md(x) + "</p>").join("");

  /* ---------------- 翻页 ---------------- */
  const prev = LIST[index - 1];
  const next = LIST[index + 1];
  $("pager").innerHTML =
    (prev ? '<a href="problem.html?id=' + encodeURIComponent(prev.id) + '">← ' + esc(prev.id) + " " + esc(prev.title) + "</a>" : '<span class="disabled">← 已经是第一题</span>') +
    '<a class="mid" href="index.html">全部题解</a>' +
    (next ? '<a href="problem.html?id=' + encodeURIComponent(next.id) + '">' + esc(next.id) + " " + esc(next.title) + " →</a>" : '<span class="disabled">最后一题 →</span>');

  /* ---------------- 目录 ---------------- */
  const TOC = [
    ["summary", "题意"],
    ["points", (p.keyPoints && p.keyPoints.title) || "关键结论"],
    ["partial", "部分分"],
    ["solution", "正解"],
    ["code", "代码"],
    ["pitfalls", "易错点"],
    ["statement", "题面原文"],
  ].filter(([id]) => {
    const el = $(id);
    return el && !el.hidden;
  });

  const tocEl = $("toc");
  tocEl.innerHTML = TOC.map(
    ([id, label]) => '<a href="#' + id + '" data-toc="' + id + '">' + esc(label) + "</a>"
  ).join("");

  // 点「题面原文」时顺手展开折叠
  tocEl.addEventListener("click", (e) => {
    const a = e.target.closest("a[data-toc]");
    if (!a) return;
    const target = $(a.dataset.toc);
    if (target && target.tagName === "DETAILS") target.open = true;
  });

  const links = Array.from(tocEl.querySelectorAll("a"));
  const sections = links.map((a) => $(a.dataset.toc));

  let ticking = false;
  function syncToc() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      let idx = 0;
      sections.forEach((el, i) => {
        if (el && el.getBoundingClientRect().top <= 100) idx = i;
      });
      links.forEach((a, i) => a.classList.toggle("active", i === idx));
      ticking = false;
    });
  }
  window.addEventListener("scroll", syncToc, { passive: true });
  window.addEventListener("resize", syncToc);
  syncToc();

  initTheme();
})();
