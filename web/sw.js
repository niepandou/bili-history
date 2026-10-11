/* B站历史记录仪 —— Service Worker
   策略：本机服务几乎总是可达 + 迭代频繁，所以一律「网络优先」，
   保证改完代码刷新一次就生效；只有断网时才回退缓存做离线兜底。
   ⚠️ 静态资源千万别改回「缓存优先」，否则用户会一直看到旧版 JS/CSS。 */
const CACHE = "bili-history-shell-v2";

// 网络请求必须带超时：系统休眠 / 服务进程卡住时 fetch 会永久挂起，
// 页面就会一直停在加载状态。超时后回退缓存，至少保证界面能开出来。
const NET_TIMEOUT = 10000;

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("network timeout")), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); },
                 (e) => { clearTimeout(t); reject(e); });
  });
}

const SHELL = [
  "/",
  "/index.html",
  "/assets/style.css",
  "/assets/app.js",
  "/assets/manifest.webmanifest",
  "/assets/icons/icon-192.png",
  "/assets/icons/icon-512.png",
  "/assets/icons/favicon-64.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 接口数据：只走网络，绝不缓存
  if (url.pathname.startsWith("/api/")) {
    e.respondWith(withTimeout(fetch(req), NET_TIMEOUT).catch(() => new Response(
      JSON.stringify({ ok: false, offline: true, msg: "离线：连不上本机服务" }),
      { headers: { "Content-Type": "application/json; charset=utf-8" } }
    )));
    return;
  }

  // 页面导航：网络优先，离线回退到缓存首页
  if (req.mode === "navigate") {
    e.respondWith(
      withTimeout(fetch(req), NET_TIMEOUT)
        .then((r) => {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put("/", copy));
          return r;
        })
        .catch(() => caches.match("/").then((r) => r || caches.match("/index.html")))
    );
    return;
  }

  // 静态资源：网络优先 + 失败回退缓存（本地场景务必保证刷新即生效）
  e.respondWith(
    withTimeout(fetch(req), NET_TIMEOUT)
      .then((r) => {
        if (r && r.ok) {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return r;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match("/index.html")))
  );
});
