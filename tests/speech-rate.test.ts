// 语速（播放侧保持音高的时间伸缩）的测试。
//
// 为什么要在 Node 里测 worklet：realtime 模式的服务端**没有**语速控制
// （speed / speech_rate / output_audio_speed 全被静默忽略，instructions 里要求
// "语速加快"也无效），所以变速只能在播放侧做。而播放侧最容易出的错是
// 「顺手用重采样」—— 时长对了但音高跟着上去，她会变成花栗鼠。
// 所以这里的核心断言不是听感，是**基频必须不变**：喂已知周期的信号，
// 用自相关量出输出周期，和输入周期对比。
//
// 加载方式和 tests/realtime.test.ts 一样：把 public/audio-playback.js 当普通脚本
// 跑在假的 AudioWorkletGlobalScope 里，测的是真正会上线的那份代码。
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { readFileSync } from 'node:fs';

type WorkletPort = {
  postMessage: (data: unknown, transfer?: unknown[]) => void;
  onmessage: ((event: { data: unknown }) => void) | null;
  _out: { data: Record<string, unknown> }[];
  _in: (data: unknown) => void;
};
type WorkletNode = {
  port: WorkletPort;
  process: (inputs: unknown[], outputs?: Float32Array[][]) => boolean;
};
type Stretcher = {
  frame: number;
  hop: number;
  overlap: number;
  capacity: number;
  setSpeed: (speed: number) => void;
  inputNeeded: () => number;
  push: (src: Float32Array, n: number) => number;
  round: () => boolean;
  drain: () => void;
  pull: (dest: Float32Array, offset: number, count: number) => number;
  reset: () => void;
};
type Internals = {
  TimeStretcher: new (rate: number) => Stretcher;
  normalizeRate: (value: unknown) => number;
};

const source = readFileSync(
  new URL('../apps/web/public/audio-playback.js', import.meta.url),
  'utf8',
);

function loadPlayback(rate: number): {
  Playback: new (options?: unknown) => WorkletNode;
  internals: Internals;
} {
  const registered: Record<string, new (options?: unknown) => WorkletNode> = {};
  const base = class {
    port: WorkletPort;
    constructor() {
      let handler: ((event: { data: unknown }) => void) | null = null;
      const out: WorkletPort['_out'] = [];
      this.port = {
        postMessage: (data) => out.push({ data: data as Record<string, unknown> }),
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
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(...Object.keys(scope), source)(...Object.values(scope));
  const internals = (globalThis as unknown as { StepPlaybackInternals: Internals })
    .StepPlaybackInternals;
  return { Playback: registered['step-playback'], internals };
}

/** 一串带谐波的周期信号 + 缓慢的幅度包络，比纯正弦更接近人声。 */
function voiceLike(count: number, f0: number, rate: number): Float32Array {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const t = i / rate;
    const envelope = 0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t); // 3Hz 的音节起伏
    out[i] =
      envelope *
      0.3 *
      (Math.sin(2 * Math.PI * f0 * t) +
        0.5 * Math.sin(2 * Math.PI * 2 * f0 * t) +
        0.3 * Math.sin(2 * Math.PI * 3 * f0 * t) +
        0.15 * Math.sin(2 * Math.PI * 4 * f0 * t));
  }
  return out;
}

/** 把整段信号过一遍伸缩器，收集全部输出。 */
function stretchAll(input: Float32Array, speed: number, rate: number): Float32Array {
  const { internals } = loadPlayback(rate);
  const stretcher = new internals.TimeStretcher(rate);
  stretcher.setSpeed(speed);
  const chunk = new Float32Array(512);
  const sink = new Float32Array(stretcher.capacity + 4096);
  const collected: number[] = [];
  let pos = 0;

  const feed = () => {
    let need = stretcher.inputNeeded();
    while (need > 0 && pos < input.length) {
      const n = Math.min(need, chunk.length, input.length - pos);
      chunk.set(input.subarray(pos, pos + n));
      pos += n;
      stretcher.push(chunk, n);
      need = stretcher.inputNeeded();
    }
  };
  const take = () => {
    let n = stretcher.pull(sink, 0, sink.length);
    while (n > 0) {
      for (let i = 0; i < n; i++) collected.push(sink[i]);
      n = stretcher.pull(sink, 0, sink.length);
    }
  };

  feed();
  let guard = 1_000_000;
  while (stretcher.round() && guard-- > 0) {
    take();
    feed();
  }
  stretcher.drain();
  take();
  return Float32Array.from(collected);
}

/** 归一化自相关的峰值滞后 = 周期（样本）。 */
function periodOf(x: Float32Array, minLag: number, maxLag: number): number {
  let bestLag = -1;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let dot = 0;
    let e1 = 0;
    let e2 = 0;
    for (let i = 0; i + lag < x.length; i++) {
      dot += x[i] * x[i + lag];
      e1 += x[i] * x[i];
      e2 += x[i + lag] * x[i + lag];
    }
    const score = dot / Math.sqrt(e1 * e2 + 1e-12);
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  return bestLag;
}

/** 朴素重采样（故意写错的那种实现），用来证明基频断言真的有鉴别力。 */
function naiveResample(input: Float32Array, speed: number): Float32Array {
  const out = new Float32Array(Math.floor(input.length / speed));
  for (let i = 0; i < out.length; i++) {
    const p = i * speed;
    const a = Math.floor(p);
    const frac = p - a;
    out[i] = input[a] + ((input[a + 1] ?? input[a]) - input[a]) * frac;
  }
  return out;
}

function pcm16(count: number, fn: (i: number) => number): ArrayBuffer {
  const samples = new Int16Array(count);
  for (let i = 0; i < count; i++) samples[i] = Math.round(fn(i) * 30000);
  return samples.buffer;
}

describe('TimeStretcher：时长按倍率变，音高不变', () => {
  const rate = 24000;

  for (const speed of [0.8, 1.15, 1.4, 1.8]) {
    test(`${speed}× 的输出时长 ≈ 输入 / ${speed}`, () => {
      const input = voiceLike(rate * 3, 200, rate);
      const output = stretchAll(input, speed, rate);
      const expected = input.length / speed;
      const drift = (Math.abs(output.length - expected) / expected) * 100;
      assert.ok(
        drift < 2,
        `${speed}× 下时长漂移 ${drift.toFixed(2)}%（${output.length} vs 期望 ${expected.toFixed(0)}）`,
      );
    });
  }

  for (const speed of [0.8, 1.15, 1.4, 1.8]) {
    test(`${speed}× 不改变基频（不是重采样）`, () => {
      const f0 = 200;
      const input = voiceLike(rate * 2, f0, rate);
      const output = stretchAll(input, speed, rate);
      // 取中段，避开首尾的直通/收尾段。
      const middle = output.subarray(
        Math.floor(output.length * 0.25),
        Math.floor(output.length * 0.75),
      );
      // 搜索范围 60~180 样本 = 133~400Hz。朴素重采样在 1.4× 会落到 86 样本，
      // 在这个范围里 —— 所以这个断言真的能把错实现抓出来。
      const period = periodOf(middle, 60, 180);
      const truth = rate / f0; // 120
      const error = (Math.abs(period - truth) / truth) * 100;
      assert.ok(error < 2, `${speed}× 下周期变成 ${period} 样本（应为 ${truth}），偏差 ${error.toFixed(2)}%`);
    });
  }

  test('speed=1 时伸缩器本身是透明的（逐样本等于输入）', () => {
    // 旁路路径之外的额外保险：即使某天在 1.0 上也走了伸缩器（比如刚从 1.4
    // 切回原速、缓冲还没吐完），输出也不该有任何染色。
    const input = voiceLike(rate, 200, rate);
    const output = stretchAll(input, 1, rate);
    assert.equal(output.length, input.length, '1× 的输出长度必须和输入一致');
    for (let i = 0; i < input.length; i++) {
      assert.equal(output[i], input[i], `1× 下第 ${i} 个样本被改动了`);
    }
  });

  test('对照：朴素重采样确实会把基频拉上去（证明上面的断言有鉴别力）', () => {
    const input = voiceLike(rate * 2, 200, rate);
    const wrong = naiveResample(input, 1.4);
    const middle = wrong.subarray(
      Math.floor(wrong.length * 0.25),
      Math.floor(wrong.length * 0.75),
    );
    const period = periodOf(middle, 60, 180);
    // 1.4× 重采样 → 120 / 1.4 ≈ 86 样本（280Hz，升了约 5 个半音）。
    assert.ok(
      Math.abs(period - 120 / 1.4) < 3,
      `朴素重采样的周期应当落在 86 附近，实测 ${period}`,
    );
  });

  test('幅度不炸：交叉淡化之后峰值不超过输入峰值太多', () => {
    const input = voiceLike(rate * 2, 200, rate);
    const output = stretchAll(input, 1.4, rate);
    let inPeak = 0;
    let outPeak = 0;
    for (const v of input) inPeak = Math.max(inPeak, Math.abs(v));
    for (const v of output) outPeak = Math.max(outPeak, Math.abs(v));
    assert.ok(
      outPeak <= inPeak * 1.15,
      `输出峰值 ${outPeak.toFixed(3)} 相比输入 ${inPeak.toFixed(3)} 涨得太多（会削波）`,
    );
    assert.ok(outPeak > inPeak * 0.6, `输出峰值 ${outPeak.toFixed(3)} 掉得太多（相位抵消了）`);
  });

  test('48kHz 的 AudioContext 下同样成立（WKWebView 不保证兑现请求的采样率）', () => {
    const r = 48000;
    const input = voiceLike(r * 2, 200, r);
    const output = stretchAll(input, 1.4, r);
    const drift = (Math.abs(output.length - input.length / 1.4) / (input.length / 1.4)) * 100;
    assert.ok(drift < 2, `48k 下时长漂移 ${drift.toFixed(2)}%`);
    const middle = output.subarray(
      Math.floor(output.length * 0.25),
      Math.floor(output.length * 0.75),
    );
    const period = periodOf(middle, 120, 360);
    assert.ok(Math.abs(period - 240) <= 4, `48k 下周期应为 240 样本，实测 ${period}`);
  });
});

describe('normalizeRate：夹紧与旁路吸附', () => {
  test('超出 0.8~1.8 的值被夹住，离 1 很近的值吸附成 1（走旁路）', () => {
    const { internals } = loadPlayback(24000);
    assert.equal(internals.normalizeRate(5), 1.8);
    assert.equal(internals.normalizeRate(0.1), 0.8);
    assert.equal(internals.normalizeRate(1.0005), 1);
    assert.equal(internals.normalizeRate(undefined), 1);
    assert.equal(internals.normalizeRate('x'), 1);
    assert.equal(internals.normalizeRate(0), 1);
    assert.equal(internals.normalizeRate(1.4), 1.4);
  });
});

describe('audio-playback.js：语速在播放路径上的行为', () => {
  const run = (node: WorkletNode, quanta: number, outputs: Float32Array[][]) => {
    let nonSilent = 0;
    for (let i = 0; i < quanta; i++) {
      outputs[0][0].fill(0);
      node.process([], outputs);
      if (outputs[0][0].some((v) => Math.abs(v) > 0.01)) nonSilent += outputs[0][0].length;
    }
    return nonSilent;
  };

  test('rate=1 走旁路：输出与输入逐样本相同', () => {
    const { Playback } = loadPlayback(24000);
    const node = new Playback({ processorOptions: { sourceRate: 24000, rate: 1 } });
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
          `旁路路径必须逐样本原样输出（第 ${q * 128 + i} 个样本）`,
        );
      }
    }
  });

  test('rate=1.0005 也走旁路（不为了 0.05% 引入一次重叠相加）', () => {
    const { Playback } = loadPlayback(24000);
    const node = new Playback({ processorOptions: { sourceRate: 24000, rate: 1.0005 } });
    const input = new Int16Array(1024);
    for (let i = 0; i < input.length; i++) input[i] = Math.round(20000 * Math.sin(i / 5));
    node.port._in({ type: 'pcm', buffer: input.buffer });
    const outputs = [[new Float32Array(128)]];
    node.process([], outputs);
    for (let i = 0; i < 128; i++) assert.equal(outputs[0][0][i], input[i] / 32768);
  });

  for (const [rate, expected] of [
    [1.15, 1 / 1.15],
    [1.4, 1 / 1.4],
    [0.8, 1 / 0.8],
  ] as const) {
    test(`rate=${rate}：1 秒音频播约 ${expected.toFixed(3)} 秒`, () => {
      const { Playback } = loadPlayback(24000);
      const node = new Playback({ processorOptions: { sourceRate: 24000, rate } });
      node.port._in({
        type: 'pcm',
        buffer: pcm16(24000, (i) => 0.8 * Math.sin((2 * Math.PI * 200 * i) / 24000)),
      });
      const outputs = [[new Float32Array(128)]];
      const nonSilent = run(node, Math.ceil((24000 * 2) / 128), outputs);
      const seconds = nonSilent / 24000;
      const drift = Math.abs(seconds - expected) / expected;
      assert.ok(drift < 0.06, `rate=${rate} 播了 ${seconds.toFixed(3)} 秒，期望 ${expected.toFixed(3)} 秒`);
    });
  }

  test('运行时改 rate 立刻生效（用户拖滑块）', () => {
    const { Playback } = loadPlayback(24000);
    const node = new Playback({ processorOptions: { sourceRate: 24000, rate: 1 } });
    const outputs = [[new Float32Array(128)]];
    const measure = (rate: number) => {
      node.port._in({ type: 'flush' });
      node.port._in({ type: 'rate', value: rate });
      node.port._in({
        type: 'pcm',
        buffer: pcm16(24000, (i) => 0.8 * Math.sin((2 * Math.PI * 200 * i) / 24000)),
      });
      return run(node, Math.ceil((24000 * 2) / 128), outputs) / 24000;
    };
    const slow = measure(0.8);
    const fast = measure(1.8);
    assert.ok(slow > 1.1, `0.8× 应当变长，实测 ${slow.toFixed(3)} 秒`);
    assert.ok(fast < 0.62, `1.8× 应当变短，实测 ${fast.toFixed(3)} 秒`);
    // 超范围的值要被夹到 1.8，而不是按 4× 播。
    const clamped = measure(4);
    assert.ok(Math.abs(clamped - fast) < 0.05, `超范围的倍率应当夹到 1.8，实测 ${clamped.toFixed(3)} 秒`);
  });

  test('flush 让下一个 quantum 立刻静音 —— 时间伸缩的内部缓冲不能让打断迟到', () => {
    const { Playback } = loadPlayback(24000);
    const node = new Playback({ processorOptions: { sourceRate: 24000, rate: 1.4 } });
    node.port._in({ type: 'pcm', buffer: pcm16(24000 * 5, (i) => 0.9 * Math.sin(i / 9)) });
    const outputs = [[new Float32Array(128)]];
    let heard = false;
    for (let i = 0; i < 40 && !heard; i++) {
      outputs[0][0].fill(0);
      node.process([], outputs);
      heard = outputs[0][0].some((v) => Math.abs(v) > 0.3);
    }
    assert.ok(heard, '预缓冲之后必须出声');

    node.port._in({ type: 'flush' });
    outputs[0][0].fill(0);
    node.process([], outputs);
    assert.ok(
      outputs[0][0].every((v) => v === 0),
      'flush 之后紧接着的那一帧就必须是静音（伸缩器内部缓冲也要一起清）',
    );
    // 再多跑几帧也不能冒出残留 —— 环空了，伸缩器也空了。
    for (let i = 0; i < 20; i++) {
      outputs[0][0].fill(0);
      node.process([], outputs);
      assert.ok(outputs[0][0].every((v) => v === 0), 'flush 之后不能再吐出任何残留');
    }
    const levels = node.port._out.filter((m) => m.data.type === 'level');
    assert.equal(levels.at(-1)!.data.value, 0, 'flush 必须把口型音量归零');
  });

  test('预缓冲不会把很短的尾音吞掉：仍然播出来并上报 drained', () => {
    const { Playback } = loadPlayback(24000);
    const node = new Playback({ processorOptions: { sourceRate: 24000, rate: 1.4 } });
    // 500 个样本（约 21ms）远不够一轮 WSOLA，必须原速吐出去而不是卡住。
    node.port._in({ type: 'pcm', buffer: pcm16(500, () => 0.9) });
    const outputs = [[new Float32Array(128)]];
    let nonSilent = 0;
    for (let i = 0; i < 60; i++) {
      outputs[0][0].fill(0);
      node.process([], outputs);
      for (const v of outputs[0][0]) if (Math.abs(v) > 0.01) nonSilent++;
    }
    assert.ok(nonSilent > 400, `尾音应当基本播完，实测只出了 ${nonSilent} 个样本`);
    assert.ok(
      node.port._out.some((m) => m.data.type === 'drained'),
      '必须上报 drained，否则表情回不到 idle',
    );
    assert.equal(node.process([], outputs), true, '节点必须继续存活');
  });

  test('RMS 音量仍然反映实际播放的音量（口型靠它驱动）', () => {
    const { Playback } = loadPlayback(24000);
    const peakFor = (amplitude: number) => {
      const node = new Playback({ processorOptions: { sourceRate: 24000, rate: 1.4 } });
      node.port._in({
        type: 'pcm',
        buffer: pcm16(24000, (i) => amplitude * Math.sin((2 * Math.PI * 200 * i) / 24000)),
      });
      const outputs = [[new Float32Array(128)]];
      let max = 0;
      for (let i = 0; i < 200; i++) {
        node.process([], outputs);
        for (const message of node.port._out) {
          if (message.data.type === 'level') max = Math.max(max, message.data.value as number);
        }
      }
      return max;
    };
    const quiet = peakFor(0.05);
    const loud = peakFor(0.95);
    assert.ok(loud > quiet, '变速之后音量仍要随幅度上升');
    assert.ok(quiet >= 0 && loud <= 1, `音量必须在 0..1，实测 ${quiet} / ${loud}`);
    assert.ok(loud > 0.5, '大声说话应当让嘴张得够开');
  });

  test('边喂边播（上游 1× 实时送达）不会反复欠载：中途一次 drained 都不该有', () => {
    // 这是加速带来的主要风险：rate=1.4 时环被消耗快 40%，如果欠载处理不对，
    // 就会反复出现「半个 quantum 有声 + 静音」的断续咔哒，并且 drained/started
    // 来回抖动（表情跟着闪）。
    //
    // 注意送达速率：256 个样本 @24kHz = 10.67ms 的音频，每 2 个 quantum
    // （也是 10.67ms）送一块 —— 这正好是 **1× 实时**，也就是 realtime 模型
    // 真实的出音速度。（这里原来写的"2× 实时"是错的。）
    const { Playback } = loadPlayback(24000);
    const node = new Playback({ processorOptions: { sourceRate: 24000, rate: 1.4 } });
    const outputs = [[new Float32Array(128)]];
    let sent = 0;
    let drainedMidway = 0;
    for (let q = 0; q < 400; q++) {
      if (q % 2 === 0 && sent < 24000) {
        node.port._in({ type: 'pcm', buffer: pcm16(256, (i) => 0.8 * Math.sin((sent + i) / 9)) });
        sent += 256;
      }
      node.port._out.length = 0;
      node.process([], outputs);
      if (sent < 24000 && node.port._out.some((m) => m.data.type === 'drained')) drainedMidway++;
    }
    assert.equal(drainedMidway, 0, `流还没结束就上报了 ${drainedMidway} 次 drained（欠载抖动）`);
  });
});

/**
 * 按真实速率把一段音频喂给 worklet，统计**听得见的断续**。
 *
 * 为什么必须这么测：上一版的流式测试只断言「中途没有 drained」，而半路欠载走的
 * 是另一条分支（重新预缓冲），**根本不发 drained**。所以那个测试全绿，用户却
 * 听到断断续续。这里直接数输出里的全静音 quantum —— 那才是用户听到的东西。
 *
 * @param supply 上游出音速度，1 = 实时。realtime 模型大致就是 1。
 * @param chunkMs 上游每次送多少毫秒的音频（realtime 的 audio delta 粒度）。
 */
function measureStream({
  rate,
  supply,
  seconds,
  chunkMs = 40,
  sr = 24000,
}: {
  rate: number;
  supply: number;
  seconds: number;
  chunkMs?: number;
  sr?: number;
}): {
  firstAudioMs: number | null;
  playedMs: number;
  gaps: number;
  gapMs: number;
  worstGapMs: number;
} {
  const { Playback } = loadPlayback(sr);
  const node = new Playback({ processorOptions: { sourceRate: sr, rate } });
  const outputs = [[new Float32Array(128)]];
  const total = Math.round(sr * seconds);
  const chunk = Math.max(1, Math.round((sr * chunkMs) / 1000));

  let produced = 0;
  let credit = 0;
  let started = false;
  let firstAudio = -1;
  let nonSilent = 0;
  let gapQuanta = 0;
  let gaps = 0;
  let worst = 0;
  let run = 0;
  const limit = Math.ceil((sr * (seconds / Math.min(rate, supply) + 2)) / 128);

  for (let q = 0; q < limit; q++) {
    // 上游按 supply × 实时产出：每个 quantum（128/sr 秒）产出 128·supply 个样本，
    // 攒够一块才发出去（真实的增量就是这种颗粒状到达）。
    credit += 128 * supply;
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
    for (const v of outputs[0][0]) {
      energy += v * v;
      if (Math.abs(v) > 1e-9) nonSilent++;
    }
    const silent = energy < 1e-12;
    if (!started && !silent) {
      started = true;
      firstAudio = q;
    }
    // 只数「流还没送完」时的静音 —— 送完之后的静音是正常的句尾。
    if (started && produced < total) {
      if (silent) {
        gapQuanta++;
        run++;
        if (run === 1) gaps++;
        worst = Math.max(worst, run);
      } else {
        run = 0;
      }
    }
  }

  const ms = (quanta: number) => ((quanta * 128) / sr) * 1000;
  return {
    firstAudioMs: firstAudio < 0 ? null : ms(firstAudio),
    playedMs: (nonSilent / sr) * 1000,
    gaps,
    gapMs: ms(gapQuanta),
    worstGapMs: ms(worst),
  };
}

describe('加速时的欠载：上游按实时出音，播放按 rate 消耗', () => {
  // 为什么这一组测试存在：用户真机反馈「加速后断断续续」。实测确认这**不是**
  // WSOLA 的实现 bug，而是数据率不够 —— 以 r 倍播一段原速时长 T 的话音，比原速
  // 早 T·(r−1)/r 结束，而旧代码的预缓冲只有固定的约 53ms。实测旧行为：
  //   1.15×、3 秒话音 →  6 次空洞，每次 43ms
  //   1.30×、6 秒话音 → 24 次空洞，合计 1.02 秒
  // 修法是「预缓冲按 rate 缩放」+「水位低时把瞬时倍率收回 1.0」。

  for (const rate of [1.15, 1.3, 1.4]) {
    test(`上游 1× 实时、${rate}× 播放、连续 6 秒：一个空洞都没有`, () => {
      const r = measureStream({ rate, supply: 1, seconds: 6 });
      assert.equal(
        r.gaps,
        0,
        `${rate}× 下出现 ${r.gaps} 次空洞、合计 ${r.gapMs.toFixed(1)}ms（最长 ${r.worstGapMs.toFixed(1)}ms）`,
      );
      // 音频一个样本都不能丢：空洞变成 0 不能是靠少播。
      assert.ok(
        r.playedMs > 6000 / rate - 50,
        `播出 ${r.playedMs.toFixed(0)}ms，至少应有 ${(6000 / rate).toFixed(0)}ms 的内容`,
      );
    });
  }

  for (const chunkMs of [5, 20, 100, 200]) {
    test(`增量粒度 ${chunkMs}ms（1× 实时、1.15×）：没有空洞`, () => {
      // realtime 的 audio delta 粒度实测从 20ms 到 200ms 不等，水位控制不能只
      // 在某一种颗粒度下成立。
      const r = measureStream({ rate: 1.15, supply: 1, seconds: 4, chunkMs });
      assert.equal(r.gaps, 0, `${chunkMs}ms 粒度下出现 ${r.gaps} 次空洞（合计 ${r.gapMs.toFixed(1)}ms）`);
    });
  }

  test('上游快于实时（1.3×）时 1.4× 全程跑满目标倍率', () => {
    // 弹性倍率的 1.0 是**下界不是目标**：上游供得上就不打折。
    const r = measureStream({ rate: 1.4, supply: 1.3, seconds: 4 });
    assert.equal(r.gaps, 0, `应当没有空洞，实测 ${r.gaps} 次`);
    const drift = Math.abs(r.playedMs - 4000 / 1.4) / (4000 / 1.4);
    assert.ok(drift < 0.1, `上游供得上时应当接近 ${(4000 / 1.4).toFixed(0)}ms，实测 ${r.playedMs.toFixed(0)}ms`);
  });

  test('上游慢于实时（0.95×）时空洞无法为 0，但有明确的下界', () => {
    // 这是物理下界，不是 bug：6 秒话音在 0.95× 实时下要 6.32 秒才送完，
    // 而最快也只能按 1.0 播（再慢就不是"加速"了），所以至少有
    // 6/0.95 − 6 ≈ 316ms 的时间没有音频可播。预缓冲能垫掉其中约 300ms，
    // 剩下的必须是静音 —— 音频本来就不在。
    const r = measureStream({ rate: 1.15, supply: 0.95, seconds: 6 });
    const floorMs = 6000 / 0.95 - 6000 - 300; // ≈ 16ms，再减去垫子
    assert.ok(r.gapMs >= 0, '不该是负数');
    assert.ok(
      r.gapMs < 200,
      `欠载应当被压到 200ms 以内（理论缺口约 ${Math.max(0, floorMs).toFixed(0)}ms + 一次重新垫水位），实测 ${r.gapMs.toFixed(1)}ms / ${r.gaps} 次`,
    );
    assert.ok(r.gaps <= 2, `空洞次数应当是个位数的 1~2 次，实测 ${r.gaps} 次`);
  });

  test('原速（1.00×）的首音延迟不受影响 —— 旁路一个样本都不等', () => {
    // 预缓冲只能加在变速路径上。默认档是 1.00，绝不能为了加速档付延迟。
    const r = measureStream({ rate: 1, supply: 1, seconds: 2 });
    assert.ok(
      r.firstAudioMs !== null && r.firstAudioMs <= 45,
      `原速首音应当在 45ms 内（约等于一块增量），实测 ${String(r.firstAudioMs)}ms`,
    );
    assert.equal(r.gaps, 0, '原速不该有空洞');
  });

  test('加速的代价是首音延迟，而且被钉在 0.55 秒以内', () => {
    // 这一条是故意用来"锁数字"的：按 rate 缩放预缓冲换来的平滑，代价全在首音上。
    // realtime 模式「说完到出声约 0.2 秒」是它唯一的卖点，谁想再加厚垫子
    // （改 PREBUFFER_* 常量）都会在这里被挡下来，必须显式地重新权衡。
    const fast = measureStream({ rate: 1.15, supply: 1, seconds: 3 });
    const slow = measureStream({ rate: 1, supply: 1, seconds: 3 });
    assert.ok(
      fast.firstAudioMs !== null && fast.firstAudioMs <= 550,
      `1.15× 的首音延迟 ${String(fast.firstAudioMs)}ms 超了 550ms 上限`,
    );
    assert.ok(
      slow.firstAudioMs !== null && fast.firstAudioMs! > slow.firstAudioMs,
      '加速档的首音本来就该比原速晚 —— 这是设计上的代价，不是回归',
    );
  });

  test('极碎的增量（每 quantum 只来几十个样本）也一定出声，不会卡在预缓冲里', () => {
    // 排查「完全没有声音」：如果预缓冲的门限在某种输入形状下永远凑不够，
    // 用户听到的就不是断续而是**一声都没有**。硬上限必须在这种形状下也生效。
    const { Playback } = loadPlayback(24000);
    const node = new Playback({ processorOptions: { sourceRate: 24000, rate: 1.15 } });
    const outputs = [[new Float32Array(128)]];
    let fed = 0;
    let nonSilent = 0;
    for (let q = 0; q < 1200; q++) {
      const n = 1 + (q % 40); // 远低于 1× 实时，而且块大小一直在变
      const at = fed;
      node.port._in({ type: 'pcm', buffer: pcm16(n, (i) => 0.8 * Math.sin((at + i) / 11)) });
      fed += n;
      node.process([], outputs);
      for (const v of outputs[0][0]) if (Math.abs(v) > 1e-9) nonSilent++;
    }
    assert.ok(nonSilent > fed * 0.8, `喂了 ${fed} 个样本只播出 ${nonSilent} 个 —— 音频被卡在预缓冲里了`);
  });

  test('48kHz 的 AudioContext（源仍是 24k）下水位控制同样成立', () => {
    // 水位全部在**输出采样率**域上算，而 WKWebView 不保证兑现请求的采样率，
    // 换算错了就会在真机上退化成断续。
    const r = measureStream({ rate: 1.15, supply: 1, seconds: 4, sr: 48000 });
    assert.equal(r.gaps, 0, `48k 下出现 ${r.gaps} 次空洞（合计 ${r.gapMs.toFixed(1)}ms）`);
  });

  /** 说话到一半把倍率改掉（用户拖滑块/点菜单），统计挖出来的空洞。 */
  const switchMidway = (from: number, to: number): { gaps: number; worstMs: number } => {
    const sr = 24000;
    const { Playback } = loadPlayback(sr);
    const node = new Playback({ processorOptions: { sourceRate: sr, rate: from } });
    const outputs = [[new Float32Array(128)]];
    const chunk = 960; // 40ms 粒度
    const total = sr * 6;
    let produced = 0;
    let credit = 0;
    let switched = false;
    let started = false;
    let gaps = 0;
    let run = 0;
    let worst = 0;
    for (let q = 0; q < Math.ceil((sr * 8) / 128); q++) {
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
      if (!switched && ((q * 128) / sr) * 1000 >= 2000) {
        node.port._in({ type: 'rate', value: to });
        switched = true;
      }
      outputs[0][0].fill(0);
      node.process([], outputs);
      let energy = 0;
      for (const v of outputs[0][0]) energy += v * v;
      const silent = energy < 1e-12;
      if (!started && !silent) started = true;
      if (started && produced < total) {
        if (silent) {
          run++;
          if (run === 1) gaps++;
          worst = Math.max(worst, run);
        } else {
          run = 0;
        }
      }
    }
    return { gaps, worstMs: ((worst * 128) / sr) * 1000 };
  };

  for (const [from, to] of [
    [1.15, 1.3],
    [1.3, 1.15],
    [1.15, 1],
    [1.3, 1],
    [1.15, 0.8],
  ] as const) {
    test(`说话中途 ${from}× → ${to}× 不挖洞`, () => {
      // 拖滑块是连续事件，每动一下挖一个洞是不能接受的。中途改倍率只垫回稳态
      // 水位（不按"新的一段"重新垫满），而水位此时本来就是满的，所以不用等。
      const r = switchMidway(from, to);
      assert.equal(r.gaps, 0, `${from}→${to} 出现 ${r.gaps} 次空洞（最长 ${r.worstMs.toFixed(1)}ms）`);
    });
  }

  for (const to of [1.15, 1.3]) {
    test(`说话中途 1.00× → ${to}× 有一次约 120ms 的停顿（换不掉，但要有界）`, () => {
      // 原速走旁路，环被消耗到接近空；而伸缩器需要一轮 WSOLA 的前瞻才能合成
      // 第一段，这段前瞻只能等出来。要紧的是它**只有一次**而且不到一个垫子
      // 的时长 —— 如果这里退化成约 450ms，说明中途切档被当成了"新的一段"。
      const r = switchMidway(1, to);
      assert.ok(r.gaps <= 1, `应当只停顿一次，实测 ${r.gaps} 次`);
      assert.ok(
        r.worstMs < 200,
        `停顿 ${r.worstMs.toFixed(1)}ms 太长了（应当 <200ms，不该按新的一段重新垫满）`,
      );
    });
  }
});
