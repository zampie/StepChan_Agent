#!/usr/bin/env python
"""从 master.png 派生全部变体素材。

所有 prompt 来自 character.py，所有后处理来自 alpha.py / chroma.py。
本脚本只负责调度：并发、重试、断点续跑、日志。

运行（必须用 gpt-image-lab 的 venv，Pillow 和 httpx 在那里）：
    ~/Desktop/gpt-image-lab/.venv/bin/python tools/art/gen_variants.py [--only LABEL ...] [--concurrency 3]

两条实测约束决定了这里的写法：
1. proxy 对合法请求也会偶发 400（message 恒为 %!s(<nil>)），所以 400 必须当可重试错误，
   连续 4 次失败才判定为真失败。
2. /images/edits 忽略 background=transparent，所以 edit 类作业的输入是压平到品红的 master，
   产物在 postprocess 阶段本地抠像。
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

LAB = Path.home() / "Desktop" / "gpt-image-lab"
sys.path.insert(0, str(LAB / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from PIL import Image  # noqa: E402

from character import variant_jobs  # noqa: E402
from chroma import KEY, flatten_on_key  # noqa: E402
from gpt_image_lab.client import ImageClient, ImageRequest  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets" / "stepchan_q_v1"
MASTER = ASSETS / "master.png"
RAW = ASSETS / "raw"  # 1024 原始产物，留痕
KEYED_INPUT = RAW / "_master_magenta.png"
BLANK_INPUT = RAW / "_blank_magenta.png"
LOG = RAW / "_gen.log"

QUALITY = "medium"
SIZE = "1024x1024"
MODEL = "gpt-image-2"
MAX_ATTEMPTS = 4

_lock = threading.Lock()


def log(msg: str) -> None:
    line = f"{time.strftime('%H:%M:%S')} {msg}"
    with _lock:
        print(line, flush=True)
        with LOG.open("a") as fh:
            fh.write(line + "\n")


def prepare_input() -> None:
    """edits 的两种输入：master 压平到纯品红；以及一张纯品红空画布（给特效用）。"""
    RAW.mkdir(parents=True, exist_ok=True)
    if not KEYED_INPUT.exists():
        flatten_on_key(Image.open(MASTER), KEY).save(KEYED_INPUT)
        log(f"prepared {KEYED_INPUT.name}")
    if not BLANK_INPUT.exists():
        Image.new("RGB", (1024, 1024), KEY).save(BLANK_INPUT)
        log(f"prepared {BLANK_INPUT.name}")


def run_job(client: ImageClient, label: str, kind: str, prompt: str) -> dict:
    out = RAW / f"{label}.png"
    if out.exists():
        log(f"[{label}] skip (exists)")
        return {"label": label, "ok": True, "skipped": True, "attempts": 0}

    errors: list[str] = []
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            if kind == "gen":
                res = client.generate(
                    ImageRequest(
                        prompt=prompt,
                        model=MODEL,
                        size=SIZE,
                        quality=QUALITY,
                        background="transparent",
                        output_format="png",
                    ),
                    label=label,
                )
            else:
                res = client.edit(
                    prompt,
                    [BLANK_INPUT if kind == "edit_blank" else KEYED_INPUT],
                    label=label,
                    model=MODEL,
                    size=SIZE,
                    quality=QUALITY,
                    output_format="png",
                )
        except Exception as exc:  # 网络层异常同样当可重试
            errors.append(f"exc:{exc}")
            log(f"[{label}] attempt {attempt} raised {exc}")
            time.sleep(10 + random.random() * 10)
            continue

        if res.ok and res.images:
            log(f"[{label}] ok attempt={attempt} {res.elapsed_s:.0f}s {res.images[0].width}x{res.images[0].height} mode={res.images[0].mode}")
            return {"label": label, "ok": True, "attempts": attempt, "elapsed_s": round(res.elapsed_s, 1)}

        errors.append(f"http={res.status_code} {res.error}")
        log(f"[{label}] attempt {attempt} FAIL http={res.status_code} ({res.elapsed_s:.0f}s) -> backoff")
        time.sleep(15 + attempt * 10 + random.random() * 10)

    log(f"[{label}] GIVING UP after {MAX_ATTEMPTS} attempts :: {errors[-1] if errors else '?'}")
    return {"label": label, "ok": False, "attempts": MAX_ATTEMPTS, "errors": errors}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", nargs="*", default=None)
    ap.add_argument("--concurrency", type=int, default=3)
    ap.add_argument(
        "--fx-mode",
        choices=["gen", "edit_blank"],
        default="edit_blank",
        help="特效走哪条路。gen 是本来该用的（有真 alpha），但该 key 的 generations 实测 400；"
        "edit_blank 在纯品红空画布上画，本地抠像。",
    )
    args = ap.parse_args()

    jobs = variant_jobs(args.fx_mode)
    if args.only:
        jobs = {k: v for k, v in jobs.items() if k in set(args.only)}
        missing = set(args.only) - set(jobs)
        if missing:
            print(f"unknown labels: {sorted(missing)}", file=sys.stderr)
            return 2

    prepare_input()
    client = ImageClient(out_dir=RAW, timeout=1800.0)
    log(f"key={client.settings.key_fingerprint} src={client.settings.source} jobs={len(jobs)} concurrency={args.concurrency}")

    t0 = time.time()
    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        results = list(pool.map(lambda kv: run_job(client, kv[0], *kv[1]), jobs.items()))

    ok = [r for r in results if r["ok"]]
    lost = [r for r in results if not r["ok"]]
    retried = [r for r in ok if r.get("attempts", 0) > 1]
    run = {
        "fx_mode": args.fx_mode,
        "total": len(results),
        "ok": len(ok),
        "skipped": sum(1 for r in ok if r.get("skipped")),
        "lost": [r["label"] for r in lost],
        "needed_retry": {r["label"]: r["attempts"] for r in retried},
        "wall_clock_s": round(time.time() - t0, 1),
    }
    # 断点续跑会多次运行，每次都留一条记录 —— 「第几次才成」是要报出去的事实。
    path = RAW / "_gen_summary.json"
    history = json.loads(path.read_text()) if path.exists() else {"runs": []}
    if "runs" not in history:
        history = {"runs": [history]}
    history["runs"].append(run)
    path.write_text(json.dumps(history, indent=2, ensure_ascii=False))
    log("summary " + json.dumps(run, ensure_ascii=False))
    return 0 if not lost else 1


if __name__ == "__main__":
    raise SystemExit(main())
