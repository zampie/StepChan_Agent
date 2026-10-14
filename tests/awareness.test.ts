import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Awareness,
  DropReactor,
  FrontmostReactor,
  IdleBehavior,
  RateWindow,
  appKey,
  basename,
  categorize,
  describePaths,
  extension,
  previewText,
  type ActivityProbe,
  type AwarenessDesktop,
  type AwarenessIntent,
  type DragDropPayload,
  type FrontmostApp,
  type Settings,
  type Spot,
} from '../apps/web/src/awareness/index';
import {
  COOLDOWN_MS,
  HOURLY_BUDGET,
  HOUR_MS,
  MENTION_TTL_MS,
} from '../apps/web/src/awareness/FrontmostReactor';
import { DROP_COOLDOWN_MS, DROP_LIMIT } from '../apps/web/src/awareness/DropReactor';
import {
  IDLE_AFTER_MS,
  MOVE_INTERVAL_MS,
  NAP_AFTER_MS,
} from '../apps/web/src/awareness/IdleBehavior';
import { defaultSettings, settingsSchema } from '../shared/desktop';
import { spots } from '../shared/pet';

// ---- 测试替身 ----
// 全部用注入的时钟/随机源。这里**没有一行 sleep**，也没有假定时器库：
// 反应器和状态机都接受 now 参数，时间线是显式喂进去的。

function settings(patch: Partial<Settings> = {}): Settings {
  return settingsSchema.parse({ ...defaultSettings, ...patch });
}

type ProbeState = { busy: boolean; typing: boolean; visible: boolean };

function makeProbe(initial: Partial<ProbeState> = {}): ActivityProbe & { state: ProbeState } {
  const state: ProbeState = { busy: false, typing: false, visible: true, ...initial };
  return {
    state,
    busy: () => state.busy,
    userTyping: () => state.typing,
    visible: () => state.visible,
  };
}

const app = (name: string, bundleId: string): FrontmostApp => ({ name, bundleId });

/** 按顺序取值的随机源；取完之后恒定返回最后一个值。 */
function seededRandom(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)] ?? 0;
}

// ---- RateWindow ----

test('RateWindow 的配额按滑动窗口释放，has() 不记账', () => {
  const window = new RateWindow(1000, 2);
  assert.equal(window.has(0), true);
  // 只查不记：连查十次用量仍然是 0。
  for (let i = 0; i < 10; i++) window.has(0);
  assert.equal(window.used, 0);

  window.take(0);
  window.take(500);
  assert.equal(window.has(900), false, '窗口内已经用满');
  // t=1000 时 t=0 那条刚好滑出。
  assert.equal(window.has(1000), true);
  window.reset();
  assert.equal(window.used, 0);
});

// ---- FrontmostReactor ----

test('FrontmostReactor 在 appAwareness 关闭时完全惰性', () => {
  const probe = makeProbe();
  const reactor = new FrontmostReactor({ probe });
  const off = settings({ appAwareness: false });

  // 默认就是关的 —— 这条顺带钉住 shared 契约的默认值。
  assert.equal(defaultSettings.appAwareness, false);

  for (let t = 0; t < 10; t++) {
    assert.equal(reactor.handle(app('Xcode', 'com.apple.dt.Xcode'), off, t * HOUR_MS), null);
  }
  assert.equal(reactor.budgetUsed, 0, '关闭状态不该消耗配额');

  // 打开之后立刻可用，而且不会"补发"关闭期间积压的切换。
  const first = reactor.handle(app('Xcode', 'com.apple.dt.Xcode'), settings({ appAwareness: true }), 10 * HOUR_MS);
  assert.equal(first?.kind, 'frontmost');
});

test('FrontmostReactor 同一个应用不重复触发，来回切也受 MENTION_TTL 约束', () => {
  const probe = makeProbe();
  const reactor = new FrontmostReactor({ probe });
  const on = settings({ appAwareness: true });

  const code = app('Visual Studio Code', 'com.microsoft.VSCode');
  const safari = app('Safari', 'com.apple.Safari');

  assert.ok(reactor.handle(code, on, 0), '第一次应当说话');
  // 同一个应用反复推事件：一次都不触发。
  for (let i = 1; i <= 5; i++) {
    assert.equal(reactor.handle(code, on, i * 1000), null, '切到同一个应用不算变化');
  }

  // 换到 Safari：过了冷却才说。
  assert.equal(reactor.handle(safari, on, COOLDOWN_MS - 1), null, '冷却内不说');
  // 注意上一行已经把 lastKey 推进到 safari 了，所以要先切回 code 再切过去。
  assert.ok(reactor.handle(code, on, COOLDOWN_MS * 3) === null, 'code 还在 MENTION_TTL 内');
  assert.ok(reactor.handle(safari, on, COOLDOWN_MS * 4), 'safari 还没提过，应当说话');

  // MENTION_TTL 过去之后 code 可以再提一次。
  assert.ok(reactor.handle(code, on, MENTION_TTL_MS + COOLDOWN_MS * 4 + 1));
});

test('FrontmostReactor 在她说话或用户打字时闭嘴，且不积压', () => {
  const probe = makeProbe();
  const reactor = new FrontmostReactor({ probe });
  const on = settings({ appAwareness: true });

  probe.state.busy = true;
  assert.equal(reactor.handle(app('Slack', 'com.tinyspeck.slackmacgap'), on, 0), null);
  probe.state.busy = false;

  probe.state.typing = true;
  assert.equal(reactor.handle(app('Notes', 'com.apple.Notes'), on, 1000), null);
  probe.state.typing = false;

  assert.equal(reactor.budgetUsed, 0, '被抑制的事件不该消耗配额');

  // 抑制期间最后看到的是 Notes。再推一次 Notes 不该"补发"那句被吞掉的话。
  assert.equal(
    reactor.handle(app('Notes', 'com.apple.Notes'), on, 2000),
    null,
    '被抑制的切换已经被吸收，不能事后补发',
  );
  // 换个新应用才恢复发言。
  assert.ok(reactor.handle(app('Terminal', 'com.apple.Terminal'), on, 3000));
});

test('FrontmostReactor 的每小时配额会封顶，窗口滑过后恢复', () => {
  const probe = makeProbe();
  const reactor = new FrontmostReactor({ probe });
  const on = settings({ appAwareness: true });

  let now = 0;
  let spoken = 0;
  // 每次都换一个全新应用，并且间隔刚好跨过冷却，只剩配额这一道闸。
  for (let i = 0; i < HOURLY_BUDGET + 6; i++) {
    now += COOLDOWN_MS;
    if (reactor.handle(app(`App${i}`, `com.test.app${i}`), on, now)) spoken++;
  }
  assert.equal(spoken, HOURLY_BUDGET, `一小时内最多 ${HOURLY_BUDGET} 次`);
  assert.ok(now < HOUR_MS, '这条测试必须在一小时窗口内跑完才有意义');

  // 窗口滑过去之后恢复。
  assert.ok(reactor.handle(app('Fresh', 'com.test.fresh'), on, HOUR_MS + now));
});

test('FrontmostReactor 忽略 null 与没有标识的应用', () => {
  const reactor = new FrontmostReactor({ probe: makeProbe() });
  const on = settings({ appAwareness: true });
  assert.equal(reactor.handle(null, on, 0), null);
  assert.equal(reactor.handle(app('  ', '  '), on, 1000), null);
  // bundleId 为空时退回用名字做键（tauri dev 下自己就是这种）。
  assert.equal(appKey(app('Dev Build', '')), 'Dev Build');
  assert.equal(appKey(app('', 'com.x.y')), 'com.x.y');
  assert.equal(appKey(null), null);
  assert.ok(reactor.handle(app('Dev Build', ''), on, 2000));
});

test('FrontmostReactor 产出的提示包含应用名并带 frontmost 隐私标记', () => {
  const reactor = new FrontmostReactor({ probe: makeProbe() });
  const intent = reactor.handle(app('Figma', 'com.figma.Desktop'), settings({ appAwareness: true }), 0);
  assert.ok(intent);
  assert.equal(intent.privacy, 'frontmost', '读了前台应用就必须能冒出可见提示');
  assert.ok(intent.prompt.includes('Figma'));
  // 必须显式授权"不值得说就别说"，否则模型每次都硬凑一句。
  assert.ok(intent.prompt.includes('别说') || intent.prompt.includes('不值得'));
});

// ---- 拖放 ----

test('basename / extension / categorize 处理各种路径', () => {
  assert.equal(basename('/Users/a/b/report.pdf'), 'report.pdf');
  assert.equal(basename('report.pdf'), 'report.pdf');
  // 拖目录时会带尾斜杠。
  assert.equal(basename('/Users/a/project/'), 'project');
  assert.equal(basename('C:\\Users\\a\\x.txt'), 'x.txt');

  assert.equal(extension('/a/b/main.RS'), 'rs', '后缀要归一化成小写');
  assert.equal(extension('/a/b/Makefile'), '', '没有后缀');
  assert.equal(extension('/a/b/.zshrc'), '', '隐藏文件不算有后缀');
  assert.equal(extension('/a/b/weird.'), '', '尾点不算后缀');
  assert.equal(extension('/a/b/archive.tar.gz'), 'gz');

  assert.equal(categorize('/x/a.png'), '图片');
  assert.equal(categorize('/x/a.tsx'), '代码');
  assert.equal(categorize('/x/a.pdf'), '文档');
  assert.equal(categorize('/x/a.mov'), '音视频');
  assert.equal(categorize('/x/a.zip'), '压缩包');
  assert.equal(categorize('/x/Makefile'), null);
});

test('describePaths 从文件名和数量生成描述，不涉及文件内容', () => {
  assert.equal(describePaths([]), null);
  assert.equal(describePaths(['   ']), null);

  const one = describePaths(['/Users/a/设计稿.png']);
  assert.ok(one);
  assert.ok(one.includes('设计稿.png'));
  assert.ok(one.includes('图片'));

  const many = describePaths([
    '/a/1.png',
    '/a/2.png',
    '/a/3.png',
    '/a/main.rs',
    '/a/notes.md',
    '/a/Makefile',
  ]);
  assert.ok(many);
  assert.ok(many.includes('6 个文件'));
  assert.ok(many.includes('3 个图片'), `应当按类别计数：${many}`);
  assert.ok(many.includes('1.png'), '应当点出第一个文件名');

  const noExt = describePaths(['/a/Makefile']);
  assert.ok(noExt?.includes('没有后缀'));

  // 空白路径要在计数和"第一个叫什么"之前就被剔掉。
  const mixed = describePaths(['  ', '/a/real.png', '/a/other.png']);
  assert.ok(mixed);
  assert.ok(mixed.includes('2 个文件'), `空白路径不该被计入：${mixed}`);
  assert.ok(mixed.includes('real.png'), '第一个名字应当取过滤后的第一项');
});

test('previewText 压平并截断拖进来的文字', () => {
  assert.equal(previewText('   '), null);
  assert.equal(previewText('  hello\n\n  world  '), 'hello world');
  const long = 'x'.repeat(500);
  const preview = previewText(long);
  assert.ok(preview);
  assert.ok(preview.endsWith('…'));
  assert.ok([...preview].length < 200);
  // 多字节字符按字符而不是按字节截断。
  const cjk = previewText('中'.repeat(500));
  assert.ok(cjk && [...cjk].length < 200);
});

test('DropReactor 的提示明确声明看不到文件内容', () => {
  const reactor = new DropReactor();
  const intent = reactor.handle({ kind: 'files', paths: ['/a/secret.pdf'] }, 0);
  assert.ok(intent);
  assert.equal(intent.kind, 'drop');
  assert.equal(intent.privacy, undefined, '拖放是用户主动投喂，不是隐私读取');
  assert.ok(intent.prompt.includes('secret.pdf'));
  assert.ok(
    intent.prompt.includes('看不到里面的内容'),
    `必须堵住"编造文件内容"这条路：${intent.prompt}`,
  );
});

test('DropReactor 有冷却与突发配额，空载荷不反应', () => {
  const reactor = new DropReactor();
  const payload: DragDropPayload = { kind: 'files', paths: ['/a/x.png'] };

  assert.ok(reactor.handle(payload, 0));
  assert.equal(reactor.handle(payload, DROP_COOLDOWN_MS - 1), null, '冷却内吃掉重复投递');
  assert.ok(reactor.handle(payload, DROP_COOLDOWN_MS));

  // 烧完一分钟的突发配额。
  let now = DROP_COOLDOWN_MS;
  let count = 2;
  while (count < DROP_LIMIT) {
    now += DROP_COOLDOWN_MS;
    if (reactor.handle(payload, now)) count++;
  }
  now += DROP_COOLDOWN_MS;
  assert.equal(reactor.handle(payload, now), null, '超过突发配额要拦住');

  // 空载荷无论什么时候都不反应。
  const fresh = new DropReactor();
  assert.equal(fresh.handle({ kind: 'files', paths: [] }, 0), null);
  assert.equal(fresh.handle({ kind: 'text', text: '  \n ' }, 0), null);
});

test('DropReactor 处理文字载荷', () => {
  const reactor = new DropReactor();
  const intent = reactor.handle({ kind: 'text', text: '帮我看看这段 SQL' }, 0);
  assert.ok(intent?.prompt.includes('帮我看看这段 SQL'));
});

// ---- IdleBehavior ----

test('IdleBehavior 在 autonomy 关闭时完全惰性', () => {
  const probe = makeProbe();
  const idle = new IdleBehavior({ probe, startedAt: 0, random: () => 0 });
  assert.equal(defaultSettings.autonomy, false, '自主行动默认必须关闭');

  const off = settings({ autonomy: false });
  for (let t = 0; t <= NAP_AFTER_MS * 2; t += 5000) {
    assert.deepEqual(idle.tick(off, t), [], `t=${t} 不该产出任何行为`);
  }
  assert.equal(idle.phase, 'active');
});

test('IdleBehavior 的 active → idle → napping → active 状态机', () => {
  const probe = makeProbe();
  // 随机数：第一个 >= MOVE_CHANCE 让它这一 tick 不挪，避免干扰状态断言。
  const idle = new IdleBehavior({ probe, startedAt: 0, random: () => 1 });
  const on = settings({ autonomy: true });

  assert.equal(idle.phase, 'active');
  idle.tick(on, IDLE_AFTER_MS - 1);
  assert.equal(idle.phase, 'active', '还没到空闲阈值');

  idle.tick(on, IDLE_AFTER_MS);
  assert.equal(idle.phase, 'idle');

  idle.tick(on, NAP_AFTER_MS - 1);
  assert.equal(idle.phase, 'idle', '还没到打盹阈值');

  const napping = idle.tick(on, NAP_AFTER_MS);
  assert.equal(idle.phase, 'napping');
  assert.equal(napping.length, 1);
  assert.equal(napping[0].type, 'intent');
  assert.equal(napping[0].type === 'intent' && napping[0].intent.kind, 'nap');

  // 打盹期间继续 tick 不再产出东西（不会每 5 秒喊一次"我困了"）。
  assert.deepEqual(idle.tick(on, NAP_AFTER_MS + 5000), []);
  assert.deepEqual(idle.tick(on, NAP_AFTER_MS + 60_000), []);

  // 互动叫醒 → 产出 wake 意图，而且只产出一次。
  const woke = idle.noteInteraction(NAP_AFTER_MS + 61_000);
  assert.equal(idle.phase, 'active');
  assert.equal(woke.length, 1);
  assert.equal(woke[0].type === 'intent' && woke[0].intent.kind, 'wake');
  assert.deepEqual(idle.noteInteraction(NAP_AFTER_MS + 62_000), [], '没在打盹时互动不产出 wake');
});

test('IdleBehavior 偶尔挪位置，受 MOVE_INTERVAL 和 reduceMotion 约束', () => {
  const probe = makeProbe();
  // 一次位移消耗两个随机数：先决定要不要动（0 → 动），再决定去哪（0 → 第一个候选）。
  const idle = new IdleBehavior({
    probe,
    startedAt: 0,
    spot: 'bottom_right',
    random: seededRandom([0, 0, 0, 0, 0, 0]),
  });
  const on = settings({ autonomy: true });

  const first = idle.tick(on, IDLE_AFTER_MS);
  assert.equal(first.length, 1);
  assert.equal(first[0].type, 'move');
  const movedTo = first[0].type === 'move' ? first[0].spot : null;
  assert.ok(movedTo && spots.includes(movedTo));
  assert.notEqual(movedTo, 'bottom_right', '不该挪到原地');

  // 紧接着不再挪：MOVE_INTERVAL 还没到。
  assert.deepEqual(idle.tick(on, IDLE_AFTER_MS + 5000), []);
  assert.deepEqual(idle.tick(on, IDLE_AFTER_MS + MOVE_INTERVAL_MS - 1), []);
  // 间隔到了就又能挪。
  const second = idle.tick(on, IDLE_AFTER_MS + MOVE_INTERVAL_MS);
  assert.equal(second[0]?.type, 'move');
  assert.notEqual(second[0].type === 'move' && second[0].spot, movedTo, '连续两次不挪到同一处');

  // reduceMotion：同样的时间线下一次都不挪，但状态机照常进入 idle。
  const still = new IdleBehavior({ probe, startedAt: 0, random: () => 0 });
  const reduced = settings({ autonomy: true, reduceMotion: true });
  for (let t = IDLE_AFTER_MS; t < NAP_AFTER_MS; t += MOVE_INTERVAL_MS) {
    assert.deepEqual(still.tick(reduced, t), [], 'reduceMotion 下不许挪窗口');
  }
  assert.equal(still.phase, 'idle');
  // 但打盹还照常（表情变化不是位移）。
  assert.equal(still.tick(reduced, NAP_AFTER_MS)[0]?.type, 'intent');
});

test('IdleBehavior 在窗口隐藏/她在忙/用户打字时暂停，并且不积压空闲时间', () => {
  const probe = makeProbe({ visible: false });
  const idle = new IdleBehavior({ probe, startedAt: 0, random: () => 0 });
  const on = settings({ autonomy: true });

  // 隐藏期间横跨远超打盹阈值的时间。
  for (let t = 0; t <= NAP_AFTER_MS * 3; t += 10_000) {
    assert.deepEqual(idle.tick(on, t), [], '隐藏时必须暂停');
  }
  assert.equal(idle.phase, 'active');

  // 一显示出来不该立刻判定"已经空闲三十分钟"。
  const shown = NAP_AFTER_MS * 3 + 10_000;
  probe.state.visible = true;
  assert.deepEqual(idle.tick(on, shown), [], '刚显示出来的那一刻还不算空闲');
  assert.equal(idle.phase, 'active');
  // 要重新从零计时。
  idle.tick(on, shown + IDLE_AFTER_MS);
  assert.equal(idle.phase, 'idle');

  // 她在说话 / 用户打字同样是暂停并重置计时。
  probe.state.busy = true;
  idle.tick(on, shown + IDLE_AFTER_MS + 1000);
  probe.state.busy = false;
  idle.tick(on, shown + IDLE_AFTER_MS + 2000);
  assert.equal(idle.phase, 'idle', 'busy 期间推进了计时基准但不改变已有阶段');
  probe.state.typing = true;
  assert.deepEqual(idle.tick(on, shown + IDLE_AFTER_MS + 3000), [], '用户打字时不许自作主张');
});

// ---- Awareness 门面 ----

type FakeDesktop = AwarenessDesktop & {
  pushFrontmost(app: FrontmostApp): void;
  pushDrop(payload: DragDropPayload): void;
  moves: Spot[];
  listeners: number;
  current: Settings;
};

function fakeDesktop(initial: Settings): FakeDesktop {
  let frontmostHandler: ((app: FrontmostApp) => void) | null = null;
  let dropHandler: ((payload: DragDropPayload) => void) | null = null;
  const state = {
    moves: [] as Spot[],
    listeners: 0,
    current: initial,
    pushFrontmost(app: FrontmostApp) {
      frontmostHandler?.(app);
    },
    pushDrop(payload: DragDropPayload) {
      dropHandler?.(payload);
    },
    onFrontmostChanged(handler: (app: FrontmostApp) => void) {
      frontmostHandler = handler;
      state.listeners++;
      return () => {
        frontmostHandler = null;
        state.listeners--;
      };
    },
    onDragDrop(handler: (payload: DragDropPayload) => void) {
      dropHandler = handler;
      state.listeners++;
      return () => {
        dropHandler = null;
        state.listeners--;
      };
    },
    async moveToSpot(spot: Spot) {
      state.moves.push(spot);
    },
    async getSettings() {
      return state.current;
    },
  };
  return state as FakeDesktop;
}

test('Awareness 门面路由意图、同步设置，stop 之后彻底安静', async () => {
  let now = 0;
  const desktop = fakeDesktop(settings({ appAwareness: true }));
  const intents: AwarenessIntent[] = [];
  const awareness = new Awareness({
    desktop,
    probe: makeProbe(),
    onIntent: (intent) => intents.push(intent),
    now: () => now,
    random: () => 1,
    // 不起真定时器，测试手动调 tick()。
    startTimer: () => () => {},
  });

  await awareness.start();
  assert.equal(awareness.active, true);
  assert.equal(desktop.listeners, 2, 'start 应当挂上两个监听');
  assert.equal(awareness.settings.appAwareness, true);

  desktop.pushFrontmost(app('Xcode', 'com.apple.dt.Xcode'));
  assert.equal(intents.length, 1);
  assert.equal(intents[0].kind, 'frontmost');

  now = COOLDOWN_MS * 2;
  desktop.pushDrop({ kind: 'files', paths: ['/a/b.png'] });
  assert.equal(intents.length, 2);
  assert.equal(intents[1].kind, 'drop');

  // 托盘改了开关：下一个 tick 刷进来之后前台感知就该停。
  desktop.current = settings({ appAwareness: false });
  awareness.tick();
  await Promise.resolve();
  assert.equal(awareness.settings.appAwareness, false);
  now = COOLDOWN_MS * 10;
  desktop.pushFrontmost(app('Safari', 'com.apple.Safari'));
  assert.equal(intents.length, 2, '开关关掉之后不该再有前台意图');

  // stop：退订、不再响应任何事件。
  awareness.stop();
  assert.equal(awareness.active, false);
  assert.equal(desktop.listeners, 0);
  desktop.pushFrontmost(app('Mail', 'com.apple.mail'));
  desktop.pushDrop({ kind: 'text', text: 'hello' });
  assert.equal(intents.length, 2, 'stop 之后一条都不许再冒出来');
});

test('Awareness 在 autonomy 打开时才挪窗口，并把位移下发给 desktop', async () => {
  let now = 0;
  const desktop = fakeDesktop(settings({ autonomy: false }));
  const awareness = new Awareness({
    desktop,
    probe: makeProbe(),
    onIntent: () => {},
    now: () => now,
    // 位移消耗两个随机数，都给 0 → 必然挪。
    random: seededRandom([0, 0]),
    startTimer: () => () => {},
    spot: 'bottom_right',
  });

  await awareness.start();
  // autonomy 关着：无论过多久都不挪。
  for (now = 0; now <= NAP_AFTER_MS; now += MOVE_INTERVAL_MS) {
    awareness.tick();
    await Promise.resolve();
  }
  assert.deepEqual(desktop.moves, [], '默认不许自己乱跑');

  // 打开 autonomy。先 tick 一次把快照刷进来（这一 tick 还在重置计时基准）。
  desktop.current = settings({ autonomy: true });
  awareness.tick();
  await Promise.resolve();
  const base = now;
  now = base + IDLE_AFTER_MS;
  awareness.tick();
  await Promise.resolve();
  assert.equal(desktop.moves.length, 1, `应当挪了一次：${JSON.stringify(desktop.moves)}`);
  assert.notEqual(desktop.moves[0], 'bottom_right');
});

test('Awareness 拿不到设置时退化为全关', async () => {
  const broken: AwarenessDesktop = {
    onFrontmostChanged: () => () => {},
    onDragDrop: () => () => {},
    moveToSpot: async () => {},
    getSettings: async () => {
      throw Error('store 坏了');
    },
  };
  const intents: AwarenessIntent[] = [];
  const awareness = new Awareness({
    desktop: broken,
    probe: makeProbe(),
    onIntent: (i) => intents.push(i),
    now: () => 0,
    startTimer: () => () => {},
  });
  await awareness.start();
  // 隐私相关的默认必须落在保守的那一侧。
  assert.equal(awareness.settings.appAwareness, false);
  assert.equal(awareness.settings.screenAwareness, false);
  assert.equal(awareness.settings.clipboardAwareness, false);
  assert.equal(awareness.settings.autonomy, false);
  assert.equal(intents.length, 0);
  awareness.stop();
});

test('Awareness.notifyInteraction 唤醒并压住紧随其后的主动搭话', async () => {
  let now = 0;
  const desktop = fakeDesktop(settings({ appAwareness: true, autonomy: true }));
  const intents: AwarenessIntent[] = [];
  const awareness = new Awareness({
    desktop,
    probe: makeProbe(),
    onIntent: (i) => intents.push(i),
    now: () => now,
    random: () => 1,
    startTimer: () => () => {},
  });
  await awareness.start();

  // 睡过去。
  now = NAP_AFTER_MS;
  awareness.tick();
  await Promise.resolve();
  now = NAP_AFTER_MS * 2;
  awareness.tick();
  await Promise.resolve();
  assert.equal(awareness.idle.phase, 'napping');

  // 用户互动 → wake 意图，并且冷却基准被推到现在。
  awareness.notifyInteraction();
  assert.equal(intents.at(-1)?.kind, 'wake');
  assert.equal(awareness.idle.phase, 'active');

  const before = intents.length;
  desktop.pushFrontmost(app('Terminal', 'com.apple.Terminal'));
  assert.equal(intents.length, before, '刚互动完不该马上又自顾自搭话');
  now += COOLDOWN_MS;
  desktop.pushFrontmost(app('Safari', 'com.apple.Safari'));
  assert.equal(intents.length, before + 1, '过了冷却才恢复');

  awareness.stop();
});
