# Step酱 Web MVP

本地运行的 AI 探索伙伴：真实立绘、流式聊天、可点击的小房间、部位触碰、常驻交互建议、可打断对话、自主探索与语音输入/朗读。React + TypeScript + Vite + PixiJS 8；Node.js + Fastify。

**当前进度（2026-10-14）：** 见 [PROGRESS.md](PROGRESS.md)，包含已实现范围、验证证据、已知限制和下一步。

## 立即运行

已验证 Node.js **24.21.0**、npm **11.12.1**（要求 Node >=22.12）。在项目根目录执行：

```powershell
npm.cmd ci
npm.cmd run dev
```

打开 http://127.0.0.1:5173 ，角色实验室在 http://127.0.0.1:5173/debug/pet 。后端地址为 http://127.0.0.1:3001 。所有服务只绑定本机。

- 没有密钥时，演示模式也能独立工作；回复是明确标识的预设内容，房间工具、时间查询和链接校验仍执行真实逻辑。
- 本次已将提供的密钥写入根目录 `.env`（已被 `.gitignore` 排除）。它仅由后端读取，前端不接触凭据。页面检测到服务端配置后默认真实模型。
- 新环境先复制 `.env.example` 为 `.env`，填写 `STEPFUN_API_KEY`；修改后重启开发服务。不要使用 `VITE_` 前缀。旧 `config/server.env.example` 是启动包历史模板，当前不加载它。
- 当前 Provider：StepFun 官方 `https://api.stepfun.com/v1`，默认模型为 `step-3.7-flash`；`.env` 中注释保留 `step-5-preview` 以便切回。`MAX_TOKENS=1024`，`reasoning_effort=low`。
- 原 OpenRouter 配置在 `.env` 中注释保留。切换时只启用一个 `LLM_PROVIDER`：`stepfun` 或 `openrouter`，并取消相应密钥和模型配置的注释，然后重启服务。两种接口使用各自的密钥，不自动跨服务回退。

生产模式（单个本地端口）：

```powershell
npm.cmd run build
npm.cmd start
```

打开 http://127.0.0.1:3001 。构建产物仍需要仓库里的 `prompts/` 和根目录 `.env`，不要单独搬走服务端 JS。停止运行使用终端 Ctrl+C。

## 使用

输入后 Enter 发送，Shift+Enter 换行。生成过程中可以直接发送新消息或点击建议，立即打断旧回复；也可以单独点击停止。已收到的部分文字和已执行的工具保留在后续上下文中，不回滚浇水等动作。失败后重试是继续解释，不重新执行上一次点击。顶部选择演示或真实模型。垃圾桶清空聊天和房间，侧栏按钮可收起聊天。

可以拖动角色改变页面内位置，舞台右上角重置位置。轻点头顶、脸颊、徽章或手会收到不同回应，透明区域不会误触。设置支持减少动态效果和关闭嘴型。

房间里的台灯、盆栽、发现卡和沙漏都可以点击，模型也可通过受限工具操作它们。发现卡支持猜答案；输入框上方始终有无需打字的建议。开启「自主探索」后，Step酱会在空闲时自己选小目标，每次最多 6 步；输入、生成中和后台页面暂停新一轮调度。默认关闭，可随时停下。

聊天和房间仅保留在浏览器及服务端内存中；刷新建立新会话，关闭/清空时请求删除，失联会话闲置一小时后由后续请求清理。没有长期记忆、其他窗口读取或系统悬浮。沙漏是页面内倒计时，页面关闭后不会发系统提醒。

开发模式修改服务端文件会触发重启，旧内存会话随之丢失。前端收到 HTTP 410 后会自动新建会话、重置房间和上下文，并至多继续一次当前输入；旧卡片答案和倒计时事件不会重放。页面会提示重连，不需要手动点击清空。普通断流不会自动重发，避免重复执行工具。

## 语音

真实模式的输入区提供「声音开/关」「按住说话」「试听」。默认关闭自动朗读；点击声音开关后，新回复按短句生成并播放。按住说话（或聚焦后按住空格/Enter）时才申请麦克风；松开后转写到输入框，可修改后发送。录音最多 30 秒，Escape 取消。首次允许麦克风后若已松开，重新按住录音即可。

TTS 使用 `stepaudio-3-tts`，默认音色 `livelybreezy-female`（活力轻快），保留自然亲近的底音，微调为清脆、轻盈、有童真的聊天语气，音调略高、停顿自然、不拉长尾音。服务端 `.env` 可用 `STEPFUN_TTS_VOICE` 换底音；不需要克隆音色。ASR 使用 `stepaudio-3-asr-max`，对话与工具仍由 `step-3.7-flash` 负责。二者使用已有的服务端 `STEPFUN_API_KEY`。

新交互、录音、停止、清空和切换模式会取消语音请求并清空播放队列。识别过程中输入新草稿会丢弃迟到的转写。实际播放音量只驱动 neutral 表情的嘴型。录音与合成音频在内存中处理，不由应用写入文件；录音会经后端提交 StepFun 识别。演示模式禁用语音服务，不消耗语音额度。

当前采用按句 HTTP TTS 与按住说话 ASR，不是连续全双工 Realtime；合成句子之间可能有等待。桌面 Edge 已验证，真机触屏/真人录音质量仍待体验。详见 [语音接入记录](docs/AUDIO_INTEGRATION.md)。

试试「现在几点了？」或「为 https://example.com 准备链接」。链接只会在你点击后打开，界面显示目标地址。模型文本使用禁用原始 HTML 的 Markdown 渲染，链接再次校验 HTTPS。

模型速度、token 与费用的实测对比，以及 StepAudio 3 接入建议，见 [模型与语音调研](docs/MODELS_AND_AUDIO.md)。Flash 在当前样本中更快、更便宜，但工具后空回复与自主工具超限更多；没有宣称是等价替换。

## 验证与演示

```powershell
npm.cmd run validate-assets
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
# 开发服务运行时，使用本机 Edge 做浏览器测试
node scripts/browser-qa.mjs
node scripts/markdown-qa.mjs
node scripts/interaction-qa.mjs
node scripts/audio-qa.mjs
node scripts/session-recovery-qa.mjs
# 会使用真实 TTS / ASR 额度，生成新的试听文件及合成麦克风测试样本
npx.cmd tsx scripts/audio-live.ts
# 先运行 audio-live；用生成样本模拟浏览器麦克风，并调用真实 ASR / Flash / TTS
node scripts/audio-browser-live.mjs
# 会使用真实 API 额度：房间工具、打断与上下文、自主观察
node scripts/interaction-live.mjs
# 两个模型各 15 个回合，使用实际 API 额度
npx.cmd tsx scripts/model-benchmark.ts
# 初版兼容端点的检查仍保留
node scripts/live-smoke.mjs
# 已构建时，独立启动临时生产服务并验证（也调用一次真实模型）
node scripts/production-check.mjs
```

推荐演示：切到演示模式 → 关灯/浇水 → 她说到一半时点「简短一点」 → 抽发现卡并猜答案 → 点点角色的四个部位 → 试试 10 秒沙漏 → 清空后开启自主探索，观察她自行浇水 → 切回真实模型自由交流。实验室按钮不调用模型，故障场景按钮仅在演示模式可用。

本次交互迭代的运行结果、调度规则和实现说明见 [交互增强记录](docs/INTERACTION_V2.md)。初版结果保留在 [验证记录](docs/VALIDATION.md)，初版设计调整见 [实现决策](docs/IMPLEMENTATION_NOTES.md)。截图与本次真实调用结果保存在被 Git 忽略的 `artifacts/`；测试脚本可以重新生成证据。

## 代码地图

- `apps/web/src/App.tsx`：聊天、设置、工具卡片和实验室。
- `apps/web/src/pet/`：Pixi 渲染器、状态控制器、生命周期和拖动。
- `apps/web/src/agent/`：POST SSE、内存会话、取消、截止时间、旧请求过滤。
- `apps/web/src/room/`：可点击物件、发现卡、常驻建议。
- `apps/web/src/audio/` / `apps/web/public/audio-recorder.js`：短句播放、音量嘴型、按住录音、识别取消。
- `apps/server/src/audioRoutes.ts`：服务端 TTS / ASR 接口、固定音色指令、WAV 校验和超时。
- `apps/server/src/sessions.ts` / `interactionRuntime.ts`：服务端上下文、打断记录与受限工具循环。
- `shared/room.ts`：结构化交互事件、房间状态与建议规则。
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
