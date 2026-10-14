#!/usr/bin/env python
"""用像素 diff 做配准，产出 rig.json。

这是整条流水线的关键一步，也是上一版素材清单明确禁止脸部合成的那个坑
（"Avoid facial compositing or animation crossfade until alignment QA"、eyeLayers: pending）的解法：
不靠断言，靠实测。

做法：
1. 变体抠像 → 与 base 逐像素比较，三通道取 max 得到「变化幅度图」。
2. 幅度图高斯模糊再阈值化 → 「变化密度图」。这一步是必需的：
   edits 会把整幅图重绘一遍，发丝和描边的抗锯齿到处都有 ±30 的差，
   直接按像素阈值取外接框会得到一个横跨半张图的框。模糊把稀疏噪声均掉，密集的真实改动留下。
3. 两道判定，阈值都由实测标定（见 registration-report.json）：
   - 剪影异或占比：直接回答「身体有没有动」。脸部改动全部落在 0.78%–0.86%，换姿势 1.1%–78%。
   - 密度区面积占比：回答「改动是不是局部的」。脸部改动 1.6%–11.7%，换姿势 32%–108%。
   任一不过 → 不假装能分层，退 mode:'sprite' 整图交叉淡入，并写进 degraded。
4. 通过的变体取密度图的最大连通域为 ROI，在 ROI 内取精细掩膜，
   **按掩膜挖掉 alpha** 再裁剪。覆盖层只包含真正变了的像素，所以
   base + overlay 在数学上等于变体原图，而且眼/眉/嘴/腮红四组覆盖层互不遮挡。
   矩形裁剪做不到这一点 —— 腮红的框会横跨鼻子盖住嘴。
5. 身份项（eyes.open / brow.neutral / mouth.closed）就是 base 自己，没有任何变化像素，
   所以写成 1×1 全透明贴图。这是「空操作」的精确表达，不是占位符。

运行：~/Desktop/gpt-image-lab/.venv/bin/python tools/art/register.py
"""

from __future__ import annotations

import json
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from PIL import Image, ImageChops, ImageDraw, ImageFilter  # noqa: E402

from alpha import alpha_report, clean_alpha, content_bbox, sha256_file  # noqa: E402
from chroma import chroma_key, key_ratio  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets" / "stepchan_q_v1"
RAW = ASSETS / "raw"
RIG_DIR = ASSETS / "rig"
MASTER = ASSETS / "master.png"
PUBLIC = ROOT / "apps" / "web" / "public" / "assets" / "stepchan_q_v1"

CANVAS = 1024
# 运行时尺寸。桌宠显示 200–400 px，默认 280；512 在默认档位是 1.8× 超采样，
# 在 400 px 的极限档位仍有 1.28×，对平涂赛璐珞风格足够。
# 继续用 1024 的代价是 10 张全身图 ≈ 10 MB 显存纹理（512 下是 2.5 MB），对桌面常驻进程不值当。
RUNTIME = 512
SCALE = RUNTIME / CANVAS

EYE_STATES = ["open", "half", "closed", "smile", "sparkle", "wide"]
BROW_STATES = ["neutral", "raised", "furrowed", "worried"]
VISEMES = ["closed", "small", "medium", "wide", "round", "smile"]
EXPRESSIONS = [
    "neutral", "happy", "excited", "curious", "confused",
    "surprised", "proud", "shy", "sleepy", "angry", "sad",
]
ACTIONS = ["idle", "wave", "sit", "sleep", "point", "hold", "jump", "tilt", "walk_a", "walk_b"]
FX = ["sparkle", "sweat", "zzz", "heart", "exclaim", "question", "note"]

# 身份项：本来就是 master 自己，不生成、不 diff。
IDENTITY = {"eyes": "open", "brow": "neutral", "mouth": "closed"}

# 覆盖层降级后的替代链，按「视觉上最接近」排序，最后一项一定是身份项（必然可用）。
# 作用是让降级退到最近的一级，而不是一步塌回中性 —— 否则「惊讶」会被画成「发呆」。
FALLBACK: dict[str, dict[str, list[str]]] = {
    "eyes": {
        "half": ["closed", "open"],
        "closed": ["half", "smile", "open"],
        "smile": ["closed", "half", "open"],
        "sparkle": ["wide", "open"],
        "wide": ["open"],
    },
    "brow": {
        "raised": ["neutral"],
        "furrowed": ["worried", "neutral"],
        "worried": ["furrowed", "neutral"],
    },
    "mouth": {
        "small": ["medium", "closed"],
        "medium": ["small", "wide", "closed"],
        "wide": ["medium", "small", "closed"],
        "round": ["wide", "medium", "small", "closed"],
        "smile": ["medium", "small", "closed"],
    },
}


def pick_available(slot: str, want: str, degraded_names: set[str]) -> str:
    """沿退化链找第一个没被降级的覆盖层。身份项永远可用，所以必有解。"""
    for candidate in [want, *FALLBACK.get(slot, {}).get(want, []), IDENTITY[slot]]:
        if f"{slot}.{candidate}" not in degraded_names:
            return candidate
    return IDENTITY[slot]

# ---- 判定阈值（全部由实测标定，见 registration-report.json 的 measured 段）----
#
# 一开始我用的是「逐像素阈值 → 外接框 → 框外残差」，实测直接失败：
# edits 会把整幅图重绘一遍，发丝、描边的抗锯齿到处有 ±30 的差，
# 结果每个脸部变体的框外平均残差都是 8–10，和真的位移了分不开。
# 所以判定换成下面两个量，它们在实测数据上有明确空档。
#
# DIFF_T：单像素「变了」的幅度门限（0–255，三通道取 max）。只用于生成覆盖层的 alpha 掩膜，
#   不用于判定。保持 28：真实改动（眼线、瞳孔、口腔）幅度 50–170，抗锯齿噪声多在 28 以下。
DIFF_T = 28
# 变化「密度」图：幅度图高斯模糊后再阈值化。稀疏的抗锯齿噪声会被均掉，
# 密集的真实改动留下来。两个常数决定「多密才算改动」。
DENSITY_BLUR = 6
DENSITY_T = 14
# CORE_AREA_MAX：密度区总面积 / 角色不透明面积。
#   实测脸部局部改动 1.55%–11.67%，换姿势 31.9%–108%。空档 2.7 倍，取 15%。
CORE_AREA_MAX = 0.15
# SIL_XOR_MAX：变体与 base 的剪影（alpha>128）异或面积 / 角色面积。
#   这才是真正的「身体有没有动」检查 —— 位移/缩放会直接改变剪影。
#   实测脸部改动全部落在 0.78%–0.86%（极窄的一簇，只是发丝抗锯齿），
#   换姿势是 1.10%（hold）→ 78.3%（sleep）。取 1.0%：比脸部簇的上界高 16%，仍能挡住 hold。
SIL_XOR_MAX = 0.010
# 掩膜膨胀与羽化，用来盖住阈值以下的过渡边并消除硬切边。
DILATE = 5
FEATHER = 1.2
# 连通域分析的降采样倍数。1024/8 = 128²，纯 Python 洪水填充毫秒级。
CC_DOWN = 8
# ROI 外扩，保证羽化后的边缘不被裁掉。
ROI_PAD = 12
# 脸部区域（由肤色推出）的外扩比例。眉毛压在刘海下缘，需要往上多留一点。
FACE_PAD = 0.18
# 保留连通域的下限：面积不低于最大域的这个比例，且不低于这个绝对像素数。
# 眼睛和腮红天生是左右两块，只取最大的会丢掉一半。
MIN_COMP_FRAC = 0.12
MIN_COMP_PX = 256
# MIN_DIFF_RATIO：改动量下限。
#   「通过了阈值但几乎什么都没变」比降级更危险 —— 会裁出一块近乎空白的覆盖层，
#   表情切过去肉眼看不出差别，排查时只能靠猜。实测真实五官改动 ≥0.002，
#   而落到头发噪声上的伪 ROI 只有 0.0001–0.0002。取 0.0008 卡在中间。
MIN_DIFF_RATIO = 0.0008
# ACTION_MIN_XOR：动作图与 idle 的剪影差异下限。
#   动作是独立整图，不需要配准，但「换了姿势却和 idle 一样」等于白出一张图。
#   实测 wave 7.5%、tilt 17.9%、sit 28.5%、sleep 78.3%，而 hold（第一版）只有 1.1%。取 3%。
#
#   **这个门限只能挡住最粗糙的无效动作，挡不住「手臂没动但头发重绘了」。**
#   实测证据：被人眼判定为「和 idle 完全看不出区别」的 point 第一版，剪影异或是 15.7%；
#   而确实换了姿势的 hold 第二版只有 ~1.5% 的非脸肤色块位移。
#   我试过肤色连通域位移、脸部外接框长宽比、非脸肤色异或三种指标，
#   没有一个能把「被拒的第一版」和「通过的第二版」分开（point-v1 的分数反而高于 hold-v2）。
#   结论：姿势是否真的变了，廉价的几何指标判不了，只能靠 QA 图人眼看。
#   所以下面那份 ACTION_REJECTED 是**显式记录的人工判断**，不是伪装成客观的阈值。
ACTION_MIN_XOR = 0.03

# 人眼复核 _qa_220.png 后判定「和 idle 看不出区别」的动作。
# 这里留空才是正常状态；填了内容就说明那个动作重生成多次仍失败。
# 写在代码里而不是悄悄改数据：谁拒的、为什么拒，要能被 review。
ACTION_REJECTED: dict[str, str] = {
    "tilt": "三版 prompt 都失败（v1 泛泛描述 / v2 中英双写点名角度 / v3 改成描述成品并用呆毛朝向当硬指标）；"
    "v3 只让呆毛倒向一侧，头和两眼连线仍是水平的，220 px 下与 idle 无法区分。"
    "改由渲染器对 idle 整身图做程序化旋转实现 —— 头身比 40% 的 Q 版角色，整体倾斜在视觉上就读作歪头",
}
# 由渲染器程序化实现、因此不需要独立素材的动作。
# 它们在 rig.json 里指向 idle 的图，但**不是**空动作 —— 调用方仍应提供它们。
PROCEDURAL_ACTIONS = {"tilt"}


def rgb_on(im: Image.Image, bg=(128, 128, 128)) -> Image.Image:
    """按 alpha 压到中灰上。中灰让「有东西变没」和「没东西变有」都显现为差异。"""
    c = Image.new("RGB", im.size, bg)
    c.paste(im.convert("RGBA"), (0, 0), im.convert("RGBA"))
    return c


def magnitude(a: Image.Image, b: Image.Image) -> Image.Image:
    """逐像素三通道差的最大值。全部走 Pillow 的 C 实现，1024² 只要毫秒级。"""
    d = ImageChops.difference(rgb_on(a), rgb_on(b))
    r, g, bl = d.split()
    return ImageChops.lighter(ImageChops.lighter(r, g), bl)


def opaque_mask(im: Image.Image, t: int = 128) -> Image.Image:
    return im.convert("RGBA").getchannel("A").point(lambda v: 255 if v > t else 0)


def even(v: int) -> int:
    """把坐标对齐到偶数，保证 1024→512 的半像素缩放不产生漂移。"""
    return v - (v % 2)


@dataclass
class DiffResult:
    name: str
    ok: bool
    reason: str = ""
    diff_ratio: float = 0.0
    core_ratio: float = 0.0
    sil_xor: float = 0.0
    bbox: tuple[int, int, int, int] | None = None
    roi: tuple[int, int, int, int] | None = None
    key: dict = field(default_factory=dict)


def count_nonzero(im: Image.Image) -> int:
    """直方图计数，比逐像素遍历快两个数量级。"""
    h = im.convert("L").histogram()
    return sum(h[1:])


def components(mask: Image.Image, down: int = CC_DOWN) -> list[tuple[int, tuple[int, int, int, int]]]:
    """连通域列表 [(面积, 外接框)]，按面积降序。降采样网格上洪水填充，128² 毫秒级。"""
    w, h = mask.size
    sw, sh = max(1, w // down), max(1, h // down)
    small = mask.resize((sw, sh), Image.BOX).point(lambda v: 1 if v > 32 else 0)
    px = list(small.getdata())
    seen = bytearray(sw * sh)
    out: list[tuple[int, tuple[int, int, int, int]]] = []
    for start in range(sw * sh):
        if px[start] == 0 or seen[start]:
            continue
        stack = [start]
        seen[start] = 1
        x1 = x2 = start % sw
        y1 = y2 = start // sw
        area = 0
        while stack:
            i = stack.pop()
            area += 1
            x, y = i % sw, i // sw
            x1, x2 = min(x1, x), max(x2, x)
            y1, y2 = min(y1, y), max(y2, y)
            for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if 0 <= nx < sw and 0 <= ny < sh:
                    j = ny * sw + nx
                    if px[j] and not seen[j]:
                        seen[j] = 1
                        stack.append(j)
        out.append(
            (area * down * down, (x1 * down, y1 * down, (x2 + 1) * down, (y2 + 1) * down))
        )
    out.sort(reverse=True)
    return out


def face_box(base: Image.Image) -> tuple[int, int, int, int]:
    """从 master 的肤色像素推出脸部区域，不手标。

    为什么必须有这个先验：edits 会把整幅图重绘，发丝的抗锯齿噪声在密度图上会形成
    比「一只眼睛」更大的连通域。实测只取最大连通域时，mouth.small / mouth.medium 的 ROI
    落到了眼睛上方的头发里（diffRatio 0.0001，等于裁了一块空白当嘴型），
    brow.raised 落到了左侧头发里。这类「通过了阈值但内容是错的」的覆盖层比降级更危险。

    肤色是角色配色里唯一的高 R、略偏暖、高亮区域（实测脸部像素 ≈ (252,238,229)），
    头发是冰蓝、衣服是白+青、鞋是深棕，都不满足 R-B≥12 且 R-G≥4。
    取最大肤色连通域即脸（次大的两块是膝盖和手，面积只有脸的 8%）。
    """
    r, g, b, a = base.convert("RGBA").split()
    px = [
        255 if (av > 128 and rv >= 238 and gv >= 212 and bv >= 195 and rv - bv >= 12 and rv - gv >= 4) else 0
        for rv, gv, bv, av in zip(r.getdata(), g.getdata(), b.getdata(), a.getdata())
    ]
    mask = Image.new("L", base.size)
    mask.putdata(px)
    mask = mask.filter(ImageFilter.MedianFilter(5))
    comps = components(mask)
    if not comps:
        raise ValueError("找不到肤色区域，角色配色可能变了 —— 不要猜，去看 master")
    x1, y1, x2, y2 = comps[0][1]
    # 外扩：眉毛压在刘海下缘、下巴/腮红可能略超出肤色连通域。
    mx, my = int((x2 - x1) * FACE_PAD), int((y2 - y1) * FACE_PAD)
    return (
        max(0, x1 - mx), max(0, y1 - my),
        min(base.width, x2 + mx), min(base.height, y2 + my),
    )


def metrics(res: DiffResult) -> dict:
    """落到报告里的实测数字。阈值可以争论，数字不能被省略。"""
    return {
        "ok": res.ok,
        "diffRatio": res.diff_ratio,
        "coreRatio": res.core_ratio,
        "silhouetteXor": res.sil_xor,
        "roi": res.roi,
        "bbox": res.bbox,
        "reason": res.reason,
    }


def diff_variant(
    base: Image.Image,
    variant: Image.Image,
    name: str,
    region: tuple[int, int, int, int] | None = None,
) -> tuple[DiffResult, Image.Image | None, tuple[int, int, int, int] | None]:
    """返回 (判定结果, 带掩膜的覆盖层全画布 RGBA, 裁剪框)。不通过时后两项为 None。

    @param region 把「改动在哪」的搜索限制在这个矩形内（脸部变体传 face_box）。
                  两道判定仍在**全身**上计算 —— 限制搜索区不能用来掩盖身体位移。
    """
    body = opaque_mask(base)
    body_area = count_nonzero(body) or 1
    res = DiffResult(name=name, ok=False)

    # 检查 1：剪影异或。身体有没有动，这一项直接回答，不受重绘噪声干扰。
    vbody = opaque_mask(variant)
    res.sil_xor = round(count_nonzero(ImageChops.difference(body, vbody)) / body_area, 5)

    mag = ImageChops.multiply(magnitude(base, variant), body)
    # 检查 2 的输入：密度图（幅度图模糊后阈值化）。稀疏的抗锯齿噪声被均掉，密集的真实改动留下。
    density = mag.filter(ImageFilter.GaussianBlur(DENSITY_BLUR)).point(
        lambda v: 255 if v >= DENSITY_T else 0
    )
    res.core_ratio = round(count_nonzero(density) / body_area, 5)

    if res.sil_xor > SIL_XOR_MAX:
        res.reason = (
            f"剪影异或 {res.sil_xor:.2%} 超过 {SIL_XOR_MAX:.1%}：身体位移/缩放了，覆盖层对不上"
        )
        return res, None, None
    if res.core_ratio > CORE_AREA_MAX:
        res.reason = f"变化密度区 {res.core_ratio:.1%} 超过 {CORE_AREA_MAX:.0%}：不是局部改动"
        return res, None, None

    # 精细掩膜：限制在 region 内 → 过幅度门限 → 腐蚀去孤立噪点 → 膨胀补回形状。
    search = Image.new("L", base.size, 0)
    ImageDraw.Draw(search).rectangle(region or (0, 0, base.width, base.height), fill=255)
    fine = ImageChops.multiply(mag.point(lambda v: 255 if v >= DIFF_T else 0), search)
    fine = fine.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(5))

    # 保留所有足够大的连通域，取并集框。
    # 必须保留多个而不是只取最大的：眼睛和腮红天生是左右两块，各自都比噪点大但都不是「最大」。
    comps = components(fine)
    if not comps:
        res.reason = f"搜索区 {region} 内没有超过幅度门限 {DIFF_T} 的像素：模型没改动这个部位"
        return res, None, None
    biggest = comps[0][0]
    keep = [c for c in comps if c[0] >= max(MIN_COMP_PX, biggest * MIN_COMP_FRAC)]
    roi = (
        max(0, min(c[1][0] for c in keep) - ROI_PAD),
        max(0, min(c[1][1] for c in keep) - ROI_PAD),
        min(base.width, max(c[1][2] for c in keep) + ROI_PAD),
        min(base.height, max(c[1][3] for c in keep) + ROI_PAD),
    )
    res.roi = roi
    roi_mask = Image.new("L", base.size, 0)
    ImageDraw.Draw(roi_mask).rectangle(roi, fill=255)
    fine = ImageChops.multiply(fine, roi_mask)
    res.diff_ratio = round(count_nonzero(fine) / body_area, 5)

    if res.diff_ratio < MIN_DIFF_RATIO:
        res.reason = (
            f"改动量 {res.diff_ratio:.5f} 低于下限 {MIN_DIFF_RATIO}："
            "模型实际没改动这个部位，做成覆盖层等于裁一块空白"
        )
        return res, None, None

    # 覆盖层只保留真正变了的像素 → base + overlay 在数学上等于变体原图，
    # 而且眼/眉/嘴/腮红四组覆盖层互不遮挡（矩形裁剪做不到：腮红的框会横跨鼻子盖住嘴）。
    soft = fine.filter(ImageFilter.MaxFilter(DILATE)).filter(ImageFilter.GaussianBlur(FEATHER))
    over = variant.convert("RGBA").copy()
    over.putalpha(ImageChops.multiply(over.getchannel("A"), soft))
    bbox = soft.getbbox()
    if bbox is None:
        res.reason = "掩膜为空"
        return res, None, None
    res.ok = True
    res.bbox = bbox
    return res, over, bbox


def save_overlay(over: Image.Image, bbox: tuple[int, int, int, int], path: Path) -> dict:
    x1, y1, x2, y2 = even(bbox[0]), even(bbox[1]), bbox[2], bbox[3]
    crop = over.crop((x1, y1, x2, y2))
    w = max(1, round(crop.width * SCALE))
    h = max(1, round(crop.height * SCALE))
    crop.resize((w, h), Image.LANCZOS).save(path)
    return {"file": f"rig/{path.name}", "x": round(x1 * SCALE), "y": round(y1 * SCALE), "w": w, "h": h}


def save_empty(path: Path) -> dict:
    """身份项：1×1 全透明。base + 空操作 = base，这就是 open/neutral/closed 的准确定义。"""
    Image.new("RGBA", (1, 1), (0, 0, 0, 0)).save(path)
    return {"file": f"rig/{path.name}", "x": 0, "y": 0, "w": 1, "h": 1}


def save_full(im: Image.Image, path: Path) -> dict:
    im.resize((RUNTIME, RUNTIME), Image.LANCZOS).save(path)
    return {"file": f"rig/{path.name}", "w": RUNTIME, "h": RUNTIME}


def asset(entry: dict) -> dict:
    p = RIG_DIR / Path(entry["file"]).name
    return {
        "file": entry["file"],
        "sha256": sha256_file(p),
        "width": entry["w"],
        "height": entry["h"],
    }


def overlay(entry: dict) -> dict:
    out = asset(entry)
    out["x"] = entry["x"]
    out["y"] = entry["y"]
    out["diffRatio"] = entry.get("diffRatio", 0.0)
    return out


def align_bottom_center(im: Image.Image, ref: tuple[int, int, int, int]) -> Image.Image:
    """动作图只做平移对齐，不缩放。

    不缩放是刻意的：坐下本来就比站着矮，用 normalize_canvas 按外接框铺满画布会把
    「蹲下」拉成「站着」，把姿势信息抹掉。平移保证脚底/底边与 master 对齐（锚点约定），
    水平中心对齐，相对大小交给模型自己画出来的比例 —— 偏差在 QA 图上肉眼可查。
    """
    im = clean_alpha(im)
    bbox = content_bbox(im)
    cx_ref = (ref[0] + ref[2]) / 2
    dx = round(cx_ref - (bbox[0] + bbox[2]) / 2)
    dy = round(ref[3] - bbox[3])
    out = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    out.paste(im, (dx, dy), im)
    return out


def trim_fx(im: Image.Image) -> Image.Image:
    """特效图：抠紧后放进正方形画布，留 6% 边。

    两种来源都要兼容：generations 的产物自带 alpha；edit_blank 的产物是 RGB，
    需要先做品红抠像。按通道判断，不靠记哪张是哪条路出来的。
    """
    if "A" not in im.getbands():
        im = chroma_key(im)
    im = clean_alpha(im)
    im = im.crop(content_bbox(im))
    side = max(im.width, im.height)
    pad = max(2, int(side * 0.06))
    canvas = Image.new("RGBA", (side + pad * 2, side + pad * 2), (0, 0, 0, 0))
    canvas.paste(im, ((canvas.width - im.width) // 2, (canvas.height - im.height) // 2), im)
    return canvas.resize((CANVAS // 4, CANVAS // 4), Image.LANCZOS)


def fallback_fx(name: str) -> Image.Image:
    """特效生成丢了的兜底：程序画一个能看懂的记号。
    这不是「看起来还行」的伪造 —— 会同时写进 degraded，明确说明是程序画的。
    """
    s = CANVAS // 4
    im = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    c, outline = (255, 214, 64, 255), (40, 40, 48, 255)
    if name == "heart":
        c = (255, 120, 160, 255)
    elif name in ("question", "note"):
        c = (20, 182, 197, 255)
    elif name == "sweat":
        c = (150, 215, 245, 255)
    d.ellipse((s * 0.2, s * 0.2, s * 0.8, s * 0.8), fill=c, outline=outline, width=max(2, s // 40))
    return im


def main() -> int:
    RIG_DIR.mkdir(parents=True, exist_ok=True)
    report: dict = {
        "diffs": {}, "alpha": {}, "chroma": {}, "actions": {},
        "thresholds": {
            "DIFF_T": DIFF_T, "DENSITY_BLUR": DENSITY_BLUR, "DENSITY_T": DENSITY_T,
            "CORE_AREA_MAX": CORE_AREA_MAX, "SIL_XOR_MAX": SIL_XOR_MAX,
            "MIN_DIFF_RATIO": MIN_DIFF_RATIO, "MIN_COMP_FRAC": MIN_COMP_FRAC,
            "FACE_PAD": FACE_PAD, "runtime": RUNTIME, "canvas": CANVAS,
        },
    }
    degraded: list[dict] = []

    base = clean_alpha(Image.open(MASTER))
    ref_bbox = content_bbox(base)
    face = face_box(base)
    report["alpha"]["base"] = alpha_report(base)
    report["base_bbox"] = ref_bbox
    report["face_box"] = face
    base_entry = save_full(base, RIG_DIR / "base.png")

    # ---------- 覆盖层三组 ----------
    layers: dict[str, dict[str, dict]] = {"eyes": {}, "brow": {}, "mouth": {}}
    groups = {"eyes": EYE_STATES, "brow": BROW_STATES, "mouth": VISEMES}
    for slot, states in groups.items():
        for state in states:
            if state == IDENTITY[slot]:
                e = save_empty(RIG_DIR / f"{slot}-{state}.png")
                e["diffRatio"] = 0.0
                layers[slot][state] = e
                continue
            src = RAW / f"{slot}-{state}.png"
            name = f"{slot}.{state}"
            if not src.exists():
                layers[slot][state] = {**save_empty(RIG_DIR / f"{slot}-{state}.png"), "diffRatio": 0.0}
                degraded.append({"name": name, "reason": "生成丢失（proxy 400 重试耗尽），退化为空操作覆盖层"})
                continue
            raw = Image.open(src)
            report["chroma"][name] = key_ratio(raw)
            keyed = chroma_key(raw)
            report["alpha"][name] = alpha_report(keyed)
            res, over, bbox = diff_variant(base, keyed, name, region=face)
            report["diffs"][name] = metrics(res)
            if res.ok and over is not None and bbox is not None:
                e = save_overlay(over, bbox, RIG_DIR / f"{slot}-{state}.png")
                e["diffRatio"] = res.diff_ratio
                layers[slot][state] = e
            else:
                layers[slot][state] = {**save_empty(RIG_DIR / f"{slot}-{state}.png"), "diffRatio": 0.0}
                degraded.append({"name": name, "reason": res.reason or "diff 判定不通过"})

    # ---------- 腮红 ----------
    blush_entry = None
    bsrc = RAW / "blush-on.png"
    if bsrc.exists():
        keyed = chroma_key(Image.open(bsrc))
        report["chroma"]["blush"] = key_ratio(Image.open(bsrc))
        report["alpha"]["blush"] = alpha_report(keyed)
        res, over, bbox = diff_variant(base, keyed, "blush", region=face)
        report["diffs"]["blush"] = metrics(res)
        if res.ok and over is not None and bbox is not None:
            e = save_overlay(over, bbox, RIG_DIR / "blush.png")
            e["diffRatio"] = res.diff_ratio
            blush_entry = e
        else:
            degraded.append({"name": "blush", "reason": res.reason or "diff 判定不通过"})
    else:
        degraded.append({"name": "blush", "reason": "生成丢失，shy 表情不带腮红"})

    # ---------- 整脸表情（layers 组合不出来时的后路）----------
    face_sprites: dict[str, dict] = {}
    for name in ("shy", "angry", "sad", "excited"):
        src = RAW / f"face-{name}.png"
        if not src.exists():
            continue
        keyed = chroma_key(Image.open(src))
        report["alpha"][f"face.{name}"] = alpha_report(keyed)
        res, _, _ = diff_variant(base, keyed, f"face.{name}", region=face)
        report["diffs"][f"face.{name}"] = metrics(res)
        # 整脸图一律当 sprite 用（整图交叉淡入），不拆分层 —— 它存在的意义就是分层表达不了。
        face_sprites[name] = save_full(keyed, RIG_DIR / f"face-{name}.png")

    # ---------- 表情表 ----------
    # layers 组合方案。只有在三个覆盖层都没降级时才用 layers。
    combos: dict[str, tuple[str, str, str, bool]] = {
        # expression: (eyes, brow, mouth, blush)
        "neutral": ("open", "neutral", "closed", False),
        "happy": ("smile", "neutral", "smile", False),
        "excited": ("sparkle", "raised", "wide", False),
        "curious": ("open", "raised", "small", False),
        "confused": ("half", "worried", "small", False),
        "surprised": ("wide", "raised", "round", False),
        "proud": ("smile", "raised", "smile", False),
        "shy": ("half", "worried", "small", True),
        "sleepy": ("half", "neutral", "small", False),
        "angry": ("wide", "furrowed", "medium", False),
        "sad": ("half", "worried", "closed", False),
    }
    degraded_names = {d["name"] for d in degraded}
    expressions: dict[str, dict] = {}
    for name in EXPRESSIONS:
        eyes, brow, mouth, blush = combos[name]
        needed = [f"eyes.{eyes}", f"brow.{brow}", f"mouth.{mouth}"]
        if blush:
            needed.append("blush")
        missing = [n for n in needed if n in degraded_names]
        if not missing:
            expressions[name] = {
                "mode": "layers", "eyes": eyes, "brow": brow, "mouth": mouth,
                "blush": blush and blush_entry is not None,
            }
            continue
        if name in face_sprites:
            expressions[name] = {"mode": "sprite", "sprite": asset(face_sprites[name])}
            degraded.append({"name": f"expression.{name}", "reason": f"依赖的覆盖层已降级（{', '.join(missing)}）→ 整图交叉淡入"})
            continue
        # 连整脸图都没有 → 沿 FALLBACK 链换成最接近的可用覆盖层，并显式记账。
        # 直接塌回中性（open/neutral/closed）会把「惊讶」画成「发呆」，
        # 换成 wide 口型至少还是个张嘴的惊讶脸 —— 退化要退到最近的那一级，不是退到零。
        used = {
            "eyes": pick_available("eyes", eyes, degraded_names),
            "brow": pick_available("brow", brow, degraded_names),
            "mouth": pick_available("mouth", mouth, degraded_names),
        }
        expressions[name] = {
            "mode": "layers",
            **used,
            "blush": blush and blush_entry is not None and "blush" not in degraded_names,
        }
        swapped = ", ".join(
            f"{slot}.{combo}→{used[slot]}"
            for slot, combo in (("eyes", eyes), ("brow", brow), ("mouth", mouth))
            if used[slot] != combo
        )
        degraded.append({
            "name": f"expression.{name}",
            "reason": f"覆盖层降级且无整脸备图（{', '.join(missing)}）→ 沿退化链替换：{swapped}",
        })

    # 有整脸备图但分层也可用时：优先 sprite，因为整脸图带着分层表达不出来的元素
    # （腮红强度、怒气符号、眼泪）。这是人工判断，写在这里而不是埋在数据里。
    for name in ("shy", "angry", "sad"):
        if name in face_sprites and expressions[name]["mode"] == "layers":
            expressions[name] = {"mode": "sprite", "sprite": asset(face_sprites[name])}
            degraded.append({"name": f"expression.{name}", "reason": "分层无法表达腮红/怒气符号/眼泪 → 使用整脸图交叉淡入"})

    # ---------- 动作 ----------
    actions: dict[str, dict] = {"idle": asset(base_entry)}
    for name in ACTIONS:
        if name == "idle":
            continue
        src = RAW / f"action-{name}.png"
        if name in ACTION_REJECTED:
            # 人眼复核判定为无效动作 → 指向 idle 的整身图，并记入 degraded。
            # 指向 idle（而不是留一张假姿势）让「这个动作没有独立素材」在运行时可被检测：
            # actions[name].sha256 == base.sha256。
            actions[name] = asset(base_entry)
            tail = (
                "改由渲染器程序化实现（见 apps/web/src/pet/RigRenderer.ts 的 PROCEDURAL_ACTIONS），"
                "调用方仍应提供该动作"
                if name in PROCEDURAL_ACTIONS
                else "调用方应通过 sha256 == base.sha256 检测并不提供该动作"
            )
            degraded.append({
                "name": f"action.{name}",
                "reason": f"无独立姿势素材：{ACTION_REJECTED[name]}。{tail}",
            })
            continue
        if not src.exists():
            actions[name] = asset(base_entry)
            degraded.append({"name": f"action.{name}", "reason": "生成丢失，回退 idle 全身图"})
            continue
        raw = Image.open(src)
        report["chroma"][f"action.{name}"] = key_ratio(raw)
        keyed = chroma_key(raw)
        aligned = align_bottom_center(keyed, ref_bbox)
        bb = content_bbox(aligned)
        # 对齐后与 idle 的剪影异或：动作图是不是真的换了姿势，这一项直接回答。
        # 不用来判死（动作本来就是独立整图，不需要配准），但必须报出来 ——
        # 实测 hold 只有 1.1%，意味着模型基本没换姿势，用起来和 idle 看不出区别。
        xor = count_nonzero(ImageChops.difference(opaque_mask(base), opaque_mask(aligned)))
        report["actions"][name] = {
            "bbox": bb,
            "height_vs_master": round((bb[3] - bb[1]) / (ref_bbox[3] - ref_bbox[1]), 3),
            "width_vs_master": round((bb[2] - bb[0]) / (ref_bbox[2] - ref_bbox[0]), 3),
            "silhouetteXorVsIdle": round(xor / (count_nonzero(opaque_mask(base)) or 1), 4),
        }
        if report["actions"][name]["silhouetteXorVsIdle"] < ACTION_MIN_XOR:
            degraded.append({
                "name": f"action.{name}",
                "reason": f"与 idle 的剪影差异只有 {report['actions'][name]['silhouetteXorVsIdle']:.1%}"
                f"（下限 {ACTION_MIN_XOR:.0%}）：模型没真的换姿势，播这个动作看不出变化",
            })
        report["alpha"][f"action.{name}"] = alpha_report(aligned)
        actions[name] = asset(save_full(aligned, RIG_DIR / f"action-{name}.png"))

    # ---------- 特效 ----------
    fx: dict[str, dict] = {}
    for name in FX:
        src = RAW / f"fx-{name}.png"
        out = RIG_DIR / f"fx-{name}.png"
        if src.exists():
            im = trim_fx(Image.open(src))
            report["alpha"][f"fx.{name}"] = alpha_report(im)
        else:
            im = fallback_fx(name)
            degraded.append({"name": f"fx.{name}", "reason": "生成丢失，使用程序绘制的占位记号"})
        im.save(out)
        fx[name] = {"file": f"rig/{out.name}", "sha256": sha256_file(out), "width": im.width, "height": im.height}

    # ---------- 清单 ----------
    gen_summary = {}
    gs = RAW / "_gen_summary.json"
    if gs.exists():
        gen_summary = json.loads(gs.read_text())

    manifest = {
        "id": "stepchan_q",
        "version": "1.0.0",
        "source": {
            "model": "gpt-image-2",
            "masterQuality": "medium",
            "variantQuality": "medium",
            "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        },
        "canvas": {"width": RUNTIME, "height": RUNTIME},
        "anchor": {"x": 0.5, "y": 1.0},
        "base": asset(base_entry),
        "layers": {
            "eyes": {k: overlay(v) for k, v in layers["eyes"].items()},
            "brow": {k: overlay(v) for k, v in layers["brow"].items()},
            "mouth": {k: overlay(v) for k, v in layers["mouth"].items()},
            **({"blush": overlay(blush_entry)} if blush_entry else {}),
        },
        "expressions": expressions,
        "actions": actions,
        "fx": fx,
        "degraded": degraded,
    }
    (ASSETS / "rig.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")

    report["generation"] = gen_summary
    report["degraded"] = degraded
    report["layer_modes"] = {k: v["mode"] for k, v in expressions.items()}
    (ASSETS / "registration-report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")

    # 同步给 vite 的静态目录（dev 和 build 都从 public 取）。
    PUBLIC.mkdir(parents=True, exist_ok=True)
    (PUBLIC / "rig").mkdir(exist_ok=True)
    for p in RIG_DIR.iterdir():
        (PUBLIC / "rig" / p.name).write_bytes(p.read_bytes())
    (PUBLIC / "rig.json").write_bytes((ASSETS / "rig.json").read_bytes())

    n_layers = sum(1 for v in expressions.values() if v["mode"] == "layers")
    print(f"expressions: layers={n_layers} sprite={len(expressions) - n_layers}")
    print(f"degraded: {len(degraded)}")
    for d in degraded:
        print(f"  - {d['name']}: {d['reason']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
