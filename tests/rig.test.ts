import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Texture, TextureSource } from 'pixi.js';
import {
  BlinkScheduler,
  BreathPhase,
  HoldTimer,
  RigRenderer,
  ShuffleBag,
  Spring,
  VisemeTracker,
  ZzzEmitter,
  audioVisemeLadder,
  awakeBreath,
  breathe,
  breatheAt,
  crossfadeMs,
  easeInOut,
  fullBodyFallback,
  fxPose,
  listenFeel,
  listenPose,
  logoUrlFor,
  minHoldMs,
  parseLogoManifest,
  parsePoseRegions,
  poseRegionsUrlFor,
  resolveBaseUrl,
  silenceFloor,
  sleepExpression,
  sleepFeel,
  sleepPose,
  squash,
  sway,
  tapActionHoldMs,
  tapExpressionHoldMs,
  tapPools,
  tapTargetOf,
  tapTargets,
  zzzSpawn,
  type LoadedRig,
  type PoseRegion,
  type TapReaction,
} from '../apps/web/src/pet';
import type { HitRegion } from '../shared/desktop';
import {
  actions,
  expressions,
  fxNames,
  rigManifestSchema,
  touchParts,
  type ActionName,
  type EyeState,
  type RigManifest,
  type Viseme,
} from '../shared/pet';

// ---------------------------------------------------------------------------
// 真实清单。睡觉/zzz 的位置是从**实测的逐姿势几何**算出来的，
// 所以这里读真的 rig.json / hitregions.json / logo.json，不造假数据 ——
// 造出来的「头部框」没法暴露「zzz 冒在腰上方的空气里」这种错。
// ---------------------------------------------------------------------------
const rigDir = path.resolve(import.meta.dirname, '../assets/stepchan_q_v1');
const realManifest: RigManifest = rigManifestSchema.parse(
  JSON.parse(readFileSync(path.join(rigDir, 'rig.json'), 'utf8')),
);
const realRegions = parsePoseRegions(
  JSON.parse(readFileSync(path.join(rigDir, 'hitregions.json'), 'utf8')),
);
const realLogo = parseLogoManifest(
  JSON.parse(readFileSync(path.join(rigDir, 'logo.json'), 'utf8')),
);

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
// 睡觉：持续状态的数学与节拍
//
// 同样地，Pixi 跑不起来 → **手感（躺下的过渡、zzz 飘起来好不好看）未经验证**。
// 这里验证的是「睡觉是状态不是动作」在数学上的那几条：醒着时完全中性、
// 睡着时呼吸更慢更浅、摇摆被按到 0、reduceMotion 下仍有一枚常驻 zzz。
// 渲染器那一侧（姿势保持、zzz 真的周期性生成、命中区切到 sleep）在文件末尾另有一组。
// ---------------------------------------------------------------------------

test('醒着时睡觉姿态完全中性（呼吸就是清醒那套，摇摆照常，没有标记）', () => {
  const p = sleepPose(0);
  assert.equal(p.breathAmplitude, awakeBreath.amplitude);
  assert.equal(p.breathPeriodMs, awakeBreath.periodMs);
  assert.equal(p.swayScale, 1, '醒着时闲置摇摆必须照常');
  assert.equal(p.markAlpha, 0);
});

test('睡着时呼吸更慢更浅，而且仍然在呼吸 —— 不是把呼吸关掉', () => {
  const p = sleepPose(1);
  assert.ok(
    p.breathPeriodMs > awakeBreath.periodMs,
    `睡着的周期 ${p.breathPeriodMs}ms 不比清醒的 ${awakeBreath.periodMs}ms 长`,
  );
  assert.ok(p.breathAmplitude < awakeBreath.amplitude, '睡着的呼吸幅度没有变浅');
  assert.ok(p.breathAmplitude > 0, '呼吸被关掉了 —— 那看起来像死了，不是睡着了');
  // 换算成「次/分」看一眼是否落在生理范围：清醒静息 12–20，睡眠 10–16。
  const perMin = 60000 / p.breathPeriodMs;
  assert.ok(perMin >= 9 && perMin <= 16, `睡着时 ${perMin.toFixed(1)} 次/分，不像在睡觉`);
  assert.equal(p.swayScale, 0, '睡着时还在左右摇 —— 侧躺的人摇起来像在抽搐');
});

test('睡觉的进入/退出是插值的，越界被夹住', () => {
  const half = sleepPose(0.5);
  assert.ok(Math.abs(half.breathPeriodMs - (awakeBreath.periodMs + sleepFeel.breathPeriodMs) / 2) < 1e-9);
  assert.ok(Math.abs(half.swayScale - 0.5) < 1e-9, '摇摆没按 amount 渐隐');
  assert.deepEqual(sleepPose(9), sleepPose(1));
  assert.deepEqual(sleepPose(-3), sleepPose(0));
});

test('reduceMotion 下睡觉有一枚常驻静态 zzz —— 不是完全没有', () => {
  const r = sleepPose(1, false);
  assert.ok(r.markAlpha > 0.3, `reduceMotion 下 zzz 透明度只有 ${r.markAlpha}，看不出她在睡`);
  // 正常模式下这枚不显示：那时 zzz 是周期性生成的 FX，两者互斥，否则会有两个 zzz。
  assert.equal(sleepPose(1, true).markAlpha, 0, '正常模式下静态标记应当让位给周期性 zzz');
  // 乘在 amount 上，所以叫醒她的时候是淡出而不是突然不见。
  assert.ok(Math.abs(sleepPose(0.5, false).markAlpha - r.markAlpha / 2) < 1e-9);
  assert.equal(sleepPose(0, false).markAlpha, 0);
});

test('呼吸相位在周期改变时连续 —— 刚躺下那一帧不许「咯」一下', () => {
  // 直接用 sin(t/period) 的实现，在换周期的那一帧相位会跳。这里量的就是那个跳变。
  const ph = new BreathPhase();
  let prev = breatheAt(ph.value, awakeBreath.amplitude).scaleY;
  let worst = 0;
  for (let i = 0; i < 1200; i++) {
    // 第 100 帧开始一路插值到睡着，模拟弹簧。
    const amount = Math.min(1, Math.max(0, (i - 100) / 40));
    const sp = sleepPose(amount);
    const cur = breatheAt(ph.step(16, sp.breathPeriodMs), sp.breathAmplitude).scaleY;
    worst = Math.max(worst, Math.abs(cur - prev));
    prev = cur;
  }
  // 一帧（16ms）内 scaleY 的变化上限约 2π·16/3400·0.012 ≈ 3.5e-4，留一个量级的余量。
  assert.ok(worst < 2e-3, `单帧跳变 ${worst}，相位不连续`);
});

test('呼吸相位推进速率正确，且周期为 0 / 负数不会把相位算飞', () => {
  const ph = new BreathPhase();
  // 走满一个周期应当回到原点（允许取模误差）。
  for (let i = 0; i < 100; i++) ph.step(34, 3400);
  assert.ok(Math.min(ph.value, Math.PI * 2 - ph.value) < 1e-9, `一个周期后相位是 ${ph.value}`);
  const bad = new BreathPhase();
  bad.step(16, 0);
  bad.step(16, -5);
  assert.ok(Number.isFinite(bad.value), '周期为 0 把相位算成了 Infinity');
  // breathe(t) 必须和「相位累加」等价，否则两条路会给出不同的呼吸。
  const direct = breathe(1700);
  const viaPhase = breatheAt((1700 / awakeBreath.periodMs) * Math.PI * 2);
  assert.ok(Math.abs(direct.scaleY - viaPhase.scaleY) < 1e-12);
});

// ---- zzz 的节拍 ----

test('zzz 节拍器：停着的时候一个都不生成', () => {
  const e = new ZzzEmitter(sleepFeel, () => 0.5);
  let total = 0;
  for (let i = 0; i < 2000; i++) total += e.update(16);
  assert.equal(total, 0, '没在睡觉却冒 zzz 了');
});

test('zzz 节拍器：睡着后按 2~3 秒的节奏周期性生成，不是只冒一个', () => {
  const e = new ZzzEmitter(sleepFeel, mulberry(11));
  e.setActive(true);
  const at: number[] = [];
  let now = 0;
  while (now < 30000) {
    now += 16;
    if (e.update(16) > 0) at.push(now);
  }
  // 30 s 里按 2.5 s 一个应当是 11~12 个（首个延迟 0.7 s）。
  assert.ok(at.length >= 10 && at.length <= 13, `30 s 里只冒了 ${at.length} 个 zzz`);
  assert.ok(
    at[0] >= sleepFeel.zzzFirstDelayMs && at[0] <= sleepFeel.zzzFirstDelayMs + 32,
    `第一个 zzz 在 ${at[0]}ms，和约定的首延迟 ${sleepFeel.zzzFirstDelayMs}ms 不符`,
  );
  const gaps: number[] = [];
  for (let i = 1; i < at.length; i++) gaps.push(at[i] - at[i - 1]);
  for (const g of gaps) {
    assert.ok(
      g >= sleepFeel.zzzIntervalMs - sleepFeel.zzzJitterMs - 32 &&
        g <= sleepFeel.zzzIntervalMs + sleepFeel.zzzJitterMs + 32,
      `间隔 ${g}ms 跑出了约定区间`,
    );
    // 用户的原话是「每 2~3 秒一个」。
    assert.ok(g >= 1800 && g <= 3200, `间隔 ${g}ms 不在 2~3 秒这个量级`);
  }
  // 必须真的有抖动，否则就是个节拍器，几轮之后会被看出是循环。
  assert.ok(new Set(gaps.map((g) => Math.round(g / 100))).size >= 3, '间隔完全不抖动');
  // 间隔必须大于 FX 的生命周期，否则 zzz 叠成一团云而不是一个个飘。
  assert.ok(sleepFeel.zzzIntervalMs - sleepFeel.zzzJitterMs > 1400);
});

test('zzz 节拍器：停止睡觉后立刻不再生成（已经飘着的不由它管）', () => {
  const e = new ZzzEmitter(sleepFeel, mulberry(3));
  e.setActive(true);
  let spawned = 0;
  for (let i = 0; i < 400; i++) spawned += e.update(16); // 6.4 s
  assert.ok(spawned >= 2, '准备阶段就没冒出 zzz，后面的断言没意义');
  e.setActive(false);
  let after = 0;
  for (let i = 0; i < 5000; i++) after += e.update(16); // 80 s
  assert.equal(after, 0, '叫醒之后还在冒 zzz');
  assert.equal(e.active, false);
  assert.equal(e.remaining, 0);
});

test('zzz 节拍器：重复 setActive(true) 不重置节拍（菜单和自动打盹可能都喊一次）', () => {
  const e = new ZzzEmitter(sleepFeel, () => 0.5);
  e.setActive(true);
  for (let i = 0; i < 20; i++) e.update(16); // 320ms
  const left = e.remaining;
  e.setActive(true);
  assert.equal(e.remaining, left, '重复进入睡觉把 zzz 的节拍推后了');
});

test('zzz 节拍器：一次超长帧只冒一个，不会补出一串', () => {
  const e = new ZzzEmitter(sleepFeel, () => 0.5);
  e.setActive(true);
  // 切回标签页：攒了 5 分钟。
  assert.equal(e.update(300000), 1, '超长帧应当只补一个 zzz');
  assert.equal(e.update(16), 0, '超长帧之后紧跟着又冒了一个 —— 节拍被补课了');
});

// ---- zzz 的位置 ----

test('zzz 冒在**这个姿势**的头顶上方，而不是站立那个写死的位置', () => {
  const sleepRegions = realRegions.regionsFor('sleep');
  const head = sleepRegions.find((r) => r.part === 'head');
  assert.ok(head, 'sleep 姿势没量到头部框，这条测试的前提不成立');
  const p = zzzSpawn(sleepRegions);
  // 位置的坐标系：x 从画布中心算，y 从脚底往上算，单位都是画布高度的比例。
  // 换回「从上往下」的归一化坐标好和命中区对比。
  const half = sleepFeel.zzzSize / 2;
  const bottom = 1 - (p.y - half);
  const top = 1 - (p.y + half);
  assert.ok(bottom <= head.y0 + 1e-9, `zzz 的下边 ${bottom} 压在头部框里（头顶 ${head.y0}）`);
  assert.ok(top >= 0, `zzz 的上边 ${top} 飘出画布了`);
  const headCx = (head.x0 + head.x1) / 2;
  assert.ok(Math.abs(p.x + 0.5 - headCx) < 1e-9, 'zzz 没对准头部框的横向中心');
  // 侧躺时头在画幅左侧 → zzz 必须跟过去。站立那份常量是 x=+0.24（角色右上方）。
  assert.ok(p.x < -0.1, `侧躺时 zzz 还在 x=${p.x}，没跟着头挪到左边`);
});

test('站立姿势的 zzz 也留在画布内（y 被夹住，不会只剩半个）', () => {
  for (const a of actions) {
    const p = zzzSpawn(realRegions.regionsFor(a));
    const half = sleepFeel.zzzSize / 2;
    assert.ok(p.y + half <= 1 + 1e-9, `${a}: zzz 顶出画布了（y=${p.y}）`);
    assert.ok(p.y - half > 0, `${a}: zzz 掉到脚底下了（y=${p.y}）`);
    assert.ok(Math.abs(p.x) < 0.5, `${a}: zzz 跑出画布左右边界了（x=${p.x}）`);
  }
});

test('没有头部框时退回整身框顶边，命中区整份缺失时也不炸', () => {
  const body: PoseRegion = { part: 'body', x0: 0.2, y0: 0.1, x1: 0.8, y1: 0.95 };
  const p = zzzSpawn([body]);
  assert.ok(Math.abs(p.x + 0.5 - 0.5) < 1e-9, '退回整身框时应当对准它的横向中心');
  assert.ok(p.y > 0);
  // 空数组（理论上不可能，清单校验保证有 body）也要有东西兜住，不能返回 NaN。
  const empty = zzzSpawn([]);
  assert.ok(Number.isFinite(empty.x) && Number.isFinite(empty.y));
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

// ---------------------------------------------------------------------------
// 渲染器本身：睡觉状态的持续性、zzz 的生成、命中区跟着姿势切
//
// 上面那些测的是数学；这一组测的是**接线**，而接线恰恰是「睡觉」最容易漏气的地方：
// 临时动作到点回位会不会把睡姿顶掉、表情倒计时会不会把 sleepy 抹掉、
// setSleeping 有没有真的触发 onPoseRegions（侧躺时命中区不切 = 点不中她，
// 这是用户报过的 bug）。这些都不是纯函数，只有驱动真的 RigRenderer 才测得到。
//
// 怎么在没有 GUI 的环境里驱动它：见 headless() 的说明。
// **仍然没有被验证的是手感** —— 这里没有一个像素被真的画出来。
// ---------------------------------------------------------------------------

/**
 * 渲染器的私有状态。只有 headless() 这个夹具用，用来跳过 Pixi 的 Application.init()。
 *
 * 为什么可以这样：RigRenderer 里需要 GPU 的只有 `app.init()` 和 `app.renderer.resize()`，
 * 其余（Container / Sprite / Texture 的建立与变换、所有状态机）在 Node 里都能跑。
 * 所以这里注入「init() 成功之后」的那份最小状态，然后调它真正的公开 API。
 * 代价是这份字段名列表和 RigRenderer 的私有字段耦合 —— 重命名会让这里编译失败，
 * 这比「测一个和产线无关的替身」要好。
 */
interface RigInternals {
  ready: boolean;
  rig: LoadedRig | null;
  manifest: RigManifest | null;
  textures: Map<string, Texture>;
  hostW: number;
  hostH: number;
  action: ActionName;
  expression: string;
  fx: { sprite: { x: number; y: number; width: number; height: number } }[];
  sleepMark: { visible: boolean; alpha: number; x: number; y: number };
  zzz: ZzzEmitter;
  readonly restingAction: ActionName;
  playAction(action: ActionName): void;
  buildScene(): void;
  applyExpression(expression: string, instant: boolean): void;
  emitPoseRegions(): void;
}

interface Harness {
  rig: RigRenderer;
  inner: RigInternals;
  /** onPoseRegions 的全部回调记录，顺序即发生顺序。 */
  emitted: { pose: ActionName; regions: PoseRegion[] }[];
  /** 推进 n 帧（每帧 dtMs）。 */
  run(ms: number, dtMs?: number): void;
  /** 从开始到现在一共生成过多少枚 FX（按 sprite 身份去重，淡出销毁的也算过）。 */
  spawnCount(): number;
  /** 当前还活着的 FX。 */
  live(): RigInternals['fx'];
}

function headless(
  opts: { reduceMotion?: boolean; seed?: number; beforeReady?: (rig: RigRenderer) => void } = {},
): Harness {
  const emitted: Harness['emitted'] = [];
  const host = { clientWidth: 220, clientHeight: 220, appendChild() {} } as unknown as HTMLElement;
  const rig = new RigRenderer({
    host,
    manifestUrl: 'rig/rig.json',
    size: 220,
    reduceMotion: opts.reduceMotion,
    onPoseRegions: (regions, pose) => emitted.push({ pose, regions }),
    onError: (m) => assert.fail(`渲染器报错：${m}`),
  });
  const inner = rig as unknown as RigInternals;
  // zzz 的间隔是带随机抖动的（故意的，见 sleepFeel.zzzJitterMs）。测试里换成固定种子 ——
  // 否则「30 s 里冒了几个」这类断言会以百分之几的概率抖出边界，变成间歇性失败。
  inner.zzz = new ZzzEmitter(sleepFeel, mulberry(opts.seed ?? 5));
  // 清单还没到位时就调公开 API，模拟「素材加载完成前就被要求睡觉」。
  opts.beforeReady?.(rig);

  // 清单里引用到的每个文件都给一张同尺寸的空贴图。内容无关 —— 这里不画像素，
  // 只验证位置/显隐/生命周期，而那些只依赖贴图的尺寸。
  const textures = new Map<string, Texture>();
  const put = (file: string, width: number, height: number) => {
    if (!textures.has(file)) {
      textures.set(file, new Texture({ source: new TextureSource({ width, height, resolution: 1 }) }));
    }
  };
  put(realManifest.base.file, realManifest.base.width, realManifest.base.height);
  for (const slot of [
    realManifest.layers.eyes,
    realManifest.layers.brow,
    realManifest.layers.mouth,
  ]) {
    for (const o of Object.values(slot)) put(o.file, o.width, o.height);
  }
  if (realManifest.layers.blush) {
    const b = realManifest.layers.blush;
    put(b.file, b.width, b.height);
  }
  for (const e of Object.values(realManifest.expressions)) {
    if (e.mode === 'sprite') put(e.sprite.file, e.sprite.width, e.sprite.height);
  }
  for (const a of Object.values(realManifest.actions)) put(a.file, a.width, a.height);
  for (const f of Object.values(realManifest.fx)) put(f.file, f.width, f.height);
  put(realLogo.manifest.asset.file, realLogo.manifest.asset.width, realLogo.manifest.asset.height);

  inner.manifest = realManifest;
  inner.rig = {
    manifest: realManifest,
    baseUrl: 'rig/',
    logo: realLogo,
    logoError: null,
    regions: realRegions,
    regionsError: null,
  };
  inner.textures = textures;
  inner.hostW = 220;
  inner.hostH = 220;
  inner.ready = true;
  // init() 的尾段，去掉需要 GPU 的 layout()/ticker。顺序和 init() 里一致 ——
  // 其中 playAction(restingAction) 就是「加载完成前被要求睡觉」的补发点。
  inner.buildScene();
  inner.playAction(inner.restingAction);
  inner.applyExpression(inner.expression, true);
  inner.emitPoseRegions();

  const seen = new Set<unknown>();
  const harness: Harness = {
    rig,
    inner,
    emitted,
    run(ms, dtMs = 16) {
      for (let t = 0; t < ms; t += dtMs) {
        rig.update(dtMs);
        for (const f of inner.fx) seen.add(f.sprite);
      }
    },
    spawnCount: () => seen.size,
    live: () => inner.fx,
  };
  return harness;
}

/** 画布高度（px）。FX 的位置都是按它算的。 */
const canvasH = realManifest.canvas.height;

test('夹具本身是活的：初始是 idle 姿势，命中区喊过一次 idle', () => {
  const h = headless();
  assert.equal(h.inner.action, 'idle');
  assert.deepEqual(h.emitted.map((e) => e.pose), ['idle']);
  assert.deepEqual(h.emitted[0].regions, realRegions.regionsFor('idle'));
  h.run(2000);
  assert.equal(h.inner.action, 'idle', '什么都没做却换了姿势');
  assert.equal(h.spawnCount(), 0, '没人要求特效却冒了特效');
});

test('setSleeping(true) 把命中区切到 sleep 那套 —— 侧躺时点不中她的那个 bug', () => {
  const h = headless();
  h.rig.setSleeping(true);
  const last = h.emitted.at(-1)!;
  assert.equal(last.pose, 'sleep', 'setSleeping 没有触发 onPoseRegions，命中区还停在 idle');
  assert.deepEqual(last.regions, realRegions.regionsFor('sleep'));
  // 这份命中区必须真的和 idle 不一样，否则「切过去了」没有意义。
  assert.notDeepEqual(last.regions, realRegions.regionsFor('idle'));
  // 兜底框必须在：这是「任何姿势都点得中」的最后一道防线。
  assert.ok(last.regions.some((r) => r.part === 'body'), 'sleep 的命中区没有整身兜底框');
  // 叫醒之后要切回去。
  h.rig.setSleeping(false);
  assert.equal(h.emitted.at(-1)!.pose, 'idle');
  assert.deepEqual(h.emitted.at(-1)!.regions, realRegions.regionsFor('idle'));
});

test('睡觉状态能撑住长跑：5000 帧之后还在睡，姿势没被回位逻辑顶掉', () => {
  const h = headless();
  h.rig.setSleeping(true);
  h.run(5000 * 16); // 80 s
  assert.equal(h.rig.sleeping, true);
  assert.equal(h.inner.action, 'sleep', '跑了 80 s 之后她自己站起来了');
  assert.equal(h.inner.expression, sleepExpression, 'sleepy 被倒计时抹掉了');
  // 中途一次都不该再喊命中区（姿势没变过）。首帧的 idle + 进入睡觉的 sleep 共两条。
  assert.deepEqual(h.emitted.map((e) => e.pose), ['idle', 'sleep']);
});

test('睡觉期间 zzz 周期性地冒，而不是只冒一个', () => {
  // 多个种子都跑一遍：间隔带抖动，单个种子可能恰好落在舒服的位置。
  for (let seed = 1; seed <= 6; seed++) {
    const h = headless({ seed });
    h.rig.setSleeping(true);
    h.run(30000);
    const n = h.spawnCount();
    // 30 s / 2.5 s ≈ 12 个（首个延迟 0.7 s）。节拍器那组已经把间隔测死了，
    // 这里只确认渲染器真的把每一拍都变成了一枚 FX。
    assert.ok(n >= 10 && n <= 14, `种子 ${seed}：30 s 里生成了 ${n} 枚 zzz`);
    // 同一时刻不该堆着一堆 zzz（间隔 > FX 生命周期）。
    assert.ok(h.live().length <= 2, `种子 ${seed}：同时有 ${h.live().length} 枚 zzz 在飘，叠成云了`);
  }
});

test('zzz 冒在侧躺的头顶上方（画布像素级别对一遍）', () => {
  const h = headless();
  h.rig.setSleeping(true);
  // 跑到第一枚 zzz 刚出生、还没飘太远的时候量它的位置。
  h.run(sleepFeel.zzzFirstDelayMs + 32);
  const fx = h.live();
  assert.equal(fx.length, 1, `期望刚好有一枚 zzz，实际 ${fx.length}`);
  const head = realRegions.regionsFor('sleep').find((r) => r.part === 'head')!;
  const sprite = fx[0].sprite;
  // anchor 在中心，所以 x/y 是中心点；sprite 的 height 是画布像素。
  const bottom = sprite.y + sprite.height / 2;
  assert.ok(bottom <= head.y0 * canvasH + 1, `zzz 的下边 ${bottom}px 压进了头部框（顶边 ${head.y0 * canvasH}px）`);
  assert.ok(sprite.y - sprite.height / 2 >= -1, 'zzz 飘出画布上边了');
  const headCx = ((head.x0 + head.x1) / 2) * canvasH;
  assert.ok(Math.abs(sprite.x - headCx) < 1, `zzz 的 x=${sprite.x}px 没对准头部中心 ${headCx}px`);
  // 站立那份常量在角色右上方；侧躺时头在左边，zzz 必须跟过去。
  assert.ok(sprite.x < canvasH * 0.5, 'zzz 还在画布右半边，没跟着头挪过去');
});

test('叫醒之后停止生成，但已经在飘的那几枚自然淡出（不硬切）', () => {
  const h = headless();
  h.rig.setSleeping(true);
  // 跑到第二枚 zzz 刚出生不久：此时天上必有一枚，而且前面已经冒过两枚。
  h.run(sleepFeel.zzzFirstDelayMs + sleepFeel.zzzIntervalMs + sleepFeel.zzzJitterMs + 64);
  const before = h.spawnCount();
  assert.ok(before >= 2, `准备阶段只冒了 ${before} 枚 zzz，后面的断言没意义`);
  const flying = h.live().length;
  assert.ok(flying >= 1, '准备阶段天上一枚 zzz 都没有，测不到「不硬切」');
  h.rig.setSleeping(false);
  // 叫醒的那一帧不许把天上的 zzz 抹掉。
  assert.equal(h.live().length, flying, '停止睡觉时把正在飘的 zzz 硬切掉了');
  h.run(32);
  assert.equal(h.spawnCount(), before, '叫醒之后又冒了新的 zzz');
  // 再过一个 FX 生命周期，它们应当自己走完淡出。
  h.run(2000);
  assert.equal(h.live().length, 0, '旧的 zzz 没有自然淡出');
  assert.equal(h.spawnCount(), before);
  assert.equal(h.rig.sleeping, false);
});

test('reduceMotion 下不冒飘动的 zzz，改成一枚常驻静态 zzz', () => {
  const h = headless({ reduceMotion: true });
  h.rig.setSleeping(true);
  h.run(30000);
  assert.equal(h.spawnCount(), 0, 'reduceMotion 下还在周期性生成飘动的 zzz');
  const mark = h.inner.sleepMark;
  assert.equal(mark.visible, true, 'reduceMotion 下连静态 zzz 都没有，用户看不出她在睡');
  assert.ok(mark.alpha > 0.3, `静态 zzz 的透明度只有 ${mark.alpha}`);
  // 位置和飘动的那一版一致：对准侧躺的头顶。
  const head = realRegions.regionsFor('sleep').find((r) => r.part === 'head')!;
  assert.ok(Math.abs(mark.x - ((head.x0 + head.x1) / 2) * canvasH) < 1);
  assert.ok(mark.y < head.y0 * canvasH, '静态 zzz 没在头顶上方');
  // 命中区照样要切。
  assert.equal(h.emitted.at(-1)!.pose, 'sleep');
  h.rig.setSleeping(false);
  h.run(32);
  assert.equal(h.inner.sleepMark.visible, false, '叫醒之后静态 zzz 还挂着');
});

test('睡觉时被点一下：临时动作播完是躺回去，不是站起来，命中区也跟着回 sleep', () => {
  const h = headless();
  h.rig.setSleeping(true);
  // 洗牌袋保证一轮内每条反应各出现一次，所以最多四次就能抽到带动作的那条。
  let tapped: TapReaction | null = null;
  for (let i = 0; i < 8 && !tapped?.action; i++) tapped = h.rig.reactToTap('hand');
  assert.ok(tapped?.action, '摸手这组一条带动作的反应都没抽到，测试前提不成立');
  assert.notEqual(tapped.action, 'sleep');
  assert.equal(h.inner.action, tapped.action, '单击没有换姿势');
  assert.equal(h.emitted.at(-1)!.pose, tapped.action, '单击换姿势时没有喊命中区');

  // 临时动作到点。
  h.run(tapActionHoldMs + 64);
  assert.equal(h.inner.action, 'sleep', '睡觉期间被点一下，动作播完她站起来了');
  assert.equal(h.emitted.at(-1)!.pose, 'sleep', '姿势躺回去了但命中区还停在上一个动作上');
  assert.deepEqual(h.emitted.at(-1)!.regions, realRegions.regionsFor('sleep'));

  // 表情倒计时到点也要回 sleepy，而不是 neutral。
  h.run(tapExpressionHoldMs + 64);
  assert.equal(h.inner.expression, sleepExpression, '表情倒计时把睡觉的 sleepy 抹成 neutral 了');
  assert.equal(h.rig.sleeping, true);
});

test('没睡觉时的回位行为不变：临时动作回 idle、临时表情回 neutral', () => {
  const h = headless();
  let tapped: TapReaction | null = null;
  for (let i = 0; i < 8 && !tapped?.action; i++) tapped = h.rig.reactToTap('hand');
  assert.ok(tapped?.action);
  h.run(tapActionHoldMs + 64);
  assert.equal(h.inner.action, 'idle');
  h.run(tapExpressionHoldMs + 64);
  assert.equal(h.inner.expression, 'neutral');
  assert.equal(h.rig.sleeping, false);
});

test('重复 setSleeping(true) 不会重新播一遍进入动作，也不会多喊命中区', () => {
  const h = headless();
  h.rig.setSleeping(true);
  const after = h.emitted.length;
  h.run(1000);
  h.rig.setSleeping(true);
  h.rig.setSleeping(true);
  assert.equal(h.emitted.length, after, '重复进入睡觉把命中区又喊了一遍');
  assert.equal(h.rig.sleeping, true);
});

test('加载完成前就被要求睡觉：素材到位后补上睡姿（自动打盹和加载是并行的）', () => {
  // 真实时序：IdleBehavior 的计时器、右键菜单都可能早于贴图加载完成，
  // 那时 playAction 因为 manifest 还是 null 而无效 —— init() 的尾段必须补发一次。
  const h = headless({
    beforeReady: (rig) => {
      rig.setSleeping(true);
      assert.equal(rig.sleeping, true, '清单没到位就把睡觉状态丢了');
    },
  });
  assert.equal(h.inner.action, 'sleep', '加载完成后没有补上睡姿，她站着「睡」了');
  assert.deepEqual(h.emitted.map((e) => e.pose), ['sleep'], '命中区应当直接以 sleep 喊出来');
  assert.deepEqual(h.emitted[0].regions, realRegions.regionsFor('sleep'));
  assert.equal(h.inner.expression, sleepExpression);
  // 加载完之后 zzz 也要照常冒。
  h.run(6000);
  assert.ok(h.spawnCount() >= 2, '补上睡姿之后 zzz 没有开始冒');
});

test('一次性 FX 的大小按画布高度归一化，不随贴图原始尺寸漂', () => {
  // 这条守的是刚修掉的一个老问题：stepFx 原来 `scale.set(p.scale)`，
  // 把 spawnFx 里按画布高度算好的 width/height 整个覆盖掉，
  // FX 的实际大小变成「贴图原始尺寸 × p.scale」（256 px 贴图 ≈ 画布高度的一半）。
  // 睡觉的 zzz 要按头部框定位，位置对不对直接取决于它多大，所以这条不能再漂回去。
  const h = headless();
  h.rig.spawnFx('zzz');
  let peak = 0;
  for (let i = 0; i < 100 && h.live().length > 0; i++) {
    h.run(16);
    for (const f of h.live()) peak = Math.max(peak, f.sprite.height);
  }
  assert.ok(peak > 0, 'FX 一帧都没活过');
  // 生命周期曲线的峰值约 1.12，所以上限是 0.22 × 1.12 ≈ 0.25 个画布高度。
  assert.ok(
    peak < canvasH * 0.28,
    `FX 峰值高度 ${peak}px（画布 ${canvasH}px）—— 大小没有被归一化`,
  );
  assert.ok(peak > canvasH * 0.2, `FX 峰值高度只有 ${peak}px，比目标 0.22 个画布高度还小`);
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
