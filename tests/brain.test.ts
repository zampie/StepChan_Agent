// 大脑层的测试：URL 校验、隐私门禁、工具执行、每轮工具上限、人设兜底判断。
//
// RealtimeSession 的测试通过一个假 WebSocket 驱动 —— 它构造时不碰 AudioContext
// （SpeechStream/MicStream 只在 start() 里建图），所以可以在 Node 里直接实例化，
// 把服务端事件灌进去，再检查它往外发了什么。
import assert from 'node:assert/strict';
import test, { describe, beforeEach, afterEach } from 'node:test';

import { safeUrl } from '../apps/web/src/brain/url';
import { Brain } from '../apps/web/src/brain/Brain';
import { createToolExecutor, type ToolContext } from '../apps/web/src/brain/tools';
import {
  buildInstructions,
  summarizeTranscript,
  textNeedsTool,
  textRequestsMove,
} from '../apps/web/src/brain/persona';
import {
  RealtimeSession,
  MAX_TOOL_CALLS_PER_TURN,
  MIN_PUSH_TO_TALK_FRAMES,
} from '../apps/web/src/voice/RealtimeSession';
import { defaultSettings, type Desktop, type Settings } from '../shared/desktop';
import { toolDefinitions, toolNames, type PetEvent, type ToolName, type ToolResult } from '../shared/brain';

// ---------------------------------------------------------------- safeUrl

describe('safeUrl：链接卡片的唯一闸门', () => {
  test('放过正常的 https', () => {
    assert.equal(safeUrl('https://example.com'), 'https://example.com/');
    assert.equal(safeUrl('https://example.com/a?b=c#d'), 'https://example.com/a?b=c#d');
  });

  test('拒绝 http —— 会被中间人改写，而我们是交给系统浏览器打开的', () => {
    assert.equal(safeUrl('http://example.com'), null);
  });

  test('拒绝带凭据的 URL —— 卡片上显示 real.com，点进去是 evil.com', () => {
    assert.equal(safeUrl('https://evil.com@real.com'), null);
    assert.equal(safeUrl('https://user:pass@real.com'), null);
    assert.equal(safeUrl('https://user@real.com'), null);
  });

  test('拒绝非 http(s) 协议', () => {
    for (const url of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,<script>alert(1)</script>',
      'ftp://example.com',
      'ws://example.com',
      'vscode://x',
    ]) {
      assert.equal(safeUrl(url), null, `${url} 应当被拒`);
    }
  });

  test('拒绝没有 hostname 的 URL', () => {
    assert.equal(safeUrl('https://'), null);
    // 注意：`https:///path` 会被 URL 规范化成 host=path（单标签主机名），
    // 所以它通得过。这不是漏洞 —— 单标签主机解析不出去，点了也只是打不开。
    assert.equal(safeUrl('https:///path'), 'https://path/');
  });

  test('拒绝彻底不是 URL 的东西，且不抛错', () => {
    for (const value of ['', '  ', 'example.com', '不是网址', '//example.com']) {
      assert.doesNotThrow(() => safeUrl(value));
      assert.equal(safeUrl(value), null, `${JSON.stringify(value)} 应当被拒`);
    }
  });
});

// ---------------------------------------------------------------- 假 Desktop

type FakeDesktopOptions = {
  settings?: Partial<Settings>;
  available?: boolean;
  capture?: Awaited<ReturnType<Desktop['captureScreen']>>;
  clipboard?: string | null;
};

function fakeDesktop(options: FakeDesktopOptions = {}) {
  const calls: { name: string; args?: unknown }[] = [];
  let settings: Settings = { ...defaultSettings, ...options.settings };
  const desktop: Desktop = {
    available: options.available ?? true,
    async credentials() {
      calls.push({ name: 'credentials' });
      return {
        apiKey: 'sk-fake',
        realtimeModel: 'stepaudio-3-realtime-preview',
        visionModel: 'step-1o-turbo-vision',
        chatModel: 'step-3.7-flash',
      };
    },
    async credentialsStatus() {
      return {
        configured: true,
        fingerprint: 'sk-fak…fake',
        source: '/tmp/.env',
        userPath: '/tmp/.stepchan/.env',
      };
    },
    async setApiKey() {
      calls.push({ name: 'setApiKey' });
      return {
        configured: true,
        fingerprint: 'sk-new…key1',
        source: '/tmp/.stepchan/.env',
        userPath: '/tmp/.stepchan/.env',
      };
    },
    async setHitRegions() {},
    async focusPet() {
      calls.push({ name: 'focusPet' });
    },
    async startDragging() {
      calls.push({ name: 'startDragging' });
    },
    async openSettings() {},
    async quit() {},
    async setInteractive() {},
    async moveToSpot(spot) {
      calls.push({ name: 'moveToSpot', args: spot });
    },
    async workArea() {
      return null;
    },
    async captureScreen() {
      calls.push({ name: 'captureScreen' });
      return options.capture ?? { status: 'ok', png: 'aGVsbG8=', width: 100, height: 100 };
    },
    async screenPermission() {
      return 'granted';
    },
    async frontmostApp() {
      calls.push({ name: 'frontmostApp' });
      return { name: 'Code', bundleId: 'com.microsoft.VSCode' };
    },
    async systemStatus() {
      calls.push({ name: 'systemStatus' });
      return {
        battery: { percent: 72, state: 'discharging', minutesRemaining: 183 },
        localTime: '2026-10-14 16:30',
        timezone: 'Asia/Shanghai',
        os: 'macOS 15.1',
      };
    },
    async readClipboardText() {
      calls.push({ name: 'readClipboardText' });
      return options.clipboard ?? 'clipboard text';
    },
    async notify(title, body) {
      calls.push({ name: 'notify', args: { title, body } });
    },
    async openUrl(url) {
      calls.push({ name: 'openUrl', args: url });
    },
    async getSettings() {
      return settings;
    },
    async setSettings(patch) {
      settings = { ...settings, ...patch } as Settings;
      return settings;
    },
    onTrayCommand: () => () => {},
    onHotkey: () => () => {},
    onDragDrop: () => () => {},
    onFrontmostChanged: () => () => {},
    onHitTest: () => () => {},
    onSettingsChanged: () => () => {},
  };
  return { desktop, calls, getSettings: () => settings };
}

function executorFor(
  options: FakeDesktopOptions & { movementRequested?: () => boolean } = {},
) {
  const { movementRequested, ...desktopOptions } = options;
  const fake = fakeDesktop(desktopOptions);
  const events: PetEvent[] = [];
  const context: ToolContext = {
    desktop: fake.desktop,
    getSettings: () => fake.desktop.getSettings(),
    getCredentials: () => fake.desktop.credentials(),
    emit: (event) => events.push(event),
    // 不传就是 undefined，正好覆盖「不提供闸门时默认不动」那条用例。
    movementRequested,
  };
  return { ...fake, events, executor: createToolExecutor(context) };
}

// ---------------------------------------------------------------- 隐私门禁

describe('隐私门禁：开关关着必须明确拒绝，并告诉用户去开哪个开关', () => {
  test('screenAwareness 关闭时 glance_screen 被拒，且根本没去截屏', async () => {
    const harness = executorFor({ settings: { screenAwareness: false } });
    const result = await harness.executor.execute('glance_screen', { reason: '用户让我看看' });
    assert.equal(result.ok, false);
    assert.match(result.message, /屏幕感知/, '拒绝消息里要点明是哪个开关');
    assert.match(result.message, /打开/, '拒绝消息要可操作');
    assert.equal(result.description, undefined, '被拒时不能带画面描述');
    // 关键：没有真的去截屏。
    assert.equal(
      harness.calls.some((c) => c.name === 'captureScreen'),
      false,
      '开关关着时绝对不能调 captureScreen',
    );
    // 被拒也不该发隐私提示（因为什么都没发生）。
    assert.equal(harness.events.some((e) => e.type === 'privacy_notice'), false);
  });

  test('screenAwareness 关闭时 read_clipboard 被拒，且没去读剪贴板', async () => {
    const harness = executorFor({ settings: { screenAwareness: false } });
    const result = await harness.executor.execute('read_clipboard', {});
    assert.equal(result.ok, false);
    assert.match(result.message, /剪贴板/);
    assert.match(result.message, /打开/);
    assert.equal(
      harness.calls.some((c) => c.name === 'readClipboardText'),
      false,
      '开关关着时绝对不能调 readClipboardText',
    );
  });

  test('screenAwareness 开启时 read_clipboard 会读，并且发了可见的隐私提示', async () => {
    const harness = executorFor({ settings: { screenAwareness: true }, clipboard: '一段文字' });
    const result = await harness.executor.execute('read_clipboard', {});
    assert.equal(result.ok, true);
    assert.match(result.message, /一段文字/);
    const notice = harness.events.find((e) => e.type === 'privacy_notice');
    assert.ok(notice, '读剪贴板必须冒出可见提示');
    assert.equal(notice!.type === 'privacy_notice' ? notice.action : null, 'clipboard');
  });

  test('appAwareness 关闭时 get_system_status 不查前台应用，并明确说不知道', async () => {
    const harness = executorFor({ settings: { appAwareness: false } });
    const result = await harness.executor.execute('get_system_status', {});
    assert.equal(result.ok, true);
    assert.equal(
      harness.calls.some((c) => c.name === 'frontmostApp'),
      false,
      '开关关着时不能调 frontmostApp',
    );
    assert.match(result.message, /应用感知是关着的/);
    assert.match(result.message, /不要猜/);
  });

  test('appAwareness 开启时才查前台应用，并发隐私提示', async () => {
    const harness = executorFor({ settings: { appAwareness: true } });
    const result = await harness.executor.execute('get_system_status', {});
    assert.equal(result.ok, true);
    assert.ok(harness.calls.some((c) => c.name === 'frontmostApp'));
    assert.match(result.message, /Code/);
    const notice = harness.events.find(
      (e) => e.type === 'privacy_notice' && e.action === 'frontmost',
    );
    assert.ok(notice, '查前台应用也要有可见提示');
  });

  test('录屏权限被系统拒绝时，给出可操作的系统设置指引', async () => {
    const harness = executorFor({
      settings: { screenAwareness: true },
      capture: { status: 'denied', message: '未授权屏幕录制' },
    });
    const result = await harness.executor.execute('glance_screen', { reason: '看看' });
    assert.equal(result.ok, false);
    assert.match(result.message, /系统设置/);
    assert.match(result.message, /屏幕录制/);
  });

  test('截屏出错时如实失败，不编造画面内容', async () => {
    const harness = executorFor({
      settings: { screenAwareness: true },
      capture: { status: 'error', message: '显示器断开了' },
    });
    const result = await harness.executor.execute('glance_screen', { reason: '看看' });
    assert.equal(result.ok, false);
    assert.equal(result.description, undefined);
    assert.match(result.message, /如实/);
  });
});

// ---------------------------------------------------------------- 其他工具

describe('工具执行', () => {
  test('open_url 放过 https 并发出链接卡片事件', async () => {
    const harness = executorFor();
    const result = await harness.executor.execute('open_url', { url: 'https://stepfun.com/docs' });
    assert.equal(result.ok, true);
    assert.equal(result.url, 'https://stepfun.com/docs');
    const link = harness.events.find((e) => e.type === 'link');
    assert.ok(link, '应当发出 link 事件');
    // 关键：工具自己不打开网页，必须由用户点。
    assert.equal(harness.calls.some((c) => c.name === 'openUrl'), false);
    assert.match(result.message, /别假装看过/);
  });

  test('open_url 拒绝非 https 和带凭据的链接，且不发事件', async () => {
    for (const url of ['http://evil.com', 'javascript:alert(1)', 'https://a@b.com']) {
      const harness = executorFor();
      const result = await harness.executor.execute('open_url', { url });
      assert.equal(result.ok, false, `${url} 应当被拒`);
      assert.equal(result.url, undefined);
      assert.equal(harness.events.some((e) => e.type === 'link'), false, `${url} 不应发出卡片`);
    }
  });

  test('express 至少要给一个字段，否则失败', async () => {
    const harness = executorFor();
    assert.equal((await harness.executor.execute('express', {})).ok, false);
    assert.equal((await harness.executor.execute('express', { expression: 'happy' })).ok, true);
  });

  // move_to 保留但被程序化门控：模型自己想挪时会被拒，用户明确要求时才放行。
  // 乱跳的根治办法是代码判定，不是在 prompt 里求她别乱动 —— 后者就是她乱跳的原因。
  test('用户没要求时 move_to 被拒，且根本不碰 desktop', async () => {
    const harness = executorFor({ movementRequested: () => false });
    const result = await harness.executor.execute('move_to', { spot: 'bottom_right' });
    assert.equal(result.ok, false);
    assert.match(result.message, /只有用户明确/);
    assert.match(result.message, /不要声称自己挪过了/);
    assert.equal(
      harness.calls.some((c) => c.name === 'moveToSpot'),
      false,
      '被拒时连 desktop 都不该碰',
    );
  });

  test('用户明确要求时 move_to 放行', async () => {
    const harness = executorFor({ movementRequested: () => true });
    const result = await harness.executor.execute('move_to', { spot: 'bottom_right' });
    assert.equal(result.ok, true);
    assert.deepEqual(
      harness.calls.filter((c) => c.name === 'moveToSpot'),
      [{ name: 'moveToSpot', args: 'bottom_right' }],
    );
  });

  test('不提供闸门时按「没要求」处理 —— 默认方向是不动', async () => {
    const harness = executorFor();
    const result = await harness.executor.execute('move_to', { spot: 'center' });
    assert.equal(result.ok, false);
  });

  test('textRequestsMove 认得要求、不认得闲聊', () => {
    for (const yes of ['让开一点', '你挡住了', '挪到右下角去吧', '去角落待着', '让一让']) {
      assert.equal(textRequestsMove(yes), true, `应判定为要求挪动：${yes}`);
    }
    for (const no of ['你好呀', '现在几点', '帮我看看屏幕', '我想挪一下这个窗口的位置吗']) {
      assert.equal(textRequestsMove(no), false, `不该判定为要求挪动：${no}`);
    }
  });

  test('get_time 对不存在的时区降级到本地而不是抛错', async () => {
    const harness = executorFor();
    const result = await harness.executor.execute('get_time', { timezone: 'Mars/Olympus_Mons' });
    assert.equal(result.ok, true);
    assert.match(result.message, /不是有效时区/);
  });

  test('set_timer 被调两次只排一个通知（用户不该收到两条一样的提醒）', async () => {
    const harness = executorFor();
    const first = await harness.executor.execute('set_timer', { seconds: 60, label: '喝水' });
    assert.equal(first.ok, true);
    assert.equal(harness.executor.pendingTimers, 1);

    const second = await harness.executor.execute('set_timer', { seconds: 60, label: '喝水' });
    assert.equal(second.ok, true, '重复调用应当成功返回，而不是报错');
    assert.match(second.message, /已经设过了/);
    assert.equal(harness.executor.pendingTimers, 1, '不能排第二个通知');

    // 不同内容的提醒还是要能设。
    await harness.executor.execute('set_timer', { seconds: 60, label: '站起来走走' });
    assert.equal(harness.executor.pendingTimers, 2);
    harness.executor.dispose();
    assert.equal(harness.executor.pendingTimers, 0, 'dispose 必须清掉未触发的倒计时');
  });

  test('set_timer 到点真的发系统通知', async () => {
    const harness = executorFor();
    // 直接用最小合法值跑太慢，这里改用假时钟不现实（setTimeout 在执行器内部），
    // 所以只验证排队成功 + dispose 清理；真实弹窗在桌面端手测。
    await harness.executor.execute('set_timer', { seconds: 10, label: '面条' });
    assert.equal(harness.executor.pendingTimers, 1);
    harness.executor.dispose();
  });
});

// ---------------------------------------------------------------- 人设

describe('人设组装', () => {
  test('instructions 写明了口语约束（这些会被直接念出来）', () => {
    const text = buildInstructions({ settings: defaultSettings, desktopAvailable: true });
    assert.match(text, /1~3 句/);
    assert.match(text, /markdown/i);
    assert.match(text, /emoji|表情符号/);
    assert.match(text, /舞台提示|动作描写/);
    assert.match(text, /桌面/);
  });

  test('instructions 写明了诚实约束', () => {
    const text = buildInstructions({ settings: defaultSettings, desktopAvailable: true });
    assert.match(text, /没有调用工具，就什么都没发生/);
    assert.match(text, /长期记忆/);
  });

  test('开关状态如实反映进 instructions', () => {
    const off = buildInstructions({
      settings: { ...defaultSettings, screenAwareness: false },
      desktopAvailable: true,
    });
    assert.match(off, /屏幕感知：已关闭/);
    assert.match(off, /glance_screen 会被拒绝/);

    const on = buildInstructions({
      settings: { ...defaultSettings, screenAwareness: true },
      desktopAvailable: true,
    });
    assert.match(on, /屏幕感知：已开启/);
  });

  test('浏览器调试环境会在 instructions 里说明能力不可用', () => {
    const text = buildInstructions({ settings: defaultSettings, desktopAvailable: false });
    assert.match(text, /调试环境/);
    assert.match(text, /不要假装成功/);
  });

  test('instructions 覆盖了全部工具名', () => {
    const text = buildInstructions({ settings: defaultSettings, desktopAvailable: true });
    for (const definition of toolDefinitions) {
      assert.ok(text.includes(definition.function.name), `instructions 里缺 ${definition.function.name}`);
    }
  });
});

describe('textNeedsTool：「嘴上答应却不调工具」的兜底', () => {
  test('指向明确的说法命中对应工具', () => {
    const cases: [string, ToolName][] = [
      ['看一下我的屏幕', 'glance_screen'],
      ['看看我的屏幕', 'glance_screen'],
      ['我现在在干什么', 'glance_screen'],
      ['读一下我的剪贴板', 'read_clipboard'],
      ['剪贴板里有什么', 'read_clipboard'],
      ['现在几点', 'get_time'],
      ['提醒我十分钟后喝水', 'set_timer'],
    ];
    for (const [text, expected] of cases) {
      assert.equal(textNeedsTool(text), expected, `${text} 应当命中 ${expected}`);
    }
  });

  test('闲聊不误判 —— 误判会让一句闲聊变成一次截屏', () => {
    for (const text of [
      '你好呀',
      '今天天气真好',
      '讲个冷知识',
      '你喜欢蓝色吗',
      '帮我想想周末去哪玩',
      '时间是什么',
    ]) {
      assert.equal(textNeedsTool(text), null, `${text} 不该强制调工具`);
    }
  });
});

describe('summarizeTranscript：换会话时带过去的上下文', () => {
  test('空记录返回空串', () => {
    assert.equal(summarizeTranscript([]), '');
  });

  test('只保留最近几条，并有总长上限', () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      role: (i % 2 ? 'pet' : 'user') as 'user' | 'pet',
      text: `第 ${i} 句`.repeat(40),
    }));
    const summary = summarizeTranscript(entries, 6, 600);
    assert.ok(summary.length <= 600, `摘要长度 ${summary.length} 超过上限`);
    assert.ok(summary.length > 0);
  });

  test('角色标记用「用户」和「你」，模型读得懂', () => {
    const summary = summarizeTranscript([
      { role: 'user', text: '帮我定个闹钟' },
      { role: 'pet', text: '设好啦' },
    ]);
    assert.match(summary, /用户：帮我定个闹钟/);
    assert.match(summary, /你：设好啦/);
  });
});

// ---------------------------------------------------------------- 假 WebSocket

type Listener = (event: unknown) => void;

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = 1;
  sent: Record<string, unknown>[] = [];
  closed: { code?: number; reason?: string } | null = null;
  private listeners = new Map<string, Listener[]>();

  constructor(
    readonly url: string,
    readonly protocols?: string[],
  ) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code?: number, reason?: string) {
    this.readyState = 3;
    this.closed = { code, reason };
  }

  // --- 测试驱动用 ---
  fire(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  open() {
    this.fire('open', {});
  }
  deliver(payload: unknown) {
    this.fire('message', { data: JSON.stringify(payload) });
  }
  sentTypes() {
    return this.sent.map((frame) => frame.type as string);
  }
  framesOf(type: string) {
    return this.sent.filter((frame) => frame.type === type);
  }
}

const realWebSocket = globalThis.WebSocket;

/**
 * 测试里建过的会话，afterEach 统一收摊。
 *
 * 必须收：RealtimeSession 在 open 时排了一个约 28.5 分钟的会话轮换定时器，
 * 不清掉的话 node 测试进程跑完也不退出。
 */
const liveSessions: RealtimeSession[] = [];

function resetWebSocket() {
  FakeWebSocket.instances = [];
  (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
}

async function cleanupSessions() {
  (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
  while (liveSessions.length) {
    const session = liveSessions.pop()!;
    // stop() 会清掉轮换/重连/补刀三个定时器。
    await session.stop();
  }
}

function makeSession(
  overrides: Partial<Parameters<typeof buildSessionOptions>[0]> = {},
): {
  session: RealtimeSession;
  ws: FakeWebSocket;
  events: PetEvent[];
  executed: { name: ToolName; args: unknown }[];
  /** 播放层探针：压音状态可读，出声电平可写，可手动触发「环空了」。 */
  /**
   * 播放层探针。`playing`/`underrun` 是关键：真实实现里「她在出声」和
   * 「瞬时电平」是两件事，而打断门控只看前者。
   */
  speech: {
    ducked: boolean;
    level: number;
    playing: boolean;
    flushes: number;
    drain: () => void;
    beginSpeaking: () => void;
    underrun: () => void;
  };
  /** 采集层探针：不碰真麦克风，只记录开关次数，并能按需喂几帧音频。 */
  mic: {
    starts: number;
    stops: number;
    running: boolean;
    failWith?: Error;
    /** 模拟采到了 n 帧音频（走真正的 onFrame 回调）。 */
    feed: (frames?: number) => void;
  };
} {
  const events: PetEvent[] = [];
  const executed: { name: ToolName; args: unknown }[] = [];
  const options = buildSessionOptions({ events, executed, ...overrides });
  const session = new RealtimeSession(options);
  liveSessions.push(session);
  // 绕过 start()（那会去建 AudioContext），直接驱动连接。
  (session as unknown as { connect: (r: boolean) => Promise<void> }).connect(false);
  const ws = FakeWebSocket.instances.at(-1)!;
  ws.open();

  // 播放层在 node:test 里没有 AudioContext，但打断逻辑只依赖
  // audioLevel / duck / unduck 这三样，所以在实例上替掉它们就够了，
  // 不必把整个 SpeechStream 做成可注入的。
  let ducked = false;
  let flushes = 0;
  let level = 0;
  let playing = false;
  const raw = session as unknown as {
    speech: { duck: () => void; unduck: () => void; flush: () => number };
    mic: { start: () => Promise<void>; stop: () => void; events: { onFrame: (b: string) => void } };
    started: boolean;
  };
  Object.defineProperty(raw.speech, 'audioLevel', {
    configurable: true,
    get: () => level,
  });
  // 「她在出声」必须独立于瞬时电平可控。
  //
  // 真实实现里这两件事是分开的：`audioLevel` 是 worklet 逐 quantum 的 RMS，
  // 欠载/句间停顿都会让它瞬时归零；而 `speaking` 是对 started/drained 做过
  // 去抖的布尔。打断门控只看后者。
  // 夹具以前只能驱动 level，所以「responseActive 已清零、但环里还有尾音」
  // 这个真实状态在测试里**无法表达** —— 那条路径上的打断 bug 因此一直没被抓到。
  Object.defineProperty(raw.speech, 'speaking', {
    configurable: true,
    get: () => playing,
  });
  // flush 要像真实实现那样**立刻**把出声状态清掉（打断是不可逆的）。
  raw.speech.flush = () => {
    playing = false;
    level = 0;
    flushes++;
    return 0;
  };
  raw.speech.duck = () => {
    ducked = true;
  };
  raw.speech.unduck = () => {
    ducked = false;
  };
  // 触发一次「环空了」。真实实现每句会发几十次（见 audio-playback.js 的
  // processDirect），所以"最后一次 drained 落在 response.done 之前还是之后"
  // 是一个真实存在的竞态。
  // SpeechStream 把回调存在 this.events（构造参数属性），运行时可取到。
  const handlers = () =>
    (
      session as unknown as {
        speech: { events?: { onDrained?: () => void; onStarted?: () => void } };
      }
    ).speech.events;
  // 注意真实实现对 drained 做了 350ms 去抖，所以这里 drain() 代表的是
  // **去抖之后**那一次（真的播完了），不是 worklet 的原始 drained。
  const drain = () => {
    playing = false;
    level = 0;
    handlers()?.onDrained?.();
  };
  /** 她开始出声：设电平 + 置出声态 + 触发 onStarted（真实实现由 worklet 回报）。 */
  const beginSpeaking = () => {
    level = 0.4;
    playing = true;
    handlers()?.onStarted?.();
  };
  /**
   * 欠载：电平瞬时归零但她**还在说**（环里还有尾音）。
   * 这是 D2 那条 bug 的现场 —— 判据用瞬时电平的话这一刻就会被判成「没在说话」。
   */
  const underrun = () => {
    level = 0;
  };
  const speech = {
    drain,
    beginSpeaking,
    underrun,
    get flushes() {
      return flushes;
    },
    get playing() {
      return playing;
    },
    get ducked() {
      return ducked;
    },
    get level() {
      return level;
    },
    set level(v: number) {
      level = v;
    },
  };

  // 麦克风同理：按住说话只关心「开了几次、关了几次、送了几帧」。
  const mic = {
    starts: 0,
    stops: 0,
    running: false,
    failWith: undefined as Error | undefined,
    // 一帧 PCM16 的 base64，内容无所谓 —— 会话只数帧数。
    feed: (frames = MIN_PUSH_TO_TALK_FRAMES) => {
      for (let i = 0; i < frames; i++) raw.mic.events.onFrame('AAAA');
    },
  };
  raw.mic.start = async () => {
    mic.starts++;
    if (mic.failWith) throw mic.failWith;
    mic.running = true;
  };
  raw.mic.stop = () => {
    mic.stops++;
    mic.running = false;
  };
  // connect() 绕过了 start()，所以 started 没被置上 —— 按住说话会检查它。
  raw.started = true;
  return { session, ws, events, executed, speech, mic };
}

function buildSessionOptions(input: {
  events: PetEvent[];
  executed: { name: ToolName; args: unknown }[];
  executeTool?: (name: ToolName, args: unknown) => Promise<ToolResult>;
  textNeedsTool?: (text: string) => ToolName | null;
  listening?: boolean;
  interruptible?: boolean;
}) {
  return {
    apiKey: 'sk-fake',
    voice: 'yuanqishaonv',
    instructions: 'test instructions',
    tools: toolDefinitions,
    // 两个开关在契约里的默认值：持续聆听开、语音打断关。
    listening: input.listening ?? true,
    interruptible: input.interruptible ?? false,
    emit: (event: PetEvent) => input.events.push(event),
    textNeedsTool: input.textNeedsTool,
    executeTool:
      input.executeTool ??
      (async (name: ToolName, args: unknown) => {
        input.executed.push({ name, args });
        return { ok: true, message: 'done' } satisfies ToolResult;
      }),
  };
}

describe('RealtimeSession：工具闭环与上限', () => {
  beforeEach(resetWebSocket);
  afterEach(cleanupSessions);

  test('连接时用 subprotocol 鉴权，URL 里不带密钥', () => {
    const { ws } = makeSession();
    assert.deepEqual(ws.protocols, ['realtime', 'openai-insecure-api-key.sk-fake']);
    assert.ok(!ws.url.includes('sk-fake'));
  });

  test('open 后立刻下发 session.update，含 pcm16、server_vad、转写和工具', () => {
    const { ws } = makeSession();
    const update = ws.framesOf('session.update')[0];
    assert.ok(update, '必须发 session.update');
    const session = update.session as Record<string, unknown>;
    assert.deepEqual(session.modalities, ['text', 'audio']);
    assert.equal(session.input_audio_format, 'pcm16');
    assert.equal(session.output_audio_format, 'pcm16');
    // 必须显式调参：文档默认 silence_duration_ms=100ms 会把一句话切成好几个回合，
    // 能量门限曾抬到 3400 挡噪声，但实测把低增益输入整个挡掉了
    // （AirPods 自检峰值 0.001 → 永远跨不过去，表现为"说话毫无反应"）。
    // 所以现在只要求"不高于文档默认值太多"：宁可偶尔多听一句也不要听不见，
    // 噪声的代价已经很小了（可打断默认关闭，噪声砍不掉她说的话）。
    const vad = session.turn_detection as {
      type: string;
      silence_duration_ms: number;
      energy_awakeness_threshold: number;
    };
    assert.equal(vad.type, 'server_vad');
    assert.ok(
      vad.silence_duration_ms >= 500,
      '停顿容忍不能用 100ms 的默认值，否则一句话会被切断',
    );
    assert.ok(
      vad.energy_awakeness_threshold <= 2500,
      '能量门限不能抬太高，否则低增益麦克风（如蓝牙耳机）会被整个挡掉，表现为"说话没反应"',
    );
    assert.ok(
      vad.energy_awakeness_threshold > 0,
      '仍要有门限，否则纯静音也会开回合',
    );
    const transcription = session.input_audio_transcription as Record<string, unknown>;
    assert.equal(transcription.model, 'stepaudio-3-asr-max');
    assert.equal(transcription.language, 'zh');
    assert.ok((transcription.hotwords as string[]).includes('Step酱'));
    assert.equal((session.tools as unknown[]).length, toolDefinitions.length);
  });

  test('工具调用 → 校验 → 执行 → 回灌 function_call_output + response.create', async () => {
    const { ws, executed, events } = makeSession();
    ws.deliver({ type: 'response.created', response: {} });
    ws.deliver({
      type: 'response.function_call_arguments.done',
      call_id: 'call_1',
      name: 'set_timer',
      arguments: '{"seconds":600,"label":"喝水"}',
    });
    await new Promise((r) => setTimeout(r, 10));

    assert.deepEqual(executed, [{ name: 'set_timer', args: { seconds: 600, label: '喝水' } }]);
    const output = ws.framesOf('conversation.item.create').at(-1);
    assert.ok(output);
    const item = output!.item as Record<string, unknown>;
    assert.equal(item.type, 'function_call_output');
    assert.equal(item.call_id, 'call_1');
    assert.deepEqual(JSON.parse(item.output as string), { ok: true, message: 'done' });
    assert.ok(ws.sentTypes().includes('response.create'), '回灌后要再触发一次回复');
    assert.ok(events.some((e) => e.type === 'tool_start' && e.name === 'set_timer'));
    assert.ok(events.some((e) => e.type === 'tool_end' && e.name === 'set_timer'));
  });

  test('非法参数被挡住，执行器根本不被调用', async () => {
    const { ws, executed } = makeSession();
    ws.deliver({ type: 'response.created', response: {} });
    ws.deliver({
      type: 'response.function_call_arguments.done',
      call_id: 'bad_1',
      name: 'set_timer',
      arguments: '{"seconds":99999,"label":"太久了"}',
    });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(executed, [], '参数非法时不能执行');
    const output = ws.framesOf('conversation.item.create').at(-1)!;
    const result = JSON.parse((output.item as Record<string, string>).output);
    assert.equal(result.ok, false);
    assert.match(result.message, /参数不合法/);
  });

  test('参数不是合法 JSON 时失败但不崩', async () => {
    const { ws, executed } = makeSession();
    ws.deliver({ type: 'response.created', response: {} });
    ws.deliver({
      type: 'response.function_call_arguments.done',
      call_id: 'bad_2',
      name: 'get_time',
      arguments: '{这不是 json',
    });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(executed, []);
    const result = JSON.parse(
      (ws.framesOf('conversation.item.create').at(-1)!.item as Record<string, string>).output,
    );
    assert.equal(result.ok, false);
    assert.match(result.message, /JSON/);
  });

  test('不存在的工具名被拒', async () => {
    const { ws, executed } = makeSession();
    ws.deliver({ type: 'response.created', response: {} });
    ws.deliver({
      type: 'response.function_call_arguments.done',
      call_id: 'nope',
      name: 'rm_rf_slash',
      arguments: '{}',
    });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(executed, []);
    const result = JSON.parse(
      (ws.framesOf('conversation.item.create').at(-1)!.item as Record<string, string>).output,
    );
    assert.equal(result.ok, false);
  });

  test(`每轮工具上限 ${MAX_TOOL_CALLS_PER_TURN}：第 ${MAX_TOOL_CALLS_PER_TURN + 1} 次被拒`, async () => {
    const { ws, executed } = makeSession();
    ws.deliver({ type: 'response.created', response: {} });
    for (let i = 0; i < MAX_TOOL_CALLS_PER_TURN + 3; i++) {
      ws.deliver({
        type: 'response.function_call_arguments.done',
        call_id: `call_${i}`,
        name: 'get_time',
        arguments: '{}',
      });
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(
      executed.length,
      MAX_TOOL_CALLS_PER_TURN,
      `只应执行 ${MAX_TOOL_CALLS_PER_TURN} 次，实际 ${executed.length} 次`,
    );
    const last = JSON.parse(
      (ws.framesOf('conversation.item.create').at(-1)!.item as Record<string, string>).output,
    );
    assert.equal(last.ok, false);
    assert.match(last.message, /已经用掉/);
  });

  test('新一轮 response.created 之后上限重新计数', async () => {
    const { ws, executed } = makeSession();
    ws.deliver({ type: 'response.created', response: {} });
    for (let i = 0; i < MAX_TOOL_CALLS_PER_TURN; i++) {
      ws.deliver({
        type: 'response.function_call_arguments.done',
        call_id: `a_${i}`,
        name: 'get_time',
        arguments: '{}',
      });
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(executed.length, MAX_TOOL_CALLS_PER_TURN);
    ws.deliver({ type: 'response.created', response: {} });
    ws.deliver({
      type: 'response.function_call_arguments.done',
      call_id: 'b_0',
      name: 'get_time',
      arguments: '{}',
    });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(executed.length, MAX_TOOL_CALLS_PER_TURN + 1, '新回合应当重新允许调用');
  });

  test('同一个 call_id 重复到达只执行一次（幂等）', async () => {
    const { ws, executed } = makeSession();
    ws.deliver({ type: 'response.created', response: {} });
    for (let i = 0; i < 3; i++) {
      ws.deliver({
        type: 'response.function_call_arguments.done',
        call_id: 'same_call',
        name: 'set_timer',
        arguments: '{"seconds":60,"label":"喝水"}',
      });
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(executed.length, 1, `重复 call_id 执行了 ${executed.length} 次，副作用会重复`);
  });

  test('执行器抛错时如实回报失败，不让她以为成功了', async () => {
    const events: PetEvent[] = [];
    const executed: { name: ToolName; args: unknown }[] = [];
    const { ws } = makeSession({
      events,
      executed,
      executeTool: async () => {
        throw Error('截屏炸了');
      },
    });
    ws.deliver({ type: 'response.created', response: {} });
    ws.deliver({
      type: 'response.function_call_arguments.done',
      call_id: 'boom',
      name: 'get_time',
      arguments: '{}',
    });
    await new Promise((r) => setTimeout(r, 10));
    const result = JSON.parse(
      (ws.framesOf('conversation.item.create').at(-1)!.item as Record<string, string>).output,
    );
    assert.equal(result.ok, false);
    assert.match(result.message, /截屏炸了/);
    assert.match(result.message, /如实告诉用户/);
  });
});

describe('RealtimeSession：打断（headline feature，voiceInterruptible=true）', () => {
  beforeEach(resetWebSocket);
  afterEach(cleanupSessions);

  /** 这一组测的是「可打断」开着时的 duck-then-confirm 行为，所以必须显式打开。 */
  const interruptible = (extra: Partial<Parameters<typeof buildSessionOptions>[0]> = {}) =>
    makeSession({ interruptible: true, ...extra });

  // 打断是不可逆的（flush + cancel 砍掉的音频回不来），而 VAD 会被咳嗽、键盘声误触发。
  // 所以契约是「先压音量，确认是人声再 cancel」，不是「立刻 cancel」。
  test('speech_started 先压音量，不立刻 cancel', () => {
    const { ws, events, speech } = interruptible();
    ws.deliver({ type: 'response.created', response: {} });
    speech.level = 0.5; // 她正在出声
    ws.sent.length = 0;
    ws.deliver({ type: 'input_audio_buffer.speech_started', audio_start_ms: 0 });
    assert.equal(ws.sentTypes().includes('response.cancel'), false, '确认前不该 cancel');
    assert.equal(speech.ducked, true, '应当先压音量');
    assert.ok(
      events.some((e) => e.type === 'activity' && e.value === 'listening'),
      '应切到 listening',
    );
  });

  test('听到实际转写才真打断', () => {
    const { ws, speech } = interruptible();
    ws.deliver({ type: 'response.created', response: {} });
    speech.level = 0.5;
    ws.deliver({ type: 'input_audio_buffer.speech_started', audio_start_ms: 0 });
    ws.sent.length = 0;
    ws.deliver({
      type: 'conversation.item.input_audio_transcription.delta',
      delta: '等一下',
    });
    assert.ok(ws.sentTypes().includes('response.cancel'), '确认是人声后必须 cancel');
  });

  // 这条是本次修复的核心：一声咳嗽不该把她刚说的半句彻底砍掉。
  test('噪声误触发（无转写就结束）不打断，音量恢复', () => {
    const { ws, speech } = interruptible();
    ws.deliver({ type: 'response.created', response: {} });
    speech.level = 0.5;
    ws.deliver({ type: 'input_audio_buffer.speech_started', audio_start_ms: 0 });
    assert.equal(speech.ducked, true);
    ws.sent.length = 0;
    ws.deliver({ type: 'input_audio_buffer.speech_stopped', audio_end_ms: 120 });
    assert.equal(ws.sentTypes().includes('response.cancel'), false, '噪声不该 cancel');
    assert.equal(speech.ducked, false, '应恢复音量继续说');
  });

  test('没有进行中的回复时不发多余的 cancel', () => {
    const { ws } = interruptible();
    ws.sent.length = 0;
    ws.deliver({ type: 'input_audio_buffer.speech_started', audio_start_ms: 0 });
    assert.equal(ws.sentTypes().includes('response.cancel'), false);
  });

  test('cancel 之后在途的音频增量被丢弃（实测会再来 4 条）', () => {
    const { ws, session } = interruptible();
    ws.deliver({ type: 'response.created', response: {} });
    const speech = (session as unknown as { speech: { enqueue: (v: string) => void } }).speech;
    let enqueued = 0;
    speech.enqueue = () => {
      enqueued++;
    };
    ws.deliver({ type: 'response.audio.delta', delta: 'AAAA' });
    assert.equal(enqueued, 1, '正常时应当入队');

    // 走完整的打断：VAD 开口 + 听到转写（确认是人声）才是真 cancel。
    // 只发 speech_started 不会打断 —— 那是留给噪声误触发的那一档。
    ws.deliver({ type: 'input_audio_buffer.speech_started', audio_start_ms: 0 });
    ws.deliver({
      type: 'conversation.item.input_audio_transcription.delta',
      delta: '停',
    });
    // 在途的 4 条
    for (let i = 0; i < 4; i++) ws.deliver({ type: 'response.audio.delta', delta: 'AAAA' });
    assert.equal(enqueued, 1, '打断后在途增量必须被丢弃，否则她会多蹦半个字');

    // 下一轮开始后恢复
    ws.deliver({ type: 'response.created', response: {} });
    ws.deliver({ type: 'response.audio.delta', delta: 'AAAA' });
    assert.equal(enqueued, 2, '新回合应当恢复入队');
  });

  test('打字输入先把她正在说的掐掉，再建 item 并触发回复', () => {
    const { ws, session, events } = makeSession();
    ws.deliver({ type: 'response.created', response: {} });
    ws.sent.length = 0;
    session.sendText('现在几点');

    const types = ws.sentTypes();
    const cancelAt = types.indexOf('response.cancel');
    const createAt = types.indexOf('conversation.item.create');
    const respondAt = types.lastIndexOf('response.create');
    assert.ok(cancelAt >= 0, '打字也要先打断正在进行的回复');
    assert.ok(createAt > cancelAt, 'cancel 必须排在新 item 之前');
    assert.ok(respondAt > createAt, 'response.create 必须在 item 之后');

    const item = ws.framesOf('conversation.item.create')[0].item as Record<string, unknown>;
    assert.equal(item.type, 'message');
    assert.equal(item.role, 'user');
    assert.deepEqual(item.content, [{ type: 'input_text', text: '现在几点' }]);
    // 打字内容立刻以 final 字幕回显，不等服务端。
    assert.ok(events.some((e) => e.type === 'user_transcript' && e.final && e.text === '现在几点'));
    assert.deepEqual(
      session.transcript.map((entry) => entry.text),
      ['现在几点'],
    );
  });

  test('空白输入不发任何东西', () => {
    const { ws, session } = makeSession();
    ws.sent.length = 0;
    session.sendText('   ');
    assert.deepEqual(ws.sent, []);
  });

  test('命中 textNeedsTool 且模型不调工具时，补发 tool_choice:required 的提醒', async () => {
    const events: PetEvent[] = [];
    const executed: { name: ToolName; args: unknown }[] = [];
    const { ws, session } = makeSession({
      events,
      executed,
      textNeedsTool: () => 'set_timer',
    });
    ws.deliver({ type: 'response.created', response: {} });
    ws.sent.length = 0;
    session.sendText('挪到右下角去吧');
    // 模型只说话，不调工具 —— 这正是实测到的失败模式。
    ws.deliver({ type: 'response.audio_transcript.done', transcript: '好的，我这就挪过去。' });
    await new Promise((r) => setTimeout(r, 1500));

    const nudge = ws
      .framesOf('conversation.item.create')
      .map((frame) => frame.item as Record<string, unknown>)
      .find((item) => item.role === 'system');
    assert.ok(nudge, '没有补发强制提醒 —— 她会谎称已经办好了');
    const text = (nudge!.content as { text: string }[])[0].text;
    assert.match(text, /set_timer/);
    assert.match(text, /不要声称自己已经做过/);
  });

  test('模型确实调了工具时不补发提醒', async () => {
    const events: PetEvent[] = [];
    const executed: { name: ToolName; args: unknown }[] = [];
    const { ws, session } = makeSession({
      events,
      executed,
      textNeedsTool: () => 'set_timer',
    });
    ws.deliver({ type: 'response.created', response: {} });
    session.sendText('挪到右下角去吧');
    ws.deliver({
      type: 'response.function_call_arguments.done',
      call_id: 'c1',
      name: 'set_timer',
      arguments: '{"seconds":600,"label":"喝水"}',
    });
    await new Promise((r) => setTimeout(r, 1500));
    const nudge = ws
      .framesOf('conversation.item.create')
      .map((frame) => frame.item as Record<string, unknown>)
      .find((item) => item.role === 'system');
    assert.equal(nudge, undefined, '工具已经调了，不该再补刀');
    assert.equal(executed.length, 1);
  });
});

describe('RealtimeSession：未知事件不能弄死会话', () => {
  beforeEach(resetWebSocket);
  afterEach(cleanupSessions);

  test('未知事件、畸形 JSON、二进制帧都不抛错，会话继续可用', () => {
    const { ws, events } = makeSession();
    assert.doesNotThrow(() => {
      ws.deliver({ type: 'response.hologram.delta', delta: 'x' });
      ws.fire('message', { data: '{坏 json' });
      ws.fire('message', { data: new ArrayBuffer(4) });
      ws.deliver({ type: 'conversation.item.created', item: {} });
    });
    // 会话还能正常处理后续事件。
    ws.deliver({ type: 'response.created', response: {} });
    ws.deliver({ type: 'response.audio_transcript.done', transcript: '还活着' });
    assert.ok(
      events.some((e) => e.type === 'pet_transcript' && e.text === '还活着' && e.final),
      '未知事件之后会话必须仍然可用',
    );
  });

  test('server error 事件转成 PetEvent 而不是抛错', () => {
    const { ws, events } = makeSession();
    ws.deliver({ type: 'error', error: { type: 'invalid_request', message: '工具格式不对' } });
    const error = events.find((e) => e.type === 'error');
    assert.ok(error);
    assert.match(error!.type === 'error' ? error.message : '', /工具格式不对/);
  });

  test('她自己的字幕是增量累加，done 时定稿', () => {
    const { ws, events, session } = makeSession();
    // 对照用：response.audio_transcript.delta 确实是增量（已实测），所以这里要 += 。
    ws.deliver({ type: 'response.audio_transcript.delta', delta: '你好' });
    ws.deliver({ type: 'response.audio_transcript.delta', delta: '呀' });
    const partial = events.filter((e) => e.type === 'pet_transcript' && !e.final).at(-1);
    assert.equal(partial!.type === 'pet_transcript' ? partial.text : '', '你好呀');
    ws.deliver({ type: 'response.audio_transcript.done', transcript: '你好呀' });
    assert.ok(events.some((e) => e.type === 'pet_transcript' && e.final && e.text === '你好呀'));
    assert.deepEqual(
      session.transcript.map((entry) => `${entry.role}:${entry.text}`),
      ['pet:你好呀'],
    );
  });

  test('用户字幕在 completed 时定稿，只进内存不落盘', () => {
    const { ws, events, session } = makeSession();
    ws.deliver({ type: 'conversation.item.input_audio_transcription.delta', delta: '你好' });
    ws.deliver({ type: 'conversation.item.input_audio_transcription.delta', delta: '你好呀' });
    const partial = events.filter((e) => e.type === 'user_transcript' && !e.final).at(-1);
    assert.equal(partial!.type === 'user_transcript' ? partial.text : '', '你好呀');
    ws.deliver({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: '你好呀',
    });
    assert.ok(events.some((e) => e.type === 'user_transcript' && e.final && e.text === '你好呀'));
    // transcript 只在内存里。
    assert.deepEqual(
      session.transcript.map((entry) => `${entry.role}:${entry.text}`),
      ['user:你好呀'],
    );
  });

  test('response.thinking.delta 驱动 thinking 事件', () => {
    const { ws, events } = makeSession();
    ws.deliver({ type: 'response.thinking.delta', delta: '让我想想' });
    assert.ok(events.some((e) => e.type === 'thinking' && e.text === '让我想想'));
    assert.ok(events.some((e) => e.type === 'activity' && e.value === 'thinking'));
  });
});

// ---------------------------------------------------------------- 累计 delta 回归
//
// 用户报「有时候一句话重复好几遍」。实测确认 conversation.item.input_audio_transcription.delta
// 送的是**累计全量文本**而不是增量（见 shared/realtime.ts 顶部），所以必须赋值而不是 += 。
// 这一组存在的唯一目的是：有人"顺手改回" += 的时候立刻红。

describe('RealtimeSession：用户转写 delta 是累计全量（回归：一句话重复好几遍）', () => {
  beforeEach(resetWebSocket);
  afterEach(cleanupSessions);

  /**
   * 实测形状：每条 delta 都是从句首开始的完整文本。
   *
   * 注意第 1→2 条把「你好呀。」改成了「你好呀，」—— ASR 边听边改标点，
   * 所以后一条**不保证**是前一条的严格前缀。正因如此，判重不能靠「前缀校验」，
   * 只能靠「赋值而不是累加」。
   */
  const CUMULATIVE = [
    '你好呀。',
    '你好呀，我',
    '你好呀，我今天',
    '你好呀，我今天想',
    '你好呀，我今天想跟你',
    '你好呀，我今天想跟你聊聊天。',
  ];

  test('喂一串累计 delta，字幕不出现重复前缀', () => {
    const { ws, events } = makeSession();
    for (const delta of CUMULATIVE) {
      ws.deliver({ type: 'conversation.item.input_audio_transcription.delta', delta });
    }
    const texts = events
      .filter((e) => e.type === 'user_transcript' && !e.final)
      .map((e) => (e.type === 'user_transcript' ? e.text : ''));
    assert.equal(texts.length, CUMULATIVE.length, '每条 delta 都该发一次字幕');

    // 1. 每一次发出去的字幕就是那一条 delta 本身（赋值语义）。用 += 的话
    //    第二条就会变成「你好呀。你好呀，我」，这里立刻红。
    assert.deepEqual(texts, CUMULATIVE);

    // 2. 最终字幕不比最后一条 delta 长 —— += 会让它长好几倍。
    const last = texts.at(-1)!;
    assert.equal(
      last,
      CUMULATIVE.at(-1),
      `字幕被叠起来了（${last}）—— delta 是累计全量，必须赋值而不是 +=`,
    );

    // 3. 句首只能出现一次。这就是用户肉眼看到的那个 bug。
    for (const text of texts) {
      const occurrences = text.split('你好呀').length - 1;
      assert.equal(occurrences, 1, `「${text}」里「你好呀」出现了 ${occurrences} 次`);
    }

    // 4. 任何一次字幕都不该超过最长那条 delta 的长度。累加的总长是各条之和
    //    （这串是 69 个字 vs 最长 14 个字），差一个数量级，糊弄不过去。
    const longest = Math.max(...CUMULATIVE.map((d) => d.length));
    for (const text of texts) {
      assert.ok(
        text.length <= longest,
        `字幕长度 ${text.length} 超过了最长的 delta（${longest}）—— 说明被累加了`,
      );
    }
  });

  test('严格递增的累计 delta：每次字幕都正好是当前已听到的全文', () => {
    // 没有标点改写的那种流，此时「后一条是前一条的前缀」成立，可以直接断前缀。
    const growing = ['明', '明天', '明天下午', '明天下午三点', '明天下午三点提醒我'];
    const { ws, events } = makeSession();
    for (const delta of growing) {
      ws.deliver({ type: 'conversation.item.input_audio_transcription.delta', delta });
    }
    const texts = events
      .filter((e) => e.type === 'user_transcript' && !e.final)
      .map((e) => (e.type === 'user_transcript' ? e.text : ''));
    assert.deepEqual(texts, growing);
    for (const text of texts) {
      assert.ok(
        growing.at(-1)!.startsWith(text),
        `字幕「${text}」不是最终文本的前缀 —— 说明被累加了`,
      );
    }
  });

  test('打断确认路径下也不重复（累计 delta + barge-in）', () => {
    const { ws, events, speech } = makeSession({ interruptible: true });
    ws.deliver({ type: 'response.created', response: {} });
    speech.level = 0.5;
    ws.deliver({ type: 'input_audio_buffer.speech_started', audio_start_ms: 0 });
    for (const delta of CUMULATIVE) {
      ws.deliver({ type: 'conversation.item.input_audio_transcription.delta', delta });
    }
    const last = events
      .filter((e) => e.type === 'user_transcript' && !e.final)
      .map((e) => (e.type === 'user_transcript' ? e.text : ''))
      .at(-1);
    assert.equal(last, CUMULATIVE.at(-1), '打断路径不该影响字幕的赋值语义');
    assert.ok(ws.sentTypes().includes('response.cancel'), '听到转写后仍应打断');
  });

  test('speech_started 会清掉上一轮的残留，新一轮不带旧文本', () => {
    const { ws, events, speech } = makeSession({ interruptible: true });
    ws.deliver({ type: 'conversation.item.input_audio_transcription.delta', delta: '上一句话' });
    speech.level = 0;
    ws.deliver({ type: 'input_audio_buffer.speech_started', audio_start_ms: 0 });
    ws.deliver({ type: 'conversation.item.input_audio_transcription.delta', delta: '新的' });
    const last = events
      .filter((e) => e.type === 'user_transcript' && !e.final)
      .map((e) => (e.type === 'user_transcript' ? e.text : ''))
      .at(-1);
    assert.equal(last, '新的', '新一轮不该带上一轮的文本');
  });

  test('delta 字段缺失时保住上一次的文本，不变成 undefined', () => {
    const { ws, events } = makeSession();
    ws.deliver({ type: 'conversation.item.input_audio_transcription.delta', delta: '你好呀' });
    ws.deliver({ type: 'conversation.item.input_audio_transcription.delta' });
    const last = events
      .filter((e) => e.type === 'user_transcript' && !e.final)
      .map((e) => (e.type === 'user_transcript' ? e.text : ''))
      .at(-1);
    assert.equal(last, '你好呀');
  });
});

// ---------------------------------------------------------------- 可打断开关

describe('RealtimeSession：可打断开关关闭时（默认）语音不打断她', () => {
  beforeEach(resetWebSocket);
  afterEach(cleanupSessions);

  /** 让她处于「正在说话」的状态。 */
  function speaking(harness: ReturnType<typeof makeSession>) {
    harness.ws.deliver({ type: 'response.created', response: {} });
    harness.speech.beginSpeaking();
    harness.ws.sent.length = 0;
  }

  test('她说话期间的 VAD 完全被忽略 —— 连音量都不压', () => {
    const harness = makeSession();
    speaking(harness);
    harness.ws.deliver({ type: 'input_audio_buffer.speech_started', audio_start_ms: 0 });
    assert.equal(harness.speech.ducked, false, '开关关着时连压音量都不该做');
    assert.equal(harness.ws.sentTypes().includes('response.cancel'), false, '不该 cancel');
  });

  test('听到真实转写也不打断（她自己的回声就长这样）', () => {
    const harness = makeSession();
    speaking(harness);
    harness.ws.deliver({ type: 'input_audio_buffer.speech_started', audio_start_ms: 0 });
    harness.ws.deliver({
      type: 'conversation.item.input_audio_transcription.delta',
      delta: '确实是人在说话',
    });
    assert.equal(
      harness.ws.sentTypes().includes('response.cancel'),
      false,
      '开关关着时即使确认是人声也不能打断',
    );
    assert.equal(harness.speech.ducked, false);
  });

  test('在途音频不被丢弃 —— 她要把话说完', () => {
    const harness = makeSession();
    const speech = (harness.session as unknown as { speech: { enqueue: (v: string) => void } })
      .speech;
    let enqueued = 0;
    speech.enqueue = () => {
      enqueued++;
    };
    speaking(harness);
    harness.ws.deliver({ type: 'input_audio_buffer.speech_started', audio_start_ms: 0 });
    harness.ws.deliver({
      type: 'conversation.item.input_audio_transcription.delta',
      delta: '喂',
    });
    for (let i = 0; i < 4; i++) {
      harness.ws.deliver({ type: 'response.audio.delta', delta: 'AAAA' });
    }
    assert.equal(enqueued, 4, '没有打断，音频必须继续播');
  });

  test('被忽略的那一轮不会把活动状态搅乱（她还在说话就不该显示 thinking）', () => {
    const harness = makeSession();
    speaking(harness);
    harness.events.length = 0;
    harness.ws.deliver({ type: 'input_audio_buffer.speech_started', audio_start_ms: 0 });
    harness.ws.deliver({ type: 'input_audio_buffer.speech_stopped', audio_end_ms: 300 });
    const activities = harness.events
      .filter((e) => e.type === 'activity')
      .map((e) => (e.type === 'activity' ? e.value : ''));
    assert.deepEqual(activities, [], `被忽略的 VAD 回合不该发活动事件，实际发了 ${activities}`);
  });

  // 关键：关掉「语音打断」不等于关掉「开始新回合」。
  test('她没在说话时仍然正常开始新回合', () => {
    const { ws, events, speech } = makeSession();
    speech.level = 0;
    ws.sent.length = 0;
    ws.deliver({ type: 'input_audio_buffer.speech_started', audio_start_ms: 0 });
    assert.ok(
      events.some((e) => e.type === 'activity' && e.value === 'listening'),
      '她闲着的时候用户开口必须切到 listening',
    );
    ws.deliver({ type: 'input_audio_buffer.speech_stopped', audio_end_ms: 300 });
    assert.ok(
      events.some((e) => e.type === 'activity' && e.value === 'thinking'),
      '说完之后该进 thinking',
    );
  });

  test('interrupt() 在开关关闭时依然有效（Esc / 长按走这条）', () => {
    const harness = makeSession();
    speaking(harness);
    harness.session.interrupt();
    assert.ok(
      harness.ws.sentTypes().includes('response.cancel'),
      'interrupt() 是用户明确的动作，不受开关影响',
    );
  });

  test('打字输入依然会先把她掐掉', () => {
    const harness = makeSession();
    speaking(harness);
    harness.session.sendText('算了，说点别的');
    assert.ok(harness.ws.sentTypes().includes('response.cancel'));
  });
});

// ---------------------------------------------------------------- 聆听模式 / 按住说话

describe('RealtimeSession：按住说话（listening=false）', () => {
  beforeEach(resetWebSocket);
  afterEach(cleanupSessions);

  test('session.update 把 turn_detection 设成 null（否则 VAD 会截断长按）', () => {
    const { ws } = makeSession({ listening: false });
    const session = ws.framesOf('session.update')[0].session as Record<string, unknown>;
    assert.equal(
      session.turn_detection,
      null,
      '按住说话必须关掉服务端 VAD，不然它会按停顿把一句话切成好几个回合',
    );
  });

  test('持续聆听模式下 turn_detection 仍然是 server_vad', () => {
    const { ws } = makeSession({ listening: true });
    const session = ws.framesOf('session.update')[0].session as Record<string, unknown>;
    assert.equal((session.turn_detection as { type: string }).type, 'server_vad');
  });

  test('enableMic() 被拒绝 —— 按住说话模式不许常开麦', async () => {
    const { session, mic } = makeSession({ listening: false });
    await session.enableMic();
    assert.equal(mic.starts, 0, '常开麦会违背「不持续开麦」的承诺');
  });

  test('长按才开麦；松手提交 commit + response.create 并关麦', async () => {
    const { session, ws, mic, events } = makeSession({ listening: false });
    assert.equal(mic.starts, 0, '建会话时不该碰麦克风（权限留到第一次长按）');

    ws.sent.length = 0;
    await session.beginPushToTalk();
    assert.equal(mic.starts, 1, '长按才开麦');
    assert.equal(session.pushToTalkActive, true);
    mic.feed(); // 用户说了几帧话
    assert.ok(
      ws.framesOf('input_audio_buffer.append').length > 0,
      '按住期间采到的音频要实时 append 上去',
    );
    assert.equal(
      ws.sentTypes().includes('input_audio_buffer.commit'),
      false,
      '还按着的时候不能提交',
    );
    assert.ok(
      events.some((e) => e.type === 'activity' && e.value === 'listening'),
      '长按期间应当显示在听',
    );

    ws.sent.length = 0;
    session.endPushToTalk();
    assert.equal(mic.stops >= 1, true, '松手必须关麦，否则录音指示灯一直亮');
    assert.equal(session.pushToTalkActive, false);
    const types = ws.sentTypes();
    const commitAt = types.indexOf('input_audio_buffer.commit');
    const respondAt = types.indexOf('response.create');
    assert.ok(commitAt >= 0, 'VAD 关着时必须手动 commit，否则这段话永远不会变成一个回合');
    assert.ok(respondAt > commitAt, 'response.create 必须排在 commit 之后');
    assert.ok(events.some((e) => e.type === 'activity' && e.value === 'thinking'));
  });

  // 实测：空缓冲区上 commit 会让服务端回两个 error（其中一条是
  // "input_audio_buffer.append is not called"），用户会看到莫名的错误提示。
  test('误触的极短长按不提交，而是清掉（空 commit 会让服务端报错）', async () => {
    const { session, ws, events } = makeSession({ listening: false });
    await session.beginPushToTalk();
    ws.sent.length = 0;
    events.length = 0;
    session.endPushToTalk(); // 一帧都没采到
    assert.equal(
      ws.sentTypes().includes('input_audio_buffer.commit'),
      false,
      '一帧音频都没有就提交 = 用户看到一个看不懂的错误',
    );
    assert.ok(ws.sentTypes().includes('input_audio_buffer.clear'), '误触的残留要清掉');
    assert.deepEqual(
      events.filter((e) => e.type === 'activity').map((e) => (e.type === 'activity' ? e.value : '')),
      ['idle'],
      '误触之后回到 idle，不要卡在「正在听」',
    );
  });

  test('采到的音频够长就正常提交（下限只拦误触，不拦短句）', async () => {
    const { session, ws, mic } = makeSession({ listening: false });
    await session.beginPushToTalk();
    mic.feed(MIN_PUSH_TO_TALK_FRAMES);
    ws.sent.length = 0;
    session.endPushToTalk();
    assert.ok(
      ws.sentTypes().includes('input_audio_buffer.commit'),
      `${MIN_PUSH_TO_TALK_FRAMES} 帧（约 ${MIN_PUSH_TO_TALK_FRAMES * 40}ms）应当算一次正常说话`,
    );
  });

  test('帧数在两次长按之间不累积（上一次的余额不能顶这一次）', async () => {
    const { session, ws, mic } = makeSession({ listening: false });
    await session.beginPushToTalk();
    mic.feed(MIN_PUSH_TO_TALK_FRAMES);
    session.endPushToTalk();
    await session.beginPushToTalk();
    ws.sent.length = 0;
    session.endPushToTalk(); // 这一次什么都没说
    assert.equal(ws.sentTypes().includes('input_audio_buffer.commit'), false);
  });

  test('长按前先清缓冲区，上一轮的尾巴不会被算进这一轮', async () => {
    const { session, ws } = makeSession({ listening: false });
    ws.sent.length = 0;
    await session.beginPushToTalk();
    assert.ok(
      ws.sentTypes().includes('input_audio_buffer.clear'),
      '不清掉残留的话，上次没提交的音频会跟这次拼在一起',
    );
  });

  test('长按会先打断她（无论可打断开关怎么设）', async () => {
    const { session, ws, speech } = makeSession({ listening: false, interruptible: false });
    ws.deliver({ type: 'response.created', response: {} });
    speech.level = 0.5;
    ws.sent.length = 0;
    await session.beginPushToTalk();
    assert.ok(ws.sentTypes().includes('response.cancel'), '长按就是「闭嘴，听我说」');
  });

  test('重复长按不会开两次麦', async () => {
    const { session, mic } = makeSession({ listening: false });
    await session.beginPushToTalk();
    await session.beginPushToTalk();
    await session.beginPushToTalk();
    assert.equal(mic.starts, 1);
  });

  test('没按就松手是空操作，不会发出假的 commit', () => {
    const { session, ws } = makeSession({ listening: false });
    ws.sent.length = 0;
    session.endPushToTalk();
    assert.deepEqual(ws.sent, []);
  });

  test('麦克风权限被拒时如实收场，不把 UI 卡在「正在听」', async () => {
    const harness = makeSession({ listening: false });
    harness.mic.failWith = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    await harness.session.beginPushToTalk();
    assert.equal(harness.session.pushToTalkActive, false);
    assert.equal(
      harness.events.filter((e) => e.type === 'activity').at(-1)?.type === 'activity'
        ? (harness.events.filter((e) => e.type === 'activity').at(-1) as { value: string }).value
        : '',
      'idle',
    );
    harness.ws.sent.length = 0;
    harness.session.endPushToTalk();
    assert.deepEqual(harness.ws.sent, [], '没采到音频就不该提交');
  });

  test('连接断了的时候松手不会把状态卡在 listening', async () => {
    const { session, ws, events, mic } = makeSession({ listening: false });
    await session.beginPushToTalk();
    mic.feed();
    ws.readyState = 3; // 连接没了
    events.length = 0;
    session.endPushToTalk();
    assert.deepEqual(
      events.filter((e) => e.type === 'activity').map((e) => (e.type === 'activity' ? e.value : '')),
      ['idle'],
    );
  });

  test('持续聆听模式下长按只当「闭嘴听我说」，不手动提交（断句仍交给 VAD）', async () => {
    const { session, ws, mic, speech } = makeSession({ listening: true });
    ws.deliver({ type: 'response.created', response: {} });
    speech.level = 0.5;
    ws.sent.length = 0;
    await session.beginPushToTalk();
    assert.ok(ws.sentTypes().includes('response.cancel'), '仍然要打断她');
    assert.equal(mic.starts, 0, '麦克风本来就开着，不该再开一次');
    ws.sent.length = 0;
    session.endPushToTalk();
    assert.equal(
      ws.sentTypes().includes('input_audio_buffer.commit'),
      false,
      'VAD 开着的时候手动提交会和 VAD 抢着断句',
    );
    assert.equal(mic.stops, 0, '不能把常开的麦关掉');
  });
});

// ---------------------------------------------------------------- 运行时切换

describe('RealtimeSession：两个开关都能运行时切换（用户随时在托盘里改）', () => {
  beforeEach(resetWebSocket);
  afterEach(cleanupSessions);

  test('setInterruptible(true) 之后语音立刻能打断；再关掉又不能', () => {
    const harness = makeSession({ interruptible: false });
    harness.ws.deliver({ type: 'response.created', response: {} });
    harness.speech.level = 0.5;

    harness.session.setInterruptible(true);
    harness.ws.sent.length = 0;
    harness.ws.deliver({ type: 'input_audio_buffer.speech_started', audio_start_ms: 0 });
    assert.equal(harness.speech.ducked, true, '打开之后应当恢复 duck-then-confirm');
    harness.ws.deliver({
      type: 'conversation.item.input_audio_transcription.delta',
      delta: '停一下',
    });
    assert.ok(harness.ws.sentTypes().includes('response.cancel'));

    // 再关掉
    harness.session.setInterruptible(false);
    harness.ws.deliver({ type: 'response.created', response: {} });
    harness.speech.level = 0.5;
    harness.ws.sent.length = 0;
    harness.ws.deliver({ type: 'input_audio_buffer.speech_started', audio_start_ms: 0 });
    assert.equal(harness.speech.ducked, false);
    assert.equal(harness.ws.sentTypes().includes('response.cancel'), false);
  });

  test('正压着音量时把开关关掉 → 立刻恢复音量，别让她一直小声说', () => {
    const harness = makeSession({ interruptible: true });
    harness.ws.deliver({ type: 'response.created', response: {} });
    harness.speech.level = 0.5;
    harness.ws.deliver({ type: 'input_audio_buffer.speech_started', audio_start_ms: 0 });
    assert.equal(harness.speech.ducked, true);
    harness.session.setInterruptible(false);
    assert.equal(harness.speech.ducked, false, '关掉开关必须立刻 unduck');
  });

  test('setListening 热改 turn_detection，不重建会话（已实测可以热改）', async () => {
    const { session, ws, mic } = makeSession({ listening: true });
    const wsCount = FakeWebSocket.instances.length;

    ws.sent.length = 0;
    await session.setListening(false);
    assert.equal(
      FakeWebSocket.instances.length,
      wsCount,
      'turn_detection 能热改，不该为此重建 WebSocket',
    );
    const off = ws.framesOf('session.update').at(-1)!.session as Record<string, unknown>;
    assert.equal(off.turn_detection, null);
    assert.equal(mic.stops >= 1, true, '切到按住说话必须把常开的麦关掉');

    ws.sent.length = 0;
    await session.setListening(true);
    assert.equal(FakeWebSocket.instances.length, wsCount);
    const on = ws.framesOf('session.update').at(-1)!.session as Record<string, unknown>;
    assert.equal((on.turn_detection as { type: string }).type, 'server_vad');
    assert.equal(mic.starts, 1, '切回持续聆听要把麦重新打开');
  });

  test('切模式时把按着的那一轮收掉，不留没提交的音频', async () => {
    const { session, ws, mic } = makeSession({ listening: false });
    await session.beginPushToTalk();
    mic.feed();
    ws.sent.length = 0;
    await session.setListening(true);
    assert.ok(
      ws.sentTypes().includes('input_audio_buffer.commit'),
      '用户正按着时切模式，这段话要么提交要么丢，不能悬着',
    );
    assert.equal(session.pushToTalkActive, false);
  });

  test('切成一样的值是空操作（托盘每次点击都会重读设置）', async () => {
    const { session, ws } = makeSession({ listening: true, interruptible: false });
    ws.sent.length = 0;
    await session.setListening(true);
    session.setInterruptible(false);
    assert.deepEqual(ws.sent, [], '值没变就不该推送配置');
  });

  test('重连之后新开关值跟着一起下发（不是只在建会话时读一次）', async () => {
    const { session, ws } = makeSession({ listening: true });
    await session.setListening(false);
    // 模拟一次重连：旧连接断掉，connect 再跑一遍。
    ws.readyState = 3;
    await (session as unknown as { connect: (r: boolean) => Promise<void> }).connect(true);
    const next = FakeWebSocket.instances.at(-1)!;
    next.open();
    const update = next.framesOf('session.update')[0].session as Record<string, unknown>;
    assert.equal(update.turn_detection, null, '重连之后必须沿用当前的聆听模式');
  });
});

// ---------------------------------------------------------------- 假音频栈
//
// Brain 层的测试要走 session.start()，那会碰 AudioContext 和 getUserMedia。
// 这里把它们桩出来 —— 不是为了测音频（测不了），而是为了能数清
// 「启动了几个 WebSocket」「申请了几次麦克风权限」。

type AudioStubs = {
  /** getUserMedia 被调了几次 = 向用户申请了几次麦克风。 */
  getUserMediaCalls: number;
  liveTracks: number;
  restore: () => void;
};

function stubAudio(): AudioStubs {
  const g = globalThis as Record<string, unknown>;
  // Node 的 globalThis.navigator 是只读 getter，必须用 defineProperty 覆盖，
  // 直接赋值会抛 "has only a getter"。
  const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const saved = {
    AudioContext: g.AudioContext,
    AudioWorkletNode: g.AudioWorkletNode,
    GainNode: g.GainNode,
  };
  const stubs: AudioStubs = {
    getUserMediaCalls: 0,
    liveTracks: 0,
    restore: () => {
      g.AudioContext = saved.AudioContext;
      g.AudioWorkletNode = saved.AudioWorkletNode;
      g.GainNode = saved.GainNode;
      if (savedNavigator) Object.defineProperty(globalThis, 'navigator', savedNavigator);
      else delete g.navigator;
    },
  };

  class FakeAudioContext {
    sampleRate = 24000;
    state = 'running';
    currentTime = 0;
    destination = {};
    audioWorklet = { addModule: async () => {} };
    async resume() {}
    async close() {}
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} };
    }
  }
  class FakeWorkletNode {
    port = { onmessage: null as unknown, postMessage() {} };
    connect() {}
    disconnect() {}
  }
  class FakeGainNode {
    context = { currentTime: 0 };
    gain = { setTargetAtTime() {} };
    connect() {}
    disconnect() {}
  }
  g.AudioContext = FakeAudioContext;
  g.AudioWorkletNode = FakeWorkletNode;
  g.GainNode = FakeGainNode;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: {
      mediaDevices: {
        getUserMedia: async () => {
          stubs.getUserMediaCalls++;
          stubs.liveTracks++;
          return {
            getTracks: () => [
              {
                stop: () => {
                  stubs.liveTracks--;
                },
              },
            ],
          };
        },
      },
    },
  });
  return stubs;
}

describe('Brain：并发 start 不能起两套会话（「一句话重复好几遍」的第二个嫌疑）', () => {
  let audio: AudioStubs;
  beforeEach(() => {
    resetWebSocket();
    audio = stubAudio();
  });
  afterEach(async () => {
    await cleanupSessions();
    audio.restore();
  });

  /** 让所有 FakeWebSocket 都 open，这样 session.update 会真的发出去。 */
  function openAll() {
    for (const ws of FakeWebSocket.instances) if (ws.readyState === 1) ws.open();
  }

  test('启动 + 托盘 + 热键同时调 start，只建一个 WebSocket、只申请一次麦克风', async () => {
    const { desktop } = fakeDesktop();
    const brain = new Brain({ desktop });
    const events: PetEvent[] = [];
    brain.on((e: PetEvent) => events.push(e));
    try {
      await Promise.all([brain.start(true), brain.start(true), brain.start(true)]);
      assert.equal(
        FakeWebSocket.instances.length,
        1,
        `建了 ${FakeWebSocket.instances.length} 个 WebSocket —— 两条连接会让每句话被回两遍`,
      );
      assert.equal(
        audio.getUserMediaCalls,
        1,
        `申请了 ${audio.getUserMediaCalls} 次麦克风 —— 两个 MicStream 会把每帧音频送两份`,
      );
      assert.deepEqual(
        events.filter((e) => e.type === 'error').map((e) => (e.type === 'error' ? e.message : '')),
        [],
      );
    } finally {
      await brain.dispose();
    }
  });

  test('先用 withMic=false 起会话，再 start(true) 能补上麦克风', async () => {
    const { desktop } = fakeDesktop();
    const brain = new Brain({ desktop });
    try {
      await brain.start(false);
      assert.equal(audio.getUserMediaCalls, 0, '纯打字模式不该弹权限对话框');
      await brain.start(true);
      assert.equal(audio.getUserMediaCalls, 1, '后来开语音要能真的把麦打开');
      assert.equal(FakeWebSocket.instances.length, 1);
    } finally {
      await brain.dispose();
    }
  });

  test('并发 start 里混着 withMic=false 也不会丢掉麦克风', async () => {
    const { desktop } = fakeDesktop();
    const brain = new Brain({ desktop });
    try {
      // sendText 走的是 start(false)，和启动时的 start(true) 撞在一起过。
      await Promise.all([brain.start(false), brain.start(true)]);
      assert.equal(FakeWebSocket.instances.length, 1);
      assert.equal(audio.getUserMediaCalls, 1, '被去重的那次 start 不能把麦克风一起吞掉');
    } finally {
      await brain.dispose();
    }
  });

  test('stop 之后再 start 是干净的一套，旧的麦克风被放掉', async () => {
    const { desktop } = fakeDesktop();
    const brain = new Brain({ desktop });
    try {
      await brain.start(true);
      await brain.stop();
      assert.equal(audio.liveTracks, 0, '停掉之后必须放开麦克风，否则录音指示灯不灭');
      await brain.start(true);
      assert.equal(FakeWebSocket.instances.length, 2);
      assert.equal(audio.liveTracks, 1);
    } finally {
      await brain.dispose();
      assert.equal(audio.liveTracks, 0);
    }
  });
});

describe('Brain：两个开关从设置里读、并能运行时应用', () => {
  let audio: AudioStubs;
  beforeEach(() => {
    resetWebSocket();
    audio = stubAudio();
  });
  afterEach(async () => {
    await cleanupSessions();
    audio.restore();
  });

  /**
   * 喂几帧音频给会话内部的 MicStream 回调。
   *
   * 这里跑不了真麦克风（没有 AudioWorklet），但按住说话的下限判定数的就是帧数，
   * 所以直接走 onFrame 回调。真实采集链路仍然未验证。
   */
  function feedFrames(brain: Brain, frames = MIN_PUSH_TO_TALK_FRAMES) {
    const mic = (brain as unknown as { session: { mic: { events: { onFrame: (b: string) => void } } } })
      .session.mic;
    for (let i = 0; i < frames; i++) mic.events.onFrame('AAAA');
  }

  test('listening=false 时启动不申请麦克风权限，第一次长按才申请', async () => {
    const { desktop } = fakeDesktop({ settings: { listening: false } });
    const brain = new Brain({ desktop });
    try {
      await brain.start(true);
      assert.equal(
        audio.getUserMediaCalls,
        0,
        '按住说话模式下应用一启动就申请麦克风是不可接受的',
      );
      FakeWebSocket.instances[0].open();
      const update = FakeWebSocket.instances[0].framesOf('session.update')[0].session as Record<
        string,
        unknown
      >;
      assert.equal(update.turn_detection, null);

      await brain.beginPushToTalk();
      assert.equal(audio.getUserMediaCalls, 1, '第一次长按才申请权限');
      assert.equal(brain.pushToTalkActive, true);
      // 模拟采集到了够长的一段音频（真麦克风在这里测不了）。
      feedFrames(brain);
      brain.endPushToTalk();
      assert.equal(audio.liveTracks, 0, '松手要放开麦克风');
      const types = FakeWebSocket.instances[0].sentTypes();
      assert.ok(types.includes('input_audio_buffer.commit'));
      assert.ok(types.includes('response.create'));
    } finally {
      await brain.dispose();
    }
  });

  test('refreshSettings 把新开关值应用到正在进行的会话上', async () => {
    const { desktop } = fakeDesktop({ settings: { listening: true, voiceInterruptible: false } });
    const brain = new Brain({ desktop });
    try {
      await brain.start(true);
      FakeWebSocket.instances[0].open();
      const ws = FakeWebSocket.instances[0];
      assert.equal(brain.listening, true);
      assert.equal(brain.voiceInterruptible, false);

      // 用户在托盘里改了两个开关。
      await desktop.setSettings({ listening: false, voiceInterruptible: true });
      ws.sent.length = 0;
      const applied = await brain.refreshSettings();
      assert.equal(applied.listening, false);
      assert.equal(brain.listening, false);
      assert.equal(brain.voiceInterruptible, true);

      // turn_detection 走热改，不重建连接。
      assert.equal(FakeWebSocket.instances.length, 1, '改开关不该重建会话');
      const update = ws.framesOf('session.update').at(-1)!.session as Record<string, unknown>;
      assert.equal(update.turn_detection, null, '新的聆听模式必须真的推下去');
      assert.equal(audio.liveTracks, 0, '切到按住说话要把常开的麦放掉');
      // instructions 也要跟着更新，让她知道用户现在得长按才能说话。
      assert.match(String(update.instructions), /长按/);
    } finally {
      await brain.dispose();
    }
  });

  test('refreshSettings 在会话没起来时不炸', async () => {
    const { desktop } = fakeDesktop();
    const brain = new Brain({ desktop });
    const settings = await brain.refreshSettings();
    assert.equal(settings.listening, true);
    await brain.dispose();
  });

  test('beginPushToTalk 在会话还没起来时会先把会话起起来', async () => {
    const { desktop } = fakeDesktop({ settings: { listening: false } });
    const brain = new Brain({ desktop });
    try {
      await brain.beginPushToTalk();
      assert.equal(FakeWebSocket.instances.length, 1, '长按应当顺手把会话起起来');
      assert.equal(audio.getUserMediaCalls, 1);
    } finally {
      await brain.dispose();
    }
  });
});

describe('persona：两个开关如实写进 instructions', () => {
  test('按住说话模式下告诉她「按住我说」，而不是「你说吧」', () => {
    const text = buildInstructions({
      settings: { ...defaultSettings, listening: false },
      desktopAvailable: true,
    });
    assert.match(text, /持续聆听：已关闭/);
    assert.match(text, /长按/);
    const on = buildInstructions({
      settings: { ...defaultSettings, listening: true },
      desktopAvailable: true,
    });
    assert.match(on, /持续聆听：已开启/);
  });

  test('不可打断时仍然要求她说短话（用户想插话得专门按键）', () => {
    const text = buildInstructions({
      settings: { ...defaultSettings, voiceInterruptible: false },
      desktopAvailable: true,
    });
    assert.match(text, /语音打断：已关闭/);
    assert.match(text, /1~3 句/);
    const on = buildInstructions({
      settings: { ...defaultSettings, voiceInterruptible: true },
      desktopAvailable: true,
    });
    assert.match(on, /语音打断：已开启/);
  });

  test('默认值与契约一致：聆听开、语音打断关', () => {
    assert.equal(defaultSettings.listening, true);
    assert.equal(defaultSettings.voiceInterruptible, false);
  });
});


describe('活动状态：不能卡在 speaking', () => {
  // 必须和其他 RealtimeSession 的 describe 一样装 WebSocket 替身 ——
  // 漏了的话会去连真 WebSocket，于是一个事件都收不到、测试以 undefined 失败。
  beforeEach(resetWebSocket);
  afterEach(cleanupSessions);

  // 卡在 speaking 是静默故障：用户只会看到「气泡不消失、点她不说话、说话没反应」。
  // 原因是退出条件原本分散在 onDrained(!responseActive) 和
  // response.done(!audioLevel) 两处，两个条件互锁 —— 都不命中就永久卡住。
  const lastActivity = (events: PetEvent[]): string | undefined => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.type === 'activity') return e.value;
    }
    return undefined;
  };

  test('drained 早于 response.done 且当时仍在出声，最终仍要回到 listening', () => {
    const { ws, events, speech } = makeSession();
    ws.deliver({ type: 'response.created', response: {} });
    speech.beginSpeaking();
    speech.drain(); // 句中的一次环空：responseActive 仍为 true，不该改状态
    assert.equal(lastActivity(events), 'speaking', '句中环空不该提前回到 listening');
    ws.deliver({ type: 'response.done', response: { status: 'completed' } });
    speech.level = 0;
    speech.drain();
    // 断言的是「离开了 speaking」。具体落到 listening 还是 idle 取决于麦克风
    // 开没开，而 makeSession 绕过了 start()，所以这里不该钉死那个分支。
    assert.notEqual(lastActivity(events), 'speaking', '最终必须退出 speaking');
  });

  test('response.done 时音频已播完则立刻退出 speaking', () => {
    const { ws, events, speech } = makeSession();
    ws.deliver({ type: 'response.created', response: {} });
    speech.beginSpeaking();
    // 「播完了」要用 drain() 表达，不是把电平设成 0。
    // 这条测试原来写的是 `speech.level = 0`，而**电平归零不等于播完** ——
    // 句中每一次欠载都会让它归零。用电平当判据正是「关了开关还是被打断」
    // 的根因之一，所以这里也必须按真实语义写。
    speech.drain();
    ws.deliver({ type: 'response.done', response: { status: 'completed' } });
    assert.notEqual(lastActivity(events), 'speaking');
  });

  test('欠载（电平瞬时归零）不算播完，仍然是 speaking', () => {
    const { ws, events, speech } = makeSession();
    ws.deliver({ type: 'response.created', response: {} });
    speech.beginSpeaking();
    speech.underrun(); // 网络卡一下，电平掉到 0，但环里还有尾音
    ws.deliver({ type: 'response.done', response: { status: 'completed' } });
    assert.equal(
      lastActivity(events),
      'speaking',
      '她还在出声就不能退出 speaking —— 退出会让打断门控失效',
    );
  });
});

/** 最后一次 activity 事件的值。模块级，给下面几个 describe 共用。 */
function lastActivityOf(events: PetEvent[]): string | undefined {
  const list = events.filter((e) => e.type === 'activity');
  const last = list.at(-1);
  return last && last.type === 'activity' ? last.value : undefined;
}

// ---------------------------------------------------------------------------
// 一次独立评审查出的一批状态机缺陷的回归测试。
//
// 这批缺陷有个共同点：**全都是无声失败**，而且大半只在特定事件序列下出现
// （重连、30 分钟轮换、事件乱序、欠载）。它们在真机上表现为用户报的两句话：
// 「ASR 气泡有时卡住不消失」和「关了『允许说话打断她』还是会被打断」。
// 没有这些测试就无法确认修好了 —— 只能等用户再碰上一次。
// ---------------------------------------------------------------------------

describe('回归：「关了开关还是被打断」的三个独立根因', () => {
  beforeEach(resetWebSocket);
  afterEach(cleanupSessions);

  test('D2 尾音期间（responseActive 已清零）不能被打断', () => {
    const harness = makeSession({ interruptible: false });
    harness.ws.deliver({ type: 'response.created', response: { id: 'r1' } });
    harness.speech.beginSpeaking();
    // 模型出音快于播放：这一轮在服务端已经结束，但环里还压着尾音。
    harness.ws.deliver({ type: 'response.done', response: { id: 'r1', status: 'completed' } });
    // 而且恰好赶上一次欠载 —— 瞬时电平也是 0。
    // **两个条件必须同时摆出来**，否则这条测试没有区分力：旧判据是
    // `responseActive || audioLevel > 0`，只满足一个的话它照样认为她在说话，
    // 测试在修复前后都绿，等于什么都没测。
    harness.speech.underrun();
    assert.equal(harness.speech.playing, true, '前提：她还在出声（环里有尾音）');
    const flushesBefore = harness.speech.flushes;
    harness.ws.sent.length = 0;

    harness.ws.deliver({ type: 'input_audio_buffer.speech_started', audio_start_ms: 0 });

    assert.equal(harness.speech.flushes, flushesBefore, '不该 flush 掉她的尾音');
    assert.equal(
      harness.ws.sentTypes().includes('response.cancel'),
      false,
      '不该发 response.cancel',
    );
    assert.equal(harness.speech.ducked, false, '开关关着连压音量都不该做');
  });

  test('D2 欠载（电平瞬时归零）期间也不能被打断', () => {
    const harness = makeSession({ interruptible: false });
    harness.ws.deliver({ type: 'response.created', response: { id: 'r1' } });
    harness.speech.beginSpeaking();
    harness.speech.underrun(); // 网络卡一下
    const flushesBefore = harness.speech.flushes;
    harness.ws.sent.length = 0;

    harness.ws.deliver({ type: 'input_audio_buffer.speech_started', audio_start_ms: 0 });

    assert.equal(harness.speech.flushes, flushesBefore, '欠载那一瞬不该变成可打断');
  });

  test('D3 她说话期间掐断音频上行，服务端才没法自己开回合', () => {
    const harness = makeSession({ interruptible: false });
    harness.ws.deliver({ type: 'response.created', response: { id: 'r1' } });
    harness.speech.beginSpeaking();
    harness.ws.sent.length = 0;

    harness.ws.deliver({ type: 'input_audio_buffer.speech_started', audio_start_ms: 0 });
    assert.ok(
      harness.ws.sentTypes().includes('input_audio_buffer.clear'),
      '必须清掉服务端已经堆起来的音频，否则那一段就够它开一个回合',
    );

    harness.ws.sent.length = 0;
    harness.mic.feed(5);
    assert.equal(
      harness.ws.framesOf('input_audio_buffer.append').length,
      0,
      '她说话期间不能再往上传音频 —— 服务端 VAD 会自己 commit 并在服务端截断她',
    );
  });

  test('D3 她说完之后音频上行必须恢复（否则她再也听不见）', () => {
    const harness = makeSession({ interruptible: false });
    harness.ws.deliver({ type: 'response.created', response: { id: 'r1' } });
    harness.speech.beginSpeaking();
    harness.ws.deliver({ type: 'input_audio_buffer.speech_started', audio_start_ms: 0 });
    harness.ws.deliver({ type: 'input_audio_buffer.speech_stopped', audio_end_ms: 100 });

    // 她说完了：这一轮结束 + 音频播完。
    harness.ws.deliver({ type: 'response.done', response: { id: 'r1', status: 'completed' } });
    harness.speech.drain();

    harness.ws.sent.length = 0;
    harness.mic.feed(3);
    assert.equal(
      harness.ws.framesOf('input_audio_buffer.append').length,
      3,
      '她说完之后必须恢复上行',
    );
  });

  test('D3 手动打断（Esc/长按）之后音频上行也要恢复', () => {
    const harness = makeSession({ interruptible: false });
    harness.ws.deliver({ type: 'response.created', response: { id: 'r1' } });
    harness.speech.beginSpeaking();
    harness.ws.deliver({ type: 'input_audio_buffer.speech_started', audio_start_ms: 0 });

    harness.session.interrupt(); // 用户按 Esc

    harness.ws.sent.length = 0;
    harness.mic.feed(2);
    assert.equal(
      harness.ws.framesOf('input_audio_buffer.append').length,
      2,
      '打断成功却收不到后续音频 = 「打断了但她再也听不见」',
    );
  });

  test('D8 上一轮迟到的 response.done 不能把新一轮判成已结束', () => {
    const harness = makeSession({ interruptible: false });
    harness.ws.deliver({ type: 'response.created', response: { id: 'r1' } });
    // 服务端 VAD 在 r1 收尾前自己开了 r2（已实测会发生）。
    harness.ws.deliver({ type: 'response.created', response: { id: 'r2' } });
    // 关键：r2 的音频还在预缓冲，环里**还没有**东西 —— 所以播放侧的
    // `speaking` 是假的，此刻唯一撑着「她在忙」的就是 responseActive。
    // 必须这么摆，否则 D2 的去抖判据会把这条测试兜住，id 比对是真是假都看不出来。
    assert.equal(harness.speech.playing, false, '前提：音频还没开始播');
    const flushesBefore = harness.speech.flushes;

    // r1 的 done 迟到。不对 id 的话它会把 r2 的 responseActive 清零。
    harness.ws.deliver({ type: 'response.done', response: { id: 'r1', status: 'completed' } });
    harness.ws.deliver({ type: 'input_audio_buffer.speech_started', audio_start_ms: 0 });

    assert.equal(
      harness.speech.flushes,
      flushesBefore,
      'r2 还在生成，不能因为 r1 的 done 就执行不可逆打断（后果是她这一轮整段不说话）',
    );
  });
});

describe('回归：「ASR 气泡卡住不消失」', () => {
  beforeEach(resetWebSocket);
  afterEach(cleanupSessions);

  /** 收集「把用户气泡收掉」的信号：final=true（UI 对 final 一律清空，不看内容）。 */
  const clearedUserBubble = (events: PetEvent[]) =>
    events.some((e) => e.type === 'user_transcript' && e.final && e.text === '');

  test('空转写也要发 final —— 否则 delta 推上去的半个字永久留着', () => {
    const { ws, events } = makeSession();
    ws.deliver({ type: 'conversation.item.input_audio_transcription.delta', delta: '呃' });
    events.length = 0;
    ws.deliver({ type: 'conversation.item.input_audio_transcription.completed', transcript: '' });
    assert.ok(clearedUserBubble(events), '空转写必须把气泡收掉');
  });

  test('转写失败也要发 final（而不是被当成未知事件丢掉）', () => {
    const { ws, events } = makeSession();
    ws.deliver({ type: 'conversation.item.input_audio_transcription.delta', delta: '我想问一下' });
    events.length = 0;
    ws.deliver({
      type: 'conversation.item.input_audio_transcription.failed',
      error: { message: 'asr failed' },
    });
    assert.ok(clearedUserBubble(events), 'ASR 失败必须把气泡收掉');
  });

  test('连接断开要把在途转写清掉（持续聆听下 activity 永不回 idle，这是唯一的清空路径）', () => {
    const { ws, events } = makeSession();
    ws.deliver({ type: 'conversation.item.input_audio_transcription.delta', delta: '我想问一下' });
    events.length = 0;
    ws.fire('close', { code: 1006, reason: '' });
    assert.ok(clearedUserBubble(events), '断线必须把气泡收掉，否则它再也不会消失');
  });

  test('D12 delta 字段缺失时忽略这一条，不要把旧文本重放一遍', () => {
    const { ws, events } = makeSession();
    ws.deliver({ type: 'conversation.item.input_audio_transcription.delta', delta: '上一句' });
    events.length = 0;
    ws.deliver({ type: 'conversation.item.input_audio_transcription.delta' });
    assert.equal(
      events.filter((e) => e.type === 'user_transcript').length,
      0,
      'delta 缺失不是「内容没变」，不能拿旧值再 emit 一遍',
    );
  });

  test('D7 responseActive 不能跨断线泄漏（否则重连后用户说话界面毫无反应）', () => {
    const harness = makeSession({ interruptible: false });
    harness.ws.deliver({ type: 'response.created', response: { id: 'r1' } });
    harness.speech.beginSpeaking();
    harness.ws.fire('close', { code: 1006, reason: '' });

    // 重连后用户开口：speech_started/stopped 必须被正常处理，不能被
    // 「她还在说话」的残留状态一起吃掉。
    const next = FakeWebSocket.instances.at(-1)!;
    next.open();
    harness.events.length = 0;
    next.deliver({ type: 'input_audio_buffer.speech_started', audio_start_ms: 0 });
    next.deliver({ type: 'input_audio_buffer.speech_stopped', audio_end_ms: 500 });
    assert.ok(
      harness.events.some((e) => e.type === 'activity' && e.value === 'thinking'),
      '重连后这一轮必须照常走到 thinking，否则用户说完话界面毫无反应',
    );
  });
});

describe('回归：卡在 thinking（永久三点气泡 + 点她不说话）', () => {
  beforeEach(resetWebSocket);
  afterEach(cleanupSessions);

  test('连接不可用时 sendText 必须出声报错，而不是悄悄卡在 thinking', () => {
    const { session, ws, events } = makeSession();
    ws.readyState = 3; // 连接死了，但 session 还在
    events.length = 0;
    session.sendText('你好');

    assert.ok(
      events.some((e) => e.type === 'error'),
      '发送失败必须报错 —— 静默丢弃会让用户以为自己没说清楚',
    );
    assert.notEqual(
      lastActivityOf(events),
      'thinking',
      '发不出去就不能切到 thinking（出不来）',
    );
  });

  test('发送失败会踢一次重连（提示语承诺的「点一下她再试」要真的成立）', () => {
    const { session, ws } = makeSession();
    ws.readyState = 3;
    const before = FakeWebSocket.instances.length;
    session.sendText('你好');
    assert.ok(
      FakeWebSocket.instances.length > before,
      '必须真的重建连接，否则那句提示是空的',
    );
  });

  test('response.cancelled 之后活动状态要落地（它不会再来 response.done）', () => {
    const { session, ws, events } = makeSession();
    // 把她摆进「在想」：VAD 收到一句话、服务端开始生成。
    ws.deliver({ type: 'input_audio_buffer.speech_started', audio_start_ms: 0 });
    ws.deliver({ type: 'input_audio_buffer.speech_stopped', audio_end_ms: 500 });
    ws.deliver({ type: 'response.created', response: { id: 'r1' } });
    assert.equal(lastActivityOf(events), 'thinking', '前提：停在 thinking');

    session.interrupt(); // 用户按 Esc
    events.length = 0;
    ws.deliver({ type: 'response.cancelled' });

    // **必须是正向断言。** 写成「最后一次 activity 不是 thinking」是没用的：
    // 漏发事件的时候 events 里一条 activity 都没有，断言对着 undefined
    // 平凡通过 —— 测试在修复前后都绿。
    assert.equal(
      lastActivityOf(events),
      'idle',
      'cancelled 之后不会再有 response.done，必须自己把活动状态落地，否则永久停在 thinking',
    );
  });

  test('看门狗兜住卡死的 thinking，并且告诉用户', async () => {
    const { session, ws, events } = makeSession();
    await session.start(false).catch(() => {});
    ws.deliver({ type: 'input_audio_buffer.speech_started', audio_start_ms: 0 });
    ws.deliver({ type: 'input_audio_buffer.speech_stopped', audio_end_ms: 500 });
    assert.equal(lastActivityOf(events), 'thinking', '前提：停在 thinking');

    // 服务端判这段是噪声，不开回合 —— 没有任何事件能把她拉出来。
    // 把进入 thinking 的时刻拨到过去，等一个看门狗周期（500ms）。
    (session as unknown as { thinkingSince: number }).thinkingSince = Date.now() - 60_000;
    events.length = 0;
    await new Promise((r) => setTimeout(r, 700));

    assert.notEqual(lastActivityOf(events), 'thinking', '看门狗必须把它复位');
    assert.ok(
      events.some((e) => e.type === 'error'),
      '必须告诉用户这一句没被回应 —— 静默复位会让人再说一遍',
    );
  });
});

describe('回归：持续聆听下的长按（此前是死代码，现在默认会走到）', () => {
  beforeEach(resetWebSocket);
  afterEach(cleanupSessions);

  // App 侧原来用 `!brain.listening` 门控长按，而 listening 默认 true ——
  // 于是 beginPushToTalk() 永远不被调用，会话里这条分支从没执行过。
  // 门控修好之后它成了默认路径，所以必须有测试。

  test('长按让她立刻停下，但不另开一路麦克风', async () => {
    const harness = makeSession({ listening: true });
    await harness.session.start(false).catch(() => {});
    harness.ws.deliver({ type: 'response.created', response: { id: 'r1' } });
    harness.speech.beginSpeaking();
    const micStarts = harness.mic.starts;
    const flushesBefore = harness.speech.flushes;

    await harness.session.beginPushToTalk();

    assert.ok(harness.speech.flushes > flushesBefore, '长按是明确的打断意图，必须止声');
    assert.equal(
      harness.mic.starts,
      micStarts,
      '持续聆听下麦克风本来就开着，不该再开一路（断句仍交给服务端 VAD）',
    );
    assert.equal(harness.session.pushToTalkActive, false, '连续模式下长按只是个手势');
  });

  test('松手是安全的空操作，不会提交空缓冲（服务端会为此回两个错）', async () => {
    const harness = makeSession({ listening: true });
    await harness.session.start(false).catch(() => {});
    await harness.session.beginPushToTalk();
    harness.ws.sent.length = 0;

    harness.session.endPushToTalk();

    assert.equal(
      harness.ws.sentTypes().includes('input_audio_buffer.commit'),
      false,
      '连续模式下松手不该 commit —— 断句是服务端 VAD 的事',
    );
  });

  test('长按打断之后音频上行要恢复（否则打断了却再也听不见）', async () => {
    const harness = makeSession({ listening: true, interruptible: false });
    await harness.session.start(false).catch(() => {});
    harness.ws.deliver({ type: 'response.created', response: { id: 'r1' } });
    harness.speech.beginSpeaking();
    // 她说话期间环境噪声触发了 VAD → 上行被掐断。
    harness.ws.deliver({ type: 'input_audio_buffer.speech_started', audio_start_ms: 0 });

    await harness.session.beginPushToTalk(); // 用户长按插话

    harness.ws.sent.length = 0;
    harness.mic.feed(3);
    assert.equal(
      harness.ws.framesOf('input_audio_buffer.append').length,
      3,
      '长按后说的话必须传得上去',
    );
  });
});

describe('回归：turn_start —— 回合边界必须由会话层告诉 UI，不能让它猜', () => {
  beforeEach(resetWebSocket);
  afterEach(cleanupSessions);

  // 症状：「有的时候只有语音，不显示聊天气泡」。
  //
  // UI 原来靠「活动状态跨进忙」这个边沿推断「新回合开始了，把上一句收掉」。
  // 但同一次交互里可能有**第二个 response**（工具回调之后那次、服务端 VAD
  // 自己开的那次），它不经过 thinking —— 于是本轮字幕先到、边沿后到，
  // UI 把刚到的新字幕当成上一句清掉了。

  /** 事件类型序列，用来断言顺序。 */
  const typesOf = (events: PetEvent[]) => events.map((e) => e.type);

  test('turn_start 先于本轮任何字幕', () => {
    const { ws, events } = makeSession();
    events.length = 0;
    ws.deliver({ type: 'response.created', response: { id: 'r1' } });
    ws.deliver({ type: 'response.audio_transcript.delta', delta: '我' });

    const types = typesOf(events);
    const start = types.indexOf('turn_start');
    const first = types.indexOf('pet_transcript');
    assert.ok(start >= 0, '必须发 turn_start');
    assert.ok(first >= 0, '前提：有字幕');
    assert.ok(start < first, 'turn_start 必须先到，否则 UI 会把新字幕当旧话清掉');
  });

  test('同一次交互里的第二个 response 也要发（工具回调之后那一次）', () => {
    const { ws, events } = makeSession();
    // 第一轮：她说「我看一下」。
    ws.deliver({ type: 'response.created', response: { id: 'r1' } });
    ws.deliver({ type: 'response.audio_transcript.delta', delta: '我看一下' });
    ws.deliver({ type: 'response.done', response: { id: 'r1', status: 'completed' } });
    events.length = 0;

    // 工具跑完，服务端开第二轮说真正的答案 —— **不经过 thinking**。
    ws.deliver({ type: 'response.created', response: { id: 'r2' } });
    ws.deliver({ type: 'response.audio_transcript.delta', delta: '现在八点半' });

    const types = typesOf(events);
    assert.ok(
      types.indexOf('turn_start') >= 0 &&
        types.indexOf('turn_start') < types.indexOf('pet_transcript'),
      '第二个 response 同样要先发 turn_start —— 这一轮没有 thinking 可供 UI 推断',
    );
    assert.equal(
      types.filter((t) => t === 'activity').length,
      0,
      '前提：这一轮确实没有活动状态变化（所以边沿推断必然失效）',
    );
  });

  test('被打断后重开的那一轮也要发', () => {
    const { session, ws, events } = makeSession();
    ws.deliver({ type: 'response.created', response: { id: 'r1' } });
    session.interrupt();
    events.length = 0;
    ws.deliver({ type: 'response.created', response: { id: 'r2' } });
    assert.ok(typesOf(events).includes('turn_start'));
  });
});

describe('回归：30 分钟轮换要等她说完，但不能无限等', () => {
  beforeEach(resetWebSocket);
  afterEach(cleanupSessions);

  /** 私有的 rotate()，测试里直接驱动（真实触发要等 28.5 分钟）。 */
  const rotate = (session: RealtimeSession, waitForQuiet = true) =>
    (session as unknown as { rotate: (w: boolean) => Promise<void> }).rotate(waitForQuiet);

  test('她还在说话时不切，说完才切', async () => {
    const harness = makeSession();
    (harness.session as unknown as { started: boolean }).started = true;
    harness.ws.deliver({ type: 'response.created', response: { id: 'r1' } });
    harness.speech.beginSpeaking();

    const done = rotate(harness.session);
    // **必须等过 4.5 秒**。原来的实现是「固定等 4 秒然后不再复查」，
    // 只等几百毫秒的话它也还没切，测试在修复前后都绿 —— 等于没测。
    // 一句长回复（她偶尔会说三四句）超过 4 秒很常见，那正是被切断的现场。
    await new Promise((r) => setTimeout(r, 4600));
    assert.equal(
      harness.ws.closed,
      null,
      '她还在说话就不能切会话 —— 原来固定等 4 秒就切，超过 4 秒的回复直接被砍在半句上',
    );

    // 她说完了（这一轮结束 + 音频播完）。
    harness.ws.deliver({ type: 'response.done', response: { id: 'r1', status: 'completed' } });
    harness.speech.drain();
    await done;
    assert.ok(harness.ws.closed, '说完之后应当切掉旧连接');
    assert.ok(FakeWebSocket.instances.length >= 2, '并且建起新连接');
  });

  // 注意：这条抓不到「固定等待」那个缺陷（旧实现在 !responseActive 时也立刻返回），
  // 它钉的是另一个性质 —— 修成轮询之后不能反而引入无条件的等待。
  test('她没在说话就立刻切，不白等', async () => {
    const harness = makeSession();
    (harness.session as unknown as { started: boolean }).started = true;
    const t0 = Date.now();
    await rotate(harness.session);
    assert.ok(
      Date.now() - t0 < 300,
      `空闲时不该等（实际等了 ${Date.now() - t0}ms）—— 原来短回复也要白等满 4 秒`,
    );
    assert.ok(harness.ws.closed);
  });

  test('换音色不等她说完 —— 用户点出来的操作要立刻生效', async () => {
    // setVoice() 也走 rotate()。等她说完在这里是错的：用户在托盘里点了新音色，
    // 等最长 60 秒没反应只会以为点坏了。宁可把当前这句掐掉。
    const harness = makeSession();
    (harness.session as unknown as { started: boolean }).started = true;
    harness.ws.deliver({ type: 'response.created', response: { id: 'r1' } });
    harness.speech.beginSpeaking();

    const t0 = Date.now();
    await rotate(harness.session, false);
    assert.ok(
      Date.now() - t0 < 300,
      `换音色不该等（实际等了 ${Date.now() - t0}ms）`,
    );
    assert.ok(harness.ws.closed, '应当立刻切掉旧连接');
  });

  test('stop() 之后不再傻等（否则 stop 完还挂着定时器）', async () => {
    const harness = makeSession();
    (harness.session as unknown as { started: boolean }).started = true;
    harness.ws.deliver({ type: 'response.created', response: { id: 'r1' } });
    harness.speech.beginSpeaking();

    const done = rotate(harness.session);
    await harness.session.stop();
    // 不该挂在那儿等满 60 秒的硬超时。
    await Promise.race([
      done,
      new Promise((_, reject) => setTimeout(() => reject(Error('rotate 在 stop 之后还在等')), 2000)),
    ]);
  });
});
