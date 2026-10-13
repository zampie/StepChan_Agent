# Step酱 Web MVP

本地运行的 AI 探索伙伴：真实立绘、流式聊天、页面内拖动、表情和嘴型，以及时间查询、网页链接卡片。React + TypeScript + Vite + PixiJS 8；Node.js + Fastify。

## 立即运行

已验证 Node.js **24.21.0**、npm **11.12.1**（要求 Node >=22.12）。在项目根目录执行：

```powershell
npm.cmd ci
npm.cmd run dev
```

打开 http://127.0.0.1:5173 ，角色实验室在 http://127.0.0.1:5173/debug/pet 。后端地址为 http://127.0.0.1:3001 。所有服务只绑定本机。

- 没有密钥时，演示模式也能独立工作；回复是明确标识的预设内容，两个工具仍执行真实的时间/链接校验。
- 本次已将提供的密钥写入根目录 `.env`（已被 `.gitignore` 排除）。它仅由后端读取，前端不接触凭据。页面检测到服务端配置后默认真实模型。
- 新环境先复制 `.env.example` 为 `.env`，填写 `OPENROUTER_API_KEY`；修改后重启开发服务。不要使用 `VITE_` 前缀。旧 `config/server.env.example` 是启动包历史模板，当前不加载它。
- 实际 Provider：OpenRouter `stepfun/step-5-preview`，`MAX_TOKENS=1024`，低推理预算；模型不允许彻底关闭推理。

生产模式（单个本地端口）：

```powershell
npm.cmd run build
npm.cmd start
```

打开 http://127.0.0.1:3001 。构建产物仍需要仓库里的 `prompts/` 和根目录 `.env`，不要单独搬走服务端 JS。停止运行使用终端 Ctrl+C。

## 使用

输入后 Enter 发送，Shift+Enter 换行。生成过程中点击停止；失败可重试，已有部分文字会标明未完成。顶部选择演示或真实模型。垃圾桶清空当前会话，侧栏按钮可收起聊天。

可以拖动角色改变页面内位置，舞台右上角重置位置。设置支持减少动态效果和关闭嘴型。没有主动闲聊、聊天保存、其他窗口读取或系统悬浮；刷新页面即丢弃会话。模型不读取网页，不创建提醒。

试试「现在几点了？」或「为 https://example.com 准备链接」。链接只会在你点击后打开，界面显示目标地址。模型文本使用禁用原始 HTML 的 Markdown 渲染，链接再次校验 HTTPS。

## 验证与演示

```powershell
npm.cmd run validate-assets
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
# 开发服务运行时，使用本机 Edge 做浏览器测试
node scripts/browser-qa.mjs
node scripts/markdown-qa.mjs
# 会使用真实 API 额度：两轮上下文 + 两个工具
node scripts/live-smoke.mjs
# 已构建时，独立启动临时生产服务并验证（也调用一次真实模型）
node scripts/production-check.mjs
```

演示顺序：实验室切换六表情、四个动作和嘴型 → 演示模式聊天 → 生成中停止并再发 → error / disconnect / slow 故障场景 → 查询时间 → 准备链接 → 清空 → 真实模式自由聊天。实验室按钮不调用模型，故障场景按钮仅在演示模式可用。

运行结果与实际限制见 [验证记录](docs/VALIDATION.md)，相对设计的调整见 [实现决策](docs/IMPLEMENTATION_NOTES.md)。截图与本次真实调用结果保存在被 Git 忽略的 `artifacts/`；测试脚本可以重新生成证据。

## 代码地图

- `apps/web/src/App.tsx`：聊天、设置、工具卡片和实验室。
- `apps/web/src/pet/`：Pixi 渲染器、状态控制器、生命周期和拖动。
- `apps/web/src/agent/AgentClient.ts`：POST SSE、取消、截止时间、旧请求过滤。
- `apps/server/src/`：Fastify 路由、Mock/OpenRouter、工具校验、有限回合运行时。
- `shared/`：Zod 请求/事件协议与 UTF-8 SSE 解析。
- `tests/`：协议、异常、工具、控制器、Provider 适配和 HTTP 测试。
- `scripts/prepare-assets.mjs`：保留原图的 512px 派生流程；安装时自动生成。
- `docs/StepChan_Character_Bible_v1.md`：保留的人设原文。

主要锁定版本：React 19.3.0、Vite 7.3.7、TypeScript 5.9.3、PixiJS 8.22.0、Fastify 5.12.5、Zod 4.6.7、Sharp 0.35.5。完整精确版本以 `package-lock.json` 为准。

## 素材与范围

原件位于 `assets/blue_pet_assets_v0_2/`，1254×1254，未经修改。运行版为完整透明画布 512×512，9 张 PNG 共约 1.15 MB，比原图小 76.2%。派生 manifest 记录缩放和 SHA-256；没有裁图或虚构的配准修复。

六张全身表情互斥切换。嘴型只叠在 neutral 上，已检查 250/350/500px 与浅色/深色/棋盘格背景。其它表情停嘴，取消/错误/600ms 文本停顿也停嘴。无眨眼、挥手、独立头部或呆毛动画素材。

`START_HERE.md`、技术设计、原验收清单和 `sources/` 保留为设计来源；当前事实以本 README 与验证记录为准。`DELIVERY_MANIFEST.json` 是启动包历史快照，不是当前应用清单。
