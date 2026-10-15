import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TouchTalk,
  TOUCH_TALK_COOLDOWN_MS,
  isBusyActivity,
} from '../apps/web/src/brain/touchTalk';

// 全部用注入的时钟，没有 sleep、没有假定时器。

test('被摸会产出旁白，并且带上"短一句"的约束', () => {
  let now = 0;
  const talk = new TouchTalk(() => now);
  const line = talk.narrate('head', false);
  assert.ok(line, '第一次被摸应该开口');
  assert.match(line!, /头|呆毛/, '旁白要说清被摸的是哪里');
  assert.match(line!, /一句话/, '必须带约束，否则她会长篇大论');
});

test('冷却内的连点只有第一下开口', () => {
  let now = 0;
  const talk = new TouchTalk(() => now);
  assert.ok(talk.narrate('head', false));
  now += 100;
  assert.equal(talk.narrate('head', false), null, '连点第二下不该再开口');
  now += TOUCH_TALK_COOLDOWN_MS - 200;
  assert.equal(talk.narrate('head', false), null, '冷却还没到');
  now += 300;
  assert.ok(talk.narrate('head', false), '冷却过了应该可以再开口');
});

test('她在忙时不插话，而且不消耗冷却', () => {
  let now = 0;
  const talk = new TouchTalk(() => now);
  assert.equal(talk.narrate('head', true), null, '她在听/想/说的时候不该插话');
  // 关键：被抑制的那次不能把冷却用掉，否则她一忙完用户还得再等 12 秒。
  assert.ok(talk.narrate('head', false), '抑制不该消耗冷却');
});

test('同一部位连续取到的旁白不重复（洗牌袋而不是随机）', () => {
  let now = 0;
  const talk = new TouchTalk(() => now);
  const seen: string[] = [];
  for (let i = 0; i < 3; i++) {
    const line = talk.narrate('head', false);
    assert.ok(line);
    seen.push(line!);
    now += TOUCH_TALK_COOLDOWN_MS;
  }
  assert.equal(new Set(seen).size, seen.length, '三次应当拿到三条不同措辞');
});

test('认不出的部位走兜底组，不会返回空', () => {
  let now = 0;
  const talk = new TouchTalk(() => now);
  assert.ok(talk.narrate('elbow', false), '未知部位也要有反应');
  now += TOUCH_TALK_COOLDOWN_MS;
  assert.ok(talk.narrate(null, false), 'null 部位也要有反应');
});

test('reset 清掉冷却（会话重建后不该残留）', () => {
  let now = 0;
  const talk = new TouchTalk(() => now);
  assert.ok(talk.narrate('head', false));
  talk.reset();
  assert.ok(talk.narrate('head', false), 'reset 之后应当可以立刻再开口');
});

// isBusyActivity 的语义错过一次，造成两个无声失败：点她只换表情不开口、
// 主动感知整层失效。所以把它钉住。
test('listening 是休息态，不算忙', () => {
  assert.equal(isBusyActivity('listening'), false, '开着麦克风等你说话不算忙，否则点她永远不开口');
  assert.equal(isBusyActivity('idle'), false);
  assert.equal(isBusyActivity('thinking'), true);
  assert.equal(isBusyActivity('speaking'), true);
});

test('持续聆听下点击必须能开口（回归：busy 曾永久为 true）', () => {
  let now = 0;
  const talk = new TouchTalk(() => now);
  // 她开着麦克风在等你说话 —— 这是最常见的状态。
  const busy = isBusyActivity('listening');
  assert.ok(talk.narrate('head', busy), '持续聆听时点她必须会说话');
});
