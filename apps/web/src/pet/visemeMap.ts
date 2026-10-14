// 音频 RMS → 口型。单一映射点，渲染器和测试都用这里。
//
// 为什么不按文字节奏摆嘴：文字到达时间和实际出声时间差几百毫秒（TTS 要排队、要缓冲），
// 按文字摆出来的是「嘴在念字幕」，不是在说话。驱动源只能是正在播放的音频电平。
//
// 为什么要滞回（hysteresis）：RMS 在阈值附近每帧抖动，直接比大小会让嘴 60fps 开合，
// 看起来像打字机。上行阈值高于下行阈值，再加一个最短保持时间，抖动就被吃掉了。
import type { Viseme } from '../../../../shared/pet';

/** 由音频电平驱动的口型阶梯，按开口度递增。index 即「开口档位」。 */
export const audioVisemeLadder = [
  // up: 升到该档需要的电平；down: 掉出该档需要低于的电平。up > down 构成滞回带。
  { viseme: 'closed', up: 0, down: 0 },
  { viseme: 'small', up: 0.06, down: 0.035 },
  { viseme: 'medium', up: 0.2, down: 0.14 },
  { viseme: 'wide', up: 0.42, down: 0.3 },
] as const satisfies ReadonlyArray<{ viseme: Viseme; up: number; down: number }>;

/**
 * 'round' 与 'smile' 不由音频驱动 —— 它们是表情的静息口型（惊讶的「o」、开心的笑口），
 * 由 setExpression 决定，不参与电平阶梯。这是刻意的取舍：
 * 从单一 RMS 标量推不出元音形状，硬猜只会让口型和声音脱节。
 */
export const audioDrivenVisemes = audioVisemeLadder.map((l) => l.viseme);

/** 低于此电平视为静音，直接闭嘴（避免底噪把嘴撑开）。 */
export const silenceFloor = 0.02;
/** 档位最短保持时间，毫秒。比一帧长得多，用来吃掉帧级抖动。 */
export const minHoldMs = 70;

export class VisemeTracker {
  private level = 0; // 当前档位 index
  private heldSince = 0;
  private lastLevel = 0;

  constructor(
    private readonly ladder: ReadonlyArray<{ viseme: Viseme; up: number; down: number }> =
      audioVisemeLadder,
    private readonly hold = minHoldMs,
  ) {}

  /** 当前口型。 */
  get viseme(): Viseme {
    return this.ladder[this.level].viseme;
  }

  /** 平滑后的电平，渲染器可用它做细微的口型缩放。 */
  get smoothed(): number {
    return this.lastLevel;
  }

  reset(now = 0) {
    this.level = 0;
    this.heldSince = now;
    this.lastLevel = 0;
  }

  /**
   * 送入一帧音频电平，返回应该显示的口型。
   * @param raw 0..1 的 RMS。null / NaN 当静音处理。
   * @param nowMs 单调时钟（毫秒）。
   */
  update(raw: number | null, nowMs: number): Viseme {
    const level = raw == null || Number.isNaN(raw) ? 0 : Math.min(1, Math.max(0, raw));
    // 一阶低通：先把包络磨平，再做档位判定。两道防抖是互补的，
    // 低通管「毛刺」，滞回管「在阈值上反复横跳」。
    this.lastLevel += (level - this.lastLevel) * 0.35;
    const v = level < silenceFloor ? 0 : this.lastLevel;

    const canSwitch = nowMs - this.heldSince >= this.hold;
    const next = this.level + 1;
    if (next < this.ladder.length && v >= this.ladder[next].up) {
      // 升档不受最短保持时间限制：说话起音必须立刻张嘴，延迟会非常明显。
      this.level = next;
      this.heldSince = nowMs;
    } else if (this.level > 0 && v < this.ladder[this.level].down && canSwitch) {
      this.level -= 1;
      this.heldSince = nowMs;
    }
    return this.viseme;
  }
}
