#!/usr/bin/env bash
# 出海报：静态 PNG + 动态 GIF，写到 docs/images/。
#
# 为什么要起一个本地 HTTP 服务器：poster.html 用 fetch 读 rig.json / logo.json，
# file:// 下会被 CORS 拦掉（角色渲染不出来，页面却不报错 —— 排查过一次）。
#
# 为什么用无头 Chrome 而不是 Python 画：排版用 HTML/CSS 改一行就能看效果，
# 而且角色合成能直接复用 rig.json / logo.json —— 那本来就是给前端读的清单。
set -euo pipefail
cd "$(dirname "$0")/../.."          # 仓库根
ROOT=$(pwd)
PORT=${PORT:-8731}
CHROME=${CHROME:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
TMP=$(mktemp -d); trap 'rm -rf "$TMP"; kill %1 2>/dev/null || true' EXIT

[ -x "$CHROME" ] || { echo "找不到 Chrome，用 CHROME=... 指定" >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "需要 ffmpeg" >&2; exit 1; }

python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
sleep 2
URL="http://127.0.0.1:$PORT/tools/poster/poster.html"
shot() { "$CHROME" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --window-size="$2" --screenshot="$1" --virtual-time-budget="${4:-8000}" ${3:-} "$URL?$5" >/dev/null 2>&1; }

echo "· 静态海报"
shot "$ROOT/docs/images/poster.png" 1024,1536 "" 8000 "mode=poster"
echo "· GIF 静态底"
shot "$TMP/base.png" 1024,1536 "" 8000 "mode=base"

# 帧数由 timeline.js 决定，这里问它要，别写死
FRAMES=$(node --input-type=module -e "import('$ROOT/tools/poster/timeline.js').then(m=>process.stdout.write(String(m.buildTimeline().length)))")
echo "· 角色帧 ×${FRAMES}（透明底）"
mkdir -p "$TMP/f"
for i in $(seq 0 $((FRAMES - 1))); do
  shot "$TMP/f/$(printf %03d "$i").png" 665,665 \
    "--default-background-color=00000000" 2500 "mode=frame&i=$i"
done

echo "· 合成 GIF"
# 角色框：left:50% + translateX(-50%) → (1024-665)/2；top 见 poster.html 的 #char
ffmpeg -y -loglevel error -loop 1 -i "$TMP/base.png" -framerate 12 -i "$TMP/f/%03d.png" \
  -filter_complex "[0][1]overlay=180:555:shortest=1,split[a][b];\
[a]palettegen=max_colors=128:stats_mode=diff[p];\
[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" \
  -loop 0 "$ROOT/docs/images/poster.gif"

ls -la "$ROOT/docs/images/poster.png" "$ROOT/docs/images/poster.gif" | awk '{printf "  %s  %.2f MB\n",$NF,$5/1048576}'
