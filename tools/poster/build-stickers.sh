#!/usr/bin/env bash
# 出动态表情包：docs/images/stickers/<name>.png（APNG）与 .gif
#
# 默认只出 GIF。实测这个画风下 GIF 的 1 bit 透明**看不出毛刺** —— 角色本身带浅色
# 描边，深底浅底都干净；而 ffmpeg 的 APNG 不做帧间差分，单个 0.6–1.2 MB（GIF 的
# 4 倍），换不来可见收益。需要真 alpha 时 APNG=1 ./build-stickers.sh。
#
# dither=none：她的画风是平涂，开抖动会在头发上留下可见纹理，而且体积并不更小。
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$(pwd)
PORT=${PORT:-8732}
SIZE=${SIZE:-256}
FPS=${FPS:-12}   # 12fps：渲染器的眨眼是 half45/closed75/half55，10fps 下一帧 100ms 太粗
CHROME=${CHROME:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
OUT="$ROOT/docs/images/stickers"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"; kill %1 2>/dev/null || true' EXIT

[ -x "$CHROME" ] || { echo "找不到 Chrome，用 CHROME=... 指定" >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "需要 ffmpeg" >&2; exit 1; }
mkdir -p "$OUT"

python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
sleep 2
URL="http://127.0.0.1:$PORT/tools/poster/poster.html"

# 不带参数出全部；带名字只出指定的几个（改一个表情不用等全套重跑）
#   ./build-stickers.sh happy
if [ $# -gt 0 ]; then
  NAMES="$*"
else
  NAMES=$(node --input-type=module -e \
    "import('$ROOT/tools/poster/stickers.js').then(m=>process.stdout.write(m.STICKER_NAMES.join(' ')))")
fi

for name in $NAMES; do
  N=$(node --input-type=module -e \
    "import('$ROOT/tools/poster/stickers.js').then(m=>process.stdout.write(String(m.buildSticker('$name').length)))")
  echo "· ${name}（${N} 帧）"
  rm -rf "$TMP/$name"; mkdir -p "$TMP/$name"
  for i in $(seq 0 $((N - 1))); do
    "$CHROME" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
      --window-size=512,512 --default-background-color=00000000 \
      --screenshot="$TMP/$name/$(printf %03d "$i").png" --virtual-time-budget=2500 \
      "$URL?mode=sticker&name=$name&i=$i" >/dev/null 2>&1
  done

  # 按**整段**的 alpha 包围盒统一裁切：逐帧各裁会让循环时画面跳动
  python3 - "$TMP/$name" "$SIZE" <<'PY'
import sys, pathlib
from PIL import Image
d, size = pathlib.Path(sys.argv[1]), int(sys.argv[2])
fs = sorted(d.glob('*.png'))
box = None
for f in fs:
    b = Image.open(f).getbbox()
    if b is None: continue
    box = b if box is None else (min(box[0],b[0]), min(box[1],b[1]), max(box[2],b[2]), max(box[3],b[3]))
pad = 6
box = (max(0,box[0]-pad), max(0,box[1]-pad), min(512,box[2]+pad), min(512,box[3]+pad))
# 裁成正方形，表情包平台普遍要求等边
w, h = box[2]-box[0], box[3]-box[1]
side = max(w, h)
cx, cy = (box[0]+box[2])//2, (box[1]+box[3])//2
sq = (cx-side//2, cy-side//2, cx-side//2+side, cy-side//2+side)
for f in fs:
    im = Image.open(f).convert('RGBA').crop(sq).resize((size, size), Image.LANCZOS)
    im.save(f)
print(f'  裁切 {w}×{h} → {side}² → {size}²')
PY

  # GIF：1 bit 透明，留一个调色板槽位给透明色
  ffmpeg -y -loglevel error -framerate "$FPS" -i "$TMP/$name/%03d.png" \
    -filter_complex "split[a][b];[a]palettegen=max_colors=120:reserve_transparent=1[p];\
[b][p]paletteuse=alpha_threshold=128:dither=none" -loop 0 "$OUT/$name.gif"
  # 需要真 alpha 时才出 APNG（体积是 GIF 的 4 倍）
  if [ "${APNG:-}" = "1" ]; then
    ffmpeg -y -loglevel error -framerate "$FPS" -i "$TMP/$name/%03d.png" \
      -plays 0 -f apng "$OUT/$name.png"
  fi
done

echo
ls -la "$OUT" | awk 'NR>3 {printf "  %-18s %6.0f KB\n", $NF, $5/1024}'
