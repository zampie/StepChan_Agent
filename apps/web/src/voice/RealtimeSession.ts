// 一个 WebSocket 实时会话的全部状态机。
//
// 职责边界：本类只管协议与音频通道，不认识桌面能力，也不认识人设内容 ——
// 工具执行器和 instructions 都由构造参数注入（见 brain/Brain.ts）。
//
// 几个硬约束（来自 shared/realtime.ts 开头的实测记录）：
// - 鉴权必须走 subprotocol，webview 设不了 header。
// - 工具是嵌套格式。
// - 单会话 30 分钟上限 → 到点前主动静默重建，并把上下文摘要带过去。
// - 首次出音后 voice 不可改 → 换音色也只能重建。
import {
  REALTIME_SESSION_LIMIT_MS,
  parseServerEvent,
  realtimeSubprotocols,
  realtimeUrl,
  type ClientEvent,
  type ServerEvent,
  type SessionConfig,
  type ToolDefinition,
} from '../../../../shared/realtime';
import type { PetEvent, ToolName, ToolResult } from '../../../../shared/brain';
import { toolArgSchemas, toolNames } from '../../../../shared/brain';
import { SpeechStream } from './SpeechStream';
import { MicStream } from './MicStream';
import { reportDiagnostic } from '../platform/diagnostics';

/** 一轮最多执行多少个工具。防止模型自循环把额度烧光。 */
export const MAX_TOOL_CALLS_PER_TURN = 4;
/** 提前多久重建会话。留足时间让当前这轮说完。 */
const ROTATE_MARGIN_MS = 90_000;
/** 文字输入后，等多久判定「她答应了却没真的调工具」。 */
const TOOL_NUDGE_DELAY_MS = 1200;
/**
 * 「在想」最多允许停留多久（且期间既没有在生成、也没有工具在跑）。
 *
 * 超了就判定这一轮丢了：报错并复位。为什么需要它 —— 进入 thinking 的出口只有
 * `response.done`，而有几条路进得去出不来（发送失败、服务端判噪声不开回合、
 * response.cancelled）。卡在 thinking 的表现是永久三点气泡 + 点她不说话 +
 * 主动感知整层静默，而且**不报任何错**。
 *
 * 10 秒：比正常的首字延迟（实测 1~2 秒）宽松一个数量级，又不至于让用户
 * 盯着三点气泡等到放弃。
 */
const THINKING_TIMEOUT_MS = 10_000;
/**
 * 轮换前最多等她说完多久。
 *
 * ROTATE_MARGIN_MS 留了 90 秒余量，这里最多吃掉 60 秒，剩 30 秒够重连 + 推摘要。
 */
const ROTATE_WAIT_MAX_MS = 60_000;
/**
 * 服务端 VAD 的参数。**只有这一份**，`sendSessionUpdate` 和 VAD 的挂起/恢复都用它。
 *
 * silence_duration_ms：文档默认 100ms 在桌宠场景下不可用 —— 说话里任何一个自然
 * 停顿都会被当成「说完了」，一句话被切成好几个回合。停顿容忍抬到 700ms。
 *
 * energy_awakeness_threshold：曾经抬到 3400 来挡环境噪声，但实测这会把**低增益的
 * 输入整个挡掉** —— 用户的 AirPods 自检峰值只有 0.001，那种电平永远跨不过 3400，
 * 表现是「麦克风检测通过但说话毫无反应」。现在回到接近文档默认的 2200。
 */
const SERVER_VAD = {
  type: 'server_vad',
  prefix_padding_ms: 300,
  silence_duration_ms: 700,
  energy_awakeness_threshold: 2200,
} as const;
/** 等她说完时的轮询间隔。250ms 足够细 —— 切点误差听不出来。 */
const ROTATE_POLL_MS = 250;
/**
 * 打断后的「丢弃在途音频」闸门最多开多久。
 *
 * 正常情况它由下一个 `response.created` 解除。但那条事件不是一定会来
 * （`response.create` 可能发失败，或者服务端因 VAD 自己开的回合先送音频再送
 * created），而闸门开着期间**所有音频增量都被整段丢弃** —— 用户听到的是
 * 「她这一次完全不说话」，而且不报错。实测在途增量只有 4 条，1.5 秒是个
 * 宽松到不可能误伤、又不会让她静音太久的上界。
 */
const SUPPRESS_MAX_MS = 1500;
/**
 * 一次长按至少要采到这么多帧（一帧约 40ms，见 MicStream 的 frameSamples）才算
 * 「说了话」。
 *
 * 为什么要这个下限：**实测**空缓冲区上 commit 会让服务端回两个 error
 * （`input_audio_buffer.append is not called` 外加一个 500 级的内部错误），
 * 用户看到的就是莫名其妙的「语音服务返回了一个错误」。误触的极短长按
 * （手指刚碰到就挪开）正好会走到这条路上，所以干脆不提交，清掉算了。
 */
export const MIN_PUSH_TO_TALK_FRAMES = 4;

export type ToolExecutor = (name: ToolName, args: unknown) => Promise<ToolResult>;

export type RealtimeSessionOptions = {
  apiKey: string;
  model?: string;
  voice: string;
  instructions: string;
  tools: ToolDefinition[];
  executeTool: ToolExecutor;
  /**
   * 持续聆听。默认 true。
   * - true：持续开麦 + 服务端 VAD 断句。
   * - false：**不持续开麦**，只在 beginPushToTalk()/endPushToTalk() 之间采集，
   *   并且把 turn_detection 设成 null（否则 VAD 会在中途把一句话截断）。
   */
  listening?: boolean;
  /**
   * 允许用语音打断她。默认 false。
   * 关闭时她说话期间的 VAD 事件被**完全忽略** —— 连压音量都不做，
   * 因为环境噪声和她自己的回声都会触发 VAD。
   */
  interruptible?: boolean;
  /** 发事件给 UI。 */
  emit: (event: PetEvent) => void;
  /**
   * 判断一句文字输入是否「明显应该调工具」。返回工具名则在模型没调工具时补一刀。
   * 放在外面是因为这属于人设/业务判断，不属于协议。
   */
  textNeedsTool?: (text: string) => ToolName | null;
  /** 换会话时带过去的上下文摘要。 */
  summarize?: (transcript: TranscriptEntry[]) => string;
  onLevel?: (level: number) => void;
};

export type TranscriptEntry = { role: 'user' | 'pet'; text: string; at: number };

type PendingCall = { callId: string; name: string; args: string };

export class RealtimeSession {
  private ws: WebSocket | null = null;
  private speech: SpeechStream;
  private mic: MicStream;
  /** 每次 connect 自增。所有异步回调都要对 epoch，防止旧连接的迟到消息污染新会话。 */
  private epoch = 0;
  private closedByUs = false;
  private rotating = false;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private rotateTimer: ReturnType<typeof setTimeout> | null = null;
  private nudgeTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private micWanted = false;

  private toolCallsThisTurn = 0;
  /** 幂等：同一 call_id 只执行一次；重复的直接回上次的结果。 */
  private toolResults = new Map<string, ToolResult>();
  private inFlightTools = new Set<string>();
  private responseActive = false;
  /**
   * 当前这一轮的 response id。用来丢掉上一轮迟到的 `response.done`。
   * 服务端 VAD 会在一轮还没收尾时自己开下一轮，两轮的事件真的会交错（已实测）。
   */
  private activeResponseId: string | null = null;
  private hadAudioOutput = false;
  private awaitingToolFor: ToolName | null = null;
  /**
   * 打断之后到下一个 response.created 之间，丢弃所有音频增量。
   *
   * 实测：发出 response.cancel 之后还会再到 4 条 response.audio.delta（在途的），
   * 之后流才安静。不丢掉它们的话，刚 flush 的环又被填上，她会在被打断后
   * 再蹦出小半个字。
   */
  private suppressAudio = false;
  /** 已压音量、等待确认是不是真人声的状态。 */
  private pendingBargeIn = false;
  private bargeInTimer: ReturnType<typeof setTimeout> | null = null;
  /** 丢弃闸门的硬上界定时器。见 SUPPRESS_MAX_MS。 */
  private suppressTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * 本次 VAD 回合被「不可打断」规则忽略了。
   *
   * speech_started 被忽略时置位，speech_stopped 时清掉 —— 这样一对事件要么
   * 一起处理、要么一起忽略，不会出现「开口被忽略、闭口却把活动状态改成 thinking」
   * 这种半截状态（她明明还在说话，UI 却显示在思考）。
   */
  private vadIgnored = false;
  /**
   * 「不可打断」期间暂停上传麦克风音频。
   *
   * 为什么光在客户端忽略 VAD 不够：服务端 VAD 是开着的（她不说话时还要靠它开
   * 新回合），我们忽略 `speech_started` 只是不动本地播放 —— 可服务端那边音频
   * 还在往 buffer 里堆，静音 700ms 后它会**自己 commit、自己开新回合**，
   * 在服务端把她说到一半的回复截断。客户端对此零控制力（协议的
   * `turn_detection` 没有「要断句但不要自动开回合」的字段，见 shared/realtime.ts）。
   *
   * 所以唯一可行的办法是：她说话期间干脆不给服务端音频 —— 停止 append 并
   * 清掉已经堆进去的。没有音频就没有回合，她才真的不会被打断。
   *
   * 代价说清楚：这段时间用户说的话是**真的被丢掉**了，不是排队等她说完。
   * 这正是「不可打断」的语义 —— 想插话就长按她（走 interrupt()，不受开关影响）。
   * 长按是**可靠**的那个手段；Esc 只在应用是当前窗口时收得到，而 Accessory
   * 激活策略下桌宠窗平时不抢键盘焦点，所以别把 Esc 当主要出路写给用户。
   */
  private micHeld = false;
  /**
   * 「不可打断」期间把服务端 VAD 整个关掉。
   *
   * **为什么掐断音频上行不够 —— 这是实测结论，不是推断。** 原来的做法是收到
   * `speech_started` 之后停止上传并发 `input_audio_buffer.clear`，当时推断
   * 「没有音频就没有回合」。真机日志否掉了它：
   *
   *   vad: 服务端检测到人声开始
   *   vad: 不可打断 —— 已暂停音频上行并清空服务端缓冲   ← 确实执行了
   *   asr: 转写完成「」                                 ← 音频真的被清掉了
   *   turn: 服务端开始生成回复                           ← 服务端照样开了新回合
   *
   * 服务端在**发出 speech_started 的那一刻**就已经开了一个回合，事后清 buffer
   * 救不回来；而新回合一开，它就把她上一轮的生成丢掉了。**反应式来不及。**
   *
   * 所以改成预防式：她一开始说话就 `session.update` 把 turn_detection 设成 null
   * （已实测可在同一连接上双向热改、改完立刻生效，见 setListening 的注释），
   * 她说完再恢复。VAD 关着期间服务端不会检测人声、不会 commit、不会开回合。
   *
   * 代价不变：这段时间用户说的话是**真的被丢掉**了。这正是「不可打断」的语义 ——
   * 想插话就长按她。
   */
  private vadSuspended = false;
  /** 按住说话进行中。 */
  private pttActive = false;
  /** 本次长按已经送出去多少帧音频。见 MIN_PUSH_TO_TALK_FRAMES。 */
  private pttFrames = 0;

  /** 送出的麦克风帧数。只用于诊断。 */
  private micFrames = 0;
  private firstDeltaLogged = false;
  private suppressLogged = false;
  private lastActivity: 'idle' | 'listening' | 'thinking' | 'speaking' = 'idle';
  /** 进入 thinking 的时刻。看门狗用它判断「在想」是不是已经想死了。 */
  private thinkingSince = 0;
  private activityWatchdog: ReturnType<typeof setInterval> | null = null;
  private userPartial = '';
  private petPartial = '';
  readonly transcript: TranscriptEntry[] = [];

  constructor(private options: RealtimeSessionOptions) {
    this.speech = new SpeechStream({
      onLevel: (level) => this.options.onLevel?.(level),
      onDrained: () => this.resolveIdleActivity(),
      onStarted: () => this.setActivity('speaking'),
      onError: (message) => this.options.emit({ type: 'error', message }),
    });
    this.mic = new MicStream({
      onFrame: (base64) => {
        // 「不可打断」期间不给服务端音频 —— 否则它会自己 commit 并开新回合，
        // 在服务端截断她。见 micHeld 的注释。
        if (this.micHeld) return;
        if (this.pttActive) this.pttFrames++;
        this.send({ type: 'input_audio_buffer.append', audio: base64 });
      },
      onError: (message) => this.options.emit({ type: 'error', message }),
      onSampleRateMismatch: (actual, target) =>
        console.warn(`[RealtimeSession] 麦克风采样率 ${actual}Hz ≠ ${target}Hz，已重采样。`),
    });
  }

  get audioLevel(): number {
    return this.speech.audioLevel;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** 持续聆听开关的当前值（默认 true）。 */
  get listening(): boolean {
    return this.options.listening !== false;
  }

  /** 可打断开关的当前值（默认 false）。 */
  get interruptible(): boolean {
    return this.options.interruptible === true;
  }

  /** 按住说话进行中。 */
  get pushToTalkActive(): boolean {
    return this.pttActive;
  }

  /**
   * 她此刻正在出声（还有未播完的音频，或者这一轮还没结束）。
   *
   * 两个分量各自都会在她真的还在说话时为假，所以必须是或：
   * - `responseActive` 在 `response.done` 就清零，而环里还压着几百毫秒到几秒的
   *   尾音（模型出音快于播放）。
   * - 播放侧的 `speaking` 是**去抖后**的，不是瞬时音量。原来这里用的是
   *   `speech.audioLevel > 0`，而欠载/句间停顿都会让它瞬时归零 ——
   *   于是「可打断」关着时 `!interruptible && speaking` 在那一瞬不成立，
   *   speech_started 落到 beginBargeIn()，而它开头就是「她没在说话 → 直接
   *   不可逆打断」。用户报的「关了开关还是被打断」有一半是这么来的。
   */
  private get speaking(): boolean {
    return this.responseActive || this.speech.speaking;
  }

  /**
   * 该回 idle/listening 了吗？只有在「这一轮结束 **且** 音频播完」时才回。
   *
   * 这个判断原来分散在两处，各带一个条件：`onDrained` 里判 `!responseActive`、
   * `response.done` 里判 `!audioLevel`。两个条件互锁，于是只要
   * 「最后一次 drained 早于 response.done，而 response.done 时音频还没播完」
   * 两边就都不命中，活动状态**永久卡在 speaking**。
   * 后果不是只有气泡不消失：`speaking` 卡住会让点击被当成「她在忙」而不说话，
   * 而且「可打断」关闭时所有 VAD 事件都被忽略。
   *
   * 所以合并成一个幂等函数，并配一个看门狗（见 startActivityWatchdog）——
   * 竞态本身被消掉，而不是再加一个条件去绕。
   */
  private resolveIdleActivity(): void {
    if (this.speaking) return;
    // 她说完了 → 先清缓冲再开 VAD。顺序要紧：反过来的话停传期间攒下的
    // 在途音频会在 VAD 刚恢复时被当成一句话提交。
    this.releaseMicUpload();
    this.resumeServerVad();
    this.setActivity(this.micWanted ? 'listening' : 'idle');
  }

  /**
   * 她要开口了 → 不可打断模式下把**服务端 VAD 和音频上行一起**停掉。
   *
   * ⚠️ 两件事必须共用这一个闸门。拆成两次调用、只给其中一个加 `interruptible`
   * 判断，后果是**开着打断开关时打断失效** —— 她一开口就掐断上行，服务端
   * 压根听不到用户说话。这个回归真的发生过，真机日志里长这样：
   *   session: listening=true interruptible=true turn_detection=server_vad
   *   turn: 服务端开始生成回复
   *   vad: 不可打断 —— 已暂停音频上行并清空服务端缓冲   ← 不该执行
   *   asr: 转写完成「给我讲个笑话呗」                   ← 转写到了却打不断
   *
   * 不适用的两种情况：可打断模式（本来就该让 VAD 工作、该收音），
   * 以及按住说话模式（turn_detection 本来就是 null，麦克风也不常开）。
   */
  private shieldWhileSpeaking(): void {
    if (this.interruptible || !this.listening) return;
    this.suspendServerVad();
    this.holdMicUpload();
  }

  /** 关掉服务端 VAD。只该由 shieldWhileSpeaking 调用 —— 闸门在那里。 */
  private suspendServerVad(): void {
    if (this.vadSuspended) return;
    this.vadSuspended = true;
    // 走 sendSessionUpdate 推**完整**配置，不是只发一个 turn_detection 字段 ——
    // 没有验证过服务端是合并还是整体替换，只发一个字段有把 instructions/voice/tools
    // 一起冲掉的风险。setListening 热改 VAD 用的也是这条路。
    this.sendSessionUpdate(false);
    reportDiagnostic('vad: 不可打断 —— 已关掉服务端 VAD（她说完再开）');
  }

  private resumeServerVad(): void {
    if (!this.vadSuspended) return;
    this.vadSuspended = false;
    this.sendSessionUpdate(false);
    reportDiagnostic('vad: 已恢复服务端 VAD');
  }

  /** 她说话期间掐断音频上行。配合 suspendServerVad 一起用，见 micHeld 的注释。 */
  private holdMicUpload(): void {
    if (this.micHeld) return;
    this.micHeld = true;
    // 清掉她开始说话到现在已经堆进服务端 buffer 的那一段，否则这段就够它开一个回合。
    this.send({ type: 'input_audio_buffer.clear' });
    reportDiagnostic('vad: 不可打断 —— 已暂停音频上行并清空服务端缓冲');
  }

  private releaseMicUpload(): void {
    if (!this.micHeld) return;
    this.micHeld = false;
    // 恢复前再清一次：停传期间服务端可能还收到了在途的几帧。
    this.send({ type: 'input_audio_buffer.clear' });
    reportDiagnostic('vad: 已恢复音频上行');
  }

  /**
   * 看门狗：卡住是静默故障，用户只会看到「她不理我了」。
   * 代价是一个 500ms 的轻量定时器，比再引入一个互锁条件划算得多。
   *
   * 两种卡住都要兜：
   * - **speaking**：音频播完和回合结束两个信号的顺序竞态（见 resolveIdleActivity）。
   * - **thinking**：出口只有 `response.done`，而有好几条路进得去出不来 ——
   *   `send()` 在连接不是 OPEN 时只返回 false（`sendText` 以前根本不看返回值）、
   *   服务端判定这段是噪声不开回合、`response.cancelled` 不走 resolveIdleActivity。
   *   卡在 thinking 比卡在 speaking 更糟：永久的三点气泡，而且 busy 恒为真，
   *   于是点她不说话、主动感知整层静默。
   */
  private startActivityWatchdog(): void {
    if (this.activityWatchdog) return;
    this.activityWatchdog = setInterval(() => {
      if (this.lastActivity === 'speaking' && !this.speaking) {
        reportDiagnostic('activity: ⚠ 看门狗发现卡在 speaking，已复位');
        this.resolveIdleActivity();
        return;
      }
      if (this.lastActivity !== 'thinking') return;
      // 她真的在生成、或者本地工具还在跑，就是正常的「在想」，不要打扰。
      if (this.responseActive || this.inFlightTools.size > 0) {
        this.thinkingSince = Date.now();
        return;
      }
      if (Date.now() - this.thinkingSince < THINKING_TIMEOUT_MS) return;
      reportDiagnostic('activity: ⚠ 看门狗发现卡在 thinking，已复位');
      // 必须告诉用户 —— 这条路径下她是真的没收到/没回，静默复位只会让人
      // 以为自己没说清楚，又说一遍。
      this.options.emit({
        type: 'error',
        message: '这一句她没有回应，可能是连接断了。再说一次试试。',
      });
      this.resolveIdleActivity();
    }, 500);
  }

  /**
   * 建立会话。withMic=false 用于纯打字模式，以及「按住说话」模式
   * （两者都不该在启动时就申请麦克风权限）。
   */
  async start(withMic: boolean): Promise<void> {
    this.startActivityWatchdog();
    this.started = true;
    // 按住说话模式下不持续开麦：麦克风权限留到用户第一次长按时再申请。
    const continuous = withMic && this.listening;
    this.micWanted = continuous;
    await this.speech.start();
    await this.connect(false);
    if (continuous) await this.enableMic();
  }

  async enableMic(): Promise<void> {
    // 按住说话模式下不能常开麦 —— 开了就违背「不持续开麦」这个承诺。
    if (!this.listening) return;
    // 顺序要紧：`micWanted` 必须在确认会话已启动**之后**才置位。
    // 反过来写的话，stop() 与 start() 竞态时它会留在 true，
    // 之后 resolveIdleActivity() 一直报 'listening' 而麦克风其实没开 ——
    // 界面显示在听、实际不在听，而且不报错。
    if (!this.started) return;
    this.micWanted = true;
    try {
      await this.mic.start();
      reportDiagnostic('mic: 会话已开启麦克风（持续采集）');
      this.setActivity('listening');
    } catch {
      // 错误已经通过 onError 发出去了；降级为纯打字，不抛给调用方。
      this.micWanted = false;
    }
  }

  disableMic(): void {
    this.micWanted = false;
    this.pttActive = false;
    this.mic.stop();
    this.setActivity('idle');
  }

  // ---- 两个运行时开关 ----

  /**
   * 切换「可打断」。纯本地行为，不需要动会话配置 ——
   * 服务端 VAD 照常跑（她没说话时还要靠它开新回合），只是播放期间我们不理它。
   */
  setInterruptible(interruptible: boolean): void {
    if (interruptible === this.interruptible) return;
    this.options = { ...this.options, interruptible };
    // 关掉开关的瞬间可能正压着音量等确认，立刻恢复，别让她一直小声说。
    if (!interruptible && this.pendingBargeIn) this.cancelBargeIn();
  }

  /**
   * 切换「持续聆听」。
   *
   * 不重建会话：**已实测** turn_detection 能在同一连接上用 session.update
   * 双向热改（null ↔ server_vad，改完立刻生效），见本轮的 ptt-probe 结果。
   */
  async setListening(listening: boolean): Promise<void> {
    if (listening === this.listening) return;
    // 正按着说话就先把这一轮收掉，否则 VAD 配置变了之后这段音频没人提交。
    if (this.pttActive) this.endPushToTalk();
    this.options = { ...this.options, listening };
    if (!this.started) return;
    // 先推配置再动麦克风：VAD 还开着的时候松开的麦会留下半截 buffer。
    if (this.connected) this.sendSessionUpdate(false);
    if (listening) {
      await this.enableMic();
    } else {
      this.micWanted = false;
      this.mic.stop();
      // 她可能正在说话，这时不该把活动状态抹成 idle。
      if (!this.speaking) this.setActivity('idle');
    }
  }

  // ---- 按住说话 ----

  /**
   * 长按桌宠开始说话。
   *
   * 持续聆听模式下长按只当「闭嘴，听我说」用 —— 麦克风本来就开着，断句交给 VAD。
   * 按住说话模式下才真的现开麦克风：**麦克风权限就是在这里第一次申请的**，
   * 应用启动时不碰。
   */
  async beginPushToTalk(): Promise<void> {
    if (!this.started) return;
    // 长按是用户明确的意思表示，所以无论「可打断」开关如何都先让她停下。
    this.interrupt();
    if (this.listening) {
      // 麦克风已经开着，让服务端 VAD 继续断句，不要手动接管。
      this.setActivity('listening');
      return;
    }
    if (this.pttActive) return;
    this.pttActive = true;
    this.pttFrames = 0;
    // 上一次松手可能留下了没提交的尾巴（比如松手时连接刚断），先清干净。
    this.send({ type: 'input_audio_buffer.clear' });
    this.micWanted = true;
    try {
      await this.mic.start();
    } catch {
      // 权限被拒之类：错误已经通过 onError 发出去了，退回纯打字。
      this.pttActive = false;
      this.micWanted = false;
      this.setActivity('idle');
      return;
    }
    // start() 期间用户可能已经松手了。
    if (!this.pttActive) {
      this.micWanted = false;
      this.mic.stop();
      return;
    }
    this.setActivity('listening');
  }

  /**
   * 松手 = 这一轮说完了。
   *
   * VAD 关着的时候**必须手动提交**，否则这段音频永远不会变成一个回合
   * （已实测：turn_detection: null 下服务端不会自己 commit、也不会自己开回合）。
   */
  endPushToTalk(): void {
    if (!this.pttActive) return;
    this.pttActive = false;
    if (this.listening) return; // 连续模式下这只是个手势，没有缓冲区要收
    this.micWanted = false;
    this.mic.stop();
    const frames = this.pttFrames;
    this.pttFrames = 0;
    if (frames < MIN_PUSH_TO_TALK_FRAMES) {
      // 误触：没采到够长的音频就提交，服务端会回两个 error（实测）。
      // 什么都不问比弹一个看不懂的错误好。
      console.info(`[RealtimeSession] 长按太短（${frames} 帧），当误触丢掉。`);
      this.send({ type: 'input_audio_buffer.clear' });
      this.setActivity('idle');
      return;
    }
    const committed = this.send({ type: 'input_audio_buffer.commit' });
    if (!committed) {
      // 连接断了：这段话丢了，但不能把 UI 卡在 listening 上。
      this.setActivity('idle');
      return;
    }
    this.send({ type: 'response.create' });
    this.setActivity('thinking');
  }

  private setActivity(value: 'idle' | 'listening' | 'thinking' | 'speaking'): void {
    if (value === 'thinking' && this.lastActivity !== 'thinking') {
      this.thinkingSince = Date.now();
    }
    this.lastActivity = value;
    this.options.emit({ type: 'activity', value });
  }

  // ---- 连接 ----

  private async connect(isRotation: boolean): Promise<void> {
    const epoch = ++this.epoch;
    this.clearTimers();
    this.closedByUs = false;
    this.options.emit({
      type: 'connection',
      state: isRotation ? 'reconnecting' : 'connecting',
    });

    let ws: WebSocket;
    try {
      ws = new WebSocket(
        realtimeUrl(this.options.model),
        realtimeSubprotocols(this.options.apiKey),
      );
    } catch (error) {
      this.options.emit({
        type: 'error',
        message: `无法建立语音连接：${error instanceof Error ? error.message : '未知错误'}`,
      });
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      if (epoch !== this.epoch) {
        ws.close();
        return;
      }
      this.attempts = 0;
      this.options.emit({ type: 'connection', state: 'open' });
      this.sendSessionUpdate(isRotation);
      // 到 30 分钟墙之前主动换会话。
      this.rotateTimer = setTimeout(
        () => void this.rotate(true),
        Math.max(10_000, REALTIME_SESSION_LIMIT_MS - ROTATE_MARGIN_MS),
      );
      this.setActivity(this.micWanted ? 'listening' : 'idle');
    });

    ws.addEventListener('message', (event: MessageEvent) => {
      if (epoch !== this.epoch) return;
      if (typeof event.data !== 'string') return; // 协议里没有二进制帧
      let parsed: ServerEvent;
      try {
        parsed = parseServerEvent(event.data);
      } catch (error) {
        // parseServerEvent 承诺不抛；真抛了也不能让会话死掉。
        console.error('[RealtimeSession] 解析异常', error);
        return;
      }
      try {
        this.handle(parsed);
      } catch (error) {
        console.error('[RealtimeSession] 处理事件失败', parsed.type, error);
      }
    });

    ws.addEventListener('error', () => {
      if (epoch !== this.epoch) return;
      console.warn('[RealtimeSession] WebSocket error');
    });

    ws.addEventListener('close', (event: CloseEvent) => {
      if (epoch !== this.epoch) return;
      this.ws = null;
      this.clearTimers();
      this.speech.flush();
      // 连接没了，这一轮的所有状态都必须作废 —— 否则会跨连接泄漏，
      // 表现为重连后「她不说话」或「ASR 气泡永久卡住」。见 abandonTurn。
      this.abandonTurn();
      if (this.closedByUs) {
        this.options.emit({ type: 'connection', state: 'closed' });
        return;
      }
      // 1000 既可能是服务端到点收摊，也可能是我们自己轮换 —— 轮换走 rotate()，
      // 到这里的 1000 一律按「意外」处理，但提示语区分开。
      const expected = event.code === 1000 || event.code === 1001;
      this.options.emit({
        type: 'connection',
        state: 'reconnecting',
        detail: expected ? '会话到期，正在重新连接' : `连接中断（${event.code}）`,
      });
      this.scheduleReconnect();
    });
  }

  private sendSessionUpdate(isRotation: boolean): void {
    let instructions = this.options.instructions;
    if (isRotation && this.options.summarize) {
      const summary = this.options.summarize(this.transcript);
      if (summary) {
        // 带摘要而不是全量 transcript：全量会把 30 分钟的对话重新灌一遍，
        // 又慢又贵，而且她会开始复述旧内容。
        instructions = `${instructions}\n\n# 刚才聊到哪了\n${summary}\n（这是上一段会话的摘要。不要主动提「我们重连了」这种事，自然接着聊。）`;
      }
    }
    const session: SessionConfig = {
      modalities: ['text', 'audio'],
      instructions,
      voice: this.options.voice,
      input_audio_format: 'pcm16',
      output_audio_format: 'pcm16',
      // 两种情况下必须关掉服务端 VAD（见 SERVER_VAD 与 vadSuspended 的注释）：
      // 按住说话模式，以及「不可打断」期间她正在说话。
      turn_detection: this.listening && !this.vadSuspended ? SERVER_VAD : null,
      input_audio_transcription: {
        model: 'stepaudio-3-asr-max',
        language: 'zh',
        hotwords: ['Step酱', '阶跃娘', '阶跃星辰', '星星笔记', '呆毛'],
      },
      tools: this.options.tools,
      tool_choice: 'auto',
    };
    // 把生效的模式报出来。「持续聆听」靠服务端 VAD 自动提交回合，
    // 「按住说话」则 turn_detection=null、必须手动 commit —— 两者的
    // 「说完了没反应」长得一模一样，但原因完全不同。
    reportDiagnostic(
      `session: listening=${this.listening} interruptible=${this.interruptible} ` +
        `turn_detection=${session.turn_detection ? 'server_vad' : 'null(按住说话)'}`,
    );
    this.send({ type: 'session.update', session });
  }

  /**
   * 用户主动重试：把退避计数清零并立刻重连。
   *
   * 退避耗尽（8 次）之后 scheduleReconnect 就彻底不再重试了，而提示语承诺
   * 「点一下她再试」—— 这个方法就是让那句话成立的那一半。
   */
  retryNow(): void {
    if (!this.started || this.connected) return;
    this.attempts = 0;
    this.closedByUs = false;
    void this.connect(true);
  }

  private scheduleReconnect(): void {
    if (!this.started || this.closedByUs) return;
    this.attempts++;
    if (this.attempts > 8) {
      this.options.emit({
        type: 'connection',
        state: 'closed',
        detail: '多次重连失败，先歇一下。点一下她再试。',
      });
      return;
    }
    // 指数退避 + 抖动，避免服务端抖动时所有客户端同频重试。
    const delay = Math.min(15_000, 500 * 2 ** (this.attempts - 1)) + Math.random() * 400;
    this.reconnectTimer = setTimeout(() => void this.connect(true), delay);
  }

  /**
   * 轮换前等她把话说完。返回时要么安静了，要么等到了硬超时。
   *
   * 超时是必须的：30 分钟墙是硬的，而 ROTATE_MARGIN_MS 只留了 90 秒余量。
   * 宁可切断一句特别长的话，也不能等到会话被服务端掐死 —— 那样连摘要都带不过去。
   */
  private async waitUntilQuiet(): Promise<void> {
    const deadline = Date.now() + ROTATE_WAIT_MAX_MS;
    while (this.speaking && Date.now() < deadline) {
      // started 要一起查：等待期间用户可能把语音整个关了（stop()），
      // 那就没什么要等的了，继续等会让 stop() 后还挂着一个定时器。
      if (!this.started) return;
      await new Promise((r) => setTimeout(r, ROTATE_POLL_MS));
    }
    if (this.speaking) {
      reportDiagnostic('rotate: ⚠ 等满超时她还在说，只能切断（30 分钟墙到了）');
    }
  }

  /**
   * 重建会话。
   *
   * @param waitForQuiet 要不要先等她把话说完。
   *   - `true`：30 分钟墙前的静默重建。用户不应该察觉，所以绝不能切在半句上。
   *   - `false`：用户**明确要求**的重建（换音色）。这时等待是错的 ——
   *     他在托盘里点了新音色，等一分钟没反应只会以为点坏了。宁可把她当前
   *     这句掐掉，立刻生效。
   */
  private async rotate(waitForQuiet: boolean): Promise<void> {
    if (this.rotating || !this.started) return;
    this.rotating = true;
    try {
      // 等她说完再切，避免切在半句上。
      //
      // 原来是「如果 responseActive 就固定等 4 秒」然后不再复查 —— 于是超过
      // 4 秒的回复照样被切断，正是这段等待想避免的事；而短回复又白等满 4 秒。
      // 改成轮询到真的安静，带硬超时。判据用 `speaking`（含播放侧的尾音），
      // 不是 responseActive：服务端那边早结束了，环里还压着几秒音频。
      if (waitForQuiet) await this.waitUntilQuiet();
      this.closedByUs = true;
      this.ws?.close(1000, 'rotate');
      this.ws = null;
      this.speech.flush();
      // 轮换对用户应当是不可见的，所以更不能留下残留 —— 一个卡住的 ASR 气泡
      // 会在毫无征兆的时刻出现（30 分钟那一刻）并且再也不消失。
      this.abandonTurn();
      await this.connect(true);
    } finally {
      this.rotating = false;
    }
  }

  /** 换音色 = 重建会话（首次出音后 voice 不可改）。 */
  async setVoice(voice: string): Promise<void> {
    if (voice === this.options.voice) return;
    this.options = { ...this.options, voice };
    if (!this.started) return;
    if (!this.hadAudioOutput && this.connected) {
      // 还没出过音，直接改就行，省一次重连。
      this.sendSessionUpdate(false);
      return;
    }
    // 不等她说完：换音色是用户点出来的，立刻生效比不切断更重要。
    await this.rotate(false);
  }

  setInstructions(instructions: string): void {
    this.options = { ...this.options, instructions };
    if (this.connected) this.sendSessionUpdate(false);
  }

  // ---- 发送 ----

  private send(event: ClientEvent): boolean {
    const ws = this.ws;
    if (ws?.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(event));
      return true;
    } catch (error) {
      console.warn('[RealtimeSession] 发送失败', event.type, error);
      return false;
    }
  }

  /** 打字输入。 */
  sendText(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    // 打字也算一次新回合：先把她正在说的掐掉，否则两段话会叠在一起。
    this.interrupt();
    this.transcript.push({ role: 'user', text: trimmed, at: Date.now() });
    this.options.emit({ type: 'user_transcript', text: trimmed, final: true });
    this.resetTurnState();
    const sent =
      this.send({
        type: 'conversation.item.create',
        item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: trimmed }] },
      }) && this.send({ type: 'response.create' });
    if (!sent) {
      // **必须出声报错。** 原来这里不看 send() 的返回值，而它在 socket 不是 OPEN
      // 时只是 return false —— 于是连接断着的时候这句话悄悄丢了，活动状态却切到
      // thinking 再也出不来：永久三点气泡、点她不说话、主动感知整层静默，
      // 全程零报错。这类无声失败在这个项目里已经反复出现过。
      reportDiagnostic('send: ⚠ 连接不可用，这一句没发出去');
      this.options.emit({
        type: 'error',
        message: '连接断了，这句话没发出去。正在重连，稍等一下再说一次。',
      });
      this.resolveIdleActivity();
      // 顺手踢一次重连。重连次数耗尽后提示语写的是「点一下她再试」，
      // 而在这之前**没有任何代码会真的重建连接** —— 点她走的是 sendText，
      // 它只判 session 存不存在（存在），于是那句承诺是空的。
      this.retryNow();
      return;
    }
    this.setActivity('thinking');

    // 实测过的坑：她可能只是「口头答应」而不真的调工具。见 armToolNudge 的注释。
    this.armToolNudge(trimmed);
  }

  private nudgeToolCall(name: ToolName): void {
    console.info(`[RealtimeSession] 文字输入未触发 ${name}，补发 tool_choice:required。`);
    // 用系统消息说清楚「必须真的调」，再强制一次。失败就失败，不编造结果。
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'system',
        content: [
          {
            type: 'input_text',
            text: `上一轮你没有真的调用工具。用户的请求需要 ${name}。现在立刻调用它；如果你判断不该调用，就直接告诉用户你做不到，绝对不要声称自己已经做过。`,
          },
        ],
      },
    });
    this.send({ type: 'response.create' });
    this.awaitingToolFor = null;
  }

  /**
   * 打断。barge-in 的核心：必须同步完成本地止声，网络那一刀是顺带的。
   * 顺序很重要 —— 先 flush 本地再 cancel 远端，反过来会多播 200ms。
   */
  /** 人声持续这么久仍没出转写，也按真人处理 —— 不能让打断一直等 ASR。 */
  private static readonly BARGE_CONFIRM_MS = 400;

  private cancelBargeInTimer(): void {
    if (this.bargeInTimer) {
      clearTimeout(this.bargeInTimer);
      this.bargeInTimer = null;
    }
    this.pendingBargeIn = false;
  }

  /** VAD 说有人开口：先压音量，等确认。 */
  private beginBargeIn(): void {
    if (this.pendingBargeIn) return;
    // 她本来就没在说话 —— **什么都不用做**。
    //
    // 原来这里调 interrupt()，理由是「直接当新回合」。但 interrupt() 会立起
    // 音频丢弃闸门（suppressAudio）并发 response.cancel，而这时根本没有东西
    // 要打断：真机日志里每次用户开口都跟着一条
    //   turn: ⚠ 丢弃闸门超时自动解除（response.created 没来）
    // 一轮对话刷了 8 条。闸门白开 1.5 秒，还顺手清掉了 awaitingToolFor 和
    // 补刀定时器（「她嘴上答应却不调工具」的兜底就失效了）。
    if (!this.speaking) return;
    this.pendingBargeIn = true;
    this.speech.duck();
    this.bargeInTimer = setTimeout(() => {
      this.bargeInTimer = null;
      if (this.pendingBargeIn) this.confirmBargeIn();
    }, RealtimeSession.BARGE_CONFIRM_MS);
  }

  /** 确认是真人声 → 执行不可逆的打断。 */
  private confirmBargeIn(): void {
    // pendingBargeIn 只在「可打断」开着时才会被置位，所以这里天然不会在
    // 开关关闭时打断她。
    if (!this.pendingBargeIn) return;
    this.interrupt();
  }

  /** 判定为噪声误触发 → 恢复音量，让她把话说完。 */
  private cancelBargeIn(): void {
    this.cancelBargeInTimer();
    this.speech.unduck();
    if (this.responseActive) this.setActivity('speaking');
    else this.setActivity('idle');
  }

  /**
   * 打断。**不受 voiceInterruptible 开关影响** —— 那个开关只管「语音能不能
   * 自动打断」，这是用户明确的动作（Esc、长按、开始打字），永远有效。
   */
  interrupt(): void {
    this.cancelBargeInTimer();
    // 这一刀之后 VAD 的忽略状态应当作废：她不说话了，后面的 speech_stopped
    // 要走正常流程（切 thinking），不能继续被当成「被忽略的那一回合」。
    this.vadIgnored = false;
    const hadAudio = this.speech.audioLevel > 0 || this.responseActive;
    this.speech.flush();
    this.speech.unduck();
    // **只有真的取消了什么，才需要丢弃闸门。**
    //
    // 闸门的用途是丢掉 `response.cancel` 之后那几条在途音频增量（实测 4 条）。
    // 她本来就没在出声时没有在途增量，立闸门纯属多余 —— 而且每次都要等 1.5 秒
    // 超时才解除，真机日志里按住说话模式下每按一次就刷一条
    //   turn: ⚠ 丢弃闸门超时自动解除（response.created 没来）
    // 因为 beginPushToTalk() 会无条件先 interrupt() 一下。
    if (hadAudio) {
      // 顺序要紧：先立闸门再发 cancel，反过来会漏掉最先到的那几条增量。
      this.suppressAudio = true;
      this.armSuppressExpiry();
    }
    if (this.responseActive) this.send({ type: 'response.cancel' });
    this.responseActive = false;
    this.activeResponseId = null;
    // 打断之后她不说话了，上行和 VAD 都必须恢复 —— 否则用户接下来说的话
    // 一帧都传不上去，表现为「打断成功了但她再也听不见」。
    this.releaseMicUpload();
    this.resumeServerVad();
    if (this.nudgeTimer) {
      clearTimeout(this.nudgeTimer);
      this.nudgeTimer = null;
    }
    this.awaitingToolFor = null;
    if (hadAudio) this.petPartial = '';
  }

  /**
   * 「她答应了却没真的调工具」的兜底。
   *
   * 实测过两次，两种输入都会：
   * - 文字「挪到右下角去吧」→ 正常发了 move_to。
   * - 语音「你能不能挪到屏幕右下角去，别挡着我了」→ 只说了「好的，我这就挪到右下角去」，
   *   **没有发任何 function call**。
   * 所以这不是文字输入独有的问题，语音回合也要兜。命中了就用
   * tool_choice:'required' 补一刀；补不成她会说「做不到」，而不是继续撒谎。
   */
  private armToolNudge(utterance: string): void {
    const expected = this.options.textNeedsTool?.(utterance) ?? null;
    this.awaitingToolFor = expected;
    if (!expected) return;
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
    this.nudgeTimer = setTimeout(() => {
      if (this.awaitingToolFor !== expected) return;
      if (this.toolCallsThisTurn > 0) return;
      this.nudgeToolCall(expected);
    }, TOOL_NUDGE_DELAY_MS);
  }

  private resetTurnState(): void {
    this.toolCallsThisTurn = 0;
    this.toolResults.clear();
    this.inFlightTools.clear();
  }

  /**
   * 放弃当前回合并把所有跨回合状态复位。连接断开/重连/30 分钟轮换都要走这里。
   *
   * 为什么必须有这么一个统一的地方：原来 close 回调只调了 `speech.flush()`、
   * `rotate()` 只调了 `resetTurnState()`（而它只清工具状态），于是一串状态会
   * **跨连接泄漏**：
   * - `responseActive` 留在 true → `speaking` 恒为真 → 「不可打断」规则把
   *   重连后用户说的第一句话连 speech_started/stopped 一起吃掉，界面毫无反应。
   * - `suppressAudio` 留在 true → 新连接的第一段音频被整段丢弃，她「不说话」。
   * - `userPartial` 留着 → **ASR 气泡永久卡住**。这是用户报的那个 bug 的主因：
   *   清空用户气泡只有「转写 final」和「activity 回到 idle」两条路，而持续聆听
   *   下 activity 恒为 'listening'（第二条是死代码），所以只要 final 没来就再也
   *   清不掉了。重连和轮换恰好都会让 final 永远不来。
   */
  private abandonTurn(): void {
    this.cancelBargeInTimer();
    this.speech.unduck();
    this.responseActive = false;
    this.activeResponseId = null;
    this.clearSuppressExpiry();
    this.suppressAudio = false;
    this.suppressLogged = false;
    this.firstDeltaLogged = false;
    this.vadIgnored = false;
    this.micHeld = false;
    // 只复位标志，不推配置：连接可能已经断了，而重连后 sendSessionUpdate
    // 会按这个标志重新算出 server_vad。
    this.vadSuspended = false;
    this.awaitingToolFor = null;
    if (this.nudgeTimer) {
      clearTimeout(this.nudgeTimer);
      this.nudgeTimer = null;
    }
    this.resetTurnState();
    this.clearPartials();
  }

  private clearSuppressExpiry(): void {
    if (this.suppressTimer) {
      clearTimeout(this.suppressTimer);
      this.suppressTimer = null;
    }
  }

  /** 给丢弃闸门上一个硬上界，见 SUPPRESS_MAX_MS。 */
  private armSuppressExpiry(): void {
    this.clearSuppressExpiry();
    this.suppressTimer = setTimeout(() => {
      this.suppressTimer = null;
      if (!this.suppressAudio) return;
      reportDiagnostic('turn: ⚠ 丢弃闸门超时自动解除（response.created 没来）');
      this.suppressAudio = false;
      this.suppressLogged = false;
    }, SUPPRESS_MAX_MS);
  }

  /**
   * 清掉两个气泡的在途文本，并通知 UI。
   *
   * 发 `final: true` 且文本为空是和 UI 约定的「把气泡收掉」信号
   * （App.tsx 对 final 一律清空，不看内容）。不发事件只清本地变量是没用的 ——
   * UI 自己存了一份。
   */
  private clearPartials(): void {
    if (this.userPartial) {
      this.userPartial = '';
      this.options.emit({ type: 'user_transcript', text: '', final: true });
    }
    this.petPartial = '';
  }

  // ---- 接收 ----

  private handle(event: ServerEvent): void {
    switch (event.type) {
      case 'session.created':
      case 'session.updated':
      case 'rate_limits.updated':
      case 'conversation.item.created':
      case 'conversation.item.deleted':
      case 'response.content_part.added':
      case 'response.content_part.done':
      case 'response.output_item.added':
      case 'input_audio_buffer.cleared':
      case 'input_audio_buffer.committed':
        return;

      case 'error': {
        const raw = event.error?.message ?? '';
        reportDiagnostic(`server error: ${raw || '(无消息)'}`);
        console.warn('[RealtimeSession] server error', event.error);
        // **空闲超时不是用户能处理的错误，不往界面上弹。**
        //
        // 服务端会掐掉长时间没动作的会话（实测消息是 "too long without operation"），
        // 紧跟着连接关闭、我们自动重连 —— 整个过程对用户没有影响。而真机日志里
        // 一次挂机就刷了 10 条，每条都会变成一个红色报错气泡：桌宠放在那儿不管，
        // 过一会儿屏幕上冒出一串「语音服务返回了一个错误」，而其实什么都没坏。
        // 报错气泡要留给用户真能做点什么的情况。
        if (/too long without operation/i.test(raw)) return;
        this.options.emit({ type: 'error', message: raw || '语音服务返回了一个错误。' });
        return;
      }

      // ---- 打断：headline feature ----
      case 'input_audio_buffer.speech_started': {
        // 服务端 VAD 真的听见了人声 —— 这是「说话没反应」排查里最关键的一条分界：
        // 有这条说明音频通了、门限也过了，问题在后面；没有则在前面。
        reportDiagnostic('vad: 服务端检测到人声开始');
        // 「可打断」关着的时候，她说话期间的 VAD 事件被完全忽略 —— 连压音量都不做。
        // 这不是偷懒：环境噪声和她自己从扬声器出来的声音都会触发 VAD，
        // 压一下音量再恢复听上去就是她说话一卡一卡的。想打断就长按她
        // （走 interrupt()，不受这个开关影响）。
        // 注意只在「她正在说话」时忽略 —— 她没说话时这就是正常的新回合开始，必须照常处理。
        if (!this.interruptible && this.speaking) {
          this.vadIgnored = true;
          // 光忽略不够：服务端 VAD 会自己 commit 并开新回合，在服务端截断她。
          // 必须同时掐掉音频上行。见 micHeld 的注释。
          this.holdMicUpload();
          return;
        }
        // 不立刻打断 —— 打断是不可逆的（flush + response.cancel 砍掉的音频回不来），
        // 而 VAD 会被咳嗽、键盘、关门声误触发。先压音量：听觉上已经是「她让你说」，
        // 再等确认（听到实际转写，或者人声持续超过 BARGE_CONFIRM_MS）才真打断。
        // 噪声那一下只会让音量抖一下，她会继续说完。
        this.beginBargeIn();
        this.userPartial = '';
        this.setActivity('listening');
        return;
      }
      case 'input_audio_buffer.speech_stopped': {
        // 开口那一下被忽略了，闭口也要一起忽略，否则活动状态会被改成 thinking
        // （她明明还在说话）。
        reportDiagnostic(`vad: 人声结束（audio_end_ms=${event.audio_end_ms ?? '?'}）`);
        if (this.vadIgnored) {
          this.vadIgnored = false;
          return;
        }
        // 还没确认就结束了 → 判定为误触发，恢复音量、让她接着说。
        if (this.pendingBargeIn) {
          this.cancelBargeIn();
          return;
        }
        this.setActivity('thinking');
        return;
      }

      // ---- 字幕 ----
      case 'conversation.item.input_audio_transcription.delta': {
        // **赋值，不是累加。** 实测这个事件送的是「累计全量文本」而不是增量：
        //   你好呀。 / 你好呀，我 / 你好呀，我今天 / ...
        // 用 += 拼接会得到「你好呀。你好呀，我你好呀，我今天…」——
        // 用户看到的就是「一句话重复好几遍」。
        // 注意这与 OpenAI Realtime 的惯例相反，也与她自己的
        // response.audio_transcript.delta 不一致（那个确实是增量，已实测）。
        //
        // delta 缺失时**忽略这一条**，不要回退成 userPartial 再 emit 一遍：
        // schema 里 delta 是 optional，而「拿旧值当新内容」会把上一句的残留
        // 重新推给 UI（配合下面的卡住问题，就是一句旧话赖在屏幕上不走）。
        if (event.delta === undefined) return;
        this.userPartial = event.delta;
        // 听到实际内容 = 确认是人在说话，这时才执行不可逆的打断。
        if (this.userPartial.trim()) this.confirmBargeIn();
        this.options.emit({ type: 'user_transcript', text: this.userPartial, final: false });
        return;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        reportDiagnostic(`asr: 转写完成「${(event.transcript ?? '').slice(0, 40)}」`);
        const text = (event.transcript ?? this.userPartial).trim();
        this.userPartial = '';
        if (!text) {
          // 空转写（只听到「呃」、或者服务端判定这段没内容）也**必须**发一条
          // final 把气泡收掉。原来这里直接 return，于是 delta 已经把「呃」推到
          // 屏幕上、而唯一的清空信号不来了 —— 气泡就永久留着。
          this.options.emit({ type: 'user_transcript', text: '', final: true });
          return;
        }
        this.transcript.push({ role: 'user', text, at: Date.now() });
        this.options.emit({ type: 'user_transcript', text, final: true });
        // 语音回合同样会出现「嘴上答应、不调工具」，所以这里也要兜一刀。
        this.armToolNudge(text);
        return;
      }
      case 'conversation.item.input_audio_transcription.failed': {
        // ASR 失败也要把气泡收掉，否则半句话永久留在屏幕上。
        reportDiagnostic(`asr: ⚠ 转写失败 ${event.error?.message ?? '(无消息)'}`);
        this.userPartial = '';
        this.options.emit({ type: 'user_transcript', text: '', final: true });
        // 不弹 error：转写失败通常不影响她听懂（音频本身照常进模型），
        // 弹一个用户无法处理的报错只会添乱。
        return;
      }
      case 'response.audio_transcript.delta':
      case 'response.text.delta': {
        this.petPartial += event.delta ?? '';
        this.options.emit({ type: 'pet_transcript', text: this.petPartial, final: false });
        return;
      }
      case 'response.audio_transcript.done':
      case 'response.text.done': {
        const payload =
          event.type === 'response.audio_transcript.done' ? event.transcript : event.text;
        const text = (payload ?? this.petPartial).trim();
        this.petPartial = '';
        if (!text) return;
        this.transcript.push({ role: 'pet', text, at: Date.now() });
        this.options.emit({ type: 'pet_transcript', text, final: true });
        return;
      }

      case 'response.thinking.delta': {
        const text = event.delta ?? '';
        if (text) this.options.emit({ type: 'thinking', text });
        this.setActivity('thinking');
        return;
      }
      case 'response.thinking.done':
        return;

      // ---- 音频 ----
      case 'response.audio.delta': {
        // 被打断后在途的增量必须丢掉，否则刚清空的环又被填上。
        if (this.suppressAudio) {
          if (!this.suppressLogged) {
            this.suppressLogged = true;
            reportDiagnostic('turn: ⚠ 音频增量被抑制闸门丢弃（打断后的在途数据）');
          }
          return;
        }
        if (!this.firstDeltaLogged) {
          this.firstDeltaLogged = true;
          reportDiagnostic('turn: 收到第一段回复音频');
        }
        this.hadAudioOutput = true;
        this.speech.enqueue(event.delta);
        return;
      }
      case 'response.audio.done':
        return;

      case 'response.created': {
        reportDiagnostic('turn: 服务端开始生成回复');
        // 告诉 UI「上一句可以收了」。必须在这里发而不是让 UI 自己猜：
        // 这是唯一一个「新回合开始」一定先于本轮任何字幕的时刻。
        this.options.emit({ type: 'turn_start' });
        this.shieldWhileSpeaking();
        this.firstDeltaLogged = false;
        this.responseActive = true;
        this.activeResponseId =
          (event.response as { id?: string }).id ?? null;
        // 新的一轮开始了，之前打断留下的在途音频已经结束。
        this.clearSuppressExpiry();
        this.suppressAudio = false;
        this.suppressLogged = false;
        this.resetTurnState();
        return;
      }
      case 'response.cancelled': {
        this.responseActive = false;
        this.activeResponseId = null;
        // 取消之后没有 response.done 会来，所以必须自己把活动状态落地 ——
        // 不然就永久停在 thinking（三点气泡不走、点她不说话）。
        this.resolveIdleActivity();
        return;
      }
      case 'response.done': {
        const done = event.response as { id?: string; status?: string };
        // **必须对 id**：服务端 VAD 会在一轮还没结束时自己开下一轮，于是上一轮
        // 迟到的 done 会把**新**那一轮的 responseActive 清零 —— 她明明在说话，
        // `speaking` 却成了假，「不可打断」规则随即被绕过（D2 那条的另一个入口）。
        if (done.id && this.activeResponseId && done.id !== this.activeResponseId) {
          reportDiagnostic(`turn: 忽略上一轮迟到的 response.done（${done.id}）`);
          return;
        }
        this.responseActive = false;
        this.activeResponseId = null;
        if (done.status === 'failed') {
          this.options.emit({ type: 'error', message: '这一轮没说完，再说一次试试。' });
        }
        this.resolveIdleActivity();
        return;
      }
      case 'response.output_item.done':
        return;

      // ---- 工具 ----
      case 'response.function_call_arguments.delta':
        return;
      case 'response.function_call_arguments.done': {
        void this.runTool({ callId: event.call_id, name: event.name, args: event.arguments });
        return;
      }

      case 'unknown': {
        // 服务端随时可能加事件。记一笔继续跑，绝不断会话。
        console.debug('[RealtimeSession] 未知事件', event.rawType);
        return;
      }
    }
  }

  private async runTool(call: PendingCall): Promise<void> {
    this.awaitingToolFor = null;
    const name = call.name as ToolName;

    // 幂等：同一个 call_id 重复到达（重试/重放）直接回上次结果，不重复执行副作用。
    const cached = this.toolResults.get(call.callId);
    if (cached) {
      this.replyTool(call.callId, cached, false);
      return;
    }
    if (this.inFlightTools.has(call.callId)) return;

    if (!toolNames.includes(name)) {
      this.replyTool(call.callId, { ok: false, message: `没有叫 ${call.name} 的工具。` }, true);
      return;
    }

    this.toolCallsThisTurn++;
    if (this.toolCallsThisTurn > MAX_TOOL_CALLS_PER_TURN) {
      const result: ToolResult = {
        ok: false,
        message: `这一轮已经用掉 ${MAX_TOOL_CALLS_PER_TURN} 次工具了，先把结果告诉用户，别再调了。`,
      };
      this.toolResults.set(call.callId, result);
      this.replyTool(call.callId, result, true);
      return;
    }

    let args: unknown;
    try {
      args = call.args.trim() ? JSON.parse(call.args) : {};
    } catch {
      this.replyTool(
        call.callId,
        { ok: false, message: '参数不是合法 JSON，重新调用一次。' },
        true,
      );
      return;
    }
    // 模型给的参数一律不可信。
    const schema = toolArgSchemas[name];
    const parsed = schema.safeParse(args);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join('.') || '参数'}: ${i.message}`)
        .join('；');
      this.replyTool(call.callId, { ok: false, message: `参数不合法（${detail}）。` }, true);
      return;
    }

    this.inFlightTools.add(call.callId);
    this.options.emit({ type: 'tool_start', name, args: parsed.data });
    let result: ToolResult;
    try {
      result = await this.options.executeTool(name, parsed.data);
    } catch (error) {
      result = {
        ok: false,
        message: `工具执行失败：${error instanceof Error ? error.message : '未知错误'}。如实告诉用户没做成。`,
      };
    } finally {
      this.inFlightTools.delete(call.callId);
    }
    this.toolResults.set(call.callId, result);
    this.options.emit({ type: 'tool_end', name, result });
    this.replyTool(call.callId, result, true);
  }

  /** 回灌工具结果并要求她继续说。 */
  private replyTool(callId: string, result: ToolResult, createResponse: boolean): void {
    const ok = this.send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(result) },
    });
    if (ok && createResponse) this.send({ type: 'response.create' });
  }

  // ---- 收摊 ----

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.rotateTimer) clearTimeout(this.rotateTimer);
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
    this.reconnectTimer = null;
    this.rotateTimer = null;
    this.nudgeTimer = null;
    this.clearSuppressExpiry();
  }

  async stop(): Promise<void> {
    this.started = false;
    this.micWanted = false;
    this.closedByUs = true;
    this.epoch++;
    this.clearTimers();
    this.mic.stop();
    this.speech.flush();
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close(1000, 'stop');
    } catch {
      /* 已经关了 */
    }
    // 停会话要把所有跨回合状态一起作废，否则下次 start() 会带着上一次的
    // responseActive / 丢弃闸门 / 卡住的气泡文本开场。
    this.abandonTurn();
    this.cancelBargeInTimer();
    if (this.activityWatchdog) {
      clearInterval(this.activityWatchdog);
      this.activityWatchdog = null;
    }
    this.lastActivity = 'idle';
    this.options.emit({ type: 'activity', value: 'idle' });
    this.options.emit({ type: 'connection', state: 'closed' });
  }

  async dispose(): Promise<void> {
    if (this.activityWatchdog) {
      clearInterval(this.activityWatchdog);
      this.activityWatchdog = null;
    }
    await this.stop();
    await this.speech.dispose();
  }
}
