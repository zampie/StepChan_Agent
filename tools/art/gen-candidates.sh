#!/usr/bin/env bash
# 生成 Q 版主形象候选。并发 3，每张 medium 档约 73 s。
# 用法: tools/art/gen-candidates.sh [quality] [only_label]
set -uo pipefail

LAB="/Users/jyxc-dz-0100316/Desktop/gpt-image-lab"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$ROOT/assets/stepchan_q_v1/candidates"
QUALITY="${1:-medium}"
ONLY="${2:-}"
CONCURRENCY=3

mkdir -p "$OUT"

# 从 character.py 读 prompt，保证 prompt 只有一个来源
labels=$("$LAB/.venv/bin/python" -c "
import sys; sys.path.insert(0, '$ROOT/tools/art')
from character import CANDIDATES
print('\n'.join(CANDIDATES))
")

gen_one() {
  local label="$1"
  local prompt
  prompt=$("$LAB/.venv/bin/python" -c "
import sys; sys.path.insert(0, '$ROOT/tools/art')
from character import CANDIDATES
print(CANDIDATES['$label'])
")
  # proxy 的 400 不可信（message 恒为 %!s(<nil>)，且合法请求会偶发 400）→ 重试 3 次
  for attempt in 1 2 3; do
    if (cd "$LAB" && uv run gimg gen "$prompt" \
          --size 1024x1024 --quality "$QUALITY" \
          --background transparent --output-format png \
          --label "$label-$QUALITY" --out "$OUT" >>"$OUT/$label.log" 2>&1); then
      echo "[$label] ok (attempt $attempt)"
      return 0
    fi
    echo "[$label] attempt $attempt failed, backing off" >>"$OUT/$label.log"
    sleep 15
  done
  echo "[$label] FAILED after 3 attempts"
  return 1
}

running=0
for label in $labels; do
  [ -n "$ONLY" ] && [ "$label" != "$ONLY" ] && continue
  gen_one "$label" &
  running=$((running + 1))
  if [ "$running" -ge "$CONCURRENCY" ]; then
    wait -n 2>/dev/null || wait
    running=$((running - 1))
  fi
done
wait
echo "=== done: $(ls -1 "$OUT"/*.png 2>/dev/null | wc -l | tr -d ' ') png ==="
