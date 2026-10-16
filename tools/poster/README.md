# 海报生成

```bash
tools/poster/build.sh          # 出 docs/images/poster.png 与 poster.gif
```

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

- `poster.html` —— 版面与文案，三种渲染模式（`?mode=poster|base|frame`）
- `rig.js` —— 按 `rig.json` / `logo.json` 把一帧角色叠出来
- `timeline.js` —— 动画时间线（呼吸眨眼 → 说话 → 兴奋 → 歪头 → 害羞 → 挥手 → 打瞌睡）
- `build.sh` —— 起本地服务器、逐帧截图、ffmpeg 合成

背景是 `gpt-image-2` 生成的，源文件在 `assets/poster/bg-window.png`。

## 两个坑

- **`file://` 下 `fetch` 被 CORS 拦掉**，角色渲染不出来而页面不报错。必须走 HTTP，`build.sh` 已处理。
- **Chrome 的 `--screenshot=` 不展开 `~`**，写不进去也不报错。脚本里一律用绝对路径。
