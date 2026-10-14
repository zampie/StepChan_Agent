import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { availableActions, isNoopAction } from '../apps/web/src/pet';
import {
  actions,
  browStates,
  eyeStates,
  expressions,
  fxNames,
  rigManifestSchema,
  visemes,
  type RigManifest,
} from '../shared/pet';

const root = path.resolve(import.meta.dirname, '..');
const rigDir = path.join(root, 'assets/stepchan_q_v1');
const rigPath = path.join(rigDir, 'rig.json');

// 契约要求 z.record(z.enum(...)) 的键必须齐全（zod 4 的 record 对 enum 键是穷尽校验的）。
// 所以「缺素材」不可能表现为「少一个键」，只会表现为「键在但降级了」。
// 这组测试的职责就是把这件事钉死：清单完整 + 文件真的在 + 内容真的没被换掉。
const manifest: RigManifest = rigManifestSchema.parse(
  JSON.parse(readFileSync(rigPath, 'utf8')),
);

const degradedNames = new Set(manifest.degraded.map((d) => d.name));

function sha256(file: string) {
  return createHash('sha256').update(readFileSync(path.join(rigDir, file))).digest('hex');
}

interface NamedAsset {
  name: string;
  file: string;
  sha256: string;
  width: number;
  height: number;
}

/** 清单里引用的全部素材。按契约枚举遍历，不用 Object.entries —— 顺手也验证了键的齐全。 */
function allAssets(): NamedAsset[] {
  const out: NamedAsset[] = [{ name: 'base', ...manifest.base }];
  for (const s of eyeStates) out.push({ name: `eyes.${s}`, ...manifest.layers.eyes[s]! });
  for (const s of browStates) out.push({ name: `brow.${s}`, ...manifest.layers.brow[s]! });
  for (const s of visemes) out.push({ name: `mouth.${s}`, ...manifest.layers.mouth[s]! });
  if (manifest.layers.blush) out.push({ name: 'blush', ...manifest.layers.blush });
  for (const name of expressions) {
    const e = manifest.expressions[name]!;
    if (e.mode === 'sprite') out.push({ name: `expression.${name}`, ...e.sprite });
  }
  for (const name of actions) out.push({ name: `action.${name}`, ...manifest.actions[name]! });
  for (const name of fxNames) out.push({ name: `fx.${name}`, ...manifest.fx[name]! });
  return out;
}

test('rig.json 通过 rigManifestSchema', () => {
  // parse 在模块加载时已经跑过；这里把它作为一条显式断言留在报告里。
  assert.equal(manifest.id, 'stepchan_q');
  assert.ok(manifest.version.length > 0);
  assert.equal(manifest.canvas.width, manifest.canvas.height, '画布必须是正方形（锚点约定依赖这一点）');
  assert.deepEqual(manifest.anchor, { x: 0.5, y: 1 }, '锚点必须是中心/脚底');
});

test('source 段记录了可复现的生成参数', () => {
  assert.equal(manifest.source.model, 'gpt-image-2');
  assert.ok(manifest.source.masterQuality.length > 0);
  assert.ok(manifest.source.variantQuality.length > 0);
  assert.ok(
    !Number.isNaN(Date.parse(manifest.source.generatedAt)),
    `generatedAt 不是可解析的时间：${manifest.source.generatedAt}`,
  );
});

test('每个被引用的文件都存在，且 sha256 与声明一致', () => {
  for (const a of allAssets()) {
    const abs = path.join(rigDir, a.file);
    assert.ok(existsSync(abs), `${a.name} 引用的 ${a.file} 不存在`);
    assert.equal(sha256(a.file), a.sha256, `${a.name} (${a.file}) 的 sha256 不匹配 —— 素材被改过但清单没重建`);
  }
});

test('声明的宽高与文件真实宽高一致', () => {
  for (const a of allAssets()) {
    const { width, height } = pngSize(path.join(rigDir, a.file));
    assert.equal(width, a.width, `${a.name} 宽度声明 ${a.width} 实际 ${width}`);
    assert.equal(height, a.height, `${a.name} 高度声明 ${a.height} 实际 ${height}`);
  }
});

test('契约里的每个 Expression 都在清单里，降级的必须出现在 degraded', () => {
  for (const name of expressions) {
    const e = manifest.expressions[name];
    assert.ok(e, `缺少表情 ${name}`);
    if (e.mode === 'sprite')
      assert.ok(
        degradedNames.has(`expression.${name}`),
        `${name} 用了整图 sprite 但没写进 degraded —— 降级必须可见`,
      );
  }
});

test('契约里的每个 ActionName / FxName 都在清单里', () => {
  for (const name of actions) assert.ok(manifest.actions[name], `缺少动作 ${name}`);
  for (const name of fxNames) assert.ok(manifest.fx[name], `缺少特效 ${name}`);
});

test('契约里的每个 EyeState / BrowState / Viseme 都有覆盖层', () => {
  for (const s of eyeStates) assert.ok(manifest.layers.eyes[s], `缺少眼型 ${s}`);
  for (const s of browStates) assert.ok(manifest.layers.brow[s], `缺少眉型 ${s}`);
  for (const s of visemes) assert.ok(manifest.layers.mouth[s], `缺少口型 ${s}`);
});

test('身份项是 1×1 全透明空操作（base 自己，没有变化像素）', () => {
  const identity = [
    manifest.layers.eyes.open,
    manifest.layers.brow.neutral,
    manifest.layers.mouth.closed,
  ];
  for (const ov of identity) {
    assert.ok(ov, '身份项覆盖层缺失');
    assert.equal(ov.width, 1, '身份项应该是 1×1 空操作');
    assert.equal(ov.height, 1);
    assert.equal(ov.diffRatio, 0);
  }
});

test('非身份覆盖层要么有实际改动量，要么被降级 —— 不存在「空白覆盖层」', () => {
  const check = (slot: string, state: string, ov: { width: number; height: number; diffRatio: number }) => {
    if (degradedNames.has(`${slot}.${state}`)) {
      assert.equal(ov.width, 1, `${slot}.${state} 已降级，必须退成 1×1 空操作`);
      return;
    }
    assert.ok(ov.diffRatio > 0, `${slot}.${state} 没降级但 diffRatio 为 0 —— 这是个空白覆盖层`);
    assert.ok(ov.width > 1 && ov.height > 1, `${slot}.${state} 没降级但尺寸是 1×1`);
  };
  for (const s of eyeStates) if (s !== 'open') check('eyes', s, manifest.layers.eyes[s]!);
  for (const s of browStates) if (s !== 'neutral') check('brow', s, manifest.layers.brow[s]!);
  for (const s of visemes) if (s !== 'closed') check('mouth', s, manifest.layers.mouth[s]!);
});

test('覆盖层落在画布内', () => {
  const { width, height } = manifest.canvas;
  for (const ov of allAssets()) {
    const o = ov as NamedAsset & { x?: number; y?: number };
    if (o.x === undefined || o.y === undefined) continue;
    assert.ok(o.x + o.width <= width, `${o.name} 横向越界`);
    assert.ok(o.y + o.height <= height, `${o.name} 纵向越界`);
  }
});

test('layers 模式的表情只引用存在的覆盖层', () => {
  for (const [name, e] of Object.entries(manifest.expressions)) {
    if (e.mode !== 'layers') continue;
    assert.ok(manifest.layers.eyes[e.eyes], `${name} 引用了不存在的眼型 ${e.eyes}`);
    assert.ok(manifest.layers.brow[e.brow], `${name} 引用了不存在的眉型 ${e.brow}`);
    assert.ok(manifest.layers.mouth[e.mouth], `${name} 引用了不存在的口型 ${e.mouth}`);
    if (e.blush) assert.ok(manifest.layers.blush, `${name} 要求腮红但清单里没有腮红层`);
  }
});

test('动作与全身 sprite 都是满画布尺寸（锚点统一才能原地换姿势）', () => {
  for (const [name, a] of Object.entries(manifest.actions)) {
    assert.equal(a.width, manifest.canvas.width, `动作 ${name} 不是满画布宽`);
    assert.equal(a.height, manifest.canvas.height, `动作 ${name} 不是满画布高`);
  }
  for (const [name, e] of Object.entries(manifest.expressions)) {
    if (e.mode !== 'sprite') continue;
    assert.equal(e.sprite.width, manifest.canvas.width, `表情 ${name} 的整图不是满画布`);
    assert.equal(e.sprite.height, manifest.canvas.height);
  }
});

test('指向 idle 整身图的动作（没做出来的）必须出现在 degraded', () => {
  for (const name of actions) {
    if (name === 'idle') continue;
    if (manifest.actions[name]!.sha256 !== manifest.base.sha256) continue;
    assert.ok(
      degradedNames.has(`action.${name}`),
      `动作 ${name} 的素材就是 idle 的整身图，但没写进 degraded —— 这就是一个静默的空动作`,
    );
  }
});

test('availableActions / isNoopAction 与 degraded 一致', () => {
  const avail = new Set(availableActions(manifest));
  for (const name of actions) {
    const noop = isNoopAction(manifest, name);
    assert.equal(avail.has(name), !noop, `${name} 的可用性判定与 isNoopAction 不一致`);
    if (noop) assert.ok(degradedNames.has(`action.${name}`), `${name} 是空动作但没降级记录`);
  }
  assert.ok(avail.has('idle'), 'idle 必须始终可用');
});

test('degraded 的每条都有名字和非空原因', () => {
  for (const d of manifest.degraded) {
    assert.ok(d.name.length > 0);
    assert.ok(d.reason.length > 5, `${d.name} 的降级原因太短，等于没说：${d.reason}`);
  }
  // 名字不应重复到看不出发生了什么。
  const seen = new Map<string, number>();
  for (const d of manifest.degraded) seen.set(d.name, (seen.get(d.name) ?? 0) + 1);
  for (const [name, n] of seen) assert.ok(n <= 1, `degraded 里 ${name} 出现了 ${n} 次`);
});

test('运行时素材已同步到 vite 的 public 目录', () => {
  const pub = path.join(root, 'apps/web/public/assets/stepchan_q_v1');
  assert.ok(existsSync(path.join(pub, 'rig.json')), 'public 下缺 rig.json —— 跑一次 npm run rig');
  for (const a of allAssets())
    assert.ok(existsSync(path.join(pub, a.file)), `public 下缺 ${a.file}`);
});

/** 只读 PNG 的 IHDR，不引图像库 —— 测试不该依赖 sharp 这种可选依赖。 */
function pngSize(file: string) {
  const buf = readFileSync(file);
  assert.equal(buf.readUInt32BE(0), 0x89504e47, `${file} 不是 PNG`);
  assert.equal(buf.subarray(12, 16).toString('latin1'), 'IHDR', `${file} 的第一个块不是 IHDR`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

test('pngSize 能正确读出 base 的尺寸（自检，防止读错字节偏移）', () => {
  const s = pngSize(path.join(rigDir, manifest.base.file));
  assert.equal(s.width, manifest.canvas.width);
});
