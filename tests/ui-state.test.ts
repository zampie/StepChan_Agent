// UI 层那些「判断」的回归测试。
//
// App.tsx 没有 DOM 测试环境（React + Pixi 在 node 里起不来），所以能脱开 DOM 的
// 判断都抽到了 apps/web/src/ui/uiState.ts，由这个文件钉住。
//
// 这里每条测试对应一个**真的发生过**的无声失败：门控条件写反、分支漏一个 case、
// 新设置项忘了接线。症状一律是「开关点了没反应」「按住说完松手什么都没发生」，
// 界面上看不出哪儿断了，只能靠人肉发现 —— 所以宁可测得啰嗦。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  connectionFeedback,
  escapeAction,
  intentDisposition,
  longPressPlan,
  sessionSyncFor,
  shouldListenAfterWake,
} from '../apps/web/src/ui/uiState';
import { defaultSettings, settingsSchema, type Settings } from '../shared/desktop';

const base = defaultSettings;
const withSettings = (patch: Partial<Settings>): Settings => ({ ...base, ...patch });

// ---- 设置改动 → 会话动作 ----

test('同一份设置重复喂进来是空操作（直接调用和广播撞上时的去重靠它）', () => {
  // Rust 的 emit 发给所有窗口**包括发起方**，所以右键菜单那条路必然会收到
  // 自己刚写的那份设置回来。不去重的话每次改设置都会重开麦克风 / 重连两次。
  assert.equal(sessionSyncFor(base, base), 'none');
  assert.equal(sessionSyncFor(base, withSettings({})), 'none');
});

test('纯外观改动不碰会话', () => {
  // 缩放和减少动效直接作用在渲染器上；hotkey 是 Rust 注册的。
  // 这几项要是触发 refreshSettings，用户每拖一下大小她就被打断一次。
  assert.equal(sessionSyncFor(base, withSettings({ petScale: 1.5 })), 'none');
  assert.equal(sessionSyncFor(base, withSettings({ reduceMotion: true })), 'none');
  assert.equal(sessionSyncFor(base, withSettings({ hotkey: 'Alt+X' })), 'none');
});

test('换大脑模式 / 换 chat 模型 → 重建实例', () => {
  assert.equal(sessionSyncFor(base, withSettings({ brainMode: 'chat' })), 'rebuild');
  assert.equal(
    sessionSyncFor(base, withSettings({ chatModel: 'step-3.7-flash' })),
    'rebuild',
  );
});

test('换大脑优先于其它差异（新实例自己会按新设置建起来）', () => {
  const next = withSettings({ brainMode: 'chat', voice: 'jilingshaonv', listening: false });
  assert.equal(sessionSyncFor(base, next), 'rebuild');
});

test('语音开关 → start / stop', () => {
  assert.equal(sessionSyncFor(base, withSettings({ voiceEnabled: false })), 'stop');
  const off = withSettings({ voiceEnabled: false });
  assert.equal(sessionSyncFor(off, base), 'start');
});

test('语音关着的时候别的改动不去动会话', () => {
  // 没有会话可同步，等用户开语音时按那份设置建就行。
  const off = withSettings({ voiceEnabled: false });
  assert.equal(sessionSyncFor(off, withSettings({ voiceEnabled: false, listening: false })), 'none');
  assert.equal(
    sessionSyncFor(off, withSettings({ voiceEnabled: false, voice: 'jilingshaonv' })),
    'none',
  );
});

test('换音色 → voice（realtime 首次出音后 voice 不可改，底下会重连）', () => {
  assert.equal(sessionSyncFor(base, withSettings({ voice: 'jilingshaonv' })), 'voice');
});

test('「允许说话打断她」改了必须刷到会话上（用户实际报的 bug）', () => {
  // 原来设置窗那条路只 setSettings + applyAppearance，不调 refreshSettings，
  // 于是在设置窗里关掉这个开关**完全无效**，她照常被环境噪声打断。
  assert.equal(
    sessionSyncFor(base, withSettings({ voiceInterruptible: true })),
    'refresh',
  );
  const on = withSettings({ voiceInterruptible: true });
  assert.equal(sessionSyncFor(on, base), 'refresh');
});

test('持续聆听改了必须刷到会话上', () => {
  assert.equal(sessionSyncFor(base, withSettings({ listening: false })), 'refresh');
});

test('隐私开关改了必须刷 instructions（她得立刻知道自己现在能看什么）', () => {
  for (const key of ['screenAwareness', 'appAwareness', 'clipboardAwareness', 'autonomy'] as const) {
    assert.equal(
      sessionSyncFor(base, withSettings({ [key]: true })),
      'refresh',
      `${key} 改了应该刷会话`,
    );
  }
});

test('每一个设置项都有归属：改了要么动会话，要么明确属于纯外观', () => {
  // 这条是兜底。Rust 白名单漏键、前端广播不接线这两个坑都是「加了设置项，
  // 忘了接上某一段」，表现为开关永远不生效。所以遍历 schema 的全部键，
  // 逐个翻一下值，断言结果不是悄悄的 'none'（纯外观的那几个单列白名单）。
  const cosmetic = new Set(['petScale', 'reduceMotion', 'hotkey']);
  const flipped: Settings = settingsSchema.parse({
    voice: 'jilingshaonv',
    voiceEnabled: false,
    listening: false,
    voiceInterruptible: true,
    brainMode: 'chat',
    chatModel: 'step-3.7-flash',
    screenAwareness: true,
    appAwareness: true,
    clipboardAwareness: true,
    autonomy: true,
    sleepAfterMinutes: 30,
    petScale: 1.5,
    reduceMotion: true,
    hotkey: 'Alt+X',
  });
  const keys = Object.keys(base) as (keyof Settings)[];
  // flipped 必须每个键都和默认值不同，否则下面的遍历会假阳性通过。
  for (const key of keys) {
    assert.notDeepStrictEqual(flipped[key], base[key], `flipped 里 ${key} 没真的翻过来`);
  }
  for (const key of keys) {
    const next = withSettings({ [key]: flipped[key] } as Partial<Settings>);
    const action = sessionSyncFor(base, next);
    if (cosmetic.has(key)) {
      assert.equal(action, 'none', `${key} 是纯外观，不该动会话`);
    } else {
      assert.notEqual(action, 'none', `${key} 改了却不动会话 —— 这个开关会静默失效`);
    }
  }
});

// ---- Esc ----

test('Esc：输入框开着只关框，没开才是「闭嘴」', () => {
  // 一次 Esc 只干一件事。原来输入框的 onKeyDown 里是 interrupt() + closeComposer()
  // 一起做，用户想关掉打字框却顺手把她的话掐断了。
  assert.equal(escapeAction(true), 'close-composer');
  assert.equal(escapeAction(false), 'interrupt');
});

// ---- 长按 ----

test('长按在默认设置下必须能启动（回归：原来恒不启动）', () => {
  // 原来是 `brain !== null && !brain.listening`，而 listening 默认 true →
  // 定时器压根不启动 → beginPushToTalk() 永远不被调用。文案里承诺的
  // 「想让她停下，按 Esc 或长按她」两条路当时都不通。
  assert.equal(longPressPlan({ voiceEnabled: true, hasBrain: true }), 'hold');
});

test('长按的判断里不该出现聆听模式', () => {
  // 两种聆听模式的语义差别（真开麦采集 vs 只当「闭嘴，听我说」）由会话层
  // beginPushToTalk() 自己分辨。手势层替它判断过一次，结果就是上面那个 bug。
  // 入参类型里没有 listening，这条断言是把「不该加回去」写进测试。
  const input: { voiceEnabled: boolean; hasBrain: boolean } = {
    voiceEnabled: true,
    hasBrain: true,
  };
  assert.deepEqual(Object.keys(input).sort(), ['hasBrain', 'voiceEnabled']);
  assert.equal(longPressPlan(input), 'hold');
});

test('语音关着时长按要给提示，不能静默无事发生', () => {
  // 按住、说完、松手、界面毫无反应 == 麦克风坏了（实际发生过的误判）。
  assert.equal(longPressPlan({ voiceEnabled: false, hasBrain: true }), 'voice-off');
  assert.equal(longPressPlan({ voiceEnabled: false, hasBrain: false }), 'voice-off');
});

test('大脑还没起来时长按只当普通点击', () => {
  assert.equal(longPressPlan({ voiceEnabled: true, hasBrain: false }), 'ignore');
});

// ---- 连接状态反馈 ----

test('意外断线重连要给提示（原来重连期间界面一动不动）', () => {
  assert.deepEqual(connectionFeedback('reconnecting', '连接中断（1006）'), {
    kind: 'notice',
    text: '连接中断（1006）',
  });
  assert.deepEqual(connectionFeedback('reconnecting', '会话到期，正在重新连接'), {
    kind: 'notice',
    text: '会话到期，正在重新连接',
  });
});

test('静默轮换不该惊动用户', () => {
  // 30 分钟墙前的重建和换音色重连都走 reconnecting 但不带 detail，
  // 会话层明确要求「用户不应该察觉」。按状态而不按 detail 判断就会在
  // 用户换个音色时弹一句「正在重连」。
  assert.deepEqual(connectionFeedback('reconnecting'), { kind: 'ignore' });
  assert.deepEqual(connectionFeedback('reconnecting', ''), { kind: 'ignore' });
});

test('连上了要清掉残留的错误', () => {
  assert.deepEqual(connectionFeedback('open'), { kind: 'clear' });
});

test('我们自己关的连接不报错，带原因的才报', () => {
  assert.deepEqual(connectionFeedback('closed'), { kind: 'ignore' });
  assert.deepEqual(connectionFeedback('closed', '多次重连失败，先歇一下。点一下她再试。'), {
    kind: 'error',
    text: '多次重连失败，先歇一下。点一下她再试。',
  });
});

test('connecting 不提示（首次连接由别的界面状态表达）', () => {
  assert.deepEqual(connectionFeedback('connecting'), { kind: 'ignore' });
  assert.deepEqual(connectionFeedback('connecting', '随便什么'), { kind: 'ignore' });
});

// ---------------------------------------------------------------- 睡眠

describe('睡眠：不聆听、不显示气泡，谁能出声要分来源', () => {
  test('自动打盹进睡眠，但不说台词', () => {
    // 睡着时气泡是隐藏的，这时念一句「困了先睡会儿」用户只会听到一个
    // 没有出处的声音 —— 正是报过的「只有语音没有气泡」。
    assert.equal(intentDisposition('nap', false), 'sleep');
    assert.notEqual(intentDisposition('nap', false), 'speak', '入睡不该说台词');
  });

  test('用户的真实动作（唤醒、往她身上拖文件）要叫醒她并回应', () => {
    assert.equal(intentDisposition('wake', true), 'wake-and-speak');
    assert.equal(intentDisposition('drop', true), 'wake-and-speak');
  });

  test('环境类搭话睡着时咽回去，醒着才说', () => {
    assert.equal(intentDisposition('frontmost', true), 'ignore', '睡着时她不该自己搭话');
    assert.equal(intentDisposition('frontmost', false), 'speak');
  });

  test('醒来按当前设置恢复聆听，而不是睡前快照', () => {
    // 她睡着那段时间里用户可能去设置里关了语音；按快照恢复等于把用户
    // 刚关掉的麦克风又打开。
    assert.equal(shouldListenAfterWake({ voiceEnabled: true, listening: true }), true);
    assert.equal(
      shouldListenAfterWake({ voiceEnabled: false, listening: true }),
      false,
      '语音整个关着就不该恢复麦克风',
    );
    assert.equal(
      shouldListenAfterWake({ voiceEnabled: true, listening: false }),
      false,
      '按住说话模式不常开麦，醒来也不该开',
    );
  });
});
