# 素材接入与已知限制

源目录：`assets/blue_pet_assets_v0_2/`。原 ZIP SHA-256：`ed68d3e9a376bbd034f43bca4a41f509b39243c8c7cc3187e3d83354c69ab6f9`。包内已展开所有内容，无需再找旧会话下载链接。

## 文件及路径

- `manifest.json`、`README.md`：原版保留。
- `expressions/neutral.png`、`happy.png`、`confused.png`、`angry.png`、`sleepy.png`、`surprised.png`：6 张完整人物图。
- `mouths/closed.png`、`open_small.png`、`open_big.png`：3 张 neutral 专用嘴型覆盖图。

9 张图均为 1254×1254 RGBA，可解码且带透明像素。manifest 没有 base 字段；neutral 从 expressions.neutral 读取。mouths 键不使用 small/big 别名。motions 是对象而不是字符串数组，当前只描述 idle/bounce 程序动画意图。

## 最小渲染策略

一个角色父容器下放 body sprite 和 mouth sprite；二者 anchor 均为 `(0.5,1)`，完整画布尺寸相同，局部位置相同。先加载 neutral，预加载其它表情，切换 body texture 时同时校验是否需要隐藏 mouth。不要在两个独立动画通道分别修改底图与嘴型的缩放。

表情是互斥整图切换，不做面部叠加或跨整图 alpha 混合。建议先固定画布锚点测试；若发现脚底或脸部跳动，在衍生配准数据中记录偏移，而不是将“同画布”写成“已配准”。只有 neutral 的变换同时作用于嘴型。

运行目录复制为 `apps/web/public/assets/characters/blue_pet/`，保持内部结构。此目录由接手 Agent 创建，启动包中的 assets 是来源。以后如采用衍生素材，原件与派生 manifest 分离且明确应用加载哪一版。

## 视觉检查

检查 250/350/500 CSS 像素人物高度，浅色、深色和棋盘格背景。检查头发和腿侧杂边/孤立像素、六表情脚底/脸部位置、三嘴型是否覆盖原嘴及是否出现肤色矩形、缩放锯齿。当前已检查 PNG 解码；仅对 neutral 与 open_big 作单图目视查看，尚未完成浏览器叠加与全表情配准 QA。

neutral 单图可见部分发丝和人物边缘杂色，需要实际显示尺寸评估。open_big 是带脸部像素的局部覆盖块，不能视为纯嘴唇轮廓。以上不修改素材，也不代表已经修复缺陷。

嘴型 QA 通过后才将应用的 mouthOverlay capability 开启；失败时记录复现背景、尺寸和截图，默认关闭嘴型。仍可交付表情、文本与整体动作演示，但不能将嘴型验收写为通过。

## 未交付能力

没有独立眼层、手臂、头部、呆毛或骨骼，没有 wave/blink 动画序列，也没有独立三视图文件。sleepy 不是可用闭眼差分。不得从文件名推断拥有这些功能。素材用途与商用授权未在输入中给出，文档不另行声明授权结论。
