/* B站历史记录仪 —— 手机端 B站接口客户端
   关键：APK 里走 Capacitor 原生 HTTP（不受浏览器跨域限制，可直连 api.bilibili.com），
   浏览器里退回 fetch（仅用于开发调试，正式同步依赖原生层）。
   WBI 签名、字段解析与电脑端 app_core/bilibili.py 完全一致。 */
"use strict";

const Bili = (() => {
  const API_CURSOR = "https://api.bilibili.com/x/web-interface/history/cursor";
  const API_VIEW = "https://api.bilibili.com/x/web-interface/view";
  const ME = "https://api.bilibili.com/x/web-interface/nav";
  const QR_GEN = "https://passport.bilibili.com/x/passport-login/qrcode/generate";
  const QR_POLL = "https://passport.bilibili.com/x/passport-login/qrcode/poll";

  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

  const MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
    37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
    22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
  ];
  const PAGE_SIZE = 30; // cursor 接口硬上限，切勿上调

  let _wbiCache = { keys: null, ts: 0 };

  class SyncError extends Error {}

  function isNative() {
    return !!(window.Capacitor && window.Capacitor.isNativePlatform &&
      window.Capacitor.isNativePlatform() && window.Capacitor.Plugins &&
      window.Capacitor.Plugins.CapacitorHttp);
  }

  function baseHeaders(cookie) {
    const h = {
      "User-Agent": UA,
      "Referer": "https://www.bilibili.com/",
      "Origin": "https://www.bilibili.com",
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "zh-CN,zh;q=0.9",
    };
    const c = sanitizeCookie(cookie || "");
    if (c) h["Cookie"] = c;
    return h;
  }

  /* 统一发请求，返回 {data, status, headers}。data 为解析后的 JSON 对象。 */
  async function http(url, { method = "GET", headers = {}, params = null, timeout = 20000 } = {}) {
    if (params) {
      const qs = Object.keys(params).map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(params[k])).join("&");
      url += (url.includes("?") ? "&" : "?") + qs;
    }
    if (isNative()) {
      const { CapacitorHttp } = window.Capacitor.Plugins;
      try {
        const resp = await CapacitorHttp.request({ method, url, headers, responseType: "json", connectTimeout: timeout, readTimeout: timeout });
        let data = resp.data;
        if (typeof data === "string") { try { data = JSON.parse(data); } catch (e) { data = { code: -1, message: data.slice(0, 200) }; } }
        return { data, status: resp.status, headers: resp.headers || {} };
      } catch (e) {
        throw new SyncError("网络请求失败：" + (e && e.message ? e.message : e));
      }
    }
    // 浏览器 fallback（开发调试用；B站接口跨域会被拦，正式同步请用安装版 App）
    try {
      // 直接透传完整请求头：浏览器会静默忽略 Cookie/Referer 等 forbidden header，
      // 而在 Node 等无 CORS 环境里则会全部发出（便于端到端自测 WBI 签名）。
      const r = await fetch(url, { method, headers, credentials: "omit" });
      const text = await r.text();
      let data; try { data = JSON.parse(text); } catch (e) { data = { code: -1, message: text.slice(0, 200) }; }
      return { data, status: r.status, headers: {} };
    } catch (e) {
      throw new SyncError("浏览器跨域受限，无法直连 B站接口。请使用安装版 App 同步。");
    }
  }

  // ---------------- Cookie 清洗（对齐 Python sanitize_cookie） ----------------
  function sanitizeCookie(raw) {
    if (!raw) return "";
    let s = String(raw).trim();
    s = s.replace(/^\s*cookie\s*[:：]\s*/i, "");
    s = s.replace(/[\r\n\t]+/g, "; ");
    s = s.replace(/；/g, ";").replace(/，/g, ",").replace(/　/g, " ");
    s = s.replace(/\s+/g, " ");
    const parts = s.split(";").map((p) => p.trim()).filter((p) => p.includes("=") && p);
    const seen = {};
    for (const p of parts) { const k = p.split("=", 1)[0].trim(); if (k) seen[k] = p; }
    return Object.keys(seen).map((k) => seen[k]).join("; ");
  }
  function cookieInfo(raw) {
    const cleaned = sanitizeCookie(raw);
    const has = (k) => new RegExp("(?:^|;\\s*)" + k + "=", "i").test(cleaned);
    return {
      cleaned, changed: cleaned !== (raw || "").trim(), length: cleaned.length,
      has_sessdata: has("SESSDATA"), has_bili_jct: has("bili_jct"),
      has_dedeuserid: has("DedeUserID"), has_buvid3: has("buvid3"),
    };
  }

  // ---------------- WBI 签名 ----------------
  function mixinKey(imgKey, subKey) {
    const raw = (imgKey || "") + (subKey || "");
    return MIXIN_KEY_ENC_TAB.filter((i) => i < raw.length).map((i) => raw[i]).join("").slice(0, 32);
  }
  function fileKey(url) {
    const name = (url || "").split("/").pop();
    return (name || "").split(".")[0];
  }
  async function fetchWbiKeys(cookie) {
    const { data } = await http(ME, { headers: baseHeaders(cookie) });
    const wbi = (data.data && data.data.wbi_img) || {};
    const imgKey = fileKey(wbi.img_url || "");
    const subKey = fileKey(wbi.sub_url || "");
    if (!imgKey || !subKey) throw new SyncError("无法获取 WBI 签名参数，请检查登录态是否有效");
    return [imgKey, subKey];
  }
  async function getWbiKeys(cookie, force) {
    const now = Math.floor(Date.now() / 1000);
    if (!force && _wbiCache.keys && now - _wbiCache.ts < 3600) return _wbiCache.keys;
    const keys = await fetchWbiKeys(cookie);
    _wbiCache = { keys, ts: now };
    return keys;
  }
  async function wbiSign(params, cookie) {
    const [imgKey, subKey] = await getWbiKeys(cookie);
    const mixin = mixinKey(imgKey, subKey);
    const p = Object.assign({}, params);
    p.wts = Math.floor(Date.now() / 1000);
    const clean = (v) => String(v).replace(/[!'()*]/g, "");
    const query = Object.keys(p).sort()
      .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(clean(p[k]))).join("&");
    p.w_rid = window.md5(query + mixin);
    return p;
  }

  async function get(url, cookie, params, signed = true) {
    let p = Object.assign({}, params || {});
    if (signed) { try { p = await wbiSign(p, cookie); } catch (e) { /* 签名失败退化为裸参 */ } }
    const { data, status } = await http(url, { headers: baseHeaders(cookie), params: p });
    if (status >= 400) throw new SyncError(`HTTP ${status}（${(data && data.message) || "接口拒绝"}）`);
    return data;
  }

  // ---------------- 登录校验 ----------------
  async function checkLogin(cookie) {
    const info = cookieInfo(cookie);
    if (!info.cleaned) return { ok: false, uname: "", msg: "Cookie 为空" };
    if (!info.has_sessdata) return { ok: false, uname: "", msg: "Cookie 里没找到 SESSDATA，请确认已完整复制" };
    let j;
    try { j = await get(ME, cookie, null, false); }
    catch (e) { return { ok: false, uname: "", msg: String(e.message || e) }; }
    const code = j.code, data = j.data || {};
    if (code === 0 && data.isLogin) return { ok: true, uname: data.uname || "", msg: "登录状态正常" };
    if (code === -101) return { ok: false, uname: "", msg: "账号未登录：SESSDATA 已失效或过期，请重新获取" };
    return { ok: false, uname: "", msg: `登录校验失败（code=${code}：${j.message || ""}）` };
  }

  // ---------------- 字段整理（对齐 Python _normalize） ----------------
  function pick(d, ...keys) {
    for (const k of keys) { const v = d[k]; if (v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length)) return v; }
    return "";
  }
  function normalize(raw) {
    const owner = raw.owner || raw.author || {};
    const hist = raw.history || {};
    let title = pick(raw, "title", "long_title") || raw.long_title || "";
    let bvid = pick(raw, "bvid", "bv_id") || hist.bvid || "";
    let view_at = parseInt(pick(raw, "view_at", "dt") || 0, 10) || 0;
    if (!view_at) view_at = parseInt(hist.dt || raw.viewed_at || 0, 10) || 0;
    const business = pick(raw, "business") || "archive";
    const oid = pick(raw, "oid", "cid") || "0";
    let zone = pick(raw, "tag_name", "tname", "subtitle") || "";
    if (Array.isArray(zone)) zone = zone.join("/");
    const hid = `${business}:${bvid || oid}:${view_at}`;
    return {
      hid, bvid,
      aid: parseInt(pick(raw, "aid") || 0, 10) || 0,
      cid: parseInt(pick(raw, "cid") || hist.cid || 0, 10) || 0,
      title: String(title).trim(),
      cover: String(pick(raw, "cover", "pic") || ""),
      duration: parseInt(pick(raw, "duration", "page_duration") || 0, 10) || 0,
      author_mid: parseInt(owner.mid || raw.author_mid || 0, 10) || 0,
      author_name: String(owner.name || raw.author_name || ""),
      author_face: String(owner.face || raw.author_face || ""),
      zone: String(zone), business,
      page: parseInt(pick(raw, "page") || 1, 10) || 1,
      part: String(pick(raw, "part") || ""),
      uri: String(pick(raw, "uri") || ""),
      device: String(pick(raw, "device") || ""),
      view_at,
    };
  }

  function friendlyError(code, msg) {
    const table = {
      "-101": "账号未登录：SESSDATA 已失效，请重新登录或复制 Cookie",
      "-111": "CSRF 校验失败：Cookie 缺少 bili_jct",
      "-352": "触发风控：Cookie 不完整或缺少 buvid3，建议扫码登录",
      "-403": "访问权限不足：WBI 签名校验失败，请重试",
      "-412": "请求被拦截（风控）：请降低同步频率",
      "-509": "请求过于频繁：请稍等几分钟再同步",
      "-400": "请求参数错误：请重试",
    };
    return table[String(code)] || `接口返回 ${code}：${msg}`;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------- 拉取历史 ----------------
  async function fetchHistory(cookie, maxPages = 0, progress) {
    const login = await checkLogin(cookie);
    if (!login.ok) throw new SyncError(login.msg);
    const items = [];
    let page = 1, maxVal = null, viewVal = null;
    while (true) {
      const params = { type: "all", ps: PAGE_SIZE };
      if (page > 1) { params.max = maxVal; params.view_at = viewVal; }
      let j = await get(API_CURSOR, cookie, params);
      if (j.code !== 0 && [-403, -352, -412].includes(j.code)) {
        try { await getWbiKeys(cookie, true); j = await get(API_CURSOR, cookie, params); } catch (e) {}
      }
      if (j.code !== 0) throw new SyncError(friendlyError(j.code, j.message || "未知错误"));
      const data = j.data || {};
      const batch = data.list || [];
      if (!batch.length) break;
      for (const raw of batch) { try { items.push(normalize(raw)); } catch (e) {} }
      const cur = data.cursor || {};
      if (progress) progress(page, items.length);
      const nMax = cur.max, nView = cur.view_at;
      if ((!nMax || !nView) || batch.length < PAGE_SIZE) break;
      maxVal = nMax; viewVal = nView; page += 1;
      if (maxPages && page > maxPages) break;
      await sleep(350);
    }
    return { items, login };
  }

  async function deepFill(cookie, rows, limit = 200, progress) {
    const need = rows.filter((r) => r.bvid && !(r.zone || "").trim()).slice(0, limit);
    let filled = 0;
    for (let i = 0; i < need.length; i++) {
      const r = need[i];
      try {
        const j = await get(API_VIEW, cookie, { bvid: r.bvid });
        if (j.code === 0) {
          const d = j.data || {};
          if (d.tname) { r.zone = d.tname; filled += 1; }
          if (!r.duration && d.duration) r.duration = parseInt(d.duration, 10) || 0;
          if (!r.cover && d.pic) r.cover = d.pic;
        }
      } catch (e) {}
      if (progress) progress(i + 1, need.length);
      await sleep(500);
    }
    return filled;
  }

  // ---------------- 扫码登录 ----------------
  async function qrGenerate() {
    const { data } = await http(QR_GEN, { headers: baseHeaders("") });
    if (data.code !== 0) throw new SyncError("生成二维码失败：" + (data.message || data.code));
    return { url: data.data.url, qrcode_key: data.data.qrcode_key };
  }
  function extractCookie(text) {
    // 从 Set-Cookie 串或 crossDomain URL 里抠出关键字段拼成 Cookie
    const keys = ["SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5", "sid", "buvid3"];
    const found = {};
    const s = String(text || "");
    for (const k of keys) {
      const m = s.match(new RegExp(k + "=([^;&\\s]+)", "i"));
      if (m) found[k] = decodeURIComponent(m[1]);
    }
    const parts = Object.keys(found).map((k) => `${k}=${found[k]}`);
    return parts.length ? parts.join("; ") : "";
  }
  async function qrPoll(qrcode_key) {
    const resp = await http(QR_POLL, { headers: baseHeaders(""), params: { qrcode_key } });
    const d = resp.data.data || {};
    let cookie = "";
    if (d.code === 0) {
      const hdrs = resp.headers || {};
      let sc = hdrs["set-cookie"] || hdrs["Set-Cookie"] || "";
      if (Array.isArray(sc)) sc = sc.join(";");
      cookie = extractCookie(sc) || extractCookie(d.url || "");
    }
    return { code: d.code, message: d.message || "", cookie, url: d.url || "" };
  }

  return {
    sanitizeCookie, cookieInfo, checkLogin, fetchHistory, deepFill,
    qrGenerate, qrPoll, isNative, SyncError, PAGE_SIZE,
  };
})();

if (typeof window !== "undefined") window.Bili = Bili;
