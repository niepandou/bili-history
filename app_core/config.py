"""B站历史记录仪 —— 配置与路径管理（纯标准库）"""

import json
import os
from pathlib import Path

APP_NAME = "BiliHistory"
ROOT = Path(__file__).resolve().parent.parent
RUNTIME_FILE = ROOT / "runtime.json"
WEB_DIR = ROOT / "web"
DB_NAME = "history.db"

DEFAULT_PORT = 8770


def default_data_dir() -> Path:
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home())
        return Path(base) / APP_NAME
    macos = Path.home() / "Library" / "Application Support"
    if macos.exists():
        return macos / APP_NAME
    return Path.home() / ".local" / "share" / "bili-history"


class _Runtime:
    """持久化到 runtime.json 的最小配置（仅指路用，业务配置存在数据库里）。"""

    def __init__(self):
        self.data_dir: Path = default_data_dir()
        self.port: int = DEFAULT_PORT
        self.host: str = "0.0.0.0"
        self.load()

    # ---------- 读写 ----------
    def load(self):
        try:
            raw = json.loads(RUNTIME_FILE.read_text("utf-8") or "{}")
        except Exception:
            raw = {}
        d = raw.get("data_dir")
        self.data_dir = Path(d) if d else default_data_dir()
        self.port = int(raw.get("port") or DEFAULT_PORT)
        self.host = raw.get("host") or "0.0.0.0"

    def save(self):
        RUNTIME_FILE.parent.mkdir(parents=True, exist_ok=True)
        RUNTIME_FILE.write_text(
            json.dumps({"data_dir": str(self.data_dir), "port": self.port, "host": self.host},
                       ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    # ---------- 路径 ----------
    def ensure_dir(self):
        try:
            self.data_dir.mkdir(parents=True, exist_ok=True)
        except Exception:
            # 兜底：写不进去就退回用户目录
            self.data_dir = default_data_dir()
            self.data_dir.mkdir(parents=True, exist_ok=True)
            self.save()
        return self.data_dir

    @property
    def db_path(self) -> Path:
        return self.ensure_dir() / DB_NAME

    def set_port(self, port: int):
        self.port = int(port)
        self.save()


runtime = _Runtime()


# ---------- 默认业务配置 ----------
DEFAULT_SETTINGS = {
    "cookie": "",
    "cookie_mask": "",
    "auto_sync": "0",
    "sync_interval_min": "180",
    "deep_sync": "0",
    "max_pages": "0",          # 0 = 不限
    "classify_source": "auto",  # auto = 分区映射 + 关键词
    "theme": "light",
    "last_sync_at": "",
    "last_sync_result": "",
    "created_at": "",
}
