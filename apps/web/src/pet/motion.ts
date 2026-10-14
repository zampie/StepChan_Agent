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
