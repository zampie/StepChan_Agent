// 前台应用变化 → 要不要搭句话。
//
// 这是最容易变成骚扰的功能，所以闸门摞了四层，而且**顺序有讲究**：
//   1. 开关：settings.appAwareness 关着就彻底不动（Rust 侧也有一道，这里是第二道）。
//   2. 去重：切到同一个应用不重复触发；而且同一个应用在 MENTION_TTL 内只提一次
//      （防 A→B→A→B 来回切被当成两次"新鲜事"）。
//   3. 抑制：她正在说话、或者用户正在打字，一律闭嘴 —— 但**去重状态照常推进**，
//      这样抑制结束后不会突然补一句关于早就切走的应用的话。
//   4. 冷却 + 每小时配额：最后才花配额，顺序反了会把配额浪费在被抑制掉的事件上。
import { RateWindow, appKey } from './types';
import type { ActivityProbe, AwarenessIntent, FrontmostApp, Settings } from './types';

/** 两句搭话之间的最小间隔。 */
export const COOLDOWN_MS = 90_000;
/** 每小时最多主动搭话几次。 */
export const HOURLY_BUDGET = 8;
export const HOUR_MS = 3_600_000;
/** 同一个应用多久之内不重复提起。 */
export const MENTION_TTL_MS = 15 * 60_000;

export type FrontmostReactorOptions = {
  probe: ActivityProbe;
};

export class FrontmostReactor {
  private readonly budget = new RateWindow(HOUR_MS, HOURLY_BUDGET);
  /** 上一次观测到的应用键（无论有没有说话都会推进）。 */
  private lastKey: string | null = null;
  private lastSpokeAt = Number.NEGATIVE_INFINITY;
  /** key → 上次提起它的时间。 */
  private readonly mentioned = new Map<string, number>();

  constructor(private readonly options: FrontmostReactorOptions) {}

  /**
   * 处理一次前台应用变化。返回 null = 这次不说话。
   * now 由调用方给（注入时钟），这一层不读 Date.now()。
   */
  handle(app: FrontmostApp, settings: Settings, now: number): AwarenessIntent | null {
    // 1. 开关
    if (!settings.appAwareness) {
      // 关掉开关就把观测状态丢干净，重新打开时从零开始，不会拿着旧观测马上发言。
      this.reset();
      return null;
    }

    const key = appKey(app);
    if (!app || !key) return null;

    // 2. 去重：同一个应用反复切不算变化。
    if (key === this.lastKey) return null;
    this.lastKey = key;

    // 3. 抑制：注意这在 lastKey 推进之后 —— 抑制期间的切换被"吸收"掉，不积压。
    if (this.options.probe.busy() || this.options.probe.userTyping()) return null;

    const mentionedAt = this.mentioned.get(key);
    if (mentionedAt !== undefined && now - mentionedAt < MENTION_TTL_MS) return null;

    // 4. 冷却与配额
    if (now - this.lastSpokeAt < COOLDOWN_MS) return null;
    if (!this.budget.has(now)) return null;

    this.budget.take(now);
    this.lastSpokeAt = now;
    this.mentioned.set(key, now);
    this.pruneMentions(now);

    return {
      kind: 'frontmost',
      // 明确授权她"不值得说就别说"，否则模型倾向于每次都硬凑一句。
      prompt:
        `用户刚切到「${app.name}」。如果这个变化值得一提，就用一句话自然地搭个话；` +
        `不值得提就什么都别说。不要罗列你看到了什么，也别反复问他在忙什么。`,
      privacy: 'frontmost',
    };
  }

  /** 用户主动跟她互动了：重置冷却基准，免得紧接着又自顾自冒一句。 */
  noteInteraction(now: number): void {
    this.lastSpokeAt = Math.max(this.lastSpokeAt, now);
  }

  reset(): void {
    this.lastKey = null;
    this.lastSpokeAt = Number.NEGATIVE_INFINITY;
    this.mentioned.clear();
    this.budget.reset();
  }

  /** 诊断用。 */
  get budgetUsed(): number {
    return this.budget.used;
  }

  private pruneMentions(now: number): void {
    for (const [key, at] of this.mentioned) {
      if (now - at >= MENTION_TTL_MS) this.mentioned.delete(key);
    }
  }
}
