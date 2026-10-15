// Realtime 协议层的测试。
//
// 事件解析用的是 tests/fixtures/realtime-events.json —— 那是 scripts/realtime-probe.mjs
// 从真实 wss://api.stepfun.com/v1/realtime 抓下来的，不是手写的猜测。
// 重抓：node scripts/realtime-probe.mjs
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { readFileSync } from 'node:fs';

import {
  parseServerEvent,
  realtimeSubprotocols,
  realtimeUrl,
  serverEventSchema,
  toolDefinitionSchema,
  REALTIME_SAMPLE_RATE,
  type ClientEvent,
  type SessionConfig,
} from '../shared/realtime';
import { toolArgSchemas, toolDefinitions, toolNames } from '../shared/brain';

const fixtures = JSON.parse(
  readFileSync(new URL('./fixtures/realtime-events.json', import.meta.url), 'utf8'),
) as { type: string; [key: string]: unknown }[];

describe('parseServerEvent：真实抓包', () => {
  test('抓到的 20 种事件全部能解析，没有一个降级成 unknown', () => {
    assert.ok(fixtures.length >= 18, `fixture 只有 ${fixtures.length} 条，太少了`);
    const failed: string[] = [];
    for (const frame of fixtures) {
      const parsed = parseServerEvent(JSON.stringify(frame));
      if (parsed.type === 'unknown') failed.push(`${frame.type} -> ${parsed.rawType}`);
    }
    assert.deepEqual(failed, [], `这些真实事件没被契约覆盖：${failed.join(', ')}`);
  });

  test('关键事件的字段被正确取出', () => {
    const byType = new Map(fixtures.map((f) => [f.type, f]));

    const transcription = byType.get('conversation.item.input_audio_transcription.completed');
    assert.ok(transcription, 'fixture 里缺用户字幕事件');
    const parsedTranscription = parseServerEvent(JSON.stringify(transcription));
    assert.equal(parsedTranscription.type, 'conversation.item.input_audio_transcription.completed');
    assert.equal(
      parsedTranscription.type === 'conversation.item.input_audio_transcription.completed'
        ? parsedTranscription.transcript
        : null,
      '你能不能挪到屏幕右下角去，别挡着我了。',
    );

    const call = byType.get('response.function_call_arguments.done');
    assert.ok(call, 'fixture 里缺工具调用事件');
    const parsedCall = parseServerEvent(JSON.stringify(call));
    assert.equal(parsedCall.type, 'response.function_call_arguments.done');
    if (parsedCall.type === 'response.function_call_arguments.done') {
      // call_id / name / arguments 是工具闭环的必需字段，必须是 required。
      assert.equal(typeof parsedCall.call_id, 'string');
      assert.equal(typeof parsedCall.name, 'string');
      assert.equal(typeof parsedCall.arguments, 'string');
      assert.equal(parsedCall.name, 'get_time');
    }

    const vad = byType.get('input_audio_buffer.speech_started');
    assert.ok(vad, 'fixture 里缺 VAD 事件 —— 打断全靠它');
    assert.equal(parseServerEvent(JSON.stringify(vad)).type, 'input_audio_buffer.speech_started');
  });

  // 「一句话重复好几遍」那个 bug 的协议侧依据。
  //
  // 用户转写的 delta 是**累计全量文本**，不是增量：抓包里这条 delta 是
  // completed 里整句话的前缀，而不是句子中间的一小段。她自己的
  // response.audio_transcript.delta 则确实是增量 —— 两者不对称。
  // 行为侧（赋值而不是 +=）的回归测试在 tests/brain.test.ts。
  test('用户转写 delta 是整句的前缀（累计全量），不是句中片段', () => {
    const byType = new Map(fixtures.map((f) => [f.type, f]));
    const delta = byType.get('conversation.item.input_audio_transcription.delta')?.delta as string;
    const full = byType.get('conversation.item.input_audio_transcription.completed')
      ?.transcript as string;
    assert.equal(typeof delta, 'string');
    assert.equal(typeof full, 'string');
    assert.ok(
      full.startsWith(delta),
      `抓到的 delta ${JSON.stringify(delta)} 不是整句 ${JSON.stringify(full)} 的前缀 —— ` +
        '这条抓包是「delta 是累计全量」的依据，形状变了就要重新验证累加语义',
    );
    assert.ok(delta.length < full.length, 'delta 应当是说到一半时的快照');
  });

  test('她自己的字幕 delta 是句中片段（增量），与用户转写不对称', () => {
    const byType = new Map(fixtures.map((f) => [f.type, f]));
    const petDelta = byType.get('response.audio_transcript.delta')?.delta as string;
    const petFull = byType.get('response.audio_transcript.done')?.transcript as string;
    assert.equal(typeof petDelta, 'string');
    assert.ok(petFull.includes(petDelta), 'delta 应当是这句话里的一个片段');
    // 这就是不对称的地方：她的 delta 要 += ，用户的 delta 要赋值。别统一成一种。
    assert.ok(petDelta.length < petFull.length);
  });

  test('真实事件带了契约里没写的额外字段也不影响解析', () => {
    // 实测服务端会多发 client_start_ms / response_id / volume_ratio 等；
    // loose schema 必须容忍，否则加一个字段就全线崩。
    const started = fixtures.find((f) => f.type === 'input_audio_buffer.speech_started');
    assert.ok(started);
    assert.ok('client_start_ms' in started!, 'fixture 应当包含契约未声明的 client_start_ms');
    assert.equal(parseServerEvent(JSON.stringify(started)).type, 'input_audio_buffer.speech_started');
  });

  test('response.audio.delta 走快速通道，不进 zod', () => {
    const delta = fixtures.find((f) => f.type === 'response.audio.delta');
    assert.ok(delta);
    const parsed = parseServerEvent(JSON.stringify(delta));
    assert.equal(parsed.type, 'response.audio.delta');
    if (parsed.type === 'response.audio.delta') {
      assert.equal(parsed.delta, delta!.delta);
      // 必须是能解的 base64 PCM16。
      const bytes = Buffer.from(parsed.delta, 'base64');
      assert.equal(bytes.length % 2, 0, 'PCM16 的字节数必须是偶数');
      assert.ok(bytes.length > 0);
    }
  });

  test('response.output_audio.delta 归一成 response.audio.delta', () => {
    const parsed = parseServerEvent(
      JSON.stringify({ type: 'response.output_audio.delta', delta: 'AAAA', item_id: 'x' }),
    );
    assert.equal(parsed.type, 'response.audio.delta');
  });
});

describe('parseServerEvent：容错（未知事件绝不能弄死会话）', () => {
  test('未知类型降级为 unknown 而不是抛错', () => {
    const parsed = parseServerEvent(JSON.stringify({ type: 'response.hologram.delta', x: 1 }));
    assert.equal(parsed.type, 'unknown');
    if (parsed.type === 'unknown') assert.equal(parsed.rawType, 'response.hologram.delta');
  });

  test('非法 JSON 降级而不抛错', () => {
    const parsed = parseServerEvent('{这不是 json');
    assert.equal(parsed.type, 'unknown');
    if (parsed.type === 'unknown') assert.equal(parsed.rawType, 'invalid_json');
  });

  test('缺 type 字段降级而不抛错', () => {
    const parsed = parseServerEvent(JSON.stringify({ delta: 'x' }));
    assert.equal(parsed.type, 'unknown');
    if (parsed.type === 'unknown') assert.equal(parsed.rawType, 'missing_type');
  });

  test('已知类型但字段残缺也不抛错（降级为 unknown）', () => {
    // call_id/name/arguments 是 required，缺了就该降级，而不是让下游拿到 undefined。
    const parsed = parseServerEvent(
      JSON.stringify({ type: 'response.function_call_arguments.done', name: 'get_time' }),
    );
    assert.equal(parsed.type, 'unknown');
  });

  test('一堆畸形输入都不抛错', () => {
    const inputs = ['', 'null', '[]', '"x"', '123', '{"type":null}', '{"type":123}', '{'];
    for (const input of inputs) {
      assert.doesNotThrow(() => parseServerEvent(input), `parseServerEvent(${input}) 抛错了`);
    }
  });
});

describe('连接参数', () => {
  test('鉴权走 subprotocol —— webview 设不了 header', () => {
    const protocols = realtimeSubprotocols('sk-test-123');
    assert.deepEqual(protocols, ['realtime', 'openai-insecure-api-key.sk-test-123']);
  });
  test('URL 不带密钥（query param 鉴权会被服务端拒）', () => {
    const url = realtimeUrl();
    assert.ok(url.startsWith('wss://api.stepfun.com/v1/realtime?model='));
    assert.ok(!url.includes('api-key'));
    assert.ok(!url.includes('authorization'));
  });

  test('采样率常量是实测值 24000', () => {
    // 由 audio_end_ms 斜率法实测确认，见本轮报告。
    assert.equal(REALTIME_SAMPLE_RATE, 24000);
  });

  // 按住说话完全依赖这两条，所以把它们钉在契约层面。
  // 已用真实连接验证（见本轮报告的 ptt-probe）：turn_detection 设 null 之后
  // 服务端不再发 speech_started/stopped、也不会自己开回合，必须手动
  // input_audio_buffer.commit + response.create 才走完一轮；而且这个值可以在
  // 同一个连接上用 session.update 双向热改，不需要重建会话。
  test('SessionConfig 允许 turn_detection: null（关掉服务端 VAD）', () => {
    const config: SessionConfig = { turn_detection: null };
    assert.equal(config.turn_detection, null);
  });

  test('手动提交这一轮所需的客户端事件都在契约里', () => {
    const manualTurn: ClientEvent[] = [
      { type: 'input_audio_buffer.clear' },
      { type: 'input_audio_buffer.append', audio: 'AAAA' },
      { type: 'input_audio_buffer.commit' },
      { type: 'response.create' },
    ];
    assert.deepEqual(manualTurn.map((e) => e.type), [
      'input_audio_buffer.clear',
      'input_audio_buffer.append',
      'input_audio_buffer.commit',
      'response.create',
    ]);
  });
});

describe('工具定义', () => {
  test('必须是嵌套格式 —— 扁平格式会被服务端拒', () => {
    for (const definition of toolDefinitions) {
      assert.doesNotThrow(() => toolDefinitionSchema.parse(definition), `${JSON.stringify(definition)} 不合法`);
      assert.equal(definition.type, 'function');
      assert.ok(definition.function.name);
    }
  });

  test('扁平格式被 schema 拒掉', () => {
    const flat = { type: 'function', name: 'express', description: 'x', parameters: { type: 'object', properties: {} } };
    assert.equal(toolDefinitionSchema.safeParse(flat).success, false);
  });

  test('toolNames、toolArgSchemas、toolDefinitions 三者一一对应', () => {
    const defined = toolDefinitions.map((d) => d.function.name).sort();
    assert.deepEqual(defined, [...toolNames].sort());
    assert.deepEqual(Object.keys(toolArgSchemas).sort(), [...toolNames].sort());
  });
});

describe('工具参数校验：模型给的东西一律不可信', () => {
  test('express 拒绝不存在的表情', () => {
    assert.equal(toolArgSchemas.express.safeParse({ expression: 'happy' }).success, true);
    assert.equal(toolArgSchemas.express.safeParse({ expression: 'smug' }).success, false);
    assert.equal(toolArgSchemas.express.safeParse({ action: 'backflip' }).success, false);
    assert.equal(toolArgSchemas.express.safeParse({ fx: 'explosion' }).success, false);
    // strict：多余字段也要拒，否则模型能夹带任意载荷。
    assert.equal(toolArgSchemas.express.safeParse({ expression: 'happy', sprite: '../../etc/passwd' }).success, false);
  });

  // move_to 已整体移除（模型会自己乱挪位置），所以这里不再有「白名单位置」要测。
  // 对应的回归断言在 tests/brain.test.ts 的「模型没有挪动自己的工具」。

  test('set_timer 的秒数被夹在 10..7200 且必须是整数', () => {
    assert.equal(toolArgSchemas.set_timer.safeParse({ seconds: 60, label: '喝水' }).success, true);
    assert.equal(toolArgSchemas.set_timer.safeParse({ seconds: 5, label: '太短' }).success, false);
    assert.equal(toolArgSchemas.set_timer.safeParse({ seconds: 99999, label: '太长' }).success, false);
    assert.equal(toolArgSchemas.set_timer.safeParse({ seconds: 60.5, label: '小数' }).success, false);
    assert.equal(toolArgSchemas.set_timer.safeParse({ seconds: 60, label: '' }).success, false);
    assert.equal(toolArgSchemas.set_timer.safeParse({ seconds: 60 }).success, false);
    // 负数/NaN 之类不能漏。
    assert.equal(toolArgSchemas.set_timer.safeParse({ seconds: -60, label: 'x' }).success, false);
    assert.equal(toolArgSchemas.set_timer.safeParse({ seconds: Number.NaN, label: 'x' }).success, false);
  });

  test('glance_screen 必须给 reason，且长度有上限', () => {
    assert.equal(toolArgSchemas.glance_screen.safeParse({ reason: '用户问他在干什么' }).success, true);
    assert.equal(toolArgSchemas.glance_screen.safeParse({}).success, false);
    assert.equal(toolArgSchemas.glance_screen.safeParse({ reason: 'x'.repeat(201) }).success, false);
  });

  test('open_url 的长度上限挡住超长载荷', () => {
    assert.equal(toolArgSchemas.open_url.safeParse({ url: 'https://example.com' }).success, true);
    assert.equal(toolArgSchemas.open_url.safeParse({ url: 'x'.repeat(2049) }).success, false);
  });

  test('空参数工具拒绝多余字段', () => {
    assert.equal(toolArgSchemas.get_system_status.safeParse({}).success, true);
    assert.equal(toolArgSchemas.get_system_status.safeParse({ sudo: true }).success, false);
    assert.equal(toolArgSchemas.read_clipboard.safeParse({ all: true }).success, false);
  });
});

describe('serverEventSchema 直接校验', () => {
  test('error 事件的 code 可以是字符串或数字', () => {
    for (const code of ['rate_limit', 429]) {
      const parsed = serverEventSchema.safeParse({ type: 'error', error: { code, message: 'x' } });
      assert.equal(parsed.success, true, `code=${code} 应当被接受`);
    }
  });
});

// ---------------------------------------------------------------- AudioWorklet
//
// 这里跑不了浏览器，但 worklet 里的 DSP 是纯函数，可以把
// AudioWorkletGlobalScope 桩出来直接驱动 process()。
// 验证的是重采样/环形缓冲/RMS 的算法，不是浏览器集成 ——
// 真实麦克风与扬声器通路仍然未验证。

type WorkletPort = {
  postMessage: (data: unknown, transfer?: unknown[]) => void;
  onmessage: ((event: { data: unknown }) => void) | null;
  _out: { data: Record<string, never> & { [key: string]: unknown }; transfer?: unknown[] }[];
  _in: (data: unknown) => void;
};
type WorkletNode = {
  port: WorkletPort;
  process: (inputs: unknown[], outputs?: Float32Array[][]) => boolean;
};

function loadWorklet(file: string, rate: number): new (options?: unknown) => WorkletNode {
  const registered: Record<string, new (options?: unknown) => WorkletNode> = {};
  const base = class {
    port: WorkletPort;
    constructor() {
      let handler: ((event: { data: unknown }) => void) | null = null;
      const out: WorkletPort['_out'] = [];
      this.port = {
        postMessage: (data, transfer) => out.push({ data: data as never, transfer }),
        get onmessage() {
          return handler;
        },
        set onmessage(fn) {
          handler = fn;
        },
        _out: out,
        _in: (data) => handler?.({ data }),
      };
    }
  };
  const scope = {
    sampleRate: rate,
    AudioWorkletProcessor: base,
    registerProcessor: (name: string, cls: new (options?: unknown) => WorkletNode) => {
      registered[name] = cls;
    },
    console,
  };
  const source = readFileSync(
    new URL(`../apps/web/public/${file}`, import.meta.url),
    'utf8',
  );
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(...Object.keys(scope), source)(...Object.values(scope));
  return registered[Object.keys(registered)[0]];
}

function pcm16(count: number, fn: (i: number) => number): ArrayBuffer {
  const samples = new Int16Array(count);
  for (let i = 0; i < count; i++) samples[i] = Math.round(fn(i) * 30000);
  return samples.buffer;
}

describe('audio-capture.js：麦克风采集 worklet', () => {
  // WKWebView 不保证兑现 AudioContext 的 sampleRate 请求值，所以 44100/48000
  // 这些值必须也能正确重采样到 24000 —— 否则她听到的是变调的声音。
  for (const contextRate of [24000, 48000, 44100, 16000]) {
    test(`AudioContext ${contextRate}Hz → 正确重采样到 24000Hz`, () => {
      const Capture = loadWorklet('audio-capture.js', contextRate);
      const node = new Capture({ processorOptions: { targetRate: 24000, frameSamples: 960 } });
      for (let offset = 0; offset < contextRate; offset += 128) {
        const block = new Float32Array(128);
        for (let i = 0; i < 128; i++)
          block[i] = Math.sin((2 * Math.PI * 100 * (offset + i)) / contextRate);
        node.process([[block]]);
      }
      let produced = 0;
      for (const message of node.port._out) {
        const pcm = message.data.pcm as ArrayBuffer | undefined;
        if (pcm) produced += new Int16Array(pcm).length;
      }
      // 一秒输入应当产出约 24000 个样本，容差 1.5%（帧对齐余量）。
      const drift = (Math.abs(produced - 24000) / 24000) * 100;
      assert.ok(drift < 1.5, `${contextRate}Hz 下漂移 ${drift.toFixed(2)}%（产出 ${produced}）`);
    });
  }

  test('绝不写 outputs —— 麦克风回放是回声灾难', () => {
    const Capture = loadWorklet('audio-capture.js', 24000);
    const node = new Capture({ processorOptions: { targetRate: 24000 } });
    const outputs = [[new Float32Array(128)]];
    node.process([[new Float32Array(128).fill(0.9)]], outputs);
    assert.ok(outputs[0][0].every((v) => v === 0), 'capture worklet 不能往 outputs 写任何东西');
  });

  test('静音时不产出有声数据', () => {
    const Capture = loadWorklet('audio-capture.js', 24000);
    const node = new Capture({ processorOptions: { targetRate: 24000, frameSamples: 960 } });
    node.port._in({ muted: true });
    for (let i = 0; i < 40; i++) node.process([[new Float32Array(128).fill(0.9)]]);
    const loud = node.port._out.some((message) => {
      const pcm = message.data.pcm as ArrayBuffer | undefined;
      return pcm && Array.from(new Int16Array(pcm)).some((v) => Math.abs(v) > 1000);
    });
    assert.equal(loud, false, '静音期间不能把声音送出去');
  });

  test('没有输入也 return true（节点不能被回收）', () => {
    const Capture = loadWorklet('audio-capture.js', 24000);
    const node = new Capture({ processorOptions: {} });
    assert.equal(node.process([[]]), true);
    assert.equal(node.process([]), true);
    assert.equal(node.process([[undefined]]), true);
  });

  test('PCM16 转换保住了幅度（不是把音量压没了）', () => {
    const Capture = loadWorklet('audio-capture.js', 24000);
    const node = new Capture({ processorOptions: { targetRate: 24000, frameSamples: 960 } });
    for (let offset = 0; offset < 24000; offset += 128) {
      const block = new Float32Array(128);
      for (let i = 0; i < 128; i++) block[i] = Math.sin((2 * Math.PI * 200 * (offset + i)) / 24000);
      node.process([[block]]);
    }
    const pcm = new Int16Array(node.port._out[2].data.pcm as ArrayBuffer);
    const peak = Math.max(...Array.from(pcm, Math.abs));
    assert.ok(peak > 30000, `满幅正弦应当接近满刻度，实测峰值 ${peak}`);
  });
});

describe('audio-playback.js：播放 worklet 与打断', () => {
  for (const contextRate of [24000, 48000]) {
    test(`AudioContext ${contextRate}Hz 下 24k 音频按原速播放`, () => {
      const Playback = loadWorklet('audio-playback.js', contextRate);
      const node = new Playback({ processorOptions: { sourceRate: 24000 } });
      node.port._in({
        type: 'pcm',
        buffer: pcm16(24000, (i) => Math.sin((2 * Math.PI * 200 * i) / 24000)),
      });
      const outputs = [[new Float32Array(128)]];
      let nonSilent = 0;
      for (let i = 0; i < Math.ceil(contextRate / 128) + 20; i++) {
        outputs[0][0].fill(0);
        node.process([], outputs);
        if (outputs[0][0].some((v) => Math.abs(v) > 0.01)) nonSilent += 128;
      }
      const seconds = nonSilent / contextRate;
      assert.ok(Math.abs(seconds - 1) < 0.05, `1 秒音频播了 ${seconds.toFixed(3)} 秒`);
    });
  }

  test('flush 让下一个 render quantum 立刻静音（这就是打断能停在字中间的原因）', () => {
    const Playback = loadWorklet('audio-playback.js', 24000);
    const node = new Playback({ processorOptions: { sourceRate: 24000 } });
    node.port._in({ type: 'pcm', buffer: pcm16(24000 * 5, () => 0.9) });
    const outputs = [[new Float32Array(128)]];
    node.process([], outputs);
    assert.ok(outputs[0][0].some((v) => Math.abs(v) > 0.5), 'flush 之前应当有声音');

    node.port._in({ type: 'flush' });
    outputs[0][0].fill(0);
    node.process([], outputs);
    assert.ok(outputs[0][0].every((v) => v === 0), 'flush 之后紧接着的那一帧就必须是静音');

    const levels = node.port._out.filter((m) => m.data.type === 'level');
    assert.equal(levels.at(-1)!.data.value, 0, 'flush 必须把口型音量归零');
  });

  test('RMS 音量落在 0..1 且随幅度上升', () => {
    const Playback = loadWorklet('audio-playback.js', 24000);
    const node = new Playback({ processorOptions: { sourceRate: 24000 } });
    const outputs = [[new Float32Array(128)]];
    const peakFor = (amplitude: number) => {
      node.port._in({ type: 'flush' });
      node.port._out.length = 0;
      node.port._in({
        type: 'pcm',
        buffer: pcm16(24000, (i) => amplitude * Math.sin((2 * Math.PI * 200 * i) / 24000)),
      });
      let max = 0;
      for (let i = 0; i < 100; i++) {
        node.process([], outputs);
        for (const message of node.port._out) {
          if (message.data.type === 'level') max = Math.max(max, message.data.value as number);
        }
      }
      return max;
    };
    const quiet = peakFor(0.05);
    const loud = peakFor(0.95);
    assert.ok(loud > quiet, '音量必须随幅度上升');
    assert.ok(quiet >= 0 && loud <= 1, `音量必须在 0..1，实测 ${quiet} / ${loud}`);
    assert.ok(loud > 0.5, '大声说话应当让嘴张得够开');
  });

  test('欠载时输出静音并上报 drained（不足一个 quantum 的尾巴也要播掉）', () => {
    // 回归测试：早先的实现把不足一帧的尾巴卡在环里，drained 永不触发，
    // 结果表情永远停在 speaking。
    const Playback = loadWorklet('audio-playback.js', 24000);
    const node = new Playback({ processorOptions: { sourceRate: 24000 } });
    node.port._in({ type: 'pcm', buffer: pcm16(500, () => 0.9) });
    const outputs = [[new Float32Array(128)]];
    for (let i = 0; i < 10; i++) node.process([], outputs);
    assert.ok(
      node.port._out.some((m) => m.data.type === 'drained'),
      '欠载后必须上报 drained，否则活动状态回不到 idle',
    );
    assert.equal(node.process([], outputs), true, '欠载后节点必须继续存活');
  });

  test('环形缓冲溢出丢最旧并上报，不乱序也不崩', () => {
    const Playback = loadWorklet('audio-playback.js', 24000);
    const node = new Playback({ processorOptions: { sourceRate: 24000 } });
    node.port._in({ type: 'pcm', buffer: pcm16(24000 * 20, () => 0.5) });
    assert.ok(node.port._out.some((m) => m.data.type === 'overflow'), '溢出必须上报');
    assert.equal(node.process([], [[new Float32Array(128)]]), true);
  });

  // 以下三条守着原速播放这条**唯一**的路径。前两条是从 tests/speech-rate.test.ts
  // 搬过来的（那个文件整体删掉了，但其中只测原速路径的部分不该跟着没）：
  // 播放侧的时间伸缩移除之后，这里是「行为没变」的回归基准。

  test('原速路径逐样本原样输出（源采样率 == 输出采样率时不许染色）', () => {
    const Playback = loadWorklet('audio-playback.js', 24000);
    const node = new Playback({ processorOptions: { sourceRate: 24000 } });
    const input = new Int16Array(4096);
    for (let i = 0; i < input.length; i++) input[i] = Math.round(20000 * Math.sin(i / 7));
    node.port._in({ type: 'pcm', buffer: input.buffer });
    const outputs = [[new Float32Array(128)]];
    for (let q = 0; q < 8; q++) {
      node.process([], outputs);
      for (let i = 0; i < 128; i++) {
        assert.equal(
          outputs[0][0][i],
          input[q * 128 + i] / 32768,
          `原速路径必须逐样本原样输出（第 ${q * 128 + i} 个样本）`,
        );
      }
    }
  });

  test('完整一轮：排入 PCM → 出声 → started → 播完 → drained', () => {
    const Playback = loadWorklet('audio-playback.js', 24000);
    const node = new Playback({ processorOptions: { sourceRate: 24000 } });
    // 约 170ms 的音频，一次排入。
    node.port._in({
      type: 'pcm',
      buffer: pcm16(4096, (i) => 0.8 * Math.sin((2 * Math.PI * 200 * i) / 24000)),
    });
    const types = () => node.port._out.map((m) => m.data.type as string);
    assert.ok(types().includes('started'), '排入第一块音频就该上报 started');
    assert.ok(!types().includes('drained'), '还没开始播就不该有 drained');

    const outputs = [[new Float32Array(128)]];
    let nonSilent = 0;
    for (let q = 0; q < 64; q++) {
      outputs[0][0].fill(0);
      node.process([], outputs);
      for (const v of outputs[0][0]) if (Math.abs(v) > 0.01) nonSilent++;
    }
    assert.ok(nonSilent > 4096 * 0.9, `4096 个样本应当基本都播出来，实测 ${nonSilent} 个`);

    const order = types();
    const started = order.indexOf('started');
    const drained = order.indexOf('drained');
    assert.ok(started >= 0, '必须上报 started');
    assert.ok(drained > started, `drained 必须在 started 之后：${order.join(',')}`);
    const levels = node.port._out.filter((m) => m.data.type === 'level');
    assert.ok(levels.some((m) => (m.data.value as number) > 0.3), '播放期间必须有口型音量');
    assert.equal(node.process([], outputs), true, '播完之后节点必须继续存活');
  });

  test('边喂边播（上游 1× 实时、40ms 粒度）：首音一个样本都不多等，流中间不挖洞', () => {
    // realtime 模型大致按 1× 实时出音，增量粒度实测 20~200ms。原速路径不等任何
    // 预缓冲 —— 「说完到出声约 0.2 秒」是这个模式唯一的卖点，谁想在这里加垫子
    // 都会被这条挡下来。空洞数的统计口径是**全静音的 quantum**，也就是用户真的
    // 听到的断续（句中欠载只少播几个样本，不算听得见的洞）。
    const sr = 24000;
    const Playback = loadWorklet('audio-playback.js', sr);
    const node = new Playback({ processorOptions: { sourceRate: sr } });
    const outputs = [[new Float32Array(128)]];
    const chunk = Math.round(sr * 0.04);
    const total = sr * 2;
    let produced = 0;
    let credit = 0;
    let firstAudioMs: number | null = null;
    let gaps = 0;
    let run = 0;
    let worst = 0;
    for (let q = 0; q < Math.ceil((sr * 4) / 128); q++) {
      credit += 128; // 1× 实时
      while (credit >= chunk && produced < total) {
        const n = Math.min(chunk, total - produced);
        const at = produced;
        node.port._in({
          type: 'pcm',
          buffer: pcm16(n, (i) => 0.8 * Math.sin((2 * Math.PI * 200 * (at + i)) / sr)),
        });
        produced += n;
        credit -= chunk;
      }
      outputs[0][0].fill(0);
      node.process([], outputs);
      let energy = 0;
      for (const v of outputs[0][0]) energy += v * v;
      const silent = energy < 1e-12;
      if (firstAudioMs === null && !silent) firstAudioMs = ((q * 128) / sr) * 1000;
      // 只数「流还没送完」时的静音 —— 送完之后的静音是正常的句尾。
      if (firstAudioMs !== null && produced < total) {
        if (silent) {
          run++;
          if (run === 1) gaps++;
          worst = Math.max(worst, run);
        } else {
          run = 0;
        }
      }
    }
    assert.ok(
      firstAudioMs !== null && firstAudioMs <= 45,
      `原速首音应当在 45ms 内（约等于一块增量），实测 ${String(firstAudioMs)}ms`,
    );
    assert.equal(
      gaps,
      0,
      `原速播放不该有听得见的空洞，实测 ${gaps} 次（最长 ${(((worst * 128) / sr) * 1000).toFixed(1)}ms）`,
    );
  });
});

