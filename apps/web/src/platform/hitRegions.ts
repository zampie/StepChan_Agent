// 命中区表。归一化到 0..1，坐标系＝素材画布（assets/stepchan_q_v1/master.png，1024×1024，
// 角色居中、脚底贴近下沿、四周约 3% 留白），与 shared/desktop.ts 的 hitRegionSchema 一致。
//
// 为什么是「表」而不是函数：命中判定必须在 Rust 侧做（穿透一开 webview 就收不到
// mousemove，用 JS 驱动会自锁），所以这份数据要能整体 push 给 Rust。
// 旧的 apps/web/src/pet/hitRegions.ts 是个函数，且矩形是按上一版全身比例标的，
// Q 版头身比完全不同，这里重新按 master.png 的 alpha/配色分布量出来。
//
// 量取依据（master.png 像素 → 归一化）：
//   整体 alpha bbox        x 209–813  y  31–993
//   发饰徽章（黑色方块）     x 613–661  y 215–262
//   脸部肤色带             x 398–613  y 350–490
//   胸前徽章（领结上方块）   x 543–567  y 565–592
//   左手 / 右手（肤色）     x 353–388 / 633–666  y 704–736
//   裙摆（青色褶裙）        x 394–626  y 650–765
// 小目标（徽章、手）按实测 bbox 适度外扩成可点的大小；Rust 侧另有 ~6–10 px 的滞回。
import type { HitRegion } from '../../../../shared/desktop';
import { touchParts, type TouchPart } from '../../../../shared/pet';

/**
 * 可命中部位。前四个与 shared/pet.ts 的 touchParts 一一对应（她有对应的台词），
 * 'skirt' 只用于渲染层的小反应，**不是** TouchPart —— 映射回互动语义前先过 asTouchPart。
 */
export const hitParts = ['head', 'cheek', 'badge', 'hand', 'skirt'] as const;
export type HitPart = (typeof hitParts)[number];

/** 编译期约束：前四个必须仍是合法的 TouchPart，别让两边偷偷漂移。 */
const _touchPartsAreCovered: readonly TouchPart[] = touchParts;
void _touchPartsAreCovered;

type Region = HitRegion & { part: HitPart };

/**
 * 顺序即优先级：Rust 侧取第一个命中的矩形。
 * 徽章在前 —— 发饰徽章落在头部矩形内部，排后面就永远摸不到。
 */
const hitRegions: Region[] = [
  // 发饰徽章（右侧头发上的方形发夹）。
  { part: 'badge', x0: 0.58, y0: 0.2, x1: 0.67, y1: 0.28 },
  // 胸前徽章（水手领结上的方块）。实测只有 24 px 宽，连领结一起放大成可点区域。
  { part: 'badge', x0: 0.5, y0: 0.53, x1: 0.59, y1: 0.61 },
  // 头顶：从发团顶部到眉线上方（呆毛更高，但那一撮太细，不做命中）。
  { part: 'head', x0: 0.33, y0: 0.11, x1: 0.67, y1: 0.3 },
  // 脸颊：眼睛到下巴这一带，含腮红。
  { part: 'cheek', x0: 0.38, y0: 0.3, x1: 0.62, y1: 0.49 },
  // 双手（垂在裙子两侧）。
  { part: 'hand', x0: 0.32, y0: 0.67, x1: 0.4, y1: 0.74 },
  { part: 'hand', x0: 0.6, y0: 0.67, x1: 0.68, y1: 0.74 },
  // 裙摆。排在手之后，免得把手的小矩形吃掉。
  { part: 'skirt', x0: 0.38, y0: 0.63, x1: 0.62, y1: 0.75 },
];

export default hitRegions;

/** 把命中部位映射回互动语义；'skirt' 没有对应台词，返回 null。 */
export function asTouchPart(part: string | null): TouchPart | null {
  return part === 'head' || part === 'cheek' || part === 'badge' || part === 'hand' ? part : null;
}
