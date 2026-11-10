/* ============================================================
   题解后台 · 交互
   原生 JS，无构建、无依赖。
   ============================================================ */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const state = {
    view: "list",
    problems: [],
    current: null,
    dirty: false,
    jsonMode: false,
    aiExisting: null,
    aiJobId: null,
    aiPoll: null,
    aiResult: null,
    rulesLoaded: false,
    settings: null,
    gateway: null,
    gatewayTimer: null,
  };

  const META = {
    list: ["题目管理", "编辑题解、生成内容、管理题库"],
    editor: ["编辑题解", "改动先校验，保存后自动重新打包"],
    ai: ["AI 生成", "题面 + AC 代码 → 解析卡；免费池串行执行"],
    rules: ["写作规范", "AI 生成时作为 system prompt，保存后立即生效"],
    settings: ["设置", "网关、模型与安全选项"],
  };

  /* ============================================================
     基础工具
     ============================================================ */

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const trim = (v) => String(v ?? "").trim();
  const lines = (v) => String(v ?? "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const csv = (v) => String(v ?? "").split(/[,，、]/).map((x) => x.trim()).filter(Boolean);
  const clone = (o) => JSON.parse(JSON.stringify(o));

  function fmtTime(ms) {
    if (!ms) return "—";
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function fmtClock(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  function fmtDuration(ms) {
    const s = Math.max(0, Math.round(Number(ms || 0) / 1000));
    if (s < 60) return `${s} 秒`;
    return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
  }

  function fmtBytes(n) {
    if (!n) return "—";
    if (n < 1024) return `${n} B`;
    return `${(n / 1024).toFixed(1)} KB`;
  }

  let toastTimer = null;
  function toast(msg, type = "") {
    const el = $("toast");
    el.textContent = msg;
    el.className = "toast show " + type;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.className = "toast " + type;
    }, 2600);
  }

  function setBusy(btn, busy, busyText) {
    if (!btn) return;
    if (busy) {
      btn.dataset.text = btn.textContent;
      btn.disabled = true;
      if (busyText) btn.textContent = busyText;
    } else {
      btn.disabled = false;
      if (btn.dataset.text) btn.textContent = btn.dataset.text;
    }
  }

  /* ---------------- API ---------------- */

  async function api(url, opts = {}) {
    const init = { ...opts, headers: { ...(opts.headers || {}) } };
    if (init.body !== undefined && typeof init.body !== "string") {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(init.body);
    }
    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      throw new Error("连不上后台服务：" + (e.message || e));
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* 非 JSON 响应 */
    }
    if (!res.ok) {
      const err = new Error(data?.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.details = data?.details;
      throw err;
    }
    return data;
  }

  /* ---------------- 弹窗 ---------------- */

  let modalResolve = null;

  function openModal(title, bodyHtml, okText = "确定", danger = false) {
    return new Promise((resolve) => {
      modalResolve = resolve;
      $("modalTitle").textContent = title;
      $("modalBody").innerHTML = bodyHtml;
      $("modalOk").textContent = okText;
      $("modalOk").className = "btn " + (danger ? "danger" : "primary");
      $("modal").showModal();
      setTimeout(() => {
        const first = $("modalBody").querySelector("input, textarea, select");
        if (first) first.focus();
      }, 30);
    });
  }

  function closeModal(value) {
    const resolve = modalResolve;
    modalResolve = null;
    try {
      $("modal").close();
    } catch {
      /* ignore */
    }
    if (resolve) resolve(value);
  }

  function confirmDialog(title, message, okText = "确定", danger = false) {
    return openModal(title, `<p style="margin:0">${esc(message)}</p>`, okText, danger);
  }

  /* ============================================================
     视图切换
     ============================================================ */

  async function showView(name, opts = {}) {
    if (!opts.force && state.view === "editor" && state.dirty && name !== "editor") {
      const ok = await confirmDialog("放弃未保存的改动？", "当前题解有改动，离开后会丢失。", "离开", true);
      if (!ok) return;
      state.dirty = false;
      updateDirtyHint();
    }

    state.view = name;
    $$(".view").forEach((v) => {
      v.hidden = v.id !== "view-" + name;
    });
    $$(".nav-item").forEach((b) => {
      const v = b.dataset.view;
      b.classList.toggle("active", v === name || (name === "editor" && v === "list"));
    });

    const meta = META[name] || META.list;
    $("viewTitle").textContent = meta[0];
    $("viewSub").textContent = meta[1];

    if (name === "list") await loadProblems();
    if (name === "ai") await ensureAiSelect();
    if (name === "rules" && !state.rulesLoaded) await loadRules();
    if (name === "settings") await loadSettings();
  }

  function updateDirtyHint() {
    const el = $("dirtyHint");
    if (el) el.hidden = !(state.view === "editor" && state.dirty);
  }

  function markDirty() {
    if (state.view !== "editor") return;
    if (!state.dirty) {
      state.dirty = true;
      updateDirtyHint();
    }
  }

  function clearDirty() {
    state.dirty = false;
    updateDirtyHint();
  }

  /* ============================================================
     列表
     ============================================================ */

  function setHash(value) {
    try {
      history.replaceState(null, "", location.pathname + location.search + (value ? "#" + value : ""));
    } catch {
      /* file:// 等场景忽略 */
    }
  }

  async function routeFromHash() {
    const h = decodeURIComponent(location.hash.replace(/^#\/?/, ""));
    if (!h) return;
    if (h.startsWith("editor/")) {
      await openEditor(h.slice("editor/".length));
      return;
    }
    if (["list", "ai", "rules", "settings"].includes(h)) await showView(h);
  }

  async function loadProblems() {
    try {
      const data = await api("/api/problems");
      state.problems = data.items || [];
      renderList();
      renderBuildBar(data);
      fillAiSelect();
    } catch (e) {
      toast(e.message, "error");
    }
  }

  function renderBuildBar(data) {
    const bar = $("buildBar");
    const bad = (data.items || []).filter((x) => x.errors > 0);
    if (bad.length) {
      bar.className = "build-bar error";
      bar.innerHTML =
        `<b>${bad.length} 道题有字段错误</b>：` +
        bad.map((x) => `<code>${esc(x.id)}</code>`).join("、") +
        "。点「编辑」修正后再保存。";
      bar.hidden = false;
      return;
    }
    if (data.stale) {
      bar.className = "build-bar";
      bar.innerHTML = `<b>前台数据不是最新</b>：有 JSON 改动还没打包，点「重新打包」生成 <code>assets/data.js</code>。`;
      bar.hidden = false;
      return;
    }
    bar.className = "build-bar ok";
    bar.textContent = `已打包 ${data.count} 道题 · ${fmtTime(data.dataUpdatedAt)}`;
    bar.hidden = false;
  }

  function renderList() {
    const q = trim($("listSearch").value).toLowerCase();
    const items = state.problems.filter((p) => {
      if (!q) return true;
      return [p.id, p.title, p.contest, p.suffix, ...(p.knowledge || [])]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(q);
    });

    const body = $("listBody");
    body.innerHTML = items
      .map((p) => {
        const tags = (p.knowledge || []).map((k) => `<span class="tag">${esc(k)}</span>`).join("");
        const badges = [
          p.errors > 0 ? `<span class="badge error">${p.errors} 处错误</span>` : "",
          p.errors === 0 && p.warnings > 0 ? `<span class="badge warn">${p.warnings} 条提醒</span>` : "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          `<tr>` +
          `<td><span class="pid">${esc(p.id)}</span></td>` +
          `<td><span class="ptitle">${esc(p.title)}</span>` +
          `<span class="psub">${esc([p.contest, p.suffix].filter(Boolean).join(" · ") || "—")} ${badges}</span></td>` +
          `<td>${tags || '<span class="hint">—</span>'}</td>` +
          `<td class="ptime">${esc(fmtTime(p.updatedAt))}</td>` +
          `<td><div class="pactions">` +
          `<button class="linkbtn" data-act="edit" data-id="${esc(p.id)}">编辑</button>` +
          `<button class="linkbtn" data-act="ai" data-id="${esc(p.id)}">AI 生成</button>` +
          `<button class="linkbtn" data-act="preview" data-id="${esc(p.id)}">预览</button>` +
          `<button class="linkbtn danger" data-act="del" data-id="${esc(p.id)}">删除</button>` +
          `</div></td>` +
          `</tr>`
        );
      })
      .join("");

    $("listCount").textContent = `${state.problems.length} 道`;
    $("listEmpty").hidden = items.length > 0;
  }

  /* ============================================================
     编辑器：表单 <-> JSON
     ============================================================ */

  const ROW_EMPTY = '<p class="row-empty">还没有条目，点上面的「添加」。</p>';

  function kpRow(v = {}) {
    return (
      `<div class="row-item">` +
      `<button class="row-del" type="button" title="删除这一条">×</button>` +
      `<div class="row-grid">` +
      `<label class="field"><span>名称</span><input class="input" data-k="name" value="${esc(v.name)}" placeholder="同车厢"></label>` +
      `<label class="field"><span>代码 / 式子</span><input class="input mono" data-k="code" value="${esc(v.code)}" placeholder="c1 == c2"></label>` +
      `</div>` +
      `<label class="field"><span>说明 <em>为什么成立</em></span><textarea class="textarea" data-k="note" rows="2">${esc(v.note)}</textarea></label>` +
      `</div>`
    );
  }

  function subRow(v = {}) {
    return (
      `<div class="row-item">` +
      `<button class="row-del" type="button" title="删除这一档">×</button>` +
      `<div class="row-grid">` +
      `<label class="field"><span>测试点</span><input class="input mono" data-k="range" value="${esc(v.range)}" placeholder="1~4"></label>` +
      `<label class="field"><span>分值</span><input class="input mono" type="number" data-k="pts" value="${v.pts ?? 0}" min="0" step="5"></label>` +
      `<label class="field"><span>特殊性质</span><input class="input mono" data-k="props" value="${esc((v.props || []).join(","))}" placeholder="A,B"></label>` +
      `<label class="field"><span>考什么</span><input class="input" data-k="focus" value="${esc(v.focus)}" placeholder="同侧序列里是否相邻"></label>` +
      `</div>` +
      `<label class="field"><span>最省力的写法</span><textarea class="textarea" data-k="how" rows="2">${esc(v.how)}</textarea></label>` +
      `<label class="check"><input type="checkbox" data-k="branch"${v.branch ? " checked" : ""}> 支线：不能复用到满分</label>` +
      `</div>`
    );
  }

  function pitRow(v = {}) {
    return (
      `<div class="row-item">` +
      `<button class="row-del" type="button" title="删除这一条">×</button>` +
      `<div class="row-grid">` +
      `<label class="field"><span>标题</span><input class="input" data-k="title" value="${esc(v.title)}" placeholder="跨车厢的同一排被误判"></label>` +
      `<label class="field"><span>危险度</span><select class="input" data-k="severity">` +
      ["高", "中", "低"].map((s) => `<option${v.severity === s ? " selected" : ""}>${s}</option>`).join("") +
      `</select></label>` +
      `</div>` +
      `<label class="field"><span>说明 <em>什么输入会错、错成什么、怎么防</em></span><textarea class="textarea" data-k="desc" rows="2">${esc(v.desc)}</textarea></label>` +
      `</div>`
    );
  }

  function testRow(v = {}) {
    return (
      `<div class="row-item">` +
      `<button class="row-del" type="button" title="删除这一条">×</button>` +
      `<div class="row-grid">` +
      `<label class="field"><span>名称</span><input class="input" data-k="name" value="${esc(v.name)}" placeholder="样例 1"></label>` +
      `<label class="field"><span>为什么测它</span><input class="input" data-k="why" value="${esc(v.why)}" placeholder="覆盖跨过道"></label>` +
      `</div>` +
      `<div class="row-grid">` +
      `<label class="field"><span>输入</span><textarea class="textarea mono" data-k="input" rows="3">${esc(v.input)}</textarea></label>` +
      `<label class="field"><span>期望输出</span><textarea class="textarea mono" data-k="expect" rows="3">${esc(v.expect)}</textarea></label>` +
      `</div>` +
      `</div>`
    );
  }

  function renderRows(container, items, builder) {
    const el = typeof container === "string" ? $(container) : container;
    el.innerHTML = items && items.length ? items.map(builder).join("") : ROW_EMPTY;
  }

  function addRow(containerId, builder, value = {}) {
    const el = $(containerId);
    const empty = el.querySelector(".row-empty");
    if (empty) empty.remove();
    el.insertAdjacentHTML("beforeend", builder(value));
    markDirty();
  }

  function readRows(containerId) {
    return $$(".row-item", $(containerId)).map((row) => {
      const get = (k) => row.querySelector(`[data-k="${k}"]`);
      return { row, get };
    });
  }

  function val(get, k) {
    const el = get(k);
    return el ? trim(el.value) : "";
  }

  function checked(get, k) {
    const el = get(k);
    return el ? !!el.checked : false;
  }

  function fillForm(p) {
    const data = p && typeof p === "object" ? p : {};

    $("fId").value = data.id || "";
    $("fTitle").value = data.title || "";
    $("fContest").value = data.contest || "";
    $("fSuffix").value = data.suffix || "";
    $("fUrl").value = data.url || "";
    $("fFetchedAt").value = data.fetchedAt || "";
    $("fLimits").value = data.limits || "";

    $("fOneLiner").value = data.oneLiner || "";
    $("fSummary").value = (data.summary || []).join("\n");
    $("fKnowledge").value = (data.knowledge || []).join("，");

    const hasFigure = !!(data.figure && Array.isArray(data.figure.lines) && data.figure.lines.length);
    $("fFigureOn").checked = hasFigure;
    $("figureBody").hidden = !hasFigure;
    $("fFigureLines").value = hasFigure ? data.figure.lines.join("\n") : "";
    $("fFigureNote").value = (hasFigure && data.figure.note) || "";

    $("fKpTitle").value = data.keyPoints?.title || "";
    renderRows("kpRows", data.keyPoints?.items || [], kpRow);

    const hasPartial = !!(data.partial && Array.isArray(data.partial.subtasks) && data.partial.subtasks.length);
    $("fPartialOn").checked = hasPartial;
    $("partialBody").hidden = !hasPartial;
    $("fPartialNote").value = (hasPartial && data.partial.note) || "";
    $("fPartialWarning").value = (hasPartial && data.partial.warning) || "";
    renderRows("subRows", hasPartial ? data.partial.subtasks : [], subRow);

    const sol = data.solution || {};
    $("fSteps").value = (sol.steps || []).join("\n");
    const hasBeginner = !!(sol.beginner && Array.isArray(sol.beginner.steps) && sol.beginner.steps.length);
    $("fBeginnerOn").checked = hasBeginner;
    $("beginnerBody").hidden = !hasBeginner;
    $("fBeginnerTitle").value = (hasBeginner && sol.beginner.title) || "";
    $("fBeginnerSteps").value = hasBeginner ? sol.beginner.steps.join("\n") : "";
    $("fBeginnerPunch").value = (hasBeginner && sol.beginner.punch) || "";
    $("fCorrectness").value = sol.correctness || "";
    $("fComplexity").value = sol.complexity || "";

    $("fCode").value = data.code || "";
    $("fCodeNote").value = data.codeNote || "";

    renderRows("pitRows", data.pitfalls || [], pitRow);
    renderRows("testRows", data.tests || [], testRow);
    $("fStatement").value = (data.statement || []).join("\n");

    $("fId").readOnly = Boolean(state.current);
    $("editorIdLabel").textContent = state.current ? `题目 ${data.id || ""}` : "新题 / 未保存";
    $("editorErrors").hidden = true;
    $("editorOk").hidden = true;
    updateDirtyHint();
  }

  function readForm() {
    const p = {
      id: trim($("fId").value),
      title: trim($("fTitle").value),
    };
    const optional = {
      contest: trim($("fContest").value),
      suffix: trim($("fSuffix").value),
      url: trim($("fUrl").value),
      fetchedAt: trim($("fFetchedAt").value),
      limits: trim($("fLimits").value),
    };
    for (const [k, v] of Object.entries(optional)) if (v) p[k] = v;

    p.oneLiner = trim($("fOneLiner").value);
    p.summary = lines($("fSummary").value);

    if ($("fFigureOn").checked) {
      const figLines = String($("fFigureLines").value || "").replace(/\r\n?/g, "\n").replace(/\s+$/, "");
      if (figLines.trim()) {
        p.figure = { lines: figLines.split("\n") };
        const note = trim($("fFigureNote").value);
        if (note) p.figure.note = note;
      }
    }

    p.knowledge = csv($("fKnowledge").value);

    p.keyPoints = {
      title: trim($("fKpTitle").value),
      items: readRows("kpRows")
        .map(({ get }) => ({
          name: val(get, "name"),
          code: val(get, "code"),
          note: val(get, "note"),
        }))
        .filter((x) => x.name || x.code || x.note),
    };

    if ($("fPartialOn").checked) {
      const subtasks = readRows("subRows")
        .map(({ get }) => ({
          range: val(get, "range"),
          pts: Number(get("pts")?.value || 0),
          props: csv(get("props")?.value),
          focus: val(get, "focus"),
          how: val(get, "how"),
          branch: checked(get, "branch"),
        }))
        .filter((x) => x.range || x.how || x.pts);
      if (subtasks.length) {
        const partial = {};
        const note = trim($("fPartialNote").value);
        const warning = trim($("fPartialWarning").value);
        if (note) partial.note = note;
        if (warning) partial.warning = warning;
        partial.subtasks = subtasks;
        p.partial = partial;
      }
    }

    p.solution = { steps: lines($("fSteps").value) };
    if ($("fBeginnerOn").checked) {
      const steps = lines($("fBeginnerSteps").value);
      const title = trim($("fBeginnerTitle").value);
      if (steps.length || title) {
        p.solution.beginner = { title, steps };
        const punch = trim($("fBeginnerPunch").value);
        if (punch) p.solution.beginner.punch = punch;
      }
    }
    const correctness = trim($("fCorrectness").value);
    const complexity = trim($("fComplexity").value);
    if (correctness) p.solution.correctness = correctness;
    if (complexity) p.solution.complexity = complexity;

    p.code = String($("fCode").value || "").replace(/\r\n?/g, "\n").replace(/\s+$/, "");
    p.codeNote = trim($("fCodeNote").value);

    p.pitfalls = readRows("pitRows")
      .map(({ get }) => ({
        title: val(get, "title"),
        severity: val(get, "severity") || "中",
        desc: val(get, "desc"),
      }))
      .filter((x) => x.title || x.desc);

    const tests = readRows("testRows")
      .map(({ get }) => ({
        name: val(get, "name"),
        input: get("input") ? get("input").value.replace(/\r\n?/g, "\n") : "",
        expect: get("expect") ? get("expect").value.replace(/\r\n?/g, "\n") : "",
        why: val(get, "why"),
      }))
      .filter((t) => t.name || t.input || t.expect || t.why);
    if (tests.length) p.tests = tests;

    p.statement = lines($("fStatement").value);
    return p;
  }

  function setEditorMode(mode) {
    state.jsonMode = mode === "json";
    $("editorForm").hidden = state.jsonMode;
    $("jsonPane").hidden = !state.jsonMode;
    $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === mode));
  }

  function syncJsonFromForm() {
    try {
      $("jsonEditor").value = JSON.stringify(readForm(), null, 2);
    } catch (e) {
      toast(e.message, "error");
    }
  }

  function applyJsonToForm() {
    let p;
    try {
      p = JSON.parse($("jsonEditor").value);
    } catch (e) {
      toast("JSON 解析失败：" + e.message, "error");
      throw e;
    }
    if (!p || typeof p !== "object" || Array.isArray(p)) {
      toast("顶层必须是一个 JSON 对象", "error");
      throw new Error("not an object");
    }
    fillForm(p);
    setEditorMode("form");
    markDirty();
    toast("已应用到表单", "ok");
  }

  function getEditorProblem() {
    if (state.jsonMode) {
      let p;
      try {
        p = JSON.parse($("jsonEditor").value);
      } catch (e) {
        throw new Error("JSON 解析失败：" + e.message);
      }
      if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error("顶层必须是一个 JSON 对象");
      return p;
    }
    return readForm();
  }

  function showEditorErrors(messages) {
    const el = $("editorErrors");
    const list = Array.isArray(messages) ? messages : [String(messages || "未知错误")];
    el.innerHTML = `<b>有 ${list.length} 个问题需要处理：</b><ul>${list.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>`;
    el.hidden = false;
    $("editorOk").hidden = true;
    el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function showEditorOk(message, warnings = []) {
    const el = $("editorOk");
    const extra = warnings.length
      ? `<ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>`
      : "";
    el.innerHTML = `<b>${esc(message)}</b>${extra}`;
    el.hidden = false;
    $("editorErrors").hidden = true;
  }

  async function openEditor(id) {
    try {
      const data = await api("/api/problems/" + encodeURIComponent(id));
      state.current = data.problem;
      state.dirty = false;
      fillForm(data.problem);
      setEditorMode("form");
      await showView("editor", { force: true });
      setHash("editor/" + encodeURIComponent(id));
    } catch (e) {
      toast(e.message, "error");
    }
  }

  function openEditorWithProblem(p) {
    const exists = state.problems.some((x) => x.id === p.id);
    state.current = exists ? p : null;
    state.dirty = false;
    fillForm(p);
    setEditorMode("form");
    showView("editor", { force: true });
    setHash("editor/" + encodeURIComponent(p.id || ""));
    markDirty();
  }

  async function saveEditor() {
    let p;
    try {
      p = getEditorProblem();
    } catch (e) {
      showEditorErrors([e.message]);
      return false;
    }

    if (!p.id || !/^[A-Za-z]+\d+$/.test(p.id)) {
      showEditorErrors(["题号格式不合法，应为「字母 + 数字」，如 P12345"]);
      return false;
    }
    if (state.current && p.id !== state.current.id) {
      showEditorErrors(["题号不能在这里改。需要换题号时，新建一道题，再删除旧题。"]);
      return false;
    }

    setBusy($("btnSave"), true, "保存中…");
    setBusy($("btnSave2"), true, "保存中…");
    try {
      const data = await api("/api/problems/" + encodeURIComponent(p.id), { method: "PUT", body: p });
      state.current = p;
      state.dirty = false;
      $("fId").readOnly = true;
      updateDirtyHint();
      if (state.jsonMode) $("jsonEditor").value = JSON.stringify(p, null, 2);
      showEditorOk(`已保存并重新打包（${data.build?.count ?? "?"} 道题）`, data.warnings || []);
      toast("已保存并发布", "ok");
      await loadProblems();
      $("editorIdLabel").textContent = `题目 ${p.id}`;
      return true;
    } catch (e) {
      showEditorErrors(e.details?.errors || [e.message]);
      toast("保存失败", "error");
      return false;
    } finally {
      setBusy($("btnSave"), false);
      setBusy($("btnSave2"), false);
    }
  }

  async function validateEditor() {
    let p;
    try {
      p = getEditorProblem();
    } catch (e) {
      showEditorErrors([e.message]);
      return;
    }
    try {
      const data = await api("/api/validate", { method: "POST", body: p });
      if (data.ok) {
        showEditorOk("校验通过，可以保存。", data.warnings || []);
        toast("校验通过", "ok");
      } else {
        showEditorErrors(data.errors || ["校验未通过"]);
        toast("校验未通过", "error");
      }
    } catch (e) {
      showEditorErrors([e.message]);
    }
  }

  async function previewEditor() {
    if (state.dirty) {
      const ok = await confirmDialog("先保存再预览？", "预览读取的是已打包的前台数据，需要先保存。", "保存并预览");
      if (!ok) return;
      const saved = await saveEditor();
      if (!saved) return;
    }
    const id = state.current?.id || trim($("fId").value);
    if (!id) return;
    window.open("../problem.html?id=" + encodeURIComponent(id), "_blank", "noopener");
  }

  async function deleteCurrent() {
    const id = state.current?.id || trim($("fId").value);
    if (!id) return;
    const ok = await confirmDialog(
      `删除 ${id}？`,
      "文件会移动到 tools/.tmp/trash/，可以手动找回；前台会立即重新打包。",
      "删除",
      true
    );
    if (!ok) return;
    try {
      await api("/api/problems/" + encodeURIComponent(id), { method: "DELETE" });
      toast("已删除", "ok");
      state.current = null;
      clearDirty();
      setHash("list");
      await showView("list", { force: true });
    } catch (e) {
      toast(e.message, "error");
    }
  }

  /* ============================================================
     AI 生成
     ============================================================ */

  async function ensureAiSelect() {
    if (!state.problems.length) await loadProblems();
    fillAiSelect();
  }

  function fillAiSelect() {
    const sel = $("aiLoad");
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML =
      '<option value="">— 选择一道已有题目 —</option>' +
      state.problems
        .map((p) => `<option value="${esc(p.id)}">${esc(p.id)} · ${esc(p.title)}</option>`)
        .join("");
    if (cur && state.problems.some((p) => p.id === cur)) sel.value = cur;
  }

  async function loadAiProblem(id) {
    try {
      const data = await api("/api/problems/" + encodeURIComponent(id));
      const p = data.problem;
      state.aiExisting = p;
      $("aiId").value = p.id || "";
      $("aiTitle").value = p.title || "";
      $("aiContest").value = p.contest || "";
      $("aiSuffix").value = p.suffix || "";
      $("aiUrl").value = p.url || "";
      $("aiLimits").value = p.limits || "";
      $("aiStatement").value = (p.statement || []).join("\n\n");
      $("aiCode").value = p.code || "";
      $("aiMode").value = "repair";
      $("aiUseExisting").checked = true;
      $("aiId").readOnly = true;
      $("aiExistingHint").hidden = false;
      $("aiExistingHint").textContent = `已载入 ${p.id}：${p.title}。生成时会带上已有解析卡，按校验错误修复。`;
      toast("已载入题目", "ok");
    } catch (e) {
      toast(e.message, "error");
    }
  }

  function clearAiLoaded() {
    state.aiExisting = null;
    $("aiId").readOnly = false;
    $("aiUseExisting").checked = false;
    $("aiExistingHint").hidden = true;
  }

  function setAiRunning(running) {
    $("btnGenerate").disabled = running;
    $("btnCancelAi").hidden = !running;
    if (running) {
      $("btnGenerate").textContent = "生成中…";
    } else {
      $("aiQueueHint").textContent = "";
      $("btnGenerate").textContent = "开始生成";
    }
  }

  function setProgress(stateName) {
    const bar = $("aiProgressBar");
    bar.classList.toggle("indeterminate", stateName === "queued" || stateName === "running");
    if (stateName === "queued" || stateName === "running") {
      bar.style.width = "";
      bar.style.background = "";
    } else {
      bar.style.width = "100%";
      bar.style.background =
        stateName === "error" ? "var(--danger)" : stateName === "done_with_errors" ? "var(--warn)" : "var(--blue-600)";
    }
  }



  function renderJob(job) {
    const map = {
      queued: ["排队中", "badge blue"],
      running: ["生成中", "badge running"],
      done: ["完成", "badge ok"],
      done_with_errors: ["待修正", "badge warn"],
      error: ["失败", "badge error"],
      cancelled: ["已取消", "badge"],
    };
    const [label, cls] = map[job.status] || ["未知", "badge"];
    const badge = $("aiStatusBadge");
    badge.textContent = label;
    badge.className = cls;

    setProgress(job.status);
    const running = job.status === "queued" || job.status === "running";
    setAiRunning(running);
    if (job.status === "queued") {
      $("aiQueueHint").textContent = "任务在排队，免费池并发为 1。";
    } else if (job.status === "running") {
      $("aiQueueHint").textContent = "免费池串行执行中，请保持页面打开。";
    }

    const log = $("aiLog");
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    log.innerHTML = (job.log || [])
      .map((x) => {
        const level = x.level === "warn" ? "warn" : x.level === "error" ? "error" : x.level === "ok" ? "ok" : "";
        return `<span class="log-line ${level}"><span class="lt">${fmtClock(x.t)}</span>${esc(x.msg)}</span>`;
      })
      .join("") || '<span class="log-empty">等待开始…</span>';
    if (nearBottom) log.scrollTop = log.scrollHeight;

    if (job.status === "done" || job.status === "done_with_errors") {
      $("aiResult").hidden = false;
    }
  }

  function showAiResult(result) {
    if (!result || !result.problem) return;
    state.aiResult = result;

    const meta = result.meta || {};
    const usage = meta.usage || {};
    const chips = [
      `题号 ${result.problem.id}`,
      meta.finish_reason ? `finish_reason=${meta.finish_reason}` : "",
      meta.attempts ? `网关尝试 ${meta.attempts} 次` : "",
      meta.duration_ms ? `耗时 ${fmtDuration(meta.duration_ms)}` : "",
      usage.total_tokens ? `tokens ${usage.total_tokens}` : "",
    ].filter(Boolean);
    $("aiMeta").innerHTML = chips.map((c) => `<span class="meta-chip">${esc(c)}</span>`).join("");

    const errors = result.errors || [];
    const warnings = result.warnings || [];
    $("aiErrors").hidden = errors.length === 0;
    $("aiErrors").innerHTML = errors.length
      ? `<b>校验未通过（${errors.length} 条），请修正后再保存：</b><ul>${errors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>`
      : "";
    $("aiWarnings").hidden = warnings.length === 0;
    $("aiWarnings").innerHTML = warnings.length
      ? `<b>提醒（${warnings.length} 条）</b><ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>`
      : "";
    $("aiResult").hidden = false;
  }

  async function pollJob() {
    if (!state.aiJobId) return;
    try {
      const data = await api("/api/ai/jobs/" + state.aiJobId);
      const job = data.job;
      renderJob(job);
      if (["done", "done_with_errors", "error", "cancelled"].includes(job.status)) {
        stopPolling();
        setAiRunning(false);
        if (job.result) showAiResult(job.result);
        if (job.status === "done") toast("生成完成", "ok");
        else if (job.status === "done_with_errors") toast("生成完成，但有字段需要修正", "");
        else if (job.status === "error") toast(job.error?.message || "生成失败", "error");
      }
    } catch (e) {
      stopPolling();
      setAiRunning(false);
      toast(e.message, "error");
    }
  }

  function startPolling() {
    stopPolling();
    pollJob();
    state.aiPoll = setInterval(pollJob, 1600);
  }

  function stopPolling() {
    if (state.aiPoll) {
      clearInterval(state.aiPoll);
      state.aiPoll = null;
    }
  }

  async function startAiJob() {
    const id = trim($("aiId").value);
    if (!id) {
      toast("先填题号", "error");
      return;
    }
    const statement = trim($("aiStatement").value);
    const code = trim($("aiCode").value);
    const mode = $("aiMode").value;
    const existing = $("aiUseExisting").checked ? state.aiExisting : null;

    if (!statement && !code && !existing) {
      toast("至少提供题面或 AC 代码", "error");
      return;
    }
    if (mode === "repair" && !existing) {
      toast("修复模式需要先从题库载入一道题", "error");
      return;
    }

    $("btnGenerate").disabled = true;
    $("btnGenerate").textContent = "提交中…";
    stopPolling();
    state.aiJobId = null;
    try {
      const data = await api("/api/ai/jobs", {
        method: "POST",
        body: {
          mode,
          id,
          title: trim($("aiTitle").value),
          contest: trim($("aiContest").value),
          suffix: trim($("aiSuffix").value),
          url: trim($("aiUrl").value),
          limits: trim($("aiLimits").value),
          statement,
          code,
          existing,
          extra: trim($("aiExtra").value),
        },
      });
      state.aiJobId = data.job.id;
      state.aiResult = null;
      $("aiResult").hidden = true;
      $("aiErrors").hidden = true;
      $("aiWarnings").hidden = true;
      $("aiLog").innerHTML = '<span class="log-empty">任务已提交，等待日志…</span>';
      setAiRunning(true);
      renderJob(data.job);
      startPolling();
    } catch (e) {
      toast(e.message, "error");
    } finally {
      if (!state.aiJobId) {
        $("btnGenerate").disabled = false;
        $("btnGenerate").textContent = "开始生成";
      }
    }
  }

  async function cancelAiJob() {
    if (!state.aiJobId) return;
    try {
      await api("/api/ai/jobs/" + state.aiJobId + "/cancel", { method: "POST" });
      toast("已请求取消", "");
    } catch (e) {
      toast(e.message, "error");
    }
  }

  async function useAiResult(andSave) {
    const p = state.aiResult?.problem;
    if (!p) return;
    if (andSave) {
      const errors = state.aiResult.errors || [];
      if (errors.length) {
        const ok = await confirmDialog(
          "结果还有字段错误",
          `直接保存会被字段校验拦下（${errors.length} 条错误）。仍然填入编辑器吗？`,
          "填入编辑器"
        );
        if (!ok) return;
      }
    }
    openEditorWithProblem(clone(p));
    toast("已填入编辑器，请检查后保存", "ok");
    if (andSave) await saveEditor();
  }

  /* ============================================================
     写作规范
     ============================================================ */

  async function loadRules() {
    try {
      const data = await api("/api/ai-rules");
      $("rulesText").value = data.text || "";
      state.rulesLoaded = true;
      updateRulesMeta();
    } catch (e) {
      toast(e.message, "error");
    }
  }

  function updateRulesMeta() {
    const len = $("rulesText").value.length;
    $("rulesCount").textContent = `${len} 字符`;
  }

  async function saveRules() {
    const text = $("rulesText").value;
    if (text.trim().length < 50) {
      toast("规范太短，至少 50 个字符", "error");
      return;
    }
    setBusy($("btnRulesSave"), true, "保存中…");
    try {
      const data = await api("/api/ai-rules", { method: "PUT", body: { text } });
      $("rulesSaved").textContent = `已保存 ${data.chars} 字符`;
      toast("规范已保存，下次生成生效", "ok");
    } catch (e) {
      toast(e.message, "error");
    } finally {
      setBusy($("btnRulesSave"), false);
    }
  }

  async function restoreRulesDefault() {
    const ok = await confirmDialog(
      "恢复默认规范？",
      "会用 admin/ai-rules.default.md 覆盖已保存的规范，当前编辑内容也会被替换。",
      "恢复默认",
      true
    );
    if (!ok) return;
    try {
      const data = await api("/api/ai-rules?default=1");
      $("rulesText").value = data.text || "";
      const saved = await api("/api/ai-rules", { method: "PUT", body: { text: $("rulesText").value } });
      $("rulesSaved").textContent = `已恢复默认（${saved.chars} 字符）`;
      updateRulesMeta();
      toast("已恢复默认规范", "ok");
    } catch (e) {
      toast(e.message, "error");
    }
  }

  /* ============================================================
     设置 / 网关状态
     ============================================================ */

  async function loadSettings() {
    try {
      const data = await api("/api/settings");
      state.settings = data.settings;
      const s = data.settings;
      $("setBaseUrl").value = s.baseUrl || "";
      $("setPool").value = s.pool || "";
      $("setAgent").value = s.agentId || "";
      $("setModel").value = s.model || "";
      $("setMaxTokens").value = s.maxTokens;
      $("setTemp").value = s.temperature;
      $("setTimeout").value = s.timeoutMs;
      $("setWait").value = s.waitTimeoutMs;
      $("setAttempts").value = s.maxAttempts;

      const source =
        data.tokenSource === "env"
          ? "已配置（环境变量 LLM_GATEWAY_TOKEN）"
          : data.tokenSource === "file"
            ? "已配置（admin/gateway-token.txt）"
            : "未配置";
      $("tokenState").innerHTML =
        `<dt>状态</dt><dd>${esc(source)}</dd>` +
        `<dt>请求头</dt><dd>${data.tokenConfigured ? "Authorization: Bearer ***" : "不发送"}</dd>` +
        `<dt>读取位置</dt><dd>仅后台进程，不下发浏览器</dd>`;
    } catch (e) {
      toast(e.message, "error");
    }
  }

  async function saveSettings() {
    const body = {
      baseUrl: trim($("setBaseUrl").value),
      pool: trim($("setPool").value),
      agentId: trim($("setAgent").value),
      model: trim($("setModel").value),
      maxTokens: Number($("setMaxTokens").value),
      temperature: Number($("setTemp").value),
      timeoutMs: Number($("setTimeout").value),
      waitTimeoutMs: Number($("setWait").value),
      maxAttempts: Number($("setAttempts").value),
    };
    setBusy($("btnSetSave"), true, "保存中…");
    try {
      const data = await api("/api/settings", { method: "PUT", body: { settings: body } });
      state.settings = data.settings;
      $("settingsState").textContent = "已保存 " + fmtClock(Date.now());
      toast("设置已保存", "ok");
      await refreshGateway();
    } catch (e) {
      toast(e.message, "error");
    } finally {
      setBusy($("btnSetSave"), false);
    }
  }

  function renderGateway(st) {
    const pill = $("gwPill");
    const sideDot = $("sideDot");
    const sideText = $("sideGateway");
    let label = "网关离线";
    let cls = "off";
    const data = st?.data || {};
    const wait = Number(data.queue?.estimated_wait_ms || 0);

    if (!st?.reachable) {
      label = "网关离线";
      cls = "off";
    } else if (data.available === false) {
      label = "网关不可用";
      cls = "off";
    } else if (wait > 3000) {
      label = `网关排队 ${fmtDuration(wait)}`;
      cls = "warn";
    } else {
      label = "网关可用";
      cls = "ok";
    }

    pill.className = "pill " + cls;
    pill.innerHTML = `<span class="dot ${cls}"></span>${esc(label)}`;
    sideDot.className = "dot " + cls;
    sideText.textContent = label;
  }

  async function refreshGateway() {
    try {
      const st = await api("/api/gateway/status");
      state.gateway = st;
      renderGateway(st);
    } catch (e) {
      renderGateway({ reachable: false, error: e.message });
    }
  }

  async function testGateway() {
    setBusy($("btnGwTest"), true, "检测中…");
    try {
      const st = await api("/api/gateway/status");
      state.gateway = st;
      renderGateway(st);
      $("gwTestResult").hidden = false;
      $("gwTestResult").textContent = JSON.stringify(
        {
          reachable: st.reachable,
          ok: st.ok,
          httpStatus: st.httpStatus,
          baseUrl: st.baseUrl,
          queue: st.data?.queue,
          available: st.data?.available,
          error: st.error,
        },
        null,
        2
      );
      toast(st.reachable ? "网关可达" : "网关不可达", st.reachable ? "ok" : "error");
    } catch (e) {
      toast(e.message, "error");
    } finally {
      setBusy($("btnGwTest"), false);
    }
  }

  /* ============================================================
     事件绑定
     ============================================================ */

  function bindEvents() {
    $$(".nav-item").forEach((b) => {
      b.addEventListener("click", () => {
        setHash(b.dataset.view);
        showView(b.dataset.view);
      });
    });

    $("btnNew").addEventListener("click", async () => {
      const ok = await openModal(
        "新建题目",
        `<div class="field"><span>题号</span><input class="input mono" id="newId" placeholder="P12345"></div>` +
          `<div class="field"><span>题目名</span><input class="input" id="newTitle" placeholder="可稍后补"></div>` +
          `<p class="hint" style="margin:0">会创建一个草稿，补全后再保存才会出现在前台。</p>`,
        "创建"
      );
      if (!ok) return;
      const id = trim($("newId").value);
      const title = trim($("newTitle").value);
      if (!/^[A-Za-z]+\d+$/.test(id)) {
        toast("题号格式不合法，例如 P12345", "error");
        return;
      }
      try {
        const data = await api("/api/problems", { method: "POST", body: { id, title } });
        toast("草稿已创建", "ok");
        await loadProblems();
        await openEditor(data.problem.id);
      } catch (e) {
        toast(e.message, "error");
      }
    });

    $("listSearch").addEventListener("input", renderList);

    $("listBody").addEventListener("click", async (e) => {
      const btn = e.target.closest("button[data-act]");
      if (!btn) return;
      const id = btn.dataset.id;
      const act = btn.dataset.act;
      if (act === "edit") return openEditor(id);
      if (act === "ai") {
        await showView("ai");
        $("aiLoad").value = id;
        return loadAiProblem(id);
      }
      if (act === "preview") {
        return window.open("../problem.html?id=" + encodeURIComponent(id), "_blank", "noopener");
      }
      if (act === "del") {
        const ok = await confirmDialog(
          `删除 ${id}？`,
          "文件会移动到 tools/.tmp/trash/，可以手动找回；前台会立即重新打包。",
          "删除",
          true
        );
        if (!ok) return;
        try {
          await api("/api/problems/" + encodeURIComponent(id), { method: "DELETE" });
          toast("已删除", "ok");
          await loadProblems();
        } catch (err) {
          toast(err.message, "error");
        }
      }
    });

    $("btnBuild").addEventListener("click", async () => {
      setBusy($("btnBuild"), true, "打包中…");
      try {
        const data = await api("/api/build", { method: "POST" });
        const warnings = data.warnings || [];
        toast(`打包完成：${data.count} 道题`, "ok");
        if (warnings.length) {
          await openModal(
            "打包完成，但有提醒",
            `<ul style="margin:0;padding-left:18px">${warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>`,
            "知道了"
          );
        }
        await loadProblems();
      } catch (e) {
        const errors = e.details?.errors || [e.message];
        await openModal(
          "打包失败",
          `<ul style="margin:0;padding-left:18px">${errors.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`,
          "知道了",
          true
        );
        await loadProblems();
      } finally {
        setBusy($("btnBuild"), false);
      }
    });

    /* 编辑器 */
    $("btnBack").addEventListener("click", () => {
      setHash("list");
      showView("list");
    });
    $("btnSave").addEventListener("click", saveEditor);
    $("btnSave2").addEventListener("click", saveEditor);
    $("btnValidate").addEventListener("click", validateEditor);
    $("btnPreview").addEventListener("click", previewEditor);
    $("btnDelete").addEventListener("click", deleteCurrent);

    $$(".tab").forEach((t) => {
      t.addEventListener("click", () => {
        if (t.dataset.tab === "json") {
          syncJsonFromForm();
          setEditorMode("json");
        } else {
          if (!state.jsonMode) return;
          try {
            applyJsonToForm();
          } catch {
            /* toast 已提示 */
          }
        }
      });
    });

    $("btnJsonSync").addEventListener("click", syncJsonFromForm);
    $("btnJsonApply").addEventListener("click", () => {
      try {
        applyJsonToForm();
      } catch {
        /* toast 已提示 */
      }
    });

    $("editorForm").addEventListener("input", markDirty);
    $("editorForm").addEventListener("change", markDirty);
    $("jsonEditor").addEventListener("input", markDirty);

    $("fFigureOn").addEventListener("change", () => {
      $("figureBody").hidden = !$("fFigureOn").checked;
      markDirty();
    });
    $("fPartialOn").addEventListener("change", () => {
      $("partialBody").hidden = !$("fPartialOn").checked;
      markDirty();
    });
    $("fBeginnerOn").addEventListener("change", () => {
      $("beginnerBody").hidden = !$("fBeginnerOn").checked;
      markDirty();
    });

    $("btnAddKp").addEventListener("click", () => addRow("kpRows", kpRow));
    $("btnAddSub").addEventListener("click", () => addRow("subRows", subRow));
    $("btnAddPit").addEventListener("click", () => addRow("pitRows", pitRow));
    $("btnAddTest").addEventListener("click", () => addRow("testRows", testRow));

    document.addEventListener("click", (e) => {
      const del = e.target.closest(".row-del");
      if (!del) return;
      const item = del.closest(".row-item");
      if (!item) return;
      item.remove();
      markDirty();
    });

    /* AI */
    $("aiLoad").addEventListener("change", () => {
      const id = $("aiLoad").value;
      if (id) loadAiProblem(id);
      else clearAiLoaded();
    });
    $("btnGenerate").addEventListener("click", startAiJob);
    $("btnCancelAi").addEventListener("click", cancelAiJob);
    $("aiUseExisting").addEventListener("change", () => {
      $("aiMode").value = $("aiUseExisting").checked ? "repair" : "full";
    });
    $("btnUseResult").addEventListener("click", () => useAiResult(false));
    $("btnUseAndSave").addEventListener("click", () => useAiResult(true));

    /* 规范 */
    $("rulesText").addEventListener("input", updateRulesMeta);
    $("btnRulesSave").addEventListener("click", saveRules);
    $("btnRulesDefault").addEventListener("click", restoreRulesDefault);

    /* 设置 */
    $("btnSetSave").addEventListener("click", saveSettings);
    $("btnGwTest").addEventListener("click", testGateway);

    /* 弹窗 */
    $("modalOk").addEventListener("click", () => closeModal(true));
    $("modalCancel").addEventListener("click", () => closeModal(false));
    $("modal").addEventListener("cancel", (e) => {
      e.preventDefault();
      closeModal(false);
    });
    $("modal").addEventListener("close", () => {
      if (modalResolve) {
        const r = modalResolve;
        modalResolve = null;
        r(false);
      }
    });

    /* Ctrl+S */
    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && state.view === "editor") {
        e.preventDefault();
        saveEditor();
      }
    });

    window.addEventListener("beforeunload", (e) => {
      if (state.dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    });
  }

  /* ============================================================
     启动
     ============================================================ */

  async function boot() {
    // 后台依赖本机服务；部署成静态页时给一个明确提示，避免误操作。
    if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(location.hostname)) {
      document.body.innerHTML =
        '<div class="local-only"><div class="local-only-card"><span class="logo">題</span>' +
        "<h1>后台只在本机运行</h1><p>请先启动本地服务，再访问 <code>http://127.0.0.1:8790/admin/</code>。</p>" +
        "<pre>$env:LLM_GATEWAY_TOKEN=\"…\"\nnode tools/admin-server.mjs</pre>" +
        '<p class="hint">这个页面不包含任何网关密钥；静态部署时无法编辑题库。</p></div></div>';
      return;
    }

    bindEvents();
    await showView("list");
    await routeFromHash();
    refreshGateway();
    state.gatewayTimer = setInterval(refreshGateway, 30000);
  }

  boot().catch((e) => toast(e.message || String(e), "error"));
})();
