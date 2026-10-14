import { Application, Assets, Container, Sprite, Texture, Point } from 'pixi.js';
import { expressions } from '../../../../shared/protocol';
import { PetController } from './PetController';
import { hitRegion } from './hitRegions';
import type { TouchPart, Scene } from '../../../../shared/room';
const base = `${import.meta.env.BASE_URL}assets/derived/blue_pet_512/`;
export class PetRenderer {
  private app = new Application();
  private disposed = false;
  private ready = false;
  private body = new Sprite();
  private mouth = new Sprite();
  private group = new Container();
  private textures = new Map<string, Texture>();
  private masks = new Map<string, Uint8ClampedArray>();
  private observer?: ResizeObserver;
  private offset = { x: 0, y: 0 };
  private drag: {
    x: number;
    y: number;
    ox: number;
    oy: number;
    moved: boolean;
    part: TouchPart | null;
  } | null = null;
  private target: Scene['petTarget'] = 'center';
  private targetX = 0;
  private lastTap = 0;
  private size = 430;
  constructor(
    private host: HTMLElement,
    private controller: PetController,
    private onError: (s: string) => void,
    private onTap: (part: TouchPart) => void,
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
      this.mask('neutral', neutral);
      this.body.texture = neutral;
      await Promise.all([
        ...expressions
          .filter((e) => e !== 'neutral')
          .map(async (e) => {
            try {
              const texture = await Assets.load<Texture>(base + manifest.expressions[e]);
              this.textures.set(e, texture);
              this.mask(e, texture);
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
  setTarget(target: Scene['petTarget']) {
    this.target = target;
    this.offset = { x: 0, y: 0 };
  }
  private mask(name: string, texture: Texture) {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (ctx) {
      ctx.drawImage(texture.source.resource as CanvasImageSource, 0, 0, 512, 512);
      this.masks.set(name, ctx.getImageData(0, 0, 512, 512).data);
    }
  }
  private hit(e: PointerEvent) {
    const rect = this.host.getBoundingClientRect();
    const p = this.group.toLocal(new Point(e.clientX - rect.left, e.clientY - rect.top));
    const x = (p.x + 256) / 512,
      y = (p.y + 512) / 512;
    const mask = this.masks.get(this.controller.expression) ?? this.masks.get('neutral');
    const solid =
      x >= 0 &&
      x < 1 &&
      y >= 0 &&
      y < 1 &&
      !!mask &&
      mask[(Math.floor(y * 512) * 512 + Math.floor(x * 512)) * 4 + 3] > 32;
    return { solid, part: solid ? hitRegion(x, y) : null };
  }
  resetPosition() {
    this.offset = { x: 0, y: 0 };
    this.target = 'center';
    this.targetX = 0;
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
    const hit = this.hit(e);
    if (!hit.solid) return;
    this.host.setPointerCapture(e.pointerId);
    this.offset.x += this.targetX;
    this.target = 'center';
    this.targetX = 0;
    this.clamp();
    this.drag = {
      x: e.clientX,
      y: e.clientY,
      ox: this.offset.x,
      oy: this.offset.y,
      moved: false,
      part: hit.part,
    };
    this.controller.cancelMotion();
  };
  private move = (e: PointerEvent) => {
    if (!this.drag) {
      const hit = this.hit(e);
      this.host.style.cursor = hit.part ? 'pointer' : hit.solid ? 'grab' : 'default';
      this.host.title = hit.part
        ? { head: '轻点头顶', cheek: '轻点脸颊', badge: '看看徽章', hand: '碰一下手' }[hit.part]
        : '';
      return;
    }
    const dx = e.clientX - this.drag.x,
      dy = e.clientY - this.drag.y;
    if (Math.hypot(dx, dy) > 5) this.drag.moved = true;
    if (this.drag.moved) {
      this.offset = { x: this.drag.ox + dx, y: this.drag.oy + dy };
      this.clamp();
    }
  };
  private up = (e: PointerEvent) => {
    if (this.drag && !this.drag.moved && this.drag.part && performance.now() - this.lastTap > 500) {
      this.lastTap = performance.now();
      this.controller.present({
        expression: this.drag.part === 'cheek' ? 'surprised' : 'happy',
        motion: 'bounce',
      });
      this.onTap(this.drag.part);
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
    const direction =
      this.target === 'plant' || this.target === 'timer'
        ? 1
        : this.target === 'cards' || this.target === 'lamp'
          ? -1
          : 0;
    const destination = direction * Math.max(0, (this.host.clientWidth - size * 0.7) / 2) * 0.55;
    this.targetX = this.controller.reduced
      ? destination
      : this.targetX + (destination - this.targetX) * 0.08;
    this.group.position.set(
      this.host.clientWidth / 2 + this.offset.x + this.targetX,
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
