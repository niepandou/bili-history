/* B站历史记录仪 —— 手机独立版主逻辑
   登录（扫码 / 粘贴 Cookie）、同步（原生 HTTP 直连 B站）、
   分类统计、规则管理、导入导出，全部在本机完成，不依赖电脑。 */
"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const els = {
    loginView: $("loginView"), mainView: $("mainView"),
    tabQr: $("tabQr"), tabCk: $("tabCk"), panelQr: $("panelQr"), panelCk: $("panelCk"),
    qrBox: $("qrBox"), qrStatus: $("qrStatus"), btnQrGen: $("btnQrGen"),
    ckInput: $("ckInput"), btnCkLogin: $("btnCkLogin"), loginErr: $("loginErr"),
    mTitle: $("mTitle"), mSub: $("mSub"), btnSyncTop: $("btnSyncTop"),
    stats: $("stats"), donut: $("donut"), legend: $("legend"),
    trend: $("trend"), hours: $("hours"), uplist: $("uplist"),
    search: $("search"), sort: $("sort"), chips: $("chips"), vlist: $("vlist"), btnMore: $("btnMore"),
    acctFace: $("acctFace"), acctName: $("acctName"), acctState: $("acctState"), btnLogout: $("btnLogout"),
    swAutoOpen: $("swAutoOpen"), btnSync: $("btnSync"), btnDeep: $("btnDeep"), log: $("log"),
    rk: $("rk"), rc: $("rc"), btnAddRule: $("btnAddRule"), ruleList: $("ruleList"), btnRecat: $("btnRecat"),
    dataInfo: $("dataInfo"), btnExport: $("btnExport"), btnImport: $("btnImport"),
    btnClear: $("btnClear"), importFile: $("importFile"),
    toast: $("toast"), syncMask: $("syncMask"), syncText: $("syncText"),
  };

  const state = {
    cookie: "", uname: "",
    page: "overview",
    videos: { q: "", sort: "recent", category: "all", page: 1, total: 0 },
    syncing: false,
    qr: { key: "", timer: 0 },
  };

  // ---------------- 基础工具 ----------------
  let toastTimer = 0;
  function toast(msg, ms = 2200) {
    els.toast.textContent = msg;
    els.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove("show"), ms);
  }
  function logLine(msg) {
    const t = new Date();
    const p = (n) => (n < 10 ? "0" + n : n);
    els.log.textContent += `[${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}] ${msg}\n`;
    els.log.scrollTop = els.log.scrollHeight;
  }
  function showMask(text) { els.syncText.textContent = text || "正在同步…"; els.syncMask.hidden = false; }
  function setMask(text) { els.syncText.textContent = text; }
  function hideMask() { els.syncMask.hidden = true; }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function fmtNum(n) { return n >= 10000 ? (n / 10000).toFixed(1) + "万" : String(n); }
  function fmtTime(ts) {
    if (!ts) return "—";
    const d = new Date(ts * 1000), p = (n) => (n < 10 ? "0" + n : n);
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function fmtDur(sec) {
    if (!sec) return "";
    const m = Math.floor(sec / 60), s = sec % 60;
    return `${m}:${s < 10 ? "0" + s : s}`;
  }

  // ---------------- 视图切换 ----------------
  function showLogin() {
    stopQrPoll();
    els.mainView.hidden = true;
    els.loginView.hidden = false;
  }
  function showMain() {
    els.loginView.hidden = true;
    els.mainView.hidden = false;
    refreshAll();
  }
  const TAB_TITLES = { overview: "概览", videos: "视频", mine: "我的" };
  function switchPage(name) {
    state.page = name;
    document.querySelectorAll(".m-tab").forEach((b) => b.classList.toggle("is-active", b.dataset.tab === name));
    document.querySelectorAll(".m-page").forEach((p) => p.classList.toggle("is-active", p.id === "page-" + name));
    els.mTitle.textContent = TAB_TITLES[name] || "";
    if (name === "overview") renderOverview();
    if (name === "videos") renderVideos(true);
    if (name === "mine") renderMine();
  }

  // ---------------- 登录：扫码 ----------------
  function stopQrPoll() {
    if (state.qr.timer) { clearInterval(state.qr.timer); state.qr.timer = 0; }
  }
  function renderQr(text) {
    // qrcode-generator 官方库：typeNumber=0 自动选择版本
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const cell = 6, margin = 4;
    const n = qr.getModuleCount();
    const size = (n + margin * 2) * cell;
    let rects = "";
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) {
          rects += `<rect x="${(c + margin) * cell}" y="${(r + margin) * cell}" width="${cell}" height="${cell}"/>`;
        }
      }
    }
    els.qrBox.innerHTML =
      `<svg class="qr-svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">` +
      `<rect width="${size}" height="${size}" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
  }
  async function genQr() {
    els.loginErr.textContent = "";
    els.btnQrGen.disabled = true;
    els.qrStatus.textContent = "正在生成二维码…";
    try {
      const { url, qrcode_key } = await Bili.qrGenerate();
      state.qr.key = qrcode_key;
      renderQr(url);
      els.qrStatus.textContent = "请用手机 B 站 App 扫码，并在手机上确认登录";
      startQrPoll();
    } catch (e) {
      els.qrStatus.textContent = "";
      els.loginErr.textContent = e.message || String(e);
    } finally {
      els.btnQrGen.disabled = false;
    }
  }
  function startQrPoll() {
    stopQrPoll();
    state.qr.timer = setInterval(async () => {
      if (!state.qr.key) return;
      try {
        const r = await Bili.qrPoll(state.qr.key);
        if (r.code === 86038) { // 二维码失效
          stopQrPoll();
          els.qrStatus.textContent = "二维码已失效，请重新生成";
        } else if (r.code === 86090) {
          els.qrStatus.textContent = "已扫码，请在手机上点确认…";
        } else if (r.code === 0) {
          stopQrPoll();
          if (!r.cookie) { els.loginErr.textContent = "登录成功但未取到 Cookie，请改用粘贴 Cookie 方式"; return; }
          els.qrStatus.textContent = "登录成功，正在进入…";
          await onLoginOk(r.cookie);
        }
      } catch (e) { /* 轮询失败忽略，等下一轮 */ }
    }, 2000);
  }

  // ---------------- 登录：粘贴 Cookie ----------------
  async function loginByCookie() {
    const raw = els.ckInput.value;
    const info = Bili.cookieInfo(raw);
    els.loginErr.textContent = "";
    if (!info.cleaned) { els.loginErr.textContent = "请先粘贴 Cookie"; return; }
    if (!info.has_sessdata) { els.loginErr.textContent = "Cookie 里没找到 SESSDATA，请确认已完整复制"; return; }
    els.btnCkLogin.disabled = true;
    els.btnCkLogin.textContent = "校验中…";
    try {
      const r = await Bili.checkLogin(info.cleaned);
      if (!r.ok) { els.loginErr.textContent = r.msg; return; }
      await onLoginOk(info.cleaned, r.uname);
    } catch (e) {
      els.loginErr.textContent = e.message || String(e);
    } finally {
      els.btnCkLogin.disabled = false;
      els.btnCkLogin.textContent = "校验并登录";
    }
  }

  async function onLoginOk(cookie, uname) {
    state.cookie = Bili.sanitizeCookie(cookie);
    await LocalDB.setSetting("cookie", state.cookie);
    if (uname) { state.uname = uname; await LocalDB.setSetting("uname", uname); }
    toast(uname ? `欢迎，${uname}` : "登录成功");
    showMain();
    // 首次登录后自动同步一次
    if (await LocalStore.overview().then((o) => o.total_views === 0).catch(() => true)) {
      doSync();
    }
  }

  async function logout() {
    if (!confirm("退出登录会保留本地数据，仅清除登录态。确定退出？")) return;
    await LocalDB.setSetting("cookie", "");
    state.cookie = ""; state.uname = "";
    els.ckInput.value = "";
    els.qrStatus.textContent = "";
    showLogin();
  }

  // ---------------- 同步 ----------------
  async function doSync() {
    if (state.syncing) { toast("正在同步中…"); return; }
    if (!state.cookie) { showLogin(); return; }
    state.syncing = true;
    showMask("正在校验登录态…");
    logLine("开始同步观看历史");
    try {
      const { items, login } = await Bili.fetchHistory(state.cookie, 0, (page, n) => {
        setMask(`正在同步… 第 ${page} 页 / 已取 ${n} 条`);
      });
      state.uname = login.uname || state.uname;
      if (login.uname) await LocalDB.setSetting("uname", login.uname);
      setMask(`正在写入本地库（${items.length} 条）…`);
      const added = await LocalStore.upsertItems(items);
      await LocalDB.setSetting("last_sync", String(Math.floor(Date.now() / 1000)));
      logLine(`同步完成：拉取 ${items.length} 条，新增 ${added} 条`);
      toast(`同步完成，新增 ${added} 条`);
      refreshAll();
    } catch (e) {
      const msg = e.message || String(e);
      logLine("同步失败：" + msg);
      toast("同步失败：" + msg, 3500);
      if (/未登录|失效/.test(msg)) showLogin();
    } finally {
      state.syncing = false;
      hideMask();
    }
  }

  async function doDeepFill() {
    if (state.syncing) { toast("正在同步中…"); return; }
    state.syncing = true;
    showMask("正在查找缺分区的记录…");
    logLine("开始补齐缺失分区");
    try {
      const rows = (await LocalDB.allHistory()).filter((r) => !(r.zone || "").trim());
      if (!rows.length) { toast("没有需要补齐的记录"); return; }
      const limit = Math.min(rows.length, 200);
      const targets = rows.slice(0, limit);
      const filled = await Bili.deepFill(state.cookie, targets, limit, (i, n) => {
        setMask(`补齐分区 ${i}/${n}`);
      });
      await LocalDB.putHistory(targets);
      const n = await LocalStore.recategorizeAll();
      logLine(`补齐分区 ${filled} 条，重算分类 ${n} 条`);
      toast(`补齐 ${filled} 条分区`);
      refreshAll();
    } catch (e) {
      logLine("补齐失败：" + (e.message || e));
      toast("补齐失败：" + (e.message || e), 3000);
    } finally {
      state.syncing = false;
      hideMask();
    }
  }

  // ---------------- 概览 ----------------
  async function renderOverview() {
    const o = await LocalStore.overview();
    els.stats.innerHTML = [
      [fmtNum(o.total_views), "观看次数"],
      [fmtNum(o.total_videos), "视频数"],
      [fmtNum(o.authors), "UP 主"],
      [o.zones, "分区"],
    ].map(([v, k]) => `<div class="stat"><b>${v}</b><em>${k}</em></div>`).join("");
    const lastSync = parseInt(await LocalDB.getSetting("last_sync") || "0", 10);
    els.mSub.textContent = lastSync ? `上次同步 ${fmtTime(lastSync)}` : "还没有同步过";

    // 环图：conic-gradient
    const total = o.categories.reduce((s, c) => s + c.views, 0);
    if (total > 0) {
      let acc = 0;
      const segs = o.categories.slice(0, 8).map((c) => {
        const a0 = acc / total * 360; acc += c.views;
        return `${c.color} ${a0}deg ${acc / total * 360}deg`;
      });
      els.donut.style.background = `conic-gradient(${segs.join(",")})`;
      els.donut.classList.add("has-data");
      els.donut.innerHTML = `<div class="hole"><b>${fmtNum(total)}</b><em>观看次数</em></div>`;
      els.legend.innerHTML = o.categories.slice(0, 8).map((c) =>
        `<li><i class="dot" style="background:${c.color}"></i><span class="nm">${esc(c.name)}</span>` +
        `<span class="vl">${c.views} 次</span><span class="pc">${Math.round(c.views / total * 100)}%</span></li>`).join("");
    } else {
      els.donut.style.background = "var(--line)";
      els.donut.classList.add("has-data");
      els.donut.innerHTML = `<div class="hole"><b>0</b><em>观看次数</em></div>`;
      els.legend.innerHTML = `<li class="empty">暂无数据，点右上角「同步」拉取观看历史</li>`;
    }

    // 近 30 天趋势
    const tr = await LocalStore.trend(30);
    const maxT = Math.max(1, ...tr.map((d) => d.count));
    els.trend.innerHTML = tr.map((d) =>
      `<div class="b" style="height:${Math.max(2, Math.round(d.count / maxT * 100))}%" title="${d.date}：${d.count} 次"></div>`).join("");
    setAxis(els.trend, [tr[0] ? tr[0].date.slice(5) : "", tr[14] ? tr[14].date.slice(5) : "", tr[29] ? tr[29].date.slice(5) : ""]);

    // 时段分布
    const hd = await LocalStore.hourDist();
    const maxH = Math.max(1, ...hd.map((d) => d.count));
    els.hours.innerHTML = hd.map((d) =>
      `<div class="b" style="height:${Math.max(2, Math.round(d.count / maxH * 100))}%" title="${d.hour} 点：${d.count} 次"></div>`).join("");
    setAxis(els.hours, ["0 时", "6 时", "12 时", "18 时", "23 时"]);

    // 常看 UP 主
    const ups = await LocalStore.topAuthors(6);
    const maxU = Math.max(1, ...ups.map((u) => u.count));
    els.uplist.innerHTML = ups.length
      ? ups.map((u) => `<div class="r"><span class="n">${esc(u.name)}</span><span class="v">${u.count} 次</span>` +
          `<div class="track"><div class="fill" style="width:${Math.round(u.count / maxU * 100)}%"></div></div></div>`).join("")
      : `<div class="empty">暂无数据</div>`;
  }

  function setAxis(barsEl, labels) {
    let ax = barsEl.nextElementSibling;
    if (!ax || !ax.classList.contains("axis")) {
      ax = document.createElement("div");
      ax.className = "axis";
      barsEl.parentElement.appendChild(ax);
    }
    ax.innerHTML = labels.map((l) => `<span>${esc(l)}</span>`).join("");
  }

  // ---------------- 视频列表 ----------------
  async function renderChips() {
    const o = await LocalStore.overview();
    const chips = [{ id: "all", name: "全部" }].concat(o.categories.map((c) => ({ id: c.id, name: c.name })));
    els.chips.innerHTML = chips.map((c) =>
      `<button class="chip${state.videos.category === c.id ? " is-active" : ""}" data-cat="${c.id}">${esc(c.name)}</button>`).join("");
    els.chips.querySelectorAll(".chip").forEach((b) =>
      b.addEventListener("click", () => { state.videos.category = b.dataset.cat; state.videos.page = 1; renderVideos(true); }));
  }

  async function renderVideos(reset) {
    if (reset) { renderChips(); }
    const v = state.videos;
    const r = await LocalStore.listVideos({ category: v.category, q: v.q, sort: v.sort, page: v.page, size: 30 });
    v.total = r.total;
    const html = r.items.map((it) => `
      <div class="vitem" data-url="${esc(it.url)}">
        <div class="vcover">${it.cover ? `<img loading="lazy" src="${esc(it.cover)}" onerror="this.remove()" alt="">` : ""}</div>
        <div class="vbody">
          <a class="vtitle">${esc(it.title)}</a>
          <div class="vmeta">
            <span class="vtag${it.locked ? " lock" : ""}" data-bvid="${esc(it.bvid)}"><i style="background:${it.category_color}"></i>${esc(it.category_name)}</span>
            <span>${esc(it.author_name)}</span>
            ${it.duration ? `<span>${fmtDur(it.duration)}</span>` : ""}
          </div>
          <div class="vmeta"><span>看过 ${it.views} 次</span><span>${fmtTime(it.last_view_at)}</span></div>
        </div>
      </div>`).join("");
    if (v.page === 1) els.vlist.innerHTML = html || `<div class="empty">暂无记录${v.q || v.category !== "all" ? "，换个条件试试" : "，点上方「同步」拉取"}</div>`;
    else els.vlist.insertAdjacentHTML("beforeend", html);
    els.btnMore.parentElement.style.display = (v.page * 30 < r.total) ? "" : "none";

    els.vlist.querySelectorAll(".vitem").forEach((row) => {
      if (row.dataset.bound) return;
      row.dataset.bound = "1";
      row.addEventListener("click", (e) => {
        if (e.target.closest(".vtag")) return;
        const url = row.dataset.url;
        if (url) window.open(url, "_blank");
      });
    });
    els.vlist.querySelectorAll(".vtag[data-bvid]").forEach((b) => {
      if (b.dataset.bound) return;
      b.dataset.bound = "1";
      b.addEventListener("click", () => pickCategory(b.dataset.bvid));
    });
  }

  // 轻量动作面板：改分类
  function pickCategory(bvid) {
    if (!bvid) return;
    const old = document.querySelector(".cat-sheet-mask");
    if (old) old.remove();
    const mask = document.createElement("div");
    mask.className = "cat-sheet-mask";
    const btns = Classifier.CATEGORIES.map(([id, name, color]) =>
      `<button class="cat-sheet-btn" data-id="${id}"><i style="background:${color}"></i>${esc(name)}</button>`).join("");
    mask.innerHTML = `<div class="cat-sheet"><h4>修改分类（该视频所有记录）</h4><div class="cat-sheet-grid">${btns}</div><button class="cat-sheet-cancel">取消</button></div>`;
    document.body.appendChild(mask);
    mask.addEventListener("click", async (e) => {
      const b = e.target.closest(".cat-sheet-btn");
      if (b) {
        await LocalStore.setOverride(bvid, b.dataset.id);
        mask.remove();
        toast("分类已更新");
        renderVideos(true);
        return;
      }
      if (e.target === mask || e.target.closest(".cat-sheet-cancel")) mask.remove();
    });
  }

  // ---------------- 我的 ----------------
  async function renderMine() {
    const uname = state.uname || (await LocalDB.getSetting("uname")) || "";
    state.uname = uname;
    els.acctName.textContent = uname || "已登录";
    els.acctFace.textContent = uname ? uname[0] : "已";
    els.acctState.textContent = Bili.isNative() ? "原生通道 · 直连 B 站" : "浏览器通道（同步受限）";
    els.swAutoOpen.checked = (await LocalDB.getSetting("auto_sync_open")) === "1";

    const o = await LocalStore.overview();
    const lastSync = parseInt(await LocalDB.getSetting("last_sync") || "0", 10);
    els.dataInfo.textContent = `本地共 ${o.total_views} 条观看记录 · ${o.total_videos} 个视频` +
      (lastSync ? ` · 上次同步 ${fmtTime(lastSync)}` : "") + "。数据只保存在这台手机里。";

    // 规则
    els.rc.innerHTML = Classifier.CATEGORIES.map(([id, name]) => `<option value="${id}">${name}</option>`).join("");
    await renderRules();
  }
  async function renderRules() {
    const rules = await LocalDB.getRules();
    const ks = Object.keys(rules);
    els.ruleList.innerHTML = ks.length
      ? ks.sort().map((k) => {
          const cid = rules[k];
          const name = Classifier.CAT_NAME[cid] || cid;
          return `<span class="rule">${esc(k)} → ${esc(name)}<button class="x" data-k="${esc(k)}">×</button></span>`;
        }).join("")
      : `<div class="empty">还没有自定义规则</div>`;
    els.ruleList.querySelectorAll(".x").forEach((x) =>
      x.addEventListener("click", async () => {
        await LocalDB.deleteRule(x.dataset.k);
        await LocalStore.recategorizeAll();
        renderRules();
        toast("规则已删除并重算分类");
      }));
  }

  // ---------------- 数据 ----------------
  async function doExport() {
    try {
      const data = await LocalStore.exportData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `bili-history-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      logLine(`已导出 ${data.count} 条记录`);
      toast("备份已导出");
    } catch (e) { toast("导出失败：" + (e.message || e)); }
  }
  async function doImport(file) {
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      const r = await LocalStore.importData(payload);
      logLine(`导入完成：文件 ${r.total} 条，新增 ${r.added} 条`);
      toast(`导入完成，新增 ${r.added} 条`);
      refreshAll();
    } catch (e) { toast("导入失败：" + (e.message || e), 3000); }
  }
  async function doClear() {
    if (!confirm("确定清空本机全部观看记录、规则和设置吗？此操作不可恢复！")) return;
    if (!confirm("再次确认：清空后只能重新同步或导入备份。继续清空？")) return;
    await LocalDB.clearAll();
    logLine("已清空本地数据");
    toast("已清空");
    refreshAll();
  }

  function refreshAll() {
    if (els.mainView.hidden) return;
    if (state.page === "overview") renderOverview();
    else if (state.page === "videos") renderVideos(true);
    else renderMine();
  }

  // ---------------- 事件绑定 ----------------
  function bind() {
    // 登录页 tab
    [els.tabQr, els.tabCk].forEach((b) => b.addEventListener("click", () => {
      [els.tabQr, els.tabCk].forEach((x) => x.classList.toggle("is-active", x === b));
      els.panelQr.hidden = b.dataset.lt !== "qr";
      els.panelCk.hidden = b.dataset.lt !== "ck";
      els.loginErr.textContent = "";
    }));
    els.btnQrGen.addEventListener("click", genQr);
    els.btnCkLogin.addEventListener("click", loginByCookie);

    // 底部 tab
    document.querySelectorAll(".m-tab").forEach((b) =>
      b.addEventListener("click", () => switchPage(b.dataset.tab)));

    // 同步
    els.btnSyncTop.addEventListener("click", doSync);
    els.btnSync.addEventListener("click", doSync);
    els.btnDeep.addEventListener("click", doDeepFill);

    // 视频筛选
    let searchTimer = 0;
    els.search.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { state.videos.q = els.search.value.trim(); state.videos.page = 1; renderVideos(true); }, 300);
    });
    els.sort.addEventListener("change", () => { state.videos.sort = els.sort.value; state.videos.page = 1; renderVideos(true); });
    els.btnMore.addEventListener("click", () => { state.videos.page += 1; renderVideos(false); });

    // 我的
    els.btnLogout.addEventListener("click", logout);
    els.swAutoOpen.addEventListener("change", () => LocalDB.setSetting("auto_sync_open", els.swAutoOpen.checked ? "1" : "0"));
    els.btnAddRule.addEventListener("click", async () => {
      const k = els.rk.value.trim();
      if (!k) { toast("请输入关键词"); return; }
      await LocalDB.putRule(k, els.rc.value);
      els.rk.value = "";
      const n = await LocalStore.recategorizeAll();
      renderRules();
      toast(`规则已添加，重算 ${n} 条分类`);
    });
    els.btnRecat.addEventListener("click", async () => {
      const n = await LocalStore.recategorizeAll();
      toast(`已重算 ${n} 条分类`);
      refreshAll();
    });
    els.btnExport.addEventListener("click", doExport);
    els.btnImport.addEventListener("click", () => els.importFile.click());
    els.importFile.addEventListener("change", () => {
      if (els.importFile.files && els.importFile.files[0]) doImport(els.importFile.files[0]);
      els.importFile.value = "";
    });
    els.btnClear.addEventListener("click", doClear);
  }

  // ---------------- 启动 ----------------
  async function boot() {
    bind();
    await LocalDB.open();
    const cookie = await LocalDB.getSetting("cookie");
    state.uname = (await LocalDB.getSetting("uname")) || "";
    if (cookie) {
      state.cookie = cookie;
      showMain();
      // 校验登录态（失败不强制踢出，提示即可）
      Bili.checkLogin(cookie).then((r) => {
        if (!r.ok) { toast(r.msg, 3500); showLogin(); }
        else if (r.uname && r.uname !== state.uname) {
          state.uname = r.uname; LocalDB.setSetting("uname", r.uname); renderMine();
        }
      }).catch(() => {});
      // 打开自动同步
      if ((await LocalDB.getSetting("auto_sync_open")) === "1") doSync();
    } else {
      showLogin();
    }
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
