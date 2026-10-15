// chat 模式的大脑。**公开 API 与 brain/Brain.ts 完全一致** —— UI 侧只需要一个
// 工厂按 settings.brainMode 选一个实现，不用在界面里到处 if（见 ./factory.ts）。
//
// 它和 Brain 的内部结构完全不同：
//   Brain      → RealtimeSession（WebSocket 全双工，模型自己出音频）
//   ChatBrain  → ChatSession（HTTP 流式）+ SpeechSynthesizer（我们自己按句合成）
//                + PushToTalkRecorder（我们自己攒音频提交 ASR）
//
// 语音输入**只有按住说话**：没有服务端 VAD，持续聆听要自己断句，不做（见 ./listen.ts）。
// 转写出来的文本直接喂 sendText()，所以字幕、工具、TTS 全部复用打字那条链。
//
// 哪些方法在这个模式下是空操作，以及为什么，见各方法的注释。
import { toolDefinitions, type PetEvent, type ToolName } from '../../../../../shared/brain';
import type { Credentials, Desktop, Settings } from '../../../../../shared/desktop';
import { desktop as defaultDesktop } from '../../platform/desktop';
import { SpeechStream } from '../../voice/SpeechStream';
import type { MicStreamEvents } from '../../voice/MicStream';
import { createToolExecutor, type ToolExecutorHandle } from '../tools';
import { ChatSession, type TranscriptEntry } from './ChatSession';
import { PushToTalkRecorder, type MicLike } from './listen';
import { chatInstructionsFor } from './persona';
import { SpeechSynthesizer, type SpeechSink } from './tts';

/** 播放侧需要的能力。真实实现是 voice/SpeechStream.ts。 */
export type AudioOutput = SpeechSink & {
  start(): Promise<void>;
  dispose(): Promise<void>;
  readonly audioLevel: number;
};

export type AudioOutputEvents = {
  onLevel(level: number): void;
  onStarted(): void;
  onDrained(): void;
  onError(message: string): void;
};

export type ChatBrainOptions = {
  /** 注入点，测试里可以塞假的。 */
  desktop?: Desktop;
  /**
   * 注入播放侧。默认 new SpeechStream(events)。
   * 测试和探测脚本在 Node 里跑，没有 AudioContext，必须换掉它。
   */
  createAudio?: (events: AudioOutputEvents) => AudioOutput;
  /** 注入 fetch，测试里塞假的。 */
  fetchImpl?: typeof fetch;
  /**
   * 注入采集侧。默认 new MicStream(events)。
   * 测试和探测脚本在 Node 里跑，没有 AudioContext，必须换掉它。
   */
  createMic?: (events: MicStreamEvents) => MicLike;
};

export class ChatBrain {
  private readonly desktop: Desktop;
  private listeners = new Set<(event: PetEvent) => void>();
  private settings: Settings | null = null;
  private credentials: Credentials | null = null;
  private session: ChatSession | null = null;
  private synth: SpeechSynthesizer | null = null;
  private audio: AudioOutput | null = null;
  private tools: ToolExecutorHandle | null = null;
  private recorder: PushToTalkRecorder | null = null;
  private level = 0;
  private starting: Promise<void> | null = null;

  constructor(private readonly options: ChatBrainOptions = {}) {
    this.desktop = options.desktop ?? defaultDesktop;
  }

  /** 订阅 PetEvent，返回取消函数。 */
  on(listener: (event: PetEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit = (event: PetEvent): void => {
    if (event.type === 'activity' && event.value === 'idle') this.level = 0;
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        // 一个订阅者抛错不能影响其他订阅者或会话。
        console.error('[ChatBrain] 订阅者抛错', error);
      }
    }
  };

  /** 0..1，驱动口型。每帧读，不走事件。 */
  get audioLevel(): number {
    return this.level;
  }

  get running(): boolean {
    return this.session !== null;
  }

  /** 内存里的对话记录。只读副本，退出即丢。 */
  get transcript(): readonly TranscriptEntry[] {
    return this.session?.transcript ?? [];
  }

  private async loadSettings(): Promise<Settings> {
    this.settings = await this.desktop.getSettings();
    return this.settings;
  }

  private async loadCredentials(): Promise<Credentials> {
    this.credentials ??= await this.desktop.credentials();
    return this.credentials;
  }

  /**
   * 准备好这个模式需要的一切。
   *
   * withMic 在这里被**忽略**，而且连麦克风都不碰：
   * - 它的含义是「持续聆听」，chat 模式没有服务端 VAD，这一版不做（见 ./listen.ts）；
   * - 语音输入只有「按住说话」，权限在第一次长按时才申请 —— 一启动就弹权限框
   *   的桌宠会被当成流氓软件。
   *
   * 仍然要在用户手势里调一次：AudioContext 必须在手势里 resume，
   * 否则表现为「一切正常但没声音」。
   */
  async start(withMic = true): Promise<void> {
    if (this.session) return;
    if (this.starting) return this.starting;
    this.starting = this.doStart(withMic).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async doStart(withMic: boolean): Promise<void> {
    if (withMic) {
      console.info('[ChatBrain] chat 模式没有持续聆听，语音输入只有按住说话。');
    }
    let credentials: Credentials;
    let settings: Settings;
    try {
      [credentials, settings] = await Promise.all([this.loadCredentials(), this.loadSettings()]);
    } catch (error) {
      this.emit({
        type: 'error',
        message: `拿不到 API 凭据，智能模式起不来：${error instanceof Error ? error.message : '未知错误'}`,
      });
      this.emit({ type: 'connection', state: 'closed' });
      return;
    }
    void credentials; // 凭据在这里只是先验证拿得到；实际用的时候再取（key 可能被换）。

    this.emit({ type: 'connection', state: 'connecting' });

    const createAudio =
      this.options.createAudio ?? ((events: AudioOutputEvents) => new SpeechStream(events));
    const audio = createAudio({
      onLevel: (level) => {
        this.level = level;
      },
      onStarted: () => this.emit({ type: 'activity', value: 'speaking' }),
      onDrained: () => {
        this.level = 0;
        this.session?.notifyDrained();
      },
      onError: (message) => this.emit({ type: 'error', message }),
    });
    this.audio = audio;
    try {
      await audio.start();
    } catch (error) {
      // 播放起不来不该让整个模式起不来 —— 文字还能用。
      this.emit({
        type: 'error',
        message: `声音通道起不来：${error instanceof Error ? error.message : '未知错误'}。文字还能用。`,
      });
    }

    const synth = new SpeechSynthesizer({
      getApiKey: async () => (await this.loadCredentials()).apiKey,
      // 每段都重新读设置里的音色：chat 模式换音色不用重建任何东西。
      getVoice: () => this.settings?.voice ?? settings.voice,
      getSpeechRate: () => this.settings?.speechRate ?? settings.speechRate,
      sink: audio,
      onError: (message) => this.emit({ type: 'error', message }),
      fetchImpl: this.options.fetchImpl,
    });
    this.synth = synth;

    const tools = createToolExecutor({
      desktop: this.desktop,
      // 每次工具执行都重新读设置：用户可能刚在托盘里改了开关。
      getSettings: () => this.loadSettings(),
      getCredentials: () => this.loadCredentials(),
      emit: this.emit,
    });
    this.tools = tools;

    this.session = new ChatSession({
      getApiKey: async () => (await this.loadCredentials()).apiKey,
      // 以设置里的 chatModel 为准（settingsSchema 默认 step-5-preview）。
      // credentials.chatModel 来自 .env，是给别的用途留的文本模型，不在这里当权威。
      getModel: () => this.settings?.chatModel ?? settings.chatModel,
      getInstructions: async () => {
        const current = await this.loadSettings();
        return chatInstructionsFor(current, this.desktop.available);
      },
      tools: toolDefinitions,
      executeTool: (name: ToolName, args: unknown) => tools.execute(name, args),
      emit: this.emit,
      speech: {
        // voiceEnabled 在这里判断而不是构造时判断：用户随时可能静音。
        // 静音时直接不合成 —— 省钱也省延迟，文字照常出。
        speak: (text) => {
          if (this.settings?.voiceEnabled === false) return;
          synth.speak(text);
        },
        cancel: () => synth.cancel(),
      },
      fetchImpl: this.options.fetchImpl,
    });

    // 录音器在这里就建好（构造它不碰麦克风，也不碰 AudioContext），
    // 这样「启动后第一个动作就是长按」不用等一次异步初始化。
    this.recorder = new PushToTalkRecorder({
      getApiKey: async () => (await this.loadCredentials()).apiKey,
      createMic: this.options.createMic,
      fetchImpl: this.options.fetchImpl,
      events: {
        // 转写结果走打字那条链：字幕、工具、TTS 一个都不用新写。
        onUtterance: (text) => {
          void this.sendText(text).catch((error: unknown) => {
            this.emit({
              type: 'error',
              message: `这句话没发出去：${error instanceof Error ? error.message : '未知错误'}`,
            });
          });
        },
        onError: (message) => this.emit({ type: 'error', message }),
        onNotice: (message) => this.emit({ type: 'notice', message }),
        onState: (state) => {
          // transcribing 映射成 thinking：对用户来说「她在琢磨我刚说的话」，
          // 转写和模型推理没有区别，不值得多一个 UI 状态。
          if (state === 'listening') this.emit({ type: 'activity', value: 'listening' });
          else if (state === 'transcribing') this.emit({ type: 'activity', value: 'thinking' });
          else this.emit({ type: 'activity', value: 'idle' });
        },
      },
    });

    this.emit({ type: 'connection', state: 'open' });
    this.emit({ type: 'activity', value: 'idle' });
  }

  /** 打字输入。会话没起来就先起。 */
  async sendText(text: string): Promise<void> {
    if (!text.trim()) return;
    if (!this.session) await this.start(false);
    await this.session?.sendText(text);
  }

  /**
   * 持续聆听这一版没有，如实告知。
   *
   * 为什么不偷偷降级成「按住说话」：用户点麦克风按钮的预期是「从现在起你一直听着」，
   * 给他一个要一直按住的入口而不说清楚，他会对着麦克风说半天然后以为是 bug。
   *
   * 用 notice 而不是 error：这是能力说明，不是故障（UI 给 error 配的是告警样式）。
   */
  async enableMic(): Promise<void> {
    this.emit({
      type: 'notice',
      message: '智能模式不能一直听着，但可以长按我说话 —— 按住说，松手我就去想。',
    });
  }

  /** 空操作：这个模式不会常开麦克风，没有要关的。长按的麦克风由录音器自己收。 */
  disableMic(): void {}

  /**
   * 「按住说话」—— chat 模式**唯一**的语音入口。
   *
   * 麦克风权限在这里第一次申请（不在 start() 里）。会话还没起来就先起，
   * 这样「启动后第一个动作就是长按」也能用（和 Brain 的行为一致）。
   *
   * 不会 reject：长按手势不该因为模式不同而需要 try/catch。失败走 error 事件。
   */
  async beginPushToTalk(): Promise<void> {
    if (!this.session) await this.start(false);
    await this.recorder?.begin();
  }

  /** 松手 = 说完了。这里才真正提交音频去转写（太短的会被当误触静默丢掉）。 */
  endPushToTalk(): void {
    this.recorder?.end();
  }

  /** 按住说话进行中（手指还按着）。转写在途时为 false —— 那时已经松手了。 */
  get pushToTalkActive(): boolean {
    return this.recorder?.active ?? false;
  }

  /**
   * 恒为 false：**持续聆听**在这个模式下不存在。
   *
   * 语义是「她是不是一直开着麦在听」，不是「设置里的 listening 开关是什么」，
   * 也不是「此刻有没有在采集」—— 按住说话期间的采集状态看 pushToTalkActive。
   * UI 依赖它来决定要不要显示常驻的「正在听」指示，返回 true 会显示一个不存在的状态。
   * 设置本身仍然保留（切回 realtime 模式后照旧生效）。
   */
  get listening(): boolean {
    return false;
  }

  /**
   * 恒为 false。
   *
   * 语音自动打断需要「她说话时也开着麦 + VAD」，两者在这个模式下都没有
   * （按住说话期间她本来就该闭嘴）。
   * 手动打断（点她一下、按 Esc）走 interrupt()，不受这个值影响，照常可用。
   */
  get voiceInterruptible(): boolean {
    return false;
  }

  /**
   * 手动打断（点她一下、按热键）。
   *
   * 连在途的录音/转写一起废掉：不然用户按了「停」之后几秒，上一句的转写回来了，
   * 又凭空发起一轮对话（工具会真的执行）。
   */
  interrupt(): void {
    this.recorder?.cancel();
    this.session?.interrupt();
    this.synth?.cancel();
    this.level = 0;
    this.emit({ type: 'activity', value: 'idle' });
  }

  /**
   * 换音色。写回设置即可 —— 下一段 TTS 就是新音色。
   *
   * 这里和 realtime 不一样：realtime 首次出音后 voice 不可改，换音色要静默重建
   * 整个会话；chat 模式的音色是**每次合成请求的参数**，所以既不丢上下文也不断连。
   */
  async setVoice(voice: string): Promise<void> {
    this.settings = await this.desktop.setSettings({ voice });
  }

  /**
   * 设置变了（隐私开关等）→ 重新读一遍。
   *
   * 不需要像 realtime 那样把 instructions 推给服务端：chat 模式每轮都重新生成
   * system prompt（见 ChatSession 的 getInstructions），所以下一句话自动生效。
   */
  async refreshSettings(): Promise<Settings> {
    return this.loadSettings();
  }

  async stop(): Promise<void> {
    const session = this.session;
    const synth = this.synth;
    const audio = this.audio;
    const tools = this.tools;
    const recorder = this.recorder;
    this.session = null;
    this.synth = null;
    this.audio = null;
    this.tools = null;
    this.recorder = null;
    this.level = 0;
    // 录音器先收：麦克风必须在这一刻就放掉（系统录音指示灯要灭），
    // 在途的转写也一起废掉 —— 切模式之后还冒出来一句话是最糟的表现。
    recorder?.dispose();
    session?.interrupt();
    synth?.dispose();
    tools?.dispose();
    await audio?.dispose();
    this.emit({ type: 'activity', value: 'idle' });
    this.emit({ type: 'connection', state: 'closed' });
  }

  async dispose(): Promise<void> {
    await this.stop();
    this.listeners.clear();
  }
}
