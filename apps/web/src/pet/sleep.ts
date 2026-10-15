// 睡觉：一个**持续状态**，外加周期性冒出来的 zzz。
//
// ---------------------------------------------------------------------------
// 为什么不是 playAction('sleep')
// ---------------------------------------------------------------------------
// `sleep` 本来只是 actions 里的一个普通动作，谁都能 playAction 一下。但这样做出来的
// 「睡觉」会在三个地方漏气：
//   1. 单击引起的临时动作到点会自动回 idle（tapActionHoldMs），睡着的人会自己站起来；
//   2. 闲置摇摆（sway）照常生效 —— 侧躺的人左右摇，读起来像在抽搐；
//   3. 表情倒计时（tapExpressionHoldMs）3.5 s 后把 sleepy 抹回 neutral。
// 也就是说「动作」这个抽象的生命周期是**一次性**的，而睡觉要一直持续到被叫醒。
//
// 所以睡觉和「按住聆听」走同一个模式：一个 on/off 状态 + 一根进出弹簧 + 一组
// 纯函数算出来的姿态修正，由 RigRenderer 每帧叠加。主动睡觉（右键菜单）和自动打盹
// （awareness/IdleBehavior 的 nap 意图）调的是同一个方法，不存在两套表现。
//
// 这个文件里没有 Pixi、没有 DOM，全部可单测 —— 「跑满几千帧仍在睡」「zzz 周期对不对」
// 这类性质恰恰是只有长跑才暴露的，必须能在测试里跑。
import type { Expression } from '../../../../shared/pet';
import { awakeBreath } from './motion';
import { fullBodyFallback, type PoseRegion } from './poseRegions';

/** 睡觉时强制的表情。sleep 的整身图自带闭眼，这个表情在被唤醒的过渡帧里才看得见。 */
export const sleepExpression: Expression = 'sleepy';

/**
 * 睡觉状态的手感参数。调手感只改这个对象。
 *
 * 呼吸（breath*）的依据：清醒静息约 17.6 次/分（awakeBreath 的 3400 ms），
 * 而 NREM 睡眠期呼吸频率降到 12 次/分左右、潮气量也略小。
 * 所以周期取 5000 ms（= 12 次/分），幅度取清醒值的一半（0.012 → 0.006）：
 * 既然躺着的轮廓比站着矮一半，同样的相对缩放在屏幕上的绝对位移本来就更小，
 * 再减半才不会让侧躺的身体看起来在「起伏」。
 */
export const sleepFeel = {
  /** 睡着时的呼吸幅度（竖向缩放比例）。 */
  breathAmplitude: 0.006,
  /** 睡着时的呼吸周期，ms。5000 ms = 12 次/分 ≈ NREM 睡眠的呼吸频率。 */
  breathPeriodMs: 5000,
  /**
   * 睡着时闲置摇摆（sway）的保留比例。0 = 完全不摇。
   * 侧躺的人不该左右摇 —— 身体的「还活着」由呼吸负责，摇摆是立姿的重心微调。
   */
  swayScale: 0,
  /**
   * 进入/退出的弹簧。比聆听（150/22）软一点：躺下和起来是慢动作，
   * 阻尼 20 对刚度 90 是过阻尼（临界是 2√90 ≈ 19），所以绝不回弹。
   */
  stiffness: 90,
  damping: 20,
  /**
   * zzz 的生成间隔，ms。取呼吸周期的一半 —— 平均「每次呼气冒一个」。
   * 必须明显大于 FX 的生命周期（1400 ms），否则 zzz 会叠成一团云而不是一个个飘。
   */
  zzzIntervalMs: 2500,
  /** 间隔抖动，ms（间隔 ± 这个值）。没有抖动就是节拍器，几轮之后就被看出是循环。 */
  zzzJitterMs: 500,
  /** 躺下后第一个 zzz 的延迟，ms。先让换姿势的交叉淡入（150 ms）走完再冒。 */
  zzzFirstDelayMs: 700,
  /** zzz 的边长，单位＝画布高度的比例。和一次性 FX 一致，不另起一套。 */
  zzzSize: 0.22,
  /** zzz 与头部外接框顶边之间的空隙，单位＝画布高度的比例。 */
  zzzGap: 0.03,
  /**
   * reduceMotion 下那枚**常驻静态** zzz 的透明度。
   * 不是 1：它要读作「背景里的一个状态标记」，而不是一个刚弹出来的特效。
   * 下限 > 0 是「持续可见」的保证 —— 和聆听那枚音符的处理一致。
   */
  markAlpha: 0.85,
} as const;

export type SleepFeel = typeof sleepFeel;

export interface SleepPose {
  /** 喂给 motion.ts 的 breatheAt 的幅度。 */
  breathAmplitude: number;
  /** 喂给 BreathPhase.step 的周期，ms。 */
  breathPeriodMs: number;
  /** 闲置摇摆的保留比例：1 = 照常摇，0 = 完全不摇。 */
  swayScale: number;
  /**
   * 常驻静态 zzz 的透明度。**只在 reduceMotion（motion=false）下非零** ——
   * 正常模式下 zzz 是周期性生成的 FX（见 ZzzEmitter），两者不同时出现。
   */
  markAlpha: number;
}

/**
 * 睡觉姿态。纯函数，所以「醒着时完全中性」「有界」「reduceMotion 下仍有标记」可单测。
 *
 * 刻意**不吃时钟**：睡觉没有脉动。聆听那枚音符要脉动是因为「正在收音」是个进行中的动作，
 * 而睡觉是静止的 —— 唯一在动的东西是呼吸和飘起来的 zzz，两者都不在这里算。
 *
 * @param amount 0 = 醒着，1 = 完全睡着。由弹簧平滑，不要直接给 0/1 的阶跃。
 * @param motion false = reduceMotion：不生成飘动的 zzz，改成一枚常驻静态 zzz。
 */
export function sleepPose(amount: number, motion = true, cfg: SleepFeel = sleepFeel): SleepPose {
  const a = clamp(amount, 0, 1);
  return {
    breathAmplitude: lerp(awakeBreath.amplitude, cfg.breathAmplitude, a),
    breathPeriodMs: lerp(awakeBreath.periodMs, cfg.breathPeriodMs, a),
    swayScale: lerp(1, cfg.swayScale, a),
    // 乘在 amount 上，所以叫醒她的时候标记是淡出而不是突然不见。
    markAlpha: motion ? 0 : cfg.markAlpha * a,
  };
}

/** FX 的生成位置：x 从画布中心算，y 从脚底往上算，单位都是画布高度的比例。 */
export interface FxSpawnPoint {
  x: number;
  y: number;
}

/**
 * 这个姿势下 zzz 该冒在哪。
 *
 * 为什么不写死一个常量：RigRenderer 的 FX_SPAWN.zzz 是按**站立**姿势定的（角色右上方）。
 * 睡觉时她侧躺，头在画幅左侧偏下（实测 sleep 的 head 框是 x 0.15–0.49 / y 0.33–0.79），
 * 站立那个位置会把 zzz 冒在她腰上方的空气里 —— 读不出是从头上冒的。
 *
 * 所以从**这个姿势实测的命中区**里取头部外接框（tools/art/regions.py 量的脸部肤色连通域，
 * 和 logo/regions 用的是同一套逐画幅实测数据），冒在头顶正上方。
 * 没有 head 框的姿势退回整身框的顶边中点 —— 整身框一定存在（清单校验保证）。
 *
 * y 会被夹住，保证整枚 zzz 留在画布内：站立姿势的头顶离画布顶只有 0.1，
 * 不夹的话只剩半个 zzz 露在外面。
 */
export function zzzSpawn(regions: readonly PoseRegion[], cfg: SleepFeel = sleepFeel): FxSpawnPoint {
  const list = regions.length > 0 ? regions : [fullBodyFallback()];
  const head = list.find((r) => r.part === 'head') ?? list.find((r) => r.part === 'body') ?? list[0];
  const half = cfg.zzzSize / 2;
  // 命中区是「从上往下」的归一化坐标，FX 的 y 是「从脚底往上」，锚点 y=1 所以差一个 1-y。
  const headTopFromFeet = 1 - head.y0;
  return {
    x: (head.x0 + head.x1) / 2 - 0.5,
    y: Math.min(headTopFromFeet + half + cfg.zzzGap, 1 - half),
  };
}

/**
 * 周期性 zzz 的节拍器。
 *
 * 只负责「这一帧该不该冒」，不知道 zzz 长什么样、冒在哪 —— 那些是 zzzSpawn 和渲染器的事。
 * 一次性 spawn 一个 zzz 读起来是「打了个哈欠」；要读成「持续在睡」就必须周期性地冒，
 * 这个类就是那个周期。
 */
export class ZzzEmitter {
  private left = 0;
  private on = false;

  constructor(
    private readonly cfg: SleepFeel = sleepFeel,
    private readonly rnd: () => number = Math.random,
  ) {}

  get active() {
    return this.on;
  }

  /** 剩余等待时间（ms）。只给测试和诊断看。 */
  get remaining() {
    return this.on ? this.left : 0;
  }

  /**
   * 开始 / 停止生成。
   *
   * **幂等**：重复 setActive(true) 不会重置节拍 —— 自动打盹和右键菜单可能先后都喊一次睡觉，
   * 重置的话 zzz 的节奏会被这类重复调用一直往后推。
   * 停止后 update() 永远返回 0；已经飘在天上的那几个由 FX 的生命周期自然淡出，
   * 不在这里硬切（那会表现为「zzz 突然集体消失」）。
   */
  setActive(on: boolean) {
    if (on === this.on) return;
    this.on = on;
    this.left = on ? this.cfg.zzzFirstDelayMs : 0;
  }

  /**
   * 推进一帧。
   *
   * @returns 本帧要生成几个 zzz。**永远是 0 或 1** —— 超长帧（切回标签页、主线程卡死）
   *   之后不补课，不然会一瞬间喷出一串 zzz。所以这里是 `left = 间隔` 而不是 `left += 间隔`。
   */
  update(dtMs: number): number {
    if (!this.on) return 0;
    this.left -= dtMs;
    if (this.left > 0) return 0;
    this.left = this.nextInterval();
    return 1;
  }

  private nextInterval() {
    // rnd() ∈ [0,1) → 间隔 ∈ [interval - jitter, interval + jitter)。
    return this.cfg.zzzIntervalMs + (this.rnd() * 2 - 1) * this.cfg.zzzJitterMs;
  }
}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}
