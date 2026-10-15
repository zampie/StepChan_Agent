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
4. **覆盖旧假徽章的位置与尺寸由实测决定，而且是「逐画幅」各测一次。**
   每个姿势图上那两枚假徽章都被单独量过中心与覆盖半径（深色像素到中心的最大距离），
   `size` 必须 ≥ `coverRadius`×2，否则断言失败。这就是「盖得住」的证据。
   量不到（被遮住）或形状不对的那一格**不写 placement**，运行期那一枚 logo 就不显示，
   并记进 degraded —— 不猜位置。

为什么不改 master/base.png 把 logo 烤进去：烤进去就没法回退，还要重跑整条流水线。
运行期覆盖只多两个 sprite，且随时可关。

上一版的降级（`logo.nonIdleActions`：只在 idle/tilt 显示 logo，其余姿势露出假徽章）
正是因为只量了 idle 一张画幅。现在逐画幅测量，那条降级被这个版本取代。

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
# 这里**没有**手填的坐标。每个画幅（每张姿势图 / 每张整脸 sprite）上的两枚假徽章
# 都由 find_badges() 从像素里量出来，写进 logo.json 的 placements[action][slot]。
# 渲染器只读清单，不在渲染逻辑里硬编码任何一个数。
#
# 测量跑在**运行期纹理**（assets/stepchan_q_v1/rig/*.png，512×512）上，而不是 1024 的
# raw 原图：动作图在 register.py 里经过 align_bottom_center() 平移对齐，raw 的坐标
# 乘 0.5 并不等于运行期坐标。量运行期纹理就不需要复刻那套对齐，坐标直接可用。
#
# idle 这一帧额外用旧的 master 探针（measure_badge，窗口 + 种子点，1024 坐标）交叉验一遍，
# 两种方法的中心差必须 ≤ PROBE_TOLERANCE_PX、覆盖半径差 ≤ 10% ——
# 新的自动检测器是靠这条断言证明自己没量错的，不是靠「看起来对」。
MASTER_TO_RUNTIME = 0.5
# 旧徽章的 master 探针（1024 坐标）与一个落在深色外环上的种子点。
# 窗口刻意开得紧：发饰徽章右下方有一道深色发丝描边，窗口大了会把它一起吃进来，
# 量出的 coverRadius 就虚高。
BADGE_PROBE = {
    "hair": {"window": (606, 208, 670, 270), "seed": (637, 217)},
    "chest": {"window": (536, 558, 576, 598), "seed": (555, 567)},
}
# 自动检测器的交叉验证容差（运行期坐标，px / 比例）。
PROBE_TOLERANCE_PX = 1.5
PROBE_COVER_TOLERANCE = 0.10
# 覆盖余量：直径 = ceil(coverRadius × 2 × (1 + COVER_MARGIN))。
# 12% 是为了吃掉旧徽章的抗锯齿外沿 —— 刚好相切会在 220 px 下露出一圈灰边。
COVER_MARGIN = 0.12
# 自转与抖动系数。位置和尺寸都是逐画幅实测的，这两项不是。
#
# rotation：**刻意不用实测角**。badge_angle() 能量出假徽章自身的转角（写在 measured 里），
#   但不把它用作 logo 的自转，两个原因：
#   (1) 阶梯是品牌标记，有「正置」的惯用读法。按实测角转过去（发饰各帧 -7°～-15°、
#       sleep 那帧 +41°）在 220 px 下读作「logo 歪了」，而不是「logo 跟着发夹歪」；
#   (2) 四重对称的方块只能把角规约到 (-45,45]，sleep 的 +39° 与 -51° 在像素上无法区分，
#       而圆盘本身是圆的，转多少都一样能盖住 —— 没有任何客观依据挑其中一个。
#   所以这里保留原来那个小角度：发饰上的假徽章在 master 里略微左倾（头发的走向），
#   -0.06 rad ≈ -3.4°，视觉上仍是正置的阶梯。
# jiggle：跟随身体摆动的**额外**抖动系数（0 = 完全贴死在身上）。
#   发饰是夹子，会比衣料多晃一点；胸前那块贴在平整的水手领上，不单独晃。
LOGO_TUNING = {
    "hair": {"rotation": -0.06, "jiggle": 0.35},
    "chest": {"rotation": 0.0, "jiggle": 0.0},
}

# ---- 自动徽章检测的判据 ----
#
# 徽章在配色里是唯一的「大块深色低饱和」图形：头发是冰蓝、衣服白+青、肤色暖白、
# 眼睛是高饱和蓝、鞋是深棕但面积大得多。所以先按「深且低饱和」取连通域，
# 再用形状与尺寸筛，最后按**相对 idle 的覆盖半径**把候选分派给 hair / chest 两个位置。
# 每个位置必须恰好剩一个候选 —— 剩 0 个（被遮住）或 ≥2 个（分不清）都降级，不猜。
DARK_MAX = 150  # RGB 三通道最大值上限（master 探针用的同一组判据）
DARK_SAT = 70  # 饱和度（max − min）上限
MIN_BADGE_PX = 60  # 连通域像素数下限。idle 胸前那枚最小，110 px
ASPECT_RANGE = (0.65, 1.55)  # 外接框长宽比。徽章是方的，转起来也还是方的
FILL_RANGE = (0.30, 0.92)  # 像素数 / 外接框面积。徽章是个「环」（中间是白方块），实测 0.49–0.82
COVER_RANGE = (0.70, 1.40)  # 覆盖半径 / idle 同位置的覆盖半径
# 整脸 sprite（shy/angry/sad）的徽章位置与 idle 的允许偏差。
# register.py 给整脸图走的是 save_full（只抠色 + 缩放，没有平移对齐），
# 实测三张都与 idle 对得上（≤0.5 px）；超过这个容差就必须为 sprite 单列 placement，
# 所以这里是断言，不是容忍。
SPRITE_TOLERANCE_PX = 1.5

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

    这条路只用于 idle 那一帧的**交叉验证**（窗口和种子点是手给的，换张图就不成立）。
    逐画幅测量走的是 find_badges()。
    """
    px = master.load()
    x0, y0, x1, y1 = window

    def dark(x: int, y: int) -> bool:
        r, g, b, a = px[x, y]
        mx, mn = max(r, g, b), min(r, g, b)
        return a > 100 and mx <= DARK_MAX and (mx - mn) <= DARK_SAT

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
# 逐画幅徽章检测
# ---------------------------------------------------------------------------


@dataclass
class Blob:
    """一个「深色低饱和」连通域。坐标单位＝该图自己的像素（运行期纹理 512）。"""

    pixels: list[int]
    bbox: tuple[int, int, int, int]
    center: tuple[float, float]
    cover: float
    aspect: float
    fill: float
    angle_deg: float
    angle_strength: float


def dark_mask(im: Image.Image) -> Image.Image:
    """「深且低饱和且不透明」的二值掩膜。

    判据与 measure_badge 的 dark() 完全一致（a>100、max≤DARK_MAX、max−min≤DARK_SAT），
    只是改用 Pillow 的通道运算做 —— 13 张 512² 图用纯 Python 逐像素要几十秒。
    """
    im = im.convert("RGBA")
    r, g, b, a = im.split()
    mx = ImageChops.lighter(ImageChops.lighter(r, g), b)
    mn = ImageChops.darker(ImageChops.darker(r, g), b)
    sat = ImageChops.subtract(mx, mn)
    out = a.point(lambda v: 255 if v > 100 else 0)
    out = ImageChops.multiply(out, mx.point(lambda v: 255 if v <= DARK_MAX else 0))
    return ImageChops.multiply(out, sat.point(lambda v: 255 if v <= DARK_SAT else 0))


def badge_angle(pixels: list[int], width: int, center: tuple[float, float]) -> tuple[float, float]:
    """估计方形徽章的自转角（度），以及这个估计有多「像方的」。

    方形有 4 重对称，协方差矩阵是各向同性的，求不出朝向；最小面积外接矩形在圆角方块上
    又很不稳（实测同一枚上下跳 ±14°）。所以用**四次谐波**：
    沿角度分 180 个桶取最远的那个像素（外轮廓），算 Σ r·e^{i4φ}。
    方块的最远点在四个角上，所以这个和的相位 /4 指向**角**的方向，
    轴对齐的方块会得到 45° —— 减掉 45 才是方块本身的转角。

    返回的角已规约到 (-45, 45]：4 重对称下 θ 和 θ±90 在像素上完全等价，
    无法从图里分辨，所以只能挑离 0 最近的那个代表元（idle 的徽章本来就接近正置）。
    第二个返回值是 |Σ| / Σr（0..1），越大越「有方向」—— 圆角很重的方块天生只有 0.07~0.17，
    所以它不是判据，只是落在 measured 里供复核的数字。
    """
    buckets = 180
    far: list[tuple[float, float] | None] = [None] * buckets
    for p in pixels:
        dx = (p % width) + 0.5 - center[0]
        dy = (p // width) + 0.5 - center[1]
        r = math.hypot(dx, dy)
        if r < 1:
            continue
        k = int((math.atan2(dy, dx) + math.pi) / (2 * math.pi) * buckets) % buckets
        cur = far[k]
        if cur is None or r > cur[0]:
            far[k] = (r, math.atan2(dy, dx))
    acc = 0j
    total = 0.0
    for item in far:
        if item is None:
            continue
        r, phi = item
        acc += r * complex(math.cos(4 * phi), math.sin(4 * phi))
        total += r
    if total <= 0:
        return 0.0, 0.0
    deg = math.degrees(math.atan2(acc.imag, acc.real)) / 4 - 45.0
    # 规约到 (-45, 45]
    deg = (deg + 45.0) % 90.0 - 45.0
    return round(deg, 3), round(abs(acc) / total, 4)


def open_frame(rel: str) -> Image.Image:
    """打开一张运行期纹理（rig.json 里的相对路径）。测量对象就是渲染器真正画的那张图。"""
    return Image.open(ASSETS / rel).convert("RGBA")


def dark_blobs(im: Image.Image) -> list[Blob]:
    """图上所有「深色低饱和」连通域，按像素数降序。4 邻接洪水填充，512² 够快。"""
    mask = dark_mask(im)
    w, h = mask.size
    px = list(mask.getdata())
    seen = bytearray(w * h)
    out: list[Blob] = []
    for start in range(w * h):
        if not px[start] or seen[start]:
            continue
        stack = [start]
        seen[start] = 1
        pts: list[int] = []
        while stack:
            i = stack.pop()
            pts.append(i)
            x, y = i % w, i // w
            for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if 0 <= nx < w and 0 <= ny < h:
                    j = ny * w + nx
                    if px[j] and not seen[j]:
                        seen[j] = 1
                        stack.append(j)
        if len(pts) < MIN_BADGE_PX:
            continue
        xs = [p % w for p in pts]
        ys = [p // w for p in pts]
        bbox = (min(xs), min(ys), max(xs) + 1, max(ys) + 1)
        cx = (bbox[0] + bbox[2]) / 2
        cy = (bbox[1] + bbox[3]) / 2
        bw, bh = bbox[2] - bbox[0], bbox[3] - bbox[1]
        cover = max(math.dist((p % w + 0.5, p // w + 0.5), (cx, cy)) for p in pts)
        ang, strength = badge_angle(pts, w, (cx, cy))
        out.append(
            Blob(
                pixels=pts,
                bbox=bbox,
                center=(cx, cy),
                cover=cover,
                aspect=bw / max(1, bh),
                fill=len(pts) / max(1, bw * bh),
                angle_deg=ang,
                angle_strength=strength,
            )
        )
    out.sort(key=lambda b: -len(b.pixels))
    # 丢掉「嵌在别人里面」的连通域。
    # 徽章的画法是「深色圆角方框 + 白方块 + 深色小方块」，中间那枚小方块是独立连通域，
    # 形状上和胸前那枚真徽章几乎一样大（实测 cover 5.5 vs 7.5）—— 不排掉的话
    # sleep 那一帧会把发饰徽章里的小方块当成胸前徽章，两枚 logo 叠在同一个点上。
    kept: list[Blob] = []
    for b in out:
        inside = any(
            o.bbox[0] <= b.bbox[0] and o.bbox[1] <= b.bbox[1]
            and o.bbox[2] >= b.bbox[2] and o.bbox[3] >= b.bbox[3]
            for o in kept
        )
        if not inside:
            kept.append(b)
    return kept


def blob_record(b: Blob) -> dict:
    return {
        "pixels": len(b.pixels),
        "bbox": list(b.bbox),
        "center": [b.center[0], b.center[1]],
        "coverRadius": round(b.cover, 3),
        "aspect": round(b.aspect, 3),
        "fill": round(b.fill, 3),
        "angleDeg": b.angle_deg,
        "angleStrength": b.angle_strength,
    }


def find_badges(im: Image.Image, ref_cover: dict[str, float] | None) -> tuple[dict, dict]:
    """在一张画幅上找出两枚假徽章。

    @param ref_cover 每个位置在 idle 上的实测覆盖半径；None 表示**这张就是 idle**，
                     此时用「两枚徽章的尺寸比约 1.8」这条内部关系自举：
                     取形状合格的候选里最大和次大的两个，大的是发饰、小的是胸前。
    @returns (找到的 {slot: blob_record}, 没找到的 {slot: 原因})

    分派规则：候选按覆盖半径与各位置参考值的**对数比**就近归属，再要求比值落在
    COVER_RANGE 内。每个位置必须恰好剩一个候选 —— 0 个说明被遮住了、≥2 个说明分不清，
    两种都降级，不挑一个「看起来最像的」。
    """
    shaped = [
        b
        for b in dark_blobs(im)
        if ASPECT_RANGE[0] <= b.aspect <= ASPECT_RANGE[1]
        and FILL_RANGE[0] <= b.fill <= FILL_RANGE[1]
    ]
    found: dict[str, dict] = {}
    missing: dict[str, str] = {}

    if ref_cover is None:
        # idle 自举：鞋子（cover 20–29）比发饰（13.4）大得多，但形状筛过后仍可能留下，
        # 所以这里不能简单「取最大的两个」。用「上下关系 + 尺寸比」两条：
        # 发饰在胸前上方，且两者半径比在 1.5–2.2 之间（实测 13.42 / 7.50 = 1.79）。
        best: tuple[Blob, Blob] | None = None
        for i, a in enumerate(shaped):
            for b in shaped[i + 1 :]:
                big, small = (a, b) if a.cover >= b.cover else (b, a)
                ratio = big.cover / max(small.cover, 1e-6)
                if not (1.5 <= ratio <= 2.2):
                    continue
                if big.center[1] >= small.center[1]:
                    continue  # 发饰必须在胸前上方
                if best is None or len(big.pixels) + len(small.pixels) > len(best[0].pixels) + len(
                    best[1].pixels
                ):
                    best = (big, small)
        if best is None:
            raise ValueError(
                "在 idle 画幅上找不到「上方大 + 下方小、半径比 1.5–2.2」的一对深色方块 —— "
                "素材的徽章画法变了，去看图再调判据，不要放宽阈值蒙过去"
            )
        found["hair"] = blob_record(best[0])
        found["chest"] = blob_record(best[1])
        return found, missing

    for slot, r0 in ref_cover.items():
        hits = []
        for b in shaped:
            # 就近归属：比起另一个位置，这个位置的参考半径更接近才算这一格的候选。
            scores = {s: abs(math.log(b.cover / max(r, 1e-6))) for s, r in ref_cover.items()}
            if min(scores, key=lambda s: scores[s]) != slot:
                continue
            if COVER_RANGE[0] <= b.cover / r0 <= COVER_RANGE[1]:
                hits.append(b)
        if len(hits) == 1:
            found[slot] = blob_record(hits[0])
        elif not hits:
            missing[slot] = (
                f"画幅上找不到符合形状与尺寸的徽章（参考覆盖半径 {r0:.2f}，"
                f"允许 {COVER_RANGE[0]:.0%}–{COVER_RANGE[1]:.0%}）：这个姿势下它被遮住或转到看不见了"
            )
        else:
            centers = ", ".join(f"({b.center[0]:.0f},{b.center[1]:.0f})" for b in hits)
            missing[slot] = (
                f"有 {len(hits)} 个候选都像徽章（中心 {centers}），分不清是哪一个 —— 不猜位置"
            )
    # 上下关系的兜底校验：发饰必须在胸前上方。错了说明归属搞反了，不能发车。
    if "hair" in found and "chest" in found and found["hair"]["center"][1] >= found["chest"]["center"][1]:
        raise ValueError(
            f"发饰徽章 {found['hair']['center']} 不在胸前徽章 {found['chest']['center']} 上方 —— 归属反了"
        )
    return found, missing


def placement_of(rec: dict, slot: str) -> dict:
    """实测记录 → 渲染器用的 placement。直径由覆盖半径 + 余量算出，断言盖得住。

    cx/cy/size 来自实测；rotation/jiggle 来自 LOGO_TUNING（见那里为什么不用实测角）。
    """
    cover = rec["coverRadius"]
    size = math.ceil(cover * 2 * (1 + COVER_MARGIN))
    if size / 2 < cover:
        raise ValueError(f"{slot}: 直径 {size} 盖不住实测半径 {cover:.2f}")
    return {
        "cx": round(rec["center"][0], 2),
        "cy": round(rec["center"][1], 2),
        "size": size,
        "rotation": LOGO_TUNING[slot]["rotation"],
        "jiggle": LOGO_TUNING[slot]["jiggle"],
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
    rig_path = ASSETS / "rig.json"
    if not rig_path.exists():
        print(f"找不到 {rig_path}；先跑 tools/art/register.py", file=sys.stderr)
        return 1
    rig = json.loads(rig_path.read_text())

    # ---- 1. idle 画幅：自动检测器 vs. 旧的 master 探针，交叉验证 ----
    idle_file = rig["actions"]["idle"]["file"]
    idle_found, idle_missing = find_badges(open_frame(idle_file), None)
    if idle_missing:
        raise ValueError(f"idle 画幅上就有量不到的徽章：{idle_missing} —— 不要继续")
    probe: dict[str, dict] = {}
    for slot, p in BADGE_PROBE.items():
        m = measure_badge(master, p["window"], p["seed"])
        probe[slot] = m
        got = idle_found[slot]
        pc = [m["center"][0] * MASTER_TO_RUNTIME, m["center"][1] * MASTER_TO_RUNTIME]
        pr = m["coverRadius"] * MASTER_TO_RUNTIME
        d = math.dist(got["center"], pc)
        rel = abs(got["coverRadius"] / pr - 1)
        if d > PROBE_TOLERANCE_PX or rel > PROBE_COVER_TOLERANCE:
            raise ValueError(
                f"{slot}: 自动检测 {got['center']} r={got['coverRadius']:.2f} 与 master 探针 "
                f"{pc} r={pr:.2f} 不一致（差 {d:.2f} px / {rel:.1%}）—— 检测器或素材有问题"
            )
        print(
            f"idle {slot}: 自动检测 中心 {got['center']} 覆盖半径 {got['coverRadius']:.2f}；"
            f"master 探针 {pc} r={pr:.2f}（差 {d:.2f} px / {rel:.1%}）✓"
        )
    ref_cover = {slot: idle_found[slot]["coverRadius"] for slot in BADGE_PROBE}

    # ---- 2. 逐动作测量 ----
    # 多个动作可能指向同一张图（tilt 没有独立素材，指向 idle 的整身图），所以按文件缓存，
    # 同一张图只量一次 —— 顺带保证指向同一张图的动作拿到完全相同的 placement。
    placements: dict[str, dict] = {}
    measured_frames: dict[str, dict] = {}
    degraded: list[dict] = []
    for action, asset_entry in rig["actions"].items():
        file = asset_entry["file"]
        if file not in measured_frames:
            found, missing = find_badges(open_frame(file), ref_cover)
            measured_frames[file] = {"found": found, "missing": missing}
        found = measured_frames[file]["found"]
        missing = measured_frames[file]["missing"]
        placements[action] = {slot: placement_of(rec, slot) for slot, rec in found.items()}
        for slot, reason in missing.items():
            degraded.append({"name": f"logo.{slot}.{action}", "reason": f"{file}：{reason}"})
        shown = ", ".join(
            f"{s}@({p['cx']},{p['cy']}) d={p['size']} rot={math.degrees(p['rotation']):.1f}°"
            for s, p in placements[action].items()
        )
        print(f"action {action:8s} [{Path(file).name}] {shown or '(无 logo)'}" + (f"  缺：{', '.join(missing)}" if missing else ""))

    # ---- 3. 整脸 sprite：量一遍并与 idle 比对 ----
    # 整脸图是满画幅的，会盖住 base 连带盖住身上的徽章，所以必须确认它们的徽章在哪。
    # 实测三张都与 idle 一致（register.py 给整脸图没做平移对齐，但模型画的位置本来就没变），
    # 所以运行期沿用 idle 帧的 placement —— 这是实测结论，不是假设；超差就报错。
    sprite_measured: dict[str, dict] = {}
    for name, entry in rig["expressions"].items():
        if entry.get("mode") != "sprite":
            continue
        found, missing = find_badges(open_frame(entry["sprite"]["file"]), ref_cover)
        sprite_measured[name] = {"found": found, "missing": missing}
        for slot, rec in found.items():
            d = math.dist(rec["center"], idle_found[slot]["center"])
            rel = abs(rec["coverRadius"] / idle_found[slot]["coverRadius"] - 1)
            if d > SPRITE_TOLERANCE_PX or rel > PROBE_COVER_TOLERANCE:
                raise ValueError(
                    f"整脸表情 {name} 的 {slot} 徽章在 {rec['center']}，与 idle "
                    f"{idle_found[slot]['center']} 差 {d:.2f} px / {rel:.1%} —— "
                    "超过容差，必须给 sprite 表情单列 placement，不能沿用 idle 帧"
                )
            print(f"sprite {name:8s} {slot}: 与 idle 差 {d:.2f} px / {rel:.1%} ✓")
        for slot in missing:
            # sprite 只在 idle/tilt 画幅下显示，那两帧的 logo 照常画在 idle 位置上；
            # 这里量不到只说明整脸图把徽章改掉了，必须留痕。
            degraded.append(
                {
                    "name": f"logo.{slot}.expression.{name}",
                    "reason": f"整脸图 {entry['sprite']['file']}：{missing[slot]}",
                }
            )

    degraded.append(
        {
            "name": "logo.steps",
            "reason": (
                "原 SVG 的 5 个阶梯方块是镂空（透明），这里填成不透明白色。"
                "镂空会让下面那个假徽章从缝里透出来；填白之后圆盘整体不透明，"
                "视觉上等同 logo 在白底上的样子，但严格说不是「镂空」"
            ),
        }
    )
    degraded.append(
        {
            "name": "logo.rotation",
            "reason": (
                "自转角没有用实测值。badge_angle() 用四次谐波量出了每一帧假徽章自身的转角"
                "（见 measured.frames[*].found[*].angleDeg，发饰各帧 -7°～-15°、sleep 那帧 +41°），"
                "但方块有 4 重对称，θ 与 θ±90° 在像素上完全等价（sleep 的 +39° 与 -51° 无法区分），"
                "而且阶梯是品牌标记、有正置的惯用读法 —— 跟着假徽章转会读作「logo 歪了」。"
                "所以 placement.rotation 用的是 LOGO_TUNING 里的固定小角度（发饰 -3.4°、胸前 0°）"
            ),
        }
    )

    manifest = {
        "version": "2.0.0",
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
        "canvas": {"width": rig["canvas"]["width"], "height": rig["canvas"]["height"]},
        "asset": {
            "file": LOGO_PNG,
            "sha256": sha256_file(out_png),
            "width": im.width,
            "height": im.height,
        },
        "placements": placements,
        "measured": {
            "method": (
                "逐画幅实测：对每张运行期纹理（rig/*.png，512²）取「深色低饱和」连通域，"
                "按形状（长宽比/填充率）与相对 idle 的覆盖半径分派给 hair/chest，"
                "每格必须恰好一个候选；中心取外接框中心，coverRadius 取深色像素到中心的最大距离"
            ),
            "thresholds": {
                "darkMax": DARK_MAX,
                "darkSat": DARK_SAT,
                "minPixels": MIN_BADGE_PX,
                "aspect": list(ASPECT_RANGE),
                "fill": list(FILL_RANGE),
                "coverVsIdle": list(COVER_RANGE),
                "coverMargin": COVER_MARGIN,
            },
            "idleProbe": probe,
            "frames": {
                file: {
                    "found": v["found"],
                    "missing": {k: r for k, r in v["missing"].items()},
                }
                for file, v in measured_frames.items()
            },
            "spriteExpressions": sprite_measured,
        },
        "degraded": degraded,
    }
    (ASSETS / "logo.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    print(f"\n写入 {ASSETS / 'logo.json'}；运行期副本用 `npm run sync-rig`")
    print(f"degraded: {len(degraded)}")
    for d in degraded:
        print(f"  - {d['name']}: {d['reason']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
