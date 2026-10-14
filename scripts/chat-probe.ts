// chat 模式的真机探测。跑真的 ChatBrain、真的工具执行器、真的 StepFun API。
//
// 留着它（而不是用完就删）的理由和 scripts/realtime-probe.mjs 一样：这是唯一能
// 复验本模式依赖的那些协议事实的办法 —— tool_calls 增量里 id/name 是空占位、
// TTS 的 WAV 里 data 块不在偏移 44、/v1/audio/speech 不渐进出流。
//
// 跑：
//     npx tsx scripts/chat-probe.ts            # 默认 step-5-preview
//     npx tsx scripts/chat-probe.ts step-3.7-flash
// 需要根目录 .env 里的 STEPFUN_API_KEY。会真的花钱（chat + 视觉 + TTS）。
//
// 它不验证的东西：浏览器里的音频播放。这里的播放侧是假的，只统计字节和时序。
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { ChatBrain, type AudioOutput, type AudioOutputEvents } from '../apps/web/src/brain/chat';
import { decodeWav } from '../apps/web/src/brain/chat/wav';
import {
  defaultSettings,
  type Credentials,
  type Desktop,
  type ScreenCapture,
  type Settings,
} from '../shared/desktop';
import type { PetEvent } from '../shared/brain';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const KEY =
  process.env.STEPFUN_API_KEY ??
  /^STEPFUN_API_KEY=(.+)$/m.exec(readFileSync(`${ROOT}/.env`, 'utf8'))?.[1]?.trim();
if (!KEY) throw Error('STEPFUN_API_KEY 缺失（环境变量或 .env）');

const MODEL = (process.argv[2] ?? 'step-5-preview') as Settings['chatModel'];
// 给视觉模型的「屏幕」：拿一张真实 PNG 素材当截图，这样 glance_screen 走的是
// 真的视觉模型调用，而不是假的字符串。
const FAKE_SCREEN = readFileSync(`${ROOT}/assets/stepchan_q_v1/master.png`).toString('base64');

let T0 = Date.now();
const since = (): string => `${String(Date.now() - T0).padStart(5)}ms`;
const log = (...parts: unknown[]): void => console.log(since(), ...parts);

// ---- 假的播放侧：只记录字节和时刻，不碰 AudioContext ----
type Clip = { at: number; bytes: number };
function fakeAudio(clips: Clip[]) {
  return (events: AudioOutputEvents): AudioOutput => ({
    async start() {},
    async dispose() {},
    get audioLevel() {
      return 0;
    },
    enqueue(base64: string) {
      const bytes = Math.floor((base64.length * 3) / 4);
      clips.push({ at: Date.now() - T0, bytes });
      log(`🔊 入环第 ${clips.length} 段：${bytes} 字节 ≈ ${(bytes / 2 / 24000).toFixed(2)}s 音频`);
      if (clips.length === 1) events.onStarted();
    },
    flush() {
      events.onDrained();
    },
  });
}

// ---- 假的桌面：系统能力给可预期的真实值，截屏给一张真 PNG ----
function makeDesktop(overrides: Partial<Settings>): Desktop {
  let settings: Settings = {
    ...defaultSettings,
    brainMode: 'chat',
    chatModel: MODEL,
    ...overrides,
  };
  const noop = (): (() => void) => () => {};
  return {
    available: true,
    async credentials(): Promise<Credentials> {
      return {
        apiKey: KEY!,
        realtimeModel: 'stepaudio-3-realtime-preview',
        visionModel: 'step-1o-turbo-vision',
        chatModel: MODEL,
      };
    },
    async setHitRegions() {},
    async setInteractive() {},
    async moveToSpot(spot) {
      log(`🪟 moveToSpot(${spot})`);
    },
    async focusPet() {},
    async startDragging() {},
    async openSettings() {},
    async quit() {},
    async workArea() {
      return null;
    },
    async captureScreen(): Promise<ScreenCapture> {
      return { status: 'ok', png: FAKE_SCREEN, width: 1024, height: 1024 };
    },
    async screenPermission() {
      return 'granted' as const;
    },
    async frontmostApp() {
      return { name: 'Ghostty', bundleId: 'com.mitchellh.ghostty' };
    },
    async systemStatus() {
      return {
        battery: { percent: 73, state: 'discharging' as const, minutesRemaining: 184 },
        localTime: new Date().toLocaleString('zh-CN'),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        os: 'macOS 26.6',
      };
    },
    async readClipboardText() {
      return 'npm run typecheck';
    },
    async notify(title, body) {
      log(`🔔 通知：${title} / ${body}`);
    },
    async openUrl() {},
    async getSettings() {
      return settings;
    },
    async setSettings(patch) {
      settings = { ...settings, ...patch };
      return settings;
    },
    onTrayCommand: noop,
    onHotkey: noop,
    onDragDrop: noop,
    onFrontmostChanged: noop,
    onHitTest: noop,
  };
}

type Marks = {
  firstThinking?: number;
  firstText?: number;
  firstClip?: number;
  toolStart?: number;
  toolEnd?: number;
  finalText?: number;
};

async function scenario(
  title: string,
  utterance: string,
  overrides: Partial<Settings>,
): Promise<void> {
  console.log(`\n========== ${title} ==========`);
  console.log(`用户打字：${utterance}`);
  T0 = Date.now();
  const clips: Clip[] = [];
  const marks: Marks = {};
  const tools: string[] = [];
  const brain = new ChatBrain({
    desktop: makeDesktop(overrides),
    createAudio: fakeAudio(clips),
  });
  brain.on((event: PetEvent) => {
    const at = Date.now() - T0;
    switch (event.type) {
      case 'thinking':
        marks.firstThinking ??= at;
        return;
      case 'pet_transcript':
        if (!event.final) {
          marks.firstText ??= at;
          return;
        }
        marks.finalText = at;
        log(`💬 最终回复：${event.text}`);
        return;
      case 'tool_start':
        marks.toolStart ??= at;
        tools.push(event.name);
        log(`🔧 tool_start ${event.name} ${JSON.stringify(event.args)}`);
        return;
      case 'tool_end':
        marks.toolEnd = at;
        log(
          `🔧 tool_end   ${event.name} ok=${event.result.ok} ${event.result.message.slice(0, 90)}${event.result.description ? ` | 画面：${event.result.description.slice(0, 90)}` : ''}`,
        );
        return;
      case 'privacy_notice':
        log(`👁 隐私提示 ${event.action}：${event.reason}`);
        return;
      case 'error':
        log(`❌ ${event.message}`);
        return;
      case 'connection':
      case 'activity':
      case 'user_transcript':
      case 'link':
        return;
    }
  });

  await brain.start(false);
  await brain.sendText(utterance);
  // 文本已经说完，但后面几段 TTS 还在排队 —— 播放是按「上一段快播完」节流的，
  // 所以两段之间的间隔约等于上一段的时长。等「上一段该播完了还没有新段」为止。
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    const last = clips[clips.length - 1];
    if (!last) continue;
    const lastDurationMs = (last.bytes / 2 / 24000) * 1000;
    if (Date.now() - T0 - last.at > lastDurationMs + 4000) break;
  }
  marks.firstClip = clips[0]?.at;
  await brain.dispose();

  console.log('--- 延迟分段 ---');
  console.log(`  首个思考 token      ${marks.firstThinking ?? '-'}ms`);
  console.log(`  首个工具调用        ${marks.toolStart ?? '-'}ms  (${tools.join(', ') || '无'})`);
  console.log(`  工具执行完          ${marks.toolEnd ?? '-'}ms`);
  console.log(`  首个正文 token      ${marks.firstText ?? '-'}ms`);
  console.log(`  ★ 首段音频可播      ${marks.firstClip ?? '-'}ms`);
  console.log(`  整轮文本说完        ${marks.finalText ?? '-'}ms`);
  console.log(
    `  共 ${clips.length} 段音频，${clips.reduce((s, c) => s + c.bytes, 0)} 字节 ≈ ${(clips.reduce((s, c) => s + c.bytes, 0) / 2 / 24000).toFixed(2)}s`,
  );
  if (!clips.length) console.log('  ⚠️ 没有合成出任何音频');
  if (!tools.length) console.log('  ⚠️ 这一轮没有调用任何工具');
}

// 顺手复验 WAV 剥壳：直接打一次 TTS，确认 data 块确实不在偏移 44。
async function checkWavLayout(): Promise<void> {
  console.log('\n========== WAV 布局复验 ==========');
  const response = await fetch('https://api.stepfun.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'stepaudio-3-tts',
      voice: defaultSettings.voice,
      input: '咦，你在干什么？',
      response_format: 'wav',
      sample_rate: 24000,
    }),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const wav = decodeWav(bytes);
  const naive = bytes.byteLength - 44;
  console.log(`总 ${bytes.byteLength} 字节；decodeWav 取到 ${wav.samples.length * 2} 字节 PCM`);
  console.log(`rate=${wav.sampleRate} channels=${wav.channels}`);
  console.log(
    `按「跳 44 字节」会多算 ${naive - wav.samples.length * 2} 字节 —— 这部分是 LIST 块，` +
      `当成样本念出来就是开头一声爆音 + 之后全部错位。`,
  );
}

await checkWavLayout();
// 1) 真工具 + 真回灌：问时间 → get_time。
await scenario('场景 1：问时间（期望调 get_time）', '现在几点了？', {});
// 2) 隐私门禁：屏幕感知关着，她必须转达拒绝原因而不是假装看到了。
await scenario('场景 2：屏幕感知关闭（期望被拒并如实转达）', '你看一下我的屏幕，我现在在干什么？', {
  screenAwareness: false,
});
// 3) 真视觉模型：屏幕感知打开，截图是一张真 PNG。
await scenario('场景 3：屏幕感知开启（期望真的看到画面）', '你看一下我的屏幕，上面是什么？', {
  screenAwareness: true,
});
