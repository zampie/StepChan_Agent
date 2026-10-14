import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BlinkScheduler,
  Spring,
  VisemeTracker,
  audioVisemeLadder,
  breathe,
  crossfadeMs,
  easeInOut,
  fxPose,
  minHoldMs,
  resolveBaseUrl,
  silenceFloor,
  squash,
  sway,
} from '../apps/web/src/pet';
import { type EyeState, type Viseme } from '../shared/pet';

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
