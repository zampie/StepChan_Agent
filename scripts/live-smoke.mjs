import fs from 'node:fs/promises';
const endpoint = process.env.STEPCHAN_TEST_URL ?? 'http://127.0.0.1:3001';
const history = [];
const results = [];
async function ask(content, context = history) {
  const start = Date.now();
  let firstDelta = null;
  const response = await fetch(endpoint + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requestId: crypto.randomUUID(),
      mode: 'live',
      messages: [...context, { role: 'user', content }],
      timezone: 'Asia/Shanghai',
    }),
    signal: AbortSignal.timeout(65000),
  });
  if (!response.ok) throw Error(`HTTP ${response.status}: ${await response.text()}`);
  const decoder = new TextDecoder();
  let buffer = '',
    text = '';
  const events = [];
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const data = frame.split('\n').find((line) => line.startsWith('data: '));
      if (!data) continue;
      const event = JSON.parse(data.slice(6));
      events.push(event);
      if (event.type === 'text_delta') {
        firstDelta ??= Date.now() - start;
        text += event.delta;
      }
    }
  }
  const result = {
    question: content,
    text,
    firstDeltaMs: firstDelta,
    durationMs: Date.now() - start,
    deltaCount: events.filter((e) => e.type === 'text_delta').length,
    tools: events.filter((e) => e.type === 'tool_end'),
    done: events.find((e) => e.type === 'done'),
    errors: events.filter((e) => e.type === 'error'),
  };
  results.push(result);
  console.log(JSON.stringify(result));
  if (result.done?.status !== 'completed') throw Error('Live request did not complete');
  context.push({ role: 'user', content }, { role: 'assistant', content: text });
  return result;
}
try {
  await ask('你好，我给一只虚构的小猫起名叫蓝莓。请简短回应，不需要保存。');
  const followup = await ask('刚才我给小猫起的名字是什么？只回答名字。');
  if (!followup.text.includes('蓝莓')) throw Error('Context recall failed');
  const time = await ask(
    '请调用 get_time 工具查询 Asia/Shanghai 的当前时间，然后用一句话告诉我。',
    [],
  );
  if (!time.tools.some((e) => e.name === 'get_time' && e.result.ok))
    throw Error('Time tool missing');
  const link = await ask('请调用 open_url，为 https://example.com 准备一个需要我点击的链接。', []);
  if (!link.tools.some((e) => e.name === 'open_url' && e.result.url === 'https://example.com/'))
    throw Error('URL tool missing');
} finally {
  await fs.mkdir('artifacts', { recursive: true });
  await fs.writeFile('artifacts/live-results.json', JSON.stringify(results, null, 2));
}
