"""Alpha 后处理。

两个实测事实驱动了这里的处理：
1. gpt-image-2 的主体 alpha 上限只到 253–254，**没有一个 255 像素**。
   下游做 alpha 相乘合成或要求二值 alpha 的地方会出问题，所以要阈值化。
2. 透明背景产物带约 1.5% 的 a<16 极淡光晕。肉眼几乎看不见，但叠在深色桌面上
   会显出一圈白雾，必须抹掉。
"""

from __future__ import annotations

import hashlib
from pathlib import Path

from PIL import Image

# 低于此值视为背景噪声（实测光晕集中在 a<16）
FLOOR = 16
# 高于此值视为完全不透明（实测主体上限 253–254）
CEIL = 240


def clean_alpha(im: Image.Image, floor: int = FLOOR, ceil: int = CEIL) -> Image.Image:
    """抹掉淡光晕并把近不透明像素拉满，保留真正的抗锯齿过渡带。"""
    im = im.convert("RGBA")
    alpha = im.getchannel("A").point(lambda v: 0 if v < floor else (255 if v >= ceil else v))
    im.putalpha(alpha)
    return im


def content_bbox(im: Image.Image, threshold: int = 24) -> tuple[int, int, int, int]:
    """不透明内容的外接框。用于统一画幅，避免留白差异伪装成大小差异。"""
    mask = im.convert("RGBA").getchannel("A").point(lambda v: 255 if v > threshold else 0)
    bbox = mask.getbbox()
    if bbox is None:
        raise ValueError("图像没有任何不透明像素")
    return bbox


def normalize_canvas(im: Image.Image, size: int, headroom: float = 0.03) -> Image.Image:
    """裁紧后居中放进正方形画布，底部对齐（锚点是脚底）。

    所有变体都经过同一套归一化，覆盖层的配准才有意义。
    """
    im = clean_alpha(im)
    im = im.crop(content_bbox(im))
    pad = max(1, int(size * headroom))
    inner = size - pad * 2
    ratio = min(inner / im.width, inner / im.height)
    im = im.resize((max(1, round(im.width * ratio)), max(1, round(im.height * ratio))), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(im, ((size - im.width) // 2, size - pad - im.height), im)
    return canvas


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def alpha_report(im: Image.Image) -> dict[str, float]:
    """alpha 分布。用于校验后处理真的生效了，而不是口头声称。"""
    data = list(im.convert("RGBA").getchannel("A").getdata())
    n = len(data)
    zero = sum(1 for v in data if v == 0)
    full = sum(1 for v in data if v == 255)
    mid = n - zero - full
    return {
        "transparent": round(100 * zero / n, 2),
        "opaque": round(100 * full / n, 2),
        "edge": round(100 * mid / n, 2),
        "max": max(data),
    }
