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
import { buildInstructions, summarizeTranscript, textNeedsTool } from './persona';
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
   */
  async start(withMic = true): Promise<void> {
    if (this.session) {
      if (withMic) await this.session.enableMic();
      return;
    }
    // 并发 start（比如用户快速点两下）只跑一次。
    if (this.starting) return this.starting;
    this.starting = this.doStart(withMic).finally(() => {
      this.starting = null;
    });
    return this.starting;
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

  /** 手动打断（点她一下、按热键）。 */
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
   * 设置变了（隐私开关等）→ 重新生成 instructions 推给模型，
   * 这样她立刻知道自己现在能看什么、不能看什么。
   */
  async refreshSettings(): Promise<Settings> {
    const settings = await this.loadSettings();
    this.session?.setInstructions(
      buildInstructions({
        settings,
        desktopAvailable: this.desktop.available,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    );
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
