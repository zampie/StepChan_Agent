// chat 智能模式的测试：SSE 解析、tool_call 增量聚合、切句、WAV 剥壳与封装、
// 对话循环（工具执行 / 每轮上限 / 幂等 / 打断 / 历史裁剪）、按句 TTS 的取消语义、
// 按住说话（采集下限 / 取消语义 / ASR 请求形状），
// 以及「ChatBrain 和 Brain 的公开面是否还一致」。
//
// 这些用例全部离线跑：所有网络调用都走注入的假 fetch，麦克风走注入的假采集。
// 真机验证在 scripts/chat-probe.ts 和 scripts/asr-probe.ts（需要真 key，会花钱）。
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { readSseData } from '../apps/web/src/brain/chat/sse';
import { streamChatCompletion, ChatHttpError } from '../apps/web/src/brain/chat/stream';
import { SentenceBuffer, spokenText } from '../apps/web/src/brain/chat/sentences';
import {
  base64ToBytes,
  bytesToBase64,
  concatPcm16,
  decodeWav,
  encodeWav,
  pcm16ToBase64,
  resample,
  toMono,
} from '../apps/web/src/brain/chat/wav';
import { transcribePcm16, AsrError, ASR_MODEL, ASR_HOTWORDS } from '../apps/web/src/brain/chat/asr';
import {
  PushToTalkRecorder,
  MAX_PUSH_TO_TALK_MS,
  type MicLike,
} from '../apps/web/src/brain/chat/listen';
import type { MicStreamEvents } from '../apps/web/src/voice/MicStream';
import { MIN_PUSH_TO_TALK_FRAMES } from '../apps/web/src/voice/RealtimeSession';
import { ChatSession, MAX_TOOL_CALLS_PER_TURN } from '../apps/web/src/brain/chat/ChatSession';
import { SpeechSynthesizer, type SpeechSink } from '../apps/web/src/brain/chat/tts';
import { buildChatInstructions } from '../apps/web/src/brain/chat/persona';
import { ChatBrain, type AudioOutput } from '../apps/web/src/brain/chat/ChatBrain';
import { createBrain, type PetBrain } from '../apps/web/src/brain/chat/factory';
import { Brain } from '../apps/web/src/brain/Brain';
import { toolDefinitions, type PetEvent, type ToolName, type ToolResult } from '../shared/brain';
import { defaultSettings, type Credentials, type Desktop, type Settings } from '../shared/desktop';

// ---------------------------------------------------------------- 工具：造 SSE

function sseBody(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
}

/** 把若干 chat chunk 包成 SSE 文本（可指定每个网络块装几帧，模拟任意切分）。 */
function chatSse(chunks: object[], framesPerPacket = 1): ReadableStream<Uint8Array> {
  const frames = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`);
  frames.push('data: [DONE]\n\n');
  const packets: string[] = [];
  for (let i = 0; i < frames.length; i += framesPerPacket) {
    packets.push(frames.slice(i, i + framesPerPacket).join(''));
  }
  return sseBody(packets);
}

function contentChunk(text: string): object {
  return { choices: [{ index: 0, delta: { role: 'assistant', content: text } }] };
}
function doneChunk(reason = 'stop'): object {
  return { choices: [{ index: 0, delta: { content: '' }, finish_reason: reason }] };
}
/** 最后一帧实测是 choices:[]，只带 usage —— 不能当成内容帧。 */
function usageOnlyChunk(): object {
  return { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } };
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const data of readSseData(stream)) out.push(data);
  return out;
}

// ---------------------------------------------------------------- SSE

describe('readSseData：chat completions 的流式解析', () => {
  test('按空行切帧，剥掉 data: 前缀', async () => {
    assert.deepEqual(await collect(sseBody(['data: {"a":1}\n\ndata: {"a":2}\n\n'])), [
      '{"a":1}',
      '{"a":2}',
    ]);
  });

  test('一帧被网络切成任意小块也能拼回来', async () => {
    const packets = ['data: {"a', '":1}\n', '\ndata: {"b":2}\n\n'];
    assert.deepEqual(await collect(sseBody(packets)), ['{"a":1}', '{"b":2}']);
  });

  test('多字节 UTF-8 跨块不会乱码（流式解码器是每连接一个）', async () => {
    const encoder = new TextEncoder();
    const whole = encoder.encode('data: {"t":"你好"}\n\n');
    const stream = sseBody([]);
    void stream;
    // 手动在汉字中间切开
    const split = 12;
    const manual = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(whole.subarray(0, split));
        controller.enqueue(whole.subarray(split));
        controller.close();
      },
    });
    assert.deepEqual(await collect(manual), ['{"t":"你好"}']);
  });

  test('[DONE] 结束，之后的内容一律不要', async () => {
    assert.deepEqual(
      await collect(sseBody(['data: {"a":1}\n\ndata: [DONE]\n\ndata: {"b":2}\n\n'])),
      ['{"a":1}'],
    );
  });

  test('结尾没有空行也不丢帧前面的内容、不抛错', async () => {
    assert.deepEqual(await collect(sseBody(['data: {"a":1}\n\ndata: {"half"'])), ['{"a":1}']);
  });

  test('CRLF 分隔同样认', async () => {
    assert.deepEqual(await collect(sseBody(['data: {"a":1}\r\n\r\n'])), ['{"a":1}']);
  });

  test('注释行（: keep-alive）不产生帧', async () => {
    assert.deepEqual(await collect(sseBody([': ping\n\ndata: {"a":1}\n\n'])), ['{"a":1}']);
  });
});

// ---------------------------------------------------------------- 流式聚合

describe('streamChatCompletion：增量聚合', () => {
  const base = { apiKey: 'k', model: 'step-5-preview', messages: [] as never[] };

  test('正文增量按顺序回调并拼成完整文本', async () => {
    const seen: string[] = [];
    const result = await streamChatCompletion({
      ...base,
      onContent: (d) => seen.push(d),
      fetchImpl: async () =>
        new Response(chatSse([contentChunk('你好'), contentChunk('呀'), doneChunk()]), {
          status: 200,
        }),
    });
    assert.deepEqual(seen, ['你好', '呀']);
    assert.equal(result.text, '你好呀');
    assert.equal(result.finishReason, 'stop');
  });

  test('reasoning_content 走单独回调，不混进正文', async () => {
    const thinking: string[] = [];
    const result = await streamChatCompletion({
      ...base,
      onReasoning: (d) => thinking.push(d),
      fetchImpl: async () =>
        new Response(
          chatSse([
            { choices: [{ index: 0, delta: { reasoning_content: '要调工具' } }] },
            contentChunk('好'),
            doneChunk(),
          ]),
          { status: 200 },
        ),
    });
    assert.deepEqual(thinking, ['要调工具']);
    assert.equal(result.text, '好');
    assert.equal(result.reasoning, '要调工具');
  });

  test('tool_call 增量里 id/name 是空字符串占位 —— 无条件覆盖会把工具名清空', async () => {
    // 这是实测的帧形状：第一条带 id 和 name，后面每条都是 {"id":"","type":"","function":{"name":""}}。
    const result = await streamChatCompletion({
      ...base,
      tools: toolDefinitions,
      fetchImpl: async () =>
        new Response(
          chatSse([
            {
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call-1',
                        type: 'function',
                        function: { name: 'glance_screen', arguments: '{' },
                      },
                    ],
                  },
                },
              ],
            },
            {
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: '',
                        type: '',
                        function: { name: '', arguments: '"reason": ' },
                      },
                    ],
                  },
                },
              ],
            },
            {
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      { index: 0, id: '', type: '', function: { name: '', arguments: '"看看"}' } },
                    ],
                  },
                },
              ],
            },
            doneChunk('tool_calls'),
            usageOnlyChunk(),
          ]),
          { status: 200 },
        ),
    });
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].id, 'call-1');
    assert.equal(result.toolCalls[0].name, 'glance_screen');
    assert.equal(result.toolCalls[0].args, '{"reason": "看看"}');
    assert.equal(result.finishReason, 'tool_calls');
  });

  test('同一轮里的多个工具按 index 分开聚合', async () => {
    const result = await streamChatCompletion({
      ...base,
      tools: toolDefinitions,
      fetchImpl: async () =>
        new Response(
          chatSse([
            {
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      { index: 0, id: 'a', function: { name: 'get_time', arguments: '{}' } },
                      {
                        index: 1,
                        id: 'b',
                        function: { name: 'get_system_status', arguments: '{}' },
                      },
                    ],
                  },
                },
              ],
            },
            doneChunk('tool_calls'),
          ]),
          { status: 200 },
        ),
    });
    assert.deepEqual(
      result.toolCalls.map((c) => c.name),
      ['get_time', 'get_system_status'],
    );
  });

  test('choices:[] 的收尾帧不会被当成内容帧而崩掉', async () => {
    const result = await streamChatCompletion({
      ...base,
      fetchImpl: async () =>
        new Response(chatSse([contentChunk('嗨'), doneChunk(), usageOnlyChunk()]), { status: 200 }),
    });
    assert.equal(result.text, '嗨');
  });

  test('坏帧跳过，不影响整轮', async () => {
    const result = await streamChatCompletion({
      ...base,
      fetchImpl: async () =>
        new Response(
          sseBody([
            'data: 这不是JSON\n\ndata: ' +
              JSON.stringify(contentChunk('嗨')) +
              '\n\ndata: [DONE]\n\n',
          ]),
          {
            status: 200,
          },
        ),
    });
    assert.equal(result.text, '嗨');
  });

  test('HTTP 错误抛 ChatHttpError，消息对用户可行动', async () => {
    for (const [status, needle] of [
      [401, 'key'],
      [429, '太频繁'],
      [500, '不可用'],
    ] as const) {
      const error = await streamChatCompletion({
        ...base,
        fetchImpl: async () => new Response('nope', { status }),
      }).then(
        () => null,
        (e: unknown) => e,
      );
      assert.ok(error instanceof ChatHttpError, `${status} 应该抛 ChatHttpError`);
      assert.equal(error.status, status);
      assert.match(error.message, new RegExp(needle));
    }
  });

  test('不给 tools 时请求体里既没有 tools 也没有 tool_choice', async () => {
    let body: Record<string, unknown> = {};
    await streamChatCompletion({
      ...base,
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
        return new Response(chatSse([contentChunk('好'), doneChunk()]), { status: 200 });
      },
    });
    assert.equal('tools' in body, false);
    assert.equal('tool_choice' in body, false);
    assert.equal(body.stream, true);
  });
});

// ---------------------------------------------------------------- 切句

describe('spokenText：不该念出来的东西一律滤掉', () => {
  test('括号里的舞台提示会被念成「左括号歪头右括号」，必须去掉', () => {
    assert.equal(spokenText('好呀（歪头）我看看'), '好呀我看看');
    assert.equal(spokenText('好呀(眼睛发亮)我看看'), '好呀我看看');
  });

  test('markdown 符号、代码块、链接、HTML 都不念', () => {
    assert.equal(spokenText('# 标题\n- 一条'), '标题 一条');
    assert.equal(spokenText('看这个 ```js\nconst a=1\n``` 就行'), '看这个 就行');
    assert.equal(spokenText('点[这里](https://example.com)看'), '点这里看');
    assert.equal(spokenText('裸链接 https://example.com/x?y=1 在这'), '裸链接 在这');
    assert.equal(spokenText('<b>粗</b>'), '粗');
    assert.equal(spokenText('**重点**和`代码`'), '重点和代码');
  });

  test('整段都是不该念的内容时返回空串', () => {
    assert.equal(spokenText('（歪头）'), '');
    assert.equal(spokenText('```\ncode\n```'), '');
  });
});

describe('SentenceBuffer：边出边念的切点', () => {
  test('强标点处切，标点跟着前一段走', () => {
    const buffer = new SentenceBuffer();
    assert.deepEqual(buffer.push('我看一眼你的屏幕。'), ['我看一眼你的屏幕。']);
    assert.deepEqual(buffer.push('好像在写代码'), []);
    assert.deepEqual(buffer.flush(), ['好像在写代码']);
  });

  test('首段允许在停顿处切 —— 这是唯一能压首音延迟的地方', () => {
    const buffer = new SentenceBuffer();
    // 「你正在用终端跑测试，」首段在逗号处就交出去，不等句号。
    const first = buffer.push('你正在用终端跑测试，旁边开着编辑器。');
    assert.deepEqual(first, ['你正在用终端跑测试，', '旁边开着编辑器。']);
  });

  test('首段太短时不切，避免把「咦，」单独念一段', () => {
    const buffer = new SentenceBuffer();
    assert.deepEqual(buffer.push('咦，'), []);
    assert.deepEqual(buffer.push('你在干什么？'), ['咦，你在干什么？']);
  });

  test('非首段只认强标点，不被逗号切碎', () => {
    const buffer = new SentenceBuffer();
    buffer.push('第一句话说完了。');
    assert.deepEqual(buffer.push('后面这句有逗号，但不该被切开。'), [
      '后面这句有逗号，但不该被切开。',
    ]);
  });

  test('没有标点的长文本也会被硬切，不会无限攒着', () => {
    const buffer = new SentenceBuffer();
    const segments = buffer.push('啊'.repeat(200));
    assert.ok(segments.length >= 3, `应该切成多段，实际 ${segments.length}`);
    for (const segment of segments) assert.ok(segment.length <= 56);
  });

  test('代码块整段不念，但后面的正文照念', () => {
    const buffer = new SentenceBuffer();
    buffer.push('看这个。');
    buffer.push('```js\nconst a = 1;\n```\n');
    const after = buffer.push('就这么写就行。');
    assert.deepEqual(after, ['就这么写就行。']);
  });

  test('一段只有括号内容时不产生空的 TTS 请求', () => {
    const buffer = new SentenceBuffer();
    assert.deepEqual(buffer.push('（歪头）'), []);
    assert.deepEqual(buffer.flush(), []);
  });

  test('reset 之后首段规则重新生效', () => {
    const buffer = new SentenceBuffer();
    buffer.push('第一句。');
    buffer.reset();
    assert.deepEqual(buffer.push('你正在用终端跑测试，'), ['你正在用终端跑测试，']);
  });
});

// ---------------------------------------------------------------- WAV

/** 造一个 WAV。extraChunk=true 时在 fmt 和 data 之间插一个 LIST 块（实测的真实形状）。 */
function makeWav(samples: Int16Array, rate = 24000, channels = 1, extraChunk = false): Uint8Array {
  const list = extraChunk ? 26 : 0;
  const listTotal = list ? 8 + list + (list % 2) : 0;
  const size = 12 + 24 + listTotal + 8 + samples.length * 2;
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  const tag = (offset: number, value: string): void => {
    for (let i = 0; i < 4; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  tag(0, 'RIFF');
  view.setUint32(4, size - 8, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2 * channels, true);
  view.setUint16(32, 2 * channels, true);
  view.setUint16(34, 16, true);
  let offset = 36;
  if (list) {
    tag(offset, 'LIST');
    view.setUint32(offset + 4, list, true);
    offset += 8 + list + (list % 2);
  }
  tag(offset, 'data');
  view.setUint32(offset + 4, samples.length * 2, true);
  offset += 8;
  for (let i = 0; i < samples.length; i++) view.setInt16(offset + i * 2, samples[i], true);
  return bytes;
}

describe('decodeWav：/v1/audio/speech 的壳', () => {
  test('普通 44 字节头的 WAV', () => {
    const samples = Int16Array.from([0, 1000, -1000, 32767, -32768]);
    const decoded = decodeWav(makeWav(samples));
    assert.deepEqual([...decoded.samples], [...samples]);
    assert.equal(decoded.sampleRate, 24000);
    assert.equal(decoded.channels, 1);
  });

  test(
    'fmt 和 data 之间插了 LIST 块时仍能定位 data —— 实测 StepFun 返回的就是这种，' +
      '按「跳 44 字节」会把 34 字节的块头当成样本（开头爆音 + 之后全部错位）',
    () => {
      const samples = Int16Array.from([5, -5, 500, -500]);
      const bytes = makeWav(samples, 24000, 1, true);
      // 先证明这个 WAV 的 data 确实不在 44
      assert.equal(String.fromCharCode(...bytes.subarray(36, 40)), 'LIST');
      const decoded = decodeWav(bytes);
      assert.deepEqual([...decoded.samples], [...samples]);
    },
  );

  test('data 块偏移是奇数时也不炸（Int16Array 视图会对不齐抛 RangeError）', () => {
    const samples = Int16Array.from([1, 2, 3]);
    // LIST 长度 25（奇数）→ data 载荷偏移变成奇数
    const bytes = makeWav(samples, 24000, 1, true);
    const view = new DataView(bytes.buffer);
    view.setUint32(40, 25, true); // 把 LIST 长度改成奇数，data 位置不变（25+1 填充）
    assert.doesNotThrow(() => decodeWav(bytes));
  });

  test('data 长度字段写成 0 时按实际字节数兜底', () => {
    const samples = Int16Array.from([7, 8, 9, 10]);
    const bytes = makeWav(samples);
    new DataView(bytes.buffer).setUint32(40, 0, true);
    assert.equal(decodeWav(bytes).samples.length, 4);
  });

  test('不是 WAV / 不是 PCM16 / 没有 data 块时明确失败，不静默播噪声', () => {
    assert.throws(() => decodeWav(new Uint8Array(100)), /不是 WAV/);
    const notPcm = makeWav(Int16Array.from([1, 2]));
    new DataView(notPcm.buffer).setUint16(20, 3, true); // float 格式
    assert.throws(() => decodeWav(notPcm), /不是 PCM16/);
  });

  test('toMono 把双声道平均成单声道', () => {
    assert.deepEqual([...toMono(Int16Array.from([100, 200, 300, 500]), 2)], [150, 400]);
    const mono = Int16Array.from([1, 2]);
    assert.equal(toMono(mono, 1), mono);
  });

  test('resample 换采样率；同采样率时原样返回', () => {
    const samples = Int16Array.from([0, 100, 200, 300]);
    assert.equal(resample(samples, 24000, 24000), samples);
    assert.equal(resample(samples, 48000, 24000).length, 2);
    assert.equal(resample(samples, 12000, 24000).length, 8);
  });

  test('pcm16ToBase64 往返正确', () => {
    const samples = Int16Array.from([0, -1, 32767, -32768, 1234]);
    const base64 = pcm16ToBase64(samples);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    assert.deepEqual([...new Int16Array(bytes.buffer)], [...samples]);
  });
});

// ------------------------------------------------- 编码侧：PCM16 → WAV（给 ASR）

describe('encodeWav：攒麦克风的帧交给 /v1/audio/asr/sse', () => {
  test('标准 44 字节头，自己的 decodeWav 能原样读回来', () => {
    const samples = Int16Array.from([0, 1000, -1000, 32767, -32768, 7]);
    const wav = encodeWav(samples, 24000);
    assert.equal(wav.length, 44 + samples.length * 2);
    const view = new DataView(wav.buffer);
    // 编码侧用教科书布局（没有 LIST 块），所以 data 确实在 36。
    assert.equal(String.fromCharCode(...wav.subarray(36, 40)), 'data');
    assert.equal(view.getUint32(4, true), wav.length - 8, 'RIFF 长度必须是文件长 -8');
    assert.equal(view.getUint32(40, true), samples.length * 2);
    assert.equal(view.getUint16(22, true), 1, '单声道');
    assert.equal(view.getUint32(28, true), 24000 * 2, 'byteRate');
    assert.equal(view.getUint16(32, true), 2, 'blockAlign');
    const decoded = decodeWav(wav);
    assert.deepEqual([...decoded.samples], [...samples]);
    assert.equal(decoded.sampleRate, 24000);
    assert.equal(decoded.channels, 1);
  });

  test('采样率写进 fmt —— 写错不会报错，只会让转写莫名其妙', () => {
    assert.equal(decodeWav(encodeWav(Int16Array.from([1, 2]), 16000)).sampleRate, 16000);
  });

  test('空样本也能拼出合法 WAV（不该抛）', () => {
    const wav = encodeWav(new Int16Array(0), 24000);
    assert.equal(wav.length, 44);
    assert.equal(new DataView(wav.buffer).getUint32(40, true), 0);
  });

  test('concatPcm16 拼帧：按小端读，落单的字节丢掉而不是补 0', () => {
    const a = Uint8Array.from([0x01, 0x00, 0xff, 0x7f]); // 1, 32767
    const b = Uint8Array.from([0x00, 0x80]); // -32768
    assert.deepEqual([...concatPcm16([a, b])], [1, 32767, -32768]);
    // 奇数字节：最后那个字节必须丢掉 —— 补 0 会让后面全部错位成白噪声。
    assert.deepEqual([...concatPcm16([a, Uint8Array.from([0x05])])], [1, 32767]);
    assert.deepEqual([...concatPcm16([])], []);
  });

  test('base64ToBytes / bytesToBase64 往返（MicStream 给的就是 base64 帧）', () => {
    const bytes = new Uint8Array(1920);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) % 256;
    assert.deepEqual([...base64ToBytes(bytesToBase64(bytes))], [...bytes]);
  });
});

// ---------------------------------------------------------------- ASR：一次性识别

/** 造一段 ASR 的 SSE 响应。 */
function asrSse(events: object[], withDone = true): ReadableStream<Uint8Array> {
  const frames = events.map((event) => `data: ${JSON.stringify(event)}\n\n`);
  if (withDone) frames.push('data: [DONE]\n\n');
  return sseBody(frames);
}

type FakeAsrOptions = {
  /** 最终文本。null = 回一个 transcript.text.done 但 text 为空。 */
  text?: string | null;
  status?: number;
  delayMs?: number;
  /** 完全自定义事件序列（覆盖 text）。 */
  events?: object[];
  /** 不发 [DONE]，用来模拟流中断。 */
  withDone?: boolean;
};

function fakeAsr(options: FakeAsrOptions = {}): {
  fetchImpl: typeof fetch;
  requests: Record<string, unknown>[];
  readonly calls: number;
  readonly aborted: number;
} {
  const requests: Record<string, unknown>[] = [];
  const state = { aborted: 0 };
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (options.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const handle = setTimeout(resolve, options.delayMs);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(handle);
          state.aborted++;
          reject(Object.assign(Error('aborted'), { name: 'AbortError' }));
        });
      });
    }
    if (options.status && options.status !== 200) {
      return new Response('nope', { status: options.status });
    }
    const events = options.events ?? [
      { type: 'transcript.text.delta', text: '现在' },
      {
        type: 'transcript.text.done',
        text: options.text === null ? '' : (options.text ?? '现在几点了'),
      },
    ];
    return new Response(asrSse(events, options.withDone ?? true), { status: 200 });
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    requests,
    get calls() {
      return requests.length;
    },
    get aborted() {
      return state.aborted;
    },
  };
}

/** 一帧 40ms 的 PCM16（内容无关，长度相关）。 */
const FRAME_SAMPLES = 24000 * 0.04;
function frameBase64(): string {
  const bytes = new Uint8Array(FRAME_SAMPLES * 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 13) % 256;
  return bytesToBase64(bytes);
}

describe('transcribePcm16：/v1/audio/asr/sse 的请求形状与 SSE 解析', () => {
  test('请求体是嵌套的，音频是能解回 24k 单声道的 WAV', async () => {
    const asr = fakeAsr({ text: '把你挪到右下角' });
    const samples = new Int16Array(FRAME_SAMPLES * 5);
    for (let i = 0; i < samples.length; i++) samples[i] = (i % 2000) - 1000;
    const text = await transcribePcm16({
      apiKey: 'k',
      samples,
      sampleRate: 24000,
      fetchImpl: asr.fetchImpl,
    });
    assert.equal(text, '把你挪到右下角');
    // 这个形状是实测跑通的那一版（见 asr.ts 的注释），结构错一层就是 400。
    const body = asr.requests[0] as {
      audio: {
        data: string;
        input: {
          transcription: { model: string; language: string; hotwords: string[] };
          format: { type: string };
        };
      };
    };
    assert.equal(body.audio.input.transcription.model, ASR_MODEL);
    assert.equal(body.audio.input.transcription.language, 'zh');
    assert.deepEqual(body.audio.input.transcription.hotwords, [...ASR_HOTWORDS]);
    assert.equal(body.audio.input.format.type, 'wav');
    const decoded = decodeWav(base64ToBytes(body.audio.data));
    assert.equal(decoded.sampleRate, 24000);
    assert.equal(decoded.channels, 1);
    assert.deepEqual([...decoded.samples], [...samples], '上行的音频必须和采到的一模一样');
  });

  test('只认 transcript.text.done，delta 不当最终结果', async () => {
    const asr = fakeAsr({
      events: [
        { type: 'transcript.text.delta', text: '现在几' },
        { type: 'transcript.text.done', text: '  现在几点了  ' },
        { type: 'transcript.text.done', text: '不该读到这条' },
      ],
    });
    const text = await transcribePcm16({
      apiKey: 'k',
      samples: new Int16Array(FRAME_SAMPLES * 5),
      sampleRate: 24000,
      fetchImpl: asr.fetchImpl,
    });
    assert.equal(text, '现在几点了');
  });

  test('听了但没听出字 → 空字符串，不是异常（用户只是说得太轻）', async () => {
    const asr = fakeAsr({ text: null });
    assert.equal(
      await transcribePcm16({
        apiKey: 'k',
        samples: new Int16Array(FRAME_SAMPLES * 5),
        sampleRate: 24000,
        fetchImpl: asr.fetchImpl,
      }),
      '',
    );
  });

  test('error 事件 / 流断在 done 之前 / HTTP 失败都抛 AsrError，消息能直接给用户看', async () => {
    const base = { apiKey: 'k', samples: new Int16Array(FRAME_SAMPLES * 5), sampleRate: 24000 };
    await assert.rejects(
      () =>
        transcribePcm16({
          ...base,
          fetchImpl: fakeAsr({ events: [{ type: 'error', error: { message: 'bad audio' } }] })
            .fetchImpl,
        }),
      (error: unknown) => error instanceof AsrError && /识别失败.*bad audio/.test(error.message),
    );
    await assert.rejects(
      () =>
        transcribePcm16({
          ...base,
          fetchImpl: fakeAsr({
            events: [{ type: 'transcript.text.delta', text: '半' }],
            withDone: false,
          }).fetchImpl,
        }),
      (error: unknown) => error instanceof AsrError && /中断/.test(error.message),
    );
    await assert.rejects(
      () => transcribePcm16({ ...base, fetchImpl: fakeAsr({ status: 500 }).fetchImpl }),
      (error: unknown) => error instanceof AsrError && error.status === 500,
    );
  });

  test('外部 signal 能真的废掉在途请求', async () => {
    const asr = fakeAsr({ delayMs: 500 });
    const abort = new AbortController();
    const pending = transcribePcm16({
      apiKey: 'k',
      samples: new Int16Array(FRAME_SAMPLES * 5),
      sampleRate: 24000,
      signal: abort.signal,
      fetchImpl: asr.fetchImpl,
    });
    abort.abort();
    await assert.rejects(() => pending);
    assert.equal(asr.aborted, 1, '不能只是忽略结果 —— 请求要真的掐掉');
  });
});

// ------------------------------------------------------- 按住说话：采集 → 转写

type FakeMic = {
  create: (events: MicStreamEvents) => MicLike;
  feed: (frames: number) => void;
  reportError: (message: string) => void;
  releaseStart: () => void;
  readonly starts: number;
  readonly stops: number;
};

/** 假麦克风。holdStart：start() 卡住不返回，用来模拟权限框弹着。 */
function fakeMic(options: { failWith?: unknown; holdStart?: boolean } = {}): FakeMic {
  const state = { starts: 0, stops: 0, release: () => {} };
  let events: MicStreamEvents | null = null;
  const frame = frameBase64();
  const mic: MicLike = {
    async start() {
      state.starts++;
      if (options.holdStart) {
        await new Promise<void>((resolve) => {
          state.release = resolve;
        });
      }
      if (options.failWith) throw options.failWith;
    },
    stop() {
      state.stops++;
    },
  };
  return {
    create: (e) => {
      events = e;
      return mic;
    },
    feed(frames) {
      for (let i = 0; i < frames; i++) events?.onFrame(frame);
    },
    reportError(message) {
      events?.onError?.(message);
    },
    releaseStart() {
      state.release();
    },
    get starts() {
      return state.starts;
    },
    get stops() {
      return state.stops;
    },
  };
}

type RecorderHarness = {
  recorder: PushToTalkRecorder;
  mic: FakeMic;
  asr: ReturnType<typeof fakeAsr>;
  utterances: string[];
  errors: string[];
  notices: string[];
  states: string[];
};

function recorderHarness(
  asrOptions: FakeAsrOptions = {},
  micOptions: { failWith?: unknown; holdStart?: boolean } = {},
): RecorderHarness {
  const mic = fakeMic(micOptions);
  const asr = fakeAsr(asrOptions);
  const utterances: string[] = [];
  const errors: string[] = [];
  const notices: string[] = [];
  const states: string[] = [];
  const recorder = new PushToTalkRecorder({
    getApiKey: async () => 'k',
    createMic: mic.create,
    fetchImpl: asr.fetchImpl,
    events: {
      onUtterance: (text) => utterances.push(text),
      onError: (message) => errors.push(message),
      onNotice: (message) => notices.push(message),
      onState: (state) => states.push(state),
    },
  });
  return { recorder, mic, asr, utterances, errors, notices, states };
}

describe('PushToTalkRecorder：长按采集 → 松手转写', () => {
  test('一次正常长按：listening → transcribing → 一句话', async () => {
    const h = recorderHarness({ text: '现在几点了' });
    await h.recorder.begin();
    assert.equal(h.recorder.active, true, '按着的时候必须如实反映');
    h.mic.feed(20);
    h.recorder.end();
    assert.equal(h.recorder.active, false);
    await settle(30);
    assert.deepEqual(h.utterances, ['现在几点了']);
    assert.deepEqual(h.states, ['listening', 'transcribing']);
    assert.deepEqual(h.errors, []);
    // 上行音频的样本数 = 帧数 × 每帧样本数（攒帧的拼接没有丢帧）。
    const body = h.asr.requests[0] as { audio: { data: string } };
    assert.equal(decodeWav(base64ToBytes(body.audio.data)).samples.length, 20 * FRAME_SAMPLES);
    assert.equal(h.mic.stops >= 1, true, '松手必须放掉麦克风');
    h.recorder.dispose();
  });

  test('权限只在第一次长按时申请，不在构造时', async () => {
    const h = recorderHarness();
    assert.equal(h.mic.starts, 0, '构造录音器不该碰麦克风');
    await h.recorder.begin();
    assert.equal(h.mic.starts, 1);
    h.recorder.dispose();
  });

  test('短于下限（4 帧）的误触：静默丢弃，不发请求也不报错', async () => {
    const h = recorderHarness();
    await h.recorder.begin();
    h.mic.feed(MIN_PUSH_TO_TALK_FRAMES - 1);
    h.recorder.end();
    await settle(30);
    assert.equal(h.asr.calls, 0, '空/过短的音频不该提交');
    assert.deepEqual(h.errors, []);
    assert.deepEqual(h.notices, [], '误触连提示都不该有');
    assert.deepEqual(h.states, ['listening', 'idle']);
    assert.equal(h.recorder.active, false);
    h.recorder.dispose();
  });

  test('刚好到下限就提交 —— 下限和 realtime 侧是同一个常量', async () => {
    const h = recorderHarness({ text: '嗯' });
    await h.recorder.begin();
    h.mic.feed(MIN_PUSH_TO_TALK_FRAMES);
    h.recorder.end();
    await settle(30);
    assert.equal(h.asr.calls, 1);
    assert.deepEqual(h.utterances, ['嗯']);
    h.recorder.dispose();
  });

  test('cancel 废掉在途转写：结果不会迟到几秒后突然发出去', async () => {
    const h = recorderHarness({ text: '太晚了', delayMs: 200 });
    await h.recorder.begin();
    h.mic.feed(10);
    h.recorder.end();
    assert.equal(h.recorder.transcribing, true);
    await settle(10); // 等请求真的发出去，不然测的是「还没发」而不是「废掉了」
    assert.equal(h.asr.calls, 1);
    h.recorder.cancel();
    await settle(300);
    assert.deepEqual(h.utterances, [], '取消之后不能再发起一轮对话');
    assert.deepEqual(h.errors, [], '取消是正常操作，不是故障');
    assert.equal(h.asr.aborted, 1, '请求要真的掐掉，不只是忽略结果');
    h.recorder.dispose();
  });

  test('松手后立刻取消：请求还没发出去就被废掉，一个字节都不上行', async () => {
    const h = recorderHarness({ text: '太晚了', delayMs: 200 });
    await h.recorder.begin();
    h.mic.feed(10);
    h.recorder.end();
    h.recorder.cancel(); // 同一个 tick 里取消
    await settle(300);
    assert.equal(h.asr.calls, 0);
    assert.deepEqual(h.utterances, []);
    h.recorder.dispose();
  });

  test('新一次长按作废上一次在途的转写（用户重按就是不要上一句了）', async () => {
    const h = recorderHarness({ text: '上一句', delayMs: 200 });
    await h.recorder.begin();
    h.mic.feed(10);
    h.recorder.end();
    await settle(10);
    await h.recorder.begin();
    assert.equal(h.asr.aborted, 1);
    h.mic.feed(10);
    h.recorder.end();
    await settle(400);
    assert.deepEqual(h.utterances, ['上一句'], '只该有第二次那一段的结果');
    h.recorder.dispose();
  });

  test('dispose 放掉麦克风并废掉在途转写', async () => {
    const h = recorderHarness({ delayMs: 200 });
    await h.recorder.begin();
    h.mic.feed(10);
    h.recorder.end();
    await settle(10);
    h.recorder.dispose();
    await settle(300);
    assert.deepEqual(h.utterances, []);
    assert.equal(h.asr.aborted, 1);
    assert.equal(h.mic.stops >= 1, true);
    // dispose 之后再按也不该开麦。
    await h.recorder.begin();
    assert.equal(h.recorder.active, false);
  });

  test('麦克风打不开：给可操作的提示，状态落回 idle，不卡在「正在听」', async () => {
    const h = recorderHarness({}, { failWith: new DOMException('denied', 'NotAllowedError') });
    await h.recorder.begin();
    assert.equal(h.recorder.active, false);
    assert.equal(h.errors.length, 1);
    assert.match(h.errors[0], /授权/);
    assert.deepEqual(h.states, ['idle']);
    assert.equal(h.mic.stops >= 1, true, '失败路径也要放掉麦克风');
    h.recorder.dispose();
  });

  test('MicStream 自己报过错就不重复报一遍', async () => {
    const h = recorderHarness({}, { failWith: Error('boom') });
    const pending = h.recorder.begin();
    h.mic.reportError('麦克风被别的程序占用了。');
    await pending;
    assert.deepEqual(h.errors, ['麦克风被别的程序占用了。']);
    h.recorder.dispose();
  });

  test('权限框还弹着用户就松手了：放掉麦克风，不提交', async () => {
    const h = recorderHarness({}, { holdStart: true });
    const pending = h.recorder.begin();
    h.recorder.end();
    h.mic.releaseStart();
    await pending;
    await settle(30);
    assert.equal(h.asr.calls, 0);
    assert.equal(h.mic.stops >= 1, true);
    assert.equal(h.states.includes('listening'), false, '人都松手了，不该再显示「正在听」');
    h.recorder.dispose();
  });

  test('到 30 秒上限自动提交，不静默丢掉也不无限吃内存', async () => {
    const h = recorderHarness({ text: '说了很久' });
    await h.recorder.begin();
    h.mic.feed(MAX_PUSH_TO_TALK_MS / 40);
    await settle(30);
    assert.equal(h.asr.calls, 1, '到上限要自己提交，不等松手');
    assert.equal(h.recorder.active, false);
    assert.equal(h.notices.length, 1);
    assert.match(h.notices[0], /30 秒/);
    // 再喂帧不该又攒一段出来。
    h.mic.feed(10);
    h.recorder.end();
    await settle(30);
    assert.equal(h.asr.calls, 1);
    h.recorder.dispose();
  });

  test('没听清（服务端回空文本）→ notice，不是红框报错', async () => {
    const h = recorderHarness({ text: null });
    await h.recorder.begin();
    h.mic.feed(10);
    h.recorder.end();
    await settle(30);
    assert.deepEqual(h.utterances, []);
    assert.deepEqual(h.errors, []);
    assert.equal(h.notices.length, 1);
    assert.match(h.notices[0], /没听清/);
    assert.equal(h.states.at(-1), 'idle');
    h.recorder.dispose();
  });

  test('识别失败 → error 事件，状态落回 idle', async () => {
    const h = recorderHarness({ status: 500 });
    await h.recorder.begin();
    h.mic.feed(10);
    h.recorder.end();
    await settle(30);
    assert.equal(h.errors.length, 1);
    assert.match(h.errors[0], /语音识别暂时不可用（500）/);
    assert.equal(h.states.at(-1), 'idle');
    h.recorder.dispose();
  });
});

// ---------------------------------------------------------------- 假桌面

function fakeDesktop(overrides: Partial<Settings> = {}): Desktop & { settings: Settings } {
  let settings: Settings = { ...defaultSettings, brainMode: 'chat', ...overrides };
  const noop = (): (() => void) => () => {};
  const desktop = {
    available: true,
    async credentials(): Promise<Credentials> {
      return {
        apiKey: 'test-key',
        realtimeModel: 'r',
        visionModel: 'v',
        chatModel: 'step-3.7-flash',
      };
    },
    async credentialsStatus() {
      return {
        configured: true,
        fingerprint: 'sk-fak…fake',
        source: '/tmp/.env',
        userPath: '/tmp/.stepchan/.env',
      };
    },
    async setApiKey() {
      return {
        configured: true,
        fingerprint: 'sk-new…key1',
        source: '/tmp/.stepchan/.env',
        userPath: '/tmp/.stepchan/.env',
      };
    },
    async setHitRegions() {},
    async setInteractive() {},
    async moveToSpot() {},
    async focusPet() {},
    async startDragging() {},
    async openSettings() {},
    async quit() {},
    async workArea() {
      return null;
    },
    async captureScreen() {
      return { status: 'error' as const, message: '测试环境' };
    },
    async screenPermission() {
      return 'unknown' as const;
    },
    async frontmostApp() {
      return null;
    },
    async systemStatus() {
      return {
        battery: null,
        localTime: '2026-10-14 20:00',
        timezone: 'Asia/Shanghai',
        os: 'macOS 26',
      };
    },
    async readClipboardText() {
      return null;
    },
    async notify() {},
    async openUrl() {},
    async getSettings() {
      return settings;
    },
    async setSettings(patch: Partial<Settings>) {
      settings = { ...settings, ...patch };
      return settings;
    },
    onTrayCommand: noop,
    onHotkey: noop,
    onDragDrop: noop,
    onFrontmostChanged: noop,
    onHitTest: noop,
    onSettingsChanged: noop,
    get settings() {
      return settings;
    },
  };
  return desktop as Desktop & { settings: Settings };
}

// ---------------------------------------------------------------- 对话循环

type Turn = { chunks: object[] };

/** 按顺序返回预设的若干轮响应，并记录每次请求体。 */
function scriptedFetch(turns: Turn[]): {
  fetchImpl: typeof fetch;
  bodies: Record<string, unknown>[];
} {
  const bodies: Record<string, unknown>[] = [];
  let index = 0;
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const turn = turns[Math.min(index++, turns.length - 1)];
    return new Response(chatSse(turn.chunks), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, bodies };
}

function toolCallChunk(index: number, id: string, name: string, args: string): object {
  return {
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [{ index, id, type: 'function', function: { name, arguments: args } }],
        },
      },
    ],
  };
}

type Harness = {
  session: ChatSession;
  events: PetEvent[];
  spoken: string[];
  executed: { name: ToolName; args: unknown }[];
  bodies: Record<string, unknown>[];
};

function harness(
  turns: Turn[],
  execute?: (name: ToolName, args: unknown) => Promise<ToolResult>,
): Harness {
  const events: PetEvent[] = [];
  const spoken: string[] = [];
  const executed: { name: ToolName; args: unknown }[] = [];
  const { fetchImpl, bodies } = scriptedFetch(turns);
  const session = new ChatSession({
    getApiKey: async () => 'k',
    getModel: () => 'step-5-preview',
    getInstructions: () => '系统提示',
    tools: toolDefinitions,
    executeTool: async (name, args) => {
      executed.push({ name, args });
      return execute ? execute(name, args) : { ok: true, message: '做好了。' };
    },
    emit: (event) => events.push(event),
    speech: { speak: (text) => spoken.push(text), cancel: () => {} },
    fetchImpl,
  });
  return { session, events, spoken, executed, bodies };
}

describe('ChatSession：一轮对话跑完', () => {
  test('纯文字回复：字幕流 + 最终文本 + 按句送 TTS', async () => {
    const h = harness([
      { chunks: [contentChunk('你正在用终端跑测试，'), contentChunk('看起来挺忙。'), doneChunk()] },
    ]);
    await h.session.sendText('我在干什么');

    const partials = h.events.filter((e) => e.type === 'pet_transcript' && !e.final);
    assert.ok(partials.length >= 2, '应该有增量字幕');
    // turn_start 必须先于本轮字幕：UI 靠它收掉上一句，晚到就会把新字幕清掉
    // （症状是「只有语音，没有气泡」）。两种大脑都要守这个约定。
    const types = h.events.map((e) => e.type);
    assert.ok(
      types.indexOf('turn_start') >= 0 &&
        types.indexOf('turn_start') < types.indexOf('pet_transcript'),
      'chat 模式也必须先发 turn_start',
    );
    const final = h.events.find((e) => e.type === 'pet_transcript' && e.final);
    assert.equal(
      final?.type === 'pet_transcript' ? final.text : '',
      '你正在用终端跑测试，看起来挺忙。',
    );
    assert.deepEqual(h.spoken, ['你正在用终端跑测试，', '看起来挺忙。']);
    assert.deepEqual(
      h.events
        .filter((e) => e.type === 'activity')
        .map((e) => (e.type === 'activity' ? e.value : '')),
      ['thinking'],
      '声音还在播时不该发 idle',
    );
  });

  test('工具调用 → 执行 → 回灌 → 继续说话', async () => {
    const h = harness(
      [
        { chunks: [toolCallChunk(0, 'c1', 'get_time', '{}'), doneChunk('tool_calls')] },
        { chunks: [contentChunk('现在八点半。'), doneChunk()] },
      ],
      async () => ({ ok: true, message: '现在是 20:30。' }),
    );
    await h.session.sendText('几点了');

    assert.deepEqual(h.executed, [{ name: 'get_time', args: {} }]);
    assert.ok(h.events.some((e) => e.type === 'tool_start' && e.name === 'get_time'));
    assert.ok(h.events.some((e) => e.type === 'tool_end' && e.result.ok));
    assert.deepEqual(h.spoken, ['现在八点半。']);

    // 第二次请求的 messages 里必须有成对的 assistant(tool_calls) + tool 结果
    const messages = h.bodies[1].messages as { role: string; tool_call_id?: string }[];
    const assistantIndex = messages.findIndex((m) => m.role === 'assistant');
    assert.ok(assistantIndex > 0);
    assert.equal(messages[assistantIndex + 1].role, 'tool');
    assert.equal(messages[assistantIndex + 1].tool_call_id, 'c1');
  });

  test('工具结果失败时照样回灌 —— 她要能把拒绝原因讲给用户', async () => {
    const h = harness(
      [
        {
          chunks: [
            toolCallChunk(0, 'c1', 'glance_screen', '{"reason":"看看"}'),
            doneChunk('tool_calls'),
          ],
        },
        { chunks: [contentChunk('屏幕感知关着，我看不到。'), doneChunk()] },
      ],
      async () => ({ ok: false, message: '屏幕感知是关着的，告诉用户去菜单里打开。' }),
    );
    await h.session.sendText('看一下我的屏幕');
    const messages = h.bodies[1].messages as { role: string; content?: string }[];
    const toolMessage = messages.find((m) => m.role === 'tool');
    assert.match(String(toolMessage?.content), /屏幕感知是关着的/);
    assert.deepEqual(h.spoken, ['屏幕感知关着，我看不到。']);
  });

  test('参数非法时不执行工具，把原因回灌让她重来', async () => {
    const h = harness([
      {
        chunks: [
          toolCallChunk(0, 'c1', 'set_timer', '{"seconds":5,"label":"x"}'), // 下限是 10 秒
          doneChunk('tool_calls'),
        ],
      },
      { chunks: [contentChunk('这个时间太短了。'), doneChunk()] },
    ]);
    await h.session.sendText('5 秒后提醒我');
    assert.deepEqual(h.executed, [], '非法参数不该执行');
    const messages = h.bodies[1].messages as { role: string; content?: string }[];
    assert.match(String(messages.find((m) => m.role === 'tool')?.content), /参数不合法/);
  });

  test('参数不是合法 JSON 时也不执行', async () => {
    const h = harness([
      { chunks: [toolCallChunk(0, 'c1', 'get_time', '{这不是JSON'), doneChunk('tool_calls')] },
      { chunks: [contentChunk('我再试一次。'), doneChunk()] },
    ]);
    await h.session.sendText('几点');
    assert.deepEqual(h.executed, []);
  });

  test('不存在的工具名被挡住', async () => {
    const h = harness([
      { chunks: [toolCallChunk(0, 'c1', 'launch_missiles', '{}'), doneChunk('tool_calls')] },
      { chunks: [contentChunk('我没有这个本事。'), doneChunk()] },
    ]);
    await h.session.sendText('发射导弹');
    assert.deepEqual(h.executed, []);
    const messages = h.bodies[1].messages as { role: string; content?: string }[];
    assert.match(
      String(messages.find((m) => m.role === 'tool')?.content),
      /没有叫 launch_missiles/,
    );
  });

  test(`每轮最多执行 ${MAX_TOOL_CALLS_PER_TURN} 个工具，超了就只回拒绝消息`, async () => {
    // 每轮都调一次工具，连调 6 轮。
    const turn: Turn = {
      chunks: [toolCallChunk(0, `c${Math.random()}`, 'get_time', '{}'), doneChunk('tool_calls')],
    };
    const turns: Turn[] = [];
    for (let i = 0; i < 6; i++) {
      turns.push({
        chunks: [toolCallChunk(0, `c${i}`, 'get_time', '{}'), doneChunk('tool_calls')],
      });
    }
    void turn;
    turns.push({ chunks: [contentChunk('好了不查了。'), doneChunk()] });
    const h = harness(turns);
    await h.session.sendText('一直查时间');
    assert.equal(h.executed.length, MAX_TOOL_CALLS_PER_TURN);
  });

  test('额度用完后那一轮不再带 tools —— 强制她说话收尾', async () => {
    const turns: Turn[] = [];
    for (let i = 0; i < 5; i++) {
      turns.push({
        chunks: [toolCallChunk(0, `c${i}`, 'get_time', '{}'), doneChunk('tool_calls')],
      });
    }
    const h = harness(turns);
    await h.session.sendText('一直查时间');
    const withTools = h.bodies.filter((b) => 'tools' in b).length;
    assert.ok(withTools <= MAX_TOOL_CALLS_PER_TURN, `带 tools 的请求应该收住，实际 ${withTools}`);
    assert.ok(
      h.bodies.some((b) => !('tools' in b)),
      '最后应该有一次不带 tools 的请求',
    );
  });

  test('同一个 call id 只执行一次（幂等）', async () => {
    const h = harness([
      {
        chunks: [
          toolCallChunk(0, 'same', 'set_timer', '{"seconds":60,"label":"喝水"}'),
          toolCallChunk(1, 'same', 'set_timer', '{"seconds":60,"label":"喝水"}'),
          doneChunk('tool_calls'),
        ],
      },
      { chunks: [contentChunk('设好了。'), doneChunk()] },
    ]);
    await h.session.sendText('一分钟后提醒我喝水');
    assert.equal(h.executed.length, 1, '重复的 call id 不该执行两次');
  });

  test('模型空回复时撤掉 tools 重试一次，仍为空就如实报错', async () => {
    const h = harness([
      { chunks: [doneChunk()] },
      { chunks: [doneChunk()] },
      { chunks: [doneChunk()] },
    ]);
    await h.session.sendText('说句话');
    assert.ok(
      h.events.some((e) => e.type === 'error' && /空回复/.test(e.message)),
      '应该如实报「空回复」而不是静默',
    );
    assert.equal(h.bodies.length, 2, '只重试一次');
  });

  test('打断：停掉合成、已说出口的半句留在历史里', async () => {
    let cancelled = 0;
    const events: PetEvent[] = [];
    const session = new ChatSession({
      getApiKey: async () => 'k',
      getModel: () => 'm',
      getInstructions: () => '系统',
      tools: toolDefinitions,
      executeTool: async () => ({ ok: true, message: '' }),
      emit: (e) => events.push(e),
      speech: { speak: () => {}, cancel: () => cancelled++ },
      // 一个永远不结束的流，等我们打断它。真 fetch 在 abort 时会让 body 流出错，
      // 假的也必须照做 —— 不然 abort 对这个测试毫无作用，只会把用例挂到超时。
      fetchImpl: (async (_url: unknown, init?: RequestInit) =>
        new Response(
          new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(contentChunk('我正在说'))}\n\n`),
              );
              init?.signal?.addEventListener('abort', () => {
                controller.error(Object.assign(Error('aborted'), { name: 'AbortError' }));
              });
              // 不 close —— 模拟还没说完
            },
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
    });
    const turn = session.sendText('说点什么');
    await new Promise((r) => setTimeout(r, 30));
    session.interrupt();
    await turn;
    assert.ok(cancelled >= 1, '打断必须取消在途合成');
    const assistant = session.messages.filter((m) => m.role === 'assistant');
    assert.equal(assistant.length, 1);
    assert.equal(assistant[0].role === 'assistant' ? assistant[0].content : '', '我正在说');
    assert.ok(!events.some((e) => e.type === 'error'), '打断是正常操作，不该报错');
  });

  test('新一句话会先打断上一轮，两段话不会叠在一起', async () => {
    const h = harness([
      { chunks: [contentChunk('第一轮。'), doneChunk()] },
      { chunks: [contentChunk('第二轮。'), doneChunk()] },
    ]);
    await h.session.sendText('一');
    await h.session.sendText('二');
    const finals = h.events
      .filter((e) => e.type === 'pet_transcript' && e.final)
      .map((e) => (e.type === 'pet_transcript' ? e.text : ''));
    assert.deepEqual(finals, ['第一轮。', '第二轮。']);
  });

  test('空输入什么都不做', async () => {
    const h = harness([{ chunks: [contentChunk('不该发生'), doneChunk()] }]);
    await h.session.sendText('   ');
    assert.equal(h.bodies.length, 0);
  });

  test('system prompt 每轮重新取，不进历史', async () => {
    let version = 1;
    const { fetchImpl, bodies } = scriptedFetch([
      { chunks: [contentChunk('一。'), doneChunk()] },
      { chunks: [contentChunk('二。'), doneChunk()] },
    ]);
    const session = new ChatSession({
      getApiKey: async () => 'k',
      getModel: () => 'm',
      getInstructions: () => `提示 v${version}`,
      tools: toolDefinitions,
      executeTool: async () => ({ ok: true, message: '' }),
      emit: () => {},
      fetchImpl,
    });
    await session.sendText('一');
    version = 2;
    await session.sendText('二');
    const first = (bodies[0].messages as { role: string; content: string }[])[0];
    const second = (bodies[1].messages as { role: string; content: string }[])[0];
    assert.equal(first.content, '提示 v1');
    assert.equal(second.content, '提示 v2', '改了设置应该下一轮立刻生效');
    assert.equal(
      (bodies[1].messages as { role: string }[]).filter((m) => m.role === 'system').length,
      1,
      'system 只能有一条',
    );
  });

  test('历史裁剪不会让窗口从 tool 结果开头（那样服务端直接 400）', async () => {
    const turns: Turn[] = [];
    // 每轮都「调一次工具 + 说一句话」，攒出一堆 assistant/tool 配对。
    for (let i = 0; i < 20; i++) {
      turns.push({
        chunks: [toolCallChunk(0, `t${i}`, 'get_time', '{}'), doneChunk('tool_calls')],
      });
      turns.push({ chunks: [contentChunk(`第 ${i} 句。`), doneChunk()] });
    }
    const h = harness(turns);
    for (let i = 0; i < 20; i++) await h.session.sendText(`问题 ${i}`);
    const history = h.session.messages;
    assert.ok(history.length > 0);
    assert.notEqual(history[0].role, 'tool', '第一条不能是 tool 结果');
    // 每条 tool 结果前面都必须能找到带 tool_calls 的 assistant
    for (let i = 0; i < history.length; i++) {
      if (history[i].role !== 'tool') continue;
      let j = i - 1;
      while (j >= 0 && history[j].role === 'tool') j--;
      assert.ok(j >= 0, 'tool 结果前面必须有 assistant');
      const owner = history[j];
      assert.ok(
        owner.role === 'assistant' && owner.tool_calls?.length,
        'tool 结果必须跟着它的调用',
      );
    }
  });

  test('HTTP 失败时发 error 事件，不抛到调用方', async () => {
    const events: PetEvent[] = [];
    const session = new ChatSession({
      getApiKey: async () => 'k',
      getModel: () => 'm',
      getInstructions: () => '提示',
      tools: toolDefinitions,
      executeTool: async () => ({ ok: true, message: '' }),
      emit: (e) => events.push(e),
      fetchImpl: (async () => new Response('bad', { status: 401 })) as unknown as typeof fetch,
    });
    await assert.doesNotReject(() => session.sendText('你好'));
    assert.ok(events.some((e) => e.type === 'error' && /key/.test(e.message)));
  });

  test('工具执行器抛错时转成失败结果回灌，而不是让整轮崩掉', async () => {
    const h = harness(
      [
        { chunks: [toolCallChunk(0, 'c1', 'get_time', '{}'), doneChunk('tool_calls')] },
        { chunks: [contentChunk('查不到时间。'), doneChunk()] },
      ],
      async () => {
        throw Error('炸了');
      },
    );
    await h.session.sendText('几点');
    const messages = h.bodies[1].messages as { role: string; content?: string }[];
    assert.match(String(messages.find((m) => m.role === 'tool')?.content), /工具执行失败/);
  });

  test('voiceEnabled 关掉（不传 speech）时文字照出，不做合成', async () => {
    const { fetchImpl } = scriptedFetch([{ chunks: [contentChunk('好的。'), doneChunk()] }]);
    const events: PetEvent[] = [];
    const session = new ChatSession({
      getApiKey: async () => 'k',
      getModel: () => 'm',
      getInstructions: () => '提示',
      tools: toolDefinitions,
      executeTool: async () => ({ ok: true, message: '' }),
      emit: (e) => events.push(e),
      fetchImpl,
    });
    await session.sendText('你好');
    assert.ok(events.some((e) => e.type === 'pet_transcript' && e.final));
    // 没有 speech 时结束就该回 idle
    assert.ok(
      events.some((e) => e.type === 'activity' && e.value === 'idle'),
      '不出声时应该直接回 idle',
    );
  });
});

// ---------------------------------------------------------------- 按句 TTS

function fakeSink(): SpeechSink & { clips: string[]; flushes: number } {
  const clips: string[] = [];
  let flushes = 0;
  return {
    enqueue(base64) {
      clips.push(base64);
    },
    flush() {
      flushes++;
    },
    get clips() {
      return clips;
    },
    get flushes() {
      return flushes;
    },
  };
}

/** 返回一个合成「长度 = 文本长度」的假 TTS。 */
function fakeTts(options: { status?: number; delayMs?: number } = {}): {
  fetchImpl: typeof fetch;
  requests: Record<string, unknown>[];
  aborted: number;
} {
  const requests: Record<string, unknown>[] = [];
  const state = { aborted: 0 };
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(body);
    if (options.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const handle = setTimeout(resolve, options.delayMs);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(handle);
          state.aborted++;
          reject(Object.assign(Error('aborted'), { name: 'AbortError' }));
        });
      });
    }
    if (options.status && options.status !== 200) {
      return new Response('nope', { status: options.status });
    }
    const samples = new Int16Array(String(body.input).length * 8);
    for (let i = 0; i < samples.length; i++) samples[i] = i % 100;
    const wav = makeWav(samples, 24000, 1, true);
    return new Response(wav.buffer as ArrayBuffer, { status: 200 });
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    requests,
    get aborted() {
      return state.aborted;
    },
  };
}

async function settle(ms = 60): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe('SpeechSynthesizer：按句合成、排队播放、可取消', () => {
  test('合成一段并剥壳成 base64 PCM 塞进播放环', async () => {
    const sink = fakeSink();
    const tts = fakeTts();
    const synth = new SpeechSynthesizer({
      getApiKey: async () => 'k',
      getVoice: () => 'yuanqishaonv',
      sink,
      fetchImpl: tts.fetchImpl,
    });
    synth.speak('你好呀。');
    await settle();
    assert.equal(sink.clips.length, 1);
    assert.ok(sink.clips[0].length > 0);
    assert.equal(tts.requests[0].model, 'stepaudio-3-tts');
    assert.equal(tts.requests[0].voice, 'yuanqishaonv');
    assert.equal(tts.requests[0].response_format, 'wav');
    assert.equal(tts.requests[0].sample_rate, 24000);
    synth.dispose();
  });

  test('音色每段都重新读 —— chat 模式换音色不用重建任何东西', async () => {
    const sink = fakeSink();
    const tts = fakeTts();
    let voice = 'yuanqishaonv';
    const synth = new SpeechSynthesizer({
      getApiKey: async () => 'k',
      getVoice: () => voice,
      sink,
      fetchImpl: tts.fetchImpl,
    });
    synth.speak('第一段。');
    await settle();
    voice = 'linjiameimei';
    synth.speak('第二段。');
    await settle();
    assert.deepEqual(
      tts.requests.map((r) => r.voice),
      ['yuanqishaonv', 'linjiameimei'],
    );
    synth.dispose();
  });

  test('多段串行合成，顺序不乱', async () => {
    const sink = fakeSink();
    const tts = fakeTts({ delayMs: 10 });
    const synth = new SpeechSynthesizer({
      getApiKey: async () => 'k',
      getVoice: () => 'v',
      sink,
      fetchImpl: tts.fetchImpl,
    });
    synth.speak('一。');
    synth.speak('二二。');
    synth.speak('三三三。');
    await settle(300);
    assert.deepEqual(
      tts.requests.map((r) => r.input),
      ['一。', '二二。', '三三三。'],
      '必须串行、按顺序',
    );
    synth.dispose();
  });

  test('cancel 废掉在途请求、清空播放环、唤醒等待', async () => {
    const sink = fakeSink();
    const tts = fakeTts({ delayMs: 5000 });
    const synth = new SpeechSynthesizer({
      getApiKey: async () => 'k',
      getVoice: () => 'v',
      sink,
      fetchImpl: tts.fetchImpl,
    });
    synth.speak('这句会被打断。');
    await settle(20);
    synth.cancel();
    await settle(30);
    assert.equal(tts.aborted, 1, '在途合成请求必须一起废掉');
    assert.ok(sink.flushes >= 1, 'cancel 必须清空播放环');
    assert.equal(sink.clips.length, 0, '取消掉的音频不该被播出来');
    synth.dispose();
  });

  test('cancel 之后迟到的音频不会被播出来', async () => {
    const sink = fakeSink();
    // 不用 abort 的假实现：请求照常完成，但 epoch 已经变了。
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string };
      await settle(40);
      return new Response(makeWav(new Int16Array(body.input.length * 8)).buffer as ArrayBuffer, {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const synth = new SpeechSynthesizer({
      getApiKey: async () => 'k',
      getVoice: () => 'v',
      sink,
      fetchImpl,
    });
    synth.speak('迟到的音频。');
    synth.cancel();
    await settle(120);
    assert.equal(sink.clips.length, 0);
    synth.dispose();
  });

  test('合成失败如实上报，文字不受影响', async () => {
    const sink = fakeSink();
    const tts = fakeTts({ status: 503 });
    const errors: string[] = [];
    const synth = new SpeechSynthesizer({
      getApiKey: async () => 'k',
      getVoice: () => 'v',
      sink,
      onError: (message) => errors.push(message),
      fetchImpl: tts.fetchImpl,
    });
    synth.speak('念不出来。');
    await settle(80);
    assert.equal(sink.clips.length, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /503/);
    synth.dispose();
  });

  test('坏 WAV 不会把整条链卡死，后面的段落照常', async () => {
    const sink = fakeSink();
    let call = 0;
    const errors: string[] = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string };
      call++;
      if (call === 1)
        return new Response(new Uint8Array(10).buffer as ArrayBuffer, { status: 200 });
      return new Response(makeWav(new Int16Array(body.input.length * 8)).buffer as ArrayBuffer, {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const synth = new SpeechSynthesizer({
      getApiKey: async () => 'k',
      getVoice: () => 'v',
      sink,
      onError: (message) => errors.push(message),
      fetchImpl,
    });
    synth.speak('坏的。');
    await settle(60);
    synth.speak('好的。');
    await settle(120);
    assert.equal(sink.clips.length, 1, '第二段应该照常播');
    assert.ok(errors.some((e) => /WAV/.test(e)));
    synth.dispose();
  });

  test('空文本不发请求', async () => {
    const sink = fakeSink();
    const tts = fakeTts();
    const synth = new SpeechSynthesizer({
      getApiKey: async () => 'k',
      getVoice: () => 'v',
      sink,
      fetchImpl: tts.fetchImpl,
    });
    synth.speak('   ');
    await settle();
    assert.equal(tts.requests.length, 0);
    synth.dispose();
  });

  test('一轮里的段落数有上限，跑飞了不会无限合成', async () => {
    const sink = fakeSink();
    const tts = fakeTts();
    const synth = new SpeechSynthesizer({
      getApiKey: async () => 'k',
      getVoice: () => 'v',
      sink,
      fetchImpl: tts.fetchImpl,
    });
    for (let i = 0; i < 40; i++) synth.speak(`第 ${i} 段。`);
    await settle(400);
    assert.ok(tts.requests.length <= 12, `段落数应该有上限，实际 ${tts.requests.length}`);
    synth.dispose();
  });
});

// ---------------------------------------------------------------- 人设

describe('buildChatInstructions：公共人设 + chat 模式补充', () => {
  const context = { settings: defaultSettings, desktopAvailable: true, timezone: 'Asia/Shanghai' };

  test('保留公共人设里的硬约束（只说中文、不要 markdown、不要舞台提示）', () => {
    const text = buildChatInstructions(context);
    assert.match(text, /只说中文/);
    assert.match(text, /markdown/);
    assert.match(text, /歪头/);
  });

  test('加了「先调工具再说话」的推动，并写明不得越过隐私开关', () => {
    const text = buildChatInstructions(context);
    assert.match(text, /直接调 glance_screen/);
    assert.match(text, /不要先说「我看不到你的屏幕」/);
    assert.match(text, /拒绝原因照实说给用户/);
  });

  test('说明她拿到的只是文字（听不到语气），但不假设用户是在打字', () => {
    const text = buildChatInstructions(context);
    assert.match(text, /永远是文字/);
    assert.match(text, /长按你说话/, '接上按住说话之后不能再说「只接文字输入」');
    assert.doesNotMatch(
      text,
      /再打一次/,
      '用户可能是说出来的 —— 让他「再打一次」就是前一版留下的 bug',
    );
  });

  test('隐私开关状态照旧体现在提示里', () => {
    const on = buildChatInstructions({
      ...context,
      settings: { ...defaultSettings, screenAwareness: true },
    });
    const off = buildChatInstructions(context);
    assert.match(on, /屏幕感知：已开启/);
    assert.match(off, /屏幕感知：已关闭/);
  });
});

// ---------------------------------------------------------------- ChatBrain

function fakeAudio(): {
  create: (events: {
    onLevel(level: number): void;
    onStarted(): void;
    onDrained(): void;
    onError(message: string): void;
  }) => AudioOutput;
  clips: string[];
} {
  const clips: string[] = [];
  return {
    clips,
    create: (events) => ({
      async start() {},
      async dispose() {},
      get audioLevel() {
        return 0;
      },
      enqueue(base64: string) {
        clips.push(base64);
        events.onStarted();
      },
      flush() {
        events.onDrained();
      },
    }),
  };
}

/** 让 ChatBrain 的三种请求（chat / tts / asr）各走各的假实现。 */
function brainFetch(turns: Turn[], asr?: ReturnType<typeof fakeAsr>): typeof fetch {
  const chat = scriptedFetch(turns);
  const tts = fakeTts();
  return (async (url: unknown, init?: RequestInit) => {
    if (String(url).includes('/audio/speech')) return tts.fetchImpl(url as string, init);
    if (String(url).includes('/audio/asr')) {
      if (!asr) throw Error('这个用例没准备假 ASR');
      return asr.fetchImpl(url as string, init);
    }
    return chat.fetchImpl(url as string, init);
  }) as unknown as typeof fetch;
}

describe('ChatBrain：与 Brain 公开面一致的另一实现', () => {
  test('两个实现都满足 PetBrain，工厂按模式选一个', () => {
    // 类型层面的一致性由 factory.ts 的 AssertAssignable 在 typecheck 时保证，
    // 这里只检查运行时确实造出了不同的实现。
    const realtime = createBrain('realtime', { desktop: fakeDesktop() });
    const chat = createBrain('chat', { desktop: fakeDesktop() });
    assert.ok(realtime instanceof Brain);
    assert.ok(chat instanceof ChatBrain);
    // 公开面的每个成员都得在
    const api: (keyof PetBrain)[] = [
      'on',
      'start',
      'stop',
      'dispose',
      'sendText',
      'setVoice',
      'refreshSettings',
      'interrupt',
      'enableMic',
      'disableMic',
      'beginPushToTalk',
      'endPushToTalk',
      'pushToTalkActive',
      'listening',
      'voiceInterruptible',
      'audioLevel',
      'running',
      'transcript',
    ];
    for (const key of api) {
      assert.notEqual(
        (chat as unknown as Record<string, unknown>)[key],
        undefined,
        `ChatBrain 缺 ${key}`,
      );
      assert.notEqual(
        (realtime as unknown as Record<string, unknown>)[key],
        undefined,
        `Brain 缺 ${key}`,
      );
    }
  });

  test('打字 → 回复 → 出音频；transcript 记下两边', async () => {
    const audio = fakeAudio();
    const brain = new ChatBrain({
      desktop: fakeDesktop(),
      createAudio: audio.create,
      fetchImpl: brainFetch([{ chunks: [contentChunk('你好呀。'), doneChunk()] }]),
    });
    const events: PetEvent[] = [];
    brain.on((e) => events.push(e));
    await brain.start(false);
    assert.equal(brain.running, true);
    await brain.sendText('嗨');
    await settle(120);
    assert.deepEqual(
      brain.transcript.map((e) => [e.role, e.text]),
      [
        ['user', '嗨'],
        ['pet', '你好呀。'],
      ],
    );
    assert.equal(audio.clips.length, 1);
    assert.ok(events.some((e) => e.type === 'connection' && e.state === 'open'));
    await brain.dispose();
    assert.equal(brain.running, false);
  });

  test('voiceEnabled=false 时只出文字不合成', async () => {
    const audio = fakeAudio();
    const brain = new ChatBrain({
      desktop: fakeDesktop({ voiceEnabled: false }),
      createAudio: audio.create,
      fetchImpl: brainFetch([{ chunks: [contentChunk('静音模式。'), doneChunk()] }]),
    });
    await brain.start(false);
    await brain.sendText('嗨');
    await settle(120);
    assert.equal(audio.clips.length, 0);
    assert.equal(brain.transcript.at(-1)?.text, '静音模式。');
    await brain.dispose();
  });

  test('setVoice 只写设置，不重建会话（realtime 必须重建，这里不用）', async () => {
    const desktop = fakeDesktop();
    const brain = new ChatBrain({
      desktop,
      createAudio: fakeAudio().create,
      fetchImpl: brainFetch([{ chunks: [contentChunk('好。'), doneChunk()] }]),
    });
    await brain.start(false);
    const before = brain.transcript.length;
    await brain.setVoice('linjiameimei');
    assert.equal(desktop.settings.voice, 'linjiameimei');
    assert.equal(brain.running, true, '换音色不该把会话弄没了');
    assert.equal(brain.transcript.length, before, '换音色不该丢上下文');
    await brain.dispose();
  });

  test('enableMic：持续聆听没有，但如实告知可以长按说话', async () => {
    const brain = new ChatBrain({ desktop: fakeDesktop(), createAudio: fakeAudio().create });
    const events: PetEvent[] = [];
    brain.on((e) => events.push(e));
    await brain.enableMic();
    assert.ok(
      events.some((e) => e.type === 'notice' && /长按/.test(e.message)),
      '用户点了麦克风就得知道这个模式只能按住说',
    );
    assert.equal(
      events.some((e) => e.type === 'error'),
      false,
      '能力说明不该走 error 通道（UI 给 error 配的是告警样式）',
    );
    brain.disableMic(); // 不该抛
    await brain.dispose();
  });

  test('按住说话：长按 → 转写 → 自动走打字那条链（含 user_transcript）', async () => {
    const audio = fakeAudio();
    const mic = fakeMic();
    const asr = fakeAsr({ text: '现在几点了' });
    const brain = new ChatBrain({
      desktop: fakeDesktop(),
      createAudio: audio.create,
      createMic: mic.create,
      fetchImpl: brainFetch([{ chunks: [contentChunk('下午三点。'), doneChunk()] }], asr),
    });
    const events: PetEvent[] = [];
    brain.on((e) => events.push(e));
    await brain.start(false);
    assert.equal(mic.starts, 0, '麦克风权限不该在 start() 里申请');

    await brain.beginPushToTalk();
    assert.equal(brain.pushToTalkActive, true, 'pushToTalkActive 要如实反映状态');
    assert.equal(mic.starts, 1, '权限在第一次长按时才申请');
    mic.feed(20);
    brain.endPushToTalk();
    assert.equal(brain.pushToTalkActive, false);
    await settle(150);

    // 气泡要显示用户说了什么 —— 否则按住说完界面上看不到自己说了啥。
    assert.ok(
      events.some((e) => e.type === 'user_transcript' && e.text === '现在几点了' && e.final),
      '缺 user_transcript(final)',
    );
    assert.deepEqual(
      brain.transcript.map((e) => [e.role, e.text]),
      [
        ['user', '现在几点了'],
        ['pet', '下午三点。'],
      ],
    );
    assert.equal(audio.clips.length, 1, '语音输入也该照常出声');
    assert.ok(events.some((e) => e.type === 'activity' && e.value === 'listening'));
    assert.equal(
      events.some((e) => e.type === 'error'),
      false,
    );
    await brain.dispose();
    assert.equal(mic.stops >= 1, true, 'dispose 必须放掉麦克风');
  });

  test('长按太短：静默丢弃，不提交也不弹提示', async () => {
    const mic = fakeMic();
    const asr = fakeAsr();
    const brain = new ChatBrain({
      desktop: fakeDesktop(),
      createAudio: fakeAudio().create,
      createMic: mic.create,
      fetchImpl: brainFetch([], asr),
    });
    const events: PetEvent[] = [];
    brain.on((e) => events.push(e));
    await brain.start(false);
    await brain.beginPushToTalk();
    mic.feed(MIN_PUSH_TO_TALK_FRAMES - 1);
    brain.endPushToTalk();
    await settle(60);
    assert.equal(asr.calls, 0);
    assert.equal(brain.transcript.length, 0);
    assert.equal(
      events.some((e) => e.type === 'error' || e.type === 'notice'),
      false,
      '误触不该让她说话也不该报错',
    );
    await brain.dispose();
  });

  test('会话没起来就长按也能用（和 Brain 的行为一致）', async () => {
    const mic = fakeMic();
    const asr = fakeAsr({ text: '你好呀' });
    const brain = new ChatBrain({
      desktop: fakeDesktop(),
      createAudio: fakeAudio().create,
      createMic: mic.create,
      fetchImpl: brainFetch([{ chunks: [contentChunk('嗨！'), doneChunk()] }], asr),
    });
    await brain.beginPushToTalk();
    assert.equal(brain.running, true, '长按该把会话先起起来');
    mic.feed(10);
    brain.endPushToTalk();
    await settle(150);
    assert.equal(brain.transcript.at(-1)?.text, '嗨！');
    await brain.dispose();
  });

  test('interrupt / stop 废掉在途转写：切模式之后不会冒出一句话', async () => {
    const mic = fakeMic();
    const asr = fakeAsr({ text: '来不及了', delayMs: 150 });
    const brain = new ChatBrain({
      desktop: fakeDesktop(),
      createAudio: fakeAudio().create,
      createMic: mic.create,
      fetchImpl: brainFetch([{ chunks: [contentChunk('不该说出来。'), doneChunk()] }], asr),
    });
    await brain.start(false);
    await brain.beginPushToTalk();
    mic.feed(10);
    brain.endPushToTalk();
    await settle(10);
    brain.interrupt();
    await settle(250);
    assert.equal(brain.transcript.length, 0, 'interrupt 之后转写不该再发起一轮');
    assert.equal(asr.aborted, 1);

    // 再来一次，这次用 stop（切模式走的就是这条路）。
    await brain.beginPushToTalk();
    mic.feed(10);
    brain.endPushToTalk();
    await settle(10);
    await brain.stop();
    await settle(250);
    assert.equal(brain.transcript.length, 0);
    assert.equal(asr.aborted, 2);
    assert.equal(mic.stops >= 2, true, '每次都要放掉麦克风');
    await brain.dispose();
  });

  test('识别失败走 error 事件，不抛给长按手势', async () => {
    const mic = fakeMic();
    const asr = fakeAsr({ status: 500 });
    const brain = new ChatBrain({
      desktop: fakeDesktop(),
      createAudio: fakeAudio().create,
      createMic: mic.create,
      fetchImpl: brainFetch([], asr),
    });
    const events: PetEvent[] = [];
    brain.on((e) => events.push(e));
    await brain.start(false);
    await assert.doesNotReject(() => brain.beginPushToTalk());
    mic.feed(10);
    brain.endPushToTalk();
    await settle(60);
    assert.ok(events.some((e) => e.type === 'error' && /语音识别/.test(e.message)));
    assert.equal(brain.pushToTalkActive, false);
    await brain.dispose();
  });

  test('麦克风打不开：error 事件带可操作提示，长按不 reject', async () => {
    const brain = new ChatBrain({
      desktop: fakeDesktop(),
      createAudio: fakeAudio().create,
      createMic: fakeMic({ failWith: new DOMException('denied', 'NotAllowedError') }).create,
      fetchImpl: brainFetch([]),
    });
    const events: PetEvent[] = [];
    brain.on((e) => events.push(e));
    await brain.start(false);
    await assert.doesNotReject(() => brain.beginPushToTalk());
    assert.equal(brain.pushToTalkActive, false);
    assert.ok(events.some((e) => e.type === 'error' && /授权/.test(e.message)));
    brain.endPushToTalk(); // 松手不该抛
    await brain.dispose();
  });

  test('listening / voiceInterruptible 在 chat 模式恒为 false（不碰麦克风）', async () => {
    const desktop = fakeDesktop({ listening: true, voiceInterruptible: true });
    const brain = new ChatBrain({ desktop, createAudio: fakeAudio().create });
    await brain.start(false);
    // 设置里开着，但这个模式不采集音频 —— 语义是「现在有没有在听」，不是「开关是什么」。
    assert.equal(desktop.settings.listening, true);
    assert.equal(brain.listening, false);
    assert.equal(brain.voiceInterruptible, false);
    // 手动打断不受影响，照常可用。
    assert.doesNotThrow(() => brain.interrupt());
    await brain.dispose();
  });

  test('start(true) 不因为「不支持麦克风」就报错 —— UI 的默认调用不该每次弹错', async () => {
    const brain = new ChatBrain({
      desktop: fakeDesktop(),
      createAudio: fakeAudio().create,
      fetchImpl: brainFetch([]),
    });
    const events: PetEvent[] = [];
    brain.on((e) => events.push(e));
    await brain.start(true);
    assert.ok(!events.some((e) => e.type === 'error'));
    await brain.dispose();
  });

  test('拿不到凭据时发 error + connection closed，不抛给调用方', async () => {
    const desktop = fakeDesktop();
    const broken: Desktop = {
      ...desktop,
      credentials: async () => {
        throw Error('没有 key');
      },
    };
    const brain = new ChatBrain({ desktop: broken, createAudio: fakeAudio().create });
    const events: PetEvent[] = [];
    brain.on((e) => events.push(e));
    await assert.doesNotReject(() => brain.start(false));
    assert.ok(events.some((e) => e.type === 'error' && /凭据/.test(e.message)));
    assert.ok(events.some((e) => e.type === 'connection' && e.state === 'closed'));
    assert.equal(brain.running, false);
    await brain.dispose();
  });

  test('并发 start 只跑一次', async () => {
    const brain = new ChatBrain({
      desktop: fakeDesktop(),
      createAudio: fakeAudio().create,
      fetchImpl: brainFetch([]),
    });
    const opens: PetEvent[] = [];
    brain.on((e) => {
      if (e.type === 'connection' && e.state === 'open') opens.push(e);
    });
    await Promise.all([brain.start(false), brain.start(false), brain.start(false)]);
    assert.equal(opens.length, 1);
    await brain.dispose();
  });

  test('sendText 会自己把会话起起来', async () => {
    const brain = new ChatBrain({
      desktop: fakeDesktop(),
      createAudio: fakeAudio().create,
      fetchImpl: brainFetch([{ chunks: [contentChunk('自动起来了。'), doneChunk()] }]),
    });
    await brain.sendText('嗨');
    await settle(100);
    assert.equal(brain.transcript.at(-1)?.text, '自动起来了。');
    await brain.dispose();
  });

  test('订阅者抛错不影响其他订阅者', async () => {
    const brain = new ChatBrain({
      desktop: fakeDesktop(),
      createAudio: fakeAudio().create,
      fetchImpl: brainFetch([]),
    });
    const seen: string[] = [];
    brain.on(() => {
      throw Error('订阅者炸了');
    });
    brain.on((e) => seen.push(e.type));
    await brain.start(false);
    assert.ok(seen.length > 0);
    await brain.dispose();
  });

  test('refreshSettings 返回最新设置（不需要推给服务端 —— 每轮重建 system prompt）', async () => {
    const desktop = fakeDesktop();
    const brain = new ChatBrain({
      desktop,
      createAudio: fakeAudio().create,
      fetchImpl: brainFetch([]),
    });
    await brain.start(false);
    await desktop.setSettings({ screenAwareness: true });
    const settings = await brain.refreshSettings();
    assert.equal(settings.screenAwareness, true);
    await brain.dispose();
  });

  test('interrupt 立刻回 idle，并且可以重复调', async () => {
    const brain = new ChatBrain({
      desktop: fakeDesktop(),
      createAudio: fakeAudio().create,
      fetchImpl: brainFetch([]),
    });
    const events: PetEvent[] = [];
    brain.on((e) => events.push(e));
    await brain.start(false);
    brain.interrupt();
    brain.interrupt();
    assert.ok(events.some((e) => e.type === 'activity' && e.value === 'idle'));
    assert.equal(brain.audioLevel, 0);
    await brain.dispose();
  });

  test('dispose 清掉订阅者，之后的操作不再通知它们', async () => {
    const brain = new ChatBrain({
      desktop: fakeDesktop(),
      createAudio: fakeAudio().create,
      fetchImpl: brainFetch([]),
    });
    await brain.start(false);
    const seen: PetEvent[] = [];
    brain.on((e) => seen.push(e));
    await brain.dispose();
    const afterDispose = seen.length;
    brain.interrupt();
    await settle(20);
    assert.equal(seen.length, afterDispose, 'dispose 之后旧订阅者不该再收到事件');
  });

  test('用的是设置里的 chatModel（默认 step-5-preview），不是 .env 里的文本模型', async () => {
    const chat = scriptedFetch([{ chunks: [contentChunk('好。'), doneChunk()] }]);
    const brain = new ChatBrain({
      desktop: fakeDesktop(),
      createAudio: fakeAudio().create,
      fetchImpl: (async (url: unknown, init?: RequestInit) => {
        if (String(url).includes('/audio/speech')) {
          return new Response(makeWav(new Int16Array(100)).buffer as ArrayBuffer, { status: 200 });
        }
        return chat.fetchImpl(url as string, init);
      }) as unknown as typeof fetch,
    });
    await brain.start(false);
    await brain.sendText('嗨');
    await settle(80);
    assert.equal(chat.bodies[0].model, defaultSettings.chatModel);
    assert.equal(defaultSettings.chatModel, 'step-5-preview');
    await brain.dispose();
  });
});
