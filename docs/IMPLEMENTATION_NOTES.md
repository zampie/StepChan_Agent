# Web MVP 实现决策

> 此文件保留初版 M1–M5 交付时的记录。后续新增的小房间、自主探索、服务端会话和打断机制，以 [交互增强记录](INTERACTION_V2.md) 与 README 为准。

2026-10-13。用户授权技术设计可调整，以下记录相对 V0.3 的实际变化。

- 保留 React、TypeScript、Vite、PixiJS 8、Fastify，以及两个 npm workspace；不发布网站，不引入桌面壳。
- 原始 1254×1254 PNG、原 manifest、人设原文保持不变。运行时从 `public/assets/derived/blue_pet_512/manifest.json` 加载 512×512 衍生 PNG。Lanczos3 等比缩放完整透明画布，不裁切、不配准、不改锚点；9 张共 4,855,660 → 1,153,773 bytes，减少约 76.2%。manifest 记录源/派生 SHA-256 和变换。缩图减少下载、纹理内存和图像检查开销，文字模型请求本身不含图片。
- 表情只有一个 body sprite；neutral 嘴型与 body 共用变换容器。截图验收通过后默认开启嘴型，设置中可以关闭。身体是整体微动，不模拟局部关节。页面隐藏时停止 Pixi ticker。
- 使用 OpenRouter `stepfun/step-5-preview`，固定服务地址，不接受客户端自定义地址或模型参数。模型强制推理，实测拒绝 `reasoning.enabled=false`；实际使用 `reasoning.effort=low`，`max_tokens=1024`。达到输出上限会明确标记未完成。
- 采用真实状态驱动动作、最终回复的保守关键词映射（开心/嘿嘿等 → happy+bounce）。不额外调用模型分类情绪，不宣称具备精细情绪识别。表现事件仍经 schema 校验；工具执行与表现分离。
- 请求错误协议简化为 `error.message` 与 `done.status`，不实现旧样例的 code/retryable 字段。运行协议以 `shared/protocol.ts` 为准。
- 聊天历史超过 20 条/16000 字时明确拒绝，单条限 4000 字；不静默裁剪。失败/取消的回复显示未完成，后续上下文不把它当作完整回答。清空与刷新均丢弃会话。
- 工具调用最多 4 次；重复 toolCallId 停止本轮，ToolRunner 本身也缓存已执行结果。工具没有网络抓取或长任务，时间与 URL 校验同步完成。整个模型/工具回合共享 60 秒截止时间。
- 主动闲聊、长期记忆、音频、提醒、系统级桌宠、其他窗口访问暂不实现。设置明确说明主动闲聊关闭。保留页面内拖动与折叠聊天。
- 开发绑定 127.0.0.1，校验 Host 与 Origin，最多同时 2 个请求；这是本机应用，不提供公网部署配置。
- 不使用第三方字体或分析服务。未配置密钥时默认 Mock；配置后页面默认真实模型，用户仍可随时选择演示模式。

原启动包的 `DELIVERY_MANIFEST.json` 保留作历史快照；README、AGENTS 与能力契约已更新，故旧 `verify_bundle.py` 会报告这些预期差异。当前素材校验使用 `npm run validate-assets`。
