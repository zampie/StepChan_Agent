#!/usr/bin/env bash
# 从 master.png 重建整套运行时素材与 rig.json。
#
# 四步，每一步都可单独重跑：
#   1. gen_variants.py  调接口生成变体（断点续跑：已存在的文件会跳过）
#   2. register.py      抠像 + 像素 diff 配准 + 写 rig.json（运行期副本由 npm run sync-rig 负责）
#   3. logo.py          StepFun logo 栅格化 + 实测旧徽章覆盖半径 + 写 logo.json
#   4. qa_sheet.py      生成人眼复核用的 QA 图
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
  echo "=== 1/4 生成变体 ==="
  # 退出码 1 表示有变体丢了（proxy 的 400）。不中断：register.py 会把丢失的显式降级，
  # 这比整条流水线挂掉更有用 —— 丢两张特效不该阻塞渲染器联调。
  "$PY" "$ROOT/tools/art/gen_variants.py" --concurrency 3 || echo "!! 有变体生成失败，继续（会在 degraded 里列出）"
else
  echo "=== 1/4 跳过生成 ==="
fi

echo "=== 2/4 配准与清单 ==="
"$PY" "$ROOT/tools/art/register.py"

echo "=== 3/4 StepFun logo 图层 ==="
# logo 不走 diff 配准（master 上那块是模型臆造的假徽章，diff 推不出真 logo 该多大），
# 走的是「SVG 几何 + 实测旧徽章覆盖半径」这条独立的证明链。见 logo.py 头部。
"$PY" "$ROOT/tools/art/logo.py"

echo "=== 4/4 QA 图 ==="
"$PY" "$ROOT/tools/art/qa_sheet.py"

echo
echo "完成。复核这三张图再提交："
echo "  $ROOT/assets/stepchan_q_v1/_qa_220.png"
echo "  $ROOT/assets/stepchan_q_v1/_qa_faces.png"
echo "  $ROOT/assets/stepchan_q_v1/_qa_logo.png"
echo "实测数字在 $ROOT/assets/stepchan_q_v1/registration-report.json 与 logo.json"
