// 播放：环形缓冲 + 每个 render quantum 算一次 RMS + 保持音高的变速。
//
// 为什么是 worklet 而不是 decodeAudioData + BufferSource：
// 打断（barge-in）要求「立刻」停住。BufferSource 一旦 start() 就只能 stop()，
// 已经排进去的后续片段还得一个个取消，而且 decodeAudioData 本身有延迟。
// 环形缓冲可以把 read 指针直接推到 write 指针，下一个 quantum（~2.7ms）就静音了。
//
// RMS 从这里 post 出去而不是用 AnalyserNode：AnalyserNode 挂在图上，
// flush 之后还会继续报上一帧的残留，口型会多张一下。
//
// 语速（rate）为什么在这里做：realtime 模式的服务端**没有**任何语速控制
// （实测 speed / speech_rate / output_audio_speed 全被静默忽略，在 instructions
// 里要求"语速加快"也无效），只能在播放侧做。见 shared/desktop.ts 的 speechRate 注释。
//
// 只有 realtime 模式走这条路。chat 模式是**服务端调速**（/v1/audio/speech 的
// speed 参数，见 brain/chat/tts.ts），拿到的 PCM 本身就已经是加速过的，
// 时长和数据率是自洽的，所以根本不存在下面那一整套欠载问题。
// 两边都调会变成乘积，所以 chat 模式的播放实例必须用 rate = 1。
const RING_SECONDS = 12;

// 语速范围，与 shared/desktop.ts 的 settings.speechRate 保持一致。
const MIN_RATE = 0.8;
const MAX_RATE = 1.8;
// 离 1 不到这个量就当原速走旁路：为了 1.005 引入一次重叠相加不值得。
const RATE_EPSILON = 0.01;

// ── 变速路径的预缓冲与弹性倍率 ──────────────────────────────────────────────
//
// 下面这一整套**只影响 rate ≠ 1**。rate = 1 走 processDirect 旁路，一个样本都
// 不经过这里，所以默认档（1.00）的行为和加这段之前逐样本一致。
//
// 根本约束（实测确认，不是实现 bug）：realtime 模型大致按**实时**速度出音频。
// 以 r 倍播放一段原速时长 T 的话音，播放会比音频到达早 T·(r−1)/r 结束 ——
// 这段差额只能靠开播前垫的缓冲填。垫不够的实测后果（24kHz、上游 1× 实时、
// 旧的 53ms 固定预缓冲）：
//   rate=1.15、3 秒话音 →  6 次欠载，每次 43ms 静音（约每 500ms 断一下）
//   rate=1.15、6 秒话音 → 12 次欠载，合计 512ms 静音
//   rate=1.30、6 秒话音 → 24 次欠载，合计 1.02 秒静音
// 这就是用户听到的「断断续续」。同样的代码在上游 1.1× 实时时 1.15 档一次欠载
// 都没有 —— 问题不在 WSOLA，在**数据率不够**。
//
// 代价（选 >1 的用户必须知道）：rate > 1 时首音要多等
//   PREBUFFER_JITTER + min(PREBUFFER_RATE_MAX, ASSUMED·(r−1)/r) 秒
//   1.02× → 多等约 159ms（53ms → 212ms）
//   1.15× → 多等约 400ms（53ms → 453ms）
//   1.30× 及以上 → 同样约 400ms（顶到上限）
// realtime 模式「说完到出声约 0.2 秒」是它唯一的卖点，选 1.15× 之后变成约
// 0.65 秒。这是物理上换不掉的 —— 音频还没到，不可能提前播。
//
// 还有一条更要紧的结论：上游恰好是 1× 实时时，加速**一点时间都省不下来**
// （最后一个样本到达的时刻是固定的），省下的只是"她说话的语速"。所以默认档
// 应该是 1.00，>1 是给明确想要快语速的人的选项。

/**
 * 抖动垫子的**下限**。真实的增量间隔靠观测（见 arrivalGap），这里只是在还没观测到
 * 任何东西时的起点 —— realtime 的音频增量粒度实测从 20ms 到 200ms 不等，缓冲水位
 * 不能贴着「能合成一轮」的下限，否则一次稍大的增量间隔就是一个空洞。
 */
const PREBUFFER_JITTER_SECONDS = 0.1;
/**
 * 观测到的增量间隔的上限。再长就不当抖动看（当成上游卡了），不然一次网络打嗝
 * 会把之后每一句的首音延迟都抬上去。
 */
const ARRIVAL_GAP_MAX_SECONDS = 0.3;
/**
 * 观测值的衰减系数：每收到一个增量就把历史最大间隔乘上它。
 * 为什么要衰减：只取 max 的话一次偶发的长间隔会永久抬高延迟；
 * 衰减让它在几十个增量之后退回真实的粒度。
 */
const ARRIVAL_GAP_DECAY = 0.97;
/**
 * 按 T·(r−1)/r 估垫子时假定的话音长度。她被 prompt 约束成只说 1~3 句，取 2.5 秒。
 * 比这更长的话音靠下面的弹性倍率兜，不靠把垫子加得更厚。
 */
const ASSUMED_UTTERANCE_SECONDS = 2.5;
/** 垫子上限。再厚就把 realtime 模式的低延迟优势吃光了。 */
const PREBUFFER_RATE_MAX_SECONDS = 0.3;
/**
 * 判定「上游说完了」的静默时长下限。真实门限是 max(这个值, 2×观测到的增量间隔)
 * —— 粒度 200ms 的上游每两块之间都会静默 200ms，用固定 150ms 判定会把每一个
 * 正常的块间间隔都当成"说完了"，弹性倍率和预缓冲就全失效了。
 * 两处用它：
 * 1. 预缓冲不再等（否则一句很短的尾音要白等一个垫子的时间，听上去是句尾打嗝）；
 * 2. 弹性倍率恢复到目标倍率（没有"未来"了，不需要再防御欠载）。
 */
const STALL_SECONDS = 0.15;
/**
 * 等预缓冲的硬上限。上游一直涓流（远低于实时）时水位永远到不了门限、而且因为
 * 数据一直在来也不会被判为"静默"，不兜这一下就永远不出声。
 */
const PRIME_MAX_SECONDS = 0.6;

/**
 * WSOLA（波形相似重叠相加）时间伸缩：改时长，**不改音高**。
 *
 * 为什么不是简单重采样：改变读取步长会把音高一起拉上去。她本来就是高音少女声，
 * 1.2× 就明显变花栗鼠 —— 那比语速慢更糟。
 *
 * 为什么是时域方法而不是相位声码器：语音在 0.8~1.4× 这个区间，时域重叠相加的
 * 质量已经够用，而相位声码器要 FFT + 相位展开，在 128 样本的 quantum 里不划算。
 *
 * 为什么必须搜索拼接点（WSOLA 里的 W）：固定步长剪贴会在每个接缝处打断声带周期，
 * 听上去是周期性的"咔哒"。所以每轮都在 ±search 内按归一化互相关找与「自然延续段」
 * 最相似的位置再拼，接缝就落在周期对齐处。
 *
 * 一轮（round）的结构：overlap 个样本与上一轮留下的 mid 交叉淡化，再直通 segment 个。
 * 每轮固定产出 hop = overlap + segment 个输出样本，名义上消耗 speed * hop 个输入样本。
 * 名义取样点按 speed 推进（不是按实际拼接点推进），所以搜索带来的偏移不会累积成速率漂移。
 *
 * 全部在**输出采样率**域上工作：上游先把环里的 PCM 重采样到 sampleRate 再推进来。
 */
class TimeStretcher {
  /** @param {number} rate 输出采样率（= AudioContext 的 sampleRate） */
  constructor(rate) {
    this.overlap = Math.max(32, Math.round(rate * 0.008)); // 交叉淡化 8ms
    this.segment = Math.max(64, Math.round(rate * 0.016)); // 直通 16ms
    // 搜索 ±8ms：覆盖 125Hz 以上的基频，她的音高在 180~350Hz，绰绰有余。
    this.search = Math.max(32, Math.round(rate * 0.008));
    this.hop = this.overlap + this.segment;
    // 一轮需要的输入量：名义点前后各 search，加 overlap + segment，再加下一轮的 overlap。
    this.frame = 2 * this.search + this.overlap + this.segment + this.overlap;
    this.capacity = this.frame + this.hop + 1024;

    this.input = new Float32Array(this.capacity);
    this.count = 0;
    /** 还要丢掉多少个尚未到达的输入样本（加速到名义点跑到缓冲之外时用）。 */
    this.skip = 0;
    /** 下一轮的名义取样点，相对 input[0]，带小数。 */
    this.nominal = 0;
    this.primed = false;
    /** 上一段的「自然延续」，等着与下一段交叉淡化。 */
    this.mid = new Float32Array(this.overlap);
    this.mixed = new Float32Array(this.overlap);
    this.fade = new Float32Array(this.overlap);
    for (let i = 0; i < this.overlap; i++) {
      // 升余弦淡化而不是线性：线性接缝的一阶不连续会留下轻微的高频毛刺。
      this.fade[i] = 0.5 - 0.5 * Math.cos((Math.PI * (i + 1)) / (this.overlap + 1));
    }

    // drain() 一次最多吐出整个输入缓冲，所以输出缓冲要留得下它 + 一个 quantum。
    this.out = new Float32Array(this.capacity + this.hop + 2048);
    this.outHead = 0;
    this.outCount = 0;
    this.speed = 1;
  }

  setSpeed(speed) {
    this.speed = speed;
  }

  /** 可以取走的输出样本数。 */
  get available() {
    return this.outCount;
  }

  /** 内部还压着东西（输入或输出）。用来判断「真的播完了」。 */
  get buffered() {
    return this.outCount > 0 || this.count > 0;
  }

  reset() {
    this.count = 0;
    this.skip = 0;
    this.nominal = 0;
    this.primed = false;
    this.outHead = 0;
    this.outCount = 0;
    this.mid.fill(0);
  }

  /** 还缺多少输入样本才能再合成一轮（0 表示够了）。 */
  inputNeeded() {
    const want = this.primed
      ? Math.round(this.nominal) + this.search + this.overlap + this.segment + this.overlap
      : this.overlap + this.segment + this.overlap;
    const missing = this.skip + Math.max(0, want - this.count);
    return Math.min(missing, this.skip + this.capacity - this.count);
  }

  /** 推入 n 个输出采样率的样本，返回实际吃下的数量。 */
  push(src, n) {
    let from = 0;
    if (this.skip > 0) {
      const dropped = Math.min(this.skip, n);
      this.skip -= dropped;
      from = dropped;
    }
    const take = Math.min(n - from, this.capacity - this.count);
    if (take <= 0) return from;
    this.input.set(src.subarray(from, from + take), this.count);
    this.count += take;
    return from + take;
  }

  /** 合成一轮。输入不够就原样返回 false（不产出半轮）。 */
  round() {
    const O = this.overlap;
    const G = this.segment;
    const S = this.search;

    if (!this.primed) {
      if (this.skip > 0 || this.count < O + G + O) return false;
      // 第一段前面没有可淡化的东西，直通。
      this.appendOut(this.input, 0, O + G);
      this.mid.set(this.input.subarray(O + G, O + G + O));
      this.nominal = this.speed * (O + G);
      this.primed = true;
      this.compact();
      return true;
    }

    const base = Math.round(this.nominal);
    if (this.skip > 0 || this.count < base + S + O + G + O) return false;

    // 在 ±search 内找与 mid 最相似的拼接点。归一化用被拼段的能量 ——
    // 不归一化就总是挑最响的位置，而不是最像的位置。
    const low = -Math.min(S, base);
    let bestShift = 0;
    let bestScore = -Infinity;
    for (let d = low; d <= S; d++) {
      const p = base + d;
      let dot = 0;
      let energy = 0;
      for (let i = 0; i < O; i++) {
        const v = this.input[p + i];
        dot += v * this.mid[i];
        energy += v * v;
      }
      const score = dot / Math.sqrt(energy + 1e-9);
      if (score > bestScore) {
        bestScore = score;
        bestShift = d;
      }
    }

    const take = base + bestShift;
    for (let i = 0; i < O; i++) {
      const w = this.fade[i];
      this.mixed[i] = this.mid[i] * (1 - w) + this.input[take + i] * w;
    }
    this.appendOut(this.mixed, 0, O);
    this.appendOut(this.input, take + O, G);
    this.mid.set(this.input.subarray(take + O + G, take + O + G + O));
    this.nominal += this.speed * (O + G);
    this.compact();
    return true;
  }

  /**
   * 输入到此为止：把残留按原速吐出去。
   * 不这么做的话每段结尾会少掉几十毫秒（最后半个字听不到），而且环先空、
   * 伸缩器还压着东西，drained 的时机也会错。
   */
  drain() {
    const O = this.overlap;
    if (this.primed) {
      const base = Math.min(Math.round(this.nominal), this.count);
      const rest = this.count - base;
      if (rest >= O) {
        for (let i = 0; i < O; i++) {
          const w = this.fade[i];
          this.mixed[i] = this.mid[i] * (1 - w) + this.input[base + i] * w;
        }
        this.appendOut(this.mixed, 0, O);
        this.appendOut(this.input, base + O, rest - O);
      } else {
        // 剩的不够交叉淡化。mid 是真实音频，不能丢，直接接上（最多重复 8ms）。
        this.appendOut(this.mid, 0, O);
        this.appendOut(this.input, base, rest);
      }
    } else if (this.count > 0) {
      this.appendOut(this.input, 0, this.count);
    }
    this.count = 0;
    this.skip = 0;
    this.nominal = 0;
    this.primed = false;
    this.mid.fill(0);
  }

  /** 取出最多 count 个输出样本，返回实际写入数。 */
  pull(dest, offset, count) {
    const n = Math.min(count, this.outCount);
    for (let i = 0; i < n; i++) dest[offset + i] = this.out[this.outHead + i];
    this.outHead += n;
    this.outCount -= n;
    if (this.outCount === 0) this.outHead = 0;
    return n;
  }

  appendOut(src, from, n) {
    if (n <= 0) return;
    if (this.outHead + this.outCount + n > this.out.length) {
      this.out.copyWithin(0, this.outHead, this.outHead + this.outCount);
      this.outHead = 0;
    }
    const at = this.outHead + this.outCount;
    const take = Math.min(n, this.out.length - at); // 兜底，正常不会被裁
    this.out.set(src.subarray(from, from + take), at);
    this.outCount += take;
  }

  /** 名义点之前（减去搜索余量）的输入已经没人要了，挪走腾地方。 */
  compact() {
    const drop = Math.floor(this.nominal) - this.search;
    if (drop <= 0) return;
    this.nominal -= drop;
    if (drop >= this.count) {
      // 加速到名义点跑到了缓冲之外：差额记到 skip，等新样本来了再丢，
      // 这样速率不会因为「丢不够」而偏慢。
      this.skip += drop - this.count;
      this.count = 0;
      return;
    }
    this.input.copyWithin(0, drop, this.count);
    this.count -= drop;
  }
}

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

    this.rate = normalizeRate(config.rate);
    this.stretcher = null;
    this.scratch = null;
    /**
     * 变速路径的预缓冲阶段。三态：
     *   'start'   —— 新的一段，垫到 prebufferLevel（含按 rate 缩放的提前量）
     *   'recover' —— 半路欠载，只垫回 holdLevel（重新垫满会在句中留一个 400ms 的洞）
     *   null      —— 正在播
     */
    this.priming = 'start';
    this.primeWaited = 0;
    this.primeLimit = Math.round(sampleRate * PRIME_MAX_SECONDS);
    /** 距上一次收到 PCM 过了多少个输出样本。用来判断上游是不是说完了。 */
    this.idleFrames = 0;
    this.stallFrames = Math.max(1, Math.round(sampleRate * STALL_SECONDS));
    /**
     * 观测到的音频增量到达间隔（输出采样率域的样本数，衰减的历史最大值）。
     * 垫子厚度和"静默"判定都按它走 —— 粒度是上游的性质，不该写成常量猜。
     */
    this.arrivalGap = 0;
    this.arrivalGapMax = Math.round(sampleRate * ARRIVAL_GAP_MAX_SECONDS);
    /** 这一段里已经收到过增量了（第一块之前的 idleFrames 不是真实的到达间隔）。 */
    this.sawAudio = false;
    /** 重采样消耗的小数余量。按整数扣 available 会累积漂移，这里补回来。 */
    this.consumedFrac = 0;
    // 非原速就在建图时把伸缩器的缓冲准备好（构造还不在 render 回调里）。
    if (this.rate !== 1) this.ensureStretcher();

    this.port.onmessage = (event) => {
      const data = event.data;
      if (!data) return;
      if (data.type === 'pcm') {
        this.enqueue(new Int16Array(data.buffer));
      } else if (data.type === 'flush') {
        // 打断：丢掉一切未播放的内容，下一个 quantum 就静音。
        // 伸缩器的内部缓冲也必须一起清 —— 不然它还能再吐几十毫秒，
        // 打断就不是「立刻」了。
        this.write = 0;
        this.read = 0;
        this.available = 0;
        this.consumedFrac = 0;
        this.playing = false;
        this.stretcher?.reset();
        this.priming = 'start';
        this.primeWaited = 0;
        // 清零而不是保留：否则下一段话开头会被当成"上游已静默"，预缓冲直接跳过。
        this.idleFrames = 0;
        // arrivalGap 不清：增量粒度是**上游的性质**，跨段继续有效，
        // 清掉就等于每一段都要重新交一次学费（第一段必定按最小垫子起步）。
        this.sawAudio = false;
        this.port.postMessage({ type: 'level', value: 0 });
        this.port.postMessage({ type: 'drained' });
        this.lastLevel = 0;
      } else if (data.type === 'rate') {
        // 运行时可改（用户拖滑块/点菜单档位）。不清缓冲：下一轮就按新速率合成，
        // 已经合成好的那几十毫秒照原样播完。
        this.rate = normalizeRate(data.value);
        if (this.rate === 1) this.stretcher?.setSpeed(1);
        // 提前把缓冲分配好，别等到播放中途才在音频线程上申请内存。
        else this.ensureStretcher();
        // 说话中途改倍率时只垫回稳态水位，不按"新的一段"重新垫满 ——
        // 后者会在句子中间挖一个约 400ms 的洞。
        //
        // 原速 → >1 仍然会有一次约 200ms 的停顿：旁路路径把环消耗到接近空，
        // 而伸缩器需要一轮 WSOLA 的前瞻才能合成，这段前瞻只能等出来。
        // 反方向（>1 → 原速）走旁路，一点都不用等。
        if (!this.stalled && this.priming === 'start') this.priming = 'recover';
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
    // 学习上游的增量粒度。取"衰减的历史最大间隔"而不是平均：垫子要盖得住**最坏**
    // 的那次间隔才有意义，盖住平均值等于一半的间隔都会露洞。
    if (this.sawAudio) {
      this.arrivalGap = Math.max(
        this.arrivalGap * ARRIVAL_GAP_DECAY,
        Math.min(this.idleFrames, this.arrivalGapMax),
      );
    }
    this.sawAudio = true;
    this.idleFrames = 0; // 上游还在出音，弹性倍率要继续防御欠载
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
    this.idleFrames += frames;

    // 原速（含「贴近 1」）走旁路：一个样本都不经过伸缩器，默认之外的情况零风险。
    // 刚从变速切回原速时伸缩器里可能还压着音频，先让它吐完再切。
    if (this.rate === 1 && !(this.stretcher && this.stretcher.buffered)) {
      return this.processDirect(out, channel, frames);
    }
    return this.processStretched(out, channel, frames);
  }

  /** 原来的路径：环 → 线性重采样 → 输出。 */
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
      this.consumedFrac = 0;
      this.priming = 'start';
      this.primeWaited = 0;
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

  /** 变速路径：环 → 线性重采样 → WSOLA → 输出。 */
  processStretched(out, channel, frames) {
    const stretcher = this.ensureStretcher();

    if (this.available <= 0 && !stretcher.buffered) {
      for (let c = 0; c < out.length; c++) out[c].fill(0);
      if (this.playing) {
        this.playing = false;
        this.port.postMessage({ type: 'drained' });
      }
      // 已经空了，reset 不会丢任何音频；但必须清掉 mid ——
      // 否则下一段话的开头会和上一段残留的 8ms 交叉淡化。
      stretcher.reset();
      this.priming = 'start';
      this.primeWaited = 0;
      this.report(0);
      return true;
    }

    // 预缓冲。门限按 rate 缩放（见文件头的推导）：以 r 倍播一段原速时长 T 的话音，
    // 比原速早 T·(r−1)/r 结束，所以开播前至少要垫住这么多。
    if (this.priming) {
      // 'recover'（半路欠载）只垫回稳态水位 —— 句中重新垫满会留一个 400ms 的洞，
      // 比继续用弹性倍率顶着难听得多。
      const want =
        this.priming === 'start' ? this.prebufferLevel(stretcher) : this.holdLevel(stretcher);
      // 环空了 / 上游静默了都说明这一段到头了，不再等 —— 否则一句很短的尾音要
      // 白等一个垫子的时间，听上去是句尾打了个嗝。
      const ready = this.ringEmpty() || this.stalled || this.bufferLevel(stretcher) >= want;
      if (!ready && this.primeWaited < this.primeLimit && stretcher.available === 0) {
        this.primeWaited += frames;
        for (let c = 0; c < out.length; c++) out[c].fill(0);
        this.report(0);
        return true;
      }
      this.priming = null;
      this.primeWaited = 0;
    }

    stretcher.setSpeed(this.elasticSpeed(stretcher));
    const scratch = this.scratch;
    let guard = 64; // 死循环保险（round() 每次都要么产出要么 break）
    while (stretcher.available < frames && guard-- > 0) {
      const want = Math.min(stretcher.inputNeeded(), scratch.length);
      if (want > 0) {
        const got = this.fillResampled(scratch, want);
        if (got > 0) stretcher.push(scratch, got);
        if (got < want) {
          // 输入不够一轮。环也空了的话说明这一段到头了，把残留吐完保住尾巴；
          // 否则（网络卡了一下）就等下一个 quantum。
          if (this.ringEmpty()) stretcher.drain();
          break;
        }
      }
      if (!stretcher.round()) break;
    }

    const render = stretcher.pull(channel, 0, frames);
    let sum = 0;
    for (let i = 0; i < render; i++) sum += channel[i] * channel[i];
    for (let i = render; i < frames; i++) channel[i] = 0;
    for (let c = 1; c < out.length; c++) out[c].set(channel);

    if (render < frames) {
      if (this.ringEmpty() && !stretcher.buffered) {
        // 环和伸缩器都空了。复位到和原路径一致的状态。
        this.available = 0;
        this.read = 0;
        this.write = 0;
        this.consumedFrac = 0;
        stretcher.reset();
        // 但"都空了"不等于"说完了"：上游慢于实时时句中也会走到这里。上游还在
        // 出音就只垫回稳态水位（~153ms），别按整段重新垫一次（~450ms）——
        // 实测上游 0.95× 实时、6 秒话音时，不区分这两种情况会在句中留一个
        // 464ms 的洞，区分之后变成 1 个约 150ms 的洞。
        this.priming = this.stalled ? 'start' : 'recover';
        this.primeWaited = 0;
        if (this.playing) {
          this.playing = false;
          this.port.postMessage({ type: 'drained' });
        }
      } else {
        // 半路欠载：重新走一次预缓冲，攒回稳态水位再播。反复出半个 quantum
        // 比等一次更难听。走到这里说明弹性倍率也没顶住（上游慢于实时），
        // 这时候音频本来就不在，断是物理结果，不是实现问题。
        this.priming = 'recover';
        this.primeWaited = 0;
      }
    }

    this.report(render ? Math.sqrt(sum / frames) : 0);
    return true;
  }

  ensureStretcher() {
    if (!this.stretcher) {
      this.stretcher = new TimeStretcher(sampleRate);
      this.scratch = new Float32Array(this.stretcher.capacity);
    }
    this.stretcher.setSpeed(this.rate);
    return this.stretcher;
  }

  /**
   * 合成一轮所需的最少驻留量（输出采样率域）。低于这个水位就吐不出一个完整的
   * quantum —— 也就是听得见的那个空洞。
   */
  minLevel(stretcher) {
    return stretcher.frame + 128;
  }

  /**
   * 稳态水位：合成下限 + 抖动垫子。弹性倍率在这里收敛到 1.0 ——
   * 上游按 1× 实时出音时，1.0 是唯一能稳住不欠载的速度。
   *
   * 垫子取 max(常量下限, 观测到的增量间隔)：粒度 200ms 的上游每块之间水位就要
   * 掉 200ms，用 100ms 的垫子必然在块间露洞（实测确实如此）。
   * rate ≤ 1 不需要垫子（放慢永远不会把上游抽干）。
   */
  holdLevel(stretcher) {
    const floor = this.minLevel(stretcher);
    if (this.rate <= 1) return floor;
    const jitter = Math.max(Math.round(sampleRate * PREBUFFER_JITTER_SECONDS), this.arrivalGap);
    return floor + Math.round(jitter);
  }

  /**
   * 开播门限（输出采样率域）= 稳态水位 + 满速播完一段 ASSUMED_UTTERANCE_SECONDS
   * 所需的提前量 T·(r−1)/r，封顶 PREBUFFER_RATE_MAX_SECONDS。
   *
   * 首音代价见文件头：1.15× 多等约 400ms，1.30× 及以上同样约 400ms（顶到上限）。
   * 顶到上限意味着满速只能撑 PREBUFFER_RATE_MAX·r/(r−1) 秒的话音
   * （1.15× → 2.3 秒，1.30× → 1.3 秒），更长的交给弹性倍率。
   */
  prebufferLevel(stretcher) {
    const hold = this.holdLevel(stretcher);
    if (this.rate <= 1) return hold;
    const headroom = Math.min(
      PREBUFFER_RATE_MAX_SECONDS,
      (ASSUMED_UTTERANCE_SECONDS * (this.rate - 1)) / this.rate,
    );
    return hold + Math.round(sampleRate * headroom);
  }

  /** 当前缓冲总水位（输出采样率域）：环里的 + 伸缩器输入里的 + 已合成好的。 */
  bufferLevel(stretcher) {
    return this.available / this.step + stretcher.count + stretcher.available;
  }

  /**
   * 上游静默够久了 —— 这一段大概说完了，不必再防御未来的欠载。
   * 门限取 max(STALL_SECONDS, 2×观测到的增量间隔)：粒度 200ms 的上游每两块之间
   * 都静默 200ms，用固定 150ms 判定会把每个正常的块间间隔都当成"说完了"。
   */
  get stalled() {
    return this.idleFrames >= Math.max(this.stallFrames, 2 * this.arrivalGap);
  }

  /**
   * 瞬时合成倍率。目标是 rate，但水位掉下来就往 1.0 收 —— 因为上游按 1× 实时
   * 出音时 1.0 是唯一的稳态（以 r 消耗、按 1 供给，环必然被抽干）。
   *
   * 为什么这比"把垫子加厚"好：垫子要厚到 T·(r−1)/r，而 T 在开播时根本不知道，
   * 按最长的话音去垫会让首音延迟到一秒以上。弹性倍率把"垫不够"的后果从
   * **每 500ms 一个 43ms 的静音**换成**几百毫秒尺度的语速起伏** —— 后者在
   * 1.0~1.15 这个范围里基本听不出来（自然语速的起伏比这还大）。
   *
   * 1.0 是**下界不是目标**：上游快于实时时（实测 1.3× 即可）水位一直是满的，
   * 全程跑满 rate，一次欠载都没有。
   *
   * 两种情况直接用目标倍率，不打折：
   * - rate ≤ 1：放慢只会让环越积越多，没有欠载风险。
   * - 上游已静默：这一段说完了，没有"未来"要防御，剩下的缓冲按目标倍率播到底
   *   （也让"一次性灌进整段音频"这种离线场景精确得到 1/rate 的时长）。
   */
  elasticSpeed(stretcher) {
    if (this.rate <= 1 || this.stalled) return this.rate;
    const hold = this.holdLevel(stretcher);
    const full = this.prebufferLevel(stretcher);
    if (full <= hold) return this.rate;
    const t = (this.bufferLevel(stretcher) - hold) / (full - hold);
    return 1 + (this.rate - 1) * Math.min(1, Math.max(0, t));
  }

  ringEmpty() {
    return Math.floor((this.available - 1) / this.step) <= 0;
  }

  /** 从环里取出 count 个输出采样率的样本（顺带重采样），返回实际取到的数量。 */
  fillResampled(dest, count) {
    const maxFrames = Math.max(0, Math.floor((this.available - 1) / this.step));
    const n = Math.min(count, maxFrames);
    for (let i = 0; i < n; i++) {
      dest[i] = this.sample(this.read);
      this.read += this.step;
      if (this.read >= this.size) this.read -= this.size;
    }
    // 小数部分累起来再扣，否则每次调用都 floor 一下，几百次之后 available
    // 就比真实剩余多出几十毫秒，读指针会追过写指针放出旧音频。
    const exact = n * this.step + this.consumedFrac;
    const whole = Math.floor(exact);
    this.consumedFrac = exact - whole;
    this.available -= whole;
    if (this.available < 0) this.available = 0;
    return n;
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

/** 夹到 0.8~1.8，并把贴近 1 的值吸附到 1（走旁路）。 */
function normalizeRate(value) {
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate <= 0) return 1;
  const clamped = Math.min(MAX_RATE, Math.max(MIN_RATE, rate));
  return Math.abs(clamped - 1) < RATE_EPSILON ? 1 : clamped;
}

// 暴露给单测：Node 里用 new Function 加载这个文件，然后直接喂合成信号断言
// 时长/基频。浏览器里这是 AudioWorkletGlobalScope，挂个属性没有副作用。
globalThis.StepPlaybackInternals = { TimeStretcher, normalizeRate };

registerProcessor('step-playback', StepPlayback);
