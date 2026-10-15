// 单击反应表。纯数据 + 纯函数，不碰 Pixi、不监听 DOM —— 渲染器负责执行，UI 负责触发。
//
// 需求是「每单击一次换一个表情/动作或显示一个交互效果」，并且摸不同部位倾向不同反应。
// 这里只定义「有哪些反应、哪个部位用哪一组」；不重复的轮转由 motion.ts 的 ShuffleBag 负责，
// 可用性过滤（动作有没有真素材）由渲染器在运行时按 rig.json 做。
//
// 为什么反应是「表情 + 动作 + 特效 + 眨眼 + 挤压」的组合而不是单一字段：
// 单击的反馈要在 200 ms 内被看见。只换表情在 220 px 下太微弱（五官只有十几像素），
// 配一个特效或一下挤压才看得出「她被点到了」。
import type { ActionName, Expression, FxName, TouchPart } from '../../../../shared/pet';

/**
 * 可被单击的目标。前四项与 shared/pet.ts 的 touchParts 一致；
 * 'skirt' 只有渲染层反应、没有台词（见 apps/web/src/platform/hitRegions.ts 的同名说明）。
 * 'default' 是点在身上其它地方时的兜底组。
 */
export const tapTargets = ['head', 'cheek', 'badge', 'hand', 'skirt', 'default'] as const;
export type TapTarget = (typeof tapTargets)[number];

/** 编译期约束：四个 TouchPart 必须都是合法的 TapTarget，别让两边偷偷漂移。 */
const _touchPartsAreTapTargets: readonly TapTarget[] = ['head', 'cheek', 'badge', 'hand'] satisfies readonly TouchPart[];
void _touchPartsAreTapTargets;

export interface TapReaction {
  /** 稳定标识。用于轮转去重、日志、以及测试里断言「换了一个」。 */
  readonly id: string;
  readonly expression?: Expression;
  /** 临时动作。渲染器会在 tapActionHoldMs 之后自动回 idle。 */
  readonly action?: ActionName;
  readonly fx?: FxName;
  /** 立刻眨一次眼。reduceMotion 下跳过。 */
  readonly blink?: 'single' | 'double';
  /** 轻微挤压反馈。reduceMotion 下跳过。 */
  readonly poke?: boolean;
}

/**
 * 每个部位一组反应。每组至少 3 条 —— 少于 3 条时「不连续重复」几乎等于「固定来回切」。
 *
 * 分组的依据是摸这个部位该是什么情绪，不是随机凑数：
 * 头顶 = 被摸头（舒服/害羞/困），脸颊 = 被捏（害羞/吓到/不满），
 * 徽章 = 被问身份（得意/想介绍），手 = 想握手（高兴/打招呼），
 * 裙摆 = 越界（生气/慌），default = 泛泛被点（好奇/惊讶）。
 */
export const tapPools: Record<TapTarget, readonly TapReaction[]> = {
  head: [
    { id: 'head.happy', expression: 'happy', fx: 'heart', blink: 'double' },
    { id: 'head.shy', expression: 'shy', fx: 'sparkle', poke: true },
    { id: 'head.sleepy', expression: 'sleepy', fx: 'zzz' },
    { id: 'head.proud', expression: 'proud', action: 'tilt' },
  ],
  cheek: [
    { id: 'cheek.shy', expression: 'shy', fx: 'heart', poke: true },
    { id: 'cheek.surprised', expression: 'surprised', fx: 'exclaim', blink: 'single' },
    { id: 'cheek.happy', expression: 'happy', action: 'tilt' },
    { id: 'cheek.angry', expression: 'angry', fx: 'sweat' },
  ],
  badge: [
    { id: 'badge.proud', expression: 'proud', fx: 'sparkle' },
    { id: 'badge.excited', expression: 'excited', action: 'point', fx: 'exclaim' },
    { id: 'badge.curious', expression: 'curious', fx: 'question' },
    { id: 'badge.happy', expression: 'happy', action: 'jump' },
  ],
  hand: [
    { id: 'hand.excited', expression: 'excited', action: 'wave' },
    { id: 'hand.happy', expression: 'happy', fx: 'note' },
    { id: 'hand.shy', expression: 'shy', poke: true },
    { id: 'hand.curious', expression: 'curious', action: 'tilt', fx: 'question' },
  ],
  skirt: [
    { id: 'skirt.angry', expression: 'angry', fx: 'exclaim', poke: true },
    { id: 'skirt.shy', expression: 'shy', fx: 'sweat' },
    { id: 'skirt.surprised', expression: 'surprised', blink: 'double' },
  ],
  default: [
    { id: 'tap.curious', expression: 'curious', fx: 'question' },
    { id: 'tap.surprised', expression: 'surprised', fx: 'exclaim', blink: 'single' },
    { id: 'tap.happy', expression: 'happy', fx: 'note' },
    { id: 'tap.excited', expression: 'excited', action: 'jump', fx: 'sparkle' },
    { id: 'tap.sleepy', expression: 'sleepy', fx: 'zzz' },
    { id: 'tap.tilt', expression: 'curious', action: 'tilt', poke: true },
  ],
};

/** 把任意部位字符串归到一个反应组。认不出来的（含 null/undefined）走 default，不报错。 */
export function tapTargetOf(part?: string | null): TapTarget {
  return (tapTargets as readonly string[]).includes(part ?? '') && part !== 'default'
    ? (part as TapTarget)
    : 'default';
}

/** 单击后临时动作的保持时长（ms），之后自动回 idle。 */
export const tapActionHoldMs = 1400;

/**
 * 单击后临时**表情**的保持时长（ms），之后自动回 neutral。
 *
 * 比动作的 1400 ms 长一倍半，因为两者要读的东西不一样：
 * 动作是整身姿势，一眼就看完；表情在 220 px 下只有十几像素的五官，
 * 实测（人眼看 _qa_faces.png 的特写）得盯一会儿才分得清 happy 和 proud，
 * 所以给 150 ms 淡入 + 约 3 s 的稳定观察窗。
 *
 * 为什么不更长：挂着一个「被摸头摸出来的害羞」直到下次互动，会和她说话时的真实情绪打架。
 * 为什么不更短：短于 2 s 的话用户还没把视线移到脸上就塌回去了，看起来像没反应。
 *
 * **这个倒计时只管单击这条路。** 模型通过 express 工具设的表情走 setExpression()，
 * 不会过期 —— 那是她当前真实的情绪状态。两条路的区别见 RigRenderer.setExpression 的注释。
 */
export const tapExpressionHoldMs = 3500;
