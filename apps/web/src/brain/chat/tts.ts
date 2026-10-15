// 按句合成 + 排队播放。chat 模式唯一能压延迟的地方。
//
// /v1/audio/speech 是整段合成（实测：响应头和完整下载几乎同时到达，没有渐进出流），
// 所以「等她说完再合成」= 文本耗时 + 整段合成耗时串起来。这里的做法是：
//   文本一出现第一个短句就开始合成，合成**串行**（保证顺序、也避免并发打爆额度），
//   播放**排队**（上一段快播完时才把下一段塞进播放环）。
//
// 为什么播放要节流而不是一股脑塞进 SpeechStream：播放环只有 12 秒
// （public/audio-playback.js 的 RING_SECONDS），而合成比播放快得多 ——
// 三段各 8 秒的音频能在 10 秒内合成完，一起塞进去就溢出，worklet 会**丢最旧的样本**，
// 也就是把正在播的那段开头砍掉。所以这里自己排队，环里最多躺一段。
import { REALTIME_SAMPLE_RATE } from '../../../../../shared/realtime';
import { decodeWav, pcm16ToBase64, resample, toMono } from './wav';

export const SPEECH_URL = 'https://api.stepfun.com/v1/audio/speech';
export const TTS_MODEL = 'stepaudio-3-tts';

/** 单次合成的超时。56 字以内实测 1.3~3.8s，20 秒还没回来就是出事了。 */
const SYNTH_TIMEOUT_MS = 20_000;
/**
 * 提前多久把下一段塞进播放环。
 * 太小会在两段之间听出一个空洞，太大会让环里堆多段（有溢出风险）。
 */
const LEAD_MS = 250;
/**
 * 一轮最多合成多少段。她被要求只说 1~3 句；真跑飞了也不该把 TTS 额度
 * （2.5 元/万字符）烧光，也不该让用户听一分钟。
 */
const MAX_SEGMENTS_PER_TURN = 12;

/** 播放侧的最小接口。真实实现是 voice/SpeechStream.ts，测试里塞假的。 */
export type SpeechSink = {
  /** 排入一段 base64 PCM16。 */
  enqueue(base64: string): void;
  /** 立刻丢掉所有未播放内容。 */
  flush(): void;
};

export type SpeechSynthesizerOptions = {
  getApiKey: () => Promise<string>;
  /** 每段都重新读 —— 用户随时可能在托盘里换音色，chat 模式换音色不用重建任何东西。 */
  getVoice: () => string;
  sink: SpeechSink;
  onError?: (message: string) => void;
  /** 注入点，测试/探测脚本里塞假的。 */
  fetchImpl?: typeof fetch;
  /** 可选的风格指令（TTS 3 的 instruction，上限 500 字）。默认不传，交给音色本身。 */
  instruction?: string;
};

export class SpeechSynthesizer {
  /** 每次 cancel 自增。所有异步回调都要对 epoch，防止被打断后迟到的音频又被播出来。 */
  private epoch = 0;
  private netTail: Promise<void> = Promise.resolve();
  private playTail: Promise<void> = Promise.resolve();
  private segments = 0;
  /** 在途请求。cancel 时一起废掉 —— 不然已经取消的那句话还会继续合成，白花钱。 */
  private inFlight = new Set<AbortController>();
  /** 在途的节流等待。cancel 时要立刻唤醒，否则下一轮要等上一段播完才开始。 */
  private waiters = new Set<() => void>();
  private disposed = false;

  constructor(private readonly options: SpeechSynthesizerOptions) {}

  /** 这一轮已经排了多少段。 */
  get pendingSegments(): number {
    return this.segments;
  }

  /**
   * 排入一段要念的文本。立刻返回 —— 合成和播放都在后台排队。
   * 文本必须已经过 spokenText 清洗（SentenceBuffer 负责）。
   */
  speak(text: string): void {
    if (this.disposed || !text.trim()) return;
    if (this.segments >= MAX_SEGMENTS_PER_TURN) {
      console.warn('[chat/tts] 这一轮段落数超限，后面不再合成。');
      return;
    }
    this.segments++;
    const epoch = this.epoch;

    // 串行合成：排在上一段之后。每个 reject 都当场消化掉，不留未处理拒绝。
    const clip = this.netTail.then(() => this.synthesize(text, epoch));
    this.netTail = clip.then(
      () => {},
      () => {},
    );

    // 排队播放：拿到音频后塞进播放环，然后等它差不多播完再放下一段。
    this.playTail = this.playTail
      .then(async () => {
        const samples = await clip;
        if (!samples || epoch !== this.epoch || this.disposed) return;
        this.options.sink.enqueue(pcm16ToBase64(samples));
        const durationMs = (samples.length / REALTIME_SAMPLE_RATE) * 1000;
        await this.wait(Math.max(0, durationMs - LEAD_MS));
      })
      .catch((error: unknown) => {
        console.warn('[chat/tts] 播放排队失败', error);
      });
  }

  /** 真正发请求。返回 null 表示这段放弃了（已取消或失败，失败已上报）。 */
  private async synthesize(text: string, epoch: number): Promise<Int16Array | null> {
    if (epoch !== this.epoch || this.disposed) return null;
    let apiKey: string;
    try {
      apiKey = await this.options.getApiKey();
    } catch {
      this.options.onError?.('拿不到 API 凭据，这几句话没法念出来。');
      return null;
    }
    if (epoch !== this.epoch) return null;

    const abort = new AbortController();
    this.inFlight.add(abort);
    const timeout = setTimeout(() => abort.abort(), SYNTH_TIMEOUT_MS);
    try {
      const doFetch = this.options.fetchImpl ?? fetch;
      const response = await doFetch(SPEECH_URL, {
        method: 'POST',
        signal: abort.signal,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: TTS_MODEL,
          voice: this.options.getVoice(),
          input: text,
          response_format: 'wav',
          sample_rate: REALTIME_SAMPLE_RATE,
          ...(this.options.instruction ? { instruction: this.options.instruction } : {}),
        }),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        this.options.onError?.(
          `语音合成失败（${response.status}）${detail ? `：${detail.slice(0, 120)}` : ''}。文字还在，只是没念出来。`,
        );
        return null;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (epoch !== this.epoch) return null;
      const wav = decodeWav(bytes);
      const mono = toMono(wav.samples, wav.channels);
      return resample(mono, wav.sampleRate, REALTIME_SAMPLE_RATE);
    } catch (error) {
      if (abort.signal.aborted) {
        // 被打断或超时。打断是正常操作，不报错；超时才值得说一句。
        if (epoch === this.epoch) this.options.onError?.('语音合成超时，这句没念出来。');
        return null;
      }
      this.options.onError?.(
        `语音合成出错：${error instanceof Error ? error.message : '未知错误'}。`,
      );
      return null;
    } finally {
      clearTimeout(timeout);
      this.inFlight.delete(abort);
    }
  }

  /** 可被 cancel 立刻唤醒的等待。 */
  private wait(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(handle);
        this.waiters.delete(done);
        resolve();
      };
      const handle = setTimeout(done, ms);
      this.waiters.add(done);
    });
  }

  /**
   * 打断：丢掉未播放的音频、废掉在途合成请求、唤醒所有等待。
   * 必须是同步的 —— 用户点她一下就该立刻安静。
   */
  cancel(): void {
    this.epoch++;
    this.segments = 0;
    for (const abort of this.inFlight) abort.abort();
    this.inFlight.clear();
    for (const wake of [...this.waiters]) wake();
    this.waiters.clear();
    this.netTail = Promise.resolve();
    this.playTail = Promise.resolve();
    this.options.sink.flush();
  }

  dispose(): void {
    this.cancel();
    this.disposed = true;
  }
}
