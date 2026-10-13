# 阶跃娘桌宠素材 v0.2

包含原有 6 张完整人物表情 PNG 和新增 3 张嘴型透明覆盖图，及 manifest.json。

## 重要
- 嘴型覆盖层只以 `expressions/neutral.png` 为基准定位。使用时先画 neutral，再叠加任一 mouths 图片，所有图片坐标相同。
- happy/angry 等仍以整张立绘互斥切换，不应直接叠加当前嘴型：其他整身差分尚未进行脸部配准。
- 嘴型是 MVP 简化示意，非自然语言精确音素口型。
- 眨眼和挥手图层仍未制作；`idle`、`bounce` 可以通过整张 PNG 的 transform 实现。
- 建议 Coding Agent 在浅色/深色背景及缩小到实际桌宠尺寸后进行 QA。
