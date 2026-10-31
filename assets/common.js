/* ============================================================
   公共工具：转义、行内格式、主题、toast
   两个页面共用，不含任何题目相关内容。
   ============================================================ */
window.PA = (function () {
  "use strict";

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // 行内：`code` 与 **bold**
  const md = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* file:// 下可能被禁用 */ } },
  };

  function initTheme() {
    const root = document.documentElement;
    const t = new URLSearchParams(location.search).get("theme") || store.get("pa-theme");
    if (t === "dark" || t === "light") root.dataset.theme = t;

    const btn = document.getElementById("btnTheme");
    if (btn) {
      btn.addEventListener("click", () => {
        root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
        store.set("pa-theme", root.dataset.theme);
      });
    }
  }

  let timer = null;
  function toast(msg) {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(timer);
    timer = setTimeout(() => el.classList.remove("show"), 1600);
  }

  return { esc, md, initTheme, toast };
})();
