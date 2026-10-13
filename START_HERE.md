# 给 Coding Agent 的启动请求

将下面的请求发送给在本目录工作的 Coding Agent：

---

请基于这个启动包实现 Step酱 AI 桌宠 Web MVP。先读取 AGENTS.md、docs/StepChan_Character_Bible_v1.md、docs/StepChan_Technical_Design_v0_3.md、docs/ASSET_INTEGRATION.md 和 docs/IMPLEMENTATION_AND_ACCEPTANCE.md，并检查真实文件。

以修订版 V0.3 为开发依据，保留 React + TypeScript + Vite + PixiJS 8 与 Node.js + Fastify。按 M1 到 M5 顺序推进；先搭建能运行的前端、真实素材加载、调试页和 Mock 流式对话，再接入服务端模型及两个工具。将所用 Node/依赖版本写进 README 并提交锁文件。

现有素材是 1254×1254 的完整人物表情切换，不是局部表情层；嘴型仅能用于 neutral，需视觉验收。不要用占位人物替换已有立绘，不要假定已有眨眼、挥手、骨骼或独立呆毛素材。界面保持简洁明亮，重点呈现角色与聊天。

落实人设边界：中文自然交流、默认称呼“你”、不伪造任务进展、不擅自保存聊天或偏好、主动闲聊默认关闭。运行时由程序限制工具和动画能力，不能只靠提示词约束。

完成每个阶段后运行相关检查，记录证据和未完成事项，再进入下一阶段。没有真实模型密钥时继续完成可独立验证的部分，明确标记真实 Provider 联调待验证，不冒充通过。最终交付源码、运行命令、配置说明、验证结果和演示步骤。

---

本段授权的是接手后的开发任务；当前启动包本身没有预先执行这些开发工作。
