import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readSSE } from '../shared/sse.ts';
const endpoint = process.env.STEPCHAN_TEST_URL ?? 'http://127.0.0.1:3001';
const response = await fetch(endpoint + '/api/sessions', { method: 'POST' });
const { sessionId } = await response.json();
const results = [];
async function ask(input, interruptEarly = false) {
  const requestId = crypto.randomUUID(),
    abort = new AbortController(),
    started = Date.now();
  let first = null,
    text = '',
    scene = null,
    interrupted = false;
  const tools = [],
    errors = [];
  let status;
  const response = await fetch(endpoint + '/api/interact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, sessionId, mode: 'live', input, timezone: 'Asia/Shanghai' }),
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(65000)]),
  });
  if (!response.ok) throw Error('HTTP ' + response.status + ': ' + (await response.text()));
  try {
    for await (const frame of readSSE(response.body)) {
      const e = JSON.parse(frame.data);
      if (e.type === 'text_delta') {
        first ??= Date.now() - started;
        text += e.delta;
      }
      if (e.type === 'tool_end') tools.push({ name: e.name, result: e.result });
      if (e.type === 'scene') scene = e.scene;
      if (e.type === 'error') errors.push(e.message);
      if (e.type === 'done') status = e.status;
      if (interruptEarly && scene?.plant.waterCount === 1 && text.length >= 8) {
        await fetch(endpoint + `/api/sessions/${sessionId}/interrupt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId, visibleChars: text.length }),
        });
        interrupted = true;
        abort.abort();
        break;
      }
    }
  } catch (e) {
    if (!interrupted) throw e;
  }
  const result = {
    input,
    text,
    tools,
    scene,
    status,
    interrupted,
    errors,
    firstDeltaMs: first,
    durationMs: Date.now() - started,
  };
  results.push(result);
  console.log(JSON.stringify(result));
  assert.deepEqual(errors, []);
  if (!interrupted) assert.equal(status, 'completed');
  return result;
}
try {
  const a = await ask(
    {
      kind: 'text',
      text: '我的纸猫叫星团。请给房间里的盆栽浇一次水，再用两句话介绍你刚才做了什么。',
    },
    true,
  );
  assert.equal(a.interrupted, true);
  assert.equal(a.scene.plant.waterCount, 1);
  const b = await ask({
    kind: 'text',
    text: '先停一下，简短回答：我的纸猫叫什么？盆栽刚才浇过了吗？不要重复浇水。',
  });
  assert.match(b.text, /星团/);
  assert.equal(b.scene.plant.waterCount, 1);
  assert.equal(b.tools.filter((t) => t.name === 'water_plant').length, 0);
  const c = await ask({ kind: 'autonomy' });
  assert.ok(c.tools.length >= 1 && c.tools.length <= 2, 'autonomous meaningful tool action');
  console.log(
    'Live interaction passed: real room tool, streaming interrupt, server context recall, no repeated effect, autonomous tools.',
  );
} finally {
  await fs.mkdir('artifacts', { recursive: true });
  await fs.writeFile('artifacts/interaction-live.json', JSON.stringify(results, null, 2));
  await fetch(endpoint + '/api/sessions/' + sessionId, { method: 'DELETE' });
}
