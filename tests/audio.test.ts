import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pcmWav, spokenText } from '../shared/audio';
import { transcribe, validRecording } from '../apps/server/src/audioRoutes';
import { buildServer } from '../apps/server/src/index';
import { PetController } from '../apps/web/src/pet/PetController';
test('spoken text strips code, URLs and inline voice directions without losing link labels', () => {
  assert.equal(
    spokenText('**你好**（低沉地笑） [发现卡](https://example.com)\n```js\nalert(1)\n```'),
    '你好 发现卡',
  );
});
test('recorded WAV validates actual duration, layout and sample encoding', () => {
  const wav = Buffer.from(pcmWav(new Float32Array(24000).fill(0.25), 24000));
  assert.equal(validRecording(wav), true);
  assert.equal(wav.readInt16LE(44), 8191);
  const forged = Buffer.from(wav);
  forged.writeUInt32LE(0, 40);
  assert.equal(validRecording(forged), false);
  assert.equal(validRecording(Buffer.from('this is WebM, not WAV')), false);
  assert.equal(validRecording(Buffer.from(pcmWav(new Float32Array(24), 24000))), false);
  assert.equal(validRecording(Buffer.from(pcmWav(new Float32Array(24000 * 31), 24000))), false);
});
test('ASR requires a final transcript and rejects partial, malformed and provider error streams', async () => {
  const stream = (...events: object[]) =>
    new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')).body!;
  assert.equal(
    await transcribe(
      stream(
        { type: 'transcript.text.delta', delta: '旧文本' },
        { type: 'transcript.text.done', text: '开灯' },
      ),
    ),
    '开灯',
  );
  await assert.rejects(
    transcribe(stream({ type: 'transcript.text.delta', delta: 'partial' })),
    /中断/,
  );
  await assert.rejects(
    transcribe(stream({ type: 'error', message: 'sensitive upstream detail' })),
    /识别失败/,
  );
  await assert.rejects(transcribe(stream({ type: 'transcript.text.done', text: '' })), /没有听清/);
});
test('audio routes keep configuration server-side, validate recordings, sanitize speech and never relay provider secrets', async () => {
  const app = buildServer(),
    original = globalThis.fetch,
    key = process.env.STEPFUN_API_KEY;
  process.env.STEPFUN_API_KEY = 'test-only';
  try {
    let calls = 0;
    globalThis.fetch = async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.voice, process.env.STEPFUN_TTS_VOICE || 'qingchunshaonv');
      assert.equal(body.model, 'stepaudio-3-tts');
      assert.equal(body.input, '你好');
      assert.match(body.instruction, /小学生/);
      return new Response(pcmWav(new Float32Array(24000), 24000));
    };
    const audio = await app.inject({
      method: 'POST',
      url: '/api/audio/tts',
      payload: { text: '**你好**（低沉地笑）' },
    });
    assert.equal(audio.statusCode, 200);
    assert.match(audio.headers['content-type']!, /audio\/wav/);
    assert.equal(audio.headers['cache-control'], 'no-store');
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/audio/asr',
      payload: { audio: 'a'.repeat(80) },
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(calls, 1);
    const override = await app.inject({
      method: 'POST',
      url: '/api/audio/tts',
      payload: { text: '你好', voice: 'arbitrary' },
    });
    assert.equal(override.statusCode, 400);
    globalThis.fetch = async () => new Response('Bearer secret-do-not-relay', { status: 401 });
    const failed = await app.inject({
      method: 'POST',
      url: '/api/audio/tts',
      payload: { text: '你好' },
    });
    assert.equal(failed.statusCode, 502);
    assert.doesNotMatch(failed.body, /secret-do-not-relay/);
    globalThis.fetch = async () =>
      new Response('data: {"type":"transcript.text.done","text":"给盆栽浇水"}\n\n');
    const recognized = await app.inject({
      method: 'POST',
      url: '/api/audio/asr',
      payload: { audio: Buffer.from(pcmWav(new Float32Array(24000), 24000)).toString('base64') },
    });
    assert.equal(recognized.json().text, '给盆栽浇水');
  } finally {
    globalThis.fetch = original;
    if (key === undefined) delete process.env.STEPFUN_API_KEY;
    else process.env.STEPFUN_API_KEY = key;
    await app.close();
  }
});
test('audio amplitude drives neutral mouths only, and muted speech returns to text animation', () => {
  const pet = new PetController();
  pet.mouthEnabled = true;
  pet.audioDriven = true;
  pet.audioLevel = 0.1;
  assert.equal(pet.pose(1000).mouth, 'open_big');
  pet.audioLevel = 0;
  assert.equal(pet.pose(1000).mouth, 'closed');
  pet.expression = 'happy';
  assert.equal(pet.pose(1000).mouth, null);
  pet.expression = 'neutral';
  pet.audioLevel = null;
  assert.equal(pet.pose(1000).mouth, null);
});
