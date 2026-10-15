// 「按住说话」的采集端：长按→采 PCM16→松手→提交 ASR→一句文本。
//
// 只做按住说话，不做持续聆听。理由：chat 模式没有 realtime 的服务端 VAD，
// 持续聆听要自己做断句（或者换成双向流式 ASR 那条路），而按住说话的边界是
// 用户的手指给的 —— 松手就是说完了，不需要猜。
//
// 这一层只管「一段音频」的生命周期，不认识对话：转写出来的文本通过 onUtterance
// 交给 ChatBrain.sendText()，于是字幕、工具调用、TTS 全部复用打字那条链。
import { MicStream, micErrorMessage, type MicStreamEvents } from '../../voice/MicStream';
// 下限直接复用 realtime 侧的常量而不是另定一个：两边的「一帧」都是 MicStream 的
// 40ms 帧，误触的判定标准不该因为模式不同而不同。
import { MIN_PUSH_TO_TALK_FRAMES } from '../../voice/RealtimeSession';
import { REALTIME_SAMPLE_RATE } from '../../../../../shared/realtime';
import { transcribePcm16, AsrError } from './asr';
import { base64ToBytes, concatPcm16 } from './wav';

/**
 * 一次长按最多采多久。超过就**自动**提交，不是静默丢掉 ——
 * 丢掉等于用户说了半分钟然后什么都没发生。
 *
 * 30 秒也是上行体积的约束：30s × 24000 × 2 字节 = 1.4MB PCM，base64 后约 1.9MB。
 */
export const MAX_PUSH_TO_TALK_MS = 30_000;
/** 一帧 40ms（MicStream 的 frameSamples），换算成帧数上限。 */
const MAX_FRAMES = Math.round(MAX_PUSH_TO_TALK_MS / 40);

/** MicStream 的最小接口。测试和探测脚本在 Node 里跑，没有 AudioContext。 */
export type MicLike = {
  start(): Promise<void>;
  stop(): void;
};

export type PushToTalkEvents = {
  /** 识别出来的一句话（非空、已 trim）。 */
  onUtterance: (text: string) => void;
  /** 真故障：麦克风打不开、识别失败。UI 会用告警样式显示。 */
  onError: (message: string) => void;
  /** 不是故障，只是需要让用户知道一声（没听清、到 30 秒上限了）。 */
  onNotice: (message: string) => void;
  /** 采集/识别阶段，由 ChatBrain 映射成 activity 事件。 */
  onState: (state: 'listening' | 'transcribing' | 'idle') => void;
};

export type PushToTalkOptions = {
  getApiKey: () => Promise<string>;
  events: PushToTalkEvents;
  /** 注入点：默认 new MicStream(events)。 */
  createMic?: (events: MicStreamEvents) => MicLike;
  fetchImpl?: typeof fetch;
};

/**
 * 一次长按的录音器。
 *
 * 取消语义（这是本类存在的主要理由）：
 * - 每次 begin() / cancel() 自增 epoch，所有异步回调都要对 epoch。迟到的转写
 *   结果被丢掉，而不是在用户早就换了话题之后凭空发起一轮对话。
 * - 在途的 ASR 请求用 AbortController 真的废掉，不只是忽略结果（省钱，也省得
 *   服务端那边还在算）。
 * - 麦克风只在 begin()..end() 之间持有。任何退出路径都要 mic.stop()，
 *   否则系统录音指示灯不灭，用户会以为被偷听。
 */
export class PushToTalkRecorder {
  private readonly events: PushToTalkEvents;
  private readonly mic: MicLike;
  /** 用户的手指是不是还按着。pushToTalkActive 的权威。 */
  private pressed = false;
  /** 每次 begin/cancel 自增。 */
  private epoch = 0;
  private frames: Uint8Array[] = [];
  /** 在途的 ASR 请求。 */
  private inFlight: AbortController | null = null;
  /** MicStream 已经通过 onError 报过一次错 —— 不要再按异常重复报一遍。 */
  private micReported = false;
  private disposed = false;

  constructor(private readonly options: PushToTalkOptions) {
    this.events = options.events;
    const micEvents: MicStreamEvents = {
      onFrame: (base64) => this.collect(base64),
      onError: (message) => {
        this.micReported = true;
        this.events.onError(message);
      },
      onSampleRateMismatch: (actual, target) => {
        // 不是错误：worklet 会重采样到 target，所以 WAV 头里写 target 是对的。
        console.info(`[chat/listen] 麦克风给了 ${actual}Hz，worklet 重采样到 ${target}Hz。`);
      },
    };
    this.mic = (options.createMic ?? ((e) => new MicStream(e)))(micEvents);
  }

  /** 手指还按着（UI 据此显示「正在听」）。 */
  get active(): boolean {
    return this.pressed;
  }

  /** 已松手、转写还在途。 */
  get transcribing(): boolean {
    return this.inFlight !== null;
  }

  /**
   * 按下。麦克风权限**在这里**第一次申请 —— 不在 ChatBrain.start() 里，
   * 因为一启动就弹权限框的桌宠会被当成流氓软件。
   *
   * 不会 reject：长按是个手势，调用方不该为了模式不同而写 try/catch。
   * 失败走 onError。
   */
  async begin(): Promise<void> {
    if (this.disposed || this.pressed) return;
    // 新的一次长按作废上一次在途的转写：用户重新按了，说明上一句不算了。
    // 让它迟到发出去的后果比丢掉严重得多 —— 工具会真的执行（截屏、挪窗口）。
    this.abortInFlight();
    const epoch = ++this.epoch;
    this.pressed = true;
    this.frames = [];
    this.micReported = false;
    try {
      await this.mic.start();
    } catch (error) {
      if (epoch !== this.epoch) return;
      this.pressed = false;
      this.mic.stop();
      if (!this.micReported) this.events.onError(micErrorMessage(error));
      this.events.onState('idle');
      return;
    }
    // 权限框可能弹了几秒，期间用户早松手了。
    if (epoch !== this.epoch || !this.pressed) {
      this.mic.stop();
      return;
    }
    this.events.onState('listening');
  }

  /** 松手 = 这句话说完了。提交转写；太短就当误触，静默丢掉。 */
  end(): void {
    if (!this.pressed) return;
    this.pressed = false;
    this.mic.stop();
    const frames = this.frames;
    this.frames = [];
    if (frames.length < MIN_PUSH_TO_TALK_FRAMES) {
      // 误触（手指刚碰到就挪开）。空/过短的音频提交上去服务端会回错误，
      // 用户看到的是一个看不懂的故障 —— 什么都不说比那个好。
      console.info(`[chat/listen] 长按太短（${frames.length} 帧），当误触丢掉。`);
      this.events.onState('idle');
      return;
    }
    void this.transcribe(frames, this.epoch);
  }

  /**
   * 取消：切模式、interrupt()、dispose 都走这里。
   * 同步放掉麦克风、废掉在途请求 —— 用户按了「停」就该立刻停。
   */
  cancel(): void {
    const wasBusy = this.pressed || this.inFlight !== null;
    this.epoch++;
    this.pressed = false;
    this.frames = [];
    this.abortInFlight();
    this.mic.stop();
    if (wasBusy) this.events.onState('idle');
  }

  dispose(): void {
    this.cancel();
    this.disposed = true;
  }

  // ---- 内部 ----

  private abortInFlight(): void {
    this.inFlight?.abort();
    this.inFlight = null;
  }

  private collect(base64: string): void {
    if (!this.pressed) return;
    this.frames.push(base64ToBytes(base64));
    if (this.frames.length < MAX_FRAMES) return;
    // 到上限了：自动提交，而不是继续吃内存或静默丢弃。
    console.info(`[chat/listen] 到 ${MAX_PUSH_TO_TALK_MS / 1000}s 上限，自动提交这一段。`);
    this.events.onNotice(`一次最多听 ${MAX_PUSH_TO_TALK_MS / 1000} 秒，这段我先去想了。`);
    this.end();
  }

  private async transcribe(frames: Uint8Array[], epoch: number): Promise<void> {
    this.events.onState('transcribing');
    const abort = new AbortController();
    this.inFlight = abort;
    try {
      const apiKey = await this.options.getApiKey();
      if (epoch !== this.epoch) return;
      const text = await transcribePcm16({
        apiKey,
        samples: concatPcm16(frames),
        // worklet 保证输出就是这个采样率（设备不一致时它自己重采样），
        // 所以这里写常量而不是设备采样率。
        sampleRate: REALTIME_SAMPLE_RATE,
        signal: abort.signal,
        fetchImpl: this.options.fetchImpl,
      });
      if (epoch !== this.epoch) return;
      if (!text) {
        // 听了但没听出字（环境太吵、离麦太远）。这不是故障，别弹红框。
        this.events.onNotice('没听清你说什么，再按住说一次？');
        this.events.onState('idle');
        return;
      }
      // 不在这里发 user_transcript —— sendText 那条链会发（ChatSession.sendText），
      // 在这儿再发一次会让气泡里出现两条一样的话。
      this.events.onUtterance(text);
    } catch (error) {
      if (epoch !== this.epoch || abort.signal.aborted) {
        // 被取消：正常操作，不报错。
        return;
      }
      const message =
        error instanceof AsrError
          ? error.message
          : `拿不到转写结果：${error instanceof Error ? error.message : '未知错误'}。`;
      this.events.onError(message);
      this.events.onState('idle');
    } finally {
      if (this.inFlight === abort) this.inFlight = null;
    }
  }
}
