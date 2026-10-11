"""系统能力：开机自启、局域网地址、数据路径迁移"""

import os
import shutil
import socket
import subprocess
import sys
from pathlib import Path

APP_NAME = "BiliHistory"
RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
SERVER = str(Path(__file__).resolve().parent.parent / "server.py")


# ---------------- 开机自启 ----------------
def _pythonw() -> str:
    exe = sys.executable
    cand = os.path.join(os.path.dirname(exe), "pythonw.exe")
    return cand if os.path.exists(cand) else exe


def _launcher_cmd() -> str:
    return f'"{_pythonw()}" "{SERVER}" --silent'


def _startup_folder_cmd():
    """Windows 无 pythonw 时，用 Startup 目录里的隐藏启动脚本兜底。"""
    try:
        base = os.environ.get("APPDATA") or str(Path.home())
        folder = Path(base) / r"Microsoft\Windows\Start Menu\Programs\Startup"
        if not folder.exists():
            return None
        vbs = folder / f"{APP_NAME}.vbs"
        return str(vbs)
    except Exception:
        return None


def autostart_enabled() -> bool:
    if os.name != "nt":
        try:
            p = Path.home() / ".config" / "autostart" / f"{APP_NAME}.desktop"
            return p.exists()
        except Exception:
            return False
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_READ) as k:
            try:
                winreg.QueryValueEx(k, APP_NAME)
                return True
            except FileNotFoundError:
                pass
    except Exception:
        pass
    vbs = _startup_folder_cmd()
    return bool(vbs and os.path.exists(vbs))


def set_autostart(enabled: bool):
    if os.name != "nt":
        return _set_autostart_nix(enabled)
    py_cmd = _launcher_cmd()
    ok = False
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_WRITE) as k:
            if enabled:
                winreg.SetValueEx(k, APP_NAME, 0, winreg.REG_SZ, py_cmd)
            else:
                try:
                    winreg.DeleteValue(k, APP_NAME)
                except FileNotFoundError:
                    pass
        ok = True
    except Exception:
        ok = False

    if not ok:
        # 注册表不可写 -> 用 Startup 目录里的 vbs 静默启动
        vbs = _startup_folder_cmd()
        if not vbs:
            return False, "系统不支持写入开机启动项"
        if enabled:
            q = chr(34)
            content = (
                'Set ws = CreateObject("Wscript.Shell")\n'
                f"ws.Run {q}{q}{_pythonw()}{q}{q} {q}{SERVER}{q} --silent, 0, False\n"
            )
            try:
                Path(vbs).write_bytes(content.encode("mbcs"))
            except Exception:
                Path(vbs).write_text(content, encoding="utf-8")
        elif os.path.exists(vbs):
            os.remove(vbs)
        return True, "已通过启动文件夹设置"
    return True, ""


def _set_autostart_nix(enabled: bool):
    try:
        folder = Path.home() / ".config" / "autostart"
        target = folder / f"{APP_NAME}.desktop"
        if enabled:
            folder.mkdir(parents=True, exist_ok=True)
            target.write_text(
                "[Desktop Entry]\nType=Application\nName=BiliHistory\n"
                f"Exec={sys.executable} {SERVER} --silent\nHidden=false\n"
                "NoDisplay=false\nX-GNOME-Autostart-enabled=true\n",
                encoding="utf-8",
            )
        elif target.exists():
            target.unlink()
        return True, ""
    except Exception as e:
        return False, str(e)


def autostart_supported() -> bool:
    return True


# ---------------- 网络地址 ----------------
def lan_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("223.5.5.5", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        try:
            return socket.gethostbyname(socket.gethostname())
        except Exception:
            return "127.0.0.1"


def all_addresses(port: int) -> list:
    host = socket.gethostname()
    ips = set()
    try:
        for info in socket.getaddrinfo(host, None, socket.AF_INET):
            ips.add(info[4][0])
    except Exception:
        pass
    lan = lan_ip()
    if lan:
        ips.add(lan)
    return sorted({f"http://{ip}:{port}" for ip in ips if not ip.startswith("169.254.")})


# ---------------- 数据目录迁移 ----------------
def migrate_data(src: Path, dst: Path) -> tuple:
    try:
        src = Path(src)
        dst = Path(dst)
        if str(src.resolve()) == str(dst.resolve()):
            return True, "路径未变化"
        dst.mkdir(parents=True, exist_ok=True)
        moved = 0
        for name in ("history.db", "history.db-wal", "history.db-shm"):
            f = src / name
            if f.exists():
                t = dst / name
                if t.exists():
                    t.unlink()
                shutil.move(str(f), str(t))
                moved += 1
        return True, f"已迁移 {moved} 个数据文件" if moved else "新目录已就绪"
    except Exception as e:
        return False, str(e)


def open_folder(path: str) -> bool:
    try:
        p = Path(path)
        if not p.exists():
            p.mkdir(parents=True, exist_ok=True)
        if os.name == "nt":
            os.startfile(str(p))  # noqa
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(p)])
        else:
            subprocess.Popen(["xdg-open", str(p)])
        return True
    except Exception:
        return False
