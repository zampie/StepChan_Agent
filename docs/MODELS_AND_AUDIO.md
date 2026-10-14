# 模型切换与 StepAudio 3 调研

2026-10-13 调研快照。已把项目默认模型切为 `step-3.7-flash`，保留官方 Step 5 Preview 和 OpenRouter 配置的注释。UI 从 `/api/health` 读取实际模型名，不再写死 Step 5。下文语音探测和计划保留为当时记录；**2026-10-14 已完成 TTS / ASR 接入，最新事实见 [语音接入记录](AUDIO_INTEGRATION.md)**。

## 先给结论

当前样本中 Flash 更快、费用更低，token 基本相同。它可以作为日常体验的默认模型，但现有工具循环上的可靠性弱于 Step 5，不能把这次切换称为无损替换。下一步应先处理工具后空回复、工具预算耗尽后的正常收尾，再用更长对话复测。

拟人度方面，StepAudio 3 Realtime 与项目方向最契合；工程上建议先加 StepAudio 3 TTS，再增加按住说话的 ASR 输入，最后实现独立的 Realtime 语音模式。

## 真实模型比较

两模型都经 StepFun 官方 API，保持生产 `runInteraction`、同一角色提示、同一房间工具、`reasoning_effort=low`、`max_tokens=1024`。问候、脸颊触碰、浇水、抽卡、自主探索共 5 类场景，每类各 3 次，两模型共 30 轮。每轮用新会话，串行请求，重复轮次交替模型顺序，无自动重试。

**完整完成情况**：Step 5 为 14/15；Flash 为 10/15。这里的“完成”要求模型正常结束、存在可见回复，并满足场景断言；不是一般知识准确率，也不是仅判断 HTTP 200。

- Flash：3 次工具执行成功后返回空回复；2 次自主探索继续请求工具而触发两次调用上限。
- Step 5：1 次自主探索触发两次调用上限。
- 已完成的浇水、抽卡等动作均保留。未用重试或回退隐藏失败。

为避免把失败的短耗时当作速度优势，下列比较只用**双方均完成的同场景、同重复序号的 9 对样本**。这个子集没有自主探索样本。

- 首个可见文本的中位等待：Step 5 **3.181 秒**，Flash **2.014 秒**，Flash 缩短约 **36.7%**。
- 整轮结束的中位耗时：**3.680 秒 → 2.206 秒**，缩短约 **40.0%**。
- 输入 token 合计：**20,000 → 20,063**；输出 token 合计：**1,666 → 1,683**；总 token：**21,666 → 21,746**，约增加 **0.37%**。本次没有省 token 的证据。
- API 调用次数均为 13；一个用户交互可能经历多次模型调用，不能只统计最终回复。
- 计入实际缓存命中、按下方价格估算这 9 轮：**约 ¥0.0950 → ¥0.0225**，下降约 **76.4%**。若完全按未命中缓存单价做参考估算：¥0.1733 → ¥0.0407。便宜主要来自单价，不能归因于 token 变少。

单价依据：[官方定价](https://platform.stepfun.com/docs/zh/guides/pricing/details)。Flash 输入未缓存/缓存/输出分别为 **1.35 / 0.27 / 8.1 元每百万 token**；Step 5 输入未缓存/输出为 **7 / 20**。本次日期为 10 月 13 日，缓存价按 **0.35** 估算；官方公告 10 月 14 日 00:30 起新适用价 **0.70**，此前已调用用户保留旧价。使用 0.70 重新估算 Step 5 则为约 ¥0.0991。以上均不是账单核验。

完整结果保存在 [逐轮数据](model-benchmark-2026-10-13.json)，可用 `npx tsx scripts/model-benchmark.ts` 复现，会使用 API 额度。默认各模型 15 轮；`BENCH_REPETITIONS` 可调整重复次数。输出写入 `artifacts/model-benchmark.json`。

限制：单机、单账号、单时段的小样本；没有消除网络波动和缓存差异，默认采样策略未固定。失败请求若未正常返回 Provider 结果，其 usage 不完整，未计入费用/token 比较。流式 usage 是累计值，只取每个 API 请求的最后一份，再跨工具回合相加。返回的 `reasoning_tokens` 全为 0，不据此宣称没有推理 token，也不自行推算推理占比。

29 项代码测试通过；当前默认 Flash 的浏览器问候实测成功，模型名显示正确。批量真实模型测试的失败率仍按上述结果保留。

## StepAudio 3 在本项目中的分工

### 1. TTS：最先接入的角色声音

模型 `stepaudio-3-tts`。当前 Flash 继续负责文字、人设和工具，TTS 只把已经生成的回复读出来。支持 `POST /v1/audio/speech`，以及用于持续文本输入的 `wss://api.stepfun.com/v1/realtime/audio?model=stepaudio-3-tts`。后者有自己的 `tts.*` 协议，不能直接复用语音对话的 Realtime 事件。

适合读出聊天回复、点击角色后的短反应、倒计时结束提示。可以先使用已探测成功的官方音色 `livelybreezy-female`，用 `instruction` 设定“年轻明亮、自然亲切、轻快但不夸张”的口吻。不需要先做音色克隆。

重要参数：TTS 3 用 `instruction` 控制风格，**不能传旧模型的 `voice_label`**；文本最多 1000 字符，instruction 最多 500 字符。`()` 中的文字会被当作不发音指令，待朗读文本要规范化；不能直接把任意 Markdown、工具 JSON 或括号原文原样送进去。

价格 **2.5 元/万字符**，100 字约 ¥0.025；1000 条各 50 字的合成约 ¥12.5，仅为字符单价估算。音色克隆另为 9.9 元/音色，本次没有调用克隆。

来源：[模型说明](https://platform.stepfun.com/docs/zh/guides/models/stepaudio-3-tts)、[HTTP 合成](https://platform.stepfun.com/docs/zh/api-reference/audio/create-audio)、[双向流式 TTS](https://platform.stepfun.com/docs/zh/api-reference/audio/ws-audio)。

### 2. ASR：保留现有文字 Agent 的语音输入

模型 `stepaudio-3-asr-max`，音频转文字，当前文档端点为 `POST /v1/audio/asr/sse`。**这是一次提交音频、流式返回文字，不能等同于持续上传麦克风音频的全双工接口。**

适合首版“按住说话、松手发送”：录制短片段，经后端转写，再走已有 `interact({kind:'text',text})`。可加入 Step酱、发现卡、盆栽等热词。该接口支持 wav/ogg/mp3/pcm/m4a，文档没有列出浏览器常见的 WebM；实现时应检查实际录音格式，必要时经 AudioWorklet 生成 PCM 或由后端转换，不能只改文件扩展名。

价格 **2.8 元/小时**。若未来追求低成本的持续转写，可额外比较文档中的 `stepaudio-2.5-asr-stream`（1.2 元/小时、双向流式），不要凭 ASR 3 的名字推断它也支持同一 WebSocket 模式。

来源：[ASR 3](https://platform.stepfun.com/docs/zh/guides/models/stepaudio-3-asr)、[ASR SSE API](https://platform.stepfun.com/docs/zh/api-reference/audio/asr-sse)、[定价](https://platform.stepfun.com/docs/zh/guides/pricing/details)。

### 3. Realtime：自然打断和“她在听”的主要方向

模型 `stepaudio-3-realtime-preview`，连接 `wss://api.stepfun.com/v1/realtime?model=stepaudio-3-realtime-preview`。官方描述包含全双工、语音活动检测、语气理解、话轮协调和自定义工具。

语音模式可让用户直接说“先别讲，让我猜”“把灯关掉”；房间工具仍由本地后端校验和执行。它本身就是对话模型，通常不应每句再调用 Flash 生成另一份回答。文字模式用 Flash，语音模式用 Realtime，两者共享房间、角色约束和必要的对话摘要。

开发重点是播放队列与会话同步：检测用户开始说话时停止本地声音，取消上游回复，丢弃旧音频块，再接新一轮。`response.cancel` 有文档依据；但仅取消生成不会自动清空浏览器已排队音频。

现有“收到多少字”的 `visibleChars` 不等于“实际听到了多少话”。纯语音模式要记录已播放音频/对应文本片段，避免没播放的后半句被记成用户已听到。本次查阅的 StepFun 事件文档未列出可直接照搬的 `conversation.item.truncate`；应先实测取消后的服务端历史行为，再决定使用已记录的短历史重建会话，或用其已支持的 item 管理接口同步。不要先假定与其他厂商的 Realtime 完全兼容。

来源：[Realtime 模型](https://platform.stepfun.com/docs/zh/guides/models/stepaudio-3-realtime)、[事件 API](https://platform.stepfun.com/docs/zh/api-reference/realtime/chat)、[开发指南](https://platform.stepfun.com/docs/zh/guides/developer/realtime)。

### 4. Chat：按轮次理解声音的备选路线

`stepaudio-3-chat-preview` 通过 Chat Completions 接收语音/文本，返回文本，可调用工具。适合希望利用语气线索、但暂时不做长连接的模式。可作为“录一段音频 → Audio 3 Chat 理解并回应 → TTS”方案；它不等同于 ASR，也不是只把文字模型 ID 替换后就得到全双工声音输出。

来源：[Realtime / Chat 的区别](https://platform.stepfun.com/docs/zh/guides/models/stepaudio-3-realtime)。

### 5. Gen：为小房间制作短音效

`stepaudio-3-gen-preview` 的 `/v1/audio/generate` 可生成声音、环境音和组合片段。适合预先制作浇水声、抽卡提示、轻笑等，保存为项目自己的固定素材，在操作成功后立即播放。不要让每次点灯都等待一次实时生成。

文档限制：instruction 和 roles 各最多 500 字符，scripts 最多 1000 字符；支持 HTTP audio/SSE，当前没有 WebSocket 双向流式。

来源：[Gen 模型](https://platform.stepfun.com/docs/zh/guides/models/stepaudio-3-gen)、[语音总览限制](https://platform.stepfun.com/docs/zh/guides/models/audio)。

### 6. Music：环境音乐或探索奖励，优先级较低

`stepaudio-3-music-preview` 的 `/v1/audio/music` 是异步任务，可为房间生成背景音乐，或把“为我创作一小段音乐”做成长期动作。更适合预生成、显式点击播放，角色讲话时降低音乐音量；不适合放到每次聊天的关键响应链路。

来源：[Music 模型](https://platform.stepfun.com/docs/zh/guides/models/stepaudio-3-music)。

Realtime、Chat、Gen、Music 的当前 preview 在官方价目表中为限时免费，之后可能下线并更换付费 ID；没有查到可据此承诺的永久免费方案。[官方定价](https://platform.stepfun.com/docs/zh/guides/pricing/details)

## 本次实际做了哪些音频验证

- `/v1/models` 返回了 Flash 与上述 Audio 3 模型 ID；这只能证明模型列表可见，不能代替每个端点的联调。
- TTS：`stepaudio-3-tts` + `livelybreezy-female` 返回 HTTP 200，生成 6.16 秒、24kHz、单声道 16-bit WAV；完整文件耗时约 **2.80 秒**。这不是首包延迟，也不是 Realtime 延迟。
- 文本为“你好，我是Step酱。要一起抽张发现卡，还是给小盆栽浇点水？”；音频保存在 `artifacts/stepchan-audio3-sample.wav`。
- ASR：提交这段合成 WAV，HTTP 200，约 **0.90 秒**完成转写，文字为“你好，我是 Step 酱，要一起抽张发现卡，还是给小盆栽浇点水？”，提供逐字时间戳。本次没有录制用户麦克风；不是对真人口音、嘈杂环境或回声的测试。
- 没有实际接通 Realtime，没有测试 Gen/Music 生成，也没有把语音功能标为已实现。

## 建议的实施次序

**第一步：读出回复。** 新增服务端 TTS 适配器和浏览器播放队列，按短句合成而非逐 token 发请求。音频块带当前 requestId；新交互同时停止当前播放、清空队列、取消生成。用实际播放音量驱动 neutral 的嘴型，暂停/取消时合嘴，沿用非 neutral 不叠嘴的素材边界。

**第二步：按住说话。** 用户启用后请求麦克风，提供明确录音状态；松手转写并交给现有 Agent。确认稳定后再考虑 VAD 自动分句。当前模型的工具后空回复和预算收尾应在这个阶段之前修复，避免只听到静音。

**第三步：Realtime 语音模式。** 浏览器与 Fastify 建立本地连接，Fastify 持有官方密钥并中转 Realtime。注册同一组房间工具，复用 Zod、调用上限、取消和旧请求过滤；同一会话只保留一个动作执行入口。语音交谈期间暂停独立自主探索调度，避免两条模型链抢着说话或重复操作。

验收重点：说话时打断立即静音；旧音频不复活；已执行动作不重复；麦克风回声不会把自己声音当用户；模型断线后文字按钮仍可用。Gen/Music 作为独立素材与环境增强，放在这条交互主链之后。
