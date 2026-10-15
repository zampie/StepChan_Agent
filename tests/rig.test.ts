import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BlinkScheduler,
  HoldTimer,
  ShuffleBag,
  Spring,
  VisemeTracker,
  audioVisemeLadder,
  breathe,
  crossfadeMs,
  easeInOut,
  fullBodyFallback,
  fxPose,
  listenFeel,
  listenPose,
  logoUrlFor,
  minHoldMs,
  parsePoseRegions,
  poseRegionsUrlFor,
  resolveBaseUrl,
  silenceFloor,
  squash,
  sway,
  tapActionHoldMs,
  tapExpressionHoldMs,
  tapPools,
  tapTargetOf,
  tapTargets,
  type PoseRegion,
  type TapReaction,
} from '../apps/web/src/pet';
import type { HitRegion } from '../shared/desktop';
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

test('poseRegionsUrlFor 把 rig.json 换成同目录的 hitregions.json', () => {
  assert.equal(poseRegionsUrlFor('/rig/rig.json'), '/rig/hitregions.json');
  assert.equal(poseRegionsUrlFor('rig.json'), 'hitregions.json');
});

// ---------------------------------------------------------------------------
// 按住聆听的持续状态
//
// Pixi 在这个环境里跑不起来（没有 GUI），所以**手感没有被验证过**。
// 这里验证的是它背后的数学：没按住时必须完全中性、按住时标记必须「一直看得见」
// （这正是「持续状态」与「一次性特效」的分界）、各项有界、reduceMotion 下是静态的。
// ---------------------------------------------------------------------------

test('没按住时聆听姿态完全中性（不转、标记不显示）', () => {
  for (const t of [0, 250, 1700, 9999]) {
    const p = listenPose(t, 0);
    assert.deepEqual(p, { rotation: 0, markScale: 0, markAlpha: 0 }, `t=${t} 不该有任何表现`);
  }
});

test('按住期间标记始终可见 —— 脉动有下限，不会像 FX 那样淡出到 0', () => {
  let min = Infinity;
  let max = -Infinity;
  for (let t = 0; t < 12000; t += 17) {
    const p = listenPose(t, 1);
    min = Math.min(min, p.markAlpha);
    max = Math.max(max, p.markAlpha);
    assert.ok(p.markScale > 0, '标记不该缩到 0');
  }
  assert.ok(min >= listenFeel.markAlphaMin - 1e-9, `标记最低透明度 ${min}，掉到下限以下了`);
  assert.ok(min > 0.3, '下限太低，按住时会看起来像在闪');
  assert.ok(max <= 1 + 1e-9);
  // 必须真的在脉动，否则「呼吸式」只是说法。
  assert.ok(max - min > 0.1, `透明度只变化了 ${max - min}，看不出脉动`);
  // FX 的生命周期是会结束的，聆听状态不会 —— 这条断言把两者的区别钉死。
  assert.equal(fxPose(2000, 1400).done, true);
});

test('聆听侧倾方向恒定、幅度有界（是姿势，不是左右摇）', () => {
  let min = Infinity;
  let max = -Infinity;
  for (let t = 0; t < 12000; t += 17) {
    const r = listenPose(t, 1).rotation;
    min = Math.min(min, r);
    max = Math.max(max, r);
  }
  assert.ok(min > 0, `侧倾出现了反向（最小 ${min}）—— 那是摇头不是侧耳`);
  assert.ok(max <= listenFeel.lean + listenFeel.nodAmplitude + 1e-9);
  // 要比闲置摇摆明显大一个量级，否则和 idle 分不开。
  let swayPeak = 0;
  for (let t = 0; t < 60000; t += 50) swayPeak = Math.max(swayPeak, Math.abs(sway(t)));
  assert.ok(min > swayPeak * 2, `侧倾 ${min} 没比闲置摇摆峰值 ${swayPeak} 大出一截，看不出区别`);
});

test('聆听的进入/退出是插值的（amount 乘在所有项上）', () => {
  const half = listenPose(0, 0.5);
  const full = listenPose(0, 1);
  assert.ok(Math.abs(half.rotation - full.rotation / 2) < 1e-9, '侧倾没按 amount 插值');
  assert.ok(Math.abs(half.markAlpha - full.markAlpha / 2) < 1e-9, '标记没按 amount 淡出');
  // 越界输入被夹住，不会把姿态算飞。
  assert.deepEqual(listenPose(0, 9), full);
  assert.deepEqual(listenPose(0, -3), { rotation: 0, markScale: 0, markAlpha: 0 });
});

test('reduceMotion 下聆听退化为静态：姿势与标记都在，但不随时间变', () => {
  const a = listenPose(0, 1, false);
  const b = listenPose(733, 1, false);
  const c = listenPose(5219, 1, false);
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
  assert.ok(a.rotation > 0, 'reduceMotion 下侧倾仍要保留 —— 它是姿势，不是动效');
  assert.ok(a.markAlpha > 0.3, 'reduceMotion 下标记要常驻可见');
});

// ---------------------------------------------------------------------------
// 命中区兜底
// ---------------------------------------------------------------------------

test('整身兜底框是个非空矩形，且把画幅中心包进去', () => {
  const r = fullBodyFallback();
  assert.equal(r.part, 'body');
  assert.ok(r.x1 > r.x0 && r.y1 > r.y0, '兜底框不能是空矩形');
  assert.ok(r.x0 < 0.5 && r.x1 > 0.5 && r.y0 < 0.5 && r.y1 > 0.5, '兜底框必须覆盖画幅中心');
  for (const v of [r.x0, r.y0, r.x1, r.y1]) assert.ok(v >= 0 && v <= 1, '越界');
});

test('PoseRegion 与 shared 的 HitRegion 结构兼容（可以直接喂 setHitRegions）', () => {
  // 这是一条**编译期**断言：pet/ 刻意不 import shared/desktop.ts（渲染层不该知道
  // 桌面能力的存在），所以两边漂移只能靠这里挡。赋值不过就是 tsc 报错。
  const region: PoseRegion = fullBodyFallback();
  const asHit: HitRegion = region;
  const back: PoseRegion = asHit;
  assert.equal(back.part, 'body');
});

test('parsePoseRegions 拒绝没有整身兜底框 / 空矩形的清单', () => {
  const full = (part: string) => ({ part, x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.9 });
  const poses = Object.fromEntries(actions.map((a) => [a, [full('body')]]));
  assert.ok(parsePoseRegions({ version: '1', poses, degraded: [] }));
  // 缺兜底框 —— 这正是「某个姿势点不中」的那个 bug，必须在加载时就炸。
  assert.throws(
    () => parsePoseRegions({ version: '1', poses: { ...poses, sleep: [full('head')] }, degraded: [] }),
    /没有整身兜底框/,
  );
  assert.throws(
    () =>
      parsePoseRegions({
        version: '1',
        poses: { ...poses, sleep: [{ part: 'body', x0: 0.5, y0: 0.1, x1: 0.5, y1: 0.9 }] },
        degraded: [],
      }),
    /空矩形/,
  );
  // 少一个动作也必须炸：漏掉的那个姿势在运行时就是「点不中」。
  const { walk_b: _omitted, ...missing } = poses;
  assert.throws(() => parsePoseRegions({ version: '1', poses: missing, degraded: [] }), /walk_b/);
});

test('清单里没有某个动作时 regionsFor 返回兜底框，不返回空数组', () => {
  const poses = Object.fromEntries(
    actions.map((a) => [a, [{ part: 'body', x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.9 }]]),
  );
  const loaded = parsePoseRegions({ version: '1', poses, degraded: [] });
  for (const a of actions) assert.ok(loaded.regionsFor(a).length >= 1, `${a} 的命中区是空的`);
  // 契约外的动作名（以后加了枚举但清单没重跑）也要有东西兜住。
  const unknown = loaded.regionsFor('not_an_action' as (typeof actions)[number]);
  assert.deepEqual(unknown, [fullBodyFallback()]);
});

// ---------------------------------------------------------------------------
// 拖动：原来这里有七条「抓娃娃机」手感的数学断言（站地时中性、支点搬到头顶、
// 体积守恒、摆幅/切变有界、落地回弹先压后弹、摆幅不超窗口宽度预算）。
//
// 整组删掉了，因为那套表现被整个删掉了 —— 用户看过实际效果后要求「拖动时不做任何动作」。
// 留着测一个不存在的功能只会让人以为它还在。详见 motion.ts 里的说明。
// 现在和拖动有关的唯一约定是「setDragging 不产生任何姿态变化」，
// 而那是一个空函数，没有可测的数学。
// ---------------------------------------------------------------------------

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
  // 整身兜底框的部位名也要能落到 default 组 —— 否则换姿势后点在身上会一点反应都没有。
  assert.equal(tapTargetOf(fullBodyFallback().part), 'default');
});

test('单击表情的保持时长比动作长，且落在「看得清又不会一直挂着」的区间', () => {
  // 表情要比动作挂得久：动作是整身姿势一眼看完，表情在 220 px 下只有十几像素的五官。
  assert.ok(
    tapExpressionHoldMs > tapActionHoldMs,
    `表情 ${tapExpressionHoldMs}ms 不比动作 ${tapActionHoldMs}ms 长，看不清就塌回去了`,
  );
  assert.ok(tapExpressionHoldMs >= 2000, '短于 2 s 的话用户还没把视线移到脸上就恢复了');
  assert.ok(tapExpressionHoldMs <= 6000, '长于 6 s 等于「一直挂着」，会和她说话时的真实情绪打架');
  // 必须远大于交叉淡入时长，否则表情还没淡完就开始倒计时回位。
  assert.ok(tapExpressionHoldMs > crossfadeMs * 4);
});

// ---------------------------------------------------------------------------
// 自动恢复的倒计时
//
// 这里测的是一条**产品规则**：点击引起的临时表情会自动回 neutral，
// 而模型通过 express 工具设的表情不会 —— 实现上就是「模型路径 cancel()、点击路径 arm()」。
// 渲染器本身要 Pixi 才能跑（这个环境没有 GUI），所以把这条规则做成了可单测的 HoldTimer。
// ---------------------------------------------------------------------------

test('倒计时到点只触发一次，之后保持静默', () => {
  const t = new HoldTimer();
  t.arm(100);
  assert.equal(t.pending, true);
  assert.equal(t.tick(60), false, '没到点就触发了');
  assert.equal(t.tick(60), true, '到点了没触发');
  assert.equal(t.pending, false);
  assert.equal(t.tick(60), false, '到点后又触发了一次 —— 表情会被反复按回 neutral');
  assert.equal(t.remaining, 0);
});

test('cancel 之后永远不会到点 —— 模型设的表情不该被自动抹掉', () => {
  const t = new HoldTimer();
  t.arm(tapExpressionHoldMs);
  // 模型通过 express 工具设了新表情 → setExpression() → cancel()。
  t.cancel();
  let fired = false;
  for (let i = 0; i < 1000; i++) fired = fired || t.tick(16);
  assert.equal(fired, false, '模型设的表情在几秒后被自动恢复抹掉了');
});

test('重新 arm 会刷新倒计时（连点两次以最后一次为准）', () => {
  const t = new HoldTimer();
  t.arm(100);
  t.tick(90);
  t.arm(100); // 又点了一下
  assert.equal(t.tick(90), false, '第二次点击没有刷新倒计时');
  assert.equal(t.tick(20), true);
});

test('没 arm 过的倒计时不会凭空触发；arm(0) 等于取消', () => {
  const t = new HoldTimer();
  for (let i = 0; i < 100; i++) assert.equal(t.tick(16), false);
  t.arm(0);
  assert.equal(t.pending, false);
  assert.equal(t.tick(16), false);
  t.arm(-5);
  assert.equal(t.tick(16), false);
});

test('一次超长帧（切回标签页）只补一次回位，不会攒出一串', () => {
  const t = new HoldTimer();
  t.arm(tapExpressionHoldMs);
  assert.equal(t.tick(600000), true, '超长帧应该直接到点');
  assert.equal(t.tick(600000), false, '到点后又触发了');
});

// 原来这里还有一条「摆角上限不会把脚甩出窗口」的几何预算断言，守的是 clawFeel.swingMax。
// 参数和表现一起删了，所以断言也删了。现在角色的旋转只有 tilt（0.22 rad）和聆听侧倾
// （0.13 rad），两者支点都在脚底 —— 绕脚底转不会把脚甩出窗口，没有需要守的预算。

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
