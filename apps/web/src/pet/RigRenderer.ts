// Step酱 桌宠的 Pixi 8 骨架渲染器。
//
// 与旧版 PetRenderer 的区别：旧版是「整图换帧」——每个表情一张全身图，切表情就是换贴图。
// 这里是 base 全身图 + 眼/眉/嘴覆盖层，覆盖层的位置来自 tools/art 的像素 diff 实测，
// 不是手标的。动画全部程序化（呼吸、摇摆、眨眼、挤压拉伸、落地回弹），没有序列图。
//
// 解耦约定：本文件不 import voice/ 或 brain/ 下的任何东西。
// 音频电平、情绪意图都由 UI 推进来，渲染器只负责「怎么插值」。
import { Application, Assets, Container, Sprite, Texture } from 'pixi.js';
import {
  type ActionName,
  type BrowState,
  type Expression,
  type EyeState,
  type FxName,
  type RigManifest,
  type Viseme,
} from '../../../../shared/pet';
import { BlinkScheduler, Spring, breathe, crossfadeMs, easeInOut, fxPose, squash, sway } from './motion';
import { loadRig, proceduralActions, type LoadedRig } from './rigManifest';
import { VisemeTracker } from './visemeMap';

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
  /** 拖拽惯性倾斜。 */
  private tiltSpring = new Spring(150, 14);
  /** 程序化动作姿态（目前只有 tilt）。单独一根弹簧，和拖拽倾斜叠加而不是互相覆盖。 */
  private poseSpring = new Spring(120, 15);
  private stretchSpring = new Spring(220, 13);
  private reboundSpring = new Spring(260, 12);
  private rebound = 0;

  private fx: FxInstance[] = [];
  private clock = 0;
  private size: number;
  private reduceMotion: boolean;
  private observer?: ResizeObserver;

  constructor(private opts: RigRendererOptions) {
    this.size = opts.size ?? 280;
    this.reduceMotion = opts.reduceMotion ?? false;
  }

  get canvas(): HTMLCanvasElement | null {
    return this.ready ? (this.app.canvas as HTMLCanvasElement) : null;
  }

  /** 本次加载被降级的条目（供 UI 显示，不要静默吞掉）。 */
  get degraded() {
    return this.manifest?.degraded ?? [];
  }

  async init() {
    try {
      await this.app.init({
        backgroundAlpha: 0,
        antialias: true,
        resolution: Math.min(globalThis.devicePixelRatio ?? 1, 2),
        autoDensity: true,
        preference: 'webgl',
        width: this.opts.host.clientWidth || this.size,
        height: this.opts.host.clientHeight || this.size,
      });
    } catch {
      this.fail('WebGL 不可用，角色无法渲染。请检查浏览器图形加速设置。');
      return;
    }
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
      this.tiltSpring.snap(0);
      this.stretchSpring.snap(0);
      this.reboundSpring.snap(0);
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

  /** @param velocity 指针速度（px/s），用于惯性倾斜与拉伸。 */
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
      // 落地回弹：先给弹簧一个初速度，让它自己过冲再收敛。
      this.rebound = 1;
      this.reboundSpring.value = 0.24;
      this.reboundSpring.velocity = -1.6;
    }
  }

  /** 外部可以手动推进（测试或自定义 ticker）。dtMs 为本帧毫秒数。 */
  update(dtMs: number) {
    if (this.disposed || !this.ready || !this.manifest) return;
    const dt = Math.min(0.05, Math.max(0.001, dtMs / 1000));
    this.clock += dtMs;

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

    await Promise.all(
      [...files].map(async (file) => {
        try {
          const tex = await Assets.load<Texture>(this.rig!.baseUrl + file);
          this.textures.set(file, tex);
        } catch {
          this.failed.add(file);
        }
      }),
    );
    if (this.failed.size > 0) {
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

    this.root.addChild(this.body, this.fxLayer);
    this.root.pivot.set(m.canvas.width * m.anchor.x, m.canvas.height * m.anchor.y);
    this.app.stage.addChild(this.root);
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
      // 只是不做弹簧过渡，直接到位。
      this.root.rotation = pose;
      this.poseSpring.snap(pose);
      return;
    }

    const br = breathe(this.clock);
    const tilt = this.tiltSpring.step(this.dragging ? clamp(-this.dragVx / 2600, -0.22, 0.22) : 0, dt);
    const stretchTarget = this.dragging
      ? clamp(Math.hypot(this.dragVx, this.dragVy) / 4200, 0, 0.2)
      : 0;
    const stretch = this.stretchSpring.step(stretchTarget, dt);

    let reboundS = 0;
    if (this.rebound > 0) {
      reboundS = this.reboundSpring.step(0, dt);
      if (Math.abs(reboundS) < 0.002 && Math.abs(this.reboundSpring.velocity) < 0.02) {
        this.rebound = 0;
        this.reboundSpring.snap(0);
      }
    }

    const sq = squash(stretch + reboundS);
    this.root.scale.set(scale * br.scaleX * sq.scaleX, scale * br.scaleY * sq.scaleY);
    this.root.rotation = this.poseSpring.step(pose, dt) + tilt + sway(this.clock);
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
    const m = this.manifest;
    // 锚点在脚底中心 → 角色站在容器底部，窗口再小也不会把脚切掉。
    this.root.position.set(w / 2, h);
    this.root.scale.set(this.size / m.canvas.height);
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
