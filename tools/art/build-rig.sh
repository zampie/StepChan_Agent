#!/usr/bin/env bash
# 从 master.png 重建整套运行时素材与 rig.json。
#
# 三步，每一步都可单独重跑：
#   1. gen_variants.py  调接口生成变体（断点续跑：已存在的文件会跳过）
#   2. register.py      抠像 + 像素 diff 配准 + 写 rig.json + 同步到 public/
#   3. qa_sheet.py      生成人眼复核用的 QA 图
#
# 用法:
#   tools/art/build-rig.sh            # 全量（缺的才生成）
#   tools/art/build-rig.sh --no-gen   # 跳过生成，只重跑配准与 QA（改阈值时用这个）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Pillow 和 httpx 在 gpt-image-lab 的 venv 里；本仓库没有 Python 依赖管理。
PY="$HOME/Desktop/gpt-image-lab/.venv/bin/python"

if [ ! -x "$PY" ]; then
  echo "找不到 $PY —— 素材流水线依赖 gpt-image-lab 的 venv（Pillow + httpx）" >&2
  exit 1
fi

if [ "${1:-}" != "--no-gen" ]; then
  echo "=== 1/3 生成变体 ==="
  # 退出码 1 表示有变体丢了（proxy 的 400）。不中断：register.py 会把丢失的显式降级，
  # 这比整条流水线挂掉更有用 —— 丢两张特效不该阻塞渲染器联调。
  "$PY" "$ROOT/tools/art/gen_variants.py" --concurrency 3 || echo "!! 有变体生成失败，继续（会在 degraded 里列出）"
else
  echo "=== 1/3 跳过生成 ==="
fi

echo "=== 2/3 配准与清单 ==="
"$PY" "$ROOT/tools/art/register.py"

echo "=== 3/3 QA 图 ==="
"$PY" "$ROOT/tools/art/qa_sheet.py"

echo
echo "完成。复核这两张图再提交："
echo "  $ROOT/assets/stepchan_q_v1/_qa_220.png"
echo "  $ROOT/assets/stepchan_q_v1/_qa_faces.png"
echo "实测数字在 $ROOT/assets/stepchan_q_v1/registration-report.json"
