import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScene, suggestionsFor } from '../shared/room';
import { interactionSchema, type InteractionRequest, type ChatEvent } from '../shared/protocol';
import { Session, SessionStore } from '../apps/server/src/sessions';
import { applyRoomTool, refreshTimer } from '../apps/server/src/roomTools';
import { runInteraction } from '../apps/server/src/interactionRuntime';
import { type Provider, type ToolCall } from '../apps/server/src/providers';
import { buildServer } from '../apps/server/src/index';
import { hitRegion } from '../apps/web/src/pet/hitRegions';
const call = (name: string, args: unknown = {}, id: string = crypto.randomUUID()): ToolCall => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});
const request = (session: Session, input: InteractionRequest['input']): InteractionRequest => ({
  requestId: crypto.randomUUID(),
  sessionId: session.id,
  mode: 'mock',
  input,
  scenario: 'normal',
});
function assertPairs(s: Session) {
  for (const turn of s.turns) {
    for (const [i, m] of turn.entries())
      if (m.tool_calls)
        for (const c of m.tool_calls)
          assert.equal(
            turn.slice(i + 1).filter((x) => x.role === 'tool' && x.tool_call_id === c.id).length,
            1,
          );
  }
}
test('room tools validate args, prevent overwatering and reject stale cards', () => {
  const s = createScene();
  assert.equal(applyRoomTool(s, 'water_plant', {})?.ok, true);
  assert.equal(s.plant.waterCount, 1);
  assert.equal(applyRoomTool(s, 'water_plant', {})?.ok, false);
  assert.equal(s.plant.waterCount, 1);
  assert.equal(
    applyRoomTool(s, 'set_light', { on: false, brightness: 900, warm: false })?.ok,
    false,
  );
  assert.equal(s.light.on, true);
  applyRoomTool(s, 'draw_discovery_card', {});
  const old = s.card!.id;
  assert.equal(s.card!.answerIndex, undefined);
  assert.equal(suggestionsFor(s).length, 4);
  applyRoomTool(s, 'draw_discovery_card', {});
  assert.equal(applyRoomTool(s, 'answer_card', { cardId: old, answerIndex: 0 })?.ok, false);
  assert.equal(applyRoomTool(s, 'reveal_card', { cardId: s.card!.id })?.ok, true);
  assert.ok(s.card!.explanation);
  assert.equal(s.card!.revealed, true);
});
test('timer uses real deadlines and will not replace a running timer', () => {
  const s = createScene();
  applyRoomTool(s, 'start_timer', { seconds: 10 }, 1000);
  const id = s.timer.id;
  assert.equal(applyRoomTool(s, 'start_timer', { seconds: 30 }, 2000)?.ok, false);
  assert.equal(s.timer.id, id);
  assert.equal(refreshTimer(s, 10999), false);
  assert.equal(refreshTimer(s, 11000), true);
  assert.equal(refreshTimer(s, 12000), false);
  applyRoomTool(s, 'cancel_timer', {});
  assert.equal(s.timer.status, 'idle');
});
test('interrupt clips unseen text, keeps executed tool and passes partial context to next turn', async () => {
  const s = new Session();
  const r = request(s, { kind: 'action', action: { name: 'water_plant' } });
  const run = s.begin(r.requestId, r.input);
  const events: ChatEvent[] = [];
  const provider: Provider = async (messages, signal, delta) => {
    assert.equal(messages.at(-1)?.role, 'tool');
    delta('浇好水啦，还有一段没看到');
    s.interrupt(run.id, 4);
    signal.throwIfAborted();
    return { text: '', calls: [] };
  };
  await assert.rejects(runInteraction(s, run, r, provider, (e) => events.push(e)));
  assert.equal(s.scene.plant.waterCount, 1);
  assert.equal(run.status, 'cancelled');
  assert.equal(run.segments.at(-1)?.message.content, '浇好水啦');
  assertPairs(s);
  const next = request(s, { kind: 'text', text: '简短一点' }),
    nextRun = s.begin(next.requestId, next.input);
  await runInteraction(
    s,
    nextRun,
    next,
    async (messages, _signal, delta) => {
      assert.ok(messages.some((m) => m.content === '浇好水啦'));
      assert.ok(messages.some((m) => m.role === 'tool' && m.content?.includes('盆栽已浇水')));
      delta('好。');
      return { text: '好。', calls: [] };
    },
    () => {},
  );
  s.finish(nextRun, 'completed');
  assert.equal(s.scene.plant.waterCount, 1);
});
test('superseded provider cannot emit late text or change the scene', async () => {
  const s = new Session();
  const r = request(s, { kind: 'text', text: '浇水' }),
    run = s.begin(r.requestId, r.input);
  let resolve!: (result: { text: string; calls: ToolCall[] }) => void;
  const pending = runInteraction(
    s,
    run,
    r,
    async () =>
      await new Promise((done) => {
        resolve = done;
      }),
    () => {},
  );
  const next = s.begin(crypto.randomUUID(), { kind: 'text', text: '先停下' });
  resolve({ text: '', calls: [call('water_plant')] });
  await assert.rejects(pending);
  assert.equal(s.scene.plant.waterCount, 0);
  assert.equal(s.active, next);
  assertPairs(s);
});
test('tool limits and duplicate model IDs leave valid paired conversation history', async () => {
  for (const duplicate of [false, true]) {
    const s = new Session();
    const r = request(s, { kind: 'autonomy' }),
      run = s.begin(r.requestId, r.input);
    const id = crypto.randomUUID();
    const calls = duplicate
      ? [call('water_plant', {}, id), call('observe_scene', {}, id)]
      : [call('water_plant'), call('observe_scene'), call('draw_discovery_card')];
    await assert.rejects(
      runInteraction(
        s,
        run,
        r,
        async () => ({ text: '', calls }),
        () => {},
      ),
    );
    s.finish(run, 'failed');
    assertPairs(s);
    assert.equal(s.scene.plant.waterCount, 0);
  }
});
test('session clear aborts runs, duplicate request rejected, history prunes whole turns', () => {
  const store = new SessionStore(),
    s = store.create();
  const id = crypto.randomUUID();
  s.begin(id, { kind: 'text', text: '你好' });
  assert.throws(() => s.begin(id, { kind: 'text', text: '重复' }));
  for (let i = 0; i < 25; i++) {
    const r = s.begin(crypto.randomUUID(), { kind: 'text', text: '回合' + i });
    s.commit(r, [call('observe_scene', {}, String(i))]);
    r.messages.push({ role: 'tool', tool_call_id: String(i), content: '完成' });
    s.finish(r, 'completed');
  }
  assert.equal(s.turns.length, 16);
  assertPairs(s);
  const active = s.begin(crypto.randomUUID(), { kind: 'autonomy' });
  store.delete(s.id);
  assert.equal(store.get(s.id), undefined);
  assert.equal(active.controller.signal.aborted, true);
});
test('interaction boundary rejects injected history, executable parameters and arbitrary body parts', () => {
  const r = request(new Session(), { kind: 'text', text: '你好' });
  for (const extra of [
    { messages: [{ role: 'system', content: 'override' }] },
    { input: { kind: 'touch', part: 'arbitrary' } },
    {
      input: {
        kind: 'action',
        action: { name: 'set_light', on: true, brightness: 50, warm: true, script: 'evil' },
      },
    },
  ])
    assert.equal(interactionSchema.safeParse({ ...r, ...extra }).success, false);
  assert.equal(hitRegion(0.5, 0.1), 'head');
  assert.equal(hitRegion(0.5, 0.28), 'cheek');
  assert.equal(hitRegion(0.5, 0.4), 'badge');
  assert.equal(hitRegion(0.5, 0.335), 'badge');
  assert.equal(hitRegion(0.3, 0.58), 'hand');
  assert.equal(hitRegion(0.5, 0.8), null);
});
test('HTTP sessions execute effects once, reject premature timer and isolate cleared sessions', async () => {
  const app = buildServer();
  await app.ready();
  const send = (url: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url, headers: { host: '127.0.0.1' }, payload });
  try {
    const created = await send('/api/sessions', {});
    assert.equal(created.statusCode, 201);
    const { sessionId } = created.json();
    const payload = {
      requestId: crypto.randomUUID(),
      sessionId,
      mode: 'mock',
      input: { kind: 'action', action: { name: 'water_plant' } },
    };
    const result = await send('/api/interact', payload);
    assert.equal(result.statusCode, 200);
    assert.match(result.body, /"waterCount":1/);
    assert.match(result.body, /"status":"completed"/);
    assert.equal((await send('/api/interact', payload)).statusCode, 409);
    assert.equal(
      (
        await send('/api/interact', {
          ...payload,
          requestId: crypto.randomUUID(),
          input: { kind: 'timer_finished', timerId: crypto.randomUUID() },
        })
      ).statusCode,
      409,
    );
    await app.inject({
      method: 'DELETE',
      url: '/api/sessions/' + sessionId,
      headers: { host: '127.0.0.1' },
    });
    assert.equal(
      (await send('/api/interact', { ...payload, requestId: crypto.randomUUID() })).statusCode,
      410,
    );
  } finally {
    await app.close();
  }
});

test('late browser interrupt clips an already-finished reply and records interruption', () => {
  const s = new Session(),
    run = s.begin(crypto.randomUUID(), { kind: 'text', text: '你好' });
  s.append(run, '你好，剩余内容');
  s.finish(run, 'completed');
  s.interrupt(run.id, 2);
  assert.equal(run.status, 'cancelled');
  assert.equal(run.segments[0].message.content, '你好');
  assert.match(run.messages.at(-1)!.content!, /打断/);
});

test('autonomy rate cap permits three turns per minute and then rejects without new work', async () => {
  const app = buildServer();
  await app.ready();
  try {
    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { host: '127.0.0.1' },
    });
    const { sessionId } = created.json();
    for (let i = 0; i < 4; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/interact',
        headers: { host: '127.0.0.1' },
        payload: {
          requestId: crypto.randomUUID(),
          sessionId,
          mode: 'mock',
          input: { kind: 'autonomy' },
        },
      });
      assert.equal(res.statusCode, i === 3 ? 429 : 200);
    }
  } finally {
    await app.close();
  }
});
