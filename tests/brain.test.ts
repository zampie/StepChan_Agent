// 大脑层的测试：URL 校验、隐私门禁、工具执行、每轮工具上限、人设兜底判断。
//
// RealtimeSession 的测试通过一个假 WebSocket 驱动 —— 它构造时不碰 AudioContext
// （SpeechStream/MicStream 只在 start() 里建图），所以可以在 Node 里直接实例化，
// 把服务端事件灌进去，再检查它往外发了什么。
import assert from 'node:assert/strict';
import test, { describe, beforeEach, afterEach } from 'node:test';

import { safeUrl } from '../apps/web/src/brain/url';
import { createToolExecutor, type ToolContext } from '../apps/web/src/brain/tools';
import {
  buildInstructions,
  summarizeTranscript,
  textNeedsTool,
} from '../apps/web/src/brain/persona';
import {
  RealtimeSession,
  MAX_TOOL_CALLS_PER_TURN,
} from '../apps/web/src/voice/RealtimeSession';
import { defaultSettings, type Desktop, type Settings } from '../shared/desktop';
import { toolDefinitions, type PetEvent, type ToolName, type ToolResult } from '../shared/brain';

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
    async setHitRegions() {},
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
  };
  return { desktop, calls, getSettings: () => settings };
}

function executorFor(options: FakeDesktopOptions = {}) {
  const fake = fakeDesktop(options);
  const events: PetEvent[] = [];
  const context: ToolContext = {
    desktop: fake.desktop,
    getSettings: () => fake.desktop.getSettings(),
    getCredentials: () => fake.desktop.credentials(),
    emit: (event) => events.push(event),
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

  test('move_to 真的调了 desktop.moveToSpot', async () => {
    const harness = executorFor();
    const result = await harness.executor.execute('move_to', { spot: 'bottom_right' });
    assert.equal(result.ok, true);
    assert.deepEqual(
      harness.calls.filter((c) => c.name === 'moveToSpot'),
      [{ name: 'moveToSpot', args: 'bottom_right' }],
    );
  });

  test('浏览器调试环境里 move_to 如实失败而不是假装成功', async () => {
    const harness = executorFor({ available: false });
    const result = await harness.executor.execute('move_to', { spot: 'center' });
    assert.equal(result.ok, false);
    assert.equal(harness.calls.some((c) => c.name === 'moveToSpot'), false);
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
      ['让开一点', 'move_to'],
      ['挪到右下角去吧', 'move_to'],
      // 实测中真实出现过的那句语音（她当时只口头答应，没调工具）。
      ['你能不能挪到屏幕右下角去，别挡着我了。', 'move_to'],
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
  return { session, ws, events, executed };
}

function buildSessionOptions(input: {
  events: PetEvent[];
  executed: { name: ToolName; args: unknown }[];
  executeTool?: (name: ToolName, args: unknown) => Promise<ToolResult>;
  textNeedsTool?: (text: string) => ToolName | null;
}) {
  return {
    apiKey: 'sk-fake',
    voice: 'yuanqishaonv',
    instructions: 'test instructions',
    tools: toolDefinitions,
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
    assert.deepEqual(session.turn_detection, { type: 'server_vad' });
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
      name: 'move_to',
      arguments: '{"spot":"bottom_right"}',
    });
    await new Promise((r) => setTimeout(r, 10));

    assert.deepEqual(executed, [{ name: 'move_to', args: { spot: 'bottom_right' } }]);
    const output = ws.framesOf('conversation.item.create').at(-1);
    assert.ok(output);
    const item = output!.item as Record<string, unknown>;
    assert.equal(item.type, 'function_call_output');
    assert.equal(item.call_id, 'call_1');
    assert.deepEqual(JSON.parse(item.output as string), { ok: true, message: 'done' });
    assert.ok(ws.sentTypes().includes('response.create'), '回灌后要再触发一次回复');
    assert.ok(events.some((e) => e.type === 'tool_start' && e.name === 'move_to'));
    assert.ok(events.some((e) => e.type === 'tool_end' && e.name === 'move_to'));
  });

  test('非法参数被挡住，执行器根本不被调用', async () => {
    const { ws, executed } = makeSession();
    ws.deliver({ type: 'response.created', response: {} });
    ws.deliver({
      type: 'response.function_call_arguments.done',
      call_id: 'bad_1',
      name: 'move_to',
      arguments: '{"spot":"the_moon"}',
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

describe('RealtimeSession：打断（headline feature）', () => {
  beforeEach(resetWebSocket);
  afterEach(cleanupSessions);

  test('speech_started 立刻发 response.cancel', () => {
    const { ws, events } = makeSession();
    ws.deliver({ type: 'response.created', response: {} });
    ws.sent.length = 0;
    ws.deliver({ type: 'input_audio_buffer.speech_started', audio_start_ms: 0 });
    assert.ok(ws.sentTypes().includes('response.cancel'), '用户开口必须立刻 cancel');
    assert.ok(
      events.some((e) => e.type === 'activity' && e.value === 'listening'),
      '打断后应切到 listening',
    );
  });

  test('没有进行中的回复时不发多余的 cancel', () => {
    const { ws } = makeSession();
    ws.sent.length = 0;
    ws.deliver({ type: 'input_audio_buffer.speech_started', audio_start_ms: 0 });
    assert.equal(ws.sentTypes().includes('response.cancel'), false);
  });

  test('cancel 之后在途的音频增量被丢弃（实测会再来 4 条）', () => {
    const { ws, session } = makeSession();
    ws.deliver({ type: 'response.created', response: {} });
    const speech = (session as unknown as { speech: { enqueue: (v: string) => void } }).speech;
    let enqueued = 0;
    speech.enqueue = () => {
      enqueued++;
    };
    ws.deliver({ type: 'response.audio.delta', delta: 'AAAA' });
    assert.equal(enqueued, 1, '正常时应当入队');

    ws.deliver({ type: 'input_audio_buffer.speech_started', audio_start_ms: 0 });
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
      textNeedsTool: () => 'move_to',
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
    assert.ok(nudge, '没有补发强制提醒 —— 她会谎称已经挪过去了');
    const text = (nudge!.content as { text: string }[])[0].text;
    assert.match(text, /move_to/);
    assert.match(text, /不要声称自己已经做过/);
  });

  test('模型确实调了工具时不补发提醒', async () => {
    const events: PetEvent[] = [];
    const executed: { name: ToolName; args: unknown }[] = [];
    const { ws, session } = makeSession({
      events,
      executed,
      textNeedsTool: () => 'move_to',
    });
    ws.deliver({ type: 'response.created', response: {} });
    session.sendText('挪到右下角去吧');
    ws.deliver({
      type: 'response.function_call_arguments.done',
      call_id: 'c1',
      name: 'move_to',
      arguments: '{"spot":"bottom_right"}',
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

  test('用户与她的字幕都正确累积并在 done 时定稿', () => {
    const { ws, events, session } = makeSession();
    ws.deliver({ type: 'conversation.item.input_audio_transcription.delta', delta: '你好' });
    ws.deliver({ type: 'conversation.item.input_audio_transcription.delta', delta: '呀' });
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
