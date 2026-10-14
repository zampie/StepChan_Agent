// End-to-end live probe against the real StepFun realtime endpoint.
//
// Kept (rather than thrown away) because it is the only way to re-verify the
// protocol facts this track depends on. Run with:
//     node scripts/realtime-probe.mjs
// Needs STEPFUN_API_KEY in the repo-root .env, plus `say` and `ffmpeg`.
//
// What it checks, in one session each:
//   1. voice in  -> input_audio_transcription + server VAD events
//   2. voice in  -> a real function call (response.function_call_arguments.done)
//   3. text in   -> whether a tool-implying utterance actually emits a call
//   4. response.cancel genuinely stops the audio stream mid-reply
//
// It also writes tests/fixtures/realtime-events.json: the captured frames the
// unit tests parse, so the tests run against real server output rather than
// hand-written guesses.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
// Scratch audio goes to the OS temp dir, never into the repo.
const TMP = process.env.PROBE_TMP ?? join(tmpdir(), 'stepchan-realtime-probe');
mkdirSync(TMP, { recursive: true });

const KEY =
  process.env.STEPFUN_API_KEY ??
  /^STEPFUN_API_KEY=(.+)$/m.exec(readFileSync(`${ROOT}/.env`, 'utf8'))?.[1]?.trim();
if (!KEY) throw Error('STEPFUN_API_KEY missing (env or .env)');

const SAMPLE_RATE = 24000;
const URL_ = 'wss://api.stepfun.com/v1/realtime?model=stepaudio-3-realtime-preview';

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_time',
      description: '查询真实当前时间。省略时区则用用户本地时区。',
      parameters: { type: 'object', properties: { timezone: { type: 'string' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'move_to',
      description: '把自己挪到屏幕的某个位置。用户说「让开」「去角落」时调用。',
      parameters: {
        type: 'object',
        properties: {
          spot: {
            type: 'string',
            enum: ['bottom_right', 'bottom_left', 'bottom_center', 'top_right', 'top_left', 'center'],
          },
        },
        required: ['spot'],
      },
    },
  },
];

const INSTRUCTIONS = `你是 Step酱，住在用户 macOS 桌面上的桌宠。每次回复 1~3 句话，不用 markdown，不用 emoji，不写括号里的动作描写。需要做事就调用工具 —— 没有调用工具就等于什么都没做，绝对不要声称做过没做过的事。`;

/** Synthesize Chinese speech and return exactly the PCM16 bytes to stream in. */
function speech(text) {
  const aiff = `${TMP}/probe.aiff`;
  const raw = `${TMP}/probe.raw`;
  execFileSync('say', ['-v', 'Tingting', '-r', '190', '-o', aiff, text]);
  execFileSync('ffmpeg', [
    '-y', '-v', 'error', '-i', aiff,
    '-af', 'volume=2.0,alimiter=limit=0.95',
    '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', raw,
  ]);
  // trailing silence so server VAD fires speech_stopped
  return Buffer.concat([readFileSync(raw), Buffer.alloc(SAMPLE_RATE * 2)]);
}

function session({ onEvent, onOpen, timeoutMs = 90_000 }) {
  const ws = new WebSocket(URL_, ['realtime', `openai-insecure-api-key.${KEY}`]);
  const frames = [];
  let finish;
  const done = new Promise((r) => (finish = r));
  const timer = setTimeout(() => { try { ws.close(); } catch {} finish('timeout'); }, timeoutMs);
  const api = {
    ws,
    frames,
    done,
    send: (event) => { if (ws.readyState === 1) ws.send(JSON.stringify(event)); },
    stop: (reason = 'done') => { clearTimeout(timer); try { ws.close(); } catch {} finish(reason); },
  };
  ws.addEventListener('open', () => {
    api.send({
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        instructions: INSTRUCTIONS,
        voice: 'yuanqishaonv',
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        turn_detection: { type: 'server_vad' },
        input_audio_transcription: {
          model: 'stepaudio-3-asr-max',
          language: 'zh',
          hotwords: ['Step酱', '阶跃娘'],
        },
        tools: TOOLS,
        tool_choice: 'auto',
      },
    });
    void onOpen?.(api);
  });
  ws.addEventListener('message', (e) => {
    if (typeof e.data !== 'string') return;
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }
    frames.push(ev);
    onEvent?.(ev, api);
  });
  ws.addEventListener('error', () => api.stop('ws-error'));
  ws.addEventListener('close', (e) => api.stop(`close-${e.code}`));
  return api;
}

async function streamIn(api, pcm, { chunkMs = 40, realtime = true } = {}) {
  const bytes = Math.round(SAMPLE_RATE * (chunkMs / 1000)) * 2;
  for (let o = 0; o < pcm.length; o += bytes) {
    if (api.ws.readyState !== 1) return;
    api.send({ type: 'input_audio_buffer.append', audio: pcm.subarray(o, o + bytes).toString('base64') });
    await new Promise((r) => setTimeout(r, realtime ? chunkMs : 8));
  }
}

const captured = [];
function capture(frames) {
  // one example per event type, audio deltas truncated so the fixture stays small
  const seen = new Set(captured.map((f) => f.type));
  for (const f of frames) {
    if (seen.has(f.type)) continue;
    seen.add(f.type);
    captured.push(
      f.type === 'response.audio.delta' ? { ...f, delta: f.delta.slice(0, 64) } : f,
    );
  }
}

// ---------------------------------------------------------------- 1 + 2
async function probeVoiceToolCall() {
  console.log('\n=== 1+2. voice in -> transcription, VAD, tool call, audio out ===');
  const pcm = speech('你能不能挪到屏幕右下角去，别挡着我了');
  const seen = [];
  let firstAudioAt = 0;
  let stoppedAt = 0;
  const calls = [];
  const api = session({
    onOpen: async (a) => { await new Promise((r) => setTimeout(r, 400)); await streamIn(a, pcm); },
    onEvent: (ev, a) => {
      if (ev.type === 'response.audio.delta') {
        if (!firstAudioAt) {
          firstAudioAt = Date.now();
          if (stoppedAt) console.log(`   VAD speech_stopped -> first audio: ${firstAudioAt - stoppedAt} ms`);
        }
        return;
      }
      seen.push(ev.type);
      if (ev.type === 'input_audio_buffer.speech_stopped') stoppedAt = Date.now();
      if (ev.type === 'conversation.item.input_audio_transcription.completed')
        console.log(`   heard: ${JSON.stringify(ev.transcript)}`);
      if (ev.type === 'response.function_call_arguments.done') {
        calls.push({ name: ev.name, args: ev.arguments, call_id: ev.call_id });
        console.log(`   TOOL CALL: ${ev.name} ${ev.arguments}`);
        // close the loop so the turn can finish
        a.send({ type: 'conversation.item.create', item: {
          type: 'function_call_output', call_id: ev.call_id,
          output: JSON.stringify({ ok: true, message: '已经挪到 bottom_right 了。' } ) } });
        a.send({ type: 'response.create' });
      }
      if (ev.type === 'response.audio_transcript.done') console.log(`   said: ${JSON.stringify(ev.transcript)}`);
      if (ev.type === 'error') console.log('   ERROR', JSON.stringify(ev.error));
      if (ev.type === 'response.done' && calls.length) setTimeout(() => a.stop(), 1500);
    },
  });
  const reason = await api.done;
  capture(api.frames);
  console.log(`   ended: ${reason}`);
  console.log(`   got transcription: ${seen.includes('conversation.item.input_audio_transcription.completed')}`);
  console.log(`   got VAD start/stop: ${seen.includes('input_audio_buffer.speech_started')}/${seen.includes('input_audio_buffer.speech_stopped')}`);
  console.log(`   got tool call: ${calls.length > 0} ${JSON.stringify(calls)}`);
  console.log(`   got audio out: ${firstAudioAt > 0}`);
  console.log(`   thinking events: ${seen.filter((t) => t.startsWith('response.thinking')).length}`);
  return { calls, seen };
}

// ---------------------------------------------------------------- 3
async function probeTextToolCall() {
  console.log('\n=== 3. TEXT in -> does a tool-implying utterance actually emit a call? ===');
  for (const text of ['现在几点了？', '挪到右下角去吧']) {
    let call = null;
    let said = '';
    const api = session({
      timeoutMs: 45_000,
      onOpen: async (a) => {
        await new Promise((r) => setTimeout(r, 400));
        a.send({ type: 'conversation.item.create', item: {
          type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
        a.send({ type: 'response.create' });
      },
      onEvent: (ev, a) => {
        if (ev.type === 'response.function_call_arguments.done') {
          call = { name: ev.name, args: ev.arguments };
          a.send({ type: 'conversation.item.create', item: {
            type: 'function_call_output', call_id: ev.call_id,
            output: JSON.stringify({ ok: true, message: '完成。' }) } });
        }
        if (ev.type === 'response.audio_transcript.done') said = ev.transcript ?? '';
        if (ev.type === 'response.done') setTimeout(() => a.stop(), 600);
      },
    });
    await api.done;
    capture(api.frames);
    console.log(`   "${text}" -> tool=${call ? `${call.name} ${call.args}` : 'NONE'}  said=${JSON.stringify(said)}`);
    if (!call && said) console.log('     ^ no tool call: this is the failure mode textNeedsTool() guards against');
  }
}

// ---------------------------------------------------------------- 4
async function probeCancel() {
  console.log('\n=== 4. response.cancel actually stops the audio stream ===');
  let deltas = 0;
  let cancelAt = 0;
  let afterCancel = 0;
  let lastDeltaAt = 0;
  const api = session({
    timeoutMs: 60_000,
    onOpen: async (a) => {
      await new Promise((r) => setTimeout(r, 400));
      a.send({ type: 'conversation.item.create', item: { type: 'message', role: 'user',
        content: [{ type: 'input_text', text: '请从一数到五十，一个都不要漏。' }] } });
      a.send({ type: 'response.create' });
    },
    onEvent: (ev, a) => {
      if (ev.type === 'response.audio.delta') {
        deltas++;
        lastDeltaAt = Date.now();
        if (cancelAt) afterCancel++;
        // cancel partway through
        if (deltas === 15 && !cancelAt) {
          cancelAt = Date.now();
          a.send({ type: 'response.cancel' });
          console.log(`   sent response.cancel after ${deltas} audio deltas`);
          setTimeout(() => {
            console.log(`   audio deltas received AFTER cancel: ${afterCancel}`);
            console.log(`   last delta ${Date.now() - lastDeltaAt} ms ago (stream quiet => cancel worked)`);
            a.stop();
          }, 3000);
        }
        return;
      }
      if (ev.type === 'response.cancelled') console.log('   server acked: response.cancelled');
      if (ev.type === 'error') console.log('   ERROR', JSON.stringify(ev.error));
    },
  });
  await api.done;
  capture(api.frames);
  console.log(`   total deltas ${deltas}; ${afterCancel} arrived after the cancel was sent`);
}

await probeVoiceToolCall();
await probeTextToolCall();
await probeCancel();

mkdirSync(`${ROOT}/tests/fixtures`, { recursive: true });
writeFileSync(
  `${ROOT}/tests/fixtures/realtime-events.json`,
  JSON.stringify(captured, null, 2) + '\n',
);
console.log(`\nwrote ${captured.length} distinct event types to tests/fixtures/realtime-events.json`);
console.log(captured.map((f) => f.type).join('\n'));
