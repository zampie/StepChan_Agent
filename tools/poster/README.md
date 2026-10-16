# 海报 / 表情包 / 素材总览表 生成

README 里所有角色相关的图都从这里出 —— 海报、动态表情包、以及表情/动作/效果件三张总览表。

```bash
tools/poster/build.sh            # docs/images/poster.png 与 poster.gif
tools/poster/build-stickers.sh   # docs/images/stickers/*.gif（10 个透明循环）
APNG=1 tools/poster/build-stickers.sh   # 另出真 alpha 的 APNG（体积约 4 倍）
```

总览表目前靠手动截图（`?mode=sheet&kind=expressions|actions|fx`，见下文模式表），
素材变了需要重跑一次。

依赖：无头 Chrome（系统装的 Google Chrome 即可）、ffmpeg、python3、node。

## 为什么是 HTML 而不是 Python 画图

排版改一行就能看效果；更重要的是**角色合成可以直接复用 `rig.json` / `logo.json`** ——
那两份清单本来就是给前端读的，不用在别处再抄一遍几何。

几何参数一律来自仓库数据，与运行时渲染器同源：

| 参数 | 来源 |
|---|---|
| 表情覆盖层的 x/y 偏移 | `rig.json` 的 `layers[*]`（像素 diff 算出来的配准） |
| 覆盖层何时成立 | 只在 `idle` 和程序化动作上 —— 对齐 `RigRenderer.layersActive()` |
| FX 边长与落点 | `FX_SIZE = 0.22`、`FX_SPAWN` —— 抄自 `RigRenderer` |
| 歪头角度 | 12.6°（0.22 rad）—— `PROCEDURAL_POSE.tilt.rotation` |
| logo 位置 | `logo.json` 的逐姿势 `placements`，含 `rotation`；标记为看不见的姿势不贴 |

不照搬这些的后果是配图比应用本身还错 —— 第一版漏了「覆盖层只在 idle 成立」，
生成的睡觉姿势被叠上表情层，眼睛飘到了头顶。

## 文件

- `poster.html` —— 版面与文案，五种渲染模式：

  | `?mode=` | 用途 |
  |---|---|
  | `poster` | 完整静态海报 |
  | `base` | 同上但隐藏角色，作为 GIF 的静态底 |
  | `frame` | 只渲染角色（透明底），配合 `&i=N` 逐帧截图 |
  | `sticker` | 表情包单帧（透明底），配合 `&name=X&i=N` |
  | `sheet` | 素材总览表（透明底），配合 `&kind=expressions\|actions\|fx` |

- `rig.js` —— 按 `rig.json` / `logo.json` 把一帧角色叠出来
- `timeline.js` —— 海报的动画时间线（呼吸眨眼 → 说话 → 兴奋 → 歪头 → 害羞 → 挥手 → 打瞌睡）
- `stickers.js` —— 10 个表情包各自的循环。**每条都要首尾相接**，否则贴图循环时会跳
- `build.sh` —— 起本地服务器、逐帧截图、ffmpeg 合成

背景是 `gpt-image-2` 生成的，源文件在 `assets/poster/bg-window.png`。

## 哪些表情包能动眼睛

**眼睛是这套素材里表现力最强的一层，但只有分层表情能动。** 逐个核对过：

| 表情包 | 用的是 | 眼睛动效 |
|---|---|---|
| happy | 自定义图层（睁眼 + 笑嘴） | 眨眼 → 笑弯眼 |
| excited | 自定义图层 | 大眼 → 睁大 → 星星眼（眼睛一亮） |
| surprised | 分层 `surprised` | 平静 → 猛地瞪大 |
| curious | 分层 `curious`（眼型 `open`） | 歪头中途眨一次 |
| proud | 分层 `proud`（眼型 `smile`） | 睁眼 → 得意地眯起（smile 不能眨，见下） |
| hello / sleepy | 整身姿势图 `wave` / `sleep` | **不能** —— 姿势图自带脸，覆盖层不成立 |
| shy / angry / sad | 整脸图（sprite） | **不能** —— 分层画不出腮红 / 怒气符号 / 眼泪，这是 `rig.json` 里记着的降级项 |

两条约束来自渲染器，照搬即可：

- **`NO_BLINK = {closed, half, smile}`** —— 这些眼型本身就是闭着或变形的，再叠眨眼
  只会打架。`happy` / `proud` 的预设眼型是 `smile`，所以它们做的是**眼型过渡**而不是眨眼
- **眨眼节奏 `half 45ms → closed 75ms → half 55ms`**（`BLINK_FRAMES`）。12fps 下一帧
  83ms，所以 half / closed / half 各一帧最接近真机观感 —— 这也是表情包默认 12fps 的原因

预设只有 11 个固定组合，而图层系统支持任意组合（见 `rig.js` 的 `layers` 参数）。
`happy` 要正常眨眼就必须有"睁眼 + 笑嘴"这种预设里没有的搭配。

## 表情包的几个决定

- **按整段的 alpha 包围盒统一裁切**，不逐帧各裁 —— 逐帧裁会让循环时画面跳动
- **裁成正方形**，表情包平台普遍要求等边
- **默认只出 GIF**。实测这个画风下 1 bit 透明看不出毛刺（角色自带浅色描边），
  而 ffmpeg 的 APNG 不做帧间差分，单个 0.6–1.2 MB，换不来可见收益
- **`dither=none`**。她是平涂画风，开抖动会在头发上留下可见纹理，而且体积并不更小

## 三个坑

- **`file://` 下 `fetch` 被 CORS 拦掉**，角色渲染不出来而页面不报错。必须走 HTTP，`build.sh` 已处理。
- **Chrome 的 `--screenshot=` 不展开 `~`**，写不进去也不报错。脚本里一律用绝对路径。
- **bash 变量名后紧跟多字节字符**（如 `$FRAMES（`）时，某些 locale 下首字节会被当成
  标识符字符，变量名被污染成 `FRAMES\xef` → unbound variable。后跟非 ASCII 一律写 `${VAR}`。
  另外 node 的 `console.log` 对数字会上色，ANSI 码混进命令替换会把算术弄炸 ——
  用 `process.stdout.write(String(n))`。
