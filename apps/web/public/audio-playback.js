// 播放：环形缓冲 + 每个 render quantum 算一次 RMS。
//
// 为什么是 worklet 而不是 decodeAudioData + BufferSource：
// 打断（barge-in）要求「立刻」停住。BufferSource 一旦 start() 就只能 stop()，
// 已经排进去的后续片段还得一个个取消，而且 decodeAudioData 本身有延迟。
// 环形缓冲可以把 read 指针直接推到 write 指针，下一个 quantum（~2.7ms）就静音了。
//
// RMS 从这里 post 出去而不是用 AnalyserNode：AnalyserNode 挂在图上，
// flush 之后还会继续报上一帧的残留，口型会多张一下。
//
// 这里**只按原速播**。曾经在这一层做过保持音高的时间伸缩（WSOLA）来加快语速，
// 已整体移除 —— 实测结论留在这里当证据（完整推导见 git 历史）：
// 以 r 倍播一段原速时长 T 的话音，播放会比音频到达早 T·(r−1)/r 结束，这段差额
// 只能靠开播前垫的缓冲填；而上游大致按 **1× 实时**出音，所以两头都不成立 ——
// 垫不够就断续（1.15×、3 秒话音 → 6 次欠载每次 43ms；1.30×、6 秒话音 → 24 次
// 合计 1.02 秒静音），垫够了首音就变慢（1.02× 就要多等约 159ms）。
// 也就是说加速一点时间都省不下来（最后一个样本到达的时刻是固定的），省下的只是
// 她说话的语速，换掉的是开口时机 —— 而「说完到出声约 0.2 秒」是 realtime 模式
// 唯一的卖点。这个交换不划算，所以不做。
const RING_SECONDS = 12;


class StepPlayback extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const config = options?.processorOptions ?? {};
    // 送进来的 PCM 的采样率。与 sampleRate 不一致时在这里线性重采样，
    // 因为 WKWebView 不保证兑现 AudioContext 的 sampleRate 请求值。
    this.sourceRate = config.sourceRate > 0 ? config.sourceRate : sampleRate;
    this.step = this.sourceRate / sampleRate; // 每个输出样本前进多少个输入样本
    this.size = Math.max(4096, Math.ceil(this.sourceRate * RING_SECONDS));
    this.ring = new Float32Array(this.size);
    this.write = 0;
    this.read = 0; // 小数读指针，支持重采样
    this.available = 0; // 环里尚未播放的输入样本数
    this.playing = false;
    this.lastLevel = -1;
    this.sinceReport = 0;
    this.dropped = 0;


    this.port.onmessage = (event) => {
      const data = event.data;
      if (!data) return;
      if (data.type === 'pcm') {
        this.enqueue(new Int16Array(data.buffer));
      } else if (data.type === 'flush') {
        // 打断：丢掉一切未播放的内容，下一个 quantum 就静音。
        this.write = 0;
        this.read = 0;
        this.available = 0;
        this.playing = false;
        this.port.postMessage({ type: 'level', value: 0 });
        this.port.postMessage({ type: 'drained' });
        this.lastLevel = 0;
      }
    };
  }

  enqueue(samples) {
    // 环满了丢最旧的，而不是让写指针绕过读指针造成乱序噪音。
    // 单块就超过整个环的情况也要报，否则会静默丢掉一大段音频。
    if (samples.length > this.size) {
      this.port.postMessage({ type: 'overflow', samples: samples.length - this.size });
      samples = samples.subarray(samples.length - this.size);
    }
    const overflow = this.available + samples.length - this.size;
    if (overflow > 0) {
      this.read = (this.read + overflow) % this.size;
      this.available -= overflow;
      this.dropped += overflow;
      this.port.postMessage({ type: 'overflow', samples: overflow });
    }
    for (let i = 0; i < samples.length; i++) {
      this.ring[this.write] = samples[i] / 32768;
      this.write = this.write + 1 === this.size ? 0 : this.write + 1;
    }
    this.available += samples.length;
    if (!this.playing) {
      this.playing = true;
      this.port.postMessage({ type: 'started' });
    }
  }

  sample(position) {
    const base = Math.floor(position);
    const frac = position - base;
    const i = base % this.size;
    const j = (base + 1) % this.size;
    return this.ring[i] + (this.ring[j] - this.ring[i]) * frac;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const channel = out[0];
    const frames = channel.length;
    return this.processDirect(out, channel, frames);
  }

  /** 唯一的播放路径：环 → 线性重采样 → 输出。 */
  processDirect(out, channel, frames) {
    if (this.available <= 0) {
      for (let c = 0; c < out.length; c++) out[c].fill(0);
      if (this.playing) {
        this.playing = false;
        this.port.postMessage({ type: 'drained' });
      }
      this.report(0);
      return true;
    }

    // 能填满多少帧？线性插值要用到 read+1，所以留一个样本余量。
    // 不足一个 quantum 时也要把尾巴播出去（而不是把它卡在环里 ——
    // 那样最后小半个字听不到，而且 drained 永远不会触发，表情就一直停在 speaking）。
    const maxFrames = Math.max(0, Math.floor((this.available - 1) / this.step));
    const render = Math.min(frames, maxFrames);
    let sum = 0;
    for (let i = 0; i < render; i++) {
      const value = this.sample(this.read);
      channel[i] = value;
      sum += value * value;
      this.read += this.step;
      if (this.read >= this.size) this.read -= this.size;
    }
    // 填不满的部分补静音，而不是重复上一帧（重复会有金属味）。
    for (let i = render; i < frames; i++) channel[i] = 0;
    for (let c = 1; c < out.length; c++) out[c].set(channel);

    if (render < frames) {
      // 环里剩下的不足以再插一帧，直接认为播完。
      this.available = 0;
      this.read = 0;
      this.write = 0;
      if (this.playing) {
        this.playing = false;
        this.port.postMessage({ type: 'drained' });
      }
    } else {
      this.available -= Math.floor(render * this.step);
    }

    this.report(render ? Math.sqrt(sum / frames) : 0);
    return true;
  }

  report(rms) {
    // RMS → 0..1。人声 RMS 很少超过 0.3，所以放大再截断，口型才有行程。
    const level = Math.min(1, rms * 3.2);
    this.sinceReport += 1;
    // 每 ~2 个 quantum 报一次（~5.8ms @48k），再密也没有视觉意义。
    if (this.sinceReport < 2 && Math.abs(level - this.lastLevel) < 0.08) return;
    this.sinceReport = 0;
    this.lastLevel = level;
    this.port.postMessage({ type: 'level', value: level });
  }
}

registerProcessor('step-playback', StepPlayback);
