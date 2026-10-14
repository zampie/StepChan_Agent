// 程序化动画的纯数学部分。没有 DOM、没有 Pixi，可以直接单测。
//
// 原则：不做逐帧序列图。桌宠要长时间在屏幕上活着，序列图会很快露出循环痕迹，
// 而且每加一个状态就要重出一套图。这里全部用时间函数 + 弹簧，状态之间天然可叠加。
import type { EyeState } from '../../../../shared/pet';

/** 呼吸：竖直方向的轻微缩放。幅度刻意很小 —— 大了就像在喘。 */
export function breathe(tMs: number, amplitude = 0.012, periodMs = 3400) {
  const phase = (tMs / periodMs) * Math.PI * 2;
  return { scaleY: 1 + Math.sin(phase) * amplitude, scaleX: 1 - Math.sin(phase) * amplitude * 0.45 };
}

/** 摇摆：两个不同周期的正弦叠加，避免出现肉眼可辨的循环节。 */
export function sway(tMs: number, amplitude = 0.018) {
  return (
    Math.sin(tMs / 2300) * amplitude + Math.sin(tMs / 5700 + 1.1) * amplitude * 0.45
  );
}

/** 临界阻尼弹簧，用于拖拽惯性与落地回弹。dt 单位为秒。 */
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
// 抓娃娃机手感
// ---------------------------------------------------------------------------
//
// 目标：拖着走的时候像被夹子提起来 —— 身体垂下来、跟着手晃、放下时落地回弹。
//
// 关键一招不是加素材，是**把旋转支点从脚底搬到头顶**。站着的时候支点在脚底，
// 旋转读作「身体歪了」；支点在头顶时，同一个旋转读作「吊着在摆」。这是单张整身图
// 能做出悬挂感的根本原因，剩下的（下垂、滞后、回弹）都是在这个基础上叠的二级动作。
//
// 没有分离的手脚素材，所以「手脚垂下」是近似出来的：
//   - 竖向拉伸（体积守恒）→ 整体被重力拉长，读作四肢和头发往下坠；
//   - 下半身滞后的切变（skew.x，支点在画幅顶）→ 上身先动、下身拖后一拍。
// 这是近似，不是真的分段骨骼。要更像就得有一张「被提起、手脚垂下」的全身图
// （见报告里关于新增 action 枚举的建议）。

/**
 * 手感参数。全部集中在这里，单位写在字段上 —— 调手感只改这个对象。
 *
 * 几个数的来历：
 * - liftPivotY 0.09：master 的 alpha 外接框上沿在画幅 3% 处（Q 版头身比，头顶就是最高点），
 *   取 9% 让支点落在后脑勺偏上，而不是悬在空气里。
 * - swingMax 0.36 rad（20.6°）：**上限由窗口宽度决定，不是凭感觉挑的**。
 *   支点在头顶时脚底的横移是 sin(θ)·(1−liftPivotY)·canvasH·scale；
 *   默认档位（画布 512、显示高度 300 → scale 0.586）下 θ=0.36 约 96 px，
 *   加上角色半宽约 88 px 共 184 px，窗口半宽 210 px（PET_WIDTH 420）还剩 26 px。
 *   再调大就会把脚甩出窗口被裁掉 —— 要加大摆幅得先加宽窗口。
 * - swingPerVelocity 1400 px/s：指针以 ~500 px/s 拖动时就打满 swingMax。
 *   再快不会更夸张，避免角色转成陀螺。
 * - lagMax 0.035 rad：skew 的位移是 sin(skew)·y，画幅 512 下脚底横移约 18 px、头顶 0 px。
 *   这是「下身拖后一拍」能看出来但不至于把人撕开的量级。
 * - landVelocity 为正：回弹值从 -landBounce（压扁）出发向上冲过 0 再收敛，
 *   顺序是「砸地压扁 → 弹起拉长 → 稳住」。先压再弹，反了就像被人往上提了一下。
 */
export const clawFeel = {
  /** 被提起时整体抬升量，单位＝显示高度的比例。 */
  liftRise: 0.06,
  /** 提起后旋转支点的高度，单位＝素材画布高度的比例（0 = 画幅顶，1 = 脚底）。 */
  liftPivotY: 0.09,
  /** 摆角上限，rad。见上面的窗口宽度推导，别随手调大。 */
  swingMax: 0.36,
  /** 指针横向速度（px/s）换算摆角的除数。 */
  swingPerVelocity: 1400,
  /** 重力下垂的竖向拉伸上限（squash 的输入，体积守恒）。 */
  sagMax: 0.085,
  /** 下垂的静态占比：刚提起来还没动时就该垂着。 */
  sagStatic: 0.6,
  /** 竖向速度（px/s）换算剩余下垂量的除数。 */
  sagPerVelocity: 2600,
  /** 下半身滞后切变的上限，rad（Pixi 的 skew.x）。 */
  lagMax: 0.035,
  /** 摆角与滞后角之差换算切变的增益。 */
  lagGain: 0.22,
  /** 落地回弹的初始压缩量与初速度（squash 输入 / 每秒）。 */
  landBounce: 0.26,
  landVelocity: 1.8,
} as const;

export type ClawFeel = typeof clawFeel;

/**
 * 悬挂摆动的目标角：横向速度越大摆得越开，方向与拖动相反（身体落在手后面）。
 * `|| 0` 不是多余的：`-0 / k` 是 `-0`，让它流进变换里虽然无害，但会把
 * 「静止时必须严格为 0」这类断言变成要靠 Object.is 去绕的噪声。
 */
export function swingTarget(vx: number, cfg: ClawFeel = clawFeel) {
  return clamp(-vx / cfg.swingPerVelocity, -cfg.swingMax, cfg.swingMax) || 0;
}

/** 重力下垂的目标量：提起来就有底量，竖向速度再加一点（被往上拽时拉得更长）。 */
export function sagTarget(vy: number, cfg: ClawFeel = clawFeel) {
  const dynamic = Math.min(1, Math.abs(vy) / cfg.sagPerVelocity) * (1 - cfg.sagStatic);
  return cfg.sagMax * (cfg.sagStatic + dynamic);
}

export interface ClawInput {
  /** 0 = 站在地上，1 = 完全被提起。由弹簧平滑，不要直接给 0/1 的阶跃。 */
  lift: number;
  /** 当前摆角，rad（欠阻尼弹簧的输出）。 */
  swing: number;
  /** 下半身跟随摆角的滞后值，rad（更软的弹簧跟踪 swing）。 */
  lag: number;
  /** 重力下垂量（squash 输入）。 */
  sag: number;
  /** 落地回弹量（squash 输入，负值＝压扁）。 */
  rebound: number;
}

export interface ClawPose {
  /** 旋转支点的 y，单位＝画布高度比例（1 = 脚底，也就是站立时的锚点）。 */
  pivotY: number;
  /** 竖直抬升，单位＝显示高度比例。负值向上。 */
  riseFrac: number;
  /** 叠加到 root 的旋转，rad。 */
  rotation: number;
  /** 叠加到身体容器的切变，rad。 */
  skewX: number;
  scaleX: number;
  scaleY: number;
}

/**
 * 把五个标量合成一个姿态。纯函数，没有 Pixi —— 手感的数学性质可以单测
 * （站地时必须完全中性、体积守恒、各项有界）。
 *
 * @param anchorY 站立时的锚点高度比例，默认 1（脚底）。
 */
export function clawPose(input: ClawInput, cfg: ClawFeel = clawFeel, anchorY = 1): ClawPose {
  const lift = clamp(input.lift, 0, 1);
  const sq = squash(input.sag * lift + input.rebound);
  return {
    pivotY: anchorY + (cfg.liftPivotY - anchorY) * lift,
    riseFrac: -(cfg.liftRise * lift) || 0,
    rotation: input.swing * lift,
    skewX: clamp((input.swing - input.lag) * cfg.lagGain, -cfg.lagMax, cfg.lagMax) * lift,
    scaleX: sq.scaleX,
    scaleY: sq.scaleY,
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
