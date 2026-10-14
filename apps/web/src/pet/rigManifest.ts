// rig.json 的加载与校验。
// 清单由 tools/art 生成，运行时只读。校验用 shared/pet.ts 的 schema —— 渲染器不自己定义结构。
import { actions, rigManifestSchema, type ActionName, type RigManifest } from '../../../../shared/pet';

export interface LoadedRig {
  manifest: RigManifest;
  /** 素材文件所在目录（含结尾斜杠），由清单 URL 推出。 */
  baseUrl: string;
}

export function resolveBaseUrl(manifestUrl: string) {
  const i = manifestUrl.lastIndexOf('/');
  return i < 0 ? '' : manifestUrl.slice(0, i + 1);
}

export async function loadRig(manifestUrl: string, fetchImpl: typeof fetch = fetch): Promise<LoadedRig> {
  const res = await fetchImpl(manifestUrl);
  if (!res.ok) throw new Error(`rig.json 加载失败：HTTP ${res.status}`);
  const json: unknown = await res.json();
  const parsed = rigManifestSchema.safeParse(json);
  if (!parsed.success) {
    // 清单结构错了就是流水线错了，不要在运行时做兼容猜测 —— 猜出来的是看不见的半成品。
    const first = parsed.error.issues[0];
    throw new Error(`rig.json 不符合契约：${first.path.join('.')} ${first.message}`);
  }
  return { manifest: parsed.data, baseUrl: resolveBaseUrl(manifestUrl) };
}

/** 清单里声明为降级的条目，UI 可以据此显示「这个表情没有分层」。 */
export function degradedNames(manifest: RigManifest) {
  return new Set(manifest.degraded.map((d) => d.name));
}

/**
 * 没有独立素材、但由渲染器程序化实现的动作。
 *
 * 目前只有 tilt：歪头本质上是一个旋转，三版 prompt 都没让模型真的把头画歪
 * （只有呆毛倒了，两眼连线仍然水平，220 px 下与 idle 无法区分）。
 * 头身比 40% 的 Q 版角色，整体倾斜在视觉上就读作歪头，所以交给渲染器转比再烧额度划算。
 * 这份集合必须与 tools/art/register.py 的 PROCEDURAL_ACTIONS 一致。
 */
export const proceduralActions = new Set<ActionName>(['tilt']);

/**
 * 真正会产生可见变化的动作。
 *
 * 契约里 `actions` 是 `z.record(z.enum(actions), ...)`，zod 4 对 enum 键是穷尽校验的 ——
 * 所以「某个动作没做出来」无法表现为「少一个键」，只能表现为「键指向 idle 的那张图」。
 * 流水线会把这种情况写进 degraded，同时让它的 sha256 等于 base 的 sha256。
 *
 * UI 和 brain 的 express 工具应该用这个函数过一遍，不要把无效动作提供给模型 ——
 * 让它说「我指给你看」然后什么都不动，比根本没有这个动作更糟。
 */
export function availableActions(manifest: RigManifest): ActionName[] {
  return actions.filter((name) => !isNoopAction(manifest, name));
}

/** 某个动作是不是彻底的空操作：既没有独立素材，也没有程序化实现。 */
export function isNoopAction(manifest: RigManifest, name: ActionName) {
  if (name === 'idle' || proceduralActions.has(name)) return false;
  return manifest.actions[name]?.sha256 === manifest.base.sha256;
}
