# TTS / ASR 接入记录

更新：2026-10-14（Asia/Shanghai）。当前为本地 Web 语音 MVP，对话模型仍为 `step-3.7-flash`。

## 已实现

- 声音开关默认关闭，试听可以独立播放。`stepaudio-3-tts` 底音改为 `qingchunshaonv`；服务端固定 instruction 要求清亮、稚嫩、活泼可爱，像小学生分享新发现。没有克隆真人声音。语音年龄感是合成风格目标，不代表客观验证的年龄或质量。
- 模型回复按标点/换行分句，长句每段最多 180 字，单轮最多 8 段。串行合成与播放重叠，播放顺序固定。去除代码块、链接地址、Markdown 标记及括号指令；不直接朗读工具参数。
- 浏览器 Web Audio 播放 WAV，AnalyserNode 实测振幅驱动 neutral 嘴型；非 neutral 不叠嘴，没有新造的骨骼动画。
- 按住按钮或键盘空格/Enter 录音，松开转写，Escape 取消。AudioWorklet 采集 PCM，编码为真实单声道 24kHz PCM16 WAV，最长 30 秒。无 WebM 改后缀伪装；静音连接不回放麦克风。
- `/api/audio/asr` 提交完整 WAV 给 `stepaudio-3-asr-max`，消费 SSE，只有收到 `transcript.text.done` 才提交转写。结果填入输入框，可修改后发送；沿用原有 agent / tools / session 链路。
- 所有音频请求经 Fastify，客户端没有供应商密钥。检查 WAV 文件头、实际长度、时长与采样率；每次最多 3 个语音请求，45 秒超时，上游音频响应最多 8MB，响应 no-store。
- 新交互、停止、清空、模式切换、隐藏页面和卸载会清除播放与迟到结果。录音轨道及时关闭，包括用户松开后才返回的麦克风授权；离开窗口取消录音。输入新草稿时取消尚未完成的转写。
- 自主调度在播放、合成、录音、识别和草稿编辑期间暂停。演示模式不调用语音 API。

## 会话过期修复

原因为服务端内存 SessionStore：开发 `tsx watch` 修改服务端文件会重启；闲置一小时的会话也会清理。浏览器原来保留旧 ID，收到 410 后仅提示清空。

现已保留 HTTP 错误状态码，只有 **执行前 410** 才自动建立一次新会话。重连后重置房间和聊天上下文，页面明确提示。当前文字、触碰及普通物件操作可继续一次；旧发现卡答案/揭晓、倒计时事件和自主调度不重放。第二次 410 正常报错退出，不能无限重试；收到流之后的断流不自动重放。重连不恢复服务端已经丢失的历史，也未引入磁盘存储。

## 验证证据

- `npm test`：34/34 通过，新增语音清洗、WAV 格式/时长、最终转写要求、API 参数校验、密钥错误脱敏、音量嘴型测试。
- `scripts/audio-qa.mjs`：Edge 自动化，通过默认关闭、Mock 隔离、试听、回复自动播放、打断、真实 AudioWorklet 采集（合成麦克风）、编辑转写、迟到 ASR/TTS、键盘取消、延迟授权轨道释放、拒绝麦克风、桌面/390px 布局与无 pageerror。API 在此脚本中被测试响应替代，不消耗额度。
- `scripts/audio-live.ts`：真实 TTS 生成 5.84 秒、24kHz 单声道 WAV，281804 字节，完整合成约 3.74 秒；真实 ASR 约 0.70 秒。识别为「嘿，你来啦，我是 Step 酱，今天也一起发现点新东西吧。」单次测量，不是首包延迟或性能保证。
- `scripts/audio-browser-live.mjs`：合成 WAV 作为浏览器麦克风输入，实际录音 → 后端 ASR 200 → 可编辑文字 → 实际 Flash 回复 → 后端 TTS 200 → 浏览器播放/停止，页面无脚本错误。未录制用户麦克风，未验证真人口音/噪音质量。
- `scripts/session-recovery-qa.mjs`：删除服务端会话模拟重启/过期；自动恢复一次并重置房间；旧卡片操作丢弃；持续 410 退出后输入区可用。
- `scripts/production-check.mjs`：构建后的临时 3002 服务可加载 AudioWorklet 文件，通过完整房间交互及音频浏览器测试、真实 Flash 回复、缺素材回退；19 个公开文件无密钥泄漏，页面无直连供应商请求。临时服务已关闭。
- 本地证据（Git 忽略）：`artifacts/audio-live-result.json`、`audio-browser-live.json`、`stepchan-young-voice.wav`、`audio-desktop.png`、`audio-mobile.png`。应用不会自动写这些文件，只有手动 QA 脚本生成。

## 当前限制

这是按住说话 + 文本对话 + 短句朗读，不是 Realtime 全双工。未加入自动 VAD、边录边识别、纯语音「实际听到多少」历史裁剪。当前可见文本继续作为对话上下文；停止播放不宣称用户已听完整句。句间可能等待合成，长回复最多读 8 段，其余仍显示文字。声音默认不自动开启，浏览器播放策略要求主动点击。

既有 Flash 工具后空回复、工具预算耗尽问题仍见模型基准记录，本次没有通过语音改动掩盖它们。手机真机、长期录音和噪声环境验收待后续。

官方依据：[TTS 接口](https://platform.stepfun.com/docs/zh/api-reference/audio/create-audio)、[音色清单](https://platform.stepfun.com/docs/zh/guides/developer/tts)、[ASR SSE](https://platform.stepfun.com/docs/zh/api-reference/audio/asr-sse)。Audio 3 的风格使用 `instruction`，不使用旧 `voice_label`。
