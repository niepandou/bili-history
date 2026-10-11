"""B站历史记录接口对接

B站 web-interface 系列接口自 2023 年起强制要求 **WBI 签名**（w_rid / wts），
不带签名会被网关直接拒绝（常见表现为 HTTP 400 或 code -403）。
这里完整实现了 WBI，并对用户粘贴的 Cookie 做清洗与诊断。
"""

import hashlib
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request

API_CURSOR = "https://api.bilibili.com/x/web-interface/history/cursor"
API_V2 = "https://api.bilibili.com/x/v2/history"
API_VIEW = "https://api.bilibili.com/x/web-interface/view"
ME = "https://api.bilibili.com/x/web-interface/nav"

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

BASE_HEADERS = {
    "User-Agent": UA,
    "Referer": "https://www.bilibili.com/",
    "Origin": "https://www.bilibili.com",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Accept-Encoding": "gzip, deflate",
    "Connection": "keep-alive",
    "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
}

# WBI 重排表（B站固定常量，64 个索引）
MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
    37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
    22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]

# cursor 接口每页条数硬上限是 30：实测 ps=30 正常返回，ps=31 起直接
# {"code":-400,"message":"请求错误"}，整次同步会因此失败。切勿上调。
PAGE_SIZE = 30

# wbi key 每天变，内存缓存即可（进程重启会重新取）
_wbi_cache = {"keys": None, "ts": 0}


class SyncError(Exception):
    pass


# ---------------- Cookie 清洗 ----------------
def sanitize_cookie(raw: str) -> str:
    """把用户粘贴的东西尽量救回一个合法 Cookie 串。

    常见脏数据：带 "Cookie:" 前缀、换行、全角分号/逗号、中文空格、多余空白。
    """
    if not raw:
        return ""
    s = str(raw).strip()
    # 去掉可能的前缀
    s = re.sub(r"^\s*cookie\s*[:：]\s*", "", s, flags=re.I)
    # 换行/制表符统一成 "; "，用户从请求头直接复制多行时很常见
    s = re.sub(r"[\r\n\t]+", "; ", s)
    # 全角符号转半角
    s = s.replace("；", ";").replace("，", ",").replace("　", " ")
    # 压缩空白
    s = re.sub(r"\s+", " ", s)
    # 去掉空项，保留 k=v 片段
    parts = [p.strip() for p in s.split(";")]
    parts = [p for p in parts if "=" in p and p]
    # 去重（保留最后一次，符合浏览器覆盖语义）
    seen, out = {}, []
    for p in parts:
        k = p.split("=", 1)[0].strip()
        if not k:
            continue
        seen[k] = p
    for k in seen:
        out.append(seen[k])
    return "; ".join(out)


def cookie_info(raw: str) -> dict:
    """给前端的诊断信息：有没有关键字段、长度、是否已清洗。"""
    cleaned = sanitize_cookie(raw)
    def has(k):
        return bool(re.search(rf"(?:^|;\s*){re.escape(k)}=", cleaned, re.I))
    return {
        "cleaned": cleaned,
        "changed": cleaned != (raw or "").strip(),
        "length": len(cleaned),
        "has_sessdata": has("SESSDATA"),
        "has_bili_jct": has("bili_jct"),
        "has_dedeuserid": has("DedeUserID"),
        "has_buvid3": has("buvid3"),
        "keys": [p.split("=", 1)[0] for p in cleaned.split("; ") if "=" in p],
    }


# ---------------- HTTP ----------------
# 显式禁用系统代理：本机可能配了全局代理（会把请求转到别的出口，
# 导致 B站网关判定异常），这里一律直连。
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _read_body(resp) -> bytes:
    data = resp.read()
    if resp.headers.get("Content-Encoding") == "gzip":
        import gzip
        try:
            data = gzip.decompress(data)
        except Exception:
            pass
    return data


def _get(url: str, cookie: str = "", params: dict = None,
         timeout: int = 15, signed: bool = True) -> dict:
    """请求接口。HTTPError 时会把 B站返回的报文原文带上，方便定位。"""
    params = dict(params or {})
    if signed:
        try:
            params = wbi_sign(params, cookie)
        except Exception:
            pass  # 签名失败就退化为裸参，总比直接崩好
    if params:
        url = url + ("&" if "?" in url else "?") + urllib.parse.urlencode(params)

    headers = dict(BASE_HEADERS)
    c = sanitize_cookie(cookie)
    if c:
        headers["Cookie"] = c
    req = urllib.request.Request(url, headers=headers)
    try:
        with _OPENER.open(req, timeout=timeout) as r:
            return json.loads(_read_body(r).decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        body = ""
        try:
            import gzip
            raw = e.read()
            if e.headers.get("Content-Encoding") == "gzip":
                raw = gzip.decompress(raw)
            body = raw.decode("utf-8", "replace")[:300]
        except Exception:
            pass
        raise SyncError(f"HTTP {e.code}（接口返回：{body or '无内容'}）")
    except Exception as e:  # noqa
        raise SyncError(f"网络请求失败：{type(e).__name__}：{e}")


# ---------------- WBI 签名 ----------------
def _mixin_key(img_key: str, sub_key: str) -> str:
    raw = (img_key or "") + (sub_key or "")
    return "".join(raw[i] for i in MIXIN_KEY_ENC_TAB if i < len(raw))[:32]


def _fetch_wbi_keys(cookie: str) -> tuple:
    """从 nav 接口取最新的 img_key / sub_key。"""
    try:
        with _OPENER.open(urllib.request.Request(
                ME, headers=dict(BASE_HEADERS, Cookie=sanitize_cookie(cookie))),
                timeout=15) as r:
            j = json.loads(_read_body(r).decode("utf-8", "replace"))
    except Exception as e:
        raise SyncError(f"获取签名参数失败：{type(e).__name__}：{e}")

    wbi = ((j.get("data") or {}).get("wbi_img") or {})
    img_key = _file_key(wbi.get("img_url") or "")
    sub_key = _file_key(wbi.get("sub_url") or "")
    if not img_key or not sub_key:
        raise SyncError("无法获取 WBI 签名参数（wbi_img 为空），请检查 Cookie 是否有效")
    return img_key, sub_key


def _file_key(url: str) -> str:
    """https://i0.hdslb.com/bfs/wbi/7cd0849413384...png -> 7cd0849413384..."""
    name = (url or "").rsplit("/", 1)[-1]
    return name.split(".")[0]


def get_wbi_keys(cookie: str, force: bool = False) -> tuple:
    now = int(time.time())
    if (not force and _wbi_cache["keys"]
            and now - _wbi_cache["ts"] < 3600):
        return _wbi_cache["keys"]
    keys = _fetch_wbi_keys(cookie)
    _wbi_cache["keys"] = keys
    _wbi_cache["ts"] = now
    return keys


def wbi_sign(params: dict, cookie: str = "") -> dict:
    """给参数加上 wts + w_rid 签名。"""
    img_key, sub_key = get_wbi_keys(cookie)
    mixin = _mixin_key(img_key, sub_key)

    def clean(v) -> str:
        # B站要求值里过滤掉这些字符再参与签名
        return re.sub(r"[!'()*]", "", str(v))

    p = dict(params)
    p["wts"] = int(time.time())
    ordered = [(k, clean(p[k])) for k in sorted(p.keys())]
    query = urllib.parse.urlencode(ordered)
    p["w_rid"] = hashlib.md5((query + mixin).encode("utf-8")).hexdigest()
    return p


# ---------------- 登录校验 ----------------
def check_login(cookie: str) -> dict:
    """校验 Cookie 是否有效，返回 {"ok":bool,"uname":str,"msg":str}"""
    info = cookie_info(cookie)
    if not info["cleaned"]:
        return {"ok": False, "uname": "", "msg": "Cookie 为空，请粘贴后再试"}
    if not info["has_sessdata"]:
        return {"ok": False, "uname": "", "msg": "Cookie 里没找到 SESSDATA，请确认已完整复制"}
    try:
        j = _get(ME, cookie, signed=False)
    except SyncError as e:
        return {"ok": False, "uname": "", "msg": str(e)}
    code = j.get("code")
    data = j.get("data") or {}
    if code == 0 and data.get("isLogin"):
        return {"ok": True, "uname": data.get("uname", ""), "msg": "登录状态正常"}
    if code == -101:
        return {"ok": False, "uname": "", "msg": "账号未登录：SESSDATA 已失效或过期，请重新获取"}
    if code in (-352, -412):
        return {"ok": False, "uname": "", "msg": "触发风控（code=%s）：建议粘贴完整 Cookie" % code}
    return {"ok": False, "uname": "", "msg": f"登录校验失败（code={code}：{j.get('message')}）"}


# ---------------- 数据整理 ----------------
def _pick(d, *keys, default=""):
    for k in keys:
        v = d.get(k)
        if v not in (None, "", []):
            return v
    return default


def _normalize(raw: dict) -> dict:
    """把不同版本接口的条目统一成内部字段。"""
    owner = raw.get("owner") or raw.get("author") or {}
    hist = raw.get("history") or {}
    title = _pick(raw, "title", "long_title", default="")
    if not title:
        title = raw.get("long_title") or ""
    bvid = _pick(raw, "bvid", "bv_id", default="")
    if not bvid:
        bvid = hist.get("bvid") or ""
    view_at = int(_pick(raw, "view_at", "dt", default=0) or 0)
    if not view_at:
        view_at = int(hist.get("dt") or raw.get("viewed_at") or 0)

    business = _pick(raw, "business", default="archive")
    oid = _pick(raw, "oid", "cid", default="0")
    zone = _pick(raw, "tag_name", "tname", "subtitle", default="")
    if isinstance(zone, list):
        zone = "/".join(str(x) for x in zone)

    hid = f"{business}:{bvid or oid}:{view_at}"
    return {
        "hid": hid,
        "bvid": bvid,
        "aid": int(_pick(raw, "aid", default=0) or 0),
        "cid": int(_pick(raw, "cid", default=0) or hist.get("cid", 0) or 0),
        "title": str(title).strip(),
        "cover": str(_pick(raw, "cover", "pic", default="")),
        "duration": int(_pick(raw, "duration", "page_duration", default=0) or 0),
        "author_mid": int(owner.get("mid") or raw.get("author_mid") or 0),
        "author_name": str(owner.get("name") or raw.get("author_name") or ""),
        "author_face": str(owner.get("face") or raw.get("author_face") or ""),
        "zone": str(zone),
        "business": business,
        "page": int(_pick(raw, "page", default=1) or 1),
        "part": str(_pick(raw, "part", default="")),
        "uri": str(_pick(raw, "uri", default="")),
        "device": str(_pick(raw, "device", default="")),
        "view_at": view_at,
    }


def fetch_history(cookie: str, max_pages: int = 0, progress=None, sleep: float = 0.35):
    """全量拉取历史记录（cursor 接口优先，失败降级 v2）。"""
    login = check_login(cookie)
    if not login["ok"]:
        raise SyncError(login["msg"])

    items, page = [], 1
    max_val, view_val = None, None
    while True:
        # cursor 接口按 max + view_at 向前翻页，不使用 pn
        params = {"type": "all", "ps": PAGE_SIZE}
        if page > 1:
            params["max"] = max_val
            params["view_at"] = view_val
        j = _get(API_CURSOR, cookie, params)
        if j.get("code") != 0:
            code = j.get("code")
            msg = j.get("message") or "未知错误"
            if code in (-403, -352, -412):
                # 签名失效或风控：强制刷新签名重试一次
                try:
                    get_wbi_keys(cookie, force=True)
                    j = _get(API_CURSOR, cookie, params)
                except SyncError:
                    pass
            if j.get("code") != 0:
                raise SyncError(_friendly_error(code, msg))

        data = j.get("data") or {}
        batch = data.get("list") or []
        if not batch:
            break
        for raw in batch:
            try:
                items.append(_normalize(raw))
            except Exception:
                continue

        cur = data.get("cursor") or {}
        if progress:
            progress(page, len(items))
        # 注意：cursor 接口返回里并没有 has_more 字段，只有 max/view_at/business/ps。
        # 判定还有下一页的唯一可靠依据是「拿到了满页数据」且游标完整。
        nxt_max, nxt_view = cur.get("max"), cur.get("view_at")
        if not (nxt_max and nxt_view) or len(batch) < PAGE_SIZE:
            break
        max_val, view_val = nxt_max, nxt_view
        page += 1
        if max_pages and page > max_pages:
            break
        time.sleep(sleep)

    if not items:
        items = _fetch_v2(cookie, progress, sleep)
    return items, login


def _friendly_error(code, msg: str) -> str:
    table = {
        -101: "账号未登录：SESSDATA 已失效，请重新复制 Cookie",
        -111: "CSRF 校验失败：Cookie 里缺少 bili_jct，请复制完整 Cookie",
        -352: "触发风控（非法请求）：Cookie 不完整或缺少 buvid3，建议按说明重新获取完整 Cookie",
        -403: "访问权限不足：WBI 签名校验失败，请重新导入 Cookie 后重试",
        -412: "请求被拦截（风控）：请降低同步频率，稍后重试",
        -509: "请求过于频繁：请稍等几分钟再同步",
        -400: "请求参数错误：本页请求被接口拒绝，请重新导入 Cookie 后重试（若持续出现请反馈）",
    }
    return table.get(code, f"接口返回 {code}：{msg}")


def _fetch_v2(cookie, progress=None, sleep=0.35):
    items, pn = [], 1
    while True:
        try:
            j = _get(API_V2, cookie, {"pn": pn, "ps": PAGE_SIZE, "type": "all"})
        except SyncError:
            break
        data = j.get("data") or {}
        if j.get("code") not in (0, None):
            break
        batch = data.get("data") or data.get("list") or []
        if not batch:
            break
        for raw in batch:
            try:
                items.append(_normalize(raw))
            except Exception:
                continue
        if progress:
            progress(pn, len(items))
        pn += 1
        time.sleep(sleep)
        if pn > 60:
            break
    return items


def deep_fill(cookie: str, rows: list, limit: int = 200, progress=None):
    """对缺分区的稿件调用 view 接口补齐 tname（限流保护）。"""
    need = [r for r in rows if r.get("bvid") and not (r.get("zone") or "").strip()]
    if not need:
        return 0
    need = need[: max(0, limit)]
    filled = 0
    for i, r in enumerate(need):
        try:
            j = _get(API_VIEW, cookie, {"bvid": r["bvid"]})
            if j.get("code") == 0:
                d = j.get("data") or {}
                tname = d.get("tname")
                if tname:
                    r["zone"] = tname
                    filled += 1
                if not r.get("duration"):
                    r["duration"] = int(d.get("duration") or 0)
                if not r.get("cover"):
                    r["cover"] = d.get("pic") or ""
        except SyncError:
            pass
        if progress:
            progress(i + 1, len(need))
        time.sleep(0.5)
    return filled


# ---------------- 诊断 ----------------
def diagnose(cookie: str) -> dict:
    """一键自检：Cookie 字段、签名、接口连通性，把 B站原文返回给前端。"""
    rep = {"steps": []}

    info = cookie_info(cookie)
    rep["cookie"] = {
        "length": info["length"],
        "changed": info["changed"],
        "has_sessdata": info["has_sessdata"],
        "has_bili_jct": info["has_bili_jct"],
        "has_dedeuserid": info["has_dedeuserid"],
        "has_buvid3": info["has_buvid3"],
        "keys": info["keys"],
    }

    # 1. nav（登录校验）
    try:
        j = _get(ME, cookie, signed=False)
        code, data = j.get("code"), j.get("data") or {}
        rep["steps"].append({
            "name": "登录校验 nav", "ok": code == 0 and bool(data.get("isLogin")),
            "code": code, "message": j.get("message") or "",
            "uname": data.get("uname", ""),
        })
    except SyncError as e:
        rep["steps"].append({"name": "登录校验 nav", "ok": False, "message": str(e)})

    # 2. WBI 签名
    try:
        img, sub = get_wbi_keys(cookie, force=True)
        rep["steps"].append({"name": "WBI 签名参数", "ok": True,
                             "message": f"img_key={img[:12]}… sub_key={sub[:12]}…（已获取）"})
    except SyncError as e:
        rep["steps"].append({"name": "WBI 签名参数", "ok": False, "message": str(e)})

    # 3. 历史接口（带签名）
    try:
        j = _get(API_CURSOR, cookie, {"type": "all", "ps": 2})
        data = j.get("data") or {}
        rep["steps"].append({
            "name": "历史接口 cursor（已签名）", "ok": j.get("code") == 0,
            "code": j.get("code"), "message": j.get("message") or "",
            "count": len(data.get("list") or []),
        })
    except SyncError as e:
        rep["steps"].append({"name": "历史接口 cursor（已签名）", "ok": False, "message": str(e)})

    # 4. 历史接口（不带签名，用于对照，证明问题是否在签名）
    try:
        j = _get(API_CURSOR, cookie, {"type": "all", "ps": 2}, signed=False)
        rep["steps"].append({"name": "历史接口 cursor（对照·无签名）",
                             "ok": j.get("code") == 0, "code": j.get("code"),
                             "message": j.get("message") or ""})
    except SyncError as e:
        rep["steps"].append({"name": "历史接口 cursor（对照·无签名）", "ok": False, "message": str(e)})

    rep["ok"] = all(s.get("ok") for s in rep["steps"])
    return rep
