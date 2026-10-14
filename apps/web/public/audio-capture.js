// 麦克风采集：在音频线程上把 Float32 转成 PCM16，按固定帧长回传主线程。
//
// 两条性质和老的 audio-recorder.js 保持一致，别改：
// 1. 永不把麦克风接到 destination —— 一旦接上就是回声灾难。
//    （调用方只把本节点接到一个 gain=0 的汇，或者干脆不接；见 MicStream。）
// 2. process() 永远 return true，不因为一帧没数据就让节点被回收。
//
// 与老文件的区别：这里直接出 Int16，并且做线性重采样。WKWebView 不保证
// 兑现 new AudioContext({sampleRate}) 的请求值，所以重采样必须在这一层做完，
// 主线程拿到的 buffer 一定已经是目标采样率。
class StepCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const config = options?.processorOptions ?? {};
    // 目标采样率（送给服务端的那个）。
    this.targetRate = config.targetRate > 0 ? config.targetRate : sampleRate;
    // 每次 postMessage 的目标采样数（~40ms）。
    this.frameSamples =
      config.frameSamples > 0 ? config.frameSamples : Math.round(this.targetRate * 0.04);
    // 重采样比：输入前进 ratio 个样本 = 输出前进 1 个样本。
    this.ratio = sampleRate / this.targetRate;
    this.needsResample = Math.abs(this.ratio - 1) > 1e-6;
    // 重采样游标，跨 render quantum 保持，避免每块边界重置造成周期性咔嗒。
    this.cursor = 0;
    this.last = 0; // 上一块的最后一个样本，供跨块线性插值
    this.hasLast = false;
    this.out = new Int16Array(this.frameSamples);
    this.filled = 0;
    this.muted = false;
    this.port.onmessage = (event) => {
      // 发言期间可被主线程静音（例如正在播放她的声音且没有回声消除时）。
      if (event.data && typeof event.data.muted === 'boolean') this.muted = event.data.muted;
    };
  }

  push(value) {
    const clamped = value > 1 ? 1 : value < -1 ? -1 : value;
    this.out[this.filled++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    if (this.filled === this.frameSamples) {
      const frame = this.out;
      this.out = new Int16Array(this.frameSamples);
      this.filled = 0;
      this.port.postMessage({ pcm: frame.buffer }, [frame.buffer]);
    }
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel || channel.length === 0) return true;
    if (this.muted) {
      // 丢数据但保持重采样游标连续，恢复后不跳相位。
      this.cursor -= channel.length;
      if (this.cursor < 0) this.cursor = 0;
      this.last = 0;
      this.hasLast = true;
      return true;
    }
    if (!this.needsResample) {
      for (let i = 0; i < channel.length; i++) this.push(channel[i]);
      return true;
    }
    // 线性插值重采样。cursor 是「相对本块起点」的小数位置，可以为负
    // （表示插值点落在上一块的最后一个样本和本块第一个样本之间）。
    while (this.cursor < channel.length) {
      const base = Math.floor(this.cursor);
      const frac = this.cursor - base;
      const a = base < 0 ? (this.hasLast ? this.last : channel[0]) : channel[base];
      const b = base + 1 < channel.length ? channel[base + 1] : channel[channel.length - 1];
      this.push(a + (b - a) * frac);
      this.cursor += this.ratio;
    }
    this.cursor -= channel.length;
    this.last = channel[channel.length - 1];
    this.hasLast = true;
    return true;
  }
}
registerProcessor('step-capture', StepCapture);
