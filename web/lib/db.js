/* B站历史记录仪 —— 手机端本地数据层
   数据全部存在手机 IndexedDB 里，和电脑端完全无关。
   结构与统计口径对齐电脑端 app_core/store.py，保证两端看到的结果一致。 */
"use strict";

const LocalDB = (() => {
  const NAME = "bili_history_mobile";
  const VER = 1;
  let _db = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VER);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains("history")) {
          const s = db.createObjectStore("history", { keyPath: "hid" });
          s.createIndex("bvid", "bvid", { unique: false });
          s.createIndex("category", "category", { unique: false });
          s.createIndex("view_at", "view_at", { unique: false });
        }
        if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv", { keyPath: "key" });
        if (!db.objectStoreNames.contains("rules")) db.createObjectStore("rules", { keyPath: "keyword" });
        if (!db.objectStoreNames.contains("overrides")) db.createObjectStore("overrides", { keyPath: "bvid" });
      };
      req.onsuccess = () => { _db = req.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }

  function tx(store, mode) {
    return open().then((db) => db.transaction(store, mode).objectStore(store));
  }
  function wrap(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function txDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  return {
    open,
    async getSetting(key) {
      const r = await wrap((await tx("kv", "readonly")).get(key));
      return r ? r.value : null;
    },
    async setSetting(key, value) {
      const store = await tx("kv", "readwrite");
      await wrap(store.put({ key, value: String(value) }));
      await txDone(store.transaction);
    },
    async allSettings() {
      const rows = await wrap((await tx("kv", "readonly")).getAll());
      const out = {};
      rows.forEach((r) => { out[r.key] = r.value; });
      return out;
    },
    async allHistory() {
      return wrap((await tx("history", "readonly")).getAll());
    },
    async putHistory(items) {
      const store = await tx("history", "readwrite");
      items.forEach((it) => store.put(it));
      await txDone(store.transaction);
    },
    async clearHistory() {
      const store = await tx("history", "readwrite");
      await wrap(store.clear());
      await txDone(store.transaction);
    },
    async getRules() {
      const rows = await wrap((await tx("rules", "readonly")).getAll());
      const out = {};
      rows.forEach((r) => { out[r.keyword] = r.category; });
      return out;
    },
    async putRule(keyword, category) {
      const store = await tx("rules", "readwrite");
      await wrap(store.put({ keyword, category }));
      await txDone(store.transaction);
    },
    async deleteRule(keyword) {
      const store = await tx("rules", "readwrite");
      await wrap(store.delete(keyword));
      await txDone(store.transaction);
    },
    async getOverrides() {
      const rows = await wrap((await tx("overrides", "readonly")).getAll());
      const out = {};
      rows.forEach((r) => { out[r.bvid] = r.category; });
      return out;
    },
    async putOverride(bvid, category) {
      const store = await tx("overrides", "readwrite");
      await wrap(store.put({ bvid, category }));
      await txDone(store.transaction);
    },
    async clearAll() {
      for (const s of ["history", "rules", "overrides"]) {
        const store = await tx(s, "readwrite");
        await wrap(store.clear());
        await txDone(store.transaction);
      }
    },
  };
})();

/* 高层数据访问：在 IndexedDB 之上做分类与统计（对齐 store.py 的口径） */
const LocalStore = (() => {
  const DEVICE_MAP = { "2": "Android", "3": "iOS", "4": "iPad", "5": "网页" };
  const C = () => window.Classifier;

  async function upsertItems(items) {
    const rules = await LocalDB.getRules();
    const ovd = await LocalDB.getOverrides();
    const existing = new Set((await LocalDB.allHistory()).map((r) => r.hid));
    let added = 0;
    const rows = items.map((it) => {
      const bvid = it.bvid || "";
      let cat, src;
      if (bvid && ovd[bvid]) { cat = ovd[bvid]; src = "manual"; }
      else { [cat, src] = C().classify(it.title || "", it.zone || "", it.author_name || "", rules); }
      if (!existing.has(it.hid)) added += 1;
      return Object.assign({}, it, { category: cat, category_source: src });
    });
    await LocalDB.putHistory(rows);
    return added;
  }

  function groupByBvid(rows) {
    const m = new Map();
    for (const r of rows) {
      const key = r.bvid || r.hid;
      let g = m.get(key);
      if (!g) {
        g = {
          bvid: r.bvid, title: r.title, cover: r.cover, author_name: r.author_name,
          author_mid: r.author_mid, author_face: r.author_face, zone: r.zone,
          duration: r.duration, category: r.category, category_source: r.category_source,
          views: 0, last_view_at: 0,
        };
        m.set(key, g);
      }
      g.views += 1;
      if ((r.view_at || 0) > g.last_view_at) {
        g.last_view_at = r.view_at;
        g.title = r.title; g.cover = r.cover; g.zone = r.zone; g.category = r.category;
        g.category_source = r.category_source; g.duration = r.duration;
        g.author_name = r.author_name; g.author_mid = r.author_mid;
      }
    }
    return Array.from(m.values());
  }

  async function listVideos({ category = "", q = "", page = 1, size = 40, sort = "recent" } = {}) {
    let rows = await LocalDB.allHistory();
    if (category && category !== "all") rows = rows.filter((r) => (r.category || "other") === category);
    if (q) {
      const s = q.toLowerCase();
      rows = rows.filter((r) =>
        (r.title || "").toLowerCase().includes(s) ||
        (r.author_name || "").toLowerCase().includes(s) ||
        (r.zone || "").toLowerCase().includes(s));
    }
    let vids = groupByBvid(rows);
    const orders = {
      recent: (a, b) => b.last_view_at - a.last_view_at,
      count: (a, b) => b.views - a.views,
      title: (a, b) => String(a.title).localeCompare(String(b.title), "zh"),
    };
    vids.sort(orders[sort] || orders.recent);
    const total = vids.length;
    const start = (page - 1) * size;
    const items = vids.slice(start, start + size).map((v) => {
      const cid = v.category || "other";
      return Object.assign({}, v, {
        category: cid,
        category_name: C().CAT_NAME[cid] || "其他",
        category_color: (C().CAT_MAP[cid] || C().CAT_MAP.other)[2],
        locked: (v.category_source || "") === "manual",
        url: v.bvid ? `https://www.bilibili.com/video/${v.bvid}` : "",
      });
    });
    return { items, total, page, size };
  }

  async function overview() {
    const rows = await LocalDB.allHistory();
    const total = rows.length;
    const bvids = new Set(), mids = new Set(), zones = new Set();
    let first = 0, last = 0;
    const catAgg = new Map();
    for (const r of rows) {
      if (r.bvid) bvids.add(r.bvid);
      if (r.author_mid) mids.add(r.author_mid);
      if (r.zone) zones.add(r.zone);
      const t = r.view_at || 0;
      if (t > 0) { if (!first || t < first) first = t; if (t > last) last = t; }
      const cid = r.category || "other";
      let a = catAgg.get(cid);
      if (!a) { a = { views: 0, vids: new Set() }; catAgg.set(cid, a); }
      a.views += 1;
      if (r.bvid) a.vids.add(r.bvid);
    }
    const cats = Array.from(catAgg.entries())
      .map(([cid, a]) => ({
        id: cid, name: C().CAT_NAME[cid] || "其他",
        color: (C().CAT_MAP[cid] || C().CAT_MAP.other)[2],
        views: a.views, videos: a.vids.size,
      }))
      .sort((x, y) => y.views - x.views);
    return { total_views: total, total_videos: bvids.size, authors: mids.size, zones: zones.size, first_view_at: first, last_view_at: last, categories: cats };
  }

  function dayKey(ts) {
    const d = new Date(ts * 1000);
    const p = (n) => (n < 10 ? "0" + n : n);
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  async function trend(days = 30) {
    const rows = await LocalDB.allHistory();
    const now = new Date(); now.setHours(0, 0, 0, 0);
    const cutoff = Math.floor(now.getTime() / 1000) - (days - 1) * 86400;
    const m = new Map();
    for (const r of rows) {
      const t = r.view_at || 0;
      if (t >= cutoff) { const k = dayKey(t); m.set(k, (m.get(k) || 0) + 1); }
    }
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86400000);
      const p = (n) => (n < 10 ? "0" + n : n);
      const k = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
      out.push({ date: k, count: m.get(k) || 0 });
    }
    return out;
  }

  async function hourDist() {
    const rows = await LocalDB.allHistory();
    const m = new Array(24).fill(0);
    rows.forEach((r) => { if (r.view_at) m[new Date(r.view_at * 1000).getHours()] += 1; });
    return m.map((count, hour) => ({ hour, count }));
  }

  async function deviceDist() {
    const rows = await LocalDB.allHistory();
    const m = new Map();
    rows.forEach((r) => { const d = r.device || ""; m.set(d, (m.get(d) || 0) + 1); });
    return Array.from(m.entries())
      .map(([d, count]) => ({ device: DEVICE_MAP[d] || "其他", count }))
      .sort((a, b) => b.count - a.count);
  }

  async function topAuthors(limit = 6) {
    const rows = await LocalDB.allHistory();
    const m = new Map();
    rows.forEach((r) => {
      if (!r.author_name) return;
      const k = r.author_mid || r.author_name;
      let a = m.get(k);
      if (!a) { a = { name: r.author_name, count: 0 }; m.set(k, a); }
      a.count += 1;
    });
    return Array.from(m.values()).sort((a, b) => b.count - a.count).slice(0, limit);
  }

  async function setOverride(bvid, category) {
    await LocalDB.putOverride(bvid, category);
    const rows = await LocalDB.allHistory();
    rows.forEach((r) => { if (r.bvid === bvid) { r.category = category; r.category_source = "manual"; } });
    await LocalDB.putHistory(rows);
  }

  async function recategorizeAll() {
    const rules = await LocalDB.getRules();
    const rows = await LocalDB.allHistory();
    let n = 0;
    rows.forEach((r) => {
      if ((r.category_source || "") === "manual") return;
      const [cat, src] = C().classify(r.title || "", r.zone || "", r.author_name || "", rules);
      r.category = cat; r.category_source = src; n += 1;
    });
    await LocalDB.putHistory(rows);
    return n;
  }

  async function exportData() {
    const [history, rules, overrides, settings] = await Promise.all([
      LocalDB.allHistory(), LocalDB.getRules(), LocalDB.getOverrides(), LocalDB.allSettings(),
    ]);
    return {
      app: "BiliHistory-Mobile", version: 1,
      exported_at: new Date().toISOString(),
      count: history.length, history, rules, overrides, settings,
    };
  }

  async function importData(payload) {
    // 兼容电脑端导出的 {items:[...]} 以及手机端自己的完整备份 {history:[...]}
    let items = [];
    if (Array.isArray(payload.history)) items = payload.history;
    else if (Array.isArray(payload.items)) {
      items = payload.items.map((v) => ({
        hid: `archive:${v.bvid}:${v.last_view_at || 0}`, bvid: v.bvid || "",
        title: v.title || "", author_name: v.author || v.author_name || "",
        zone: v.zone || "", duration: 0, cover: "", view_at: v.last_view_at || 0,
        device: "", business: "archive", page: 1, part: "", uri: "",
      }));
    }
    if (!items.length) throw new Error("文件里没有可导入的记录");
    const added = await upsertItems(items);
    if (payload.rules) for (const k in payload.rules) await LocalDB.putRule(k, payload.rules[k]);
    if (payload.overrides) for (const b in payload.overrides) await LocalDB.putOverride(b, payload.overrides[b]);
    return { added, total: items.length };
  }

  return {
    upsertItems, listVideos, overview, trend, hourDist, deviceDist, topAuthors,
    setOverride, recategorizeAll, exportData, importData,
  };
})();

if (typeof window !== "undefined") { window.LocalDB = LocalDB; window.LocalStore = LocalStore; }
