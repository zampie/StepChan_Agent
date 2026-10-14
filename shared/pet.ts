// Step酱 的表现层契约：表情、口型、动作、骨架清单。
// 渲染器（apps/web/src/pet）与素材流水线（tools/art）共用这一份定义，两边都不得自己扩枚举。
import { z } from 'zod';

// 表情是情绪，不是素材文件名。一个表情可能由分层覆盖合成，也可能降级为整图。
export const expressions = [
  'neutral',
  'happy',
  'excited',
  'curious',
  'confused',
  'surprised',
  'proud',
  'shy',
  'sleepy',
  'angry',
  'sad',
] as const;
export type Expression = (typeof expressions)[number];

// 眼睛覆盖层。blink 由渲染器用 open→half→closed 的时序合成，不是单独素材。
export const eyeStates = ['open', 'half', 'closed', 'smile', 'sparkle', 'wide'] as const;
export type EyeState = (typeof eyeStates)[number];

// 口型。由播放音频的 RMS 驱动，不是按文字节奏瞎摆。
export const visemes = ['closed', 'small', 'medium', 'wide', 'round', 'smile'] as const;
export type Viseme = (typeof visemes)[number];

export const browStates = ['neutral', 'raised', 'furrowed', 'worried'] as const;
export type BrowState = (typeof browStates)[number];

// 整身动作，必须是独立全身图（姿势变了，覆盖层对不上）。
export const actions = [
  'idle',
  'wave',
  'sit',
  'sleep',
  'point',
  'hold',
  'jump',
  'tilt',
  'walk_a',
  'walk_b',
] as const;
export type ActionName = (typeof actions)[number];

// 漂浮特效，带偏移地叠在角色周围。
export const fxNames = ['sparkle', 'sweat', 'zzz', 'heart', 'exclaim', 'question', 'note'] as const;
export type FxName = (typeof fxNames)[number];

export const activities = ['idle', 'listening', 'thinking', 'speaking'] as const;
export type Activity = (typeof activities)[number];

// 可触碰的部位。原先住在 shared/room.ts 里，但房间已删除，而「摸头」属于桌宠本身
// 的交互，和房间无关，所以挪到这里。
export const touchParts = ['head', 'cheek', 'badge', 'hand'] as const;
export type TouchPart = (typeof touchParts)[number];

export function asTouchPart(value: string | null | undefined): TouchPart | null {
  return touchParts.includes(value as TouchPart) ? (value as TouchPart) : null;
}

// ---- rig.json ----
// 由 tools/art 生成，运行时加载。bbox 是覆盖层在 base 画布中的像素位置，
// 来自与 base 的自动像素 diff，不是手工标注。
const assetSchema = z
  .object({
    file: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();
export type RigAsset = z.infer<typeof assetSchema>;

const overlaySchema = assetSchema
  .extend({
    // 覆盖层左上角在 base 画布中的位置。
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    // diff 置信度：变化区域占 base 不透明面积的比例。过大说明不是局部改动。
    diffRatio: z.number().min(0).max(1),
  })
  .strict();
export type RigOverlay = z.infer<typeof overlaySchema>;

// 表情有两种实现方式，清单里必须显式区分 —— 这是原 manifest 禁止脸部合成的那个坑的解法。
const expressionEntrySchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('layers'),
      eyes: z.enum(eyeStates),
      brow: z.enum(browStates),
      // 说话时口型由音频覆盖；这是不说话时的静息口型。
      mouth: z.enum(visemes),
      blush: z.boolean().default(false),
    })
    .strict(),
  // diff 不可靠（变化区过大/过散）→ 整图交叉淡入，不假装能分层。
  z.object({ mode: z.literal('sprite'), sprite: assetSchema }).strict(),
]);
export type ExpressionEntry = z.infer<typeof expressionEntrySchema>;

export const rigManifestSchema = z
  .object({
    id: z.literal('stepchan_q'),
    version: z.string().min(1),
    // 生成参数留痕，便于复现与追责，不靠记忆。
    source: z
      .object({
        model: z.string(),
        masterQuality: z.string(),
        variantQuality: z.string(),
        generatedAt: z.string(),
      })
      .strict(),
    canvas: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).strict(),
    // 锚点：x 为中心，y 为脚底，和现有渲染器一致。
    anchor: z.object({ x: z.number(), y: z.number() }).strict(),
    base: assetSchema,
    layers: z
      .object({
        eyes: z.record(z.enum(eyeStates), overlaySchema),
        brow: z.record(z.enum(browStates), overlaySchema),
        mouth: z.record(z.enum(visemes), overlaySchema),
        blush: overlaySchema.optional(),
      })
      .strict(),
    expressions: z.record(z.enum(expressions), expressionEntrySchema),
    actions: z.record(z.enum(actions), assetSchema),
    fx: z.record(z.enum(fxNames), assetSchema),
    // 降级清单：哪些变体没能做成覆盖层，以及原因。必须可见，不能静默。
    degraded: z.array(z.object({ name: z.string(), reason: z.string() }).strict()),
  })
  .strict();
export type RigManifest = z.infer<typeof rigManifestSchema>;

// ---- 运行时表现状态 ----
// 大脑只描述「想表达什么」，渲染器决定怎么插值。两边不共享可变状态。
export const visualIntentSchema = z
  .object({
    expression: z.enum(expressions).optional(),
    action: z.enum(actions).optional(),
    fx: z.enum(fxNames).optional(),
  })
  .strict();
export type VisualIntent = z.infer<typeof visualIntentSchema>;

// 角色在屏幕上的落脚点。窗口位移是粗粒度的，不是每帧动（见计划里的 Tauri 约束 6）。
export const spots = [
  'bottom_right',
  'bottom_left',
  'bottom_center',
  'top_right',
  'top_left',
  'center',
] as const;
export type Spot = (typeof spots)[number];
