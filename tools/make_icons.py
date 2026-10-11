#!/usr/bin/env python3
"""生成 App 图标：纯标准库 PNG/ICO 编码，无任何第三方依赖。"""
import math
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "web" / "icons"
OUT.mkdir(parents=True, exist_ok=True)

C1 = (251, 114, 153)   # B站粉
C2 = (0, 174, 236)     # B站蓝
WHITE = (255, 255, 255)


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def inside_rr(x, y, N, R):
    """圆角矩形内部判定（N 为边长，坐标 0..N-1）"""
    lo, hi = R, N - 1 - R
    if x < lo and y < lo:
        return (x - lo) ** 2 + (y - lo) ** 2 <= R * R
    if x > hi and y < lo:
        return (x - hi) ** 2 + (y - lo) ** 2 <= R * R
    if x < lo and y > hi:
        return (x - lo) ** 2 + (y - hi) ** 2 <= R * R
    if x > hi and y > hi:
        return (x - hi) ** 2 + (y - hi) ** 2 <= R * R
    return True


def render(n, maskable=False, ss=3):
    """返回 (n, n, 4) 的 RGBA bytearray。maskable 时铺满正方形并缩小主体。"""
    N = n * ss
    buf = bytearray()
    R = 0.0 if maskable else 0.22 * N
    cx = cy = (N - 1) / 2.0
    scale = 0.72 if maskable else 1.0
    outer = 0.30 * N * scale
    inner = 0.185 * N * scale
    gap_a, gap_b = -108.0, -26.0   # 右上角开口（角度制，y 轴向下）

    # 预先算好每行的 alpha 覆盖率
    for y in range(N):
        buf.append(0)  # filter type 0
        dy = y - cy
        for x in range(N):
            dx = x - cx
            if not inside_rr(x, y, N, R):
                if maskable:
                    t = min(1.0, max(0.0, (x + y) / (2.0 * (N - 1))))
                    r, g, b = lerp(C1, C2, t)
                    buf += bytes((r, g, b, 255))
                else:
                    buf += b"\x00\x00\x00\x00"
                continue
            t = min(1.0, max(0.0, (x + y) / (2.0 * (N - 1))))
            r, g, b = lerp(C1, C2, t)
            d = math.hypot(dx, dy)
            if inner <= d <= outer:
                ang = math.degrees(math.atan2(dy, dx))
                if not (gap_a <= ang <= gap_b):
                    r, g, b = WHITE
            buf += bytes((r, g, b, 255))

    # 3x3 盒式降采样
    out = bytearray()
    for oy in range(n):
        out.append(0)
        row_off = oy * ss * (1 + N * 4)
        for ox in range(n):
            ar = ag = ab = aa = 0
            for sy in range(ss):
                base = row_off + sy * (1 + N * 4) + 1 + (ox * ss) * 4
                for sx in range(ss):
                    p = base + sx * 4
                    ar += buf[p]; ag += buf[p + 1]; ab += buf[p + 2]; aa += buf[p + 3]
            k = ss * ss
            a = aa // k
            if a == 0:
                out += b"\x00\x00\x00\x00"
            else:
                # 参与像素均为全不透明，按覆盖率归一即可避免边缘发黑
                f = 255.0 / aa
                out += bytes((min(255, int(ar * f)),
                              min(255, int(ag * f)),
                              min(255, int(ab * f)), a))
    return out


def png_bytes(n, data):
    raw = bytes(data)

    def chunk(tag, body):
        c = struct.pack(">I", len(body)) + tag + body
        return c + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", n, n, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def ico_bytes(sizes=(16, 32, 48, 256)):
    """把多个尺寸的 PNG 打包进一个 .ico（PNG 内嵌，Win7+ 支持）"""
    imgs = [(s, png_bytes(s, render(s, maskable=True, ss=2 if s < 64 else 3))) for s in sizes]
    head = struct.pack("<HHH", 0, 1, len(imgs))
    offset = 6 + 16 * len(imgs)
    entries, blobs = b"", b""
    for s, data in imgs:
        w = 0 if s >= 256 else s
        entries += struct.pack("<BBBBHHII", w, w, 0, 0, 1, 32, len(data), offset)
        blobs += data
        offset += len(data)
    return head + entries + blobs


def main():
    for name, size, mask in (
        ("icon-192.png", 192, False),
        ("icon-512.png", 512, False),
        ("icon-maskable-512.png", 512, True),
        ("apple-touch-icon.png", 180, True),
        ("favicon-64.png", 64, False),
        ("favicon-32.png", 32, True),
    ):
        p = OUT / name
        p.write_bytes(png_bytes(size, render(size, maskable=mask)))
        print(f"  {name}  {size}x{size}")

    ico = OUT / "favicon.ico"
    ico.write_bytes(ico_bytes())
    print(f"  favicon.ico  (16/32/48/256)")
    print(f"输出目录：{OUT}")


if __name__ == "__main__":
    main()
