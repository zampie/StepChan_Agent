// 「按住说话」的真机探测：真的合成一段中文语音，走**生产代码的编码路径**
// （PushToTalkRecorder → wav.encodeWav → asr.transcribePcm16），真的提交
// /v1/audio/asr/sse，打印转写结果和分段耗时。
//
// 留着它（而不是用完就删）的理由和 scripts/chat-probe.ts 一样：这是唯一能复验
// ASR 那个**嵌套**请求体（audio.data / audio.input.transcription / format.type）
// 和 SSE 事件名（transcript.text.done）的办法。协议一变，这里当场就能发现。
//
// 跑：
//     npx tsx scripts/asr-probe.ts                      # 默认那句话
//     npx tsx scripts/asr-probe.ts "帮我看看屏幕上是什么"
// 需要根目录 .env 里的 STEPFUN_API_KEY，以及 macOS 的 say 和 ffmpeg。会真的花钱
// （ASR 2.8 元/小时，一句话几分钱都不到）。
//
// 它不验证的东西：真实麦克风采集、长按手势、浏览器音频。音频是 say 合成的，
// 麦克风那一段只能在 tauri build --debug 产物上人工验收。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';

import { PushToTalkRecorder } from '../apps/web/src/brain/chat/listen';
import { bytesToBase64 } from '../apps/web/src/brain/chat/wav';
import { REALTIME_SAMPLE_RATE } from '../shared/realtime';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const KEY =
  process.env.STEPFUN_API_KEY ??
  /^STEPFUN_API_KEY=(.+)$/m.exec(readFileSync(`${ROOT}/.env`, 'utf8'))?.[1]?.trim();
if (!KEY) throw Error('STEPFUN_API_KEY 缺失（环境变量或 .env）');

const SENTENCE = process.argv[2] ?? 'Step酱，帮我把你挪到屏幕右下角去，别挡着我写东西。';
/** 一帧 40ms —— 必须和 MicStream 的 frameSamples 一致，否则帧数下限的语义就变了。 */
const FRAME_BYTES = Math.round(REALTIME_SAMPLE_RATE * 0.04) * 2;

/** say + ffmpeg → 24kHz 单声道 PCM16 裸流（和 MicStream 的 worklet 输出同格式）。 */
function synthesize(text: string): Uint8Array {
  const dir = mkdtempSync(`${tmpdir()}/asr-probe-`);
  const aiff = `${dir}/say.aiff`;
  const raw = `${dir}/say.raw`;
  execFileSync('say', ['-v', 'Tingting', '-o', aiff, text]);
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    aiff,
    '-ac',
    '1',
    '-ar',
    String(REALTIME_SAMPLE_RATE),
    '-f',
    's16le',
    raw,
  ]);
  return new Uint8Array(readFileSync(raw));
}

/** 把裸流切成 40ms 的 base64 帧，就是 MicStream.onFrame 吐出来的东西。 */
function toFrames(pcm: Uint8Array): string[] {
  const frames: string[] = [];
  for (let i = 0; i + FRAME_BYTES <= pcm.length; i += FRAME_BYTES) {
    frames.push(bytesToBase64(pcm.subarray(i, i + FRAME_BYTES)));
  }
  return frames;
}

/**
 * 跑一次完整的「长按→松手→转写」。
 * 假麦克风在 start() 时把预先切好的帧一次性喂进去 —— 采集时序不是这里要验的东西。
 */
async function pushToTalk(frames: string[]): Promise<{ text?: string; events: string[] }> {
  const events: string[] = [];
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });
  let text: string | undefined;

  const recorder = new PushToTalkRecorder({
    getApiKey: async () => KEY!,
    createMic: (e) => ({
      async start() {
        for (const frame of frames) e.onFrame(frame);
      },
      stop() {},
    }),
    events: {
      onUtterance: (value) => {
        text = value;
        events.push(`utterance: ${value}`);
        resolveDone();
      },
      onError: (message) => {
        events.push(`error: ${message}`);
        resolveDone();
      },
      onNotice: (message) => {
        events.push(`notice: ${message}`);
        resolveDone();
      },
      onState: (state) => events.push(`state: ${state}`),
    },
  });
  const t0 = Date.now();
  await recorder.begin();
  const held = Date.now() - t0;
  recorder.end();
  const released = Date.now();
  // 太短的那一轮不会发任何终态事件（静默丢弃），所以给个兜底超时。
  await Promise.race([done, new Promise((r) => setTimeout(r, 12_000))]);
  console.log(
    `   采集 ${frames.length} 帧（${((frames.length * FRAME_BYTES) / 2 / REALTIME_SAMPLE_RATE).toFixed(2)}s 音频）` +
      `｜喂帧 ${held}ms｜松手→结果 ${Date.now() - released}ms`,
  );
  for (const line of events) console.log(`   ${line}`);
  recorder.dispose();
  return { text, events };
}

async function main(): Promise<void> {
  const pcm = synthesize(SENTENCE);
  const frames = toFrames(pcm);
  console.log(`原句：${SENTENCE}`);
  console.log(`say+ffmpeg → ${pcm.length} 字节 PCM16 / ${frames.length} 帧\n`);

  console.log('① 正常一句话');
  const normal = await pushToTalk(frames);

  console.log('\n② 复测（看抖动）');
  await pushToTalk(frames);

  // 下限是 MIN_PUSH_TO_TALK_FRAMES=4（160ms）。这一轮验证的是「刚过下限的音频
  // 会不会被服务端拒掉」—— 如果它回错误而不是空文本，下限就得往上提。
  console.log('\n③ 刚过下限的 5 帧（200ms）：服务端接不接');
  await pushToTalk(frames.slice(0, 5));

  console.log('\n④ 低于下限的 3 帧（120ms）：应当静默丢弃，不发请求');
  const tiny = await pushToTalk(frames.slice(0, 3));
  console.log(
    tiny.events.some((e) => e.startsWith('error'))
      ? '   ✗ 误触走到了错误路径'
      : '   ✓ 没有错误事件',
  );

  console.log('\n⑤ 取消：松手后立刻 cancel，转写结果不该发出来');
  await (async () => {
    const seen: string[] = [];
    const recorder = new PushToTalkRecorder({
      getApiKey: async () => KEY!,
      createMic: (e) => ({
        async start() {
          for (const frame of frames) e.onFrame(frame);
        },
        stop() {},
      }),
      events: {
        onUtterance: (value) => seen.push(`utterance: ${value}`),
        onError: (message) => seen.push(`error: ${message}`),
        onNotice: (message) => seen.push(`notice: ${message}`),
        onState: (state) => seen.push(`state: ${state}`),
      },
    });
    await recorder.begin();
    recorder.end();
    recorder.cancel();
    await new Promise((r) => setTimeout(r, 4000));
    for (const line of seen) console.log(`   ${line}`);
    console.log(
      seen.some((e) => e.startsWith('utterance'))
        ? '   ✗ 取消之后转写还是发出来了'
        : '   ✓ 取消生效，没有迟到的转写',
    );
    recorder.dispose();
  })();

  if (!normal.text) {
    console.log('\n✗ 正常那一轮没拿到转写，链路没通。');
    process.exitCode = 1;
  }
}

await main();
