import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BlinkScheduler,
  ShuffleBag,
  Spring,
  VisemeTracker,
  audioVisemeLadder,
  breathe,
  clawFeel,
  clawPose,
  crossfadeMs,
  easeInOut,
  fxPose,
  logoUrlFor,
  minHoldMs,
  resolveBaseUrl,
  sagTarget,
  silenceFloor,
  squash,
  sway,
  swingTarget,
  tapPools,
  tapTargetOf,
  tapTargets,
  type TapReaction,
} from '../apps/web/src/pet';
import {
  actions,
  expressions,
  fxNames,
  touchParts,
  type EyeState,
  type Viseme,
} from '../shared/pet';

// ---------------------------------------------------------------------------
// 口型映射。这是整条语音链路里唯一「主观感受」能被量化成单测的地方：
// 嘴抖不抖 = 同一段电平序列下口型切了几次。
// ---------------------------------------------------------------------------

test('viseme ladder 是单调的，且上行阈值严格高于下行阈值（滞回带非空）', () => {
  for (let i = 1; i < audioVisemeLadder.length; i++) {
    assert.ok(
      audioVisemeLadder[i].up > audioVisemeLadder[i - 1].up,
      `第 ${i} 档的 up 必须高于上一档`,
    );
    assert.ok(audioVisemeLadder[i].up > audioVisemeLadder[i].down, `第 ${i} 档必须有滞回带`);
  }
  assert.equal(audioVisemeLadder[0].viseme, 'closed');
});

test('静音与 null 都闭嘴', () => {
  const t = new VisemeTracker();
  assert.equal(t.update(null, 0), 'closed');
  assert.equal(t.update(0, 16), 'closed');
  assert.equal(t.update(silenceFloor / 2, 32), 'closed');
});

test('电平上行会张嘴，且起音不被最短保持时间拖延', () => {
  const t = new VisemeTracker();
  // 升档不等 minHold —— 连续两帧（32ms，短于 minHoldMs）就应该一路升上去。
  let v: Viseme = t.update(0.9, 0);
  v = t.update(0.9, 16);
  v = t.update(0.9, 32);
  v = t.update(0.9, 48);
  assert.equal(v, 'wide');
});

test('滞回：在阈值上反复横跳时口型不抖', () => {
  const t = new VisemeTracker();
  let now = 0;
  for (let i = 0; i < 12; i++) t.update(0.3, (now += 16)); // 先稳定在 medium 以上
  const stable = t.viseme;
  let switches = 0;
  let last = stable;
  // 在 medium 的 up 阈值（0.2）两侧 ±0.01 来回抖 40 帧。
  for (let i = 0; i < 40; i++) {
    const v = t.update(i % 2 === 0 ? 0.19 : 0.21, (now += 16));
    if (v !== last) {
      switches += 1;
      last = v;
    }
  }
  // 没有滞回的实现会在这里切 ~40 次。允许一次（从 stable 收敛到抖动带内的档位）。
  assert.ok(switches <= 1, `阈值附近抖动导致 ${switches} 次口型切换，滞回没生效`);
});

test('下行每帧最多掉一档，且掉档之间要等过最短保持时间', () => {
  const t = new VisemeTracker();
  let now = 0;
  const feed = (level: number): Viseme => t.update(level, (now += 16));
  for (let i = 0; i < 12; i++) feed(0.9);
  // 显式写出类型参数：assert.equal 的 `asserts actual is T` 否则会把 t.viseme 永久窄化成 'wide'，
  // 后面的 !== 'closed' 就成了「类型无交集」的编译错误。
  assert.equal<Viseme>(t.viseme, 'wide');

  // 音频骤停。嘴应该收，但不能一帧从 wide 直接闭上 —— 那是「咔」一下，不是闭嘴。
  assert.notEqual(feed(0), 'closed', '一帧就从 wide 闭到底了');

  // 之后每帧都喂静音，统计走到 closed 需要多久。
  const start = now;
  while (t.viseme !== 'closed' && now - start < 1000) feed(0);
  const elapsed = now - start;
  assert.equal<Viseme>(t.viseme, 'closed');
  // wide→medium→small→closed 共 3 档，中间两次掉档各要等 minHoldMs。
  assert.ok(elapsed >= minHoldMs, `从 wide 收到 closed 只用了 ${elapsed}ms，滞回没起作用`);
  assert.ok(elapsed < 600, `从 wide 收到 closed 用了 ${elapsed}ms，闭嘴太慢会拖在句尾`);
});

test('电平越界与 NaN 被夹住，不会把档位算飞', () => {
  const t = new VisemeTracker();
  assert.equal(t.update(NaN, 0), 'closed');
  t.update(99, 16);
  t.update(99, 32);
  t.update(99, 48);
  t.update(99, 64);
  assert.equal(t.viseme, 'wide');
  const t2 = new VisemeTracker();
  assert.equal(t2.update(-5, 0), 'closed');
});

test("'round' 与 'smile' 不在音频阶梯里（单一 RMS 推不出元音形状）", () => {
  const driven = audioVisemeLadder.map((l) => l.viseme as Viseme);
  assert.ok(!driven.includes('round'));
  assert.ok(!driven.includes('smile'));
});

// ---------------------------------------------------------------------------
// 眨眼调度
// ---------------------------------------------------------------------------

/** 把逐帧输出压成状态变化序列 —— 眨眼要断言的是「经过了哪些状态」，不是每个状态占几帧。 */
function runLengthEncode<T>(frames: T[]): T[] {
  return frames.filter((v, i) => i === 0 || v !== frames[i - 1]);
}

test('眨眼走完 open→half→closed→half→open，不直接跳 closed', () => {
  const b = new BlinkScheduler({
    minIntervalMs: 100,
    maxIntervalMs: 100,
    doubleChance: 0,
    random: () => 0.9,
  });
  const frames: (EyeState | null)[] = [];
  for (let i = 0; i < 60; i++) frames.push(b.update(10));
  const seq = runLengthEncode(frames);
  // null 代表「用表情自己的眼型」，也就是 open。完整时序必须是 open→half→closed→half→open。
  assert.deepEqual(seq.slice(0, 5), [null, 'half', 'closed', 'half', null]);
});

test('眨眼之间返回 null（表情自己的眼型说话）', () => {
  const b = new BlinkScheduler({ minIntervalMs: 1000, maxIntervalMs: 1000, random: () => 0.9 });
  for (let i = 0; i < 50; i++) assert.equal(b.update(10), null, '还没到间隔就眨眼了');
});

test('doubleChance=1 时连眨两次（两段闭眼之间只回到 half，不回到 open）', () => {
  const b = new BlinkScheduler({
    minIntervalMs: 50,
    maxIntervalMs: 50,
    doubleChance: 1,
    random: () => 0,
  });
  const frames: (EyeState | null)[] = [];
  for (let i = 0; i < 40; i++) frames.push(b.update(10));
  const seq = runLengthEncode(frames);
  const closedBursts = seq.filter((s) => s === 'closed').length;
  assert.ok(closedBursts >= 2, `只闭眼 ${closedBursts} 次，连眨没生效`);
  // 连眨中间不应该回到 null（睁开）—— 那就是两次独立的眨眼了。
  const first = seq.indexOf('closed');
  const second = seq.indexOf('closed', first + 1);
  assert.ok(!seq.slice(first, second).includes(null), '连眨中间睁开了');
});

test('trigger 立刻眨眼；reset 回到等待', () => {
  const b = new BlinkScheduler({ minIntervalMs: 9e9, maxIntervalMs: 9e9, random: () => 0 });
  assert.equal(b.update(16), null);
  b.trigger();
  assert.equal(b.update(16), 'half');
  b.reset();
  assert.equal(b.update(16), null);
});

test('超长 dt（切回标签页）不会把眨眼卡在闭眼上', () => {
  const b = new BlinkScheduler({ minIntervalMs: 10, maxIntervalMs: 10, doubleChance: 0, random: () => 0.9 });
  assert.equal(b.update(5000), null, '一次超长帧应该把整个眨眼走完并回到等待');
});

// ---------------------------------------------------------------------------
// 程序化动画的数学性质
// ---------------------------------------------------------------------------

test('呼吸是体积守恒的小幅缩放，且围绕 1 振荡', () => {
  let min = Infinity;
  let max = -Infinity;
  for (let t = 0; t < 8000; t += 25) {
    const b = breathe(t);
    min = Math.min(min, b.scaleY);
    max = Math.max(max, b.scaleY);
    // 竖向拉长时横向必须收窄，否则看起来是整体放大而不是呼吸。
    assert.ok((b.scaleY - 1) * (b.scaleX - 1) <= 1e-12);
  }
  assert.ok(max - min < 0.05, `呼吸幅度 ${max - min} 太大`);
  assert.ok(max > 1 && min < 1);
});

test('摇摆幅度有界且无直流偏置', () => {
  let sum = 0;
  let n = 0;
  let peak = 0;
  for (let t = 0; t < 120000; t += 50) {
    const s = sway(t);
    sum += s;
    n += 1;
    peak = Math.max(peak, Math.abs(s));
  }
  assert.ok(peak < 0.05, `摇摆峰值 ${peak} 太大`);
  assert.ok(Math.abs(sum / n) < 0.004, '摇摆有直流偏置，角色会站歪');
});

test('挤压拉伸体积守恒方向正确且被夹住', () => {
  const s = squash(0.2);
  assert.ok(s.scaleY > 1 && s.scaleX < 1);
  assert.deepEqual(squash(10), squash(0.35), '超量输入必须被夹住');
  assert.deepEqual(squash(0), { scaleX: 1, scaleY: 1 });
});

test('弹簧收敛，且超长 dt 不发散', () => {
  const s = new Spring();
  for (let i = 0; i < 400; i++) s.step(1, 1 / 60);
  assert.ok(Math.abs(s.value - 1) < 0.01, `弹簧没收敛：${s.value}`);
  const s2 = new Spring();
  s2.step(1, 0.5); // 半秒的巨大步长
  assert.ok(Number.isFinite(s2.value) && Math.abs(s2.value) < 10, `弹簧发散：${s2.value}`);
});

test('easeInOut 被夹在 0..1 且端点正确', () => {
  assert.equal(easeInOut(0), 0);
  assert.equal(easeInOut(1), 1);
  assert.equal(easeInOut(-3), 0);
  assert.equal(easeInOut(7), 1);
  assert.ok(easeInOut(0.5) > 0.49 && easeInOut(0.5) < 0.51);
});

test('FX 生命周期：淡入、上浮、结束时 done', () => {
  const life = 1000;
  assert.ok(fxPose(0, life).alpha < 0.05);
  assert.ok(fxPose(300, life).alpha > 0.9);
  assert.ok(fxPose(300, life).y < 0, 'FX 应该往上浮');
  assert.ok(fxPose(999, life).alpha < 0.1);
  assert.equal(fxPose(1000, life).done, true);
  assert.equal(fxPose(500, life).done, false);
});

test('交叉淡入时长是 150ms', () => {
  assert.equal(crossfadeMs, 150);
});

test('resolveBaseUrl 从清单 URL 推出素材目录', () => {
  assert.equal(resolveBaseUrl('/assets/stepchan_q_v1/rig.json'), '/assets/stepchan_q_v1/');
  assert.equal(resolveBaseUrl('rig.json'), '');
});

test('logoUrlFor 把 rig.json 换成同目录的 logo.json', () => {
  assert.equal(logoUrlFor('/rig/rig.json'), '/rig/logo.json');
  assert.equal(logoUrlFor('rig.json'), 'logo.json');
});

// ---------------------------------------------------------------------------
// 抓娃娃机姿态
//
// Pixi 渲染器在这个环境里跑不起来（没有 GUI），所以**手感没有被验证过**。
// 这里能验证的是手感背后的数学：站地时必须完全中性、体积守恒、各项有界、
// 支点确实会从脚底搬到头顶。这些性质错了，手感一定错；它们对了，手感仍然要人眼看。
// ---------------------------------------------------------------------------

const REST = { lift: 0, swing: 0, lag: 0, sag: 0, rebound: 0 };

test('没被提起时抓娃娃机姿态完全中性（支点在脚底、无位移无切变无缩放）', () => {
  const p = clawPose(REST);
  assert.equal(p.pivotY, 1, '站着的支点必须是锚点（脚底）');
  assert.equal(p.riseFrac, 0);
  assert.equal(p.rotation, 0);
  assert.equal(p.skewX, 0);
  assert.deepEqual({ x: p.scaleX, y: p.scaleY }, { x: 1, y: 1 });
});

test('lift 把支点从脚底搬到头顶并抬升身体 —— 这是悬挂感的来源', () => {
  const up = clawPose({ ...REST, lift: 1 });
  assert.ok(Math.abs(up.pivotY - clawFeel.liftPivotY) < 1e-9, `支点 ${up.pivotY}`);
  assert.ok(up.pivotY < 0.2, `支点 ${up.pivotY} 不在画幅上部，旋转会读作「歪了」而不是「吊着」`);
  assert.ok(up.riseFrac < 0, '被提起时应该整体上移');
  // 中间状态必须是插值，不能是开关 —— 否则抓起/放下的瞬间会跳一帧。
  const mid = clawPose({ ...REST, lift: 0.5 });
  assert.ok(mid.pivotY > up.pivotY && mid.pivotY < 1, `支点没有插值：${mid.pivotY}`);
});

test('摆角、切变、下垂都乘在 lift 上 —— 放手后自动收回，不需要退出动画', () => {
  const input = { lift: 0, swing: 0.4, lag: 0, sag: clawFeel.sagMax, rebound: 0 };
  const grounded = clawPose(input);
  assert.equal(grounded.rotation, 0, 'lift=0 时不该有悬挂摆角');
  assert.equal(grounded.skewX, 0, 'lift=0 时不该有切变');
  assert.deepEqual({ x: grounded.scaleX, y: grounded.scaleY }, { x: 1, y: 1 }, 'lift=0 时不该有下垂');
  const lifted = clawPose({ ...input, lift: 1 });
  assert.ok(Math.abs(lifted.rotation) > 0.3);
  assert.ok(lifted.scaleY > 1 && lifted.scaleX < 1, '下垂必须是竖向拉长、横向收窄');
});

test('下半身滞后产生切变，切变有界且在同步时归零', () => {
  const synced = clawPose({ ...REST, lift: 1, swing: 0.3, lag: 0.3 });
  assert.equal(synced.skewX, 0, '上下身同步时不该有切变');
  const trailing = clawPose({ ...REST, lift: 1, swing: 0.4, lag: 0 });
  assert.ok(trailing.skewX > 0, '上身先动时下身应该拖在后面');
  const extreme = clawPose({ ...REST, lift: 1, swing: 99, lag: -99 });
  assert.equal(extreme.skewX, clawFeel.lagMax, '切变必须被夹住，否则身体会被撕开');
});

test('落地回弹是先压扁后拉长（squash 输入为负＝压扁）', () => {
  const land = clawPose({ ...REST, rebound: -clawFeel.landBounce });
  assert.ok(land.scaleY < 1 && land.scaleX > 1, '落地第一下必须是压扁');
  assert.ok(clawFeel.landVelocity > 0, '初速度必须为正，才能从压扁冲过 0 变成拉长');
});

test('抓娃娃机的缩放永远体积守恒（squash 的性质，不许被绕过）', () => {
  for (const lift of [0, 0.3, 1]) {
    for (const sag of [0, 0.05, 0.085]) {
      for (const rebound of [-0.26, 0, 0.2]) {
        const p = clawPose({ ...REST, lift, sag, rebound });
        assert.ok(
          Math.abs(p.scaleX - 1 + (p.scaleY - 1)) < 1e-12,
          `lift=${lift} sag=${sag} rebound=${rebound} 不是体积守恒：${p.scaleX} × ${p.scaleY}`,
        );
      }
    }
  }
});

test('摆角与下垂的速度映射被夹住，且方向与拖动相反', () => {
  assert.equal(swingTarget(0), 0);
  assert.ok(swingTarget(600) < 0, '往右拖时身体应该落在手的左后方');
  assert.equal(swingTarget(1e9), -clawFeel.swingMax);
  assert.equal(swingTarget(-1e9), clawFeel.swingMax);
  // 提着不动也该垂着 —— 只有速度驱动的话静止悬挂就完全没有重量感。
  assert.ok(sagTarget(0) > 0, '静止悬挂也要有底量下垂');
  assert.ok(sagTarget(5000) > sagTarget(0), '拽得越快垂得越长');
  assert.ok(sagTarget(1e9) <= clawFeel.sagMax + 1e-12, '下垂必须被夹住');
});

// ---------------------------------------------------------------------------
// 单击反应
// ---------------------------------------------------------------------------

test('洗牌袋：一轮内每项各出现一次', () => {
  const bag = new ShuffleBag(['a', 'b', 'c', 'd'], mulberry(7));
  const round = [bag.next(), bag.next(), bag.next(), bag.next()];
  assert.deepEqual([...round].sort(), ['a', 'b', 'c', 'd']);
});

test('洗牌袋：连续两次绝不重复（含跨轮的交界处）', () => {
  // 交界处是唯一会出错的地方：一轮取完重洗，新一轮的第一张可能正好是上一轮的最后一张。
  // 所以必须跑足够多轮，并且用多个种子 —— 单个种子可能恰好绕过那个分支。
  for (let seed = 1; seed <= 24; seed++) {
    const bag = new ShuffleBag(['a', 'b', 'c'], mulberry(seed));
    let prev = bag.next();
    for (let i = 0; i < 600; i++) {
      const cur = bag.next();
      assert.notEqual(cur, prev, `种子 ${seed} 第 ${i} 次连续重复：${cur}`);
      prev = cur;
    }
  }
});

test('洗牌袋：长跑下分布均匀（不是「固定顺序轮转」也不是偏向某一项）', () => {
  const bag = new ShuffleBag(['a', 'b', 'c', 'd'], mulberry(3));
  const count = new Map<string, number>();
  const pairs = new Set<string>();
  let prev = bag.next();
  for (let i = 0; i < 4000; i++) {
    const cur = bag.next();
    count.set(cur, (count.get(cur) ?? 0) + 1);
    pairs.add(`${prev}>${cur}`);
    prev = cur;
  }
  for (const [k, n] of count) assert.ok(n > 800 && n < 1200, `${k} 出现 ${n} 次，分布不均`);
  // 固定顺序轮转只会产生 4 种相邻对；洗牌袋应该覆盖除自反外的 12 种。
  assert.ok(pairs.size >= 10, `只出现了 ${pairs.size} 种相邻组合，看起来是固定顺序`);
});

test('洗牌袋：单元素必然重复（显式约定），空袋直接报错', () => {
  const one = new ShuffleBag(['only']);
  assert.equal(one.next(), 'only');
  assert.equal(one.next(), 'only');
  assert.throws(() => new ShuffleBag([]), /至少一个候选/);
});

test('每个 TouchPart 以及 skirt / default 都有自己的反应组，且各组 ≥3 条', () => {
  for (const part of touchParts) {
    assert.ok(tapPools[part], `缺少 ${part} 的反应组`);
  }
  for (const target of tapTargets) {
    const pool = tapPools[target];
    assert.ok(pool.length >= 3, `${target} 只有 ${pool.length} 条反应 —— 少于 3 条谈不上「不重复」`);
    const ids = new Set(pool.map((r) => r.id));
    assert.equal(ids.size, pool.length, `${target} 的反应 id 有重复`);
  }
});

test('反应只引用契约里存在的表情/动作/特效，且每条都至少改变一件事', () => {
  const ok = {
    expression: new Set<string>(expressions),
    action: new Set<string>(actions),
    fx: new Set<string>(fxNames),
  };
  for (const target of tapTargets) {
    for (const r of tapPools[target]) {
      if (r.expression) assert.ok(ok.expression.has(r.expression), `${r.id} 的表情不在契约里`);
      if (r.action) assert.ok(ok.action.has(r.action), `${r.id} 的动作不在契约里`);
      if (r.fx) assert.ok(ok.fx.has(r.fx), `${r.id} 的特效不在契约里`);
      const changes: (keyof TapReaction)[] = ['expression', 'action', 'fx', 'blink', 'poke'];
      assert.ok(
        changes.some((k) => r[k] !== undefined),
        `${r.id} 什么都不改 —— 点了没反应比没有这条反应更糟`,
      );
      // reduceMotion 下 blink / poke 会被跳过，所以不能有「只靠动效」的反应。
      assert.ok(
        r.expression || r.action || r.fx,
        `${r.id} 只有纯动效，reduceMotion 下点了毫无变化`,
      );
    }
  }
});

test('tapTargetOf 认得各部位，认不出的一律走 default（包括 null 与 "default" 自身）', () => {
  assert.equal(tapTargetOf('head'), 'head');
  assert.equal(tapTargetOf('skirt'), 'skirt');
  assert.equal(tapTargetOf('badge'), 'badge');
  assert.equal(tapTargetOf(null), 'default');
  assert.equal(tapTargetOf(undefined), 'default');
  assert.equal(tapTargetOf('elbow'), 'default');
  // 'default' 是内部组名，外部传进来也只应落到 default，不该被当成「某个部位」。
  assert.equal(tapTargetOf('default'), 'default');
});

test('摆角上限不会把脚甩出窗口（默认档位下的几何预算）', () => {
  // 支点在头顶 → 脚底横移 = sin(θ)·(1−liftPivotY)·canvasH·scale。
  // 默认档位：画布 512、显示高度 300（BASE_SIZE）、窗口宽 420（PET_WIDTH）、角色半宽约 88 px。
  // 这条断言是为了让「调大 swingMax」这件事必须同时面对窗口宽度，而不是悄悄超出去。
  const canvasH = 512;
  const scale = 300 / canvasH;
  const footShift = Math.sin(clawFeel.swingMax) * (1 - clawFeel.liftPivotY) * canvasH * scale;
  const budget = 420 / 2 - 88;
  assert.ok(
    footShift < budget,
    `摆到上限时脚底横移 ${footShift.toFixed(0)} px 超过窗口余量 ${budget} px —— 脚会被窗口裁掉`,
  );
});

/** 确定性 PRNG（mulberry32）。测试里不能用 Math.random —— 失败必须可复现。 */
function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
