#!/usr/bin/env python
"""视觉 QA 图：把 rig.json 真正合成出来，人眼检查配准。

刻意**从 rig.json 读**，而不是从中间变量读 —— 合成逻辑和渲染器完全一致
（base + brow + eyes + mouth + blush，按清单里的 x/y 叠放）。
所以这张图同时验证了清单里的坐标是对的：如果 x/y 错了，图上会立刻看出五官错位。

浅色与深色两种底色都画：浅色看描边与抠像边缘，深色看有没有残留的白雾光晕
（透明背景产物的 a<16 淡光晕在深色桌面上会显出一圈白边）。

运行：~/Desktop/gpt-image-lab/.venv/bin/python tools/art/qa_sheet.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from PIL import Image, ImageDraw, ImageFont  # noqa: E402

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
) -> Image.Image:
    f = font()
    ft = font(15)
    head = 24
    w = PAD + len(items) * (tile + PAD)
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
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
