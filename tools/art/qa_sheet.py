#!/usr/bin/env python
"""视觉 QA 图：把 rig.json 真正合成出来，人眼检查配准。

刻意**从 rig.json 读**，而不是从中间变量读 —— 合成逻辑和渲染器完全一致
（base + brow + eyes + mouth + blush，按清单里的 x/y 叠放）。
所以这张图同时验证了清单里的坐标是对的：如果 x/y 错了，图上会立刻看出五官错位。

浅色与深色两种底色都画：浅色看描边与抠像边缘，深色看有没有残留的白雾光晕
（透明背景产物的 a<16 淡光晕在深色桌面上会显出一圈白边）。

第三张图 `_qa_logo.png` 专门看 StepFun logo 图层：覆盖前后对比（220 px 浅底/深底）、
徽章特写（6× 放大，看旧徽章有没有从边上露出来）、以及栅格化产物与真 SVG 渲染器的叠合。
合成同样**从 logo.json 读**，所以它也在验证 placements 里的 cx/cy/size/rotation。

运行：~/Desktop/gpt-image-lab/.venv/bin/python tools/art/qa_sheet.py
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from PIL import Image, ImageChops, ImageDraw, ImageFont  # noqa: E402

from logo import parse_icon, reference_raster, render_icon  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets" / "stepchan_q_v1"

TILE = 220  # 和真实显示尺寸同量级 —— 在 1024 上看不出的错位，在 220 上也看不出才算过关
PAD = 10
LABEL_H = 18
LIGHT = (242, 244, 248, 255)
DARK = (34, 36, 44, 255)
CHECKER = ((214, 216, 222, 255), (232, 234, 240, 255))

FONTS = [
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/Library/Fonts/Arial.ttf",
]


def font(size: int = 13):
    for p in FONTS:
        if Path(p).exists():
            try:
                return ImageFont.truetype(p, size)
            except OSError:
                continue
    return ImageFont.load_default()


def load(manifest: dict, rel: str) -> Image.Image:
    return Image.open(ASSETS / rel).convert("RGBA")


def compose_expression(manifest: dict, name: str) -> Image.Image:
    """按渲染器的 z 序合成：base → brow → eyes → mouth → blush，或整图 sprite。"""
    cv = manifest["canvas"]
    out = Image.new("RGBA", (cv["width"], cv["height"]), (0, 0, 0, 0))
    out.alpha_composite(load(manifest, manifest["base"]["file"]))
    entry = manifest["expressions"][name]
    if entry["mode"] == "sprite":
        out = Image.new("RGBA", (cv["width"], cv["height"]), (0, 0, 0, 0))
        out.alpha_composite(load(manifest, entry["sprite"]["file"]))
        return out
    for slot, key in (("brow", entry["brow"]), ("eyes", entry["eyes"]), ("mouth", entry["mouth"])):
        ov = manifest["layers"][slot][key]
        out.alpha_composite(load(manifest, ov["file"]), (ov["x"], ov["y"]))
    if entry.get("blush") and manifest["layers"].get("blush"):
        ov = manifest["layers"]["blush"]
        out.alpha_composite(load(manifest, ov["file"]), (ov["x"], ov["y"]))
    return out


def compose_layer(manifest: dict, slot: str, key: str) -> Image.Image:
    """单个覆盖层叠在 base 上，用来逐个检查眼/眉/嘴的配准。"""
    cv = manifest["canvas"]
    out = Image.new("RGBA", (cv["width"], cv["height"]), (0, 0, 0, 0))
    out.alpha_composite(load(manifest, manifest["base"]["file"]))
    ov = manifest["layers"][slot][key]
    out.alpha_composite(load(manifest, ov["file"]), (ov["x"], ov["y"]))
    return out


LOGO_SS = 4  # 旋转/缩放前的超采样倍数，避免 17 px 的小图被旋转搅成一团


def place_logo(canvas: Image.Image, logo: Image.Image, p: dict) -> Image.Image:
    """按 logo.json 的 placement 把 logo 贴到画布上。

    这是 Python 侧对渲染器的**复刻**：圆心对齐 cx/cy、直径 = size、顺时针 rotation 弧度。
    Pixi 里 rotation 正方向是顺时针（y 轴向下），Pillow 的 rotate 是逆时针，所以取负。
    两边对不上的话，这张 QA 图上的 logo 位置就会和运行期不一致 —— 所以单位约定写在这里。
    """
    side = max(1, int(round(p["size"])))
    im = logo.resize((side * LOGO_SS, side * LOGO_SS), Image.LANCZOS)
    if p.get("rotation"):
        im = im.rotate(-math.degrees(p["rotation"]), Image.BICUBIC, expand=True)
    im = im.resize(
        (max(1, round(im.width / LOGO_SS)), max(1, round(im.height / LOGO_SS))), Image.LANCZOS
    )
    canvas.alpha_composite(
        im, (round(p["cx"] - im.width / 2), round(p["cy"] - im.height / 2))
    )
    return canvas


def with_logo(logo: Image.Image, body: Image.Image, placements: dict) -> Image.Image:
    """把一帧的全部 placement 贴到这一帧的身体图上。placements 是 logo.json 里该动作的那一格。"""
    out = body.copy()
    for p in placements.values():
        place_logo(out, logo, p)
    return out


def checker(size: tuple[int, int], cell: int = 11) -> Image.Image:
    im = Image.new("RGBA", size, CHECKER[0])
    d = ImageDraw.Draw(im)
    for y in range(0, size[1], cell):
        for x in range(0, size[0], cell):
            if ((x // cell) + (y // cell)) % 2:
                d.rectangle((x, y, x + cell - 1, y + cell - 1), fill=CHECKER[1])
    return im


def strip(
    manifest: dict,
    items: list[tuple[str, Image.Image]],
    bg,
    title: str,
    tile: int = TILE,
    min_width: int = 0,
) -> Image.Image:
    f = font()
    ft = font(15)
    head = 24
    w = max(min_width, PAD + len(items) * (tile + PAD))
    h = head + tile + LABEL_H + PAD
    sheet = checker((w, h)) if bg == "checker" else Image.new("RGBA", (w, h), bg)
    d = ImageDraw.Draw(sheet)
    fg = (24, 26, 32, 255) if bg != DARK else (236, 238, 244, 255)
    d.text((PAD, 5), title, fill=fg, font=ft)
    for i, (name, im) in enumerate(items):
        x = PAD + i * (tile + PAD)
        sheet.alpha_composite(im.resize((tile, tile), Image.LANCZOS), (x, head))
        d.text((x + 2, head + tile + 2), name, fill=fg, font=f)
    return sheet


def stack(parts: list[Image.Image], bg=(20, 21, 26, 255)) -> Image.Image:
    w = max(p.width for p in parts)
    h = sum(p.height for p in parts)
    out = Image.new("RGBA", (w, h), bg)
    y = 0
    for p in parts:
        out.alpha_composite(p, (0, y))
        y += p.height
    return out


def main() -> int:
    manifest = json.loads((ASSETS / "rig.json").read_text())
    degraded = {d["name"] for d in manifest["degraded"]}

    def tag(prefix: str, name: str) -> str:
        return f"{name} *" if f"{prefix}.{name}" in degraded else name

    exprs = []
    for name in manifest["expressions"]:
        mode = manifest["expressions"][name]["mode"]
        exprs.append((f"{tag('expression', name)} [{mode[0]}]", compose_expression(manifest, name)))

    actions = [(tag("action", n), load(manifest, a["file"])) for n, a in manifest["actions"].items()]
    eyes = [(tag("eyes", k), compose_layer(manifest, "eyes", k)) for k in manifest["layers"]["eyes"]]
    mouths = [
        (tag("mouth", k), compose_layer(manifest, "mouth", k)) for k in manifest["layers"]["mouth"]
    ]
    brows = [(tag("brow", k), compose_layer(manifest, "brow", k)) for k in manifest["layers"]["brow"]]
    fx = [(tag("fx", n), load(manifest, a["file"])) for n, a in manifest["fx"].items()]

    parts = [
        strip(manifest, exprs, LIGHT, "expressions / light  —  [l]=layers [s]=sprite, * = degraded"),
        strip(manifest, exprs, DARK, "expressions / dark"),
        strip(manifest, actions, LIGHT, "actions / light"),
        strip(manifest, actions, DARK, "actions / dark"),
        strip(manifest, eyes, LIGHT, "eye layers over base / light"),
        strip(manifest, mouths, LIGHT, "mouth layers over base / light"),
        strip(manifest, brows, LIGHT, "brow layers over base / light"),
        strip(manifest, eyes + mouths, "checker", "eye + mouth layers / checkerboard (halo check)"),
        strip(manifest, fx, DARK, "fx / dark", tile=140),
    ]
    sheet = stack(parts)
    out = ASSETS / "_qa_220.png"
    sheet.save(out)
    print(f"wrote {out} {sheet.size}")

    # 脸部特写：220 px 全身图上的嘴只有十几像素，错位靠这张放大图才看得清。
    # 裁剪框用 registration-report.json 里由肤色推出的 face_box（1024 坐标 → 运行时坐标），
    # 不手填比例 —— 手填的比例实测把嘴切掉了。
    cv = manifest["canvas"]
    rep = json.loads((ASSETS / "registration-report.json").read_text())
    s = cv["width"] / rep["thresholds"]["canvas"]
    fb = rep["face_box"]
    fx1, fy1 = int(fb[0] * s), int(fb[1] * s)
    fx2, fy2 = int(fb[2] * s), int(fb[3] * s)
    faces = [(n, im.crop((fx1, fy1, fx2, fy2))) for n, im in exprs]
    eye_faces = [(n, im.crop((fx1, fy1, fx2, fy2))) for n, im in eyes + mouths + brows]
    close = stack(
        [
            strip(manifest, faces, LIGHT, "expression close-up / light", tile=200),
            strip(manifest, faces, DARK, "expression close-up / dark", tile=200),
            strip(manifest, eye_faces, LIGHT, "layer close-up / light", tile=200),
        ]
    )
    out2 = ASSETS / "_qa_faces.png"
    close.save(out2)
    print(f"wrote {out2} {close.size}")

    logo_sheet()
    hit_sheet()
    return 0


# 命中区的配色。顺序即优先级（Rust 取第一个命中的），所以画的时候也按这个顺序叠。
HIT_COLORS = {
    "badge": (226, 40, 40, 255),
    "cheek": (255, 150, 40, 255),
    "hand": (40, 170, 70, 255),
    "head": (60, 110, 230, 255),
    "skirt": (170, 70, 210, 255),
    "body": (90, 95, 110, 255),
}


def hit_sheet() -> None:
    """逐姿势命中区的 QA 图。

    每个姿势画一张：角色 + 该姿势的全部命中矩形（按部位配色，标题里有图例）。
    要人眼复核的就一件事 —— **矩形有没有压在对应的部位上**，以及灰色的整身兜底框
    有没有把角色整个框住。sleep 那一帧原来一个矩形都命中不到，就是这张图要防的事。
    """
    manifest = json.loads((ASSETS / "rig.json").read_text())
    path = ASSETS / "hitregions.json"
    if not path.exists():
        print("!! 没有 hitregions.json，跳过 _qa_hit.png（先跑 tools/art/regions.py）")
        return
    hm = json.loads(path.read_text())
    f = font(11)

    tiles: list[tuple[str, Image.Image]] = []
    for name, a in manifest["actions"].items():
        body = load(manifest, a["file"])
        canvas = Image.new("RGBA", body.size, (255, 255, 255, 255))
        canvas.alpha_composite(body)
        d = ImageDraw.Draw(canvas)
        regions = hm["poses"][name]
        # 兜底框先画（最底层的语义），再画细分部位，这样小矩形不会被灰框盖住。
        for r in sorted(regions, key=lambda r: r["part"] != "body"):
            c = HIT_COLORS.get(r["part"], (0, 0, 0, 255))
            box = (
                r["x0"] * body.width,
                r["y0"] * body.height,
                r["x1"] * body.width,
                r["y1"] * body.height,
            )
            d.rectangle(box, outline=c, width=3)
            d.text((box[0] + 3, box[1] + 1), r["part"], fill=c, font=f)
        tiles.append((f"{name} ({len(regions)} rects)", canvas))

    legend = "  ".join(HIT_COLORS)
    width = PAD + len(tiles) * (TILE + PAD)
    parts = [
        strip(
            {},
            tiles,
            LIGHT,
            f"per-pose hit regions @{TILE} — order = priority; grey 'body' is the never-miss fallback. parts: {legend}",
            tile=TILE,
            min_width=width,
        ),
        # 320 px 一档再画一遍：220 px 下 badge 那种小矩形几乎看不清边。
        strip({}, tiles, LIGHT, "same, larger", tile=320, min_width=width),
    ]
    sheet = stack(parts)
    out = ASSETS / "_qa_hit.png"
    sheet.save(out)
    print(f"wrote {out} {sheet.size}")


def logo_sheet() -> None:
    """StepFun logo 图层的专用 QA 图。

    五段，每一段回答一个具体问题：
    1. 栅格化产物本身对不对 —— 白底 / 深底 / 棋盘，以及和 qlmanage 渲染的同一份 SVG 叠合
       （红 = 只有我的，绿 = 只有 SVG 渲染器的；只应该剩一圈 1 px 的抗锯齿描边）。
    2. **每个动作 + 每个整脸 sprite 表情**在 220 px 下覆盖后的样子，浅底与深底各一行。
       这是用户真正看得到的东西，逐格人眼复核。标题里的 `-chest` 表示那一帧的胸前徽章
       量不到（被遮住），运行期只画发饰那一枚。
    3. 覆盖前 / 覆盖后对照（仍是 220 px），用来确认「原来的假方块」真的被换掉了。
    4. 徽章特写，逐帧逐位置，覆盖后 —— 看旧徽章有没有从圆盘边上露出来。
    5. 覆盖证明：把 logo 画成纯红，旧徽章的深色像素还露在红圈外面就会显成黑边。
       这一段是「盖干净了」的像素级证据，不靠肉眼估。
    """
    manifest = json.loads((ASSETS / "rig.json").read_text())
    lm_path = ASSETS / "logo.json"
    if not lm_path.exists():
        print("!! 没有 logo.json，跳过 _qa_logo.png（先跑 tools/art/logo.py）")
        return
    lm = json.loads(lm_path.read_text())
    logo = Image.open(ASSETS / lm["asset"]["file"]).convert("RGBA")
    placements = lm["placements"]

    # ---- 逐帧：(标签, 身体图, 该帧的 placements) ----
    # 动作按 rig.json 的顺序；整脸 sprite 表情沿用 idle 帧的位置（logo.py 已实测验证一致，
    # 见 measured.spriteExpressions），所以这里也用 idle 的 placements —— 和运行期一致。
    frames: list[tuple[str, Image.Image, dict]] = []
    for name, a in manifest["actions"].items():
        p = placements.get(name, {})
        missing = [s for s in ("hair", "chest") if s not in p]
        label = name + "".join(f" -{s}" for s in missing)
        frames.append((label, load(manifest, a["file"]), p))
    for name, e in manifest["expressions"].items():
        if e.get("mode") != "sprite":
            continue
        frames.append((f"{name} [sprite]", load(manifest, e["sprite"]["file"]), placements["idle"]))

    after = [(lbl, with_logo(logo, body, p)) for lbl, body, p in frames]
    base = load(manifest, manifest["base"]["file"])

    # ---- 1. 产物自身 ----
    icon = parse_icon((ASSETS / lm["source"]["svg"]).read_text())
    ref = reference_raster(ASSETS / lm["source"]["svg"], 256)
    overlay = Image.new("RGBA", (256, 256), (255, 255, 255, 255))
    if ref is not None:
        mine_m = _ink(render_icon(icon))
        ref_m = _ink(ref)
        px = overlay.load()
        a, b = mine_m.load(), ref_m.load()
        for y in range(256):
            for x in range(256):
                m, r = a[x, y] > 128, b[x, y] > 128
                if m and r:
                    px[x, y] = (34, 34, 38, 255)
                elif m:
                    px[x, y] = (226, 40, 40, 255)
                elif r:
                    px[x, y] = (40, 190, 60, 255)
    fid = lm["source"].get("fidelity") or {}
    raster = [
        ("logo.png", logo),
        ("on white", _on(logo, (255, 255, 255, 255))),
        ("on dark", _on(logo, DARK)),
        (f"vs SVG: IoU {fid.get('iou', '?')}", overlay),
    ]

    # ---- 3. 覆盖前后对照（idle 画幅）----
    before_after = [
        ("idle before (fake badge)", base),
        ("idle after (StepFun logo)", with_logo(logo, base, placements["idle"])),
    ]

    # ---- 4/5. 特写与覆盖证明，逐帧逐位置 ----
    closeups: list[tuple[str, Image.Image]] = []
    proof: list[tuple[str, Image.Image]] = []
    flat = Image.new("RGBA", logo.size, (226, 40, 40, 255))
    flat.putalpha(logo.getchannel("A"))
    for (lbl, body, p), (_, done) in zip(frames, after):
        for slot, pl in p.items():
            r = int(pl["size"])
            box = (int(pl["cx"] - r), int(pl["cy"] - r), int(pl["cx"] + r), int(pl["cy"] + r))
            closeups.append((f"{lbl.split(' ')[0]}/{slot} d={pl['size']} cov={pl['coverRadius']}", done.crop(box)))
            proof.append((f"{lbl.split(' ')[0]}/{slot}", place_logo(body.copy(), flat, pl).crop(box)))

    deep = fid.get("deepMismatchPixels", "?")
    width = PAD + max(len(after), len(closeups)) * (TILE + PAD)
    n_frames = len(frames)
    n_full = sum(1 for _, _, p in frames if len(p) == 2)
    parts = [
        strip(
            {},
            raster,
            LIGHT,
            f"StepFun logo raster 256px — overlay: red=mine only, green=qlmanage only, deep mismatch {deep}px",
            tile=200,
            min_width=width,
        ),
        strip(
            {},
            after,
            LIGHT,
            f"per-frame logo coverage / light @220 — {n_frames} frames, {n_full} with both badges "
            "(label suffix -chest = that badge is occluded in this pose, no logo drawn there)",
            tile=TILE,
            min_width=width,
        ),
        strip({}, after, DARK, "per-frame logo coverage / dark @220", tile=TILE, min_width=width),
        strip({}, before_after, LIGHT, "before / after (idle frame) @220", tile=TILE, min_width=width),
        strip({}, closeups, LIGHT, "badge close-up after coverage / light", tile=TILE, min_width=width),
        strip({}, closeups, DARK, "badge close-up after coverage / dark", tile=TILE, min_width=width),
        strip(
            {},
            proof,
            LIGHT,
            "coverage proof — logo painted flat red; any dark outside the red disc is the old badge leaking",
            tile=TILE,
            min_width=width,
        ),
    ]
    sheet = stack(parts)
    out = ASSETS / "_qa_logo.png"
    sheet.save(out)
    print(f"wrote {out} {sheet.size}")


def _ink(im: Image.Image) -> Image.Image:
    """黑墨掩膜（alpha 高且亮度低）。透明像素不算墨，即使 RGB 是黑的。"""
    im = im.convert("RGBA")
    a = im.getchannel("A").point(lambda v: 255 if v > 128 else 0)
    dark = im.convert("L").point(lambda v: 255 if v < 128 else 0)
    return ImageChops.multiply(a, dark)


def _on(im: Image.Image, bg) -> Image.Image:
    out = Image.new("RGBA", im.size, bg)
    out.alpha_composite(im)
    return out


if __name__ == "__main__":
    raise SystemExit(main())
