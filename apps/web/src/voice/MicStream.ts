// 采集侧：麦克风 → AudioWorklet → PCM16 → base64，约 40ms 一帧。
//
// 老 useVoice.ts 留下的教训，这里全部保留：
// - 权限被拒要给可操作的提示，不是「失败」两个字。
// - 只在会话活跃时持有麦克风，stop 时必须 stop() 每个 track（否则菜单栏
//   一直亮着录音指示灯，用户会以为被偷听）。
// - 取消/迟到：每次 start 自增 epoch，异步回来的东西对不上 epoch 就丢掉。
// - 永不把麦克风接到 destination。
import { REALTIME_SAMPLE_RATE } from '../../../../shared/realtime';

export type MicStreamEvents = {
  /** 一帧 PCM16 的 base64。 */
  onFrame: (base64: string) => void;
  onError?: (message: string) => void;
  /** 浏览器实际给的采样率与目标不一致时上报一次，便于排查。 */
  onSampleRateMismatch?: (actual: number, target: number) => void;
};

function encodeBase64(bytes: Uint8Array): string {
  // 分块避免 String.fromCharCode 的参数个数上限。
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

export class MicStream {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private epoch = 0;
  private active = false;
  private actualRate = 0;
  /**
   * 正在进行的 start()。并发调用必须共享它，不能各建一套。
   *
   * 「按住说话」模式下每次长按都会 start 一次，手快的话上一次的 getUserMedia
   * 还没回来第二次就打进来了。epoch 能保证迟到的那套不往外送音频，但两套
   * MediaStream/AudioContext 都已经建起来了 —— 输的那一套会把麦克风占着不放，
   * 系统录音指示灯灭不掉（用户会以为被偷听）。所以在入口就去重。
   */
  private starting: Promise<void> | null = null;

  constructor(private readonly events: MicStreamEvents) {}

  get running(): boolean {
    return this.active;
  }

  /** 浏览器实际使用的采样率；0 表示还没开过。 */
  get sampleRate(): number {
    return this.actualRate;
  }

  async start(): Promise<void> {
    if (this.active) return;
    if (this.starting) return this.starting;
    // finally 里要先确认 starting 还是自己 —— 中间被 stop() 清过、又被新的
    // start() 填上的话，不能把新的那个抹掉。
    const pending = this.open().finally(() => {
      if (this.starting === pending) this.starting = null;
    });
    this.starting = pending;
    return pending;
  }

  /**
   * 真正建图。
   *
   * 所有资源先放在**局部变量**里，只有在确认自己还是当前 epoch 之后才发布到 this 上。
   * 这样被 stop() 抢在中途的那一套只会清掉自己的东西，不会把新一套的
   * MediaStream/AudioContext 一起拆了（「按住说话」会频繁 start/stop，这个竞态是真的）。
   */
  private async open(): Promise<void> {
    const epoch = ++this.epoch;
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    /** 放弃这一套自己建的资源。只碰局部变量。 */
    const abandon = () => {
      stream?.getTracks().forEach((t) => t.stop());
      void context?.close().catch(() => {});
    };
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw Error('当前环境不支持麦克风采集。');
      }
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          // 她自己的声音从扬声器出来，不消回声就会把自己的话当成打断。
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      if (epoch !== this.epoch) {
        abandon();
        return;
      }

      // 请求 24k；WKWebView 可能给别的值（未在本机核实过，所以必须兼容）。
      try {
        context = new AudioContext({ sampleRate: REALTIME_SAMPLE_RATE, latencyHint: 'interactive' });
      } catch {
        // 某些实现会对不支持的 sampleRate 直接抛错 —— 退回默认值，由 worklet 重采样。
        context = new AudioContext({ latencyHint: 'interactive' });
      }
      if (context.sampleRate !== REALTIME_SAMPLE_RATE) {
        // 不是错误，worklet 会重采样；但要记录，因为这是已知的平台风险点。
        this.events.onSampleRateMismatch?.(context.sampleRate, REALTIME_SAMPLE_RATE);
        console.warn(
          `[MicStream] AudioContext 给了 ${context.sampleRate}Hz，目标 ${REALTIME_SAMPLE_RATE}Hz，已在 worklet 内重采样。`,
        );
      }

      await context.audioWorklet.addModule('/audio-capture.js');
      await context.resume().catch(() => {});
      if (epoch !== this.epoch) {
        abandon();
        return;
      }

      const node = new AudioWorkletNode(context, 'step-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        processorOptions: {
          targetRate: REALTIME_SAMPLE_RATE,
          frameSamples: Math.round(REALTIME_SAMPLE_RATE * 0.04),
        },
      });
      node.port.onmessage = (event) => {
        if (epoch !== this.epoch) return;
        const data = event.data as { pcm?: ArrayBuffer };
        if (!data?.pcm) return;
        this.events.onFrame(encodeBase64(new Uint8Array(data.pcm)));
      };
      const source = context.createMediaStreamSource(stream);
      // numberOfOutputs: 0 —— 节点没有输出，不接 destination，物理上不可能回放。
      source.connect(node);
      // 到这里为止没有 await，不会再被 stop() 插进来 —— 现在才发布。
      this.stream = stream;
      this.context = context;
      this.actualRate = context.sampleRate;
      this.source = source;
      this.node = node;
      this.active = true;
    } catch (error) {
      abandon();
      if (epoch !== this.epoch) return;
      this.events.onError?.(micErrorMessage(error));
      throw error;
    }
  }

  /** 临时静音（她在说话且没有回声消除时用）。麦克风仍然持有。 */
  setMuted(muted: boolean): void {
    this.node?.port.postMessage({ muted });
  }

  stop(): void {
    this.epoch++;
    // 在途的 start() 会在下一个 epoch 检查点自己放弃。必须把 starting 清掉：
    // 否则「长按→松手→马上再长按」时，第二次长按会复用第一次那个注定作废的
    // promise，麦克风再也开不起来，这一轮说的话静悄悄全丢。
    this.starting = null;
    this.release();
  }

  private release(): void {
    this.active = false;
    if (this.node) this.node.port.onmessage = null;
    this.source?.disconnect();
    this.node?.disconnect();
    this.source = null;
    this.node = null;
    // 必须逐个 stop，否则系统录音指示灯不灭。
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    const context = this.context;
    this.context = null;
    void context?.close().catch(() => {});
  }
}

export function micErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return '麦克风没有授权。到「系统设置 → 隐私与安全性 → 麦克风」里允许 Step酱，然后再点一次语音；也可以直接打字找我。';
    }
    if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') {
      return '没找到可用的麦克风。插上麦克风或在系统声音设置里选一个输入设备，再试一次。';
    }
    if (error.name === 'NotReadableError') {
      return '麦克风被别的程序占用了，关掉正在录音的应用再试一次。';
    }
  }
  return error instanceof Error ? error.message : '无法开启麦克风。';
}
