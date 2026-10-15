import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import {
  availableActions,
  isNoopAction,
  logoSlots,
  parseLogoManifest,
  parsePoseRegions,
} from '../apps/web/src/pet';

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
  // 同步点只有一个：scripts/sync-rig.mjs → apps/web/public/rig/，挂在 predev/prebuild 上。
  // 流水线本身不再复制一份 —— 两处都写会在 public/ 下留两份 3MB 素材，
  // 都被 vite 打进 dist，而只有一份会被加载。App.tsx 读的是 `${BASE_URL}rig/rig.json`。
  const pub = path.join(root, 'apps/web/public/rig');
  assert.ok(
    existsSync(path.join(pub, 'rig.json')),
    'public/rig 下缺 rig.json —— 跑一次 npm run sync-rig',
  );
  for (const a of allAssets())
    assert.ok(existsSync(path.join(pub, a.file)), `public/rig 下缺 ${a.file}`);
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

/**
 * 解出 8-bit RGBA PNG 的 alpha 通道。只支持 colorType 6 / bitDepth 8 —— 流水线只产这一种，
 * 遇到别的直接断言失败而不是悄悄放过。
 */
function pngAlpha(file: string) {
  const buf = readFileSync(file);
  let off = 8;
  let w = 0;
  let h = 0;
  const idat: Buffer[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString('latin1');
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      assert.equal(data[8], 8, `${file} 不是 8-bit`);
      assert.equal(data[9], 6, `${file} 不是 RGBA（colorType 6）`);
      assert.equal(data[12], 0, `${file} 用了 interlace，解析器不支持`);
    } else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = w * bpp;
  const out = new Uint8Array(w * h);
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    for (let i = 0; i < stride; i++) {
      const x = raw[p + i];
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v: number;
      if (filter === 0) v = x;
      else if (filter === 1) v = x + a;
      else if (filter === 2) v = x + b;
      else if (filter === 3) v = x + ((a + b) >> 1);
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else throw new Error(`未知 PNG 过滤器 ${filter}`);
      cur[i] = v & 0xff;
    }
    p += stride;
    for (let x = 0; x < w; x++) out[y * w + x] = cur[x * bpp + 3];
    prev.set(cur);
  }
  return out;
}

// alpha.py 的两条实测事实必须在最终产物上成立，否则后处理等于没做：
//   1. gpt-image-2 的主体 alpha 上限只到 253–254，一个 255 都没有 → 必须阈值化
//   2. 透明背景产物带约 1.5% 的 a<16 极淡光晕 → 叠在深色桌面上会显出白雾，必须抹掉
test('产物里没有 0 < alpha < 16 的淡光晕（深色桌面上会显成一圈白雾）', () => {
  for (const a of allAssets()) {
    if (a.width <= 2) continue; // 1×1 空操作没有内容
    const alpha = pngAlpha(path.join(rigDir, a.file));
    let halo = 0;
    for (const v of alpha) if (v > 0 && v < 16) halo += 1;
    assert.equal(halo, 0, `${a.name} 还有 ${halo} 个 a<16 的光晕像素 —— clean_alpha 没生效`);
  }
});

test('每张产物都有真正不透明的像素（alpha 已阈值化到 255）', () => {
  for (const a of allAssets()) {
    if (a.width <= 2) continue;
    const alpha = pngAlpha(path.join(rigDir, a.file));
    let full = 0;
    for (const v of alpha) if (v === 255) full += 1;
    assert.ok(
      full > 0,
      `${a.name} 一个 alpha=255 的像素都没有 —— gpt-image-2 的 253 上限没被拉满`,
    );
  }
});

test('1×1 身份项确实是全透明的（空操作，不是一块纯色）', () => {
  for (const a of allAssets()) {
    if (a.width !== 1 || a.height !== 1) continue;
    assert.equal(pngAlpha(path.join(rigDir, a.file))[0], 0, `${a.name} 的 1×1 贴图不是全透明`);
  }
});

// alpha.py / chroma.py 的合成输入用例在 Python 侧（tools/art/selftest.py），
// 因为被测对象就是 Python。这里只负责把它接进 npm test，并在失败时把详情原样抛出。
test('tools/art 的 alpha / chroma helper 合成输入自测', (t) => {
  const py = path.join(homedir(), 'Desktop/gpt-image-lab/.venv/bin/python');
  if (!existsSync(py)) {
    // 整条素材流水线都依赖这个 venv（Pillow）。没有它就跑不了流水线，也跑不了这组测试。
    t.skip(`缺少 ${py} —— 素材流水线的 venv 不在，跳过 Python helper 自测`);
    return;
  }
  const r = spawnSync(py, [path.join(root, 'tools/art/selftest.py')], { encoding: 'utf8' });
  assert.equal(r.status, 0, `tools/art/selftest.py 失败：\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /0 条失败/, `自测输出不符合预期：\n${r.stdout}`);
});

// ---------------------------------------------------------------------------
// StepFun logo 图层（sidecar 清单 logo.json，见 apps/web/src/pet/logoManifest.ts 顶部）
//
// 和 rig.json 同一套要求：结构过 schema、文件真的在、sha256 和尺寸没被换掉、
// 没有光晕、已同步到 public。另外多两条只属于 logo 的：
//   - 覆盖半径：直径必须盖得住实测的旧假徽章，否则 220 px 下会露出一圈灰边；
//   - 与真 SVG 渲染器的形状一致性：qlmanage 渲同一份 SVG，深层错判必须 ≈0。
// ---------------------------------------------------------------------------

const logoPath = path.join(rigDir, 'logo.json');
const logo = parseLogoManifest(JSON.parse(readFileSync(logoPath, 'utf8')));

test('logo.json 通过 schema，且画布与 rig.json 一致', () => {
  assert.equal(logo.manifest.canvas.width, manifest.canvas.width);
  assert.equal(logo.manifest.canvas.height, manifest.canvas.height);
  assert.ok(logo.manifest.version.length > 0);
});

test('logo 贴图存在，sha256 与尺寸都与声明一致', () => {
  const a = logo.manifest.asset;
  const abs = path.join(rigDir, a.file);
  assert.ok(existsSync(abs), `logo 引用的 ${a.file} 不存在`);
  assert.equal(sha256(a.file), a.sha256, 'logo 贴图被改过但 logo.json 没重建');
  const { width, height } = pngSize(abs);
  assert.deepEqual({ width, height }, { width: a.width, height: a.height });
  assert.equal(width, height, 'logo 贴图必须是正方形（placement 用直径定位）');
});

test('logo 贴图的分辨率足够喂运行期尺寸（retina + 放大桌宠）', () => {
  // 桌宠最大 400 px、画布 512 → 最大显示倍率 400/512；再乘 dpr 2。
  // 贴图短边必须大于「最大 placement 直径 × 这个倍率」才不会糊。
  const maxSize = Math.max(
    ...actions.flatMap((a) => logoSlots.map((s) => logo.manifest.placements[a]?.[s]?.size ?? 0)),
  );
  const needed = Math.ceil(maxSize * (400 / logo.manifest.canvas.height) * 2);
  assert.ok(
    logo.manifest.asset.width >= needed,
    `logo 贴图 ${logo.manifest.asset.width} px 小于所需的 ${needed} px`,
  );
});

test('每个动作都有 placement 条目，且每张姿势图上至少盖掉一枚假徽章', () => {
  // 这是「logo 在所有姿势下都显示」那个修复的核心断言。
  // 上一版只量了 idle，placements 只有两条记录、appliesTo 只有 idle/tilt，
  // 其余 8 个动作露出 master 自带的假方块 —— 用户直接看出来了。
  for (const name of actions) {
    const frame = logo.manifest.placements[name];
    assert.ok(frame, `动作 ${name} 没有 placement 条目（逐动作测量漏了一帧）`);
    assert.ok(
      Object.keys(frame).length >= 1,
      `动作 ${name} 一枚 logo 都不画 —— 那就又回到「这个姿势露出假徽章」了`,
    );
    assert.ok(frame.hair, `动作 ${name} 缺发饰那枚 logo（它在每张图上都看得见，不该量不到）`);
    assert.ok(logo.actionsWithLogo.has(name), `${name} 不在 actionsWithLogo 里`);
  }
});

test('每个 placement 都盖得住**这一帧**实测的旧假徽章（「覆盖得住」的硬条件）', () => {
  for (const name of actions) {
    for (const slot of logoSlots) {
      const p = logo.manifest.placements[name]?.[slot];
      if (!p) continue; // 这个姿势下这一枚量不到，清单里就没有 —— 下面另有断言要求它被记账
      assert.ok(p.coverRadius > 0, `${name}.${slot} 的 coverRadius 是 0 —— 没量过旧徽章`);
      assert.ok(
        p.size / 2 >= p.coverRadius,
        `${name}.${slot} 直径 ${p.size} 盖不住实测半径 ${p.coverRadius}`,
      );
      // 太大也不行：圆盘比旧徽章大一倍就成了另一个设计，而不是「替换徽章」。
      assert.ok(p.size / 2 < p.coverRadius * 1.6, `${name}.${slot} 的 logo 比旧徽章大太多（${p.size}）`);
    }
  }
});

test('逐帧位置确实各不相同 —— 不是把 idle 的那组抄了 10 遍', () => {
  const key = (n: (typeof actions)[number]) => {
    const p = logo.manifest.placements[n]?.hair;
    return p ? `${p.cx},${p.cy}` : 'none';
  };
  const distinct = new Set(actions.map(key));
  // tilt 和 idle 指向同一张图（rig.json 里 tilt 没有独立素材），所以相同是对的；
  // 其余 8 个动作各是一张独立的姿势图，位置必须不同。
  assert.equal(key('tilt'), key('idle'), 'tilt 用的就是 idle 的整身图，位置应当完全一致');
  assert.ok(distinct.size >= 8, `只有 ${distinct.size} 组不同的发饰位置，看起来是照抄的`);
});

test('某一帧量不到的那一枚必须记进 degraded（不能静默少画一枚 logo）', () => {
  for (const name of actions) {
    for (const slot of logoSlots) {
      if (logo.manifest.placements[name]?.[slot]) continue;
      assert.ok(
        logo.manifest.degraded.some((d) => d.name === `logo.${slot}.${name}`),
        `${name} 的 ${slot} 没有 placement 也没有 degraded 记录 —— 这是个静默的缺失`,
      );
    }
  }
  for (const d of logo.manifest.degraded) {
    assert.ok(d.reason.length > 5, `${d.name} 的降级原因太短：${d.reason}`);
  }
});

test('placement 落在画布内', () => {
  const { width, height } = logo.manifest.canvas;
  for (const name of actions) {
    for (const slot of logoSlots) {
      const p = logo.manifest.placements[name]?.[slot];
      if (!p) continue;
      const r = p.size / 2;
      assert.ok(p.cx - r >= 0 && p.cx + r <= width, `${name}.${slot} 横向越界`);
      assert.ok(p.cy - r >= 0 && p.cy + r <= height, `${name}.${slot} 纵向越界`);
    }
  }
});

test('整脸 sprite 表情的徽章位置与 idle 一致（实测过，所以运行期沿用 idle 帧）', () => {
  // 整脸图是满画幅的，会连身体一起盖掉，所以它们自带的假徽章在哪必须被量过。
  // 流水线里有断言（超过 1.5 px 就报错），这里检查那份实测记录真的存在且确实一致 ——
  // 否则「沿用 idle 帧」就是假设而不是结论。
  const sprites = (logo.manifest.measured?.spriteExpressions ?? {}) as Record<
    string,
    { found: Record<string, { center: [number, number] }> }
  >;
  const idle = logo.manifest.placements.idle!;
  const spriteNames = expressions.filter((e) => manifest.expressions[e]!.mode === 'sprite');
  assert.ok(spriteNames.length > 0, '一个整脸 sprite 都没有？那 rig.json 变了');
  for (const name of spriteNames) {
    const rec = sprites[name];
    assert.ok(rec, `整脸表情 ${name} 没有徽章实测记录`);
    for (const slot of logoSlots) {
      const got = rec.found[slot];
      const want = idle[slot];
      if (!got || !want) continue;
      const d = Math.hypot(got.center[0] - want.cx, got.center[1] - want.cy);
      assert.ok(d <= 1.5, `${name}.${slot} 的徽章与 idle 差 ${d.toFixed(2)} px，不该沿用 idle 帧`);
    }
  }
});

test('logo 的来源可追溯：源 SVG 在仓库里、sha256 对得上、留了原始文件出处', () => {
  const svg = path.join(rigDir, logo.manifest.source.svg);
  assert.ok(existsSync(svg), `源 SVG ${logo.manifest.source.svg} 不在仓库里`);
  assert.equal(
    createHash('sha256').update(readFileSync(svg)).digest('hex'),
    logo.manifest.source.svgSha256,
    '源 SVG 被改过但 logo.json 没重建',
  );
  const text = readFileSync(svg, 'utf8');
  // 必须只剩图标那一条 path —— "StepFun" 字样有 7 条，留着就说明抽取没做干净。
  assert.equal((text.match(/<path\b/g) ?? []).length, 1, '源 SVG 里不止一条 path');
  assert.match(logo.manifest.source.origin, /sha256=[0-9a-f]{64}/, '没记录原始文件的 sha256');
  assert.match(logo.manifest.source.origin, /path=1\/8/, '没记录「取第 1 条、共 8 条」');
});

test('栅格化产物与真 SVG 渲染器形状一致（深层错判 ≈ 0）', () => {
  const f = logo.manifest.source.fidelity;
  // null 表示本机没有可用的 SVG 渲染器。允许，但必须显式为 null（「没比过」要可见）。
  if (f === null) return;
  assert.ok(f.iou > 0.95, `与 SVG 渲染器的 IoU 只有 ${f.iou}`);
  // 总差异里绝大部分是 1 px 的抗锯齿边；真正说明形状画错的是深层错判。
  assert.ok(
    f.deepMismatchPixels < f.mismatchPixels * 0.1,
    `深层错判 ${f.deepMismatchPixels} px 占总差异 ${f.mismatchPixels} px 太多 —— 形状可能真的不一样`,
  );
});

test('logo 贴图没有淡光晕，且有真正不透明的像素', () => {
  const alpha = pngAlpha(path.join(rigDir, logo.manifest.asset.file));
  let halo = 0;
  let full = 0;
  for (const v of alpha) {
    if (v > 0 && v < 16) halo += 1;
    if (v === 255) full += 1;
  }
  assert.equal(halo, 0, `logo 还有 ${halo} 个 a<16 的光晕像素`);
  assert.ok(full > 0, 'logo 一个 alpha=255 的像素都没有');
});

test('logo 的阶梯方块是不透明的，不是镂空 —— 镂空会漏出下面的假徽章', () => {
  // 圆心附近（阶梯方块所在区域）必须全不透明。只检查内切正方形，避开圆的边缘。
  const { width } = logo.manifest.asset;
  const alpha = pngAlpha(path.join(rigDir, logo.manifest.asset.file));
  const lo = Math.round(width * 0.25);
  const hi = Math.round(width * 0.75);
  let transparent = 0;
  for (let y = lo; y < hi; y++) {
    for (let x = lo; x < hi; x++) if (alpha[y * width + x] < 255) transparent += 1;
  }
  assert.equal(transparent, 0, `圆盘内部有 ${transparent} 个非不透明像素 —— 阶梯是镂空的`);
});

test('logo 的运行期副本已同步到 vite 的 public 目录', () => {
  const pub = path.join(root, 'apps/web/public/rig');
  assert.ok(existsSync(path.join(pub, 'logo.json')), 'public/rig 下缺 logo.json —— 跑 npm run sync-rig');
  assert.ok(
    existsSync(path.join(pub, logo.manifest.asset.file)),
    `public/rig 下缺 ${logo.manifest.asset.file}`,
  );
  // 源 SVG 不该进构建产物：它是生成源头的留痕，运行期用不到。
  assert.ok(
    !existsSync(path.join(pub, logo.manifest.source.svg)),
    '源 SVG 被同步进了 public —— 它只是留痕，不该进构建产物',
  );
});

// ---------------------------------------------------------------------------
// 逐姿势命中区（sidecar 清单 hitregions.json，见 apps/web/src/pet/poseRegions.ts）
//
// 这份数据修的是「睡觉姿势下鼠标完全选不中她」：命中判定在 Rust 侧用一份归一化矩形表，
// 而那份表原来是按 idle 立姿量的，sleep 侧躺时一个矩形都命中不到 → 窗口保持穿透。
// 所以这组测试的重点只有一个 —— **任何姿势都不能出现「零命中区」**。
// ---------------------------------------------------------------------------

const hitPath = path.join(rigDir, 'hitregions.json');
const hit = parsePoseRegions(JSON.parse(readFileSync(hitPath, 'utf8')));

test('每个动作都有命中区，且一定带整身兜底框（这是「点不中」的最后一道防线）', () => {
  for (const name of actions) {
    const list = hit.regionsFor(name);
    assert.ok(list.length >= 1, `动作 ${name} 一个命中矩形都没有 —— 这就是 sleep 那个 bug`);
    const body = list.filter((r) => r.part === 'body');
    assert.equal(body.length, 1, `动作 ${name} 应该正好有一个整身兜底框，实际 ${body.length} 个`);
    // 兜底框必须排在最后：顺序即优先级，排前面会把所有细分部位吃掉。
    assert.equal(list[list.length - 1].part, 'body', `${name} 的兜底框不在最后`);
  }
});

test('兜底框足够大：包住画幅中心，且不比角色自己的外接框小', () => {
  const measured = (hit.manifest.measured?.poses ?? {}) as Record<
    string,
    { bodyBox: [number, number, number, number] }
  >;
  const side = manifest.canvas.width;
  for (const name of actions) {
    const body = hit.regionsFor(name).find((r) => r.part === 'body')!;
    assert.ok(
      body.x0 < 0.5 && body.x1 > 0.5,
      `${name} 的兜底框横向不含中心（${body.x0}–${body.x1}）—— 点身体中线都可能落空`,
    );
    const m = measured[name];
    if (!m) continue;
    // 实测的 alpha 外接框必须落在兜底框里（允许 1 px 的取整误差）。
    const eps = 1 / side;
    assert.ok(body.x0 <= m.bodyBox[0] / side + eps, `${name} 兜底框左边切掉了角色`);
    assert.ok(body.y0 <= m.bodyBox[1] / side + eps, `${name} 兜底框上边切掉了角色`);
    assert.ok(body.x1 >= m.bodyBox[2] / side - eps, `${name} 兜底框右边切掉了角色`);
    assert.ok(body.y1 >= m.bodyBox[3] / side - eps, `${name} 兜底框下边切掉了角色`);
  }
});

test('命中矩形都是非空的、落在 0..1 内，且小目标大到点得中', () => {
  // 0.055 × 300 px 的显示高度 ≈ 16 px。比这还小的矩形在实际桌宠尺寸下点不中，
  // 等于白写一条（流水线里按 MIN_TAPPABLE=0.08 外扩，这里留了余量）。
  const minSide = 0.055;
  for (const name of actions) {
    for (const r of hit.regionsFor(name)) {
      assert.ok(r.x1 > r.x0 && r.y1 > r.y0, `${name}.${r.part} 是空矩形`);
      for (const v of [r.x0, r.y0, r.x1, r.y1]) {
        assert.ok(v >= 0 && v <= 1, `${name}.${r.part} 越界：${v}`);
      }
      assert.ok(
        r.x1 - r.x0 >= minSide && r.y1 - r.y0 >= minSide,
        `${name}.${r.part} 太小（${(r.x1 - r.x0).toFixed(3)}×${(r.y1 - r.y0).toFixed(3)}），点不中`,
      );
    }
  }
});

test('命中区的部位名都是前端认得的，且顺序把小目标排在大目标前面', () => {
  // 'badge' 落在 'head' 矩形内部，排后面就永远摸不到（原手工表的注释里就写着这件事）。
  const rank = ['badge', 'cheek', 'hand', 'head', 'skirt', 'body'];
  for (const name of actions) {
    const list = hit.regionsFor(name);
    let last = -1;
    for (const r of list) {
      const i = rank.indexOf(r.part);
      assert.ok(i >= 0, `${name} 里出现了未知部位名 ${r.part}`);
      assert.ok(i >= last, `${name} 的部位顺序不对：${r.part} 排在了更大的目标后面`);
      last = i;
    }
  }
});

test('逐姿势命中区确实各不相同 —— 不是把 idle 那份抄了 10 遍', () => {
  const key = (n: (typeof actions)[number]) =>
    hit
      .regionsFor(n)
      .map((r) => `${r.part}:${r.x0.toFixed(3)},${r.y0.toFixed(3)}`)
      .join('|');
  const distinct = new Set(actions.map(key));
  assert.equal(key('tilt'), key('idle'), 'tilt 用的就是 idle 的整身图，命中区应当完全一致');
  assert.ok(distinct.size >= 8, `只有 ${distinct.size} 组不同的命中区，看起来是照抄的`);
  // sleep 是这次要修的那一帧：它的头部矩形必须真的落在侧躺的头上，而不是 idle 的头顶位置。
  const sleepHead = hit.regionsFor('sleep').find((r) => r.part === 'head')!;
  const idleHead = hit.regionsFor('idle').find((r) => r.part === 'head')!;
  assert.ok(
    Math.abs(sleepHead.y0 - idleHead.y0) > 0.1,
    'sleep 的头部矩形还在 idle 的位置上 —— 侧躺时它不在那儿',
  );
});

test('命中区清单的运行期副本已同步到 vite 的 public 目录', () => {
  assert.ok(
    existsSync(path.join(root, 'apps/web/public/rig/hitregions.json')),
    'public/rig 下缺 hitregions.json —— 跑 npm run sync-rig',
  );
});

