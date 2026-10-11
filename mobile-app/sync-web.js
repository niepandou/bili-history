/* 把 web/ 里的手机端资源拷到 www/，并以 mobile.html 作为 App 入口 index.html */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const SRC = path.join(ROOT, "..", "web");
const DST = path.join(ROOT, "www");

// 手机端不需要的文件（桌面端页面、Service Worker 等）
const SKIP = new Set(["index.html", "app.js", "style.css", "sw.js", "manifest.webmanifest"]);

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (SKIP.has(name)) continue;
    const s = path.join(src, name);
    const d = path.join(dst, name);
    const st = fs.statSync(s);
    if (st.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

fs.rmSync(DST, { recursive: true, force: true });
copyDir(SRC, DST);
// 入口：mobile.html -> index.html
fs.copyFileSync(path.join(SRC, "mobile.html"), path.join(DST, "index.html"));
console.log("www 已更新，入口为 mobile.html");
