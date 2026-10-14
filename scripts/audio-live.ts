// Explicit manual smoke test; calls paid TTS + ASR once, using only generated speech.
import { mkdir, writeFile } from 'node:fs/promises';
import { pcmWav } from '../shared/audio';
const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:3001';
const text = '嘿，你来啦！我是Step酱。今天也一起发现点新东西吧！';
const started = performance.now();
const tts = await fetch(`${base}/api/audio/tts`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text }),
});
if (!tts.ok) throw Error(`TTS ${tts.status}: ${await tts.text()}`);
const wav = Buffer.from(await tts.arrayBuffer()),
  ttsMs = performance.now() - started;
await mkdir('artifacts', { recursive: true });
await writeFile('artifacts/stepchan-young-voice.wav', wav);
// Provider WAV may contain extra metadata/fmt bytes; normalize to recorder's PCM16 layout.
let rate = 0,
  data: Buffer | undefined;
for (let p = 12; p + 8 <= wav.length;) {
  const tag = wav.toString('ascii', p, p + 4),
    size = wav.readUInt32LE(p + 4);
  if (tag === 'fmt ') {
    rate = wav.readUInt32LE(p + 12);
    if (wav.readUInt16LE(p + 10) !== 1 || wav.readUInt16LE(p + 22) !== 16)
      throw Error('Expected mono PCM16');
  }
  if (tag === 'data') {
    data = wav.subarray(p + 8, p + 8 + size);
    break;
  }
  p += 8 + size + (size % 2);
}
if (!data || !rate) throw Error('Missing WAV data');
const samples = Float32Array.from(
  { length: data.length / 2 },
  (_, i) => data!.readInt16LE(i * 2) / 32768,
);
const canonical = Buffer.from(pcmWav(samples, rate));
await writeFile('artifacts/stepchan-mic-fixture.wav', canonical);
const asrStart = performance.now();
const asr = await fetch(`${base}/api/audio/asr`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ audio: canonical.toString('base64') }),
});
if (!asr.ok) throw Error(`ASR ${asr.status}: ${await asr.text()}`);
const result = {
  text,
  recognized: (await asr.json()).text,
  ttsMs,
  asrMs: performance.now() - asrStart,
  bytes: wav.length,
  seconds: samples.length / rate,
  rate,
};
await writeFile('artifacts/audio-live-result.json', JSON.stringify(result, null, 2));
console.log(result);
