"""品红抠像。

为什么需要它：`/images/edits` **忽略** `background=transparent`，返回 RGB 无 alpha，
而且模型会把「透明」理解成一张格子图直接画进画面（实测
`~/Desktop/gpt-image-lab/out/spike/spike-blink.png` 就是一张画出来的棋盘格）。

实测可行的替代方案：把输入压平到纯品红 #FF00FF，prompt 里锁死背景，产物本地抠像。
`spike-chroma.png` 实测 76.4% 像素是品红、只有 0.35% 落在中间过渡带，
说明边缘光晕极窄，简单的距离阈值就够，不需要复杂的边缘恢复。

品红是刻意选的：角色配色是冰蓝 #CEEBFC / 青 #14B6C5 / 肤色 #FDEEE5 / 深棕，
没有一处接近高 R + 零 G + 高 B，不会误抠到角色身上。
"""

from __future__ import annotations

from PIL import Image

from alpha import clean_alpha

KEY = (255, 0, 255)

# 完全判定为背景的距离阈值（曼哈顿距离，0–765）。
# 实测纯背景像素距离为 0，角色最接近品红的像素（深棕鞋的阴影、青色领口）距离 > 250。
# 90 留足余量又不会吃到角色。
BG_DIST = 90
# 距离在 BG_DIST..EDGE_DIST 之间按线性斜坡给半透明，抹掉抠像硬边。
EDGE_DIST = 200


def flatten_on_key(im: Image.Image, key: tuple[int, int, int] = KEY) -> Image.Image:
    """把 RGBA 压平到纯色背景上，作为 edits 的输入。"""
    im = im.convert("RGBA")
    bg = Image.new("RGBA", im.size, (*key, 255))
    bg.alpha_composite(im)
    return bg.convert("RGB")


def chroma_key(
    im: Image.Image,
    key: tuple[int, int, int] = KEY,
    bg_dist: int = BG_DIST,
    edge_dist: int = EDGE_DIST,
) -> Image.Image:
    """抠掉纯色背景，返回 RGBA。

    用逐通道差的最大值而不是加权亮度：品红的 G=0，角色里任何偏绿/偏白的像素都会在 G 上
    拉开距离，取 max 比取均值更不容易把角色的高光误判成背景。
    """
    rgb = im.convert("RGB")
    r, g, b = rgb.split()
    kr, kg, kb = key
    dr = r.point(lambda v, k=kr: abs(v - k))
    dg = g.point(lambda v, k=kg: abs(v - k))
    db = b.point(lambda v, k=kb: abs(v - k))
    dist = Image.new("L", im.size)
    dist.putdata(
        [max(a, c, d) for a, c, d in zip(dr.getdata(), dg.getdata(), db.getdata(), strict=True)]
    )

    span = max(1, edge_dist - bg_dist)

    def ramp(v: int) -> int:
        if v <= bg_dist:
            return 0
        if v >= edge_dist:
            return 255
        return int(255 * (v - bg_dist) / span)

    alpha = dist.point(ramp)
    out = rgb.convert("RGBA")
    out.putalpha(alpha)
    # 半透明边缘像素仍混着品红，会在深色背景上显出紫边 → 把过渡带的像素色拉回不透明邻域。
    out = _despill(out, key)
    return clean_alpha(out)


def _despill(im: Image.Image, key: tuple[int, int, int]) -> Image.Image:
    """压掉边缘残留的 key 色溢出。

    只在 G 通道低于 R、B 的像素上生效（即「偏品红」），把 R、B 压到不高于 G 与原值的较大者，
    这样角色本身的粉色腮红（R 高、G 中、B 中，G 并不显著低）不会被动到。
    """
    r, g, b, a = im.split()
    rd, gd, bd = list(r.getdata()), list(g.getdata()), list(b.getdata())
    out_r, out_b = [], []
    for i in range(len(rd)):
        rv, gv, bv = rd[i], gd[i], bd[i]
        spill = min(rv, bv) - gv
        if spill > 60:
            limit = gv + 60
            out_r.append(min(rv, limit))
            out_b.append(min(bv, limit))
        else:
            out_r.append(rv)
            out_b.append(bv)
    nr, nb = Image.new("L", im.size), Image.new("L", im.size)
    nr.putdata(out_r)
    nb.putdata(out_b)
    return Image.merge("RGBA", (nr, g, nb, a))


def key_ratio(im: Image.Image, key: tuple[int, int, int] = KEY, bg_dist: int = BG_DIST) -> dict:
    """抠像前的体检：背景占比、过渡带占比。用来判断模型有没有乖乖保持纯色背景。"""
    rgb = im.convert("RGB")
    r, g, b = rgb.split()
    kr, kg, kb = key
    dr, dg, db = (
        r.point(lambda v, k=kr: abs(v - k)),
        g.point(lambda v, k=kg: abs(v - k)),
        b.point(lambda v, k=kb: abs(v - k)),
    )
    dists = [max(a, c, d) for a, c, d in zip(dr.getdata(), dg.getdata(), db.getdata(), strict=True)]
    n = len(dists)
    bgp = sum(1 for v in dists if v <= bg_dist)
    edge = sum(1 for v in dists if bg_dist < v < EDGE_DIST)
    return {
        "bg": round(100 * bgp / n, 2),
        "edge": round(100 * edge / n, 2),
        "subject": round(100 * (n - bgp - edge) / n, 2),
    }
