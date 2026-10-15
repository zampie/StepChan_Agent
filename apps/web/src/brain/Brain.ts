// 大脑：把实时会话、工具执行器、设置缝在一起，对 UI 只暴露一个小 API。
//
// UI 不直接接触 realtime 事件，也不直接调 desktop —— 它只 on(PetEvent) 和读 audioLevel。
// 这样 Track C 的渲染器和这一层之间只有 shared/brain.ts 一个契约。
//
// transcript 只在内存里。退出即丢，不落盘（见 AGENTS.md 隐私条款）。
import { toolDefinitions, type PetEvent, type ToolName } from '../../../../shared/brain';
import type { Credentials, Desktop, Settings } from '../../../../shared/desktop';
import { desktop as defaultDesktop } from '../platform/desktop';
import { RealtimeSession, type TranscriptEntry } from '../voice/RealtimeSession';
import { buildInstructions, textRequestsMove, summarizeTranscript, textNeedsTool } from './persona';
import { createToolExecutor, type ToolExecutorHandle } from './tools';

export type BrainOptions = {
  /** 注入点，测试里可以塞假的。 */
  desktop?: Desktop;
};

export class Brain {
  private readonly desktop: Desktop;
  private session: RealtimeSession | null = null;
  private tools: ToolExecutorHandle | null = null;
  private listeners = new Set<(event: PetEvent) => void>();
  private settings: Settings | null = null;
  private credentials: Credentials | null = null;
  private level = 0;
  private starting: Promise<void> | null = null;

  constructor(options: BrainOptions = {}) {
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
        console.error('[Brain] 订阅者抛错', error);
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

  /** 内存里的对话记录。只读副本。 */
  get transcript(): readonly TranscriptEntry[] {
    return this.session?.transcript ?? [];
  }

  /**
   * 持续聆听是否开着。关着的时候只有长按桌宠才采集音频。
   *
   * **会话在跑的时候以会话为准**，不以 `this.settings` 为准。两者是同一个事实的
   * 两个真相源，而且会无声漂移：`this.settings` 会被 `loadSettings()` 顺手刷新
   * （工具执行器每执行一次工具就刷一次），而会话里的值只有 `setListening()` 能改。
   * 漂移之后 UI 按「按住说话」处理、会话按「持续聆听」处理 —— 用户按住、说完、
   * 松手，什么都不会发生，而且两边都不报错。
   *
   * 设置还没读到、或者会话没起来时按默认值（true）算。
   */
  get listening(): boolean {
    return this.session?.listening ?? this.settings?.listening ?? true;
  }

  /** 语音能不能自动打断她。注意 interrupt() 不受它影响。 */
  get voiceInterruptible(): boolean {
    return this.session?.interruptible ?? this.settings?.voiceInterruptible ?? false;
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
   * 开始一次会话。withMic=false 时只建连接不碰麦克风 —— 纯打字模式不该
   * 弹权限对话框。
   *
   * 「按住说话」模式（settings.listening=false）也不会在这里开麦：即使调用方
   * 传了 withMic=true，麦克风权限也要留到用户第一次长按时再申请。
   */
  async start(withMic = true): Promise<void> {
    // 并发 start（启动流程 + 托盘 + 热键会同时打过来）只真正跑一次。
    if (this.starting) {
      await this.starting;
    } else if (!this.session) {
      this.starting = this.doStart(withMic).finally(() => {
        this.starting = null;
      });
      await this.starting;
    }
    // 会话已经在了（或者刚被别的调用方用 withMic=false 起起来）：
    // 这里补开麦克风，否则「先打字起会话、再从托盘开语音」会一直没麦。
    // enableMic() 自己会在按住说话模式下拒绝常开麦。
    if (withMic) await this.session?.enableMic();
  }

  private async doStart(withMic: boolean): Promise<void> {
    let credentials: Credentials;
    let settings: Settings;
    try {
      [credentials, settings] = await Promise.all([this.loadCredentials(), this.loadSettings()]);
    } catch (error) {
      this.emit({
        type: 'error',
        message: `拿不到 API 凭据，语音起不来：${error instanceof Error ? error.message : '未知错误'}`,
      });
      this.emit({ type: 'connection', state: 'closed' });
      return;
    }

    const tools = createToolExecutor({
      // move_to 的程序化闸门：以本回合用户最后说的那句话为准。
      // 她自己想换地方待着时这里是 false，工具会被拒 —— 这是乱跳的根治办法，
      // 比在 instructions 里求她别乱动可靠。
      movementRequested: () => {
        // 取 transcript 里最后一条用户发言。不另存一份 lastUserText：
        // 那会和 session 的 transcript 产生两个真相源，换会话时必然漂。
        const entries = this.session?.transcript ?? [];
        for (let i = entries.length - 1; i >= 0; i--) {
          if (entries[i].role === 'user') return textRequestsMove(entries[i].text);
        }
        return false;
      },
      desktop: this.desktop,
      // 每次工具执行都重新读设置：用户可能刚在托盘里改了开关。
      getSettings: () => this.loadSettings(),
      getCredentials: () => this.loadCredentials(),
      emit: this.emit,
    });
    this.tools = tools;

    const session = new RealtimeSession({
      apiKey: credentials.apiKey,
      model: credentials.realtimeModel,
      voice: settings.voice,
      instructions: buildInstructions({
        settings,
        desktopAvailable: this.desktop.available,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
      tools: toolDefinitions,
      executeTool: (name: ToolName, args: unknown) => tools.execute(name, args),
      // 两个开关的初值。之后用户从托盘改，走 refreshSettings() 热更新。
      listening: settings.listening,
      interruptible: settings.voiceInterruptible,
      emit: this.emit,
      textNeedsTool,
      summarize: (entries) => summarizeTranscript(entries),
      onLevel: (level) => {
        this.level = level;
      },
    });
    this.session = session;
    try {
      await session.start(withMic);
    } catch (error) {
      this.emit({
        type: 'error',
        message: `语音会话启动失败：${error instanceof Error ? error.message : '未知错误'}`,
      });
    }
  }

  /** 打字输入。会话没起来就先起（不开麦克风）。 */
  async sendText(text: string): Promise<void> {
    if (!text.trim()) return;
    if (!this.session) await this.start(false);
    this.session?.sendText(text);
  }

  async enableMic(): Promise<void> {
    if (!this.session) {
      await this.start(true);
      return;
    }
    await this.session.enableMic();
  }

  disableMic(): void {
    this.session?.disableMic();
  }

  /**
   * 长按桌宠开始说话。
   *
   * - 按住说话模式（settings.listening=false）：这是**唯一**的采集入口。
   *   麦克风在这里第一次申请权限，松手（endPushToTalk）时提交这一轮。
   * - 持续聆听模式：长按当「闭嘴，听我说」用 —— 先打断她，断句仍交给服务端 VAD。
   *
   * 会话还没起来就先起（不常开麦），这样「启动后第一个动作就是长按」也能用。
   */
  async beginPushToTalk(): Promise<void> {
    if (!this.session) await this.start(false);
    await this.session?.beginPushToTalk();
  }

  /** 松手。按住说话模式下这里才真正提交音频并要她回话。 */
  endPushToTalk(): void {
    this.session?.endPushToTalk();
  }

  /** 按住说话进行中（UI 可以据此显示「正在听」）。 */
  get pushToTalkActive(): boolean {
    return this.session?.pushToTalkActive ?? false;
  }

  /**
   * 手动打断（点她一下、按热键、长按）。
   * **不受 voiceInterruptible 开关影响** —— 开关只管语音能不能自动打断。
   */
  interrupt(): void {
    this.session?.interrupt();
  }

  /**
   * 换音色。首次出音后 voice 不可改，所以这会静默重建会话。
   * 同时写回设置，下次启动沿用。
   */
  async setVoice(voice: string): Promise<void> {
    this.settings = await this.desktop.setSettings({ voice });
    await this.session?.setVoice(voice);
  }

  /**
   * 设置变了（隐私开关、聆听模式、可打断）→ 把新值真正应用到**正在进行的会话**上，
   * 不是只在建会话时读一次。
   *
   * - instructions 重新生成并推下去，这样她立刻知道自己现在能看什么。
   * - voiceInterruptible 是纯本地行为，立即生效。
   * - listening 走 session.update 热改 turn_detection（已实测可以双向热改，
   *   不需要重建会话），并相应开/关麦克风。
   */
  async refreshSettings(): Promise<Settings> {
    const settings = await this.loadSettings();
    const session = this.session;
    if (!session) return settings;
    session.setInstructions(
      buildInstructions({
        settings,
        desktopAvailable: this.desktop.available,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    );
    session.setInterruptible(settings.voiceInterruptible);
    await session.setListening(settings.listening);
    return settings;
  }

  async stop(): Promise<void> {
    const session = this.session;
    const tools = this.tools;
    this.session = null;
    this.tools = null;
    this.level = 0;
    tools?.dispose();
    await session?.dispose();
  }

  async dispose(): Promise<void> {
    await this.stop();
    this.listeners.clear();
  }
}
