/* ============================================================
   公共工具：转义、行内格式、主题、toast
   两个页面共用，不含任何题目相关内容。
   ============================================================ */
window.PA = (function () {
  "use strict";

  // ===== 反馈入口：把腾讯问卷 / 金数据的链接填在这里，右上角按钮会自动出现 =====
  // 例：const FEEDBACK_URL = "https://wj.qq.com/s2/12345678/abcd/";
  const FEEDBACK_URL = "";

  function mountFeedback() {
    const links = document.querySelectorAll("[data-feedback]");
    if (!links.length) return;
    if (!FEEDBACK_URL) {
      links.forEach((a) => a.remove());
      return;
    }
    links.forEach((a) => {
      a.href = FEEDBACK_URL;
      a.hidden = false;
    });
  }

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // 行内公式：a_i → a<sub>i</sub>，2^30 → 2<sup>30</sup>，10^5 同理。
  // 只处理正文，反引号里的代码原样保留。
  const MATH = [
    [/([A-Za-z0-9]+)_\{([^}]+)\}/g, "$1<sub>$2</sub>"],
    [/([A-Za-z]+)_([A-Za-z0-9]+)/g, "$1<sub>$2</sub>"],
    [/([A-Za-z0-9]+)\^\{([^}]+)\}/g, "$1<sup>$2</sup>"],
    [/([A-Za-z0-9]+)\^([A-Za-z0-9]+)/g, "$1<sup>$2</sup>"],
  ];
  const mathify = (t) => MATH.reduce((s, [re, rep]) => s.replace(re, rep), t);

  // 行内：`code`、**bold**、$公式$、简单上下标
  // $...$ 原样交给 KaTeX（这里的切分保证公式里的 \sum_{i=1}^{n} 不被上下标规则改写）
  function md(s) {
    return String(s)
      .split(/(`[^`]+`|\$\$[\s\S]*?\$\$|\$[^$\n]+\$)/)
      .map((part) => {
        if (part.length > 1 && part.startsWith("`") && part.endsWith("`")) {
          return "<code>" + esc(part.slice(1, -1)) + "</code>";
        }
        if (part.startsWith("$")) return esc(part);
        return mathify(esc(part).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>"));
      })
      .join("");
  }

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

  mountFeedback();

  return { esc, md, initTheme, toast };
})();
