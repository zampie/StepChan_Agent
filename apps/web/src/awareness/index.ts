// 主动感知层的门面。start/stop + onIntent 回调，就这些。
//
// 边界：awareness/ **不 import voice/ 也不 import brain/**。它只产出 AwarenessIntent，
// 由集成层决定要不要真的让她开口、要不要先冒 privacy_notice。
// 唯一的外部依赖是 shared/desktop.ts 的 Desktop 契约（而且只取其中四个方法）
// 与 shared/pet.ts 的 spots —— 这两个都是冻结契约，不是别人的实现。
//
// 设置不缓存在构造期：托盘菜单随时会改开关，所以每个 tick 异步刷一次快照。
// 前台应用事件可能落在两次 tick 之间，那时用的是最多 tickMs 旧的快照 ——
// Rust 侧对 appAwareness 也有一道独立闸门，所以这点延迟不会越过隐私底线。
import { defaultSettings } from '../../../../shared/desktop';
import { DropReactor } from './DropReactor';
import { FrontmostReactor } from './FrontmostReactor';
import { IdleBehavior } from './IdleBehavior';
import type {
  ActivityProbe,
  AwarenessDesktop,
  AwarenessIntent,
  DragDropPayload,
  FrontmostApp,
  IntentSink,
  Random,
  Settings,
  Spot,
} from './types';

export * from './types';
export { DropReactor, basename, categorize, describePaths, extension, previewText } from './DropReactor';
export { FrontmostReactor } from './FrontmostReactor';
export { IdleBehavior } from './IdleBehavior';
export type { IdleEffect, IdlePhase } from './IdleBehavior';

/** 空闲状态机的推进间隔。 */
export const DEFAULT_TICK_MS = 5_000;

/**
 * 拿不到真实设置时的保底值。直接复用 shared/desktop.ts 的 defaultSettings，
 * 不在这儿手抄一份 —— 契约加字段时手抄的那份会悄悄漂移
 * （clipboardAwareness 就是这么加进来的）。那份默认值隐私项全关，正是我们要的保守侧。
 */
const FALLBACK_SETTINGS: Settings = defaultSettings;

export type AwarenessOptions = {
  desktop: AwarenessDesktop;
  probe: ActivityProbe;
  /** 拿到意图的回调。集成层在这里决定怎么路由。 */
  onIntent: IntentSink;
  now?: () => number;
  random?: Random;
  tickMs?: number;
  /** 注入定时器，返回取消函数。测试里传一个什么都不做的实现，然后手动调 tick()。 */
  startTimer?: (fn: () => void, ms: number) => () => void;
  /** 她的初始位置，用来避免第一次自主位移挪到原地。 */
  spot?: Spot;
};

export class Awareness {
  readonly frontmost: FrontmostReactor;
  readonly drop: DropReactor;
  readonly idle: IdleBehavior;

  private readonly now: () => number;
  private readonly tickMs: number;
  private readonly startTimer: (fn: () => void, ms: number) => () => void;
  private settingsSnapshot: Settings = FALLBACK_SETTINGS;
  private disposers: Array<() => void> = [];
  private stopTimer: (() => void) | null = null;
  private running = false;
  private refreshing = false;

  constructor(private readonly options: AwarenessOptions) {
    this.now = options.now ?? (() => Date.now());
    this.tickMs = options.tickMs ?? DEFAULT_TICK_MS;
    this.startTimer =
      options.startTimer ??
      ((fn, ms) => {
        const handle = setInterval(fn, ms);
        return () => clearInterval(handle);
      });
    this.frontmost = new FrontmostReactor({ probe: options.probe });
    this.drop = new DropReactor();
    this.idle = new IdleBehavior({
      probe: options.probe,
      random: options.random,
      startedAt: this.now(),
      spot: options.spot,
    });
  }

  /** 当前设置快照（只读，诊断与测试用）。 */
  get settings(): Settings {
    return this.settingsSnapshot;
  }

  get active(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    await this.refreshSettings();

    const { desktop } = this.options;
    this.disposers = [
      desktop.onFrontmostChanged((app) => this.handleFrontmost(app)),
      desktop.onDragDrop((payload) => this.handleDrop(payload)),
    ];
    this.stopTimer = this.startTimer(() => this.tick(), this.tickMs);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    this.stopTimer?.();
    this.stopTimer = null;
    // 停下来就把观测状态丢干净，不留着下次 start 时发一句过期的话。
    this.frontmost.reset();
    this.drop.reset();
    this.idle.reset(this.now());
  }

  /** 用户互动了（说话、点桌宠、按热键）。集成层负责在这些地方调。 */
  notifyInteraction(): void {
    const now = this.now();
    this.frontmost.noteInteraction(now);
    this.apply(this.idle.noteInteraction(now));
  }

  /** 她被挪到了某个位置（比如模型调了 move_to）。同步一下避免挪到原地。 */
  notifyMoved(spot: Spot): void {
    this.idle.noteSpot(spot, this.now());
  }

  /** 推进空闲状态机并刷新设置快照。start() 之后由定时器驱动；测试里手动调。 */
  tick(): void {
    if (!this.running) return;
    void this.refreshSettings();
    this.apply(this.idle.tick(this.settingsSnapshot, this.now()));
  }

  private handleFrontmost(app: FrontmostApp): void {
    if (!this.running) return;
    const intent = this.frontmost.handle(app, this.settingsSnapshot, this.now());
    if (intent) this.emit(intent);
  }

  private handleDrop(payload: DragDropPayload): void {
    if (!this.running) return;
    const intent = this.drop.handle(payload, this.now());
    if (intent) this.emit(intent);
  }

  private apply(effects: ReturnType<IdleBehavior['tick']>): void {
    for (const effect of effects) {
      if (effect.type === 'move') {
        // 位移失败不该让整条链炸掉（窗口可能刚好被关了）。
        void Promise.resolve(this.options.desktop.moveToSpot(effect.spot)).catch(() => {});
      } else {
        this.emit(effect.intent);
      }
    }
  }

  private emit(intent: AwarenessIntent): void {
    this.options.onIntent(intent);
  }

  private async refreshSettings(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      this.settingsSnapshot = await this.options.desktop.getSettings();
    } catch {
      // 拿不到设置就按"全关"走 —— 隐私相关的默认必须是保守的那一侧。
      this.settingsSnapshot = FALLBACK_SETTINGS;
    } finally {
      this.refreshing = false;
    }
  }
}
