// Step酱 桌宠的 Pixi 8 骨架渲染器。
//
// 与旧版 PetRenderer 的区别：旧版是「整图换帧」——每个表情一张全身图，切表情就是换贴图。
// 这里是 base 全身图 + 眼/眉/嘴覆盖层，覆盖层的位置来自 tools/art 的像素 diff 实测，
// 不是手标的。动画全部程序化（呼吸、摇摆、眨眼、挤压拉伸、交叉淡入），没有序列图。
//
// 三组对外行为，顺带说明各自的参数在哪（这里一个「手感数字」都不该硬编码）：
//   - 表情 / 口型 / 动作：rig.json（tools/art/register.py 的像素 diff 配准）。
//   - StepFun logo 图层：logo.json（tools/art/logo.py 的 SVG 几何 + **逐画幅**实测的
//     旧徽章中心与覆盖半径）。位置/直径/自转按动作分组放在清单里；本文件只放「怎么动」。
//   - 单击反应：tapReactions.ts 的 tapPools；按住聆听：motion.ts 的 listenFeel。
//
// **拖动刻意不做任何表现**，见 motion.ts 里那段说明（用户看过实际效果后的决定）。
//
// 解耦约定：本文件不 import voice/ 或 brain/ 下的任何东西，也不监听任何 DOM 事件。
// 音频电平、情绪意图、拖拽、单击、按住聆听都由 UI 推进来，渲染器只负责「怎么插值」。
import { Application, Assets, Container, Sprite, Texture } from 'pixi.js';
// Pixi 默认用 new Function() 动态拼着色器/批处理代码，而我们的 CSP 是 script-src 'self'，
// 于是 app.init() 直接抛 "Current environment does not allow unsafe-eval"，
// 角色一个像素都画不出来。这个模块名字有迷惑性：它是**替掉** eval 实现，
// 让 Pixi 走不需要 eval 的那条路，所以 CSP 不用为了桌宠开 'unsafe-eval'。
// 必须在建 Application 之前 import，所以放在这里而不是入口文件。
import 'pixi.js/unsafe-eval';
import {
  type ActionName,
  type BrowState,
  type Expression,
  type EyeState,
  type FxName,
  type RigManifest,
  type Viseme,
} from '../../../../shared/pet';
import {
  BlinkScheduler,
  BreathPhase,
  HoldTimer,
  ShuffleBag,
  Spring,
  breatheAt,
  crossfadeMs,
  easeInOut,
  fxPose,
  listenFeel,
  listenPose,
  squash,
  sway,
} from './motion';
import {
  ZzzEmitter,
  sleepExpression,
  sleepFeel,
  sleepPose,
  zzzSpawn,
  type FxSpawnPoint,
  type SleepPose,
} from './sleep';
import { loadRig, proceduralActions, isNoopAction, type LoadedRig } from './rigManifest';
import { logoSlots, type LogoPlacement, type LogoSlot } from './logoManifest';
import { fullBodyFallback, type PoseRegion } from './poseRegions';
import {
  tapActionHoldMs,
  tapExpressionHoldMs,
  tapPools,
  tapTargetOf,
  type TapReaction,
  type TapTarget,
} from './tapReactions';
import { VisemeTracker } from './visemeMap';
import { reportDiagnostic } from '../platform/diagnostics';

export interface RigRendererOptions {
  host: HTMLElement;
  manifestUrl: string;
  /** 显示高度（px）。桌宠一般 200–400。 */
  size?: number;
  reduceMotion?: boolean;
  onError?: (message: string) => void;
  /**
   * 姿势变化时回调**这个姿势**的命中区。
   *
   * 为什么要这个回调：命中判定在 Rust 侧（穿透一开，webview 收不到 mousemove），
   * 而命中区表原来只按 idle 立姿量过一次。换姿势后身体整个挪了位置 ——
   * sleep 侧躺时一个矩形都命中不到，鼠标直接穿透过去，点不中她。
   *
   * 坐标系与 shared/desktop.ts 的 hitRegionSchema 一致（归一化 0..1，素材画布），
   * 所以可以直接喂给 desktop.setHitRegions()。
   * 已经按姿势去重，同一个姿势不会反复回调；清单缺失时回调仍会发生，内容是整身兜底框。
   */
  onPoseRegions?: (regions: PoseRegion[], pose: ActionName) => void;
}

/**
 * FX 相对画布的生成位置，单位是画布高度的比例（x 从中心算，y 从脚底往上算）。
 *
 * 这一份是**按站立姿势**定的。睡觉时的 zzz 不走这里 —— 侧躺时头在画幅左侧，
 * 位置按逐姿势实测的头部框算（见 sleep.ts 的 zzzSpawn）。
 */
const FX_SPAWN: Record<FxName, FxSpawnPoint> = {
  sparkle: { x: 0.26, y: 0.84 },
  sweat: { x: 0.22, y: 0.78 },
  zzz: { x: 0.24, y: 0.92 },
  heart: { x: -0.24, y: 0.86 },
  exclaim: { x: 0.2, y: 0.94 },
  question: { x: 0.22, y: 0.94 },
  note: { x: -0.26, y: 0.82 },
};

/** 一次性 FX 的边长，单位＝画布高度的比例。 */
const FX_SIZE = 0.22;

const FX_LIFE_MS = 1400;

/**
 * 程序化动作的姿态偏移。
 *
 * tilt（歪头）没有独立素材：三版 prompt 都没让模型把头真的画歪
 * （见 rigManifest.ts 的 proceduralActions 与 rig.json 的 degraded）。
 * 头身比 40% 的 Q 版角色，整体倾斜在视觉上就读作歪头，所以在这里转。
 * 0.22 rad ≈ 12.6°，比 sway 的峰值（0.026 rad）大一个数量级，不会被呼吸晃动吃掉。
 */
const PROCEDURAL_POSE: Partial<Record<ActionName, { rotation: number }>> = {
  tilt: { rotation: 0.22 },
};

/** 这些眼型本身就是闭着/变形的，再叠眨眼只会打架。 */
const NO_BLINK: ReadonlySet<EyeState> = new Set<EyeState>(['closed', 'half', 'smile']);

/**
 * StepFun logo 图层的**动态**参数。
 *
 * 静态参数（圆心、直径、自转）全部在 logo.json 的 placements 里，由 tools/art/logo.py
 * 生成，这里一个都不许硬编码 —— 这是「以后微调只改一个数」的前提。
 * 这里只放「怎么动」：logo 贴在身上，所以呼吸/摇摆/倾斜/悬挂都由 body 容器的变换
 * 自动带上；额外要做的只有发饰那枚夹子的**滞后抖动**。
 *
 * 做法是一根软弹簧跟踪身体的总旋转角，差值（身体转了、夹子还没跟上）换算成夹子的额外自转。
 * 这就是二级动作：身体停下的瞬间夹子还在晃。placement.jiggle 是每个位置的系数
 * （发饰 0.35、胸前 0 —— 贴在平整衣料上的东西不该自己晃）。
 */
const LOGO_MOTION = {
  /** 滞后差值 → 额外自转的增益。 */
  followGain: 2.4,
  /** 额外自转上限，rad（≈7.5°）。再大就从头发上掉下来了。 */
  maxExtraRotation: 0.13,
  /** 跟踪身体旋转的软弹簧。欠阻尼（临界阻尼是 2√70 ≈ 16.7），所以会自己晃几下。 */
  stiffness: 70,
  damping: 6,
} as const;

/** 单击反馈的挤压冲量：先压一下，再由弹簧弹回（squash 输入 / 每秒）。 */
const TAP_POKE = { squash: -0.1, velocity: 1.4 } as const;

/** 按住聆听时强制的眼型。睁大眼是「我在听」最直接的一张脸。 */
const LISTEN_EYES: EyeState = 'wide';
/** 按住聆听时用作标记的特效素材（现有素材，不新生成）。音符 = 声音进来了。 */
const LISTEN_MARK: FxName = 'note';

/** 睡觉用的素材：整身姿势图 + zzz 特效，都是现有的。 */
const SLEEP_POSE: ActionName = 'sleep';
const SLEEP_MARK: FxName = 'zzz';

interface Slot {
  /** 正在淡入的层。 */
  cur: Sprite;
  /** 上一层，始终 alpha=1 垫在下面 —— 否则淡入过程中 base 原始的眼睛会透出来。 */
  prev: Sprite;
  fade: number;
  name: string | null;
}

interface FxInstance {
  sprite: Sprite;
  age: number;
  baseX: number;
  baseY: number;
  /** 把贴图归一化到目标大小（FX_SIZE / zzzSize）的缩放。生命周期曲线乘在它上面。 */
  baseScale: number;
}

/** logo 的一枚实例：贴图 + 它在**当前画幅**里的那份静态参数（换动作时整份替换）。 */
interface LogoInstance {
  slot: LogoSlot;
  sprite: Sprite;
  placement: LogoPlacement | null;
}

export class RigRenderer {
  private app = new Application();
  private ready = false;
  private disposed = false;
  private rig: LoadedRig | null = null;
  private manifest: RigManifest | null = null;

  /** 画布坐标系容器，pivot 落在锚点（中心/脚底）。 */
  private root = new Container();
  private body = new Container();
  private fxLayer = new Container();

  private baseCur = new Sprite();
  private basePrev = new Sprite();
  private baseFade = 1;
  /** sprite 模式表情用的整图覆盖层，盖满整个画布。 */
  private faceSprite = new Sprite();
  private faceSpriteTarget = 0;

  private eyes: Slot | null = null;
  private brow: Slot | null = null;
  private mouth: Slot | null = null;
  private blush = new Sprite();
  private blushTarget = 0;
  /** StepFun logo 层。挂在 body 下、faceSprite 之上 —— 整脸 sprite 会盖住整个画布。 */
  private logoLayer = new Container();
  private logos: LogoInstance[] = [];

  private textures = new Map<string, Texture>();
  private failed = new Set<string>();

  private expression: Expression = 'neutral';
  private action: ActionName = 'idle';
  private restingMouth: Viseme = 'closed';
  private visemeOverride: Viseme | null = null;
  private audioLevel: number | null = null;
  private viseme = new VisemeTracker();
  private blink = new BlinkScheduler();

  /** 程序化动作姿态（目前只有 tilt）。单独一根弹簧，和聆听侧倾叠加而不是互相覆盖。 */
  private poseSpring = new Spring(120, 15);
  /** 单击的挤压反馈。 */
  private tapSpring = new Spring(320, 12);
  /** 发饰那枚 logo 的滞后跟踪器（见 LOGO_MOTION）。 */
  private logoSpring = new Spring(LOGO_MOTION.stiffness, LOGO_MOTION.damping);
  /** 「按住聆听」的进入程度 0..1。整个聆听姿态都乘在它上面，所以松手时平滑收回。 */
  private listenSpring = new Spring(listenFeel.stiffness, listenFeel.damping);
  private listening = false;
  /** 聆听时耳边那枚常驻标记（现有 fx 素材，不是一次性特效）。 */
  private listenMark = new Sprite();

  /**
   * 睡觉状态。**和「动作」是两件事** —— 它一直持续到被叫醒，不会自动回位。见 sleep.ts。
   * 主动睡觉（右键菜单）和自动打盹（IdleBehavior 的 nap 意图）都走 setSleeping()。
   */
  private sleepOn = false;
  /** 睡觉的进入程度 0..1。呼吸参数、摇摆抑制、静态标记透明度都乘在它上面。 */
  private sleepSpring = new Spring(sleepFeel.stiffness, sleepFeel.damping);
  /** 睡觉期间周期性冒 zzz 的节拍器。停止睡觉就停止生成，已飘起来的自然淡出。 */
  private zzz = new ZzzEmitter();
  /** reduceMotion 下那枚**常驻静态** zzz（正常模式下由周期性 FX 接管，这枚不显示）。 */
  private sleepMark = new Sprite();
  /**
   * 呼吸相位累加器。不是 breathe(clock) —— 睡着时周期要变长，
   * 直接换周期会让相位跳一下，正好跳在刚躺下那一刻。见 motion.ts 的 BreathPhase。
   */
  private breath = new BreathPhase();

  /** 单击触发的临时动作剩余时长。归零时自动回 idle。 */
  private tapAction = new HoldTimer();
  /**
   * 单击触发的临时**表情**倒计时。归零时自动回 neutral。
   *
   * 和动作的倒计时分开计，因为两者时长不同（姿势 1.4 s 够看，表情要 3.5 s 才读得出来）。
   * 关键在于**只有这条路径有倒计时**：setExpression() 是模型通过 express 工具走的路，
   * 那是她真实的情绪状态，不该几秒后被抹掉，所以 setExpression() 会 cancel 掉它。
   */
  private tapExpression = new HoldTimer();
  /** 每个部位一个洗牌袋，保证「每次换一个」。按需建，因为可用性要等素材加载完才知道。 */
  private tapBags = new Map<TapTarget, ShuffleBag<TapReaction>>();

  private fx: FxInstance[] = [];
  private clock = 0;
  private size: number;
  private reduceMotion: boolean;
  private observer?: ResizeObserver;
  /** 容器尺寸。 */
  private hostW = 0;
  private hostH = 0;
  /** 上一次已经喊出去的命中区姿势，用来去重 —— 同一个姿势不要反复回调。 */
  private emittedPose: ActionName | null = null;

  constructor(private opts: RigRendererOptions) {
    this.size = opts.size ?? 280;
    this.reduceMotion = opts.reduceMotion ?? false;
  }

  get canvas(): HTMLCanvasElement | null {
    return this.ready ? (this.app.canvas as HTMLCanvasElement) : null;
  }

  /**
   * 本次加载被降级的条目（供 UI 显示，不要静默吞掉）。
   * 合并了 rig.json / logo.json / hitregions.json 三份清单，以及两份 sidecar 自身
   * 加载失败的情况 —— sidecar 的降级不会出现在 rig.json 里，不合并就等于静默。
   */
  get degraded(): { name: string; reason: string }[] {
    return [
      ...(this.manifest?.degraded ?? []),
      ...(this.rig?.logo?.manifest.degraded ?? []),
      ...(this.rig?.logoError ? [{ name: 'logo', reason: this.rig.logoError }] : []),
      ...(this.rig?.regions?.manifest.degraded ?? []),
      ...(this.rig?.regionsError ? [{ name: 'hitRegions', reason: this.rig.regionsError }] : []),
    ];
  }

  /**
   * 建渲染器。按「最好看 → 最保险」的顺序逐档尝试。
   *
   * 为什么要回退链：实测在 Tauri 的 WKWebView 里，写死 `preference:'webgl'` + MSAA 的
   * 那一档会直接抛错，于是整个角色根本不出现 —— 而原来的 `catch {}` 把异常内容丢了，
   * 现场只剩「桌宠完全透明」这一个毫无指向性的症状。
   * 所以这里每一档都记下真实报错，全挂了才放弃，并把所有报错一起喊出去。
   */
  private async initRenderer(): Promise<boolean> {
    const width = this.opts.host.clientWidth || this.size;
    const height = this.opts.host.clientHeight || this.size;
    const base = {
      backgroundAlpha: 0,
      resolution: Math.min(globalThis.devicePixelRatio ?? 1, 2),
      autoDensity: true,
      width,
      height,
    } as const;
    // MSAA 是第一个要牺牲的：平涂赛璐珞风格丢掉抗锯齿的代价远小于角色不出现。
    const attempts: { label: string; options: Parameters<Application['init']>[0] }[] = [
      { label: 'webgl+aa', options: { ...base, antialias: true, preference: 'webgl' } },
      { label: 'webgl', options: { ...base, antialias: false, preference: 'webgl' } },
      { label: 'auto+aa', options: { ...base, antialias: true } },
      { label: 'auto', options: { ...base, antialias: false } },
      { label: 'webgpu', options: { ...base, antialias: false, preference: 'webgpu' } },
    ];

    const failures: string[] = [];
    for (const attempt of attempts) {
      try {
        await this.app.init(attempt.options);
        if (failures.length) {
          // 降级成功也要留痕：下次有人问「为什么边缘有锯齿」时能查到原因。
          reportDiagnostic(
            `rig renderer: 用 ${attempt.label} 起来了；前面失败的档位 → ${failures.join(' | ')}`,
          );
        }
        return true;
      } catch (e) {
        failures.push(`${attempt.label}: ${(e as Error)?.message ?? String(e)}`);
        // Application 失败后内部状态不保证干净，换一个实例再试。
        this.app = new Application();
      }
    }
    this.fail(`渲染器无法初始化（已尝试 ${attempts.length} 档）：${failures.join(' | ')}`);
    return false;
  }

  async init() {
    if (!(await this.initRenderer())) return;
    this.ready = true;
    if (this.disposed) {
      this.app.destroy(true, { children: true });
      return;
    }
    this.opts.host.appendChild(this.app.canvas);

    try {
      this.rig = await loadRig(this.opts.manifestUrl);
    } catch (e) {
      this.fail(`角色清单加载失败：${(e as Error).message}`);
      return;
    }
    if (this.disposed) return;
    this.manifest = this.rig.manifest;
    if (this.rig.logoError) {
      // 不致命（角色照常显示），但必须留痕：症状是「身上还是那个假徽章」，
      // 没有这条日志的话根本看不出是 sidecar 清单没加载成功。
      reportDiagnostic(`rig: ${this.rig.logoError}`);
    }
    if (this.rig.regionsError) {
      // 同上。症状更隐蔽：命中区退回整身兜底框，部位细分（摸头/捏脸）全部失效。
      reportDiagnostic(`rig: ${this.rig.regionsError}`);
    }

    await this.loadTextures();
    if (this.disposed) return;
    if (!this.textures.has(this.manifest.base.file)) {
      this.fail('角色主体贴图加载失败，无法渲染。');
      return;
    }

    this.buildScene();
    // 素材加载是异步的，而「睡觉」可能在这之前就被要求了（自动打盹的计时器和加载并行跑，
    // 用户也可能在角色出现前就点了菜单）。那种情况下 setSleeping 里的 playAction
    // 因为 manifest 还是 null 而无效，所以这里补一次。不睡觉时它就是 playAction('idle')，
    // 和当前姿势相同 → 直接返回，什么都不做。
    this.playAction(this.restingAction);
    this.applyExpression(this.expression, true);
    // 初始姿势（idle）的命中区也要喊一次 —— 否则在第一次换动作之前，
    // 调用方手里一份命中区都没有。
    this.emitPoseRegions();

    this.observer = new ResizeObserver(() => this.layout());
    this.observer.observe(this.opts.host);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.app.ticker.add(this.onTick);
    this.layout();
    this.onVisibility();
  }

  // ---------------- 公开 API（UI 驱动） ----------------

  setSize(px: number) {
    this.size = px;
    if (this.ready) this.layout();
  }

  setReduceMotion(on: boolean) {
    this.reduceMotion = on;
    // zzz 的两种形态互斥：正常模式是周期性飘起来的 FX，reduceMotion 是一枚常驻静态图标。
    // 所以切换时要把节拍器跟着开关，否则 reduceMotion 下会同时有两种 zzz。
    this.zzz.setActive(this.sleepOn && !on);
    if (on) {
      this.blink.reset();
      for (const s of [this.poseSpring, this.tapSpring, this.logoSpring]) s.snap(0);
      this.listenSpring.snap(this.listening ? 1 : 0);
      this.sleepSpring.snap(this.sleepOn ? 1 : 0);
    }
  }

  /**
   * 设置表情。**模型通过 express 工具走的就是这条路。**
   *
   * 和 reactToTap 的区别只有一个，但很重要：这里设的表情**不会自动恢复**。
   * 那是她当前真实的情绪状态，几秒后把它抹掉等于把模型的输出吞了。
   * 所以这里顺手取消单击的表情倒计时 —— 否则点一下再让她说句话，
   * 3.5 秒后她的表情会莫名其妙塌回 neutral。
   */
  setExpression(expression: Expression) {
    this.tapExpression.cancel();
    if (expression === this.expression) return;
    this.applyExpression(expression, this.reduceMotion);
  }

  /** 显式指定口型，覆盖音频驱动。传 null 回到音频/静息口型。 */
  setViseme(v: Viseme | null) {
    this.visemeOverride = v;
  }

  /** 送入正在播放音频的 0..1 电平。传 null 表示没有音频在放。 */
  setAudioLevel(level: number | null) {
    this.audioLevel = level;
    if (level == null) this.viseme.reset(this.clock);
  }

  playAction(action: ActionName) {
    // 外部显式换动作 → 取消单击的自动回 idle，否则 1.4 s 后会把别人刚设的姿势抹掉。
    this.tapAction.cancel();
    if (action === this.action) return;
    const asset = this.manifest?.actions[action];
    if (!asset) return;
    const tex = this.textures.get(asset.file);
    if (!tex) {
      this.opts.onError?.(`动作 ${action} 素材缺失，保持当前姿势。`);
      return;
    }
    this.action = action;
    this.swapBase(tex, this.reduceMotion);
    // 换姿势后脸部覆盖层必然失配（diff 配准只对 idle 画幅成立）→ 整组隐藏。
    // 这不是偷懒，是流水线能保证的边界：动作图自带表情。
    // 程序化动作用的是 idle 的图，画幅没变，所以覆盖层继续有效。
    this.setLayersVisible(action === 'idle' || proceduralActions.has(action));
    this.syncLogoPlacements();
    this.emitPoseRegions();
  }

  spawnFx(name: FxName) {
    this.spawnFxAt(name, FX_SPAWN[name], FX_SIZE);
  }

  /**
   * 在指定位置生成一枚一次性 FX。
   * 位置抽成参数是为了睡觉的 zzz —— 它要跟着姿势走，不能用 FX_SPAWN 那份站立常量。
   */
  private spawnFxAt(name: FxName, spawn: FxSpawnPoint, size: number) {
    const asset = this.manifest?.fx[name];
    if (!asset) return;
    const tex = this.textures.get(asset.file);
    if (!tex || !this.manifest) return;
    const sprite = new Sprite(tex);
    sprite.anchor.set(0.5);
    const h = this.manifest.canvas.height;
    sprite.width = h * size;
    sprite.height = h * size;
    const baseScale = sprite.scale.x;
    const baseX = this.manifest.canvas.width * this.manifest.anchor.x + spawn.x * h;
    const baseY = h * this.manifest.anchor.y - spawn.y * h;
    sprite.position.set(baseX, baseY);
    this.fxLayer.addChild(sprite);
    this.fx.push({ sprite, age: 0, baseX, baseY, baseScale });
  }

  /** 睡觉期间的一枚 zzz：位置按**当前姿势**实测的头部框算（见 sleep.ts 的 zzzSpawn）。 */
  private spawnSleepZzz() {
    this.spawnFxAt(SLEEP_MARK, zzzSpawn(this.poseRegions()), sleepFeel.zzzSize);
  }

  /** 当前姿势的命中区。清单缺失时是整身兜底框，绝不是空数组。 */
  private poseRegions(): PoseRegion[] {
    return this.rig?.regions?.regionsFor(this.action) ?? [fullBodyFallback()];
  }

  /**
   * 拖拽状态。**刻意什么都不做。**
   *
   * 这里原来是一整套「抓娃娃机」悬挂表现（支点搬到头顶、身体垂下、随手摆动、落地回弹）。
   * 用户看过实际效果后的结论是「效果不太好，取消拖动动画，拖动时不做任何动作」，
   * 所以那套实现（五根弹簧 + clawPose + clawFeel + 对应单测）被整个删掉了，
   * 拖动期间角色就是正常的 idle 呼吸。详见 motion.ts 里那段说明。
   *
   * 签名保留是因为 App.tsx 的手势处理仍然调它（拖动开始/结束各一次），
   * 而且以后真要做点什么（比如换一张「被提起」的整身图）这就是入口。
   * **想加回拖动动画之前先去问人** —— 这是产品决定，不是漏实现。
   *
   * @param _on 是否正在拖拽。
   * @param _velocity 指针速度（px/s）。
   */
  setDragging(_on: boolean, _velocity?: { x: number; y: number }) {
    // 故意空实现，见上面的说明。
  }

  /**
   * 「按住聆听」状态：按住桌宠说话时，给一个一眼能和 idle 区分开、而且**持续**的表现。
   *
   * 三件事同时发生（全部用现有素材 + 程序化，没有新素材）：
   *   - 身体恒定侧倾 + 很慢的点头（motion.ts 的 listenPose，参数在 listenFeel）
   *   - 眼睛强制睁大（rig.json 里现成的 eyes.wide 覆盖层）
   *   - 耳边一枚常驻的音符标记（现有 fx-note 素材）做呼吸式脉动，透明度有下限 ——
   *     不会像一次性 FX 那样淡出消失，这是「状态」而不是「动画」的关键
   *
   * reduceMotion 下退化为静态：侧倾与标记照常（它们是**姿势**，表达「我在听」），
   * 但不点头、不脉动。
   *
   * 和表情/动作是正交的：聆听期间她照样可以是 happy、照样可以在 sit。
   * 眼型是唯一会被压过去的 —— 睁大眼就是这个状态最直接的信号。
   */
  setListeningHold(on: boolean) {
    this.listening = on;
    if (this.reduceMotion) this.listenSpring.snap(on ? 1 : 0);
  }

  /** 她现在是不是睡着的。供右键菜单显示勾选状态，以及诊断/测试。 */
  get sleeping() {
    return this.sleepOn;
  }

  /**
   * 睡觉状态。**主动睡觉（右键菜单）和自动打盹（IdleBehavior 的 nap 意图）都走这一个方法** ——
   * 不要为菜单单独做一套，否则两条路的表现迟早漂开。
   *
   * 它是「状态」不是「动作」，这件事体现在四个地方（为什么必须如此见 sleep.ts 顶部）：
   *   - 姿势回位的目标变成 sleep 而不是 idle（restingAction）。所以睡觉期间被点一下、
   *     临时动作播完之后，她是**躺回去**而不是站起来。
   *   - 表情走 setExpression() 这条「模型路径」，它会取消单击的 3.5 s 倒计时，
   *     所以 sleepy 不会被抹掉；万一之后又被点了，倒计时到点也是回 sleepy（restingExpression）。
   *   - 闲置摇摆按 sleepPose().swayScale 抑制到 0，呼吸换成更慢更浅的一套。
   *   - 头顶周期性冒 zzz（ZzzEmitter + zzzSpawn），不是一次性 spawn 一个。
   *
   * 命中区：走 playAction() 这条路，所以 onPoseRegions 回调会照常触发并切到 sleep 那套
   * （侧躺时 idle 的矩形一个都命中不到 —— 这是用户报过的「换姿势后点不中她」那个 bug）。
   *
   * reduceMotion 下退化为静态：姿势与呼吸照常（呼吸本来就被 reduceMotion 整体关掉），
   * 周期性 zzz 换成**一枚常驻静态 zzz** —— 不是完全没有，用户要能看出她在睡。
   */
  setSleeping(on: boolean) {
    if (this.sleepOn === on) return;
    this.sleepOn = on;
    this.zzz.setActive(on && !this.reduceMotion);
    if (this.reduceMotion) this.sleepSpring.snap(on ? 1 : 0);
    // 这两行同时负责「进入」和「平滑退出」：退出时 restingAction/Expression 就是 idle/neutral。
    // playAction 内部会 emitPoseRegions()，命中区因此跟着姿势一起切。
    this.playAction(this.restingAction);
    this.setExpression(this.restingExpression);
  }

  /**
   * 「没有临时状态时应该是什么姿势」。
   * 睡觉是持续状态，所以单击的临时动作播完之后要躺回去，而不是一律回 idle。
   */
  private get restingAction(): ActionName {
    return this.sleepOn ? SLEEP_POSE : 'idle';
  }

  /** 同上，表情。 */
  private get restingExpression(): Expression {
    return this.sleepOn ? sleepExpression : 'neutral';
  }

  /**
   * 单击反应：每次换一个表情/动作/特效，不连续重复，按部位分组。
   *
   * 只暴露 API，**不监听任何 DOM 事件** —— 点击命中判定在 Rust 侧（见 hittest.rs），
   * 事件由 UI 转进来。
   *
   * @param part 被点到的部位。接受 TouchPart（head/cheek/badge/hand）以及渲染层专属的
   *             'skirt'；认不出来的字符串（含 null）走 default 组，不报错。
   * @returns 实际应用的那条反应，便于上层记日志；渲染器还没就绪时返回 null。
   */
  reactToTap(part?: string | null): TapReaction | null {
    if (!this.ready || !this.manifest) return null;
    const reaction = this.nextTapReaction(tapTargetOf(part));
    if (!reaction) return null;
    if (reaction.expression) {
      this.setExpression(reaction.expression);
      // setExpression 会把倒计时清零（模型设的表情不该过期），所以在后面设。
      // 这就是「点击引起的临时表情」与「模型设的表情」唯一的区别所在。
      this.tapExpression.arm(tapExpressionHoldMs);
    }
    if (reaction.action) {
      this.playAction(reaction.action);
      // playAction 会把它清零（外部换动作要能取消自动回位），所以在后面设。
      this.tapAction.arm(tapActionHoldMs);
    }
    if (reaction.fx) this.spawnFx(reaction.fx);
    // 眨眼和挤压是纯动效，reduceMotion 下跳过；表情和动作是「状态」，照常生效。
    if (!this.reduceMotion) {
      if (reaction.blink) this.blink.trigger(reaction.blink === 'double');
      if (reaction.poke) {
        this.tapSpring.value = TAP_POKE.squash;
        this.tapSpring.velocity = TAP_POKE.velocity;
      }
    }
    return reaction;
  }

  /** 外部可以手动推进（测试或自定义 ticker）。dtMs 为本帧毫秒数。 */
  update(dtMs: number) {
    if (this.disposed || !this.ready || !this.manifest) return;
    const dt = Math.min(0.05, Math.max(0.001, dtMs / 1000));
    this.clock += dtMs;

    // 单击触发的临时动作/表情到点就回位。两个都用倒计时而不是 setTimeout：
    // 渲染器销毁时不用额外清理，页面隐藏（ticker 停）时也不会在后台乱跳。
    // 回位目标是 restingAction/restingExpression 而不是写死的 idle/neutral ——
    // 睡着的时候被点一下，临时动作播完必须**躺回去**，不是站起来。
    if (this.tapAction.tick(dtMs)) this.playAction(this.restingAction);
    // setExpression 自己会 cancel 掉倒计时，所以这里不用再清一次。
    if (this.tapExpression.tick(dtMs)) this.setExpression(this.restingExpression);

    // 睡觉期间周期性冒 zzz。一次最多一个（超长帧不补课，见 ZzzEmitter.update）。
    if (this.zzz.update(dtMs) > 0) this.spawnSleepZzz();

    this.stepFades(dtMs);
    this.stepFace(dtMs);
    this.stepPose(dt);
    this.stepFx(dtMs);
  }

  destroy() {
    this.disposed = true;
    this.observer?.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibility);
    if (!this.ready) return;
    this.app.ticker.remove(this.onTick);
    for (const tex of this.textures.values()) tex.destroy(true);
    this.textures.clear();
    // texture:false —— 贴图已在上面显式销毁，交给 Pixi 二次销毁会触发已释放资源的告警。
    this.app.destroy(true, { children: true, texture: false, textureSource: false });
  }

  // ---------------- 内部 ----------------

  private fail(message: string) {
    if (!this.disposed) this.opts.onError?.(message);
  }

  private async loadTextures() {
    const m = this.manifest!;
    const files = new Set<string>([m.base.file]);
    for (const slot of [m.layers.eyes, m.layers.brow, m.layers.mouth]) {
      for (const o of Object.values(slot)) files.add(o.file);
    }
    if (m.layers.blush) files.add(m.layers.blush.file);
    for (const e of Object.values(m.expressions)) {
      if (e.mode === 'sprite') files.add(e.sprite.file);
    }
    for (const a of Object.values(m.actions)) files.add(a.file);
    for (const f of Object.values(m.fx)) files.add(f.file);
    const logoAsset = this.rig?.logo?.manifest.asset;
    if (logoAsset) files.add(logoAsset.file);

    const reasons = new Set<string>();
    await Promise.all(
      [...files].map(async (file) => {
        try {
          const tex = await Assets.load<Texture>(this.rig!.baseUrl + file);
          this.textures.set(file, tex);
        } catch (e) {
          this.failed.add(file);
          // 把真实原因留下。全部失败时它们几乎一定是同一个原因（CSP / 路径 / 协议），
          // 而「36 个素材加载失败」这种计数本身完全不指向原因。
          reasons.add((e as Error)?.message ?? String(e));
        }
      }),
    );
    if (this.failed.size > 0) {
      const sample = [...this.failed][0];
      reportDiagnostic(
        `textures failed ${this.failed.size}/${files.size}; baseUrl=${this.rig!.baseUrl} ` +
          `sample=${this.rig!.baseUrl}${sample}; reasons=${[...reasons].join(' | ') || '(无 message)'}`,
      );
      // 不静默：缺素材会表现为「表情没反应」，必须让人看到原因。
      this.opts.onError?.(
        `${this.failed.size} 个角色素材加载失败，相关表情/动作将回退到主体图。`,
      );
    }
  }

  private makeSlot(parent: Container): Slot {
    const prev = new Sprite();
    const cur = new Sprite();
    prev.alpha = 1;
    cur.alpha = 0;
    prev.visible = false;
    cur.visible = false;
    parent.addChild(prev, cur);
    return { cur, prev, fade: 1, name: null };
  }

  private buildScene() {
    const m = this.manifest!;
    this.basePrev.visible = false;
    this.baseCur.texture = this.textures.get(m.base.file)!;
    this.body.addChild(this.basePrev, this.baseCur);

    this.brow = this.makeSlot(this.body);
    this.eyes = this.makeSlot(this.body);
    this.mouth = this.makeSlot(this.body);

    if (m.layers.blush) {
      const tex = this.textures.get(m.layers.blush.file);
      if (tex) {
        this.blush.texture = tex;
        this.blush.position.set(m.layers.blush.x, m.layers.blush.y);
        this.blush.alpha = 0;
        this.body.addChild(this.blush);
      }
    }

    this.faceSprite.alpha = 0;
    this.faceSprite.visible = false;
    this.body.addChild(this.faceSprite);

    // logo 必须在 faceSprite **之后**加：整脸 sprite 是满画布的，排在它前面会被整块盖掉。
    this.buildLogo();
    this.body.addChild(this.logoLayer);

    // 聆听标记与睡觉标记都挂在 fxLayer 上而不是 body 里：它们和 FX 同级，跟着整体
    // （呼吸、侧倾）走，但不参与脸部覆盖层那套显隐逻辑 —— 在任何动作、任何表情下都要能出现。
    // 两枚都复用现成的 fx 贴图，没有新素材。
    this.buildMark(
      LISTEN_MARK,
      this.listenMark,
      `聆听标记素材缺失（fx.${LISTEN_MARK}），按住说话时只有侧耳与睁大眼`,
    );
    this.buildMark(
      SLEEP_MARK,
      this.sleepMark,
      `睡觉标记素材缺失（fx.${SLEEP_MARK}），reduceMotion 下睡觉只有姿势、看不到 zzz`,
    );

    this.root.addChild(this.body, this.fxLayer);
    this.root.pivot.set(m.canvas.width * m.anchor.x, m.canvas.height * m.anchor.y);
    this.app.stage.addChild(this.root);
  }

  /** 建一枚**常驻**标记 sprite（不是一次性 FX）：聆听的音符、睡觉的 zzz 各一枚。 */
  private buildMark(name: FxName, sprite: Sprite, missingNote: string) {
    const asset = this.manifest!.fx[name];
    const tex = asset && this.textures.get(asset.file);
    if (!tex) {
      reportDiagnostic(missingNote);
      return;
    }
    sprite.texture = tex;
    sprite.anchor.set(0.5);
    sprite.visible = false;
    this.fxLayer.addChild(sprite);
  }

  /**
   * 按 logo.json 建 logo sprite：每个位置一枚，共两枚，建完就不再增删。
   *
   * 位置/直径/自转全部来自清单的**当前动作**那一格，这里只做「清单 → sprite 属性」的翻译。
   * 贴图是 256 px 的，按 placement.size 缩到 17–35 px —— 所以放大桌宠或换 retina
   * 不会糊，而且以后想调大小只改 logo.py 的 COVER_MARGIN / LOGO_TUNING。
   */
  private buildLogo() {
    const logo = this.rig?.logo;
    if (!logo) return;
    const tex = this.textures.get(logo.manifest.asset.file);
    if (!tex) {
      // 贴图没下来已经在 loadTextures 里报过了；这里只记一条指向性更强的。
      reportDiagnostic(`logo 贴图缺失：${logo.manifest.asset.file}，身上会留着假徽章`);
      return;
    }
    for (const slot of logoSlots) {
      const sprite = new Sprite(tex);
      sprite.anchor.set(0.5);
      sprite.visible = false;
      this.logoLayer.addChild(sprite);
      this.logos.push({ slot, sprite, placement: null });
    }
    this.syncLogoPlacements();
  }

  /**
   * 把 logo sprite 对准**当前姿势**的实测位置。
   *
   * 每张姿势图上那两枚假徽章的位置都单独量过（tools/art/logo.py 的 find_badges），
   * 所以换动作就是换一组 cx/cy/size —— 不再像上一版那样「只在 idle/tilt 显示」。
   * 某个位置在这个姿势下量不到（实测 sleep 侧躺、hold 双手抱胸的胸前徽章被遮住）时，
   * 清单里就没有那一格，这里对应地把那一枚藏起来 —— 不猜位置，宁可少画一枚。
   */
  private syncLogoPlacements() {
    const logo = this.rig?.logo;
    this.logoLayer.visible = !!logo && this.logos.length > 0;
    if (!logo) return;
    const frame = logo.placementsFor(this.action);
    for (const l of this.logos) {
      const p = frame[l.slot];
      l.placement = p ?? null;
      l.sprite.visible = !!p;
      if (!p) continue;
      l.sprite.width = p.size;
      l.sprite.height = p.size;
      l.sprite.position.set(p.cx, p.cy);
      l.sprite.rotation = p.rotation;
    }
  }

  /**
   * 把当前姿势的命中区喊出去。按姿势去重 —— 同一个姿势不反复回调。
   *
   * 兜底是硬要求：清单缺失、或者某个姿势一个矩形都没量出来时，退回**整身外接框**。
   * 宁可整只都能点，也不能像 sleep 那次一样一个矩形都命中不到、鼠标直接穿透过去。
   */
  private emitPoseRegions() {
    const cb = this.opts.onPoseRegions;
    if (!cb || this.emittedPose === this.action) return;
    this.emittedPose = this.action;
    cb(this.poseRegions(), this.action);
  }

  /**
   * 取下一条单击反应。
   *
   * 两件事在这里做，不在 tapReactions.ts 里做 —— 它们都依赖**运行时**的清单与贴图：
   * 1. 可用性消毒。rig.json 里「没做出来」的动作指向 idle 的整身图（sha256 == base），
   *    播出去等于「说要指给你看然后一动不动」；缺贴图的特效同理。
   *    这类字段直接抹掉而不是把整条反应丢掉 —— 丢掉会缩小候选池，
   *    而每条反应至少还换一个表情，仍然是「换了一个」。
   * 2. 洗牌袋按部位缓存，所以「不连续重复」是按部位算的：
   *    连点头顶不会重复，但头顶和脸颊各自的轮转互不干扰（它们本来就是不同的反应）。
   */
  private nextTapReaction(target: TapTarget): TapReaction | null {
    let bag = this.tapBags.get(target);
    if (!bag) {
      const m = this.manifest!;
      const sanitized = tapPools[target].map((r) => ({
        ...r,
        action: r.action && !isNoopAction(m, r.action) ? r.action : undefined,
        fx: r.fx && this.textures.has(m.fx[r.fx].file) ? r.fx : undefined,
      }));
      if (sanitized.length === 0) return null;
      bag = new ShuffleBag<TapReaction>(sanitized);
      this.tapBags.set(target, bag);
    }
    return bag.next();
  }

  /** 覆盖层当前是否成立。程序化动作用的是 idle 的图，画幅没变，覆盖层继续有效。 */
  private layersActive() {
    return this.action === 'idle' || proceduralActions.has(this.action);
  }

  private setLayersVisible(on: boolean) {
    for (const slot of [this.eyes, this.brow, this.mouth]) {
      if (!slot) continue;
      slot.cur.visible = on && !!slot.cur.texture && slot.name != null;
      slot.prev.visible = on && slot.prev.visible;
    }
    if (!on) {
      this.blushTarget = 0;
      this.faceSpriteTarget = 0;
    }
  }

  private applyExpression(expression: Expression, instant: boolean) {
    this.expression = expression;
    const m = this.manifest;
    if (!m) return;
    const entry = m.expressions[expression];
    if (!entry) return;

    if (entry.mode === 'sprite') {
      const tex = this.textures.get(entry.sprite.file);
      if (tex) {
        this.faceSprite.texture = tex;
        this.faceSprite.visible = true;
        this.faceSpriteTarget = 1;
        if (instant) this.faceSprite.alpha = 1;
        return;
      }
      // 整图也没了 → 退回中性分层，而不是什么都不显示。
      this.faceSpriteTarget = 0;
      this.setSlot(this.eyes, m.layers.eyes.open, 'open', instant);
      this.setSlot(this.brow, m.layers.brow.neutral, 'neutral', instant);
      this.restingMouth = 'closed';
      this.blushTarget = 0;
      return;
    }

    this.faceSpriteTarget = 0;
    this.setSlot(this.brow, m.layers.brow[entry.brow], entry.brow, instant);
    this.setSlot(this.eyes, m.layers.eyes[entry.eyes], entry.eyes, instant);
    this.restingMouth = entry.mouth;
    this.blushTarget = entry.blush && this.blush.texture ? 1 : 0;
    if (instant) this.blush.alpha = this.blushTarget;
  }

  private setSlot(
    slot: Slot | null,
    overlay: { file: string; x: number; y: number } | undefined,
    name: string,
    instant: boolean,
  ) {
    if (!slot || !overlay) return;
    if (slot.name === name) return;
    const tex = this.textures.get(overlay.file);
    if (!tex) return;
    if (slot.cur.texture && slot.name) {
      slot.prev.texture = slot.cur.texture;
      slot.prev.position.copyFrom(slot.cur.position);
      slot.prev.visible = true;
      slot.prev.alpha = 1;
    }
    slot.cur.texture = tex;
    slot.cur.position.set(overlay.x, overlay.y);
    // **必须过 layersActive()，不能无条件 true。**
    // 覆盖层的 x/y 是按 idle 画幅实测的，换姿势（sleep 侧躺、sit 坐下…）之后
    // 那个坐标没有意义。playAction 会先 setLayersVisible(false) 把它们藏起来，
    // 但紧接着设表情就会走到这里 —— 原来这一行无条件显示，于是眼睛又冒出来、
    // 还贴在站立时的位置上。用户报的「去睡吧时眼睛贴图位置不对」就是这条。
    slot.cur.visible = this.layersActive();
    slot.cur.alpha = instant ? 1 : 0;
    slot.fade = instant ? 1 : 0;
    slot.name = name;
    if (instant) slot.prev.visible = false;
    if (!slot.cur.visible) slot.prev.visible = false;
  }

  private stepFades(dtMs: number) {
    const step = dtMs / crossfadeMs;
    for (const slot of [this.eyes, this.brow, this.mouth]) {
      if (!slot || slot.fade >= 1) continue;
      slot.fade = Math.min(1, slot.fade + step);
      slot.cur.alpha = easeInOut(slot.fade);
      if (slot.fade >= 1) slot.prev.visible = false;
    }
    if (this.baseFade < 1) {
      this.baseFade = Math.min(1, this.baseFade + step);
      this.baseCur.alpha = easeInOut(this.baseFade);
      if (this.baseFade >= 1) this.basePrev.visible = false;
    }
    this.faceSprite.alpha += (this.faceSpriteTarget - this.faceSprite.alpha) * Math.min(1, step);
    this.faceSprite.visible = this.faceSprite.alpha > 0.002 && this.layersActive();
    this.blush.alpha += (this.blushTarget - this.blush.alpha) * Math.min(1, step);
  }

  private stepFace(dtMs: number) {
    const m = this.manifest!;
    if (!this.layersActive() || this.faceSpriteTarget > 0.5) return;

    // 口型优先级：显式覆盖 > 音频电平 > 表情静息口型。
    let viseme: Viseme = this.restingMouth;
    if (this.visemeOverride) viseme = this.visemeOverride;
    else if (this.audioLevel != null) viseme = this.viseme.update(this.audioLevel, this.clock);
    this.setSlot(this.mouth, m.layers.mouth[viseme], viseme, this.reduceMotion);

    // 眨眼只覆盖「睁着的」眼型。闭眼/笑眼再眨一次是自相矛盾的。
    const entry = m.expressions[this.expression];
    let restEye: EyeState = entry && entry.mode === 'layers' ? entry.eyes : 'open';
    // 按住聆听时强制睁大眼，压过表情自己的眼型 —— 这是「我在听」最直接的信号，
    // 而且必须持续存在，所以不能让 happy 的笑眼把它盖回去。
    if (this.listening) restEye = LISTEN_EYES;
    if (this.reduceMotion || NO_BLINK.has(restEye)) {
      this.setSlot(this.eyes, m.layers.eyes[restEye], restEye, true);
      return;
    }
    const blinkEye = this.blink.update(dtMs);
    const eye = blinkEye ?? restEye;
    this.setSlot(this.eyes, m.layers.eyes[eye], eye, true);
  }

  private stepPose(dt: number) {
    const m = this.manifest!;
    const scale = this.size / m.canvas.height;
    const pose = PROCEDURAL_POSE[this.action]?.rotation ?? 0;
    // 聆听的进入程度。reduceMotion 下 setListeningHold 已经把它钉到位，step 不会改变结论。
    const listen = this.listenSpring.step(this.listening ? 1 : 0, dt);
    const lp = listenPose(this.clock, listen, !this.reduceMotion);
    this.applyListenMark(lp);
    // 睡觉的进入程度。同样 reduceMotion 下已被钉住。
    const sp = sleepPose(this.sleepSpring.step(this.sleepOn ? 1 : 0, dt), !this.reduceMotion);
    this.applySleepMark(sp);

    if (this.reduceMotion) {
      this.root.scale.set(scale);
      // reduceMotion 下程序化动作与聆听侧倾仍然生效 —— 它们表达的是「姿势」，不是「动效」。
      // 只是不做弹簧过渡，直接到位。
      this.root.rotation = pose + lp.rotation;
      this.poseSpring.snap(pose);
      for (const l of this.logos) if (l.placement) l.sprite.rotation = l.placement.rotation;
      this.placeRoot();
      return;
    }

    // 呼吸：睡着时更慢更浅（见 sleepFeel 的依据）。周期逐帧插值，所以用累加相位而不是时钟，
    // 否则「刚躺下」那一帧相位会跳。
    const br = breatheAt(this.breath.step(dt * 1000, sp.breathPeriodMs), sp.breathAmplitude);
    // 单击挤压：目标恒为 0，靠 reactToTap 打进去的初值和初速度自由衰减。
    const sq = squash(this.tapSpring.step(0, dt));
    const scaleX = scale * br.scaleX * sq.scaleX;
    const scaleY = scale * br.scaleY * sq.scaleY;
    this.root.scale.set(scaleX, scaleY);
    // 程序化姿势 + 聆听侧倾/点头 + 闲置摇摆。三者相加，不互相覆盖。
    // 摇摆按 swayScale 抑制：侧躺的人左右摇读起来像在抽搐，所以睡着时为 0。
    this.root.rotation =
      this.poseSpring.step(pose, dt) + lp.rotation + sway(this.clock) * sp.swayScale;
    this.placeRoot();
    this.stepLogo(this.root.rotation, dt);
  }

  /**
   * 聆听标记（耳边那枚音符）的每帧更新。
   * 位置固定在发饰那一侧，缩放与透明度由 listenPose 的脉动给 —— alpha 有下限，
   * 所以只要还按着就一直看得见（这是「持续状态」与「一次性 FX」的区别）。
   */
  private applyListenMark(lp: { markScale: number; markAlpha: number }) {
    if (!this.listenMark.texture || !this.manifest) return;
    const visible = lp.markAlpha > 0.002;
    this.listenMark.visible = visible;
    if (!visible) return;
    const m = this.manifest;
    const h = m.canvas.height;
    const side = h * lp.markScale;
    this.listenMark.width = side;
    this.listenMark.height = side;
    this.listenMark.alpha = lp.markAlpha;
    this.listenMark.position.set(
      m.canvas.width * m.anchor.x + listenFeel.markX * h,
      h * m.anchor.y - listenFeel.markY * h,
    );
  }

  /**
   * reduceMotion 下那枚常驻静态 zzz 的每帧更新。
   *
   * 正常模式下 sleepPose().markAlpha 恒为 0，这枚永远不显示 —— 那时 zzz 是周期性生成的 FX。
   * reduceMotion 下反过来：节拍器是关掉的，改由这一枚**不动不闪**的图标表示「她在睡」。
   * 完全不显示是不行的：reduceMotion 的用户也要看得出状态（和聆听那枚音符的处理一致）。
   *
   * 位置和飘动的 zzz 用同一个几何函数，所以两种模式下 zzz 冒在同一个地方。
   */
  private applySleepMark(sp: SleepPose) {
    if (!this.sleepMark.texture || !this.manifest) return;
    const visible = sp.markAlpha > 0.002;
    this.sleepMark.visible = visible;
    if (!visible) return;
    const m = this.manifest;
    const h = m.canvas.height;
    const side = h * sleepFeel.zzzSize;
    this.sleepMark.width = side;
    this.sleepMark.height = side;
    this.sleepMark.alpha = sp.markAlpha;
    const spawn = zzzSpawn(this.poseRegions());
    this.sleepMark.position.set(
      m.canvas.width * m.anchor.x + spawn.x * h,
      h * m.anchor.y - spawn.y * h,
    );
  }

  /**
   * 落位：支点固定在锚点（脚底中心），角色站在容器底边中间。
   *
   * 支点不再在帧与帧之间移动（原来被提起时会搬到头顶），所以这里不需要补偿项 ——
   * 锚点和支点是同一点时，position 就是锚点在屏幕上的落点。
   */
  private placeRoot() {
    const m = this.manifest!;
    this.root.pivot.set(m.canvas.width * m.anchor.x, m.canvas.height * m.anchor.y);
    this.root.position.set((this.hostW || this.size) / 2, this.hostH || this.size);
  }

  /**
   * logo 的二级动作：软弹簧跟踪身体旋转，差值换算成额外自转。
   * jiggle=0 的位置（胸前）直接贴死，不走弹簧 —— 衣料上的东西不该自己晃。
   * placement 为 null 的位置（这个姿势下徽章被遮住）整个跳过，sprite 本来就是隐藏的。
   */
  private stepLogo(bodyRotation: number, dt: number) {
    if (this.logos.length === 0) return;
    const tracked = this.logoSpring.step(bodyRotation, dt);
    const lagAngle = bodyRotation - tracked;
    for (const l of this.logos) {
      const p = l.placement;
      if (!p) continue;
      if (p.jiggle <= 0) {
        l.sprite.rotation = p.rotation;
        continue;
      }
      const extra = clamp(
        lagAngle * LOGO_MOTION.followGain * p.jiggle,
        -LOGO_MOTION.maxExtraRotation,
        LOGO_MOTION.maxExtraRotation,
      );
      l.sprite.rotation = p.rotation + extra;
    }
  }

  private stepFx(dtMs: number) {
    if (this.fx.length === 0) return;
    const keep: FxInstance[] = [];
    for (const inst of this.fx) {
      inst.age += dtMs;
      const p = fxPose(inst.age, FX_LIFE_MS);
      if (p.done) {
        inst.sprite.destroy();
        continue;
      }
      inst.sprite.alpha = p.alpha;
      // 生命周期的缩放是**乘在**生成时那份归一化缩放上的。
      // 原来这里是 `scale.set(p.scale)`，直接把 spawnFx 里按画布高度算出来的
      // sprite.width/height 覆盖掉了 —— 于是 FX 的实际大小变成「贴图原始尺寸 × p.scale」
      // （256 px 贴图在 512 px 画布上 ≈ 画布高度的一半），FX_SIZE 等于白写。
      // 睡觉的 zzz 要按头部框定位，位置对不对直接取决于它多大，所以这里必须修。
      const s = inst.baseScale * p.scale;
      inst.sprite.scale.set(s);
      inst.sprite.position.set(inst.baseX, inst.baseY + (this.reduceMotion ? 0 : p.y));
      keep.push(inst);
    }
    this.fx = keep;
  }

  private swapBase(tex: Texture, instant: boolean) {
    if (this.baseCur.texture) {
      this.basePrev.texture = this.baseCur.texture;
      this.basePrev.visible = true;
      this.basePrev.alpha = 1;
    }
    this.baseCur.texture = tex;
    this.baseCur.alpha = instant ? 1 : 0;
    this.baseFade = instant ? 1 : 0;
    if (instant) this.basePrev.visible = false;
  }

  private layout() {
    if (!this.ready || !this.manifest) return;
    const w = this.opts.host.clientWidth || this.size;
    const h = this.opts.host.clientHeight || this.size;
    this.app.renderer.resize(w, h);
    this.hostW = w;
    this.hostH = h;
    const m = this.manifest;
    this.root.scale.set(this.size / m.canvas.height);
    // 锚点在脚底中心 → 角色站在容器底部，窗口再小也不会把脚切掉。
    this.placeRoot();
  }

  private onVisibility = () => {
    if (!this.ready) return;
    if (document.hidden) this.app.stop();
    else this.app.start();
  };

  private onTick = () => {
    this.update(this.app.ticker.deltaMS);
  };
}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}
