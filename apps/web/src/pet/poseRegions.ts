// 逐姿势命中区清单（hitregions.json）。
//
// ---------------------------------------------------------------------------
// 这份数据存在的原因：换姿势后点不中她
// ---------------------------------------------------------------------------
// 命中判定必须在 Rust 侧做（穿透一开，webview 就收不到 mousemove，用 JS 驱动会自锁），
// 所以命中区是一份**数据**，由前端推给 Rust。原来那份（apps/web/src/platform/hitRegions.ts）
// 是按 idle 立姿量的一组归一化矩形 —— 换了姿势身体整个挪位，矩形就全落空了。
// 实测最严重的是 sleep：侧躺时角色的不透明区域在画幅下半部偏左，
// 而 idle 的头部矩形在 y 0.11–0.30，**一个矩形都命中不到**，于是窗口保持穿透，
// 左右键都穿到后面的应用去。
//
// 修法和 logo 一样：逐画幅量。tools/art/regions.py 对每张运行期纹理量出
//   - 整身不透明外接框（必然存在 → 兜底矩形，保证任何姿势都点得中）
//   - 脸部肤色连通域（register.py 用过的同一招）→ 脸颊 / 头部
//   - 两枚假徽章（logo.py 的同一个检测器）→ 徽章
//   - 裙摆（饱和青色的最大连通域）
//   - 其余肤色块（手/膝）→ 手
// 量不出来的部位就不写，**但整身兜底框一定在**。
//
// ---------------------------------------------------------------------------
// 为什么又是一份 sidecar
// ---------------------------------------------------------------------------
// rig.json 的 schema 在 shared/pet.ts 里，是 `.strict()` 且本轮冻结，加字段会直接
// 校验失败。所以走和 logo.json 同样的路：同目录、同样由流水线生成、同样带 degraded。
// 以后要并进契约的话，把下面的 schema 搬过去即可（见报告里的字段名建议）。
import { actions, type ActionName } from '../../../../shared/pet';
import { z } from 'zod';

/**
 * 一个命中矩形。**结构上与 shared/desktop.ts 的 HitRegion 完全一致**，
 * 所以可以直接喂给 desktop.setHitRegions()，不需要转换也不需要 cast。
 *
 * 刻意不从 shared/desktop.ts import：pet/ 只依赖 shared/pet.ts 这一份契约，
 * 渲染层不该知道桌面能力的存在（见 RigRenderer 顶部的解耦约定）。
 * 两边漂移的风险由 tests/rig.test.ts 里的结构一致性断言兜着。
 */
export interface PoseRegion {
  /** 部位名。'body' 是整身兜底框 —— 认不出的部位名会走 default 反应组、且没有专属台词。 */
  part: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const regionSchema = z
  .object({
    part: z.string().min(1),
    x0: z.number().min(0).max(1),
    y0: z.number().min(0).max(1),
    x1: z.number().min(0).max(1),
    y1: z.number().min(0).max(1),
  })
  .strict();

export const poseRegionsManifestSchema = z
  .object({
    version: z.string().min(1),
    /** 测量参数与逐帧实测数字的留痕。渲染器不读。 */
    measured: z.record(z.string(), z.unknown()).optional(),
    /**
     * 逐动作的命中区。键必须把契约里的动作全列齐（穷尽的 record）——
     * 「漏了一个动作」必须在加载时就报错，而不是等用户在那个姿势下点不中她才发现。
     * 每个动作的数组**至少一项**（整身兜底框），顺序即优先级（Rust 取第一个命中的）。
     */
    poses: z.record(z.enum(actions), z.array(regionSchema).min(1)),
    degraded: z.array(z.object({ name: z.string(), reason: z.string() }).strict()),
  })
  .strict();
export type PoseRegionsManifest = z.infer<typeof poseRegionsManifestSchema>;

export interface LoadedPoseRegions {
  manifest: PoseRegionsManifest;
  /** 某个姿势的命中区。清单里没有这个动作时返回整身兜底框，绝不返回空数组。 */
  regionsFor(action: ActionName): PoseRegion[];
}

/** hitregions.json 相对 rig.json 的文件名。两者同目录。 */
export const poseRegionsFile = 'hitregions.json';

export function poseRegionsUrlFor(rigManifestUrl: string) {
  const i = rigManifestUrl.lastIndexOf('/');
  return (i < 0 ? '' : rigManifestUrl.slice(0, i + 1)) + poseRegionsFile;
}

/**
 * 整身兜底矩形：素材画布的中间 80%。
 *
 * 清单缺失/加载失败时用它。数字来自 master.png 的 alpha 外接框（x 209–813 / 1024 ≈ 0.20–0.79，
 * y 31–993 ≈ 0.03–0.97），为所有姿势留了余量 —— 刻意**偏大**：
 * 这是「点不中」的最后一道防线，宁可多出一点背景也不能漏。
 */
export function fullBodyFallback(): PoseRegion {
  return { part: 'body', x0: 0.1, y0: 0.02, x1: 0.9, y1: 0.99 };
}

export function parsePoseRegions(json: unknown): LoadedPoseRegions {
  const parsed = poseRegionsManifestSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(`hitregions.json 不符合契约：${first.path.join('.')} ${first.message}`);
  }
  const m = parsed.data;
  for (const [action, list] of Object.entries(m.poses) as [ActionName, PoseRegion[]][]) {
    for (const r of list) {
      // 空矩形等于没有，而「有一项但点不中」比「没有这一项」更难查。
      if (r.x1 <= r.x0 || r.y1 <= r.y0) {
        throw new Error(`hitregions.json 的 ${action}.${r.part} 是空矩形：${JSON.stringify(r)}`);
      }
    }
    if (!list.some((r) => r.part === 'body')) {
      // 兜底框是这份清单存在的全部意义，缺了就等于又回到「某个姿势点不中」。
      throw new Error(`hitregions.json 的 ${action} 没有整身兜底框（part: 'body'）`);
    }
  }
  return {
    manifest: m,
    regionsFor: (action) => m.poses[action] ?? [fullBodyFallback()],
  };
}
