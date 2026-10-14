#!/usr/bin/env python
"""阶跃星辰（StepFun）logo：从 SVG 几何栅格化成独立可动图层，并写出 logo.json。

为什么单独一个脚本、而不是塞进 register.py：logo 不是「从 master 像素 diff 里长出来」的
覆盖层，它的位置**不能**靠 diff 推 —— master 上那块是模型臆造的假徽章，
diff 只会告诉我们「那里有个深色方块」，不会告诉我们真 logo 该多大。
所以这条链是另一种证明方式：

1. **几何来自原文件，不靠眼睛描。** 源 SVG（`assets/stepchan_q_v1/_logo_stepfun.svg`）
   是从 `logo-B0FsyLQP.svg` 里机械抽出来的第 1 个 `<path>`（共 8 个，后 7 个是
   "StepFun" 字样，丢掉）。抽取用 `--extract`，会把原文件 sha256 写进注释留痕。
2. **解析而不是重打数字。** 本脚本把那条 `d` 真的解析成 1 个圆 + 5 个正方形，
   并断言一串形状不变量（贝塞尔圆的 κ≈0.5523、5 个方块边长一致、全部落在圆内、
   构成单调阶梯）。任何一条不过就报错退出，不会悄悄画出一个错的 logo。
3. **栅格化结果与真 SVG 渲染器对比。** macOS 自带 `qlmanage` 能渲染 SVG；
   有它的话就渲一张参考图，和 Pillow 的产物算 IoU 与像素一致率，数字写进 logo.json。
   没有 rsvg-convert / cairosvg，所以这是本机能拿到的唯一独立实现。
4. **覆盖旧假徽章的尺寸由实测决定。** `PLACEMENT` 里每个位置的 `size` 必须
   ≥ 实测的 `coverRadius`×2（旧徽章深色像素到其中心的最大距离，由本脚本量出来），
   否则断言失败。这就是「盖得住」的证据，不是「看起来盖住了」。

为什么不改 master/base.png 把 logo 烤进去：烤进去就没法回退，而且 10 张动作图
每张的徽章位置都不一样，要全部重做。运行期覆盖只多两个 sprite，且随时可关。

运行：
  ~/Desktop/gpt-image-lab/.venv/bin/python tools/art/logo.py
  ~/Desktop/gpt-image-lab/.venv/bin/python tools/art/logo.py --extract ~/Documents/logo-B0FsyLQP.svg
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from PIL import Image, ImageChops, ImageDraw, ImageFilter  # noqa: E402

from alpha import clean_alpha, sha256_file  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets" / "stepchan_q_v1"
RIG_DIR = ASSETS / "rig"
# 纯图标源文件。
#
# 下划线前缀是**功能性**的，不是风格：scripts/sync-rig.mjs 跳过所有以 `_` 开头的条目，
# 所以这个前缀把它挡在 vite 的 public/ 之外。它是生成源头的留痕（和 `_qa_*.png` 同性质），
# 运行期一个字节都用不到 —— 把 SVG 打进构建产物只会让人以为渲染器在读它。
SOURCE_SVG = ASSETS / "_logo_stepfun.svg"
MASTER = ASSETS / "master.png"

# ---- 栅格化参数 ----
# 贴图边长。运行期画布 512，logo 在身上最大 32 px（见 PLACEMENT），
# 256 等于 8× 超采样 —— retina（dpr 2）+ 桌宠放到 400 px 仍有 5× 余量，而文件只有几 KB。
RASTER = 256
# 超采样倍数。Pillow 的 ImageDraw 没有抗锯齿，靠画大再 LANCZOS 缩。
SUPERSAMPLE = 8
# 圆盘颜色，取自原 SVG 的 fill="#000000"。
DISC_RGB = (0, 0, 0)
# 阶梯方块的填充色。
#
# 原 SVG 里这 5 个方块是**镂空**（nonzero 填充规则下与圆反向绕行），在白色页面上显示为白。
# 这里刻意填成不透明的白，而不是做成透明洞：透明洞会让 master 上那个假徽章
# （深色圆角方块 + 白色小方块）从阶梯缝里透出来，220 px 下就是一块脏东西。
# 填白之后圆盘整体不透明，覆盖是确定的；而且「黑圆 + 白阶梯」正是 logo 在白底上的样子。
STEP_RGB = (255, 255, 255)
# 方块圆角半径，单位＝SVG 用户单位（viewBox 36×36）。
# 原 path 是纯 H/V 直角，所以默认 0；留这个常量是为了以后想柔化一下只改这里。
STEP_CORNER_UNITS = 0.0

# ---- 分层参数：logo 在运行期画布（512×512）里的位置 ----
#
# 这是**唯一**一处位置/尺寸/旋转的来源。它被写进 logo.json，渲染器只读清单，
# 不在渲染逻辑里硬编码任何一个数 —— 以后微调改这里，重跑本脚本 + `npm run sync-rig` 即可。
#
# cx/cy：圆心，单位 px（512 画布坐标）。由 measure_badge() 实测的旧徽章中心换算而来，
#        所以新 logo 和旧徽章同心 —— 不是手摆的。
# size： 直径，px。必须 ≥ coverRadius×2（断言），余量见 COVER_MARGIN。
# rotation：弧度。阶梯有方向性，发饰上的假徽章本身略有倾斜，留出来可调。
# jiggle：跟随身体摆动的**额外**抖动系数（0=完全贴死在身上）。发饰是夹子，会比衣料多晃一点。
#
# master.png 是 1024，运行期是 512，所以这里的量取坐标统一除以 2（MASTER_TO_RUNTIME）。
MASTER_TO_RUNTIME = 0.5
# 旧徽章的实测搜索窗（1024 坐标）与一个落在深色外环上的种子点。
# 窗口刻意开得紧：发饰徽章右下方有一道深色发丝描边，窗口大了会把它一起吃进来，
# 量出的 coverRadius 就虚高。
BADGE_PROBE = {
    "hair": {"window": (606, 208, 670, 270), "seed": (637, 217)},
    "chest": {"window": (536, 558, 576, 598), "seed": (555, 567)},
}
# 覆盖余量：直径 = ceil(coverRadius × 2 × (1 + COVER_MARGIN))。
# 12% 是为了吃掉旧徽章的抗锯齿外沿 —— 刚好相切会在 220 px 下露出一圈灰边。
COVER_MARGIN = 0.12
# 人工指定的旋转与抖动系数。位置和尺寸都是实测出来的，这两项没有客观来源，所以显式写在这里。
LOGO_TUNING = {
    # 发饰上的假徽章在 master 里略微左倾（头发的走向）；-0.06 rad ≈ -3.4°。
    "hair": {"rotation": -0.06, "jiggle": 0.35},
    # 胸前那块贴在平整的水手领上，不单独晃。
    "chest": {"rotation": 0.0, "jiggle": 0.0},
}
# 这两个位置只在 idle 画幅上成立。动作图换了姿势，徽章位置全变了 ——
# 和脸部覆盖层一样的边界，必须显式降级，不能让 logo 飘在腋下。
APPLIES_TO = ["idle", "tilt"]

LOGO_PNG = "rig/logo.png"


# ---------------------------------------------------------------------------
# SVG 解析
# ---------------------------------------------------------------------------

PATH_RE = re.compile(r"<path\b[^>]*?/>", re.S)
D_RE = re.compile(r'\sd="([^"]+)"')
FILL_RE = re.compile(r'fill="([^"]+)"')
NUM_RE = re.compile(r"-?\d*\.?\d+(?:[eE][-+]?\d+)?")
ORIGIN_RE = re.compile(r"<!--\s*(.*?)\s*-->", re.S)

# 贝塞尔逼近整圆的控制点比例。四段三次贝塞尔的经典常数。
KAPPA = 4 / 3 * (math.sqrt(2) - 1)  # 0.5522847...


@dataclass
class Icon:
    """解析后的 logo 几何，单位＝SVG 用户单位（viewBox 36×36）。"""

    view: float
    center: tuple[float, float]
    radius: float
    steps: list[tuple[float, float, float, float]]
    d: str


def tokenize(d: str) -> list[tuple[str, list[float]]]:
    """把 path 的 d 切成 [(命令, 参数)]。只支持 M/C/H/V/Z（绝对），其余直接报错。

    刻意不写通用 SVG 解析器：这条 path 只用到这 5 个命令，支持更多等于给自己留下
    「解析错了但没人发现」的空间。遇到没见过的命令就应该停下来看文件。
    """
    out: list[tuple[str, list[float]]] = []
    i = 0
    while i < len(d):
        ch = d[i]
        if ch in " ,\n\t":
            i += 1
            continue
        if ch not in "MCHVZ":
            raise ValueError(f"d 里出现了不支持的命令 {ch!r}（位置 {i}）：{d[max(0, i - 20):i + 20]}")
        i += 1
        args: list[float] = []
        while i < len(d) and d[i] not in "MCHVZ":
            m = NUM_RE.match(d, i)
            if not m:
                i += 1
                continue
            args.append(float(m.group()))
            i = m.end()
        out.append((ch, args))
    return out


def split_subpaths(d: str) -> list[list[tuple[str, list[float]]]]:
    subs: list[list[tuple[str, list[float]]]] = []
    for cmd, args in tokenize(d):
        if cmd == "M":
            subs.append([])
        if not subs:
            raise ValueError("d 不是以 M 开头")
        subs[-1].append((cmd, args))
    return subs


def parse_circle(sub: list[tuple[str, list[float]]]) -> tuple[tuple[float, float], float]:
    """把「M + 4 段 C + Z」认成圆，并验证它真的是圆。

    验证的是三件事：4 个端点到均值中心等距、四段首尾相接、控制点臂长 / 半径 ≈ κ。
    只看端点不够 —— 端点共圆的四段贝塞尔也可以画出一朵花。
    """
    if sub[0][0] != "M" or len(sub[0][1]) != 2:
        raise ValueError(f"圆的第一条指令不是 M x y：{sub[0]}")
    cubics = [a for c, a in sub[1:] if c == "C"]
    if len(cubics) != 4:
        raise ValueError(f"圆应该是 4 段三次贝塞尔，实际 {len(cubics)} 段")
    start = (sub[0][1][0], sub[0][1][1])
    pts = [start]
    ctrls: list[tuple[tuple[float, float], tuple[float, float]]] = []
    cur = start
    for a in cubics:
        if len(a) != 6:
            raise ValueError(f"C 的参数不是 6 个：{a}")
        c1, c2, end = (a[0], a[1]), (a[2], a[3]), (a[4], a[5])
        ctrls.append((c1, c2))
        pts.append(end)
        cur = end
    if math.dist(cur, start) > 1e-6:
        raise ValueError(f"四段贝塞尔没有闭合：终点 {cur} ≠ 起点 {start}")
    ends = pts[:4]
    cx = sum(p[0] for p in ends) / 4
    cy = sum(p[1] for p in ends) / 4
    radii = [math.dist(p, (cx, cy)) for p in ends]
    r = sum(radii) / 4
    if max(abs(x - r) for x in radii) > 1e-3:
        raise ValueError(f"四个端点不等距，不是圆：{radii}")
    # 控制点臂长：|c1 - p_i| 与 |c2 - p_{i+1}| 都应该等于 κ·r。
    arms: list[float] = []
    for i, (c1, c2) in enumerate(ctrls):
        arms.append(math.dist(c1, pts[i]))
        arms.append(math.dist(c2, pts[i + 1]))
    for a in arms:
        if abs(a / r - KAPPA) > 2e-3:
            raise ValueError(f"控制点臂长 {a:.5f} / r {r:.5f} = {a / r:.5f}，不等于 κ {KAPPA:.5f}")
    return (cx, cy), r


def parse_rect(sub: list[tuple[str, list[float]]]) -> tuple[float, float, float, float]:
    """把「M + H/V 折线 + Z」认成轴对齐矩形。"""
    if sub[0][0] != "M" or len(sub[0][1]) != 2:
        raise ValueError(f"矩形的第一条指令不是 M x y：{sub[0]}")
    x, y = sub[0][1]
    xs, ys = [x], [y]
    for cmd, args in sub[1:]:
        if cmd == "H":
            x = args[-1]
        elif cmd == "V":
            y = args[-1]
        elif cmd == "Z":
            continue
        else:
            raise ValueError(f"矩形里出现了 {cmd}，不是纯 H/V 折线")
        xs.append(x)
        ys.append(y)
    if len(set(round(v, 4) for v in xs)) != 2 or len(set(round(v, 4) for v in ys)) != 2:
        raise ValueError(f"H/V 折线不是矩形：xs={xs} ys={ys}")
    return (min(xs), min(ys), max(xs), max(ys))


def parse_icon(svg_text: str) -> Icon:
    """解析源 SVG，要求里面只有 1 个 path（抽取后的状态），且形状不变量全部成立。"""
    paths = PATH_RE.findall(svg_text)
    if len(paths) != 1:
        raise ValueError(
            f"源 SVG 里有 {len(paths)} 个 <path>，应该只有 1 个（纯图标）。"
            "字样部分必须在 --extract 时就丢掉，不要留到渲染期再挑"
        )
    fill = FILL_RE.search(paths[0])
    if not fill or fill.group(1).lower() not in ("#000000", "#000", "black"):
        raise ValueError(f"图标 path 的 fill 不是黑色：{fill and fill.group(1)}")
    vb = re.search(r'viewBox="([^"]+)"', svg_text)
    if not vb:
        raise ValueError("源 SVG 没有 viewBox")
    v = [float(x) for x in NUM_RE.findall(vb.group(1))]
    if v[0] != 0 or v[1] != 0 or v[2] != v[3]:
        raise ValueError(f"viewBox 必须是 0 0 N N（正方形、原点对齐），实际 {v}")
    view = v[2]

    d = D_RE.search(paths[0])
    if not d:
        raise ValueError("图标 path 没有 d")
    subs = split_subpaths(d.group(1))
    if len(subs) != 6:
        raise ValueError(f"图标应该是 1 个圆 + 5 个方块共 6 条子路径，实际 {len(subs)} 条")
    center, radius = parse_circle(subs[0])
    steps = [parse_rect(s) for s in subs[1:]]

    # ---- 形状不变量 ----
    sides = [(x1 - x0, y1 - y0) for x0, y0, x1, y1 in steps]
    w0 = sides[0][0]
    for i, (w, h) in enumerate(sides):
        if abs(w - h) > 0.02 or abs(w - w0) > 0.02:
            raise ValueError(f"第 {i} 个方块不是正方形或边长与其它不一致：{w}×{h}（基准 {w0}）")
    for i, (x0, y0, x1, y1) in enumerate(steps):
        for px, py in ((x0, y0), (x1, y0), (x0, y1), (x1, y1)):
            if math.dist((px, py), center) > radius + 1e-6:
                raise ValueError(f"第 {i} 个方块的角 ({px}, {py}) 落在圆外，几何不对")
    # 阶梯：按左上角排序后，x 单调不减、y 单调不增（从左下走到右上）。
    order = sorted(steps, key=lambda r: (r[0], -r[1]))
    for a, b in zip(order, order[1:]):
        if b[0] < a[0] - 1e-6 or b[1] > a[1] + 1e-6:
            raise ValueError(f"5 个方块没构成单调阶梯：{a} → {b}")
    return Icon(view=view, center=center, radius=radius, steps=steps, d=d.group(1))


# ---------------------------------------------------------------------------
# 栅格化
# ---------------------------------------------------------------------------


def render_icon(icon: Icon, size: int = RASTER, ss: int = SUPERSAMPLE) -> Image.Image:
    """画成透明 PNG：圆盘不透明，阶梯方块填 STEP_RGB，圆外全透明。

    透明像素的 RGB 留 (0,0,0)，和圆盘同色 —— LANCZOS 缩小时边缘不会被亮色污染。
    """
    big = size * ss
    s = big / icon.view
    im = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    cx, cy = icon.center[0] * s, icon.center[1] * s
    r = icon.radius * s
    d.ellipse((cx - r, cy - r, cx - r + 2 * r, cy - r + 2 * r), fill=(*DISC_RGB, 255))
    rad = STEP_CORNER_UNITS * s
    for x0, y0, x1, y1 in icon.steps:
        box = (x0 * s, y0 * s, x1 * s, y1 * s)
        if rad > 0.5:
            d.rounded_rectangle(box, radius=rad, fill=(*STEP_RGB, 255))
        else:
            d.rectangle(box, fill=(*STEP_RGB, 255))
    return clean_alpha(im.resize((size, size), Image.LANCZOS))


# ---------------------------------------------------------------------------
# 与真 SVG 渲染器对比（qlmanage）
# ---------------------------------------------------------------------------


def reference_raster(svg: Path, size: int) -> Image.Image | None:
    """用 macOS 自带的 qlmanage 渲染 SVG 作为独立参考实现。拿不到就返回 None。

    本机没有 rsvg-convert / cairosvg / inkscape（查过），qlmanage 是唯一的第二实现。
    它输出的是白底缩略图、且内容按长边缩放后贴在左上角，所以要自己裁出图标区域。
    """
    ql = shutil.which("qlmanage")
    if not ql:
        return None
    with tempfile.TemporaryDirectory() as tmp:
        r = subprocess.run(
            [ql, "-t", "-s", str(size * 2), "-o", tmp, str(svg)],
            capture_output=True,
            text=True,
        )
        out = list(Path(tmp).glob("*.png"))
        if r.returncode != 0 or not out:
            return None
        ref = Image.open(out[0]).convert("RGB")
    # 白底上找非白内容的外接框。源 SVG 的圆正好内切 viewBox，所以这个框就是图标区域。
    gray = ref.convert("L").point(lambda v: 255 if v < 250 else 0)
    bbox = gray.getbbox()
    if bbox is None:
        return None
    return ref.crop(bbox).resize((size, size), Image.LANCZOS)


def _black_mask(im: Image.Image) -> Image.Image:
    """「黑墨区域」二值掩膜。

    为什么比掩膜而不是比 RGB：参考图是白底不透明，我的产物是透明底，
    直接比 RGB 等于在比背景色。真正要证明的是**形状**一致 —— 黑墨区域重合。
    透明像素一律算不是黑墨（即使 RGB 是 0,0,0）。
    """
    im = im.convert("RGBA")
    a = im.getchannel("A").point(lambda v: 255 if v > 128 else 0)
    dark = im.convert("L").point(lambda v: 255 if v < 128 else 0)
    return ImageChops.multiply(a, dark)


def compare_to_reference(mine: Image.Image, ref: Image.Image, size: int = RASTER) -> dict:
    """我的栅格化 vs. 真 SVG 渲染器，比形状。

    两步归一化，否则比出来的全是无意义的系统偏差：
    1. 各自裁到黑墨外接框再缩到同一尺寸。qlmanage 的缩略图是按内容外接框（含抗锯齿）
       定位的，直接比会带 ~1.5% 的尺度差，表现为整圈 2 px 的假差异。
    2. 差异分两类报：`mismatchPixels` 是总数（必然包含抗锯齿边），
       `deepMismatchPixels` 只数**离自己掩膜边界 2 px 以上**的错判 ——
       形状真的画错了（少一个方块、方块错位）才会落进这一类。
       所以「形状一致」的判据是 deepMismatchPixels ≈ 0，而不是 IoU 有多高。
    """
    mm = _black_mask(mine)
    mr = _black_mask(ref)
    bm, br = mm.getbbox(), mr.getbbox()
    if bm is None or br is None:
        return {"error": "有一张图没有黑墨像素"}
    binarize = lambda im: im.point(lambda v: 255 if v > 128 else 0)  # noqa: E731
    mm = binarize(mm.crop(bm).resize((size, size), Image.LANCZOS))
    mr = binarize(mr.crop(br).resize((size, size), Image.LANCZOS))
    # 腐蚀 2 px 得到「深处」。MinFilter(5) ≈ 半径 2 的腐蚀。
    inner_m = mm.filter(ImageFilter.MinFilter(5))
    inner_r = mr.filter(ImageFilter.MinFilter(5))
    a, b = list(mm.getdata()), list(mr.getdata())
    ia, ib = list(inner_m.getdata()), list(inner_r.getdata())
    inter = union = diff = deep = 0
    for i in range(size * size):
        m, r = a[i] > 128, b[i] > 128
        if m and r:
            inter += 1
        if m or r:
            union += 1
        if m != r:
            diff += 1
            if (m and ia[i] > 128) or (r and ib[i] > 128):
                deep += 1
    return {
        "iou": round(inter / union, 5) if union else 0.0,
        "pixelAgreement": round(1 - diff / (size * size), 5),
        "mismatchPixels": diff,
        "deepMismatchPixels": deep,
        "bboxNormalized": [list(bm), list(br)],
        "size": size,
        "reference": "qlmanage (macOS QuickLook SVG renderer)",
    }


# ---------------------------------------------------------------------------
# 旧徽章实测
# ---------------------------------------------------------------------------


def measure_badge(master: Image.Image, window, seed) -> dict:
    """量出 master 上那个假徽章：中心、外接框、以及到中心的最大距离（coverRadius）。

    做法是从外环上的一个种子点洪水填充「深色且低饱和」的像素，范围限制在 window 内。
    不能全图找深色：鞋子是深棕、眼睛有黑描边、发丝有深色勾线，都会混进来。
    """
    px = master.load()
    x0, y0, x1, y1 = window

    def dark(x: int, y: int) -> bool:
        r, g, b, a = px[x, y]
        mx, mn = max(r, g, b), min(r, g, b)
        return a > 100 and mx <= 150 and (mx - mn) <= 70

    if not dark(*seed):
        raise ValueError(f"种子点 {seed} 不是深色像素 —— master 变了，去看图再改 BADGE_PROBE")
    seen = {seed}
    stack = [seed]
    while stack:
        x, y = stack.pop()
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if x0 <= nx < x1 and y0 <= ny < y1 and (nx, ny) not in seen and dark(nx, ny):
                seen.add((nx, ny))
                stack.append((nx, ny))
    xs = [p[0] for p in seen]
    ys = [p[1] for p in seen]
    bbox = (min(xs), min(ys), max(xs) + 1, max(ys) + 1)
    cx = (bbox[0] + bbox[2]) / 2
    cy = (bbox[1] + bbox[3]) / 2
    cover = max(math.dist((x + 0.5, y + 0.5), (cx, cy)) for x, y in seen)
    return {
        "pixels": len(seen),
        "bbox": list(bbox),
        "center": [cx, cy],
        "coverRadius": round(cover, 3),
    }


# ---------------------------------------------------------------------------
# 抽取模式
# ---------------------------------------------------------------------------


def extract(original: Path) -> str:
    """从完整 logo SVG 里抽出第 1 个 path，写成独立的 36×36 源文件。

    「第 1 个」不是猜的：抽完之后会把结果交给 parse_icon 验一遍，
    形状不变量（圆 + 5 个等边方块 + 单调阶梯）不成立就不会落盘。
    """
    txt = original.read_text()
    paths = PATH_RE.findall(txt)
    if not paths:
        raise ValueError(f"{original} 里没有 <path>")
    icon_path = paths[0]
    vb = re.search(r'viewBox="([^"]+)"', txt)
    if not vb:
        raise ValueError("原文件没有 viewBox")
    v = [float(x) for x in NUM_RE.findall(vb.group(1))]
    side = v[3]  # 图标是正方形，取 viewBox 的高
    digest = hashlib.sha256(original.read_bytes()).hexdigest()
    out = (
        f'<svg width="{side:g}" height="{side:g}" viewBox="0 0 {side:g} {side:g}" '
        'fill="none" xmlns="http://www.w3.org/2000/svg">\n'
        f"<!-- origin={original.name} sha256={digest} path=1/{len(paths)} "
        f'dropped={len(paths) - 1}(StepFun wordmark) -->\n'
        f"{icon_path}\n"
        "</svg>\n"
    )
    parse_icon(out)  # 验证通过才写盘
    SOURCE_SVG.write_text(out)
    print(f"已抽取 → {SOURCE_SVG}（原文件 {len(paths)} 个 path，保留第 1 个，丢弃 {len(paths) - 1} 个字样 path）")
    return out


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--extract", type=Path, help="从完整 logo SVG 重新抽取纯图标源文件")
    args = ap.parse_args()

    if args.extract:
        extract(args.extract)

    if not SOURCE_SVG.exists():
        print(f"找不到 {SOURCE_SVG}；先跑 --extract <完整 logo.svg>", file=sys.stderr)
        return 1

    svg_text = SOURCE_SVG.read_text()
    icon = parse_icon(svg_text)
    origin = ORIGIN_RE.search(svg_text)
    print(
        f"几何校验通过：圆心 {icon.center} 半径 {icon.radius}，"
        f"{len(icon.steps)} 个方块，边长 {icon.steps[0][2] - icon.steps[0][0]:.5f}"
    )

    RIG_DIR.mkdir(parents=True, exist_ok=True)
    im = render_icon(icon)
    out_png = ASSETS / LOGO_PNG
    im.save(out_png)
    print(f"栅格化 → {out_png} {im.size}")

    ref = reference_raster(SOURCE_SVG, RASTER)
    fidelity = compare_to_reference(im, ref) if ref is not None else None
    if fidelity:
        print(
            f"与 qlmanage 渲染的同一份 SVG 对比：IoU {fidelity['iou']:.4f}，"
            f"像素一致率 {fidelity['pixelAgreement']:.4f}；"
            f"总差异 {fidelity['mismatchPixels']} px，其中离边界 2px 以上的「真形状错」"
            f"{fidelity['deepMismatchPixels']} px"
        )
    else:
        print("!! 本机没有可用的 SVG 渲染器（qlmanage 失败），无法做独立对比")

    master = clean_alpha(Image.open(MASTER))
    placements: dict[str, dict] = {}
    measured: dict[str, dict] = {}
    for slot, probe in BADGE_PROBE.items():
        m = measure_badge(master, probe["window"], probe["seed"])
        measured[slot] = m
        cover_rt = m["coverRadius"] * MASTER_TO_RUNTIME
        size = math.ceil(cover_rt * 2 * (1 + COVER_MARGIN))
        tune = LOGO_TUNING[slot]
        placements[slot] = {
            "cx": round(m["center"][0] * MASTER_TO_RUNTIME, 2),
            "cy": round(m["center"][1] * MASTER_TO_RUNTIME, 2),
            "size": size,
            "rotation": tune["rotation"],
            "jiggle": tune["jiggle"],
            "coverRadius": round(cover_rt, 3),
        }
        # 盖不住就不要发车。这条断言是「覆盖得住」这句话的全部分量。
        if size / 2 < cover_rt:
            raise ValueError(f"{slot}: 直径 {size} 盖不住实测半径 {cover_rt:.2f}")
        print(
            f"{slot}: 旧徽章中心 {m['center']} 覆盖半径 {m['coverRadius']:.2f}(1024) "
            f"→ logo 直径 {size} 圆心 ({placements[slot]['cx']}, {placements[slot]['cy']})(512)，"
            f"余量 {size / 2 / cover_rt - 1:.1%}"
        )

    manifest = {
        "version": "1.0.0",
        "source": {
            "svg": SOURCE_SVG.name,
            "svgSha256": sha256_file(SOURCE_SVG),
            "origin": origin.group(1) if origin else "(未记录)",
            "raster": {"size": RASTER, "supersample": SUPERSAMPLE, "renderer": "Pillow geometry"},
            "fidelity": fidelity,
            "geometry": {
                "view": icon.view,
                "center": list(icon.center),
                "radius": icon.radius,
                "steps": [list(s) for s in icon.steps],
            },
        },
        "canvas": {"width": 512, "height": 512},
        "asset": {
            "file": LOGO_PNG,
            "sha256": sha256_file(out_png),
            "width": im.width,
            "height": im.height,
        },
        "placements": placements,
        "measured": measured,
        "appliesTo": APPLIES_TO,
        "degraded": [
            {
                "name": "logo.nonIdleActions",
                "reason": (
                    "logo 的位置是按 idle 画幅实测的（见 measured）。换姿势的动作图上徽章位置全变了，"
                    f"所以 logo 层只在 {', '.join(APPLIES_TO)} 下显示；其余动作会露出 master 自带的假徽章。"
                    "要修就得为每个动作各量一次位置，不是改一个数能解决的"
                ),
            },
            {
                "name": "logo.steps",
                "reason": (
                    "原 SVG 的 5 个阶梯方块是镂空（透明），这里填成不透明白色。"
                    "镂空会让下面那个假徽章从缝里透出来；填白之后圆盘整体不透明，"
                    "视觉上等同 logo 在白底上的样子，但严格说不是「镂空」"
                ),
            },
        ],
    }
    (ASSETS / "logo.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    print(f"写入 {ASSETS / 'logo.json'}；运行期副本用 `npm run sync-rig`")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
