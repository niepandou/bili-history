"""SQLite 数据层：历史记录、手动分类、关键词规则、设置"""

import csv
import io
import json
import re
import sqlite3
import threading
from datetime import datetime

from . import config
from .classifier import CAT_IDS, CAT_MAP, CAT_NAME, classify

_LOCAL = threading.local()
_LOCK = threading.RLock()

# 数据目录一旦迁移，所有线程的旧连接都必须作废。用一个自增代号统一通知，
# 每个线程发现自己的代号落后了就重建连接。
_GEN = 0
_CONNS = []


def connect() -> sqlite3.Connection:
    """按线程返回独立连接。

    之前全局只开一条连接并 check_same_thread=False，于是 HTTP 的每个请求线程、
    后台自动同步线程全都挤在同一条连接上：SQLite 只能串行处理，一次慢查询或
    upsert 事务就会把其它线程一起堵住，对外表现就是界面「点了没反应」。
    改成每线程一条连接 + WAL 后，读写真正并发互不阻塞。
    """
    global _GEN, _CONNS
    if getattr(_LOCAL, "conn", None) is not None and getattr(_LOCAL, "gen", -1) == _GEN:
        return _LOCAL.conn
    with _LOCK:
        want = str(config.runtime.db_path)
        conn = sqlite3.connect(want, timeout=25, check_same_thread=True)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=10000")
        conn.execute("PRAGMA synchronous=NORMAL")
        _ensure_schema(conn)
        _LOCAL.conn = conn
        _LOCAL.gen = _GEN
        _CONNS.append(conn)
    return conn


def reset_conn():
    """迁移数据目录后调用：关掉所有线程的连接并推进代号。"""
    global _GEN, _CONNS
    with _LOCK:
        _GEN += 1
        conns, _CONNS = _CONNS, []
        try:
            _LOCAL.conn = None
        except Exception:
            pass
    for c in conns:
        try:
            c.close()
        except Exception:
            pass


DDL = """
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS history (
  hid TEXT PRIMARY KEY,
  bvid TEXT, aid INTEGER, cid INTEGER,
  title TEXT, cover TEXT, duration INTEGER,
  author_mid INTEGER, author_name TEXT, author_face TEXT,
  zone TEXT, business TEXT,
  page INTEGER, part TEXT, uri TEXT, device TEXT,
  view_at INTEGER,
  category TEXT,
  category_source TEXT
);
CREATE TABLE IF NOT EXISTS overrides (
  bvid TEXT PRIMARY KEY,
  category TEXT
);
CREATE TABLE IF NOT EXISTS rules (
  keyword TEXT PRIMARY KEY,
  category TEXT
);
CREATE INDEX IF NOT EXISTS idx_hist_cat  ON history(category);
CREATE INDEX IF NOT EXISTS idx_hist_time ON history(view_at);
CREATE INDEX IF NOT EXISTS idx_hist_bv   ON history(bvid);
"""

_SEED_CREATED = "_init_marker"


def _ensure_schema(conn: sqlite3.Connection):
    conn.executescript(DDL)
    if get_setting("created_at", conn) is None:
        set_setting("created_at", datetime.now().strftime("%Y-%m-%d %H:%M"), conn)


# ---------------- 设置 ----------------
def get_setting(key: str, conn=None) -> str:
    conn = conn or connect()
    row = conn.execute("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
    return row["value"] if row else config.DEFAULT_SETTINGS.get(key)


def set_setting(key: str, value, conn=None):
    conn = conn or connect()
    conn.execute(
        "INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, str(value)),
    )
    conn.commit()


def all_settings(conn=None) -> dict:
    conn = conn or connect()
    out = dict(config.DEFAULT_SETTINGS)
    for r in conn.execute("SELECT key,value FROM kv"):
        out[r["key"]] = r["value"]
    return out


# ---------------- 规则 ----------------
def get_rules(conn=None) -> dict:
    conn = conn or connect()
    return {r["keyword"]: r["category"] for r in conn.execute("SELECT keyword,category FROM rules")}


def upsert_rule(keyword: str, category: str, conn=None):
    conn = conn or connect()
    if category not in CAT_IDS:
        raise ValueError("未知分类")
    kw = keyword.strip()
    if not kw:
        raise ValueError("关键词不能为空")
    conn.execute(
        "INSERT INTO rules(keyword,category) VALUES(?,?) "
        "ON CONFLICT(keyword) DO UPDATE SET category=excluded.category",
        (kw, category),
    )
    conn.commit()


def delete_rule(keyword: str, conn=None):
    conn = conn or connect()
    conn.execute("DELETE FROM rules WHERE keyword=?", (keyword,))
    conn.commit()


def get_overrides(conn=None) -> dict:
    conn = conn or connect()
    return {r["bvid"]: r["category"] for r in conn.execute("SELECT bvid,category FROM overrides")}


def set_override(bvid: str, category: str, conn=None):
    conn = conn or connect()
    if category not in CAT_IDS:
        raise ValueError("未知分类")
    conn.execute(
        "INSERT INTO overrides(bvid,category) VALUES(?,?) "
        "ON CONFLICT(bvid) DO UPDATE SET category=excluded.category",
        (bvid, category),
    )
    conn.execute(
        "UPDATE history SET category=?, category_source='manual' WHERE bvid=?", (category, bvid)
    )
    conn.commit()


def clear_override(bvid: str, conn=None):
    conn = conn or connect()
    conn.execute("DELETE FROM overrides WHERE bvid=?", (bvid,))
    conn.commit()


# ---------------- 历史记录 ----------------
def upsert_items(items: list) -> int:
    """写入历史条目，返回新增条数。"""
    conn = connect()
    rules = get_rules(conn)
    ovd = get_overrides(conn)
    sql = """INSERT INTO history
      (hid,bvid,aid,cid,title,cover,duration,author_mid,author_name,author_face,
       zone,business,page,part,uri,device,view_at,category,category_source)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(hid) DO UPDATE SET
       title=excluded.title, cover=excluded.cover, zone=COALESCE(NULLIF(excluded.zone,''),history.zone),
       author_name=excluded.author_name, duration=excluded.duration,
       category=CASE WHEN history.category_source='manual'
                     THEN history.category ELSE excluded.category END"""
    cur = conn.cursor()
    new = 0
    for it in items:
        hid = it.get("hid")
        title = it.get("title") or ""
        zone = it.get("zone") or ""
        bvid = it.get("bvid") or ""
        # 只有库里原本没有的才计为「新增」；
        # 不能用 total_changes，因为 ON CONFLICT DO UPDATE 对已存在记录也会计数。
        existed = conn.execute(
            "SELECT 1 FROM history WHERE hid=?", (hid,)).fetchone() is not None
        if bvid and bvid in ovd:
            cat, src = ovd[bvid], "manual"
        else:
            cat, src = classify(title, zone, it.get("author_name") or "", rules)
        cur.execute(sql, (
            hid, bvid, it.get("aid") or 0, it.get("cid") or 0,
            title, it.get("cover") or "", it.get("duration") or 0,
            it.get("author_mid") or 0, it.get("author_name") or "", it.get("author_face") or "",
            zone, it.get("business") or "archive", it.get("page") or 1, it.get("part") or "",
            it.get("uri") or "", it.get("device") or "", int(it.get("view_at") or 0),
            cat, src,
        ))
        if not existed:
            new += 1
    conn.commit()
    return new


def recategorize_all() -> int:
    """按最新词典重算（保留手动锁定项）。"""
    conn = connect()
    rules = get_rules(conn)
    rows = conn.execute(
        "SELECT hid,title,zone,author_name,bvid FROM history "
        "WHERE COALESCE(category_source,'') <> 'manual'"
    ).fetchall()
    n = 0
    for r in rows:
        cat, src = classify(r["title"] or "", r["zone"] or "", r["author_name"] or "", rules)
        conn.execute("UPDATE history SET category=?, category_source=? WHERE hid=?", (cat, src, r["hid"]))
        n += 1
    conn.commit()
    return n


# ---------------- 查询 ----------------
def overview() -> dict:
    conn = connect()
    total = conn.execute("SELECT COUNT(*) c FROM history").fetchone()["c"]
    distinct = conn.execute(
        "SELECT COUNT(*) c FROM (SELECT bvid FROM history WHERE bvid<>'' GROUP BY bvid)"
    ).fetchone()["c"]
    authors = conn.execute(
        "SELECT COUNT(*) c FROM (SELECT author_mid FROM history WHERE author_mid<>0 GROUP BY author_mid)"
    ).fetchone()["c"]
    zones = conn.execute("SELECT COUNT(DISTINCT zone) c FROM history WHERE zone<>''").fetchone()["c"]
    first = conn.execute("SELECT MIN(view_at) v FROM history WHERE view_at>0").fetchone()["v"]
    last = conn.execute("SELECT MAX(view_at) v FROM history WHERE view_at>0").fetchone()["v"]

    rows = conn.execute(
        "SELECT category, COUNT(*) views, COUNT(DISTINCT bvid) vids "
        "FROM history GROUP BY category ORDER BY views DESC"
    ).fetchall()
    cats = []
    for r in rows:
        cid = r["category"] or "other"
        cats.append({
            "id": cid,
            "name": CAT_NAME.get(cid, "其他"),
            "color": CAT_MAP.get(cid, CAT_MAP["other"])[2],
            "views": r["views"],
            "videos": r["vids"],
        })

    return {
        "total_views": total,
        "total_videos": distinct,
        "authors": authors,
        "zones": zones,
        "first_view_at": first or 0,
        "last_view_at": last or 0,
        "categories": cats,
    }


def trend(days: int = 30) -> list:
    conn = connect()
    rows = conn.execute(
        "SELECT date(view_at,'unixepoch','localtime') d, COUNT(*) c "
        "FROM history WHERE view_at>0 AND view_at >= strftime('%s','now',?) "
        "GROUP BY d ORDER BY d",
        (f"-{days} days",),
    ).fetchall()
    m = {r["d"]: r["c"] for r in rows}
    from datetime import datetime as _dt, timedelta as _td
    out = []
    for i in range(days - 1, -1, -1):
        d = (_dt.now() - _td(days=i)).strftime("%Y-%m-%d")
        out.append({"date": d, "count": m.get(d, 0)})
    return out


def hour_dist() -> list:
    conn = connect()
    rows = conn.execute(
        "SELECT CAST(strftime('%H', view_at,'unixepoch','localtime') AS INTEGER) h, COUNT(*) c "
        "FROM history WHERE view_at>0 GROUP BY h"
    ).fetchall()
    m = {r["h"]: r["c"] for r in rows}
    return [{"hour": h, "count": m.get(h, 0)} for h in range(24)]


DEVICE_MAP = {"2": "Android", "3": "iOS", "4": "iPad", "5": "网页"}


def top_authors(limit: int = 6) -> list:
    conn = connect()
    rows = conn.execute(
        "SELECT author_name, author_mid, COUNT(*) c FROM history "
        "WHERE author_name<>'' GROUP BY author_mid ORDER BY c DESC LIMIT ?",
        (limit,),
    ).fetchall()
    return [{"name": r["author_name"], "count": r["c"]} for r in rows]


def device_dist() -> list:
    conn = connect()
    rows = conn.execute(
        "SELECT COALESCE(NULLIF(device,''),'') d, COUNT(*) c FROM history GROUP BY d ORDER BY c DESC"
    ).fetchall()
    return [{"device": DEVICE_MAP.get(r["d"], "其他"), "count": r["c"]} for r in rows]


def list_videos(category="", q="", page=1, size=40, sort="recent") -> dict:
    conn = connect()
    where, args = [], []
    if category and category != "all":
        where.append("category = ?")
        args.append(category)
    if q:
        where.append("(title LIKE ? OR author_name LIKE ? OR zone LIKE ?)")
        like = f"%{q}%"
        args += [like, like, like]
    w = (" WHERE " + " AND ".join(where)) if where else ""

    order = {
        "recent": "last_view_at DESC",
        "count": "views DESC",
        "title": "title ASC",
    }.get(sort, "last_view_at DESC")

    base = """
      FROM history
      {w}
      GROUP BY bvid
    """.format(w=w)

    cnt = conn.execute(f"SELECT COUNT(*) c FROM (SELECT bvid {base})", args).fetchone()["c"]
    offset = (page - 1) * size
    rows = conn.execute(
        f"""SELECT bvid, MAX(title) title, MAX(cover) cover, MAX(author_name) author_name,
                   MAX(author_mid) author_mid, MAX(author_face) author_face, MAX(zone) zone,
                   MAX(category) category, MAX(category_source) category_source,
                   MAX(duration) duration, COUNT(*) views, MAX(view_at) last_view_at {base}
            ORDER BY {order} LIMIT ? OFFSET ?""",
        args + [size, offset],
    ).fetchall()

    items = []
    for r in rows:
        cid = r["category"] or "other"
        src = r["category_source"] or "auto"
        items.append({
            "bvid": r["bvid"],
            "title": r["title"],
            "cover": r["cover"],
            "author_name": r["author_name"],
            "author_mid": r["author_mid"],
            "zone": r["zone"],
            "duration": r["duration"],
            "views": r["views"],
            "last_view_at": r["last_view_at"],
            "category": cid,
            "category_name": CAT_NAME.get(cid, "其他"),
            "category_color": CAT_MAP.get(cid, CAT_MAP["other"])[2],
            "locked": src == "manual",
            "url": f"https://www.bilibili.com/video/{r['bvid']}" if r["bvid"] else "",
        })
    return {"items": items, "total": cnt, "page": page, "size": size}


def export_rows(limit=0):
    conn = connect()
    sql = """SELECT bvid,title,author_name,zone,category,MAX(view_at) last_view_at,COUNT(*) views
             FROM history GROUP BY bvid ORDER BY last_view_at DESC"""
    if limit:
        sql += f" LIMIT {int(limit)}"
    return conn.execute(sql).fetchall()


def to_csv_text() -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["BV号", "标题", "UP主", "B站分区", "系统分类", "观看次数", "最近观看", "链接"])
    for r in export_rows():
        ts = datetime.fromtimestamp(r["last_view_at"]).strftime("%Y-%m-%d %H:%M") if r["last_view_at"] else ""
        w.writerow([
            r["bvid"], r["title"], r["author_name"], r["zone"],
            CAT_NAME.get(r["category"], "其他"), r["views"], ts,
            f"https://www.bilibili.com/video/{r['bvid']}" if r["bvid"] else "",
        ])
    return "\ufeff" + buf.getvalue()


def to_json_text() -> str:
    rows = []
    for r in export_rows():
        rows.append({
            "bvid": r["bvid"], "title": r["title"], "author": r["author_name"],
            "zone": r["zone"], "category": r["category"],
            "category_name": CAT_NAME.get(r["category"], "其他"),
            "views": r["views"], "last_view_at": r["last_view_at"],
            "url": f"https://www.bilibili.com/video/{r['bvid']}" if r["bvid"] else "",
        })
    return json.dumps({"app": "BiliHistory", "exported_at": datetime.now().isoformat(timespec="seconds"),
                       "count": len(rows), "items": rows}, ensure_ascii=False, indent=2)


def checkpoint(full: bool = False) -> None:
    """把 WAL 合并回主库。

    连接是单例长连接，永远不会 close，所以 SQLite 关闭时才做的自动 checkpoint
    根本不会触发；而默认的 1000 页自动阈值在小数据量下也够不到 —— 实测跑一阵子
    WAL 就涨到主库的 5 倍以上且只增不减。写入后定期调用可以把它压回去。
    """
    conn = connect()
    try:
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)" if full
                     else "PRAGMA wal_checkpoint(PASSIVE)")
    except sqlite3.Error:
        pass


def clear_all():
    conn = connect()
    conn.execute("DELETE FROM history")
    conn.commit()


def clear_demo() -> int:
    """只删掉演示数据（hid 以 demo: 开头），真实同步进来的记录原样保留。"""
    conn = connect()
    cur = conn.execute("DELETE FROM history WHERE hid LIKE 'demo:%'")
    conn.commit()
    return cur.rowcount or 0


def demo_count() -> int:
    conn = connect()
    r = conn.execute(
        "SELECT COUNT(*) c FROM history WHERE hid LIKE 'demo:%'").fetchone()
    return int(r["c"] if r["c"] is not None else 0)
