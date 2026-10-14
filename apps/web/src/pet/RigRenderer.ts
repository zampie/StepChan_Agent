// Step酱 桌宠的 Pixi 8 骨架渲染器。
//
// 与旧版 PetRenderer 的区别：旧版是「整图换帧」——每个表情一张全身图，切表情就是换贴图。
// 这里是 base 全身图 + 眼/眉/嘴覆盖层，覆盖层的位置来自 tools/art 的像素 diff 实测，
// 不是手标的。动画全部程序化（呼吸、摇摆、眨眼、挤压拉伸、悬挂摆动、落地回弹），没有序列图。
//
// 三组对外行为，顺带说明各自的参数在哪（这里一个「手感数字」都不该硬编码）：
//   - 表情 / 口型 / 动作：rig.json（tools/art/register.py 的像素 diff 配准）。
//   - StepFun logo 图层：logo.json（tools/art/logo.py 的 SVG 几何 + 旧徽章实测覆盖半径）。
//     位置/直径/自转全在清单里；本文件只放「怎么动」（LOGO_MOTION）。
//   - 拖拽的抓娃娃机手感 + 单击反应：motion.ts 的 clawFeel / tapReactions.ts 的 tapPools。
//
// 解耦约定：本文件不 import voice/ 或 brain/ 下的任何东西，也不监听任何 DOM 事件。
// 音频电平、情绪意图、拖拽与单击都由 UI 推进来，渲染器只负责「怎么插值」。
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
  ShuffleBag,
  Spring,
  breathe,
  clawFeel,
  clawPose,
  crossfadeMs,
  easeInOut,
  fxPose,
  sagTarget,
  sway,
  swingTarget,
} from './motion';
import { loadRig, proceduralActions, isNoopAction, type LoadedRig } from './rigManifest';
import { logoSlots, type LogoPlacement } from './logoManifest';
import { tapActionHoldMs, tapPools, tapTargetOf, type TapReaction, type TapTarget } from './tapReactions';
import { VisemeTracker } from './visemeMap';
import { reportDiagnostic } from '../platform/diagnostics';

export interface RigRendererOptions {
  host: HTMLElement;
  manifestUrl: string;
  /** 显示高度（px）。桌宠一般 200–400。 */
  size?: number;
  reduceMotion?: boolean;
  onError?: (message: string) => void;
}

/** FX 相对画布的生成位置，单位是画布高度的比例（x 从中心算，y 从脚底往上算）。 */
const FX_SPAWN: Record<FxName, { x: number; y: number }> = {
  sparkle: { x: 0.26, y: 0.84 },
  sweat: { x: 0.22, y: 0.78 },
  zzz: { x: 0.24, y: 0.92 },
  heart: { x: -0.24, y: 0.86 },
  exclaim: { x: 0.2, y: 0.94 },
  question: { x: 0.22, y: 0.94 },
  note: { x: -0.26, y: 0.82 },
};

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
}

/** logo 的一枚实例：贴图 + 它在清单里的那份静态参数。 */
interface LogoInstance {
  sprite: Sprite;
  placement: LogoPlacement;
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

  private dragging = false;
  private dragVx = 0;
  private dragVy = 0;
  // ---- 抓娃娃机：五根弹簧 ----
  /** 被提起的程度 0..1。整个悬挂姿态都乘在它上面，所以放下时会平滑收回。 */
  private liftSpring = new Spring(110, 17);
  /** 悬挂摆角。刻意欠阻尼（临界阻尼 2√95 ≈ 19.5，这里 7.5）→ 会自己来回摆几下。 */
  private swingSpring = new Spring(95, 7.5);
  /** 下半身跟踪摆角的软弹簧。它和 swing 的差值就是「下身拖后一拍」。 */
  private lagSpring = new Spring(48, 9);
  /** 重力下垂（竖向拉伸）。 */
  private sagSpring = new Spring(140, 15);
  /** 程序化动作姿态（目前只有 tilt）。单独一根弹簧，和悬挂摆角叠加而不是互相覆盖。 */
  private poseSpring = new Spring(120, 15);
  private reboundSpring = new Spring(260, 12);
  private rebound = 0;
  /** 单击的挤压反馈。和落地回弹分开，免得点一下把正在回弹的动作打断。 */
  private tapSpring = new Spring(320, 12);
  /** 发饰那枚 logo 的滞后跟踪器（见 LOGO_MOTION）。 */
  private logoSpring = new Spring(LOGO_MOTION.stiffness, LOGO_MOTION.damping);

  /** 单击触发的临时动作剩余时长（ms）。归零时自动回 idle。 */
  private tapActionLeft = 0;
  /** 每个部位一个洗牌袋，保证「每次换一个」。按需建，因为可用性要等素材加载完才知道。 */
  private tapBags = new Map<TapTarget, ShuffleBag<TapReaction>>();

  private fx: FxInstance[] = [];
  private clock = 0;
  private size: number;
  private reduceMotion: boolean;
  private observer?: ResizeObserver;
  /** 容器尺寸与上一帧的支点，供 layout() 在两帧之间保持姿态不跳。 */
  private hostW = 0;
  private hostH = 0;
  private lastPivotY = 1;
  private lastRise = 0;
  private lastScaleY = 1;

  constructor(private opts: RigRendererOptions) {
    this.size = opts.size ?? 280;
    this.reduceMotion = opts.reduceMotion ?? false;
  }

  get canvas(): HTMLCanvasElement | null {
    return this.ready ? (this.app.canvas as HTMLCanvasElement) : null;
  }

  /**
   * 本次加载被降级的条目（供 UI 显示，不要静默吞掉）。
   * 合并了 rig.json 与 logo.json 两份清单，以及 logo.json 本身加载失败的情况 ——
   * logo 是 sidecar，它的降级不会出现在 rig.json 里，不合并就等于静默。
   */
  get degraded(): { name: string; reason: string }[] {
    return [
      ...(this.manifest?.degraded ?? []),
      ...(this.rig?.logo?.manifest.degraded ?? []),
      ...(this.rig?.logoError ? [{ name: 'logo', reason: this.rig.logoError }] : []),
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

    await this.loadTextures();
    if (this.disposed) return;
    if (!this.textures.has(this.manifest.base.file)) {
      this.fail('角色主体贴图加载失败，无法渲染。');
      return;
    }

    this.buildScene();
    this.applyExpression(this.expression, true);

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
    if (on) {
      this.blink.reset();
      for (const s of [
        this.liftSpring,
        this.swingSpring,
        this.lagSpring,
        this.sagSpring,
        this.reboundSpring,
        this.tapSpring,
        this.logoSpring,
      ]) {
        s.snap(0);
      }
      this.rebound = 0;
    }
  }

  setExpression(expression: Expression) {
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
    this.tapActionLeft = 0;
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
    this.syncLogoVisibility();
  }

  spawnFx(name: FxName) {
    const asset = this.manifest?.fx[name];
    if (!asset) return;
    const tex = this.textures.get(asset.file);
    if (!tex || !this.manifest) return;
    const sprite = new Sprite(tex);
    sprite.anchor.set(0.5);
    const h = this.manifest.canvas.height;
    const spawn = FX_SPAWN[name];
    sprite.width = h * 0.22;
    sprite.height = h * 0.22;
    const baseX = this.manifest.canvas.width * this.manifest.anchor.x + spawn.x * h;
    const baseY = h * this.manifest.anchor.y - spawn.y * h;
    sprite.position.set(baseX, baseY);
    this.fxLayer.addChild(sprite);
    this.fx.push({ sprite, age: 0, baseX, baseY });
  }

  /**
   * 拖拽状态。被提起时走「抓娃娃机」姿态：支点搬到头顶、身体垂下、随手摆动、放下落地回弹。
   * 具体数学在 motion.ts 的 clawPose / clawFeel，参数都集中在 clawFeel 里。
   *
   * @param velocity 指针速度（px/s），决定摆幅与下垂量。不给就按 0 处理（提着不动）。
   */
  setDragging(on: boolean, velocity?: { x: number; y: number }) {
    if (on) {
      this.dragVx = velocity?.x ?? 0;
      this.dragVy = velocity?.y ?? 0;
      if (!this.dragging) this.rebound = 0;
      this.dragging = true;
    } else if (this.dragging) {
      this.dragging = false;
      this.dragVx = 0;
      this.dragVy = 0;
      // 落地回弹：从「压扁」出发给一个向上的初速度，让它自己冲过 0 再收敛 ——
      // 顺序是砸地压扁 → 弹起拉长 → 稳住。反过来（先拉长）看起来像又被往上提了一下。
      this.rebound = 1;
      this.reboundSpring.value = -clawFeel.landBounce;
      this.reboundSpring.velocity = clawFeel.landVelocity;
    }
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
    if (reaction.expression) this.setExpression(reaction.expression);
    if (reaction.action) {
      this.playAction(reaction.action);
      // playAction 会把它清零（外部换动作要能取消自动回位），所以在后面设。
      this.tapActionLeft = tapActionHoldMs;
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

    // 单击触发的临时动作到点就回 idle。用倒计时而不是 setTimeout：
    // 渲染器销毁时不用额外清理，页面隐藏（ticker 停）时也不会在后台乱跳。
    if (this.tapActionLeft > 0) {
      this.tapActionLeft -= dtMs;
      if (this.tapActionLeft <= 0) {
        this.tapActionLeft = 0;
        this.playAction('idle');
      }
    }

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

    this.root.addChild(this.body, this.fxLayer);
    this.root.pivot.set(m.canvas.width * m.anchor.x, m.canvas.height * m.anchor.y);
    this.app.stage.addChild(this.root);
  }

  /**
   * 按 logo.json 的 placements 建 logo sprite。
   *
   * 位置/直径/自转全部来自清单，这里只做「清单 → sprite 属性」的翻译。
   * 贴图是 256 px 的，按 placement.size 缩到 17–31 px —— 所以放大桌宠或换 retina
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
      const p = logo.manifest.placements[slot];
      if (!p) continue;
      const sprite = new Sprite(tex);
      sprite.anchor.set(0.5);
      sprite.width = p.size;
      sprite.height = p.size;
      sprite.position.set(p.cx, p.cy);
      sprite.rotation = p.rotation;
      this.logoLayer.addChild(sprite);
      this.logos.push({ sprite, placement: p });
    }
    this.syncLogoVisibility();
  }

  /**
   * logo 层只在 logo.json 的 appliesTo 列出的动作下显示。
   *
   * 和脸部覆盖层同一条边界：位置是按 idle 画幅实测的，换姿势的动作图上徽章挪位了，
   * 继续贴就会把 logo 贴到腋下。这条降级写在 logo.json 的 degraded 里，不是静默的。
   */
  private syncLogoVisibility() {
    const logo = this.rig?.logo;
    this.logoLayer.visible = !!logo && logo.appliesTo.has(this.action) && this.logos.length > 0;
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
    slot.cur.visible = true;
    slot.cur.alpha = instant ? 1 : 0;
    slot.fade = instant ? 1 : 0;
    slot.name = name;
    if (instant) slot.prev.visible = false;
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
    const restEye: EyeState = entry && entry.mode === 'layers' ? entry.eyes : 'open';
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

    if (this.reduceMotion) {
      this.root.scale.set(scale);
      // reduceMotion 下程序化动作仍然生效 —— 它表达的是「姿势」，不是「动效」。
      // 只是不做弹簧过渡，直接到位。拖拽的悬挂效果整个关掉。
      this.root.rotation = pose;
      this.poseSpring.snap(pose);
      this.body.skew.x = 0;
      for (const l of this.logos) l.sprite.rotation = l.placement.rotation;
      this.applyPivot(m.anchor.y, 0, scale);
      return;
    }

    const br = breathe(this.clock);

    // ---- 抓娃娃机 ----
    // lift 是「被提起的程度」，其余各项都乘在它上面（见 clawPose），所以放手时会平滑收回，
    // 不需要额外的退出动画。
    const lift = this.liftSpring.step(this.dragging ? 1 : 0, dt);
    const swing = this.swingSpring.step(this.dragging ? swingTarget(this.dragVx) : 0, dt);
    const lag = this.lagSpring.step(swing, dt);
    const sag = this.sagSpring.step(this.dragging ? sagTarget(this.dragVy) : 0, dt);

    let reboundS = 0;
    if (this.rebound > 0) {
      reboundS = this.reboundSpring.step(0, dt);
      if (Math.abs(reboundS) < 0.002 && Math.abs(this.reboundSpring.velocity) < 0.02) {
        this.rebound = 0;
        this.reboundSpring.snap(0);
      }
    }
    // 单击挤压：目标恒为 0，靠 reactToTap 打进去的初值和初速度自由衰减。
    const tap = this.tapSpring.step(0, dt);

    const claw = clawPose(
      { lift, swing, lag, sag, rebound: reboundS + tap },
      clawFeel,
      m.anchor.y,
    );
    const scaleX = scale * br.scaleX * claw.scaleX;
    const scaleY = scale * br.scaleY * claw.scaleY;
    this.root.scale.set(scaleX, scaleY);
    // 站地时是「程序化姿势 + 闲置摇摆」；提起来后摇摆淡出、悬挂摆角接管。
    // 两者不是互斥开关，而是按 lift 交叉淡入 —— 否则抓起/放下的瞬间会突然一跳。
    this.root.rotation =
      this.poseSpring.step(pose, dt) + claw.rotation + sway(this.clock) * (1 - lift);
    // 下半身滞后的切变。支点是画幅顶（body 的局部原点），所以头顶 0 位移、脚底最大。
    this.body.skew.x = claw.skewX;
    this.applyPivot(claw.pivotY, claw.riseFrac, scaleY);
    this.stepLogo(this.root.rotation, dt);
  }

  /**
   * 更新旋转支点与落脚点。
   *
   * 支点上移时**必须**反向补偿位置：Pixi 的 pivot 是在局部坐标里挖一个新原点，
   * 不补偿的话把支点从脚底搬到头顶，角色会整体往下掉一个身高。
   * 补偿式来自「脚底那一点要落在容器底边」：
   *   screenY(脚底) = position.y + (anchorY − pivotY) · canvasH · scaleY ≡ hostH + rise
   */
  private applyPivot(pivotY: number, riseFrac: number, scaleY: number) {
    const m = this.manifest!;
    const w = this.hostW || this.size;
    const h = this.hostH || this.size;
    this.root.pivot.set(m.canvas.width * m.anchor.x, m.canvas.height * pivotY);
    this.root.position.set(
      w / 2,
      h + riseFrac * this.size - (m.anchor.y - pivotY) * m.canvas.height * scaleY,
    );
    this.lastPivotY = pivotY;
    this.lastRise = riseFrac;
    this.lastScaleY = scaleY;
  }

  /**
   * logo 的二级动作：软弹簧跟踪身体旋转，差值换算成额外自转。
   * jiggle=0 的位置（胸前）直接贴死，不走弹簧 —— 衣料上的东西不该自己晃。
   */
  private stepLogo(bodyRotation: number, dt: number) {
    if (this.logos.length === 0) return;
    const tracked = this.logoSpring.step(bodyRotation, dt);
    const lagAngle = bodyRotation - tracked;
    for (const l of this.logos) {
      if (l.placement.jiggle <= 0) {
        l.sprite.rotation = l.placement.rotation;
        continue;
      }
      const extra = clamp(
        lagAngle * LOGO_MOTION.followGain * l.placement.jiggle,
        -LOGO_MOTION.maxExtraRotation,
        LOGO_MOTION.maxExtraRotation,
      );
      l.sprite.rotation = l.placement.rotation + extra;
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
      inst.sprite.scale.set(p.scale * (inst.sprite.scale.x < 0 ? -1 : 1));
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
    // 用上一帧的支点而不是写死脚底：resize 可能发生在被提起来的中途，
    // 写死的话会在下一帧 stepPose 纠正前闪一下。
    this.applyPivot(this.lastPivotY, this.lastRise, this.lastScaleY);
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
