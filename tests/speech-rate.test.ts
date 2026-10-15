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

  test('边喂边播（2× 实时送达）不会反复欠载：中途一次 drained 都不该有', () => {
    // 这是加速带来的主要风险：rate=1.4 时环被消耗快 40%，如果欠载处理不对，
    // 就会反复出现「半个 quantum 有声 + 静音」的断续咔哒，并且 drained/started
    // 来回抖动（表情跟着闪）。
    const { Playback } = loadPlayback(24000);
    const node = new Playback({ processorOptions: { sourceRate: 24000, rate: 1.4 } });
    const outputs = [[new Float32Array(128)]];
    let sent = 0;
    let drainedMidway = 0;
    for (let q = 0; q < 400; q++) {
      // 每 2 个 quantum（10.7ms）送 256 个样本 —— 约 2× 实时，和真实流式出音相当。
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
