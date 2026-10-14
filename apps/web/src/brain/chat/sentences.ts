// 流式文本 → 可以立刻送去 TTS 的短句。
//
// 为什么要有这一层：chat 模型不出音频，音频得我们自己合成，而 /v1/audio/speech
// 是**整段合成**（实测响应头和完整下载几乎同时到达，没有渐进出流），所以合成
// 耗时跟文本长度正相关：8 字 ≈ 1.3~2.0s，19 字 ≈ 2.7s，68 字 ≈ 3.8s。
// 唯一能压延迟的办法就是别等她说完 —— 第一个短句一到就开始合成。
//
// 两条从旧实现（已删除的 audio/SpeechPlayer.ts）继承的教训：
// 1. markdown 和括号里的内容必须滤掉，否则会被原样念出来（「左括号歪头右括号」）。
//    TTS 3 文档也说 `()` 里的文字会被当成不发音指令，不能把原文直接送进去。
// 2. 代码块绝对不能念。

/** 句子结束符。见到就切。 */
const STRONG = /[。！？!?；;…\n]/;
/** 停顿符。只在「第一句、且已经够长」时用来切，纯粹为了压首音延迟。 */
const WEAK = /[，、,：:]/;
/** 单段硬上限。超过就强切 —— 一段太长 TTS 慢，而且 12 秒的播放环放不下。 */
const MAX_SEGMENT = 56;
/** 首段用弱标点切的最短长度。太短会把「咦，」这种语气词单独念出来。 */
const FIRST_SEGMENT_MIN = 8;
/**
 * 首段上限。实测合成耗时跟字数正相关（8 字 ≈ 1.5s，25 字 ≈ 3.4s），
 * 而首音延迟是用户唯一能感觉到的等待，所以第一段单独卡得更紧。
 * 再往下压收益有限 —— 合成本身有 1.3~2s 的地板。
 */
const FIRST_SEGMENT_MAX = 24;

/**
 * 只留能念出来的纯文本。
 *
 * 顺序有讲究：先去代码块，再去链接（保留链接文字），再去括号内容，
 * 最后去残留的 markdown 符号。括号那条要在去链接之后，否则 `[文字](url)`
 * 的 url 会先被括号规则吃掉一半。
 */
export function spokenText(text: string): string {
  return (
    text
      .replace(/```[\s\S]*?(?:```|$)/g, '')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/<[^>]*>/g, '')
      // 列表符号要按行首去掉，不能并到下面那条字符类里 —— 破折号在句子中间
      // （「八点三十九分 —— 该歇了」）是有意义的，不该一并删掉。
      .replace(/^[ \t]*(?:[-*+•]|\d+[.)])\s+/gm, '')
      // 括号里多半是她不该念的舞台提示（「（歪头）」）或补充说明。
      .replace(/[（(][^）)]*[）)]/g, '')
      .replace(/[*_`#>|~[\]（()）]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * 增量切句。喂 delta，拿回可以立刻合成的段落。
 *
 * 切点策略是不对称的：第一段尽量早切（弱标点也认），后面只认强标点。
 * 理由是首音延迟是用户唯一能感觉到的那段等待，而后面的段落反正在排队播放，
 * 切得细只会让语调更碎。
 */
export class SentenceBuffer {
  private pending = '';
  private emitted = 0;
  private inCode = false;

  /** 喂一段增量，返回这次凑出来的完整段落（可能是 0 个或多个）。 */
  push(delta: string): string[] {
    this.pending += delta;
    const out: string[] = [];
    while (true) {
      const length = this.nextCut(false);
      if (!length) break;
      const segment = this.take(length);
      if (segment) out.push(segment);
    }
    return out;
  }

  /** 这一轮说完了：把剩下的残句也交出来。 */
  flush(): string[] {
    const out: string[] = [];
    while (this.pending.trim()) {
      const length = this.nextCut(true) || this.pending.length;
      const segment = this.take(length);
      if (segment) out.push(segment);
    }
    this.pending = '';
    return out;
  }

  /** 新一轮/被打断：丢掉所有状态。 */
  reset(): void {
    this.pending = '';
    this.emitted = 0;
    this.inCode = false;
  }

  /** 返回应该切掉的长度，0 表示还不够切。 */
  private nextCut(final: boolean): number {
    const first = this.emitted === 0;
    const cap = first ? FIRST_SEGMENT_MAX : MAX_SEGMENT;
    const strong = STRONG.exec(this.pending);
    const strongAt = strong && strong.index + 1 <= cap ? strong.index + 1 : 0;
    // 首段取「最早能切的地方」：强标点和停顿符里谁先到用谁。
    // 流式输入下通常是逗号先到，但一次性灌进整段文本时也要给出同样的结果。
    if (first && this.pending.length >= FIRST_SEGMENT_MIN) {
      const weak = WEAK.exec(this.pending);
      const weakAt =
        weak && weak.index + 1 >= FIRST_SEGMENT_MIN && weak.index + 1 <= cap ? weak.index + 1 : 0;
      if (weakAt && strongAt) return Math.min(weakAt, strongAt);
      if (weakAt) return weakAt;
    }
    if (strongAt) return strongAt;
    if (this.pending.length >= cap) {
      // 到上限了：优先在上限之前的最后一个停顿处切，不然就硬切。
      const head = this.pending.slice(0, cap);
      const marks = [...head].reduce<number>(
        (best, char, i) => (WEAK.test(char) || STRONG.test(char) ? i + 1 : best),
        0,
      );
      return marks || cap;
    }
    if (final && this.pending.trim()) return Math.min(this.pending.length, cap);
    return 0;
  }

  /** 切下前 length 个字符，返回可念的文本（代码块和纯符号段返回空串）。 */
  private take(length: number): string {
    const raw = this.pending.slice(0, length);
    this.pending = this.pending.slice(length);
    const fences = (raw.match(/```/g) ?? []).length;
    const skip = this.inCode || fences > 0;
    if (fences % 2) this.inCode = !this.inCode;
    if (skip) return '';
    const spoken = spokenText(raw);
    if (!spoken) return '';
    this.emitted++;
    return spoken;
  }
}
