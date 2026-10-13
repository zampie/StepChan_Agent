import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streamChat } from '../apps/web/src/agent/AgentClient';
import type { ChatRequest, ChatEvent } from '../shared/protocol';
import { setImmediate as nextTurn } from 'node:timers/promises';
const id = crypto.randomUUID();
const request: ChatRequest = {
  requestId: id,
  mode: 'mock',
  messages: [{ role: 'user', content: '你好' }],
};
function response(events: unknown[]) {
  return new Response(
    events
      .map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`)
      .join(''),
  );
}
test('client ignores old request IDs, rejects invalid presentation and stops at first done', async () => {
  const original = globalThis.fetch;
  const received: ChatEvent[] = [];
  try {
    globalThis.fetch = async () =>
      response([
        { type: 'text_delta', requestId: crypto.randomUUID(), delta: 'late' },
        { type: 'presentation', requestId: id, motion: 'wave' },
        { type: 'text_delta', requestId: id, delta: '你好' },
        { type: 'done', requestId: id, status: 'completed' },
        { type: 'done', requestId: id, status: 'completed' },
        { type: 'text_delta', requestId: id, delta: 'too late' },
      ]);
    await streamChat(request, new AbortController().signal, (e) => received.push(e));
    assert.deepEqual(
      received.map((e) => e.type),
      ['text_delta', 'done'],
    );
  } finally {
    globalThis.fetch = original;
  }
});
test('client detects absent done and malformed JSON', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => response([{ type: 'text_delta', requestId: id, delta: '部分' }]);
    await assert.rejects(
      streamChat(request, new AbortController().signal, () => {}),
      /连接中断/,
    );
    globalThis.fetch = async () => new Response('event: text_delta\ndata: {broken}\n\n');
    await assert.rejects(
      streamChat(request, new AbortController().signal, () => {}),
      /损坏/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
test('client propagates cancellation to the network', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, options) =>
      new Promise((_resolve, reject) =>
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
          once: true,
        }),
      );
    const controller = new AbortController();
    const promise = streamChat(request, controller.signal, () => {});
    controller.abort(new Error('cancelled'));
    await assert.rejects(promise, /cancelled/);
  } finally {
    globalThis.fetch = original;
  }
});

test('client enforces 20-second initial response timeout', async (t) => {
  const original = globalThis.fetch;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    globalThis.fetch = async (_url, options) =>
      new Promise((_resolve, reject) =>
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
          once: true,
        }),
      );
    const promise = streamChat(request, new AbortController().signal, () => {});
    const rejected = assert.rejects(promise, /等待回复超时/);
    t.mock.timers.tick(20001);
    await rejected;
  } finally {
    globalThis.fetch = original;
  }
});

test('client enforces total deadline after a valid status event', async (t) => {
  const original = globalThis.fetch;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let received = false;
  try {
    globalThis.fetch = async (_url, options) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `event: status\ndata: ${JSON.stringify({ type: 'status', requestId: id, activity: 'thinking' })}\n\n`,
              ),
            );
            options?.signal?.addEventListener(
              'abort',
              () => controller.error(options.signal?.reason),
              { once: true },
            );
          },
        }),
      );
    const promise = streamChat(request, new AbortController().signal, () => {
      received = true;
    });
    const rejected = assert.rejects(promise, /超过 60 秒/);
    await nextTurn();
    assert.equal(received, true);
    t.mock.timers.tick(60001);
    await rejected;
  } finally {
    globalThis.fetch = original;
  }
});
