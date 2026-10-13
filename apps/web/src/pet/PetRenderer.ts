import { Application, Assets, Container, Sprite, Texture } from 'pixi.js';
import { expressions, type Expression } from '../../../../shared/protocol';
import { PetController } from './PetController';
const base = `${import.meta.env.BASE_URL}assets/derived/blue_pet_512/`;
export class PetRenderer {
  private app = new Application();
  private disposed = false;
  private ready = false;
  private body = new Sprite();
  private mouth = new Sprite();
  private group = new Container();
  private textures = new Map<string, Texture>();
  private observer?: ResizeObserver;
  private offset = { x: 0, y: 0 };
  private drag: { x: number; y: number; ox: number; oy: number; moved: boolean } | null = null;
  private lastTap = 0;
  private size = 430;
  constructor(
    private host: HTMLElement,
    private controller: PetController,
    private onError: (s: string) => void,
    private onTap: () => void,
  ) {}
  async init() {
    try {
      await this.app.init({
        backgroundAlpha: 0,
        antialias: true,
        resolution: Math.min(devicePixelRatio, 2),
        autoDensity: true,
        preference: 'webgl',
        width: this.host.clientWidth,
        height: this.host.clientHeight,
      });
      this.ready = true;
      if (this.disposed) {
        this.app.destroy(true, { children: true });
        return;
      }
      this.host.appendChild(this.app.canvas);
      this.body.anchor.set(0.5, 1);
      this.mouth.anchor.set(0.5, 1);
      this.group.addChild(this.body, this.mouth);
      this.app.stage.addChild(this.group);
      const response = await fetch(`${base}manifest.json`);
      if (!response.ok) throw Error('manifest 加载失败');
      const manifest = await response.json();
      const neutral = await Assets.load<Texture>(base + manifest.expressions.neutral);
      if (this.disposed) return;
      this.textures.set('neutral', neutral);
      this.body.texture = neutral;
      await Promise.all([
        ...expressions
          .filter((e) => e !== 'neutral')
          .map(async (e) => {
            try {
              this.textures.set(e, await Assets.load<Texture>(base + manifest.expressions[e]));
            } catch {
              this.onError(`${e} 加载失败，已回退 neutral。`);
            }
          }),
        ...['closed', 'open_small', 'open_big'].map(async (e) => {
          try {
            this.textures.set(e, await Assets.load<Texture>(base + manifest.mouths[e]));
          } catch {
            this.onError('嘴型资源不可用，已关闭覆盖层。');
          }
        }),
      ]);
      if (this.disposed) return;
      this.observer = new ResizeObserver(() => {
        this.app.renderer.resize(this.host.clientWidth, this.host.clientHeight);
        this.clamp();
      });
      this.observer.observe(this.host);
      this.host.addEventListener('pointerdown', this.down);
      this.host.addEventListener('pointermove', this.move);
      this.host.addEventListener('pointerup', this.up);
      this.host.addEventListener('pointercancel', this.cancel);
      this.app.ticker.add(this.tick);
      document.addEventListener('visibilitychange', this.visibility);
      this.visibility();
      this.tick();
    } catch {
      if (!this.disposed)
        this.onError('角色资源或 WebGL 加载失败，请刷新页面并检查浏览器图形支持。');
    }
  }
  setSize(size: number) {
    this.size = size;
    this.clamp();
  }
  resetPosition() {
    this.offset = { x: 0, y: 0 };
  }
  simulateMissing() {
    this.textures.delete('happy');
    this.onError('模拟 happy 资源缺失：回退 neutral。刷新可恢复。');
  }
  private dimensions() {
    return Math.min(this.size, this.host.clientWidth - 12, this.host.clientHeight - 45);
  }
  private clamp() {
    const size = this.dimensions();
    const x = Math.max(0, (this.host.clientWidth - size * 0.7) / 2);
    const y = Math.max(0, (this.host.clientHeight - size * 0.88) / 2 - 14);
    this.offset.x = Math.max(-x, Math.min(x, this.offset.x));
    this.offset.y = Math.max(-y, Math.min(y, this.offset.y));
  }
  private down = (e: PointerEvent) => {
    if (e.button !== 0) return;
    this.host.setPointerCapture(e.pointerId);
    this.drag = { x: e.clientX, y: e.clientY, ox: this.offset.x, oy: this.offset.y, moved: false };
    this.controller.cancelMotion();
  };
  private move = (e: PointerEvent) => {
    if (!this.drag) return;
    const dx = e.clientX - this.drag.x,
      dy = e.clientY - this.drag.y;
    if (Math.hypot(dx, dy) > 5) this.drag.moved = true;
    if (this.drag.moved) {
      this.offset = { x: this.drag.ox + dx, y: this.drag.oy + dy };
      this.clamp();
    }
  };
  private up = (e: PointerEvent) => {
    if (this.drag && !this.drag.moved && performance.now() - this.lastTap > 1200) {
      this.lastTap = performance.now();
      this.controller.present({ expression: 'happy', motion: 'bounce' });
      this.onTap();
    }
    this.drag = null;
    if (this.host.hasPointerCapture(e.pointerId)) this.host.releasePointerCapture(e.pointerId);
  };
  private cancel = () => {
    this.drag = null;
  };
  private visibility = () => {
    if (document.hidden) this.app.stop();
    else this.app.start();
  };
  private tick = () => {
    if (this.disposed) return;
    const pose = this.drag
      ? { y: 0, scale: 1, rotation: 0, mouth: null }
      : this.controller.pose(performance.now(), !document.hidden);
    this.body.texture =
      this.textures.get(this.controller.expression) ??
      this.textures.get('neutral') ??
      Texture.EMPTY;
    const size = this.dimensions();
    this.group.position.set(
      this.host.clientWidth / 2 + this.offset.x,
      this.host.clientHeight / 2 + size / 2 + this.offset.y + pose.y,
    );
    this.group.scale.set((size / 512) * pose.scale);
    this.group.rotation = pose.rotation;
    this.mouth.visible = !!pose.mouth && this.textures.has(pose.mouth);
    if (pose.mouth) this.mouth.texture = this.textures.get(pose.mouth) ?? Texture.EMPTY;
  };
  destroy() {
    this.disposed = true;
    this.observer?.disconnect();
    document.removeEventListener('visibilitychange', this.visibility);
    this.host.removeEventListener('pointerdown', this.down);
    this.host.removeEventListener('pointermove', this.move);
    this.host.removeEventListener('pointerup', this.up);
    this.host.removeEventListener('pointercancel', this.cancel);
    if (this.ready) {
      this.app.ticker.remove(this.tick);
      this.app.destroy(true, { children: true, texture: false, textureSource: false });
    }
  }
}
