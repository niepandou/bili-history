#!/usr/bin/env python3
"""B站历史记录仪 —— 本地服务端（仅 Python 标准库）

启动：  python server.py
可选：  python server.py --port 8770 --silent
"""

import argparse
import json
import os
import socket
import sys
import threading
import time
import webbrowser
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app_core import bilibili, store, system  # noqa: E402
from app_core import config as cfg  # noqa: E402
from app_core.classifier import CATEGORIES, ZONE_MAP  # noqa: E402
from app_core.demo import make_demo  # noqa: E402

ROOT = cfg.ROOT
WEB = cfg.WEB_DIR
MAX_BODY = 8 * 1024 * 1024

_sync_lock = threading.Lock()
_sync_state = {"running": False, "progress": "", "log": []}


class AppServer(ThreadingHTTPServer):
    """独占端口的 HTTP 服务。

    Windows 上默认的 SO_REUSEADDR 会让第二个实例也 bind 成功同一个端口，
    结果是两个进程同时监听、请求被随机分发（表现为时好时坏的 4xx / 旧页面）。
    这里改用 SO_EXCLUSIVEADDRUSE，让重复启动必定失败，从而走端口顺延逻辑。
    """

    daemon_threads = True
    # 默认监听队列只有 5。客户端一屏要并发取 state/overview/videos/rules/network，
    # 再叠上浏览器自己的预连接，队列很快就满 —— 超出的连接会被直接丢弃，
    # 表现就是偶尔某个请求怎么等都等不到回复（像卡住）。放到 128 彻底消除这个抖动。
    request_queue_size = 128

    def server_bind(self):
        if os.name == "nt":
            self.allow_reuse_address = False
            try:
                self.socket.setsockopt(
                    socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            except Exception:
                self.allow_reuse_address = True
        else:
            self.allow_reuse_address = True
        super().server_bind()


def _log(msg: str):
    line = f"[{datetime.now().strftime('%H:%M:%S')}] {msg}"
    _sync_state["log"].append(line)
    _sync_state["log"] = _sync_state["log"][-200:]
    if not _sync_state.get("quiet"):
        print(line, flush=True)


# ============================ 同步 ============================
def run_sync(cookie: str = None, deep: bool = None, max_pages: int = None) -> dict:
    if not _sync_lock.acquire(blocking=False):
        return {"ok": False, "msg": "正在同步中，请稍候"}
    try:
        _sync_state["running"] = True
        s = store.all_settings()
        cookie = bilibili.sanitize_cookie(cookie or s.get("cookie") or "")
        deep = bool(int(s.get("deep_sync") or 0)) if deep is None else deep
        max_pages = int(s.get("max_pages") or 0) if max_pages is None else max_pages
        if not cookie:
            return {"ok": False, "msg": "尚未填写 Cookie"}
        _log("开始同步历史记录…")
        items, login = bilibili.fetch_history(
            cookie, max_pages, progress=lambda p, n: _log(f"第 {p} 页 · 已获取 {n} 条")
        )
        _log(f"共获取 {len(items)} 条原始记录")
        if deep:
            filled = bilibili.deep_fill(
                cookie, items, limit=200,
                progress=lambda i, n: _log(f"补充分区 {i}/{n}")
            )
            _log(f"深度同步补齐 {filled} 条分区信息")
        new = store.upsert_items(items)
        store.checkpoint(full=True)   # 写完立刻收回 WAL，避免它长期只增不减
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        store.set_setting("last_sync_at", now)
        msg = f"完成：新增 {new} 条，累计 {store.overview()['total_views']} 条观看记录"
        store.set_setting("last_sync_result", msg)
        _log(msg)
        return {"ok": True, "new": new, "total": len(items), "uname": login.get("uname", ""), "msg": msg}
    except bilibili.SyncError as e:
        _log(f"失败：{e}")
        return {"ok": False, "msg": str(e)}
    except Exception as e:  # noqa
        _log(f"失败：{e}")
        return {"ok": False, "msg": f"同步异常：{e}"}
    finally:
        _sync_state["running"] = False
        _sync_lock.release()


def _auto_sync_loop():
    ticks = 0
    while True:
        time.sleep(60)
        ticks += 1
        try:
            s = store.all_settings()
            need = True
            if s.get("auto_sync") != "1" or not (s.get("cookie") or "").strip():
                need = False
            if need:
                gap = int(s.get("sync_interval_min") or 180)
                last = s.get("last_sync_at") or ""
                if last:
                    try:
                        delta = datetime.now() - datetime.strptime(last, "%Y-%m-%d %H:%M:%S")
                        if delta.total_seconds() < gap * 60:
                            need = False
                    except ValueError:
                        pass
            if need:
                run_sync()
        except Exception:
            pass
        finally:
            # 兜底：即使没到同步时机，也定期把 WAL 收一收，别让它只增不减
            if ticks % 30 == 0:
                try:
                    store.checkpoint()
                except Exception:
                    pass


# ============================ HTTP ============================
class Handler(BaseHTTPRequestHandler):

    server_version = "BiliHistory/1.0"
    # HTTP/1.1 + keep-alive：避免预览容器 / 浏览器每次重连，减少握手失败导致的 4xx
    protocol_version = "HTTP/1.1"
    # 必须给 socket 设读超时：否则空闲的 keep-alive 连接、以及休眠/断网留下的半开连接
    # 会让 handler 线程永久阻塞在 read 上 —— 线程一点点堆积，跑久了就表现为卡顿。
    timeout = 60

    def log_message(self, fmt, *args):  # 静音默认日志
        if os.environ.get("BILI_HISTORY_VERBOSE"):
            super().log_message(fmt, *args)

    # ---- 连接级兜底：客户端提前断开（常见于浏览器预连接/预览面板）不再刷错误 ----
    def handle_one_request(self):
        try:
            super().handle_one_request()
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            self.close_connection = True
        except Exception:
            self.close_connection = True

    def finish(self):
        try:
            super().finish()
        except (BrokenPipeError, ConnectionResetError, OSError):
            self.close_connection = True

    # ---- helpers ----
    def _send(self, code, body=b"", ctype="application/json; charset=utf-8", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD" and body:
            self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    def _file(self, path: Path, ctype: str = None):
        ctype = ctype or {
            ".html": "text/html; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".svg": "image/svg+xml",
            ".ico": "image/x-icon",
            ".png": "image/png",
            ".webmanifest": "application/manifest+json; charset=utf-8",
        }.get(path.suffix.lower(), "application/octet-stream")
        try:
            body = path.read_bytes()
        except FileNotFoundError:
            return self._send(404, b"not found", "text/plain; charset=utf-8")
        self._send(200, body, ctype)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > MAX_BODY:
            return {}
        raw = self.rfile.read(n)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def _q(self):
        return parse_qs(urlparse(self.path).query)

    # ---- GET ----
    def do_GET(self):
        u = urlparse(self.path)
        p = u.path
        q = self._q()
        try:
            if p in ("/", "/index.html"):
                return self._file(WEB / "index.html")
            if p.startswith("/assets/"):
                return self._file(WEB / p[len("/assets/"):])
            if p == "/sw.js":
                return self._file(WEB / "sw.js", ctype="application/javascript; charset=utf-8")
            if p == "/manifest.webmanifest":
                return self._file(WEB / "manifest.webmanifest", ctype="application/manifest+json; charset=utf-8")
            if p == "/favicon.ico":
                return self._file(WEB / "icons" / "favicon.ico", ctype="image/x-icon")
            if p == "/apple-touch-icon.png":
                return self._file(WEB / "icons" / "apple-touch-icon.png", ctype="image/png")
            route = {
                "/api/state": self.api_state,
                "/api/overview": self.api_overview,
                "/api/videos": self.api_videos,
                "/api/sync/status": self.api_sync_status,
                "/api/rules": self.api_rules_get,
                "/api/network": self.api_network,
                "/api/diag": self.api_diag,
                "/api/cookie-info": self.api_cookie_info,
                "/api/export": self.api_export,
                "/api/autostart": self.api_autostart_get,
            }.get(p)
            if route:
                return route(q)
            return self._send(404, b'{"ok":false,"msg":"404"}')
        except Exception as e:  # noqa
            return self._json({"ok": False, "msg": str(e)}, 500)

    # ---- HEAD / OPTIONS：健康检查、跨域预检、浏览器预连接都会用到 ----
    def do_HEAD(self):
        self.do_GET()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Allow", "GET, HEAD, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ---- POST ----
    def do_POST(self):
        u = urlparse(self.path)
        p = u.path
        body = self._body()
        try:
            route = {
                "/api/sync": self.api_sync,
                "/api/settings": self.api_settings_save,
                "/api/rules": self.api_rules_save,
                "/api/rules/delete": self.api_rules_del,
                "/api/recategorize": self.api_recategorize,
                "/api/override": self.api_override,
                "/api/data-dir": self.api_data_dir,
                "/api/autostart": self.api_autostart_set,
                "/api/demo/seed": self.api_demo_seed,
                "/api/clear": self.api_clear,
                "/api/open-folder": self.api_open_folder,
            }.get(p)
            if route:
                return route(body)
            return self._json({"ok": False, "msg": "404"}, 404)
        except Exception as e:  # noqa
            return self._json({"ok": False, "msg": str(e)}, 500)

    # ================= endpoints =================
    def api_state(self, q):
        s = store.all_settings()
        ck = s.get("cookie") or ""
        masked = (ck[:8] + "…" + ck[-6:]) if len(ck) > 20 else ("" if not ck else "已设置")
        s["cookie"] = masked
        return self._json({
            "ok": True,
            "settings": s,
            "categories": [{"id": c[0], "name": c[1], "color": c[2]} for c in CATEGORIES],
            "data_dir": str(cfg.runtime.data_dir),
            "dbFile": str(cfg.runtime.db_path),
            "dbSize": (lambda p: round(p.stat().st_size / 1024, 1) if p.exists() else 0)(cfg.runtime.db_path),
            # 健康指标：WAL 长期不回收、线程数持续增长，都是"跑久了变卡"的前兆
            "walKb": (lambda p: round(p.stat().st_size / 1024) if p.exists() else 0)(
                cfg.runtime.db_path.with_name(cfg.runtime.db_path.name + "-wal")),
            "threads": threading.active_count(),
            "autostart": system.autostart_enabled(),
            "syncing": _sync_state["running"],
            "zones_map_count": len(ZONE_MAP),
        })

    def api_overview(self, q):
        days = int((q.get("days") or ["30"])[0])
        return self._json({
            "ok": True,
            "overview": store.overview(),
            "trend": store.trend(days),
            "hours": store.hour_dist(),
            "devices": store.device_dist(),
            "topUps": store.top_authors(6),
        })

    def api_videos(self, q):
        g = lambda k, d="": (q.get(k) or [d])[0]
        return self._json({
            "ok": True,
            **store.list_videos(
                category=g("category"), q=g("q"),
                page=int(g("page", "1")), size=int(g("size", "40")), sort=g("sort", "recent"),
            ),
        })

    def api_sync(self, body):
        body = body or {}
        # 只有传入了新的 Cookie 才覆盖已保存的那个
        cookie = bilibili.sanitize_cookie(body.get("cookie") or "")
        if cookie:
            store.set_setting("cookie", cookie)
        opts = {}
        if body.get("deep"):
            store.set_setting("deep_sync", "1")
            opts["deep"] = True
        thread = threading.Thread(target=run_sync, kwargs=opts, daemon=True)
        thread.start()
        return self._json({"ok": True, "msg": "同步已启动"})

    def api_sync_status(self, q):
        s = store.all_settings()
        return self._json({
            "ok": True,
            "running": _sync_state["running"],
            "log": _sync_state["log"][-30:],
            "last_sync_at": s.get("last_sync_at", ""),
            "last_sync_result": s.get("last_sync_result", ""),
        })

    def api_settings_save(self, body):
        for k in ("auto_sync", "sync_interval_min", "deep_sync", "max_pages", "theme", "cookie"):
            if k in body:
                v = body[k]
                if k == "cookie":
                    v = bilibili.sanitize_cookie(v)
                store.set_setting(k, v)
        return self._json({"ok": True})

    def api_rules_get(self, q):
        rules = store.get_rules()
        return self._json({
            "ok": True,
            "rules": [{"keyword": k, "category": v} for k, v in sorted(rules.items())],
        })

    def api_rules_save(self, body):
        kw = (body.get("keyword") or "").strip()
        store.upsert_rule(kw, body.get("category") or "other")
        store.recategorize_all()
        return self._json({"ok": True})

    def api_rules_del(self, body):
        store.delete_rule((body.get("keyword") or "").strip())
        store.recategorize_all()
        return self._json({"ok": True})

    def api_recategorize(self, body):
        n = store.recategorize_all()
        return self._json({"ok": True, "updated": n})

    def api_override(self, body):
        bvid = (body.get("bvid") or "").strip()
        cat = (body.get("category") or "").strip()
        if not bvid or not cat:
            return self._json({"ok": False, "msg": "参数不全"})
        store.set_override(bvid, cat)
        return self._json({"ok": True, "locked": True})

    def api_data_dir(self, body):
        path = (body.get("path") or "").strip()
        if not path:
            return self._json({"ok": False, "msg": "路径不能为空"})
        old = cfg.runtime.data_dir
        new = Path(path)
        if not new.exists():
            try:
                new.mkdir(parents=True, exist_ok=True)
            except Exception as e:
                return self._json({"ok": False, "msg": f"无法创建目录：{e}"})
        store.reset_conn()
        ok, msg = system.migrate_data(old, new)
        if not ok:
            cfg.runtime.load()
            return self._json({"ok": False, "msg": msg})
        cfg.runtime.data_dir = new
        cfg.runtime.save()
        store.reset_conn()
        store.connect()
        return self._json({
            "ok": True, "msg": msg,
            "data_dir": str(cfg.runtime.data_dir),
            "dbSize": (lambda p: round(p.stat().st_size / 1024, 1) if p.exists() else 0)(cfg.runtime.db_path),
        })

    def api_autostart_get(self, q):
        return self._json({"ok": True, "enabled": system.autostart_enabled()})

    def api_autostart_set(self, body):
        ok, msg = system.set_autostart(bool(body.get("enabled")))
        return self._json({"ok": ok, "enabled": system.autostart_enabled(), "msg": msg})

    def api_demo_seed(self, body):
        n = int(body.get("count") or 180)
        items = make_demo(n)
        new = store.upsert_items(items)
        return self._json({"ok": True, "new": new})

    def api_clear(self, body):
        mode = (body.get("mode") or "all")
        if mode == "demo":
            n = store.clear_demo()
            return self._json({"ok": True, "removed": n})
        store.clear_all()
        return self._json({"ok": True})

    def api_open_folder(self, body):
        ok = system.open_folder((body.get("path") or str(cfg.runtime.data_dir)))
        return self._json({"ok": ok})

    def api_network(self, q):
        port = int((q.get("port") or [cfg.runtime.port])[0]) or cfg.runtime.port
        return self._json({
            "ok": True,
            "local": f"http://127.0.0.1:{port}",
            "lan": system.all_addresses(port),
            "port": port,
        })

    def api_export(self, q):
        fmt = (q.get("format") or ["json"])[0]
        name = f"bili-history-{datetime.now().strftime('%Y%m%d-%H%M')}.{fmt}"
        if fmt == "csv":
            body = store.to_csv_text().encode("utf-8")
            ctype = "text/csv; charset=utf-8"
        else:
            body = store.to_json_text().encode("utf-8")
            ctype = "application/json; charset=utf-8"
        self._send(200, body, ctype, {"Content-Disposition": f'attachment; filename="{name}"'})

    def api_diag(self, q):
        """一键自检：Cookie 字段 / WBI 签名 / 历史接口连通性。"""
        s = store.all_settings()
        cookie = (q.get("cookie") or [""])[0] or (s.get("cookie") or "")
        try:
            rep = bilibili.diagnose(cookie)
            return self._json({"ok": True, "report": rep})
        except Exception as e:  # noqa
            return self._json({"ok": False, "msg": f"诊断失败：{e}"})

    def api_cookie_info(self, q):
        """只看 Cookie 是否合规，不联网，用于前端即时提示。"""
        cookie = (q.get("cookie") or [""])[0]
        info = bilibili.cookie_info(cookie)
        info.pop("cleaned", None)  # 不回传完整 Cookie，避免明文到处传
        return self._json({"ok": True, "info": info})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=None)
    ap.add_argument("--host", default=None)
    ap.add_argument("--silent", action="store_true", help="不打印日志、不自动打开浏览器")
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    cfg.runtime.load()
    if args.port:
        cfg.runtime.set_port(args.port)
    if args.host:
        cfg.runtime.host = args.host

    _sync_state["quiet"] = args.silent
    store.connect()  # 初始化数据库

    host = cfg.runtime.host or "0.0.0.0"
    port = cfg.runtime.port

    # 端口被占用（常见于上一次没退干净）时自动顺延，而不是直接崩溃
    httpd = None
    for offset in range(0, 20):
        try_port = port + offset
        try:
            httpd = AppServer((host, try_port), Handler)
        except OSError as e:
            if e.errno in (48, 98, 10048) or "address" in str(e).lower():
                print(f"端口 {try_port} 已被占用，尝试 {try_port + 1}…")
                continue
            raise
        if try_port != port:
            # 仅在本次会话内顺延，不写回 runtime.json，
            # 否则下次启动会因为这份「临时端口」而漂移。
            print(f"已改用端口 {try_port}")
        port = try_port
        break
    if httpd is None:
        print(f"错误：{port} ~ {port + 19} 端口均被占用，无法启动。")
        print("请先关闭已运行的「B站历史记录仪」，或换一个端口：server.py --port 8899")
        sys.exit(1)

    threading.Thread(target=_auto_sync_loop, daemon=True).start()

    url = f"http://127.0.0.1:{port}"
    lan = system.all_addresses(port)
    print("=" * 54)
    print("  B站历史记录仪 已启动")
    print(f"  本机访问   {url}")
    for a in lan[:2]:
        print(f"  手机访问   {a}   （需与本机同一 WiFi）")
    print(f"  数据目录   {cfg.runtime.data_dir}")
    print("  关闭请按 Ctrl+C")
    print("=" * 54, flush=True)

    if not args.silent and not args.no_browser:
        try:
            threading.Timer(0.8, lambda: webbrowser.open(url)).start()
        except Exception:
            pass

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已退出")
        httpd.server_close()


if __name__ == "__main__":
    main()
