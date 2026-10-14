// chat 模式的大脑。**公开 API 与 brain/Brain.ts 完全一致** —— UI 侧只需要一个
// 工厂按 settings.brainMode 选一个实现，不用在界面里到处 if（见 ./factory.ts）。
//
// 它和 Brain 的内部结构完全不同：
//   Brain      → RealtimeSession（WebSocket 全双工，模型自己出音频）
//   ChatBrain  → ChatSession（HTTP 流式）+ SpeechSynthesizer（我们自己按句合成）
//
// 哪些方法在这个模式下是空操作，以及为什么，见各方法的注释。
import { toolDefinitions, type PetEvent, type ToolName } from '../../../../../shared/brain';
import type { Credentials, Desktop, Settings } from '../../../../../shared/desktop';
import { desktop as defaultDesktop } from '../../platform/desktop';
import { SpeechStream } from '../../voice/SpeechStream';
import { createToolExecutor, type ToolExecutorHandle } from '../tools';
import { ChatSession, type TranscriptEntry } from './ChatSession';
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
   * withMic 在这里被**忽略**：chat 模式没有 realtime 的服务端 VAD，这一版只接
   * 文字输入（方案见 docs/BRAIN_MODES.md）。不在这里报错是因为 UI 的默认调用是
   * start(true)，每次启动弹一个错误没有意义；用户**主动**点麦克风时才告诉他
   * （见 enableMic）。
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
      console.info('[ChatBrain] chat 模式这一版不接语音输入，已忽略 withMic。');
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
   * 空操作 + 如实告知。
   *
   * chat 模式没有 realtime 的服务端 VAD，这一版不接语音输入。做成空操作而不是
   * 偷偷降级，是因为用户点了麦克风按钮就是想说话 —— 不告诉他，他会对着麦克风
   * 说半天然后以为是 bug。
   */
  async enableMic(): Promise<void> {
    this.emit({
      type: 'error',
      message: '智能模式这一版还不能听你说话，先打字吧。想用语音就在菜单里切回默认模式。',
    });
  }

  /** 空操作：这个模式从来没开过麦克风。 */
  disableMic(): void {}

  /**
   * 「按住说话」。chat 模式这一版没有语音输入，所以这是空操作 —— 但会告诉用户。
   *
   * 为什么选「发 error 事件」而不是完全静默：长按桌宠是一个**明确的用户动作**，
   * 他按下去就是想说话。静默失败的表现是「按住、说完、松手、什么都没发生」，
   * 用户只会以为是 bug。和 enableMic 一个道理。
   *
   * 为什么不抛异常：App.tsx 的长按手势不该因为模式不同而需要 try/catch。
   */
  async beginPushToTalk(): Promise<void> {
    // notice 而不是 error：这是能力说明，不是故障。
    // UI 给 error 配的是告警样式，用红框显示「本模式只支持打字」会让人以为出问题了。
    this.emit({
      type: 'notice',
      message: '智能模式现在只支持打字。想按住说话就在菜单里切回默认模式。',
    });
  }

  /** 空操作：没有在进行的按住说话可以结束。不发事件 —— 按下时已经说过一次了。 */
  endPushToTalk(): void {}

  /** 恒为 false：这个模式永远没有「正在按住说话」的状态。 */
  get pushToTalkActive(): boolean {
    return false;
  }

  /**
   * 恒为 false。
   *
   * 语义是「她现在是不是在采集音频」，而不是「设置里的 listening 开关是什么」——
   * chat 模式不碰麦克风，所以答案永远是 false，和设置里写的无关。UI 依赖它来决定
   * 要不要显示「正在听」的指示，返回 true 会显示一个不存在的状态。
   * 设置本身仍然保留（切回 realtime 模式后照旧生效）。
   */
  get listening(): boolean {
    return false;
  }

  /**
   * 恒为 false。
   *
   * 语音打断需要麦克风和 VAD，两者在这个模式下都没有。
   * 手动打断（点她一下、按 Esc）走 interrupt()，不受这个值影响，照常可用。
   */
  get voiceInterruptible(): boolean {
    return false;
  }

  /** 手动打断（点她一下、按热键）。 */
  interrupt(): void {
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
    this.session = null;
    this.synth = null;
    this.audio = null;
    this.tools = null;
    this.level = 0;
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
