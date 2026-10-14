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
    """压掉**边缘过渡带**里残留的 key 色溢出。

    只处理 0 < alpha < 255 的像素。不透明的内部像素不可能混进背景色，
    对它们做 despill 是纯粹的破坏 —— 实测特效 heart 的填充 (249,81,144)
    满足 min(R,B)-G = 63 > 60，被压成了 (141,81,141) 的深紫色。
    判据从「颜色像不像品红」改成「这个像素是不是半透明」，
    因为后者才是「可能混了背景」的真正条件。
    """
    r, g, b, a = im.split()
    rd, gd, bd, ad = list(r.getdata()), list(g.getdata()), list(b.getdata()), list(a.getdata())
    out_r, out_b = [], []
    for i in range(len(rd)):
        rv, gv, bv, av = rd[i], gd[i], bd[i], ad[i]
        # 只有过渡带才可能混进 key 色。
        if 0 < av < 255 and min(rv, bv) - gv > 60:
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


def _distance(im: Image.Image, key: tuple[int, int, int]) -> list[int]:
    """逐像素到 key 的通道最大差。"""
    r, g, b = im.convert("RGB").split()
    kr, kg, kb = key
    dr = r.point(lambda v, k=kr: abs(v - k))
    dg = g.point(lambda v, k=kg: abs(v - k))
    db = b.point(lambda v, k=kb: abs(v - k))
    return [max(a, c, d) for a, c, d in zip(dr.getdata(), dg.getdata(), db.getdata(), strict=True)]


def chroma_key_flood(
    im: Image.Image,
    key: tuple[int, int, int] = KEY,
    bg_dist: int = BG_DIST,
    edge_dist: int = EDGE_DIST,
) -> Image.Image:
    """只抠「从画面边缘连通过来的」背景，不按全图颜色距离抠。

    为什么需要它：按颜色距离抠会吃掉和 key 色接近的主体。实测特效 heart 的粉色填充
    (255,120,160) 到品红 (255,0,255) 的通道最大差只有 135，落在 90–200 的过渡带里，
    结果整颗心的填充被抠成半透明，只剩一圈描边 —— 产物肉眼就能看出是坏的。

    换 key 色解决不了：特效用到的青色 (20,182,197) 离纯绿只有 197，离纯蓝只有 182，
    粉色离纯红只有 160。没有哪个单一 key 色能同时远离黄/青/粉/白/深描边这五种颜色。

    「背景是从边缘连通的一整片」这个结构性事实比颜色更可靠。角色图不走这条路
    （品红对冰蓝/青/肤色/深棕完全够用，而且那条路的产物已经验证过了，不动）。
    """
    w, h = im.size
    dist = _distance(im, key)
    # 候选背景：颜色上「可能是背景」的像素。主体内部的粉色也可能落进来，靠连通性排除。
    cand = bytearray(1 if d <= edge_dist else 0 for d in dist)

    # 从四条边界出发做洪水填充，只有真正连通到边缘的候选才算背景。
    seen = bytearray(w * h)
    stack: list[int] = []
    for x in range(w):
        for i in (x, (h - 1) * w + x):
            if cand[i] and not seen[i]:
                seen[i] = 1
                stack.append(i)
    for y in range(h):
        for i in (y * w, y * w + w - 1):
            if cand[i] and not seen[i]:
                seen[i] = 1
                stack.append(i)
    while stack:
        i = stack.pop()
        x = i % w
        if x > 0 and cand[i - 1] and not seen[i - 1]:
            seen[i - 1] = 1
            stack.append(i - 1)
        if x < w - 1 and cand[i + 1] and not seen[i + 1]:
            seen[i + 1] = 1
            stack.append(i + 1)
        if i >= w and cand[i - w] and not seen[i - w]:
            seen[i - w] = 1
            stack.append(i - w)
        if i < w * (h - 1) and cand[i + w] and not seen[i + w]:
            seen[i + w] = 1
            stack.append(i + w)

    span = max(1, edge_dist - bg_dist)
    alpha = Image.new("L", im.size)
    alpha.putdata([
        (0 if dist[i] <= bg_dist else int(255 * (dist[i] - bg_dist) / span)) if seen[i] else 255
        for i in range(w * h)
    ])
    out = im.convert("RGB").convert("RGBA")
    out.putalpha(alpha)
    return clean_alpha(_despill(out, key))
