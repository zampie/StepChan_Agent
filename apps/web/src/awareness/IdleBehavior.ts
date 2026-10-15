// 空闲行为：没人理她的时候自己挪个位置、久了就打盹、有互动就醒。
//
// 这是整套里最容易惹人烦的东西（桌面上的窗口自己乱跑），所以默认关闭：
//   - settings.autonomy 关着 → 一个 effect 都不产出（默认就是关的）；
//   - settings.reduceMotion 开着 → 不挪窗口（打盹/醒来只是表情变化，照常）；
//   - 窗口不可见 → 暂停，而且**把空闲计时基准推到当前时刻**，
//     否则藏了二十分钟再显示出来会立刻判定"该睡了"。
//
// tick() 刻意只**返回** effect 而不自己执行：这样状态机是纯函数式的，
// 测试直接喂时间戳就能跑完整条时间线，不用假定时器也不用真的 sleep。
import { spots } from '../../../../shared/pet';
import type { ActivityProbe, AwarenessIntent, Random, Settings, Spot } from './types';

/** 多久没互动算进入空闲。 */
export const IDLE_AFTER_MS = 60_000;
/**
 * 打盹阈值的兜底值（分钟）。实际用 settings.sleepAfterMinutes，0 表示不自动睡。
 *
 * 为什么不再是固定常量：用户要求「5 分钟后自动进睡觉模式、可配置」。
 * 这里保留一个默认值只是为了拿不到设置时有个合理行为。
 */
export const DEFAULT_SLEEP_AFTER_MINUTES = 5;

/** 从设置算出打盹阈值（ms）。返回 null 表示不自动睡。 */
export function napAfterMs(settings: Settings): number | null {
  const minutes = settings.sleepAfterMinutes;
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return minutes * 60_000;
}
/** 两次自主位移之间的最小间隔。 */
export const MOVE_INTERVAL_MS = 4 * 60_000;
/** 每次 tick 想挪的概率（配合 tick 间隔决定"偶尔"有多偶尔）。 */
export const MOVE_CHANCE = 0.35;

export type IdlePhase = 'active' | 'idle' | 'napping';

export type IdleEffect =
  | { type: 'move'; spot: Spot }
  | { type: 'intent'; intent: AwarenessIntent };

export type IdleBehaviorOptions = {
  probe: ActivityProbe;
  /** 起始时刻。不给就当"刚刚有过互动"。 */
  startedAt?: number;
  /** 她当前待的位置，用来避免"挪到原地"。 */
  spot?: Spot;
  /**
   * 注入随机源。一次位移会消耗**两个**随机数：
   * 先决定这一 tick 要不要动，再决定挪去哪。测试里按这个顺序排队。
   */
  random?: Random;
};

export class IdleBehavior {
  private phaseValue: IdlePhase = 'active';
  private lastInteractionAt: number;
  private lastMoveAt = Number.NEGATIVE_INFINITY;
  private currentSpot: Spot | null;
  private readonly probe: ActivityProbe;
  private readonly random: Random;

  constructor(options: IdleBehaviorOptions) {
    this.probe = options.probe;
    this.random = options.random ?? Math.random;
    this.lastInteractionAt = options.startedAt ?? 0;
    this.currentSpot = options.spot ?? null;
  }

  get phase(): IdlePhase {
    return this.phaseValue;
  }

  /** 推进一步。返回这一步要做的事（可能为空）。 */
  tick(settings: Settings, now: number): IdleEffect[] {
    // 两个开关管的是不同的事，所以要分开判：
    //   autonomy          → 自己挪位置（会打扰人，默认关）
    //   sleepAfterMinutes → 自动打盹（被动的，默认 5 分钟）
    // 两个都关掉才彻底惰性。只关 autonomy 时她仍然会到点睡觉 —— 这正是用户要的
    // 「安静的桌宠」，而不是「不许动也不许睡」。
    const sleepEnabled = napAfterMs(settings) !== null;
    if (!settings.autonomy && !sleepEnabled) {
      this.phaseValue = 'active';
      this.lastInteractionAt = now;
      return [];
    }

    // 窗口藏起来 / 她在忙 / 用户在打字：都算"现在不该自作主张"。
    if (!this.probe.visible() || this.probe.busy() || this.probe.userTyping()) {
      this.lastInteractionAt = now;
      // 正在打盹时被这些情况打断不算"醒"，醒要靠 noteInteraction（真实互动）。
      return [];
    }

    const idleFor = now - this.lastInteractionAt;

    if (this.phaseValue === 'active' && idleFor >= IDLE_AFTER_MS) {
      this.phaseValue = 'idle';
      // 不 return：刚进空闲就可以考虑挪一下。
    }

    const napAfter = napAfterMs(settings);
    if (this.phaseValue === 'idle' && napAfter !== null && idleFor >= napAfter) {
      this.phaseValue = 'napping';
      return [
        {
          type: 'intent',
          intent: {
            kind: 'nap',
            prompt: '用户很久没动静了。你困了，趴下打个盹，不用说话，也不要喊他。',
          },
        },
      ];
    }

    if (this.phaseValue !== 'idle') return [];

    // 以下只有位移，所以到这里才检查 autonomy —— 打盹已经在上面处理完了。
    if (!settings.autonomy) return [];
    // 位移：reduceMotion 一票否决。
    if (settings.reduceMotion) return [];
    if (now - this.lastMoveAt < MOVE_INTERVAL_MS) return [];
    if (this.random() >= MOVE_CHANCE) return [];

    const spot = this.pickSpot();
    this.lastMoveAt = now;
    this.currentSpot = spot;
    return [{ type: 'move', spot }];
  }

  /** 用户真的互动了（说话、点击、热键）。从打盹里醒过来会产出一个 wake 意图。 */
  noteInteraction(now: number): IdleEffect[] {
    const wasNapping = this.phaseValue === 'napping';
    this.phaseValue = 'active';
    this.lastInteractionAt = now;
    if (!wasNapping) return [];
    return [
      {
        type: 'intent',
        intent: {
          kind: 'wake',
          prompt: '你刚被叫醒。用一句话表达刚睡醒的状态，然后听用户说。',
        },
      },
    ];
  }

  /** 外部（Track A 的窗口逻辑或 move_to 工具）挪了她之后同步一下，免得挪到原地。 */
  noteSpot(spot: Spot, now: number): void {
    this.currentSpot = spot;
    this.lastMoveAt = now;
  }

  reset(now: number): void {
    this.phaseValue = 'active';
    this.lastInteractionAt = now;
    this.lastMoveAt = Number.NEGATIVE_INFINITY;
  }

  private pickSpot(): Spot {
    const choices = spots.filter((spot) => spot !== this.currentSpot);
    const index = Math.min(choices.length - 1, Math.floor(this.random() * choices.length));
    return choices[Math.max(0, index)];
  }
}
