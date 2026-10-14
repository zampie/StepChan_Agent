#!/usr/bin/env python
"""alpha.py / chroma.py 的合成输入自测。

为什么要合成输入：真实产物只能验证「结果看起来没毛病」，验证不了「边界条件处理对不对」。
这里每个用例的正确答案都是手算出来的，所以能把回归钉死。

由 tests/art.test.ts 调用（npm test 会跑到）。独立运行：
    ~/Desktop/gpt-image-lab/.venv/bin/python tools/art/selftest.py
退出码 0 = 全过，非 0 = 有失败，失败详情打到 stdout。
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from PIL import Image  # noqa: E402

from alpha import CEIL, FLOOR, alpha_report, clean_alpha, content_bbox, normalize_canvas  # noqa: E402
from chroma import KEY, chroma_key, chroma_key_flood, flatten_on_key, key_ratio  # noqa: E402

failures: list[str] = []


def check(cond: bool, msg: str) -> None:
    if not cond:
        failures.append(msg)


def rgba(size, color):
    return Image.new("RGBA", size, color)


# ---------------------------------------------------------------------------
# clean_alpha：抹掉 a<16 的光晕，把 a>=240 拉满，保留中间的真抗锯齿带
# ---------------------------------------------------------------------------
def test_clean_alpha_thresholds():
    im = rgba((5, 1), (10, 20, 30, 0))
    # 逐像素铺上有代表性的 alpha：光晕 / 恰好在下界 / 中间 / 恰好在上界 / 实测的 253 上限
    for x, a in enumerate([8, FLOOR, 128, CEIL, 253]):
        im.putpixel((x, 0), (10, 20, 30, a))
    out = clean_alpha(im)
    got = [out.getpixel((x, 0))[3] for x in range(5)]
    check(got[0] == 0, f"a=8 的光晕应被抹成 0，实际 {got[0]}")
    check(got[1] == FLOOR, f"a={FLOOR} 恰在下界应保留，实际 {got[1]}")
    check(got[2] == 128, f"a=128 的抗锯齿带应原样保留，实际 {got[2]}")
    check(got[3] == 255, f"a={CEIL} 恰在上界应拉满，实际 {got[3]}")
    check(got[4] == 255, f"gpt-image-2 的 253 上限应被拉满，实际 {got[4]}")


def test_alpha_report_counts():
    im = rgba((10, 10), (0, 0, 0, 0))
    for i in range(40):
        im.putpixel((i % 10, i // 10), (0, 0, 0, 255))
    for i in range(40, 50):
        im.putpixel((i % 10, i // 10), (0, 0, 0, 100))
    r = alpha_report(im)
    check(r["opaque"] == 40.0, f"不透明占比应为 40.0，实际 {r['opaque']}")
    check(r["edge"] == 10.0, f"过渡带占比应为 10.0，实际 {r['edge']}")
    check(r["transparent"] == 50.0, f"全透明占比应为 50.0，实际 {r['transparent']}")
    check(r["max"] == 255, f"最大 alpha 应为 255，实际 {r['max']}")


def test_content_bbox_ignores_halo():
    im = rgba((20, 20), (0, 0, 0, 8))  # 整幅都是极淡光晕
    for y in range(5, 15):
        for x in range(4, 12):
            im.putpixel((x, y), (255, 0, 0, 255))
    # content_bbox 的阈值是 24，a=8 的光晕不该把框撑满。
    check(content_bbox(im) == (4, 5, 12, 15), f"外接框被光晕撑开了：{content_bbox(im)}")


def test_normalize_canvas_bottom_aligned():
    im = rgba((40, 80), (0, 0, 0, 0))
    for y in range(10, 70):
        for x in range(8, 32):
            im.putpixel((x, y), (0, 128, 255, 255))
    out = normalize_canvas(im, 100, headroom=0.05)
    check(out.size == (100, 100), f"画幅应为 100×100，实际 {out.size}")
    bb = content_bbox(out)
    pad = int(100 * 0.05)
    # 脚底对齐：内容底边应贴在 size - pad 上（允许 1 px 的取整误差）。
    check(abs(bb[3] - (100 - pad)) <= 1, f"底部未对齐到 {100 - pad}，实际 {bb[3]}")
    # 水平居中。
    left, right = bb[0], 100 - bb[2]
    check(abs(left - right) <= 1, f"水平未居中：左 {left} 右 {right}")


# ---------------------------------------------------------------------------
# chroma：品红抠像
# ---------------------------------------------------------------------------
def test_flatten_on_key_is_opaque_rgb():
    im = rgba((4, 4), (0, 0, 0, 0))
    im.putpixel((1, 1), (10, 200, 30, 255))
    flat = flatten_on_key(im, KEY)
    check(flat.mode == "RGB", f"压平后应为 RGB，实际 {flat.mode}")
    check(flat.getpixel((0, 0)) == KEY, f"透明处应变成 key 色，实际 {flat.getpixel((0, 0))}")
    check(flat.getpixel((1, 1)) == (10, 200, 30), "不透明主体色不应被改动")


def test_chroma_key_removes_background_keeps_subject():
    # 背景纯品红，中间一块角色青色 #14B6C5（距品红 235，远高于 EDGE_DIST）
    im = Image.new("RGB", (20, 20), KEY)
    for y in range(6, 14):
        for x in range(6, 14):
            im.putpixel((x, y), (20, 182, 197))
    out = chroma_key(im)
    check(out.getpixel((0, 0))[3] == 0, f"背景应被抠成全透明，实际 alpha {out.getpixel((0, 0))[3]}")
    check(out.getpixel((10, 10))[3] == 255, f"主体应完全不透明，实际 {out.getpixel((10, 10))[3]}")
    check(out.getpixel((10, 10))[:3] == (20, 182, 197), "主体颜色不应被 despill 改动")
    check(content_bbox(out) == (6, 6, 14, 14), f"主体外接框错了：{content_bbox(out)}")


def test_chroma_key_ramp_is_semi_transparent():
    # 距离落在 BG_DIST..EDGE_DIST 之间的像素应拿到半透明 alpha，而不是 0 或 255。
    im = Image.new("RGB", (3, 1), KEY)
    im.putpixel((1, 0), (255, 145, 255))  # 到品红的通道最大差 = 145
    out = chroma_key(im)
    a = out.getpixel((1, 0))[3]
    check(0 < a < 255, f"过渡带像素应为半透明，实际 alpha {a}")


def test_key_ratio_matches_hand_count():
    im = Image.new("RGB", (10, 10), KEY)  # 100 px 全背景
    for i in range(25):
        im.putpixel((i % 10, i // 10), (20, 182, 197))  # 25 px 主体
    r = key_ratio(im)
    check(r["bg"] == 75.0, f"背景占比应为 75.0，实际 {r['bg']}")
    check(r["subject"] == 25.0, f"主体占比应为 25.0，实际 {r['subject']}")


def test_flood_key_preserves_interior_near_key_color():
    """这条是 heart 那个 bug 的回归用例。

    粉色 (249,81,144) 到品红的通道最大差只有 111，落在过渡带里。
    按颜色距离抠会把它抠成半透明（实测整颗心只剩描边）；
    按「从边缘连通」抠则必须保留，因为它被深色描边包住，连不到画面边缘。
    """
    pink = (249, 81, 144)
    outline = (30, 30, 40)
    im = Image.new("RGB", (20, 20), KEY)
    for y in range(4, 16):
        for x in range(4, 16):
            im.putpixel((x, y), outline if x in (4, 15) or y in (4, 15) else pink)

    by_color = chroma_key(im)
    by_flood = chroma_key_flood(im)
    check(
        by_color.getpixel((10, 10))[3] < 255,
        "按颜色距离抠本该吃掉粉色内部（用例前提不成立，说明阈值变了）",
    )
    check(by_flood.getpixel((10, 10))[3] == 255, "洪水填充抠像必须保留粉色内部")
    check(by_flood.getpixel((10, 10))[:3] == pink, f"粉色不应被 despill 改动，实际 {by_flood.getpixel((10, 10))[:3]}")
    check(by_flood.getpixel((0, 0))[3] == 0, "背景仍应被抠干净")


def test_flood_key_removes_background_enclosed_by_nothing():
    im = Image.new("RGB", (12, 12), KEY)
    for y in range(3, 9):
        for x in range(3, 9):
            im.putpixel((x, y), (20, 182, 197))
    out = chroma_key_flood(im)
    check(out.getpixel((0, 0))[3] == 0, "四角应全透明")
    check(out.getpixel((11, 11))[3] == 0, "四角应全透明")
    check(out.getpixel((5, 5))[3] == 255, "主体应不透明")


def main() -> int:
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for t in tests:
        before = len(failures)
        try:
            t()
        except Exception as exc:  # noqa: BLE001
            failures.append(f"{t.__name__} 抛异常：{exc!r}")
        if len(failures) == before:
            print(f"ok   {t.__name__}")
        else:
            for f in failures[before:]:
                print(f"FAIL {t.__name__}: {f}")
    print(f"\n{len(tests) - len({f.split(':')[0] for f in failures})}/{len(tests)} 组通过，{len(failures)} 条失败")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
