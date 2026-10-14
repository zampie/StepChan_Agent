import { spokenText } from '../../../../shared/audio';

type Status = 'idle' | 'loading' | 'playing';
export class SpeechPlayer {
  private context?: AudioContext;
  private source?: AudioBufferSourceNode;
  private resolvePlayback?: () => void;
  private abort = new AbortController();
  private epoch = 0;
  private netTail: Promise<unknown> = Promise.resolve();
  private playTail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private frame = 0;
  private remainder = '';
  private count = 0;
  private inCode = false;
  constructor(
    private status: (value: Status) => void,
    private error: (text: string) => void,
    private level: (value: number | null) => void,
  ) {}
  async unlock() {
    this.context ??= new AudioContext();
    await this.context.resume();
    if (this.context.state !== 'running') throw Error('请再次点击声音开关，允许播放。');
  }
  stop() {
    this.epoch++;
    this.abort.abort();
    this.abort = new AbortController();
    this.source?.stop();
    this.source = undefined;
    this.resolvePlayback?.();
    this.resolvePlayback = undefined;
    cancelAnimationFrame(this.frame);
    this.level(null);
    this.pending = 0;
    this.remainder = '';
    this.count = 0;
    this.inCode = false;
    this.netTail = Promise.resolve();
    this.playTail = Promise.resolve();
    this.status('idle');
  }
  append(delta: string, final = false) {
    this.remainder += delta;
    // Keep complete lines/sentences together; don't speak fenced code blocks.
    while (this.remainder.length) {
      const match = /[。！？!?；;\n]/.exec(this.remainder);
      const length = match
        ? Math.min(match.index + 1, 180)
        : this.remainder.length >= 180
          ? 180
          : final
            ? this.remainder.length
            : 0;
      if (!length) break;
      const segment = this.remainder.slice(0, length);
      this.remainder = this.remainder.slice(length);
      const fences = (segment.match(/```/g) ?? []).length;
      const skip = this.inCode || fences > 0;
      if (fences % 2) this.inCode = !this.inCode;
      if (!skip) this.enqueue(segment);
    }
  }
  enqueue(raw: string) {
    const text = spokenText(raw);
    if (!text || this.count >= 8 || !this.context) return;
    this.count++;
    this.pending++;
    const epoch = this.epoch,
      signal = this.abort.signal,
      context = this.context;
    if (this.pending === 1) this.status('loading');
    const audio = this.netTail.then(async () => {
      if (epoch !== this.epoch) return null;
      const response = await fetch('/api/audio/tts', {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) throw Error((await response.json()).message || '语音生成失败。');
      const buffer = await context.decodeAudioData(await response.arrayBuffer());
      return epoch === this.epoch ? buffer : null;
    });
    // Serialize synthesis, while the previous clip plays. Every rejection is observed immediately.
    const safeAudio = audio.catch((error: unknown) => {
      if (epoch === this.epoch) {
        this.stop();
        this.error(error instanceof Error ? error.message : '语音生成失败。');
      }
      return null;
    });
    this.netTail = safeAudio;
    this.playTail = this.playTail
      .then(async () => {
        const buffer = await safeAudio;
        if (!buffer || epoch !== this.epoch) return;
        if (context.state !== 'running') throw Error('播放已暂停，请点击试听重新开启声音。');
        this.status('playing');
        const source = context.createBufferSource(),
          analyser = context.createAnalyser();
        analyser.fftSize = 256;
        source.buffer = buffer;
        source.connect(analyser);
        analyser.connect(context.destination);
        this.source = source;
        const samples = new Float32Array(analyser.fftSize);
        const tick = () => {
          if (epoch !== this.epoch) return;
          analyser.getFloatTimeDomainData(samples);
          this.level(Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length));
          this.frame = requestAnimationFrame(tick);
        };
        tick();
        await new Promise<void>((resolve) => {
          this.resolvePlayback = resolve;
          source.onended = () => resolve();
          source.start();
        });
        source.disconnect();
        analyser.disconnect();
        if (epoch !== this.epoch) return;
        this.source = undefined;
        this.resolvePlayback = undefined;
        cancelAnimationFrame(this.frame);
        this.level(null);
        this.pending--;
        this.status(this.pending ? 'loading' : 'idle');
      })
      .catch((error: unknown) => {
        if (epoch === this.epoch) {
          this.stop();
          this.error(error instanceof Error ? error.message : '播放失败。');
        }
      });
  }
  destroy() {
    this.stop();
    void this.context?.close();
    this.context = undefined;
  }
}
