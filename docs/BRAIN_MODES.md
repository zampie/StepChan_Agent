# 大脑模式：realtime / chat / 混合

2026-10-14 记录，2026-10-15 补上按住说话的语音输入。本文里所有延迟数字都是**在这台
机器上实测的**（`scripts/chat-probe.ts`、`scripts/asr-probe.ts`、
`scripts/realtime-probe.mjs` 以及一次性探测脚本），不是文档估算，也不是推算。
样本量很小（每个场景 1~3 次），网络抖动没有消除 —— 看量级，不要当基准。

## 为什么会有第二个模式

realtime（`stepaudio-3-realtime-preview`）的问题不是慢，是**不可靠**：它会声称做了某件事
却不发 function call。实测两次，文字和语音输入都复现：

- 文字「挪到右下角去吧」→ 正常发了 `move_to`。
- 语音「你能不能挪到屏幕右下角去，别挡着我了」→ 只说了「好的，我这就挪到右下角去」，
  **没有发任何 function call**。

现在靠 `persona.textNeedsTool()` 的关键词兜底 + `tool_choice:'required'` 补一刀。
那是补丁，不是解决。chat 模式（`step-5-preview` / `step-3.7-flash` 走
`/v1/chat/completions`）在同样的提示和同样的工具定义下，**三个场景三次都正确发了
function call**，包括隐私开关关着时也先调工具、拿到拒绝消息再转达给用户。

代价是延迟，下面有账。

## 两个模式的结构差别

|                | realtime（默认）                  | chat（智能模式）                    |
| -------------- | --------------------------------- | ----------------------------------- |
| 传输           | WebSocket 全双工                  | HTTP SSE，一问一答                  |
| 上下文权威     | **服务端**（只能 append，读不到） | **客户端**（`ChatSession.history`） |
| 音频输出       | 模型直接出 PCM16                  | 我们自己按句调 `/v1/audio/speech`   |
| 语音输入       | 服务端 VAD + ASR                  | **只有按住说话**（一次性 ASR）      |
| 会话上限       | 30 分钟，到点要静默重建           | 没有                                |
| 换音色         | 首次出音后不可改 → 必须重建会话   | 每次合成请求的参数，随时改          |
| 改 system 提示 | `session.update` 推过去           | 每轮重新生成，下一句自动生效        |
| 工具可靠性     | 弱（见上）                        | 实测可靠                            |
| 首音延迟       | **235ms**（语音说完 → 首帧音频）  | **5.8~15.5s**（打字；语音再 +0.6s） |

公开 API 是同一套（`PetBrain`，见 `apps/web/src/brain/chat/factory.ts`）。
两条 `AssertAssignable` 编译期断言保证 `Brain` 和 `ChatBrain` 不会悄悄漂开。

## 延迟账（实测）

### chat 模式的分段

`npx tsx scripts/chat-probe.ts <model>`，真工具、真视觉模型、真 TTS。
「首段音频可播」= 第一段 PCM 真的进了播放环的时刻，也就是用户能听到的第一声。

| 模型           | 场景                     | 首工具调用 | 工具执行完 | 首正文 token | **首段音频可播** | 文本说完 |
| -------------- | ------------------------ | ---------: | ---------: | -----------: | ---------------: | -------: |
| step-5-preview | 问时间                   |     1102ms |     1104ms |       6544ms |      **10000ms** |   6546ms |
| step-5-preview | 看屏幕（开关关着）       |     2680ms |     2681ms |       3309ms |       **5919ms** |   3838ms |
| step-5-preview | 看屏幕（真视觉模型）     |     1869ms |     7814ms |      10679ms |      **15483ms** |  11468ms |
| step-3.7-flash | 问时间                   |      993ms |      994ms |       1988ms |       **5785ms** |   1989ms |
| step-3.7-flash | 问时间（复测）           |     1174ms |          — |       2393ms |       **5975ms** |   2396ms |
| step-3.7-flash | 看屏幕（开关关着）       |     1528ms |     1529ms |       2429ms |       **5866ms** |   2576ms |
| step-3.7-flash | 看屏幕（开关关着，复测） |     1195ms |          — |       2129ms |       **5765ms** |   2418ms |
| step-3.7-flash | 看屏幕（真视觉模型）     |      930ms |     2511ms |       4221ms |       **8520ms** |   4349ms |
| step-3.7-flash | 看屏幕（真视觉，复测）   |     1296ms |          — |       6479ms |      **10253ms** |   6899ms |

结论：

1. **首音延迟是 realtime 的 25~65 倍。** 235ms vs 5.8s（flash 最好情况）到 15.5s
   （step-5 + 视觉 + 它又顺手调了个 `express`）。
2. **flash 明显更快，而且工具调用一样可靠**（这次 6 个场景 6 次都正确调了）。
   step-5-preview 在工具结果回灌之后那一轮特别慢 —— 实测它的 HTTP 响应头本身就要
   5028ms（见下），不是我们这边的处理时间。
3. **延迟的大头有两块**，必须分开看：模型出首句（1.9~10.7s）和 TTS 合成首段（3.3~3.8s）。

### 语音输入（按住说话）：ASR 是整条链里最便宜的一段

`npx tsx scripts/asr-probe.ts`，走的是生产代码的编码路径（`PushToTalkRecorder` →
`wav.encodeWav` → `asr.transcribePcm16`），音频用 macOS `say -v Tingting` 合成后
`ffmpeg` 转 24k 单声道 PCM16 —— 也就是 `MicStream` 的 worklet 吐出来的那个格式。
2026-10-15 实测，`stepaudio-3-asr-max`：

| 音频时长        |   松手 → 拿到文本 | 转写结果                                                           |
| --------------- | ----------------: | ------------------------------------------------------------------ |
| 5.64s（一长句） | 683 / 561 / 690ms | 「Step酱，帮我把你挪到屏幕右下角去，别挡着我写东西。」**逐字正确** |
| 2.08s           |       476 / 381ms | 「你好呀，现在几点了？」                                           |
| 1.13s（一短句） |       383 / 380ms | 「现在几点了？」（原句没有问号，它自己补的标点）                   |
| 0.20s（5 帧）   |       245 / 167ms | 空字符串                                                           |
| 0.04s（1 帧）   |             210ms | 空字符串                                                           |
| 0 字节          |             123ms | 空字符串                                                           |

要点：

- **「Step酱」不靠热词也能转对**，这一点和原来的假设相反。同一段音频跑 6 次：
  带热词和不带热词都认出了这个词，差别只在分词 —— 带我们那份 4 词热词表时偶尔
  输出「Step 酱」（中间一个空格），不带时稳定是「Step酱」；换成单词热词表又没空格了。
  也就是说这是分词抖动，不是热词的功劳。`ASR_HOTWORDS` 还是留着（它免费，对别的
  专有名词可能有用，而且请求里带上这个字段本身也被验证过能通），但**不要**以为
  去掉它名字就会转错。空格对下游无影响（文本进的是模型），只在气泡里能看出来。
- **固定开销约 150~200ms，之后大约 0.09× 实时**（5.64s 音频只要 0.6s）。所以语音输入
  在延迟账上几乎不占位置 —— 瓶颈仍然是模型出首句和 TTS。
- **过短/空音频不会报错，只会回空文本。** 这和 realtime 侧不一样：那边在空缓冲区上
  `input_audio_buffer.commit` 会回两个 error（见 `voice/RealtimeSession.ts`）。
  所以 `MIN_PUSH_TO_TALK_FRAMES`（4 帧 / 160ms）这条下限在 chat 侧**不是**为了躲
  服务端错误，而是为了让误触彻底无声：不发请求、不花钱、也不弹「没听清」。
- 空文本和「流断在 `transcript.text.done` 之前」必须分开处理：前者是「说得太轻」
  （notice，提示再说一次），后者是真故障（error）。

### 整条链的延迟账：语音输入贵在后面

按住说话 = ASR + 打字那条链。拿上面的分段拼起来（flash，问时间）：

| 阶段                          |         耗时 | 依据                  |
| ----------------------------- | -----------: | --------------------- |
| 松手 → 转写文本到手           |     0.4~0.7s | 本节实测              |
| → 首个 tool_call              |     1.0~1.2s | 上面 chat 分段表      |
| → 首正文 token                |     2.0~2.4s | 同上                  |
| **→ 听到她的第一声**          | **6.2~6.7s** | 5.8~6.0s 的首音 + ASR |
| step-5-preview + 视觉的坏情况 |     **~16s** | 15.5s + ASR           |

对比 realtime 的 235ms：**语音输入在 chat 模式下是 26~68 倍的延迟**，而 ASR 只占
其中 10% 左右。换句话说，接上语音输入**没有让这个模式明显变慢**，它本来就慢；
想压延迟得去压模型首句和 TTS（流式 TTS 那一节）。

这是用户要付的代价，也是为什么默认模式仍然是 realtime。

### TTS 是第二个瓶颈，而且它不渐进出流

`POST /v1/audio/speech`，`response_format: wav`，`sample_rate: 24000`：

| 文本长度 | 响应头到达 | 完整下载 | 音频时长 |
| -------- | ---------: | -------: | -------: |
| 8 字     |     1994ms |   2021ms |    2.64s |
| 19 字    |     2721ms |   2770ms |    4.48s |
| 68 字    |     3823ms |   3923ms |   11.20s |

**响应头和完整下载只差 27~100ms** —— 服务端是整段合成完才开始回，不是边合成边出。
所以「等她说完再合成」= 两段耗时串联，这也是 `SentenceBuffer` 存在的全部理由：
第一个短句一凑齐就送去合成。首段上限压到 24 字（`FIRST_SEGMENT_MAX`），再往下压收益
有限 —— 合成本身有 1.3~2.0s 的地板。

其他实测：

- `response_format: 'pcm'` 可用，返回裸 PCM16 无头（省掉剥壳），8 字 1479ms。
  `mp3` 1776ms，`opus` 2402ms。我们仍然用 `wav`，因为它自描述，能**验证**
  确实是 pcm16/24k/单声道而不是假设 —— 采样率不一致的后果是音调不对，这种 bug 很难查。
- **realtime 的音色 id 可以直接喂给 TTS**：`yuanqishaonv` / `jilingshaonv` /
  `ruanmengnvsheng` / `linjiameimei` / `livelybreezy-female` 全部 200，不需要音色映射表。
- **WAV 的 data 块不在偏移 44。** StepFun 在 fmt 之后插了一个 26 字节 LIST 块，
  实际布局是 `fmt @12:16  LIST@36:26  data@70`，PCM 从偏移 78 开始。按「跳 44 字节」
  会把 34 字节块头当成样本（开头一声爆音 + 之后全部错位成白噪声）。`wav.ts` 走的是
  RIFF 块链，`tests/chat.test.ts` 里有针对这个形状的用例。

### 流式 TTS 存在，而且快得多（未完整验证）

`wss://api.stepfun.com/v1/realtime/audio?model=stepaudio-3-tts`，鉴权沿用 realtime 的
subprotocol 方式。实测一次成功：

```
 130ms  连上
 130ms  ← tts.connection.done { session_id }
 144ms  ← tts.response.created        （发了 tts.create 之后）
 292ms  ← tts.response.sentence.start （发了 tts.text.delta / tts.text.done 之后）
 477ms  ← tts.response.audio.delta    ★ 首帧音频
        ← audio.delta ×14, sentence.end, audio.done
8371ms  连接以 1006 断开
```

协议要点（踩了三次才通，记下来省下次的时间）：

- **每个客户端事件的负载都要包在 `data` 里**，并且 `data.session_id` 必须回带服务端在
  `tts.connection.done` 里给的那个值。不带 → `400 session_id is invalid`。
- `tts.create` 的字段是 **`voice_id`**，不是 HTTP 接口的 `voice`。
  不带 → `400 voice_id is required`。
- 必须先 `tts.create` 再送文本，否则
  `400 The 'tts.create' event must be sent before sending this event.`

**首帧 477ms vs HTTP 的 2000ms+**，这是 chat 模式延迟账上最大的一块可压缩空间。
但**没有验证**：取消语义（说到一半打断怎么废掉在途合成）、多句连续送入、长连接稳定性
（这次 8.4s 就被 1006 断了，原因不明）都没测。所以这一版仍然走 HTTP，流式 TTS 作为
下一步的候选。

### 其他实测细节

- `reasoning_effort` 对延迟的影响在这个样本量下被噪声淹没：step-5-preview 默认
  / `low` / `minimal` 三档，闲聊轮首正文 1675 / 3556 / 2455ms，工具轮首调用
  2350 / 1029 / 1617ms。没有一致的方向，所以代码里**不传**这个参数。
- `step-5-preview` 和 `step-3.7-flash` 在当前 key 的 `/v1/models` 里都在，
  chat 补全都能真的调通（56 个模型里还有 `step-3.5-flash` / `step-3.5-flash-2603`）。
- SSE 流以 `data: [DONE]` 结束，`[DONE]` 之前还有一帧 `choices: []`（只带 usage）。
- `tool_calls` 增量里**第一条之后的 `id` / `type` / `function.name` 都是空字符串占位**。
  无条件覆盖会把工具名清空，回灌时 400。
- Node 26 的坑：`for await` 里 `break` 出 SSE 生成器时，在 `finally` 里
  `await reader.cancel()` **不会 settle**（整个进程挂住，报 unsettled top-level await）。
  只能 fire-and-forget，要提前终止请用 `AbortSignal`。

## 混合模式：realtime 听/说 + chat 决策

### 上下文权威归谁

这是整个问题的核心，不是实现细节。

realtime 的对话状态在**服务端**：我们只能 `conversation.item.create` 往里追加，
读不回来。客户端手里的 `transcript` 是**投影**（ASR 转写 + 她自己的
`response.audio_transcript`），不等于服务端认为的那段对话。chat 的状态在**客户端**，
是完整的 `messages` 数组。

两边同时「记得」同一段对话，就必然漂。所以混合模式只有两种诚实的切法：

**切法 A：把 realtime 降级成 ASR + TTS，chat 当唯一大脑。**
不用 realtime 对话，改用 `/v1/audio/asr/sse`（按住说话）或 `stepaudio-2.5-asr-stream`
（双向流式，1.2 元/小时）做输入，chat 做决策，流式 TTS 出音。
**输入侧已经是这样了**（chat 模式的按住说话，见上），所以切法 A 剩下的只有
「持续聆听的断句」和「流式 TTS」两块。
权威只有一个，没有双写问题，顺带消掉两个 realtime 的硬约束：30 分钟墙没了，
音色锁定没了（音色变成每次合成的参数）。
代价：丢掉服务端 VAD 带来的全双工 barge-in，以及 235ms 的首音。要重写整条语音链。

**切法 B：realtime 照常对话，chat 只在「这句话需要工具」时介入。**
这是我推荐的那条。细节见下。

**不要做的版本**：让 chat 全权决策、realtime 只负责把 chat 的输出念出来。
那等于把一个全双工语音模型当 TTS 用，付两份钱，还要自己处理两边上下文对齐 ——
那就是切法 A 的劣化版，不如直接做 A。

### 实测约束对混合架构的影响

1. **单会话 30 分钟上限。** 现在重建时只带 `summarizeTranscript()` 的「最近 6 条原话」。
   混合模式下 chat 侧有完整 `messages`，重建时可以灌一段真正的摘要进去。
   所以这条约束在混合模式下是**被改善的**，不是新负担。
2. **首次出音后音色不可改。** 切法 B 下 realtime 仍然负责出音，换音色仍要重建会话 ——
   这条约束**不变**。只有切法 A 能消掉它。
3. **用户转写 delta 是累计全量文本，不是增量。** 对架构没有新约束，但有一个具体的坑：
   喂给 chat 的用户输入必须取
   `conversation.item.input_audio_transcription.completed` 的 `transcript`，
   **不能累加 delta** —— 累加会得到「你好呀你好呀我你好呀我今天…」，chat 看到的就是
   一句话重复了十几遍。
4. **realtime 接受 `role:'system'` 的 message item。** 这一条是已验证的（现在的
   `nudgeToolCall()` 就在用），而它正好是混合模式唯一的回灌通道 —— 见下。

### 接口形状

chat 侧不应该暴露成「另一个会话」，而应该暴露成**一个只做决策的工具大脑**：

```ts
/** 工具大脑：只回答「这句话该调什么工具」，不负责说话。 */
export type ToolBrain = {
  decide(input: {
    /** 用户这一句的最终转写。必须是 completed 事件的 transcript，不是累加的 delta。 */
    utterance: string;
    /** 语音侧的对话投影，用来对齐上下文。权威仍在 ToolBrain 手里。 */
    recent: readonly { role: 'user' | 'pet'; text: string }[];
    signal: AbortSignal;
  }): Promise<ToolBriefing>;

  /** 语音侧实际说了什么，回灌进来，免得两边上下文漂。 */
  observe(said: string): void;

  reset(): void;
};

export type ToolBriefing = {
  /** 执行过的工具及结果，按顺序。空数组 = 判定为不需要工具。 */
  calls: { name: ToolName; result: ToolResult }[];
  /**
   * 给语音侧的事实交代。注意这是「她该据此说话的事实」，不是「她该念的原句」——
   * 让 realtime 用自己的语气讲，才不会听出两个大脑的接缝。
   */
  briefing: string;
};
```

两个关键设计点，都不是显然的：

- **`briefing` 必须灌成 `role:'system'` 的 message item，不能灌成
  `function_call_output`。** 因为这些工具调用是 chat 发起的，realtime 侧没有对应的
  `call_id`，伪造一个就是协议错误。好在 system message 这条路已经验证过能用。
- **`observe(said)` 不能省。** 没有它，chat 不知道 realtime 已经把结论说出去了，
  下一轮会重复一遍。这是双写上下文唯一的收口。

`ChatSession` 现在的结构正好能切出 `ToolBrain`：把 `runTurn` 里「出文本 + 送 TTS」
那一段换成「只收集 tool 调用、最后一轮用 `tool_choice` 撤掉 tools 要一段
briefing」，剩下的 messages 管理、工具预算、幂等、历史裁剪全部复用。
估算改动量：`ChatSession` 加一个模式分支，不需要新文件。

### 混合模式的延迟账（按实测分段推算）

切法 B，用户说完一句需要工具的话：

| 阶段                            | 实测依据                                  |         耗时 |
| ------------------------------- | ----------------------------------------- | -----------: |
| realtime 开场（「我看一下」）   | 实测 235ms                                |        235ms |
| 并行：chat 决策出 tool_call     | flash 实测 930~1528ms                     |     0.9~1.5s |
| 并行：工具执行                  | `get_time` ~1ms；`glance_screen` 1.5~1.9s |       0~1.9s |
| briefing 灌回 + realtime 再开口 | 同 realtime 首音 235ms                    |        235ms |
| **用户听到结论**                |                                           | **1.4~3.9s** |

对比：

- 纯 realtime：首声 235ms，但工具**可能根本没调**（这就是要解决的问题）。
- 纯 chat（本次实现）：首声 5.8~15.5s。
- 混合（切法 B）：首声仍是 235ms，结论 1.4~3.9s。

这个账是**推算**，分段都是实测的，但没有真的把两条链接起来跑过。
最大的不确定性是「realtime 会不会乖乖等 briefing」：它是全双工的，
收到 `speech_stopped` 就自己生成回复了。要让它只说开场白然后等，得靠
instructions 约束它 —— 而「realtime 不听 instructions」正是我们在躲的那个问题。
这是混合模式最可能翻车的地方，必须先单独验证。

## 推荐

**有条件地做，按这个顺序：**

1. **先把 chat 当独立模式交付**（本次已完成）。它的价值不在延迟，在于
   ① 工具可靠性有了一条验证过的路径；② 它是混合模式的工具大脑的现成实现；
   ③ 用它把「主动用工具」的提示词调出来（`chat/persona.ts` 的 `CHAT_MODE` 那段）。
   默认仍然是 realtime，chat 作为可选模式。
2. **混合模式之前，先单独验证一个问题**：realtime 能不能被可靠地按住
   （「说一句开场白，然后等我灌 system message 再继续」）。这一个点不成立，
   整个切法 B 就不成立，不要先写代码。`scripts/realtime-probe.mjs` 加一个场景就能测。
3. **混合模式只做窄版**：仅在 `textNeedsTool()` 命中、或 realtime 该调工具却没调时，
   才让 chat 介入。不要让 chat 参与闲聊 —— 闲聊是 realtime 唯一的绝对优势，
   而且每轮都过一遍 chat 等于成本翻倍（chat 每轮重付全量输入 token）。
4. **切法 A 暂时不做。** 它更干净，但要重写整条语音链，而且前提是流式 TTS
   的取消语义和长连接稳定性能站住 —— 目前只验证了「首帧 477ms」这一个点。

**明确不推荐**：把 chat 设为默认模式。首音 5.8 秒以上，桌宠就不是桌宠了，
是一个会说话的命令行工具。

## chat 模式这一版没做 / 没验证的

- **只做了按住说话，没有持续聆听。** 按住说话走 `/v1/audio/asr/sse`（2.8 元/小时，
  一次提交一段，实测见上）：`MicStream` 的 PCM16 帧攒成 WAV 提交，转写结果直接喂
  `ChatBrain.sendText()`，整条对话链不用动（见 `chat/listen.ts` + `chat/asr.ts`）。
  持续聆听要自己做 VAD 才能断句，或者换成 `stepaudio-2.5-asr-stream`（双向流式，
  1.2 元/小时）—— 这一版不做，`enableMic()` 会如实告知「只能长按说」。
- **麦克风采集、长按手势、浏览器音频没验证。** `scripts/asr-probe.ts` 用 `say`
  合成的音频走假麦克风，验的是编码 → ASR → 对话这条链；真实 `getUserMedia`、
  AudioWorklet 的 24k 重采样兜底、长按手势与拖动的竞争、权限被拒的提示，
  都只能在 `tauri build --debug` 产物上人工验收。
- **浏览器里的音频播放没验证。** 探测脚本里的播放侧是假的，只统计字节和时序。
  真实播放走 `voice/SpeechStream.ts`，需要在 `tauri build --debug` 产物上验收。
- **播放环溢出没有实测触发过。** 环是 12 秒（`public/audio-playback.js` 的
  `RING_SECONDS`），合成比播放快，所以 `tts.ts` 自己按「上一段快播完」节流，
  环里最多躺一段。逻辑有单测，但没在真实音频下压过。
- **打断没在真实音频下验证。** `cancel()` 的单测覆盖了「废掉在途请求 + 清空环 +
  唤醒等待」，但「听觉上是不是立刻安静」没听过。
