// StepFun logo 图层的清单（logo.json）。
//
// ---------------------------------------------------------------------------
// 为什么是独立的一份文件，而不是 rig.json 里的一个图层
// ---------------------------------------------------------------------------
// 想放进 rig.json 的 `layers`，但 `shared/pet.ts` 的 `rigManifestSchema` 是 `.strict()` 的，
// `layers` 只接受 eyes / brow / mouth / blush 四个键 —— 多写一个 `logo` 会在加载时直接
// 校验失败。契约是冻结的，不由本条线修改，所以 logo 走 sidecar：`logo.json`，
// 和 rig.json 同目录、同样由流水线生成、同样带 sha256 和尺寸、同样有自己的 degraded。
//
// 另一个必须独立的理由是**字段形状不一样**：`overlaySchema` 只有 x/y（左上角），
// 因为眼/眉/嘴覆盖层是从 master 上按像素 diff 裁下来的，天生就是 1:1 贴回原位。
// logo 不是裁下来的，它是从 SVG 几何栅格化的 256 px 贴图，需要**圆心 + 直径 + 旋转**
// 才能定位。硬塞进 x/y 等于把「缩放」偷偷藏进渲染器里，那就违反了「分层参数不硬编码」。
//
// 要合并进 rig.json 的话，shared/pet.ts 里加这些就够了（本文件的 schema 可直接搬过去）：
//   export const logoSlots = ['hair', 'chest'] as const;
//   layers: z.object({ ..., logo: z.record(z.enum(logoSlots), logoPlacementSchema).optional() })
// 届时把 loadLogo 换成读 manifest.layers.logo 即可，渲染器其余代码不用动。
import { actions, type ActionName } from '../../../../shared/pet';
import { z } from 'zod';

/** logo 贴在身上的位置。两处位置不同、尺寸不同，所以是两条独立记录。 */
export const logoSlots = ['hair', 'chest'] as const;
export type LogoSlot = (typeof logoSlots)[number];

const logoPlacementSchema = z
  .object({
    /** 圆心，单位 px，坐标系＝运行期画布（512×512，与 rig.json 的 canvas 一致）。 */
    cx: z.number(),
    cy: z.number(),
    /** 直径，px（同一坐标系）。 */
    size: z.number().positive(),
    /** 自转，弧度，正方向与 Pixi 一致（顺时针，y 轴向下）。 */
    rotation: z.number(),
    /**
     * 跟随身体摆动的**额外**抖动系数。0 = 完全贴死在身上（衣料），
     * >0 = 像夹子一样多晃一点。具体换算见 RigRenderer 的 LOGO_MOTION。
     */
    jiggle: z.number().min(0).max(2),
    /**
     * 实测值：master 上那个假徽章的深色像素到其中心的最大距离（px，运行期坐标系）。
     * `size / 2` 必须 ≥ 这个数，否则旧徽章会从圆盘边上露出来。流水线里有断言，
     * 这里再校验一次是因为 logo.json 可能被手改过。
     */
    coverRadius: z.number().nonnegative(),
  })
  .strict();
export type LogoPlacement = z.infer<typeof logoPlacementSchema>;

// 和 shared/pet.ts 的 assetSchema 同形。刻意复制而不是导出复用：
// shared 没有导出 assetSchema，而本条线不改 shared。合并进契约时删掉这一段。
const assetSchema = z
  .object({
    file: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();

export const logoManifestSchema = z
  .object({
    version: z.string().min(1),
    /** 来源留痕：源 SVG 的 sha256、原始文件出处、栅格化参数、与真 SVG 渲染器的对比数字。 */
    source: z
      .object({
        svg: z.string().min(1),
        svgSha256: z.string().regex(/^[0-9a-f]{64}$/),
        origin: z.string(),
        raster: z.object({ size: z.number().int().positive(), supersample: z.number().int().positive(), renderer: z.string() }),
        /** 没有可用的 SVG 渲染器时为 null —— 「没比过」必须可见，不能表现为缺字段。 */
        fidelity: z
          .object({
            iou: z.number().min(0).max(1),
            pixelAgreement: z.number().min(0).max(1),
            mismatchPixels: z.number().int().nonnegative(),
            deepMismatchPixels: z.number().int().nonnegative(),
          })
          .passthrough()
          .nullable(),
      })
      .passthrough(),
    canvas: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).strict(),
    asset: assetSchema,
    placements: z.record(z.enum(logoSlots), logoPlacementSchema),
    /** 实测的旧徽章数据（中心、外接框、覆盖半径）。只做留痕，渲染器不读。 */
    measured: z.record(z.string(), z.unknown()).optional(),
    /** 这份位置只在这些动作的画幅上成立。其余动作必须隐藏 logo 层。 */
    appliesTo: z.array(z.enum(actions)).min(1),
    degraded: z.array(z.object({ name: z.string(), reason: z.string() }).strict()),
  })
  .strict();
export type LogoManifest = z.infer<typeof logoManifestSchema>;

export interface LoadedLogo {
  manifest: LogoManifest;
  /** 这份 placement 成立的动作集合。 */
  appliesTo: ReadonlySet<ActionName>;
}

/** logo.json 相对 rig.json 的文件名。两者同目录。 */
export const logoManifestFile = 'logo.json';

/** 把 rig.json 的 URL 换成同目录下的 logo.json。 */
export function logoUrlFor(rigManifestUrl: string) {
  const i = rigManifestUrl.lastIndexOf('/');
  return (i < 0 ? '' : rigManifestUrl.slice(0, i + 1)) + logoManifestFile;
}

export function parseLogoManifest(json: unknown): LoadedLogo {
  const parsed = logoManifestSchema.safeParse(json);
  if (!parsed.success) {
    // 和 rig.json 一样：结构错了就是流水线错了，不做运行时兼容猜测。
    const first = parsed.error.issues[0];
    throw new Error(`logo.json 不符合契约：${first.path.join('.')} ${first.message}`);
  }
  const m = parsed.data;
  for (const [slot, p] of Object.entries(m.placements)) {
    if (!p) continue;
    // 盖不住就不要悄悄用。这是「真 logo 盖在假徽章上」唯一的硬条件。
    if (p.size / 2 < p.coverRadius) {
      throw new Error(
        `logo.json 的 ${slot} 盖不住旧徽章：直径 ${p.size} / 2 < 实测覆盖半径 ${p.coverRadius}`,
      );
    }
  }
  return { manifest: m, appliesTo: new Set(m.appliesTo) };
}
