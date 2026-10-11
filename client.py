#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""B站历史记录仪 —— 桌面客户端

独立窗口运行（无地址栏、无标签页），外观与原生客户端一致：
- 默认使用 Edge / Chrome 的 --app 应用窗口（进程模型成熟，渲染进程独立）
- 可选 --native 走 pywebview 原生窗口

用法：
    pythonw client.py                  启动客户端（自动拉起后台服务）
    python  client.py --devtools       启动并打开开发者工具
    python  client.py --install-shortcut   创建桌面 / 开始菜单快捷方式
    python  client.py --browser        强制使用浏览器应用模式
    python  client.py --native         使用 pywebview 原生窗口（不推荐）
"""

import argparse
import os
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SERVER = ROOT / "server.py"
ICON = ROOT / "web" / "icons" / "favicon.ico"
LOG = ROOT / "client-error.log"

APP_TITLE = "B站历史记录仪"


def log_error(msg: str):
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}\n")
    except Exception:
        pass


# ---------------- 后台服务 ----------------
def port_open(port: int, host: str = "127.0.0.1", timeout: float = 0.4) -> bool:
    try:
        with socket.socket() as s:
            s.settimeout(timeout)
            return s.connect_ex((host, port)) == 0
    except Exception:
        return False


# urllib 默认会读系统代理；科学上网 / 公司代理经常把 127.0.0.1 也拦了，
# 探测时必须显式绕过，否则会误判成"服务挂了"。
_no_proxy_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def probe_service(port: int, timeout: float = 3.0) -> bool:
    """给已经在跑的服务做一次真实 HTTP 探测。

    端口通 ≠ 服务活着：窗口历史上的僵尸进程常常占着端口却不再应答，
    页面就一直停在白屏 / 转圈上 —— 这是「打开就卡死」最常见的形态。
    """
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{port}/api/state", method="GET")
        with _no_proxy_opener.open(req, timeout=timeout) as r:
            return 200 <= getattr(r, "status", 200) < 400
    except Exception:
        return False


def kill_port_owner(port: int) -> bool:
    """清掉占着目标端口却已经不应答的僵尸进程。"""
    if os.name != "nt":
        return False
    ps = (
        "$conn = Get-NetTCPConnection -LocalPort {p} -State Listen -ErrorAction SilentlyContinue;\n"
        "if ($conn) {{ $conn | ForEach-Object {{ "
        "Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }} }}"
    ).format(p=port)
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
            capture_output=True, timeout=25,
        )
        return out.returncode == 0
    except Exception as e:
        log_error(f"清理僵尸服务失败：{e}")
        return False


def start_server(port: int) -> tuple:
    """返回 (子进程或 None, 实际端口)。"""
    # 端口已有人监听：先确认它真的是活的、新的服务，能用就直接复用
    if port_open(port):
        if probe_service(port):
            return None, port
        log_error(f"端口 {port} 有进程但无应答，判定为僵尸服务，先清掉")
        kill_port_owner(port)
        for _ in range(20):
            if not port_open(port):
                break
            time.sleep(0.25)

    flags = 0x08000000 if os.name == "nt" else 0  # CREATE_NO_WINDOW
    cmd = [sys.executable, str(SERVER), "--port", str(port), "--silent", "--no-browser"]
    try:
        proc = subprocess.Popen(
            cmd, cwd=str(ROOT), creationflags=flags,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
        )
    except Exception as e:
        log_error(f"启动服务失败：{e}")
        return None, port
    try:
        from app_core import config as cfg
    except Exception:
        cfg = None
    for _ in range(80):
        if probe_service(port):
            return proc, port
        if cfg is not None:
            try:
                cfg.runtime.load()
                alt = cfg.runtime.port
                if alt and alt != port and probe_service(alt):
                    port = alt
                    return proc, port
            except Exception:
                pass
        time.sleep(0.15)
    log_error("服务未能在 12 秒内就绪")
    return proc, port


def stop_server(proc):
    if not proc:
        return
    try:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
    except Exception:
        pass


# ---------------- 应用窗口（Edge / Chrome --app） ----------------
def find_browser(prefer=None):
    if os.name != "nt":
        return None
    pf = os.environ.get("ProgramFiles", r"C:\Program Files")
    pf86 = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
    local = os.environ.get("LOCALAPPDATA", "")
    candidates = [
        ("edge", rf"{pf86}\Microsoft\Edge\Application\msedge.exe"),
        ("edge", rf"{pf}\Microsoft\Edge\Application\msedge.exe"),
        ("chrome", rf"{pf}\Google\Chrome\Application\chrome.exe"),
        ("chrome", rf"{pf86}\Google\Chrome\Application\chrome.exe"),
        ("chrome", rf"{local}\Google\Chrome\Application\chrome.exe"),
    ]
    if prefer:
        for k, p in candidates:
            if k == prefer and p and os.path.exists(p):
                return p
    for _, p in candidates:
        if p and os.path.exists(p):
            return p
    return None


def run_browser_app(url: str, width: int, height: int, devtools: bool, prefer=None):
    exe = find_browser(prefer)
    if not exe:
        import webbrowser
        webbrowser.open(url)
        return None, "default"

    profile = ROOT / ".appdata" / "app-profile"
    first_run = not (profile / "Local State").exists()
    profile.mkdir(parents=True, exist_ok=True)

    args = [exe, f"--app={url}"]
    # 首次给尺寸；之后完全交给浏览器记忆窗口位置和大小，行为和原生 App 一致
    if first_run:
        args.append(f"--window-size={width},{height}")

    args += [
        f"--user-data-dir={profile}",
        "--no-first-run", "--no-default-browser-check",
        "--disable-extensions",

        # ↓↓↓ 这些参数是解决「放着不动 / 切回来就卡死」的关键 ↓↓↓
        # Chrome/Edge 默认会对被遮挡、不可见、后台的窗口做渲染冻结和定时器节流，
        # 结果就是歇一会儿再点、或者切个窗口回来，界面像死了一样没反应。
        # （注意：Chromium 里重复传 --disable-features 只有最后一个生效，必须合并成一条）
        "--disable-features="
        "Translate,msEdgeTranslate,ExtensionsToolbarMenu,"
        "CalculateNativeWinOcclusion,IntensiveWakeUpThrottling,"
        "OptimizationGuideModelDownloading",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-background-timer-throttling",

        # 本机服务必须直连。注意千万别写 <-loopback>，它的含义恰好相反 ——
        # 是把 loopback 从隐式绕行表里剔除（即强制走代理）。这里要的是显式绕行：
        # 科学上网 / 公司代理常常把 127.0.0.1 也收进代理规则，请求会挂在代理握手上，
        # 页面就表现为「点了没反应」。
        "--proxy-bypass-list=<local>;127.0.0.1;localhost",
    ]
    if devtools:
        args.append("--auto-open-devtools-for-tabs")

    p = subprocess.Popen(args, cwd=str(ROOT))
    return p, exe


# ---------------- 快捷方式 ----------------
def install_shortcut():
    if os.name != "nt":
        print("仅支持 Windows")
        return False
    exe = sys.executable
    pythonw = os.path.join(os.path.dirname(exe), "pythonw.exe")
    if os.path.exists(pythonw):
        exe = pythonw
    ps = f"""
$ws = New-Object -ComObject WScript.Shell
$targets = @(
  [Environment]::GetFolderPath('Desktop'),
  (Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs')
)
foreach ($dir in $targets) {{
  if (-not (Test-Path $dir)) {{ continue }}
  $lnk = Join-Path $dir 'B站历史记录仪.lnk'
  $s = $ws.CreateShortcut($lnk)
  $s.TargetPath = '{exe}'
  $s.Arguments = '"{ROOT / "client.py"}"'
  $s.WorkingDirectory = '{ROOT}'
  $s.IconLocation = '{ICON},0'
  $s.Description = 'B站历史记录仪 桌面客户端'
  $s.Save()
  Write-Output $lnk
}}
"""
    tmp = ROOT / ".appdata" / "_shortcut.ps1"
    tmp.parent.mkdir(parents=True, exist_ok=True)
    tmp.write_text(ps, encoding="utf-8-sig")
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(tmp)],
            capture_output=True, timeout=60,
        )
        raw = out.stdout or out.stderr or b""
        text = ""
        for enc in ("utf-8", "gbk", "mbcs"):
            try:
                text = raw.decode(enc)
                break
            except Exception:
                continue
        print(text.strip() or ("创建完成" if out.returncode == 0 else "创建失败"))
        return out.returncode == 0
    except Exception as e:
        print(f"创建快捷方式失败：{e}")
        return False
    finally:
        try:
            tmp.unlink()
        except Exception:
            pass


# ---------------- pywebview 原生窗口（可选） ----------------
class Api:
    """暴露给页面调用的原生能力（页面里通过 window.pywebview.api 访问）"""

    def __init__(self, port: int):
        self.port = port
        self.window = None

    def client_info(self):
        return {"client": True, "platform": sys.platform, "port": self.port}

    def open_folder(self, path: str = ""):
        from app_core import system
        return system.open_folder(path or "")

    def choose_folder(self):
        try:
            import webview
            res = self.window.create_file_dialog(webview.FOLDER_DIALOG)
            if res:
                return res[0] if isinstance(res, (list, tuple)) else res
        except Exception as e:
            log_error(f"选择目录失败：{e}")
        return ""

    def open_external(self, url: str = ""):
        import webbrowser
        if url.startswith("http"):
            webbrowser.open(url)
            return True
        return False

    def quit(self):
        try:
            self.window.destroy()
        except Exception:
            pass
        return True


def run_native(url: str, width: int, height: int, devtools: bool) -> bool:
    try:
        import webview
    except Exception:
        return False

    try:
        import logging
        logging.getLogger("pywebview").setLevel(logging.CRITICAL)
    except Exception:
        pass

    api = Api(0)
    try:
        window = webview.create_window(
            APP_TITLE, url,
            width=width, height=height,
            min_size=(1024, 660),
            background_color="#f4f6fa",
            text_select=True,
            confirm_close=False,
            js_api=api,
        )
        api.window = window
        menu = _build_menu(window, url)
        webview.start(debug=devtools, private_mode=False, menu=menu,
                      icon=str(ICON) if ICON.exists() else None)
        return True
    except Exception as e:
        log_error(f"原生窗口启动失败：{e}")
        return False


def _build_menu(window, url: str):
    try:
        from webview.menu import Menu, MenuAction, MenuSeparator
    except Exception:
        return []

    def reload_page():
        try:
            window.load_url(url)
        except Exception as e:
            log_error(f"刷新失败：{e}")

    def open_data_folder():
        from app_core import config as cfg
        from app_core import system
        system.open_folder(str(cfg.runtime.data_dir))

    def open_in_browser():
        import webbrowser
        webbrowser.open(url)

    return [
        Menu("应用", [
            MenuAction("刷新界面", reload_page),
            MenuAction("在浏览器中打开", open_in_browser),
            MenuSeparator(),
            MenuAction("打开数据目录", open_data_folder),
            MenuSeparator(),
            MenuAction("退出", lambda: window.destroy()),
        ]),
    ]


# ---------------- main ----------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=None)
    ap.add_argument("--width", type=int, default=1440)
    ap.add_argument("--height", type=int, default=920)
    ap.add_argument("--devtools", action="store_true")
    ap.add_argument("--browser", action="store_true", help="强制使用浏览器应用模式")
    ap.add_argument("--chrome", action="store_true", help="应用窗口优先选 Chrome")
    ap.add_argument("--native", action="store_true", help="使用 pywebview 原生窗口")
    ap.add_argument("--install-shortcut", action="store_true")
    ap.add_argument("--keep-server", action="store_true", help="关闭窗口后保留后台服务")
    args = ap.parse_args()

    if args.install_shortcut:
        ok = install_shortcut()
        sys.exit(0 if ok else 1)

    port = args.port or 8770
    proc, port = start_server(port)
    if not probe_service(port):
        log_error(f"服务端口 {port} 未就绪，请检查 Python 环境")
    # client=1 让页面切到桌面端行为（禁用 Service Worker、走本地下载等）
    url = f"http://127.0.0.1:{port}/?client=1"

    proc2 = None
    if args.native:
        ok = run_native(url, args.width, args.height, args.devtools)
        if not ok:
            log_error("pywebview 窗口启动失败，回退到应用窗口模式")
        else:
            if not args.keep_server:
                stop_server(proc)
            return

    proc2, _ = run_browser_app(
        url, args.width, args.height, args.devtools,
        prefer="chrome" if args.chrome else None,
    )
    try:
        if proc2:
            proc2.wait()
    except KeyboardInterrupt:
        pass

    if not args.keep_server:
        stop_server(proc)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        import traceback
        log_error("客户端异常：\n" + traceback.format_exc())
        print(f"启动失败，详见 {LOG}")
        sys.exit(1)
