/* B站历史记录仪 —— 前端逻辑（无第三方依赖） */
(function () {
  "use strict";

  // 移动端 = 窄屏 + 触屏。桌面窗口被拉窄时仍属于桌面，保留左侧导航和三栏能力；
  // 判定方式与 CSS 的 `@media (max-width:900px) and (pointer:coarse)` 保持一致。
  const MOBILE = () => window.innerWidth <= 900
    && window.matchMedia("(pointer:coarse)").matches;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const S = {
    panel: "overview",
    mode: "triple",
    cats: [],
    catMap: {},
    state: null,
    cat: "all",
    q: "",
    sort: "recent",
    page: 1,
    size: 40,
    videos: [],
    total: 0,
    busy: false,
    timer: null,
  };

  /* ---------- 基础请求 ---------- */
  // 超时是必须的：系统休眠、WebView2 渲染进程冻结、网络栈异常时 fetch 会永久挂起，
  // 而挂起的 Promise 会让界面永远停在 loading 状态（表现为"用久了就卡住"）。
  const REQ_TIMEOUT = 12000;

  // 封面图默认不加载：每条都是请求 B站 CDN 的外网图片，40 条一起发出去，
  // 在客户端窗口里（尤其网络受限 / 走代理时）会长时间挂起并反复触发重排，
  // 观感就是「点了半天没反应」。想要封面随时点工具栏上的开关打开。
  let COVERS = localStorage.getItem("bh_covers") === "1";
  const LAST_VISIBLE = { t: Date.now() };

  function fetchWithTimeout(url, opt, ms) {
    if (typeof AbortController === "undefined") return fetch(url, opt);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms || REQ_TIMEOUT);
    return fetch(url, Object.assign({}, opt, { signal: ctrl.signal }))
      .then((r) => { clearTimeout(timer); return r; },
            (e) => { clearTimeout(timer); throw e; });
  }

  let _reqFail = 0;
  async function api(path, method, body) {
    const opt = { method: method || "GET", headers: {} };
    if (body) { opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
    let r;
    try {
      r = await fetchWithTimeout(path, opt);
    } catch (e) {
      // 连续多次无响应：多半是渲染进程或服务端卡住了，自动重载一次自愈
      if (++_reqFail >= 3) {
        toast("服务长时间无响应，正在自动重载…", true);
        setTimeout(() => location.reload(), 1500);
      }
      return { ok: false, msg: "请求超时，服务可能未响应" };
    }
    _reqFail = 0;
    const j = await r.json().catch(() => ({ ok: false, msg: "响应解析失败" }));
    return j;
  }

  let toastTimer = null;
  function toast(msg, bad) {
    const t = $("#toast");
    t.textContent = msg;
    t.style.background = bad ? "#c2353e" : "#1d2330";
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2400);
  }

  function fmtTime(ts) {
    if (!ts) return "";
    const d = new Date(ts * 1000);
    const diff = Date.now() - ts * 1000;
    if (diff < 3600e3) return Math.max(1, Math.round(diff / 60e3)) + " 分钟前";
    if (diff < 86400e3) return Math.round(diff / 3600e3) + " 小时前";
    if (diff < 7 * 86400e3) return Math.round(diff / 86400e3) + " 天前";
    const p = (n) => (n < 10 ? "0" + n : n);
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function fmtDur(sec) {
    if (!sec) return "";
    const m = Math.floor(sec / 60), s = sec % 60;
    return m + ":" + (s < 10 ? "0" + s : s);
  }

  /* ---------- 面板切换 ---------- */
  // 三栏（triple）= 三块内容都铺开；单栏（focus）= 只看当前那一块。
  // applyMode 是唯一出口，保证 grid 状态、导航高亮、按钮文案三者始终一致。
  const ICON_TRIPLE = '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="5" height="16" rx="1.5"/>'
    + '<rect x="9.5" y="4" width="5" height="16" rx="1.5"/>'
    + '<rect x="16" y="4" width="5" height="16" rx="1.5"/></svg>';
  const ICON_SINGLE = '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>';

  // 两个切换按钮（顶栏 + 左侧底部）共用同一套状态渲染：图标 ↔ 文字 ↔ 高亮
  // 用 dataset.iconState 做幂等，避免每次 applyMode 都重建 svg 造成闪动。
  function syncModeButton(btn, txtEl, triple) {
    if (!btn) return;
    const state = triple ? "on" : "off";
    if (txtEl) txtEl.textContent = triple ? "收起" : "三栏";
    if (btn.dataset.iconState === state) return;
    btn.dataset.iconState = state;
    btn.classList.toggle("is-on", triple);
    btn.setAttribute("aria-pressed", triple ? "true" : "false");
    btn.title = triple ? "收起为单栏" : "展开为三栏";
    const icon = btn.querySelector("svg");
    if (icon) icon.outerHTML = triple ? ICON_SINGLE : ICON_TRIPLE;
  }

  function applyMode() {
    const g = $("#grid");
    const triple = S.mode === "triple";
    g.dataset.mode = triple ? "triple" : "focus";

    // 三栏时不高亮任何单项；单栏时高亮当前面板
    $$(".rail-item[data-nav]").forEach((b) => {
      b.classList.toggle("is-active", !triple && b.dataset.nav === S.panel);
    });

    syncModeButton($("#btnViewMode"), $("#vmText"), triple);
    syncModeButton($("#btnTriple"), $("#railModeText"), triple);
  }

  function setMode(mode, opts) {
    S.mode = mode;
    applyMode();
    if (opts && opts.scroll) window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // 唯一的开关：同一次点击在「三栏 ↔ 单栏」之间翻转
  function toggleMode() {
    if (MOBILE()) {
      toast("手机上一次只看一屏，无需展开三栏");
      return;
    }
    const triple = S.mode !== "triple";
    setMode(triple ? "triple" : "focus", { scroll: true });
    toast(triple ? "已展开三栏" : "已收起为单栏");
  }

  function setPanel(name) {
    S.panel = name;
    $$(".panel").forEach((p) => p.classList.toggle("is-active", p.dataset.panel === name));
    $$(".tab-item[data-nav]").forEach((b) => b.classList.toggle("is-active", b.dataset.nav === name));
    // 手机上永远是单栏，直接走 applyMode 统一下游状态
    if (MOBILE()) S.mode = "focus";
    applyMode();
    window.scrollTo({ top: 0, behavior: "smooth" });
    if (name === "videos" && !S.videos.length) loadVideos();
  }

  // 左侧导航：三栏状态下点任意项 → 收起并只看它；单栏状态下点已选中项 → 展开三栏
  $("#rail").addEventListener("click", (e) => {
    const b = e.target.closest("[data-nav]");
    if (!b) return;
    const name = b.dataset.nav;
    if (MOBILE()) { setPanel(name); return; }
    if (S.mode === "triple") {
      S.mode = "focus";
      setPanel(name);
      toast("已收起为单栏");
      return;
    }
    if (name === S.panel) { toggleMode(); return; }
    setPanel(name);
  });
  $("#tabbar").addEventListener("click", (e) => {
    const b = e.target.closest("[data-nav]");
    if (b) setPanel(b.dataset.nav);
  });

  // 两处入口共用一个翻转开关：左侧底部「三栏」按钮 + 顶栏按钮（窄屏导航隐藏时仍可用）
  $("#btnTriple").addEventListener("click", toggleMode);
  $("#btnViewMode").addEventListener("click", toggleMode);

  window.addEventListener("resize", () => {
    // 只有真正的移动端才强制单栏；桌面窄窗口允许三栏（此时内容纵向堆叠，用户自己说了算）
    if (MOBILE() && S.mode !== "focus") S.mode = "focus";
    applyMode();
  });

  /* ---------- 概览 ---------- */
  function renderStats(o) {
    const cards = [
      ["总观看次数", o.total_views, "次"],
      ["看过视频", o.total_videos, "个"],
      ["关注过的UP主", o.authors, "位"],
      ["覆盖分区", o.zones, "个"],
    ];
    $("#stats").innerHTML = cards.map((c) =>
      `<div class="stat"><b>${esc(c[1])}</b><em>${esc(c[0])}${c[2] ? " (" + c[2] + ")" : ""}</em></div>`
    ).join("");
  }

  function arcPath(cx, cy, r, ir, a0, a1) {
    const p = (rr, a) => [cx + rr * Math.cos(a), cy + rr * Math.sin(a)];
    const [x0, y0] = p(r, a0), [x1, y1] = p(r, a1), [x2, y2] = p(ir, a1), [x3, y3] = p(ir, a0);
    const lg = a1 - a0 > Math.PI ? 1 : 0;
    return `M${x0} ${y0}A${r} ${r} 0 ${lg} 1 ${x1} ${y1}L${x2} ${y2}A${ir} ${ir} 0 ${lg} 0 ${x3} ${y3}Z`;
  }

  function renderDonut(cats) {
    const R = 190, cx = R / 2, cy = R / 2, r = 82, ir = 56;
    const total = cats.reduce((a, c) => a + c.views, 0) || 1;
    let a = 0, paths = "";
    cats.forEach((c) => {
      const span = (c.views / total) * Math.PI * 2;
      if (span > 0.0008) {
        paths += `<path d="${arcPath(cx, cy, r, ir, a, a + span - 0.012)}" fill="${c.color}"/>`;
      }
      a += span;
    });
    if (!cats.length) paths = `<circle cx="${cx}" cy="${cy}" r="${(r + ir) / 2}" fill="none" stroke="#e6e9f0" stroke-width="${r - ir}"/>`;
    $("#donut").innerHTML =
      `<svg viewBox="0 0 ${R} ${R}"><g>${paths}</g></svg>
       <div class="hole"><b>${total}</b><em>次观看</em></div>`;

    $("#legend").innerHTML = cats.map((c) => {
      const pc = ((c.views / total) * 100).toFixed(1);
      return `<li data-cat="${c.id}" title="点击查看该分类视频">
        <i class="dot" style="background:${c.color}"></i>
        <span class="nm">${esc(c.name)}</span>
        <span><span class="vl">${c.views}</span><span class="pc">${pc}%</span></span>
      </li>`;
    }).join("") || `<div class="empty">暂无数据</div>`;
  }

  function renderBars(el, data, getV, getLabel, unit) {
    const max = Math.max(1, ...data.map(getV));
    el.innerHTML =
      `<div class="bars">${data.map((d, i) => {
        const v = getV(d);
        return `<div class="b" style="height:${Math.max(2, (v / max) * 100)}%" title="${esc(getLabel(d))}：${v}${unit || ""}"></div>`;
      }).join("")}</div>`;
  }

  async function loadOverview() {
    const j = await api("/api/overview?days=30");
    if (!j.ok) return toast(j.msg, true);
    const o = j.overview;
    S.cats = o.categories;
    S.catMap = {};
    o.categories.forEach((c) => (S.catMap[c.id] = c));
    renderStats(o);
    renderDonut(o.categories);
    renderChips();

    const tr = j.trend || [];
    const wrap = $("#trend");
    wrap.innerHTML =
      `<div class="bars">${tr.map((d) => {
        const max = Math.max(1, ...tr.map((x) => x.count));
        return `<div class="b" style="height:${Math.max(2, (d.count / max) * 100)}%" title="${d.date}：${d.count} 次"></div>`;
      }).join("")}</div>
       <div class="axis"><span>${tr.length ? tr[0].date.slice(5) : ""}</span><span>${tr.length ? tr[tr.length - 1].date.slice(5) : ""}</span></div>`;

    const hrs = j.hours || [];
    const hw = $("#hours");
    const hmax = Math.max(1, ...hrs.map((h) => h.count));
    hw.innerHTML =
      `<div class="bars hours">${hrs.map((h) =>
        `<div class="b" style="height:${Math.max(2, (h.count / hmax) * 100)}%" title="${h.hour} 点：${h.count} 次"></div>`
      ).join("")}</div>
       <div class="axis"><span>0</span><span>6</span><span>12</span><span>18</span><span>24</span></div>`;

    const ups = j.topUps || [];
    const umax = Math.max(1, ...ups.map((u) => u.count));
    $("#uplist").innerHTML = ups.map((u) => `
      <div class="r">
        <span class="n">${esc(u.name)}</span><span class="v">${u.count} 次</span>
        <div class="track"><div class="fill" style="width:${(u.count / umax) * 100}%"></div></div>
      </div>`).join("") || `<div class="empty" style="padding:14px">暂无数据</div>`;

    const sum = o.categories.reduce((a, c) => a + c.videos, 0);
    $("#tbSub").textContent = o.total_views
      ? `共 ${o.total_views} 次观看 · ${sum} 个视频 · 最近 ${fmtTime(o.last_view_at) || "-"}`
      : "还没有数据，去「设置」粘贴 Cookie 或填充演示数据";
  }

  /* ---------- 视频列表 ---------- */
  function renderChips() {
    const items = [{ id: "all", name: "全部", views: S.cats.reduce((a, c) => a + c.views, 0), videos: 0, color: "#8b93a7" }]
      .concat(S.cats);
    $("#chips").innerHTML = items.map((c) => {
      const on = c.id === S.cat;
      return `<button class="chip${on ? " is-active" : ""}" data-cat="${c.id}">
        <i style="background:${c.color}"></i>${esc(c.name)} <b>${c.views}</b></button>`;
    }).join("");
  }

  async function loadVideos(append) {
    if (!append) { S.page = 1; S.videos = []; }
    const qs = new URLSearchParams({
      category: S.cat, q: S.q, page: S.page, size: S.size, sort: S.sort,
    });
    const j = await api("/api/videos?" + qs);
    if (!j.ok) return toast(j.msg, true);
    S.total = j.total;
    S.videos = append ? S.videos.concat(j.items) : j.items;
    renderVideos();
  }

  function coverHtml(v) {
    if (!COVERS || !v.cover) return "";
    const src = esc(v.cover.startsWith("//") ? "https:" + v.cover : v.cover);
    // loading=lazy + async 解码：图片完全不参与首屏关键路径，加载失败就悄悄隐藏
    return `<img src="${src}" referrerpolicy="no-referrer" loading="lazy" decoding="async"
             onerror="this.style.display='none'">`;
  }

  function renderVideos() {
    const el = $("#vlist");
    if (!S.videos.length) {
      el.innerHTML = `<div class="empty">这里还没有数据<br>点击右上角「同步记录」拉取你的观看历史</div>`;
      $("#btnMore").style.display = "none";
      return;
    }
    el.innerHTML = S.videos.map((v) => `
      <div class="vitem">
        <div class="cover">${coverHtml(v)}</div>
        <div>
          <a class="vtitle" href="${esc(v.url)}" target="_blank" rel="noreferrer">${esc(v.title)}</a>
          <div class="vmeta">
            <span class="tag"><i style="background:${v.category_color}"></i>${esc(v.category_name)}</span>
            ${v.zone ? `<span>${esc(v.zone)}</span>` : ""}
            <span>${esc(v.author_name || "未知UP")}</span>
            <span>·</span>
            <span>${fmtTime(v.last_view_at)}</span>
          </div>
          <div class="vrow">
            <span class="tag">${v.views} 次观看</span>
            ${v.duration ? `<span class="tag">${fmtDur(v.duration)}</span>` : ""}
            ${v.locked ? `<span class="tag lock">已手动锁定</span>` : ""}
            <select class="sel-cat" data-bvid="${esc(v.bvid)}">
              <option value="">改分类…</option>
              ${S.cats.map((c) => `<option value="${c.id}"${c.id === v.category ? " selected" : ""}>${esc(c.name)}</option>`).join("")}
            </select>
          </div>
        </div>
      </div>`).join("");

    $("#btnMore").style.display = S.videos.length < S.total ? "" : "none";
    $("#btnMore").textContent = `加载更多（还有 ${S.total - S.videos.length} 个）`;
  }

  $("#chips").addEventListener("click", (e) => {
    const b = e.target.closest(".chip");
    if (!b) return;
    S.cat = b.dataset.cat;
    renderChips();
    loadVideos();
    setPanel("videos");
  });
  $("#legend").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-cat]");
    if (!li) return;
    S.cat = li.dataset.cat;
    renderChips();
    loadVideos();
    if (MOBILE()) setPanel("videos");
  });
  // 封面开关：默认关（外网图片是客户端里最容易拖慢响应的一环）
  function syncCoverBtn() {
    const b = $("#btnCover");
    if (!b) return;
    b.textContent = COVERS ? "隐藏封面" : "显示封面";
    b.classList.toggle("is-on", COVERS);
  }
  $("#btnCover").addEventListener("click", () => {
    COVERS = !COVERS;
    localStorage.setItem("bh_covers", COVERS ? "1" : "0");
    syncCoverBtn();
    renderVideos();
    toast(COVERS ? "已开启封面（需联网加载图片）" : "已关闭封面，列表更清爽");
  });

  $("#btnMore").addEventListener("click", () => { S.page += 1; loadVideos(true); });
  $("#sort").addEventListener("change", (e) => { S.sort = e.target.value; loadVideos(); });

  let kt = null;
  $("#search").addEventListener("input", (e) => {
    clearTimeout(kt);
    const v = e.target.value.trim();
    kt = setTimeout(() => { S.q = v; loadVideos(); }, 320);
  });

  $("#vlist").addEventListener("change", async (e) => {
    const sel = e.target.closest(".sel-cat");
    if (!sel || !sel.value) return;
    const j = await api("/api/override", "POST", { bvid: sel.dataset.bvid, category: sel.value });
    if (!j.ok) return toast(j.msg, true);
    toast("分类已更新并锁定");
    loadOverview();
  });

  /* ---------- 设置 ---------- */
  async function loadState() {
    const j = await api("/api/state");
    if (!j.ok) { toast(j.msg, true); return false; }
    S.state = j;
    (j.categories || []).forEach((c) => { if (!S.catMap[c.id]) S.catMap[c.id] = c; });

    $("#rc").innerHTML = j.categories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
    $("#swAuto").checked = j.settings.auto_sync === "1";
    $("#intervalSel").value = j.settings.sync_interval_min || "180";
    $("#swBoot").checked = !!j.autostart;
    $("#dataDir").value = j.data_dir || "";
    // 健康指标：WAL 长期不回收会让读写越跑越慢，线程数持续增长说明连接在被泄漏
    const wal = j.walKb || 0;
    const walTxt = wal > 1024 ? `WAL ${wal} KB ⚠ 偏大` : (wal > 0 ? `WAL ${wal} KB` : "WAL 已清理");
    $("#dirInfo").textContent =
      `当前数据库：${j.dbFile || "-"}（${j.dbSize || 0} KB）｜ ${walTxt} ｜ 服务线程 ${j.threads || "-"}`;
    $("#asHint").textContent = j.autostart ? "已启用" : "未启用";
    if (j.settings.last_sync_at) {
      $("#pillSync").textContent = "上次 " + j.settings.last_sync_at.slice(5);
      $("#pillSync").className = "pill ok";
    }
    renderRules();
    loadNetAddr();
    return true;
  }

  async function loadNetAddr() {
    const j = await api("/api/network");
    if (!j.ok) return;
    const list = [{ t: "本机", u: j.local }];
    (j.lan || []).slice(0, 3).forEach((u) => list.push({ t: "手机", u }));
    $("#addrList").innerHTML = list
      .map((a) => `<li><b>${a.t}</b>${esc(a.u)}</li>`).join("");
  }

  async function renderRules() {
    const j = await api("/api/rules");
    if (!j.ok) return;
    $("#ruleList").innerHTML = (j.rules || []).map((r) =>
      `<div class="rule">
        <span class="k">${esc(r.keyword)} → ${esc((S.catMap[r.category] || {}).name || r.category)}</span>
        <button class="x" data-kw="${esc(r.keyword)}" title="删除">&times;</button>
      </div>`
    ).join("") || `<div class="empty" style="padding:14px">暂无自定义规则</div>`;
  }
  $("#ruleList").addEventListener("click", async (e) => {
    const b = e.target.closest(".x");
    if (!b) return;
    await api("/api/rules/delete", "POST", { keyword: b.dataset.kw });
    renderRules(); loadOverview(); loadVideos();
  });
  $("#btnAddRule").addEventListener("click", async () => {
    const kw = $("#rk").value.trim();
    if (!kw) return toast("请填写关键词", true);
    const j = await api("/api/rules", "POST", { keyword: kw, category: $("#rc").value });
    if (!j.ok) return toast(j.msg, true);
    $("#rk").value = "";
    renderRules(); loadOverview(); loadVideos();
    toast("已添加并重新分类");
  });
  $("#btnRecat").addEventListener("click", async () => {
    const j = await api("/api/recategorize", "POST", {});
    if (!j.ok) return toast(j.msg, true);
    toast(`已重算 ${j.updated} 条记录`);
    loadOverview(); loadVideos();
  });

  $("#swAuto").addEventListener("change", async (e) => {
    await api("/api/settings", "POST", { auto_sync: e.target.checked ? "1" : "0", sync_interval_min: $("#intervalSel").value });
    toast("已保存");
  });
  $("#intervalSel").addEventListener("change", async (e) => {
    await api("/api/settings", "POST", { sync_interval_min: e.target.value });
  });
  $("#swBoot").addEventListener("change", async (e) => {
    const j = await api("/api/autostart", "POST", { enabled: e.target.checked });
    if (!j.ok) { toast(j.msg || "设置失败", true); e.target.checked = !e.target.checked; return; }
    $("#asHint").textContent = j.enabled ? "已启用" : "未启用";
    toast(j.enabled ? "开机自启已启用" : "开机自启已关闭");
  });
  $("#btnApplyDir").addEventListener("click", async () => {
    const j = await api("/api/data-dir", "POST", { path: $("#dataDir").value.trim() });
    if (!j.ok) return toast(j.msg, true);
    toast(j.msg || "数据目录已更新");
    loadState(); loadOverview(); loadVideos();
  });
  if ($("#btnOpenDir")) $("#btnOpenDir").addEventListener("click", async () => {
    await api("/api/open-folder", "POST", {});
  });
  // 导出走 Blob 下载，而不是直接 location.href。
  // 应用窗口里导航到一个下载响应会弹下载条、甚至把窗口本身跳走，观感像「卡住了」。
  async function downloadExport(fmt) {
    try {
      toast("正在生成文件…");
      const r = await fetchWithTimeout(`/api/export?format=${fmt}`, {}, 60000);
      if (!r.ok) return toast("导出失败：" + r.status, true);
      const blob = await r.blob();
      const name = `bili-history-${new Date().toISOString().slice(0, 10)}.${fmt}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      toast("已导出：" + name);
    } catch (e) {
      toast("导出失败：" + (e && e.message || e), true);
    }
  }
  $("#btnExportCsv").addEventListener("click", () => downloadExport("csv"));
  $("#btnExportJson").addEventListener("click", () => downloadExport("json"));
  $("#btnClear").addEventListener("click", async () => {
    if (!confirm("确认清空全部历史记录？此操作不可撤销。")) return;
    const j = await api("/api/clear", "POST", {});
    if (!j.ok) return toast(j.msg, true);
    S.videos = [];
    loadOverview(); renderVideos();
    toast("已清空");
  });
  $("#btnDemo").addEventListener("click", async () => {
    const j = await api("/api/demo/seed", "POST", { count: 180 });
    if (!j.ok) return toast(j.msg, true);
    toast(`已写入 ${j.new} 条演示数据`);
    loadOverview(); loadVideos();
  });

  /* ---------- 一键自检 ---------- */
  $("#btnDiag").addEventListener("click", async () => {
    const out = $("#diagOut");
    const ck = ($("#ck").value || "").trim();
    out.hidden = false;
    out.textContent = "正在自检…";
    $("#btnDiag").disabled = true;
    try {
      const j = await api("/api/diag" + (ck ? "?cookie=" + encodeURIComponent(ck) : ""));
      if (!j.ok) { out.textContent = "自检失败：" + j.msg; return; }
      const r = j.report || {};
      const lines = [];
      const ck2 = r.cookie || {};
      lines.push("Cookie：长度 " + (ck2.length || 0)
        + "　SESSDATA " + (ck2.has_sessdata ? "有" : "缺")
        + "　bili_jct " + (ck2.has_bili_jct ? "有" : "缺")
        + "　DedeUserID " + (ck2.has_dedeuserid ? "有" : "缺")
        + "　buvid3 " + (ck2.has_buvid3 ? "有" : "缺")
        + (ck2.changed ? "　（已自动清洗）" : ""));
      lines.push("");
      (r.steps || []).forEach((s) => {
        const tail = [s.code !== undefined ? "code=" + s.code : "", s.message || ""]
          .filter(Boolean).join(" · ");
        const extra = s.uname ? " · 用户：" + s.uname : (s.count !== undefined ? " · 返回 " + s.count + " 条" : "");
        lines.push((s.ok ? "[通过] " : "[失败] ") + s.name + (tail ? "：" + tail : "") + extra);
      });
      lines.push("");
      lines.push(r.ok ? "结论：全部通过，可以正常同步。" : "结论：存在失败项，按上面的提示处理后再试。");
      out.textContent = lines.join("\n");
    } finally {
      $("#btnDiag").disabled = false;
    }
  });

  /* ---------- 同步 ---------- */
  async function doSync(deep) {
    const ck = $("#ck").value.trim();
    if (ck) await api("/api/settings", "POST", { cookie: ck });
    const j = await api("/api/sync", "POST", deep ? { deep: true } : {});
    if (!j.ok) return toast(j.msg, true);
    S.busy = true;
    $("#pillSync").textContent = "同步中…";
    $("#pillSync").className = "pill busy";
    watchSync();
  }
  $("#btnSyncTop").addEventListener("click", () => doSync(false));
  $("#btnSync").addEventListener("click", () => doSync(false));
  $("#btnSyncSet").addEventListener("click", () => doSync(false));
  $("#btnDeep").addEventListener("click", () => doSync(true));

  // guard：同一时刻只允许一条轮询链，否则多次点击同步会叠加出并行链，
  // 长期运行后请求量成倍放大。
  let watchTimer = null;
  let watchRunning = false;
  let wasRunning = false;   // 是否真的观察到过「同步正在进行」

  async function watchSync() {
    if (watchRunning) return;
    watchRunning = true;
    try {
      await tick();
    } finally {
      watchRunning = false;
    }
  }

  async function tick() {
    clearTimeout(watchTimer);
    const j = await api("/api/sync/status");
    if (!j.ok) return;
    $("#log").textContent = (j.log || []).join("\n");

    if (j.running) {
      wasRunning = true;
      $("#pillSync").textContent = "同步中…";
      $("#pillSync").className = "pill busy";
      watchTimer = setTimeout(watchSync, 900);
      return;
    }

    if (wasRunning) {
      // 刚刚走到「同步结束」这一步，这时候才有必要把三栏数据整体重拉一次
      wasRunning = false;
      $("#pillSync").textContent = j.last_sync_at ? "上次 " + j.last_sync_at.slice(5) : "未同步";
      $("#pillSync").className = "pill " + (j.last_sync_result && j.last_sync_result.startsWith("失败") ? "err" : "ok");
      await loadOverview();
      await loadVideos();
      return;
    }

    // 没有在同步：只同步一次状态角标就行。
    // 之前这里是无条件 loadState + loadOverview + loadVideos，而 boot() 里刚跑过一遍，
    // 于是每次打开都会把同样的数据请求两遍、500 多条 DOM 渲染两轮 —— 首屏直接翻倍负重。
    $("#pillSync").textContent = j.last_sync_at ? "上次 " + j.last_sync_at.slice(5) : "未同步";
    $("#pillSync").className = "pill " + (j.last_sync_result && j.last_sync_result.startsWith("失败") ? "err" : "ok");
  }

  // 休眠 / 切后台再回来时刷新数据。加了时间阈值：短暂切换（比如 Alt-Tab 一下）
  // 没必要重拉，否则每次回到窗口都要重渲一遍列表，正是「切回来卡一下」的来源。
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") { LAST_VISIBLE.t = Date.now(); return; }
    const gap = Date.now() - LAST_VISIBLE.t;
    LAST_VISIBLE.t = Date.now();
    if (gap < 15000) return;
    if (S.busy) watchSync();
    else { loadState(); loadOverview(); if (S.panel === "videos") loadVideos(); }
  });

  /* ---------- App 化：安装到手机 / 离线外壳 ---------- */
  let deferredPrompt = null;
  const standalone = () => window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone;

  function installBtn(show, text) {
    const b = $("#btnInstall");
    if (!b) return;
    b.hidden = !show;
    b.textContent = text || "安装到手机";
  }

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    installBtn(true, "安装到手机");
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    installBtn(false);
    toast("已安装，可在桌面打开");
  });
  const doInstall = async () => {
    if (standalone()) return toast("已经是应用模式了");
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const r = await deferredPrompt.userChoice;
      deferredPrompt = null;
      installBtn(false);
      toast(r.outcome === "accepted" ? "安装完成" : "已取消");
    } else {
      toast("请用浏览器菜单里的「添加到主屏幕 / 安装应用」");
      $("#installTip").classList.add("hl");
    }
  };

  $("#btnInstall").addEventListener("click", doInstall);
  if ($("#btnInstall2")) $("#btnInstall2").addEventListener("click", doInstall);

  // Service Worker 只服务于手机 PWA。在桌面客户端窗口里它是多余的一层中间人：
  // 每个请求都得先过 SW 线程再转发网络，而客户端宿主对这些常驻后台线程的支持并不稳定，
  // 一旦 SW 卡在安装/激活阶段，页面就是彻底白屏或点了没反应 —— 「打开就卡死」的高危源。
  const IS_CLIENT = new URLSearchParams(location.search).get("client") === "1";

  function unregisterSW() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.getRegistrations()
      .then((rs) => Promise.all(rs.map((r) => r.unregister())))
      .catch(() => {});
    if (window.caches) {
      caches.keys().then((ks) => Promise.all(ks.map((k) => caches.delete(k)))).catch(() => {});
    }
  }

  if ("serviceWorker" in navigator) {
    if (IS_CLIENT) {
      unregisterSW();
    } else {
      navigator.serviceWorker.register("/sw.js")
        .then((reg) => {
          // 有新版本就立刻接管，避免用户停留在旧外壳上
          reg.addEventListener("updatefound", () => {
            const sw = reg.installing;
            if (!sw) return;
            sw.addEventListener("statechange", () => {
              if (sw.state === "activated") {
                reg.waiting && reg.waiting.postMessage({ type: "SKIP_WAITING" });
              }
            });
          });
        })
        .catch(() => {});
      // 兜底：每次加载都拉一次新 SW（开发/本机迭代场景需要）
      navigator.serviceWorker.ready
        .then((reg) => reg.update().catch(() => {}))
        .catch(() => {});
    }
  }

  /* ---------- 桌面客户端模式（原生应用窗口） ---------- */
  if (IS_CLIENT) {
    const m = $("#pillMode");
    if (m) m.hidden = false;
    $("#pillMode").textContent = "桌面客户端";
    if (window.pywebview && window.pywebview.api) $("#btnBrowse").hidden = false;
    else window.addEventListener("pywebviewready", () => { $("#btnBrowse").hidden = false; }, { once: true });
  }

  // 「浏览…」按钮依赖 pywebview 的原生目录选择框；Edge/Chrome 应用窗口下没有这个桥，
  // 此时这里恒为空字符串，按钮保持隐藏，用户手工填路径即可。
  if ($("#btnBrowse")) {
    $("#btnBrowse").addEventListener("click", () => {
      const apiObj = window.pywebview && window.pywebview.api;
      if (!apiObj) return toast("当前窗口不支持选目录，请直接填写路径", true);
      apiObj.choose_folder().then((p) => {
        if (p) { $("#dataDir").value = p; toast("已选择：" + p); }
      }).catch(() => toast("选择目录失败", true));
    });
  }

  /* ---------- 启动 ---------- */
  async function boot() {
    const qp = new URLSearchParams(location.search);
    const want = qp.get("panel");
    if (want && ["overview", "videos", "settings"].indexOf(want) >= 0) {
      S.panel = want;
      S.mode = "focus";
    }
    if (MOBILE()) S.mode = "focus";
    // 窗口不够宽时默认单栏（三栏会挤成纵向三屏，反而难用），用户可随时手动展开
    else if (window.innerWidth < 1180) S.mode = "focus";
    $$(".panel").forEach((p) => p.classList.toggle("is-active", p.dataset.panel === S.panel));
    applyMode();  // 统一设置 grid 模式、导航高亮与按钮文案
    if (standalone()) installBtn(false);
    syncCoverBtn();

    const st = await loadState();
    if (!st) {
      $("#tbSub").textContent = "连不上本机服务，请确认电脑上已启动本程序";
      return;
    }
    await loadOverview();
    await loadVideos();
    watchSync();
  }
  boot();
})();
