#!/usr/bin/env python
"""逐姿势命中区实测，产出 hitregions.json。

为什么需要这一步：命中判定在 Rust 侧（穿透一开，webview 收不到 mousemove），
用的是一份归一化矩形表。原来那份表（apps/web/src/platform/hitRegions.ts）是按
**idle 立姿**量的 —— 换姿势后身体整个挪位，矩形就落空了。
实测最严重的是 sleep：侧躺时角色压在画幅下半部偏左，而 idle 的头部矩形在 y 0.11–0.30，
一个矩形都命中不到 → 窗口保持穿透 → 鼠标左右键都穿到后面的应用去，根本选不中她。

所以这里对**每一张运行期纹理**各量一次。能量的都量，量不到的不写，但有一条底线：

    **任何姿势都必须至少有一个矩形，而且那个矩形一定是整身外接框。**
    宁可整只都能点，也不能点不中。这条断言在本脚本、在 poseRegions.ts 的加载校验里
    各写了一遍。

每个部位的测量依据（全部是像素，没有手标坐标）：
  body   不透明外接框（alpha > 24）。必然存在。
  face   最大肤色连通域 —— register.py 的 face_box() 用的同一招，
         配色里只有脸/手/膝是肤色，而脸是最大的一块（次大的只有它 8%）。
  cheek  脸框的下 60%（眼睛到下巴这一带，含腮红），左右各内缩 8%。
  head   脸框往上平移一个脸高、横向放大 15%，再与不透明区域求交 ——
         头发就在脸的正上方，交集保证矩形不会伸进空气里。
  badge  两枚假徽章，直接用 logo.py 的 find_badges()（同一个检测器，同一份实测数据）。
  hand   除脸以外、位于剪影**最左与最右**的两块肤色连通域 —— 手垂在身体两侧，
         膝盖在中间，所以「最外侧」这条就能把手挑出来（实测 idle 挑中的两块
         归一化到 x 0.34 / 0.64，与原手工表标的 0.32–0.40 / 0.60–0.68 对得上）。
  skirt  最大饱和青色连通域里**最宽的那一段行** —— 青色还包括水手领和袜口，
         但褶裙是摊开的，所以「宽度 ≥ 最宽行 60%」的行区间就是裙摆。

小目标（徽章、手）按 MIN_TAPPABLE 外扩成可点的大小，和原手工表一个思路；
Rust 侧另有 ~6–10 px 的滞回。

运行：~/Desktop/gpt-image-lab/.venv/bin/python tools/art/regions.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from PIL import Image, ImageFilter  # noqa: E402

from alpha import content_bbox  # noqa: E402
from logo import find_badges, open_frame  # noqa: E402
from register import components  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets" / "stepchan_q_v1"

# 可点矩形的最小边长（归一化）。0.08 × 300 px 显示高度 ≈ 24 px，是能稳定点中的下限。
MIN_TAPPABLE = 0.08
# 徽章矩形在实测直径之外再加的余量（归一化）。徽章本体只有 ~30 px(512)，不放大点不中。
BADGE_PAD = 0.012
# 脸框 → 脸颊：取下面这个比例，左右内缩 CHEEK_INSET。
CHEEK_TOP_FRAC = 0.40
CHEEK_INSET = 0.08
# 脸框 → 头部：往上平移一个脸高，横向放大这个比例。
HEAD_WIDEN = 0.15
# 肤色判据（register.py 的 face_box 实测标定：脸部像素 ≈ (252,238,229)）。
SKIN = dict(r=238, g=212, b=195, rb=12, rg=4)
# 手那类小肤色块的面积下限（px，512 画幅）。实测真手那两块约 256，噪点（耳朵高光、
# 锁骨阴影）在 128 及以下 —— 192 卡在中间。
HAND_MIN_PX = 192
# 裙摆的饱和青色判据。实测裙子 ≈ (26,178,196)：B 和 G 都明显高于 R。
SKIRT = dict(gb_over_r=40, min_gb=120)
# 裙摆取「宽度 ≥ 最宽行 × 这个比例」的行区间。领子窄、裙摆宽，这一条把两者分开。
SKIRT_WIDE_FRAC = 0.6


def mask_from(im: Image.Image, pred) -> Image.Image:
    """按逐像素判据生成掩膜，再中值滤波去掉零散噪点（和 face_box 同样的做法）。"""
    r, g, b, a = im.convert("RGBA").split()
    px = [
        255 if pred(rv, gv, bv, av) else 0
        for rv, gv, bv, av in zip(r.getdata(), g.getdata(), b.getdata(), a.getdata())
    ]
    out = Image.new("L", im.size)
    out.putdata(px)
    return out.filter(ImageFilter.MedianFilter(5))


def skin_mask(im: Image.Image) -> Image.Image:
    return mask_from(
        im,
        lambda rv, gv, bv, av: av > 128
        and rv >= SKIN["r"]
        and gv >= SKIN["g"]
        and bv >= SKIN["b"]
        and rv - bv >= SKIN["rb"]
        and rv - gv >= SKIN["rg"],
    )


def skirt_mask(im: Image.Image) -> Image.Image:
    return mask_from(
        im,
        lambda rv, gv, bv, av: av > 128
        and min(gv, bv) >= SKIRT["min_gb"]
        and min(gv, bv) - rv >= SKIRT["gb_over_r"],
    )


def norm(box, w: int, h: int) -> dict:
    return {"x0": box[0] / w, "y0": box[1] / h, "x1": box[2] / w, "y1": box[3] / h}


def grow_to_min(rect: dict, minimum: float = MIN_TAPPABLE) -> dict:
    """把太小的矩形围绕中心放大到最小可点尺寸，再夹回 0..1。"""
    out = dict(rect)
    for lo, hi in (("x0", "x1"), ("y0", "y1")):
        span = out[hi] - out[lo]
        if span < minimum:
            mid = (out[lo] + out[hi]) / 2
            out[lo] = mid - minimum / 2
            out[hi] = mid + minimum / 2
    for k in out:
        out[k] = max(0.0, min(1.0, out[k]))
    return out


def rect(part: str, box, w: int, h: int, pad: float = 0.0) -> dict:
    r = norm(box, w, h)
    if pad:
        r = {"x0": r["x0"] - pad, "y0": r["y0"] - pad, "x1": r["x1"] + pad, "y1": r["y1"] + pad}
    return {"part": part, **grow_to_min(r)}


def intersect(a: dict, b: dict) -> dict | None:
    out = {
        "x0": max(a["x0"], b["x0"]),
        "y0": max(a["y0"], b["y0"]),
        "x1": min(a["x1"], b["x1"]),
        "y1": min(a["y1"], b["y1"]),
    }
    return out if out["x1"] > out["x0"] and out["y1"] > out["y0"] else None


def overlaps(a, b) -> bool:
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def hand_boxes(skin: list, face: tuple[int, int, int, int]) -> list[tuple[int, int, int, int]]:
    """手：除脸以外最靠外侧的两块肤色连通域。

    和脸框相交的块先排掉（耳朵、脖子、脸上的高光都会被肤色判据吃进来），
    再按中心 x 取最左和最右各一块 —— 手垂在身体两侧，膝盖/小腿在中间。
    只剩一块就只给一块，一块都没有就不给（整身兜底框接着）。
    """
    cand = [box for area, box in skin[1:] if area >= HAND_MIN_PX and not overlaps(box, face)]
    if not cand:
        return []
    cand.sort(key=lambda b: (b[0] + b[2]) / 2)
    return [cand[0]] if len(cand) == 1 else [cand[0], cand[-1]]


def skirt_box(mask: Image.Image, comp: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    """裙摆：最大青色连通域里「宽度 ≥ 最宽行 60%」的那一段连续行。

    整块青色是「水手领 + 领结 + 褶裙」连在一起的（实测 idle 那块从 y 232 一直到 416，
    直接拿来当裙摆会把胸口也算进去）。褶裙是摊开的，领子是窄的，所以按行宽切，
    并且只取最宽行所在的那一段连续区间 —— 否则上下两处同宽的行会被拼成一个大框。
    """
    x0, y0, x1, y1 = comp
    px = mask.load()
    rows: list[tuple[int, int, int]] = []
    for y in range(y0, y1):
        xs = [x for x in range(x0, x1) if px[x, y] > 128]
        rows.append((len(xs), min(xs), max(xs) + 1) if xs else (0, x0, x0 + 1))
    widest = max(r[0] for r in rows)
    if widest <= 0:
        return comp
    kept = {i for i, r in enumerate(rows) if r[0] >= widest * SKIRT_WIDE_FRAC}
    anchor = max(range(len(rows)), key=lambda i: rows[i][0])
    lo = hi = anchor
    while lo - 1 in kept:
        lo -= 1
    while hi + 1 in kept:
        hi += 1
    seg = [rows[i] for i in range(lo, hi + 1)]
    return (min(r[1] for r in seg), y0 + lo, max(r[2] for r in seg), y0 + hi + 1)


def measure_pose(file: str, ref_cover: dict[str, float] | None) -> tuple[list[dict], dict]:
    """量一张画幅的全部命中区。返回 (矩形表, 实测留痕)。

    顺序即优先级（Rust 取第一个命中的），所以小目标必须排在大目标前面：
    徽章 → 脸颊 → 手 → 头 → 裙 → 整身兜底。
    发饰徽章落在头部矩形内部，排后面就永远摸不到；整身框排最后，它只负责「至少能点中」。
    """
    im = open_frame(file)
    w, h = im.size
    body = content_bbox(im)
    note: dict = {"file": file, "bodyBox": list(body)}
    small: list[dict] = []
    mid: list[dict] = []

    # ---- 徽章：复用 logo.py 的检测器，同一份实测 ----
    badges, badge_missing = find_badges(im, ref_cover)
    for slot, rec in badges.items():
        r = rec["coverRadius"]
        cx, cy = rec["center"]
        small.append(
            rect("badge", (cx - r, cy - r, cx + r, cy + r), w, h, pad=BADGE_PAD)
        )
    note["badges"] = {k: v["center"] for k, v in badges.items()}
    note["badgesMissing"] = list(badge_missing)

    # ---- 脸：最大肤色连通域 ----
    skin = components(skin_mask(im))
    face = None
    if skin:
        face = skin[0][1]
        note["faceBox"] = list(face)
        fw, fh = face[2] - face[0], face[3] - face[1]
        mid.append(
            rect(
                "cheek",
                (
                    face[0] + fw * CHEEK_INSET,
                    face[1] + fh * CHEEK_TOP_FRAC,
                    face[2] - fw * CHEEK_INSET,
                    face[3],
                ),
                w,
                h,
            )
        )
        hands = hand_boxes(skin, face)
        note["hands"] = [list(b) for b in hands]
        for box in hands:
            mid.append(rect("hand", box, w, h))
    else:
        note["faceBox"] = None
        note["hands"] = []

    tail: list[dict] = []
    if face is not None:
        fh = face[3] - face[1]
        fw = face[2] - face[0]
        head = norm(
            (face[0] - fw * HEAD_WIDEN, face[1] - fh, face[2] + fw * HEAD_WIDEN, face[3] - fh * 0.2),
            w,
            h,
        )
        # 与不透明区域求交：头发就在脸上方，交集保证矩形不会伸进空气里。
        clipped = intersect(head, norm(body, w, h))
        if clipped:
            tail.append({"part": "head", **grow_to_min(clipped)})

    # ---- 裙摆 ----
    smask = skirt_mask(im)
    skirt = components(smask)
    if skirt:
        box = skirt_box(smask, skirt[0][1])
        note["skirtComponent"] = list(skirt[0][1])
        note["skirtBox"] = list(box)
        tail.append(rect("skirt", box, w, h))
    else:
        note["skirtBox"] = None

    # ---- 整身兜底。必须有，必须排最后 ----
    regions = [*small, *mid, *tail, rect("body", body, w, h)]
    return regions, note


def main() -> int:
    rig_path = ASSETS / "rig.json"
    if not rig_path.exists():
        print(f"找不到 {rig_path}；先跑 tools/art/register.py", file=sys.stderr)
        return 1
    rig = json.loads(rig_path.read_text())

    # idle 先量一次，它的徽章覆盖半径是其余画幅的分派参考（见 logo.py 的 find_badges）。
    idle_file = rig["actions"]["idle"]["file"]
    idle_badges, _ = find_badges(open_frame(idle_file), None)
    ref_cover = {slot: rec["coverRadius"] for slot, rec in idle_badges.items()}

    poses: dict[str, list[dict]] = {}
    measured: dict[str, dict] = {}
    degraded: list[dict] = []
    cache: dict[str, tuple[list[dict], dict]] = {}
    for action, entry in rig["actions"].items():
        file = entry["file"]
        if file not in cache:
            cache[file] = measure_pose(file, ref_cover)
        regions, note = cache[file]
        poses[action] = regions
        measured[action] = note
        parts = {}
        for r in regions:
            parts[r["part"]] = parts.get(r["part"], 0) + 1
        if not any(r["part"] == "body" for r in regions):
            raise ValueError(f"{action}: 没有整身兜底框 —— 这是底线，不能发车")
        missing = [p for p in ("head", "cheek", "badge", "hand", "skirt") if p not in parts]
        if missing:
            degraded.append(
                {
                    "name": f"hitRegions.{action}",
                    "reason": (
                        f"{file} 上量不到这些部位：{', '.join(missing)}"
                        f"（已量到 {', '.join(f'{k}×{v}' for k, v in parts.items())}）。"
                        "这些部位在这个姿势下退回整身兜底框 —— 点得中，但读作「点在身上」而不是具体部位"
                    ),
                }
            )
        print(
            f"{action:8s} [{Path(file).name}] "
            + ", ".join(f"{k}×{v}" for k, v in parts.items())
            + (f"  缺：{', '.join(missing)}" if missing else "")
        )

    # 整脸 sprite 表情：logo.py 已经实测过它们的徽章与 idle 一致；这里再确认身体外接框一致，
    # 否则 sprite 期间（只在 idle/tilt 画幅下显示）的命中区也会偏。
    idle_body = content_bbox(open_frame(idle_file))
    sprite_notes: dict[str, dict] = {}
    for name, e in rig["expressions"].items():
        if e.get("mode") != "sprite":
            continue
        box = content_bbox(open_frame(e["sprite"]["file"]))
        drift = max(abs(a - b) for a, b in zip(box, idle_body))
        sprite_notes[name] = {"bodyBox": list(box), "maxDriftPx": drift}
        if drift > 8:
            raise ValueError(
                f"整脸表情 {name} 的身体外接框 {box} 与 idle {idle_body} 差 {drift} px —— "
                "超过容差，命中区必须为 sprite 表情单列一份，不能沿用 idle"
            )
        print(f"sprite {name:8s} 身体外接框与 idle 差 {drift} px ✓")

    degraded.append(
        {
            "name": "hitRegions.proceduralRotation",
            "reason": (
                "tilt 是渲染器对 idle 整身图做程序化旋转（0.22 rad），按住聆听时还有 0.13 rad 的侧倾，"
                "而命中区是在**未旋转**的纹理上量的。所以这两种状态下矩形有最多约 "
                "sin(0.22)×身高 的横向偏移（默认档位约 30 px）。"
                "没有做补偿：矩形本身比部位大，Rust 侧还有 6–10 px 滞回，而整身兜底框一定命中"
            ),
        }
    )

    manifest = {
        "version": "1.0.0",
        "measured": {
            "method": (
                "逐画幅实测运行期纹理（rig/*.png）：body=alpha 外接框，face=最大肤色连通域，"
                "cheek=脸框下 60%，head=脸框上移一个脸高并与不透明区求交，"
                "badge=logo.py 的 find_badges()，hand=除脸外最靠外侧的两块肤色连通域，"
                "skirt=最大青色连通域里最宽的那一段行"
            ),
            "thresholds": {
                "minTappable": MIN_TAPPABLE,
                "badgePad": BADGE_PAD,
                "cheekTopFrac": CHEEK_TOP_FRAC,
                "cheekInset": CHEEK_INSET,
                "headWiden": HEAD_WIDEN,
                "skin": SKIN,
                "handMinPx": HAND_MIN_PX,
                "skirt": SKIRT,
                "skirtWideFrac": SKIRT_WIDE_FRAC,
            },
            "poses": measured,
            "spriteExpressions": sprite_notes,
        },
        "poses": poses,
        "degraded": degraded,
    }
    (ASSETS / "hitregions.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n"
    )
    print(f"\n写入 {ASSETS / 'hitregions.json'}；运行期副本用 `npm run sync-rig`")
    print(f"degraded: {len(degraded)}")
    for d in degraded:
        print(f"  - {d['name']}: {d['reason']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
