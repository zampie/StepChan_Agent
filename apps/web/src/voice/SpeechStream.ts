// 播放侧：base64 PCM16 增量 → AudioWorklet 环形缓冲，支持瞬时 flush。
//
// 设计要点见 public/audio-playback.js 顶部注释。这一层只负责：
// 解 base64、按需重采样信息传给 worklet、暴露 0..1 的音量给口型用。
import { REALTIME_SAMPLE_RATE } from '../../../../shared/realtime';

export type SpeechStreamEvents = {
  /** 0..1，驱动口型。flush 后立刻变 0。 */
  onLevel?: (level: number) => void;
  /** 环里从有到无（本段说完了）。打断导致的清空也会触发。 */
  onDrained?: () => void;
  onStarted?: () => void;
  onError?: (message: string) => void;
};

function decodeBase64(value: string): Int16Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  // 奇数字节说明上游截断了一个样本；丢掉半个样本而不是让 Int16Array 构造抛错。
  const usable = bytes.length - (bytes.length % 2);
  return new Int16Array(bytes.buffer, 0, usable / 2);
}

export class SpeechStream {
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private gain: GainNode | null = null;
  private ready: Promise<void> | null = null;
  private level = 0;
  /** 每次 flush/stop 自增。迟到的 enqueue 用它丢弃。 */
  private epoch = 0;
  private disposed = false;

  constructor(private readonly events: SpeechStreamEvents = {}) {}

  get audioLevel(): number {
    return this.level;
  }

  get contextState(): AudioContextState | 'none' {
    return this.context?.state ?? 'none';
  }

  /**
   * 建图并 resume。必须在用户手势里调用一次，否则 WKWebView/浏览器会让
   * AudioContext 停在 suspended，表现为「一切正常但没声音」。
   */
  async start(): Promise<void> {
    if (this.disposed) throw Error('SpeechStream 已销毁。');
    this.ready ??= this.build();
    await this.ready;
  }

  private async build(): Promise<void> {
    const context = new AudioContext({ sampleRate: REALTIME_SAMPLE_RATE, latencyHint: 'interactive' });
    this.context = context;
    try {
      await context.audioWorklet.addModule('/audio-playback.js');
    } catch (error) {
      await context.close().catch(() => {});
      this.context = null;
      this.ready = null;
      throw Error(`播放模块加载失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
    await context.resume().catch(() => {});
    // 实际采样率可能不是我们请求的那个（WKWebView 不保证兑现），
    // 告诉 worklet 源采样率，由它重采样。
    const node = new AudioWorkletNode(context, 'step-playback', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { sourceRate: REALTIME_SAMPLE_RATE },
    });
    node.port.onmessage = (event) => {
      const data = event.data as { type: string; value?: number };
      if (data.type === 'level') {
        this.level = data.value ?? 0;
        this.events.onLevel?.(this.level);
      } else if (data.type === 'drained') {
        this.level = 0;
        this.events.onDrained?.();
      } else if (data.type === 'started') {
        this.events.onStarted?.();
      } else if (data.type === 'overflow') {
        // 不是致命错误：说明模型出音比播放快很多，丢最旧的更好。
        console.warn('[SpeechStream] 播放环溢出，已丢弃最旧样本。');
      }
    };
    const gain = new GainNode(context, { gain: 1 });
    node.connect(gain);
    gain.connect(context.destination);
    this.node = node;
    this.gain = gain;
    if (context.state !== 'running') {
      this.events.onError?.('系统未允许播放声音，再点一次声音开关试试。');
    }
  }

  /** 排入一段 base64 PCM16。未 start 或已 flush 过的 epoch 会被丢弃。 */
  enqueue(base64: string, epoch = this.epoch): void {
    if (this.disposed || !this.node || epoch !== this.epoch || !base64) return;
    let samples: Int16Array;
    try {
      samples = decodeBase64(base64);
    } catch {
      // 坏帧不该让会话崩掉。
      console.warn('[SpeechStream] 丢弃无法解码的音频增量。');
      return;
    }
    if (samples.length === 0) return;
    // 必须拷贝：transfer 会把底层 buffer 搬走，而它是我们刚建的，没人再用。
    const copy = new Int16Array(samples);
    this.node.port.postMessage({ type: 'pcm', buffer: copy.buffer }, [copy.buffer]);
  }

  /**
   * 打断：立刻丢掉所有未播放内容。返回新的 epoch，调用方用它丢弃在途增量。
   * 这是整个功能的核心路径 —— 必须是同步的，不能 await 任何东西。
   */
  flush(): number {
    this.epoch++;
    this.level = 0;
    this.node?.port.postMessage({ type: 'flush' });
    this.events.onLevel?.(0);
    return this.epoch;
  }

  /**
   * 临时压低音量，用于「可能被打断」的瞬间。
   *
   * 为什么要有这一档：VAD 对环境噪声会误触发，而一上来就 flush + response.cancel
   * 是不可逆的 —— 一声咳嗽就能把她刚说的半句彻底砍掉。先压音量听上去已经是
   * 「她让你说」，等真的确认是人声再执行不可逆的打断；是噪声就恢复。
   * 用 setTargetAtTime 做 20ms 平滑，避免爆音。
   */
  duck(level = 0.12): void {
    const gain = this.gain;
    if (!gain) return;
    gain.gain.setTargetAtTime(level, gain.context.currentTime, 0.02);
  }

  /** 取消压低，恢复正常音量。 */
  unduck(): void {
    const gain = this.gain;
    if (!gain) return;
    gain.gain.setTargetAtTime(1, gain.context.currentTime, 0.03);
  }

  get currentEpoch(): number {
    return this.epoch;
  }

  /** 停止播放但保留 AudioContext（下次说话不用再过一次用户手势）。 */
  stop(): void {
    this.flush();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.flush();
    if (this.node) this.node.port.onmessage = null;
    this.node?.disconnect();
    this.gain?.disconnect();
    this.node = null;
    this.gain = null;
    const context = this.context;
    this.context = null;
    this.ready = null;
    await context?.close().catch(() => {});
  }
}
