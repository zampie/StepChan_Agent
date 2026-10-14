// 主动感知层的公共类型与注入口。
//
// 这一层**只产出意图**，不碰 realtime、不碰渲染器：
// 规则是 awareness/ 不得 import voice/ 或 brain/。集成层拿到 intent 自己决定怎么路由
// （要不要真的说出来、要不要先冒隐私提示）。这样这些行为逻辑可以在 node:test 里
// 用注入的时钟纯跑，不需要浏览器、不需要 Tauri、不需要真的等。
import type { Desktop, DragDropPayload, FrontmostApp, Settings } from '../../../../shared/desktop';
import type { Spot } from '../../../../shared/pet';

/**
 * 她"想说点什么"的意图。prompt 是给大脑的中文指令，不是直接播给用户的台词 ——
 * 她可以读完之后决定不说（提示里会明说这一点）。
 */
export type AwarenessIntent = {
  kind: 'frontmost' | 'drop' | 'nap' | 'wake';
  /** 给大脑的简短中文提示。 */
  prompt: string;
  /**
   * 非空表示这次意图背后发生了一次隐私读取，集成层必须冒出可见提示
   * （对应 shared/brain.ts 的 PetEvent.privacy_notice.action）。
   * AGENTS.md：每次实际读取都要让用户知道。
   */
  privacy?: 'screen' | 'clipboard' | 'frontmost';
};

export type IntentSink = (intent: AwarenessIntent) => void;

/**
 * 这一层真正需要的桌面能力，从 Desktop 契约里挑出来。
 * 用 Pick 而不是自己写一遍，保证契约变了这里会编译失败而不是静默漂移。
 */
export type AwarenessDesktop = Pick<
  Desktop,
  'onFrontmostChanged' | 'onDragDrop' | 'moveToSpot' | 'getSettings'
>;

/**
 * 外部状态探针。抑制逻辑要看"她在不在说话""用户在不在打字""窗口是不是藏起来了"，
 * 但这些状态归别的 track 管，所以这里只拿一个只读探针，不反向依赖。
 */
export type ActivityProbe = {
  /** 她正忙（listening / thinking / speaking）—— 不要插话。 */
  busy(): boolean;
  /** 用户正在输入 —— 不要插话。 */
  userTyping(): boolean;
  /** 桌宠窗口可见。隐藏时空闲行为必须暂停（别对着不存在的窗口做动画）。 */
  visible(): boolean;
};

/** 注入的随机源，测试里替换成确定值。 */
export type Random = () => number;

export type { DragDropPayload, FrontmostApp, Settings, Spot };

/** app 的去重键：优先 bundle id（稳定），没有就退回显示名。 */
export function appKey(app: FrontmostApp): string | null {
  if (!app) return null;
  const key = app.bundleId.trim() || app.name.trim();
  return key || null;
}

/**
 * 滑动窗口配额。用注入的 now 记账，不读系统时钟，所以测试不用假定时器。
 */
export class RateWindow {
  private readonly hits: number[] = [];

  constructor(
    private readonly windowMs: number,
    private readonly limit: number,
  ) {}

  /** 现在还有配额吗？（只查询，不记账） */
  has(now: number): boolean {
    this.prune(now);
    return this.hits.length < this.limit;
  }

  /** 记一次。调用方应当先 has() 确认。 */
  take(now: number): void {
    this.prune(now);
    this.hits.push(now);
  }

  get used(): number {
    return this.hits.length;
  }

  reset(): void {
    this.hits.length = 0;
  }

  private prune(now: number): void {
    while (this.hits.length > 0 && now - this.hits[0] >= this.windowMs) {
      this.hits.shift();
    }
  }
}
