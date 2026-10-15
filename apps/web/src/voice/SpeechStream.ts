// 播放侧：base64 PCM16 增量 → AudioWorklet 环形缓冲，支持瞬时 flush。
//
// 设计要点见 public/audio-playback.js 顶部注释。这一层只负责：
// 解 base64、把源采样率告诉 worklet（由它重采样）、暴露 0..1 的音量给口型用。
import { REALTIME_SAMPLE_RATE } from '../../../../shared/realtime';

export type SpeechStreamEvents = {
  /** 0..1，驱动口型。flush 后立刻变 0。 */
  onLevel?: (level: number) => void;
  /**
   * 环里真的空了（本段说完了）。打断导致的清空也会触发。
   *
   * **这是去抖之后的事件**：worklet 的原始 drained 在句中每次欠载都会发
   * （实测一句话约 40 条），直接转发会让「她说完了」这个判断一句话里反复成立。
   * 见 scheduleDrain 与 DRAIN_GRACE_MS。
   */
  onDrained?: () => void;
  onStarted?: () => void;
  onError?: (message: string) => void;
};

/**
 * 认定「真的播完了」之前要等多久没有新音频。
 *
 * 下界由**上游的增量粒度**决定，这是实测出来的：音频增量按约 200ms 一块到达，
 * 块间正常静默最坏能到 300ms 量级（偶发的网络抖动更长，但那种该当成卡顿而不是
 * 「说完了」）。所以 350ms 刚好盖住一次正常的块间间隔，又不会让她说完之后
 * 明显迟钝。
 *
 * 这个数字曾经写成「按 worklet 的 stall 门限推导」—— 那套门限是跟变速功能
 * 一起进来的，功能移除后它成了只写不读的死代码并被删掉了，所以把依据直接
 * 记在这里，而不是指向一个已经不存在的实现。
 */
const DRAIN_GRACE_MS = 350;

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
  /**
   * 去抖后的「她在出声」。见 speaking getter 的注释。
   * 真相源是 worklet 的 started/drained，但 drained 要等 DRAIN_GRACE_MS 才采信。
   */
  private playing = false;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  /** 每次 flush/stop 自增。迟到的 enqueue 用它丢弃。 */
  private epoch = 0;
  private disposed = false;

  constructor(private readonly events: SpeechStreamEvents = {}) {}

  get audioLevel(): number {
    return this.level;
  }

  /**
   * 她此刻是否真的在出声。**判断「能不能打断她」只能用这个，不能用 audioLevel。**
   *
   * audioLevel 是 worklet 逐 quantum 算的瞬时 RMS，它会在她明明还在说话时掉到 0：
   * 网络欠载、句间停顿、预缓冲没满，`processDirect` 都会直接 report(0)。
   * 拿它当「她在说话」用的后果是「可打断」关着也照常被打断 —— 因为规则
   * `!interruptible && speaking` 在那一瞬间不成立，于是直接走到不可逆的打断，
   * 连 duck-then-confirm 都绕过了。（用户实际报的 bug。）
   *
   * worklet 的 started/drained 是成对的，但 **drained 同样不可信**：
   * 句中每一次欠载都会发一条（实测一句话约 40 条）。所以这里对排空做去抖 ——
   * 只有连续 DRAIN_GRACE_MS 没有新音频才算真的说完了。
   */
  get speaking(): boolean {
    return this.playing;
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
        // 不立刻认定「说完了」：句中欠载也会发 drained（实测一句话约 40 条）。
        // 等 DRAIN_GRACE_MS 还没有新音频进来，才真的算播完。
        this.scheduleDrain();
      } else if (data.type === 'started') {
        this.clearDrainTimer();
        this.playing = true;
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

  private clearDrainTimer(): void {
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
  }

  /**
   * 排空去抖。worklet 每次欠载都会发 drained，所以要等一会儿看是不是真的没了。
   *
   * 等待期间 `speaking` 保持 true —— 这正是关键：打断门控在这段时间里仍然认为
   * 她在说话，噪声就不会把她的尾音砍掉。代价是她真说完之后要多 DRAIN_GRACE_MS
   * 才回到聆听态，这点延迟换掉一个随机打断，值得。
   */
  private scheduleDrain(): void {
    if (this.drainTimer) return;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      this.playing = false;
      this.events.onDrained?.();
    }, DRAIN_GRACE_MS);
  }

  /** 排入一段 base64 PCM16。未 start 或已 flush 过的 epoch 会被丢弃。 */  enqueue(base64: string, epoch = this.epoch): void {
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
    // flush 是不可逆的止声，这一刻她确实不出声了 —— 不走去抖，立刻置位。
    // 不这么做的话打断之后 DRAIN_GRACE_MS 内 speaking 仍为 true，
    // 紧跟着的那次 speech_started 会被「不可打断」规则吃掉，用户说的第一句话丢掉。
    this.clearDrainTimer();
    this.playing = false;
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
    this.clearDrainTimer();
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
