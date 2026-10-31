/* ============================================================
   列表页：index.html
   题库来自 assets/data.js，搜索按题号 / 题目 / 知识点 / 比赛过滤。
   ============================================================ */
(function () {
  "use strict";

  const { esc, initTheme } = window.PA;
  const LIST = window.__PROBLEMS__ || [];

  const ul = document.getElementById("plist");
  const q = document.getElementById("q");
  const count = document.getElementById("count");
  const empty = document.getElementById("empty");

  const row = (p) =>
    '<li><a class="pitem" href="problem.html?id=' + encodeURIComponent(p.id) + '">' +
    '<span class="p-id">' + esc(p.id) + "</span>" +
    '<span class="p-main">' +
    '<span class="p-title">' + esc(p.title) + "</span>" +
    '<span class="p-meta">' +
    (p.knowledge || []).map((k) => '<span class="tag">' + esc(k) + "</span>").join("") +
    '<span class="p-sub">' + esc([p.contest, p.suffix].filter(Boolean).join(" · ")) + "</span>" +
    "</span></span></a></li>";

  function render(items) {
    ul.innerHTML = items.map(row).join("");
    empty.hidden = items.length > 0;
    count.textContent = items.length + " 道";
  }

  function filter(k) {
    if (!k) return LIST;
    return LIST.filter((p) =>
      [p.id, p.title, p.contest, p.suffix, ...(p.knowledge || [])]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(k)
    );
  }

  q.addEventListener("input", () => render(filter(q.value.trim().toLowerCase())));

  render(LIST);
  initTheme();
})();
