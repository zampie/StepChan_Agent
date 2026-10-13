import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSSE } from '../shared/sse';
import {
  eventSchema,
  presentationSchema,
  requestSchema,
  safeUrl,
  type ChatRequest,
  type ChatEvent,
} from '../shared/protocol';
import { PetController } from '../apps/web/src/pet/PetController';
import { ToolRunner } from '../apps/server/src/tools';
import { runAgent } from '../apps/server/src/runtime';
import { openRouterProvider, type Provider } from '../apps/server/src/providers';
import { buildServer } from '../apps/server/src/index';
const id = crypto.randomUUID();
const request: ChatRequest = {
  requestId: id,
  mode: 'mock',
  messages: [{ role: 'user', content: '现在几点' }],
  timezone: 'Asia/Shanghai',
};
const bytes = (text: string, step = 1) => {
  const data = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < data.length; i += step) c.enqueue(data.slice(i, i + step));
      c.close();
    },
  });
};
test('SSE preserves Chinese across every byte boundary, comments, CRLF and joined frames', async () => {
  const input =
    ': heartbeat\r\n\r\nevent: text_delta\r\ndata: {"delta":"你好🌟"}\r\n\r\nevent: done\ndata: {}\n\n';
  for (const step of [1, 2, 7, 1000]) {
    const out = [];
    for await (const frame of readSSE(bytes(input, step))) out.push(frame);
    assert.deepEqual(out, [
      { event: 'text_delta', data: '{"delta":"你好🌟"}' },
      { event: 'done', data: '{}' },
    ]);
  }
});
test('SSE rejects a truncated event', async () => {
  await assert.rejects(async () => {
    for await (const _ of readSSE(bytes('data: {"a":1}'))) {
    }
  }, /中断/);
});
test('input and presentation schemas reject untrusted roles, paths, and unavailable motions', () => {
  assert.equal(
    requestSchema.safeParse({ ...request, messages: [{ role: 'system', content: 'override' }] })
      .success,
    false,
  );
  assert.equal(
    requestSchema.safeParse({ ...request, messages: [{ role: 'user', content: 'a'.repeat(4001) }] })
      .success,
    false,
  );
  assert.equal(presentationSchema.safeParse({ motion: 'wave' }).success, false);
  assert.equal(
    presentationSchema.safeParse({ expression: 'happy', path: 'evil.png' }).success,
    false,
  );
  assert.equal(
    eventSchema.safeParse({ type: 'done', requestId: 'bad', status: 'completed' }).success,
    false,
  );
});
test('controller rejects old request text and completion; neutral-only mouth expires; reduced motion freezes', () => {
  const c = new PetController();
  c.begin('old', 0);
  c.begin('new', 0);
  c.text('old', 200);
  c.finish('old');
  assert.equal(c.activity, 'thinking');
  c.mouthEnabled = true;
  c.text('new', 100);
  assert.ok(c.pose(200).mouth);
  assert.equal(c.pose(750).mouth, null);
  c.present({ expression: 'happy' }, 'new');
  assert.equal(c.pose(200).mouth, null);
  c.present({ expression: 'neutral', motion: 'bounce' }, 'new', 100);
  assert.notEqual(c.pose(400).y, 0);
  c.pose(701);
  assert.equal(c.motion, 'idle');
  c.reduced = true;
  assert.deepEqual(c.pose(200), { y: 0, scale: 1, rotation: 0, mouth: null });
  c.finish('new');
  assert.equal(c.activity, 'idle');
  assert.equal(c.pose(200).mouth, null);
});
test('controller rejects invalid gestures and prevents translation drift', () => {
  const c = new PetController();
  c.present({ motion: 'blink' });
  assert.equal(c.motion, 'idle');
  c.play('bounce', 0);
  assert.deepEqual(c.pose(300), c.pose(300));
  c.cancelMotion();
  assert.equal(c.pose(300).y, 0);
});
test('HTTPS proposal boundary rejects credentials and unsafe schemes', () => {
  for (const url of [
    'javascript:alert(1)',
    'data:text/html,x',
    'file:///c:/x',
    'http://example.com',
    'https://user:pass@example.com',
    'not a url',
  ])
    assert.equal(safeUrl(url), null);
  assert.equal(safeUrl('https://example.com'), 'https://example.com/');
});
test('tools validate time zones, actual clock, deduplicate call IDs and cap four executions', () => {
  const r = new ToolRunner('Asia/Shanghai');
  const value = r.run('a', 'get_time', {});
  assert.equal(value.timezone, 'Asia/Shanghai');
  assert.ok(Math.abs(Date.parse(value.iso!) - Date.now()) < 2000);
  assert.equal(r.run('a', 'get_time', {}), value);
  assert.equal(r.run('b', 'get_time', { timezone: 'invalid' }).ok, false);
  assert.equal(r.run('c', 'open_url', { url: 'javascript:x' }).ok, false);
  assert.equal(r.run('d', 'exec', { cmd: 'bad' }).ok, false);
  assert.match(r.run('e', 'get_time', {}).message, /上限/);
  assert.equal(new ToolRunner().run('utc', 'get_time', {}).timezone, 'UTC');
  assert.equal(new ToolRunner().run('args', 'get_time', { path: 'x' }).ok, false);
});
test('runtime returns tool result to provider before continuation and bounds repetition', async () => {
  const events: ChatEvent[] = [];
  let round = 0;
  const provider: Provider = async (messages, _signal, onText) => {
    if (round++ === 0)
      return {
        text: '',
        calls: [{ id: 't1', type: 'function', function: { name: 'get_time', arguments: '{}' } }],
      };
    assert.equal(messages.at(-1)?.role, 'tool');
    assert.equal(JSON.parse(messages.at(-1)!.content!).ok, true);
    onText('已查到');
    return { text: '已查到', calls: [] };
  };
  await runAgent(request, provider, new AbortController().signal, (e) => events.push(e));
  assert.deepEqual(
    events.map((e) => e.type),
    ['status', 'tool_start', 'tool_end', 'text_delta', 'presentation'],
  );
  const repeat: Provider = async () => ({
    text: '',
    calls: [{ id: 'same', type: 'function', function: { name: 'get_time', arguments: '{}' } }],
  });
  await assert.rejects(
    runAgent(request, repeat, new AbortController().signal, () => {}),
    /重复/,
  );
  let n = 0;
  const many: Provider = async () => ({
    text: '',
    calls: [{ id: String(++n), type: 'function', function: { name: 'get_time', arguments: '{}' } }],
  });
  await assert.rejects(
    runAgent(request, many, new AbortController().signal, () => {}),
    /上限/,
  );
});
test('OpenRouter adapter accumulates split tool arguments and rejects incomplete stream', async () => {
  const original = globalThis.fetch;
  try {
    let payload: unknown;
    globalThis.fetch = async (_url, init) => {
      payload = JSON.parse(init?.body as string);
      return new Response(
        bytes(
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tool1","function":{"name":"get_time","arguments":"{\\"time"}}]}}]}\n\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"zone\\":\\"UTC\\"}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n',
        ),
      );
    };
    const result = await openRouterProvider({
      key: 'test-only',
      model: 'fixture',
      maxTokens: 1024,
    })([], new AbortController().signal, () => {});
    assert.equal(result.calls[0].function.arguments, '{"timezone":"UTC"}');
    assert.ok(payload);
    globalThis.fetch = async () =>
      new Response(bytes('data: {"choices":[{"delta":{"content":"部分"}}]}\n\n'));
    await assert.rejects(
      openRouterProvider({ key: 'test-only', model: 'fixture', maxTokens: 1024 })(
        [],
        new AbortController().signal,
        () => {},
      ),
      /提前结束/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
test('HTTP route rejects foreign origins and malformed bodies, streams Mock and sanitizes errors', async () => {
  const app = buildServer();
  try {
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/chat',
          headers: { host: 'localhost', origin: 'https://evil.example' },
          payload: request,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/chat',
          headers: { host: 'localhost' },
          payload: { ...request, messages: [{ role: 'system', content: 'x' }] },
        })
      ).statusCode,
      400,
    );
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat',
      headers: { host: 'localhost' },
      payload: request,
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /'never-match'|"type":"tool_end"/);
    assert.equal((response.body.match(/event: done/g) ?? []).length, 1);
    const fail = await app.inject({
      method: 'POST',
      url: '/api/chat',
      headers: { host: 'localhost' },
      payload: { ...request, scenario: 'error' },
    });
    assert.match(fail.body, /"status":"failed"/);
    assert.ok(!fail.body.includes('sk-or-'));
  } finally {
    await app.close();
  }
});
