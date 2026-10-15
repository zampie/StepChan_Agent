// 程序化动画的纯数学部分。没有 DOM、没有 Pixi，可以直接单测。
//
// 原则：不做逐帧序列图。桌宠要长时间在屏幕上活着，序列图会很快露出循环痕迹，
// 而且每加一个状态就要重出一套图。这里全部用时间函数 + 弹簧，状态之间天然可叠加。
import type { EyeState } from '../../../../shared/pet';

/**
 * 醒着时的呼吸参数。
 *
 * 3400 ms ≈ 17.6 次/分，是成年人清醒静息的呼吸频率；幅度刻意很小 —— 大了就像在喘。
 * 单独导出是因为睡觉要在这两个数和 sleepFeel 的那两个数之间插值（见 sleep.ts），
 * 两边都不该各写一份。
 */
export const awakeBreath = { amplitude: 0.012, periodMs: 3400 } as const;

/** 呼吸：竖直方向的轻微缩放。 */
export function breathe(
  tMs: number,
  amplitude: number = awakeBreath.amplitude,
  periodMs: number = awakeBreath.periodMs,
) {
  return breatheAt((tMs / periodMs) * Math.PI * 2, amplitude);
}

/**
 * 给定**相位**的呼吸形变。
 *
 * 为什么要把相位单独拿出来：睡着时呼吸周期要变长（见 sleep.ts 的 sleepFeel），
 * 而 sin(t / period) 在 period 改变的那一帧相位会**跳** —— 肉眼看到身体「咯」一下，
 * 恰好发生在「刚躺下」这个最该平滑的时刻。
 * 用累加相位（BreathPhase）喂这个函数，周期就可以逐帧连续改变而相位不跳。
 */
export function breatheAt(phase: number, amplitude: number = awakeBreath.amplitude) {
  const s = Math.sin(phase);
  return { scaleY: 1 + s * amplitude, scaleX: 1 - s * amplitude * 0.45 };
}

/**
 * 呼吸相位累加器。periodMs 可以每帧不同，相位始终连续。
 *
 * 和「从 clock 换算相位」的区别只在周期变化的那一帧，但那一帧正好是醒↔睡的过渡。
 */
export class BreathPhase {
  private phase = 0;

  /** 当前相位，rad（0..2π）。 */
  get value() {
    return this.phase;
  }

  /** 推进一帧。@returns 新相位。 */
  step(dtMs: number, periodMs: number = awakeBreath.periodMs) {
    // 周期为 0 / 负数会把相位推成 ±Infinity 并污染后面所有帧，直接兜住。
    const p = periodMs > 1 ? periodMs : 1;
    const next = this.phase + (dtMs / p) * Math.PI * 2;
    const tau = Math.PI * 2;
    // 取模防止长时间运行后浮点精度变差（一天的毫秒数已经让 sin 的有效位掉一截）。
    this.phase = ((next % tau) + tau) % tau;
    return this.phase;
  }

  reset() {
    this.phase = 0;
  }
}

/** 摇摆：两个不同周期的正弦叠加，避免出现肉眼可辨的循环节。 */
export function sway(tMs: number, amplitude = 0.018) {
  return (
    Math.sin(tMs / 2300) * amplitude + Math.sin(tMs / 5700 + 1.1) * amplitude * 0.45
  );
}

/** 临界阻尼弹簧，用于姿态过渡（程序化动作、聆听状态）与单击的挤压反馈。dt 单位为秒。 */
export class Spring {
  value = 0;
  velocity = 0;
  constructor(
    public stiffness = 170,
    public damping = 16,
  ) {}
  step(target: number, dt: number) {
    // 子步长积分：dt 尖峰（切回标签页、主线程卡顿）会让显式积分炸开。
    const steps = Math.max(1, Math.min(8, Math.ceil(dt / 0.016)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const a = this.stiffness * (target - this.value) - this.damping * this.velocity;
      this.velocity += a * h;
      this.value += this.velocity * h;
    }
    return this.value;
  }
  snap(v = 0) {
    this.value = v;
    this.velocity = 0;
  }
}

/** 挤压拉伸：沿运动方向拉长、垂直方向压扁，体积守恒。 */
export function squash(stretch: number) {
  const s = Math.max(-0.35, Math.min(0.35, stretch));
  return { scaleX: 1 - s, scaleY: 1 + s };
}

// ---------------------------------------------------------------------------
// 拖动：刻意不做任何表现
// ---------------------------------------------------------------------------
//
// 这里原来有一整套「抓娃娃机」手感：拖动时把旋转支点从脚底搬到头顶，身体竖向拉长、
// 随手摆动、下半身切变滞后、放下时落地回弹。五根弹簧 + 一个 clawPose() 纯函数 + 一组
// clawFeel 参数 + 七条单测。
//
// **它被整个删掉了，不是漏实现。** 用户看过实际效果后的结论是「效果不太好，取消拖动动画，
// 拖动时不做任何动作」。所以 RigRenderer.setDragging() 现在是空实现（签名保留给 App.tsx），
// 拖动期间角色就是正常的 idle 呼吸。
//
// 想加回来之前先去问人 —— 这是产品决定，不是技术债。
// （落地回弹也一起删了：它只服务于拖动。jump 是换整身图的动作，不走回弹。
//  单击的挤压反馈还在，走 squash + 自己的一根弹簧，和拖动无关。）

// ---------------------------------------------------------------------------
// 按住聆听：持续的视觉状态
// ---------------------------------------------------------------------------
//
// 关掉「持续聆听」后，长按桌宠 = 按住说话。按住期间必须有一个**一眼能和普通 idle 区分开、
// 而且持续存在**的状态，否则用户不知道麦克风到底开没开。
//
// 没有新素材，全部用现有素材 + 程序化叠出来，三件事同时发生：
//   1. 侧耳：身体恒定侧倾（lean）—— 支点在脚底，整体倾斜在 Q 版头身比下读作「侧着头听」。
//      它是**姿势**不是动效，所以 reduceMotion 下也保留，只是不走弹簧过渡。
//   2. 慢速点头（nod）：在 lean 上叠一个很慢的正弦，读作「嗯、在听」。这是动效，
//      reduceMotion 下关掉（amount 仍然给，但调用方传 motion=false）。
//   3. 耳边的音符标记（现有 fx-note 素材）做呼吸式脉动：缩放与透明度在两个下限之上来回，
//      **永远不会掉到 0** —— 这就是「持续状态」与「一次性特效」的区别。
//      FX 的生命周期曲线（fxPose）会淡出到 0，所以这里不能复用它。
//
// 眼型（eyes.wide）由渲染器直接换覆盖层，不在这里 —— 它不是时间函数。

/** 聆听状态的手感参数。单位写在字段上，调手感只改这个对象。 */
export const listenFeel = {
  /** 侧耳倾听的恒定倾角，rad（≈7.4°）。比 tilt 的 0.22 小得多：tilt 是「歪头」，这是「侧耳」。 */
  lean: 0.13,
  /** 叠在 lean 上的慢速点头幅度，rad。约为 sway 峰值的 1.4 倍，看得出但不晃。 */
  nodAmplitude: 0.026,
  /** 点头周期，ms。1.6 s 一次 ≈ 人听话时点头的速度。 */
  nodPeriodMs: 1600,
  /** 音符标记的脉动周期，ms。比点头快一点，两者不同步才像两件事。 */
  pulsePeriodMs: 1100,
  /** 标记缩放的下限 / 上限，单位＝画布高度的比例。 */
  markScaleMin: 0.15,
  markScaleMax: 0.19,
  /** 标记透明度的下限 / 上限。下限 > 0 是「持续可见」的保证。 */
  markAlphaMin: 0.62,
  markAlphaMax: 1,
  /** 标记相对画布的位置：x 从中心算（正＝角色右侧，也就是发饰那一侧），y 从脚底往上算。 */
  markX: 0.3,
  markY: 0.78,
  /** 进入/退出的弹簧（临界阻尼附近，不要回弹 —— 聆听状态不该有「弹一下」）。 */
  stiffness: 150,
  damping: 22,
} as const;

export type ListenFeel = typeof listenFeel;

export interface ListenPose {
  /** 叠加到 root 的旋转，rad。 */
  rotation: number;
  /** 音符标记的边长，单位＝画布高度的比例。amount=0 时为 0。 */
  markScale: number;
  /** 音符标记的透明度。amount=0 时为 0。 */
  markAlpha: number;
}

/**
 * 聆听姿态。纯函数 —— 「持续可见」「有界」「静止时完全中性」这些性质可以单测。
 *
 * @param tMs    时钟
 * @param amount 0 = 没在听，1 = 完全进入聆听。由弹簧平滑，不要直接给 0/1 的阶跃。
 * @param motion false = reduceMotion：保留姿势与常驻标记，去掉点头和脉动。
 */
export function listenPose(
  tMs: number,
  amount: number,
  motion = true,
  cfg: ListenFeel = listenFeel,
): ListenPose {
  const a = clamp(amount, 0, 1);
  if (a <= 0) return { rotation: 0, markScale: 0, markAlpha: 0 };
  const nod = motion ? Math.sin((tMs / cfg.nodPeriodMs) * Math.PI * 2) * cfg.nodAmplitude : 0;
  // 0..1 的脉动相位。reduceMotion 下钉在中间值，标记就是个常驻静态图标。
  const pulse = motion ? (1 - Math.cos((tMs / cfg.pulsePeriodMs) * Math.PI * 2)) / 2 : 0.5;
  return {
    rotation: (cfg.lean + nod) * a,
    markScale: (cfg.markScaleMin + (cfg.markScaleMax - cfg.markScaleMin) * pulse) * a,
    // 淡入淡出乘在 amount 上，所以松手时标记是消失而不是突然不见。
    markAlpha: (cfg.markAlphaMin + (cfg.markAlphaMax - cfg.markAlphaMin) * pulse) * a,
  };
}

// ---------------------------------------------------------------------------
// 不重复轮转
// ---------------------------------------------------------------------------

/**
 * 洗牌袋：一轮内每项各出现一次，取空重洗，且**跨轮也不连续重复**。
 *
 * 为什么不是纯随机：单击要「每次换一个」。纯随机在 4 个候选里有 25% 概率连续两次相同，
 * 用户点两下看不出变化就会认为没反应。
 * 为什么不是固定顺序轮转：固定顺序点几轮就被记住了，变成可预测的动画列表。
 * 洗牌袋两头都占：短期不重复，长期不可预测。
 */
export class ShuffleBag<T> {
  private pool: T[] = [];
  private previous: T | undefined;
  private readonly items: readonly T[];
  private readonly rnd: () => number;

  constructor(items: readonly T[], random: () => number = Math.random) {
    if (items.length === 0) throw new Error('ShuffleBag 需要至少一个候选');
    this.items = items;
    this.rnd = random;
  }

  /** 上一次抽到的项（还没抽过时为 undefined）。 */
  get last(): T | undefined {
    return this.previous;
  }

  /** 单元素袋必然重复 —— 调用方要自己保证候选数 ≥2 才谈得上「不重复」。 */
  next(): T {
    if (this.pool.length === 0) this.refill();
    const value = this.pool.pop() as T;
    this.previous = value;
    return value;
  }

  private refill() {
    const next = [...this.items];
    // Fisher–Yates。
    for (let i = next.length - 1; i > 0; i--) {
      const j = Math.floor(this.rnd() * (i + 1));
      [next[i], next[j]] = [next[j], next[i]];
    }
    // next 是从尾部 pop 的，所以「新一轮的第一张」是 next[length-1]。
    // 它和上一轮最后一张相同时，和开头换一下 —— 只要候选数 ≥2 就一定能换掉。
    const topIndex = next.length - 1;
    if (next.length > 1 && this.previous !== undefined && next[topIndex] === this.previous) {
      [next[topIndex], next[0]] = [next[0], next[topIndex]];
    }
    this.pool = next;
  }
}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

const BLINK_FRAMES: ReadonlyArray<{ eye: EyeState; ms: number }> = [
  { eye: 'half', ms: 45 },
  { eye: 'closed', ms: 75 },
  { eye: 'half', ms: 55 },
];

export interface BlinkOptions {
  minIntervalMs?: number;
  maxIntervalMs?: number;
  /** 连眨两次的概率。真人眨眼有成串的，固定单次会显得机械。 */
  doubleChance?: number;
  random?: () => number;
}

/**
 * 眨眼调度器。返回 null 表示「用表情自己的眼型」，返回 EyeState 表示本帧覆盖。
 * 时序固定走 open→half→closed→half→open，不是直接切 closed —— 少了中间帧会看起来像掉帧。
 */
export class BlinkScheduler {
  private wait = 0;
  private frame = -1;
  private frameLeft = 0;
  private queued = 0;
  private readonly min: number;
  private readonly max: number;
  private readonly doubleChance: number;
  private readonly rnd: () => number;

  constructor(opts: BlinkOptions = {}) {
    this.min = opts.minIntervalMs ?? 2400;
    this.max = opts.maxIntervalMs ?? 6200;
    this.doubleChance = opts.doubleChance ?? 0.18;
    this.rnd = opts.random ?? Math.random;
    this.wait = this.nextWait();
  }

  private nextWait() {
    return this.min + this.rnd() * (this.max - this.min);
  }

  /** 强制立刻眨一次（例如被戳了一下）。 */
  trigger(double = false) {
    this.frame = 0;
    this.frameLeft = BLINK_FRAMES[0].ms;
    this.queued = double ? 1 : 0;
  }

  reset() {
    this.frame = -1;
    this.queued = 0;
    this.wait = this.nextWait();
  }

  /** @param dtMs 本帧时长。@returns 眼型覆盖，或 null。 */
  update(dtMs: number): EyeState | null {
    if (this.frame < 0) {
      this.wait -= dtMs;
      if (this.wait > 0) return null;
      this.frame = 0;
      this.frameLeft = BLINK_FRAMES[0].ms;
      this.queued = this.rnd() < this.doubleChance ? 1 : 0;
    }
    this.frameLeft -= dtMs;
    while (this.frameLeft <= 0) {
      this.frame += 1;
      if (this.frame >= BLINK_FRAMES.length) {
        if (this.queued > 0) {
          this.queued -= 1;
          this.frame = 0;
          this.frameLeft += BLINK_FRAMES[0].ms;
          continue;
        }
        this.frame = -1;
        this.wait = this.nextWait();
        return null;
      }
      this.frameLeft += BLINK_FRAMES[this.frame].ms;
    }
    return BLINK_FRAMES[this.frame].eye;
  }
}

// ---------------------------------------------------------------------------
// 临时状态的倒计时
// ---------------------------------------------------------------------------

/**
 * 「保持 N 毫秒然后自动回位」的倒计时。
 *
 * 为什么不是 setTimeout：
 *   - 页面隐藏时 ticker 会停（见 RigRenderer.onVisibility），倒计时就该跟着停 ——
 *     用 setTimeout 的话，切回标签页的瞬间会把攒下的回位一股脑执行掉；
 *   - 渲染器销毁时不需要额外清理，没有「已销毁对象上的回调」这类问题。
 *
 * 为什么单独成类而不是在渲染器里写两个 number：这个类**承载了一条产品规则** ——
 * 单击引起的临时状态会自动恢复，而模型主动设的状态不会。实现上就是
 * 「模型路径调 cancel()，单击路径调 arm()」，所以它值得被单测。
 */
export class HoldTimer {
  private left = 0;

  /** 还在倒计时中。 */
  get pending() {
    return this.left > 0;
  }

  /** 剩余毫秒（没在计时时为 0）。只给测试和诊断看。 */
  get remaining() {
    return this.left;
  }

  /** 开始（或重新开始）倒计时。ms ≤ 0 等于取消。 */
  arm(ms: number) {
    this.left = ms > 0 ? ms : 0;
  }

  /** 取消。模型主动设状态时走这里 —— 它设的东西不该过期。 */
  cancel() {
    this.left = 0;
  }

  /** @returns 本帧是否刚刚到点（只会返回一次 true）。 */
  tick(dtMs: number): boolean {
    if (this.left <= 0) return false;
    this.left -= dtMs;
    if (this.left > 0) return false;
    this.left = 0;
    return true;
  }
}

/** 交叉淡入的进度曲线。150ms 是实测舒服的值：再短像闪，再长像卡。 */
export const crossfadeMs = 150;


export function easeInOut(t: number) {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
}

/** FX 的生命周期曲线：弹出 → 上浮 → 淡出。 */
export function fxPose(ageMs: number, lifeMs: number) {
  const t = Math.min(1, ageMs / lifeMs);
  const pop = t < 0.18 ? easeInOut(t / 0.18) : 1;
  const scale = 0.55 + pop * 0.45 + (t < 0.3 ? Math.sin(t / 0.3 * Math.PI) * 0.12 : 0);
  return {
    scale,
    y: -46 * easeInOut(t),
    alpha: t < 0.1 ? t / 0.1 : t > 0.65 ? 1 - (t - 0.65) / 0.35 : 1,
    done: t >= 1,
  };
}
