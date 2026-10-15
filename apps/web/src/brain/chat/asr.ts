// 一次性语音识别：一段 PCM16 → 一句文本。chat 模式「按住说话」的输入端。
//
// 为什么是「一次提交一整段」而不是流式：chat 模式没有 realtime 的服务端 VAD，
// 要做持续聆听就得自己实现 VAD（或者换成 stepaudio-2.5-asr-stream 那条双向流式的路）。
// 而「按住说话」的边界是**明确**的 —— 松手就是说完了 —— 所以这条最简单的路就够用。
// 代价是转写耗时整段串在延迟账里（见 docs/BRAIN_MODES.md）。
//
// 请求体是**嵌套**的（audio.data / audio.input.transcription / audio.input.format），
// 不是 OpenAI 那种 multipart。这个形状是实测跑通过的，照抄自删掉的
// apps/server/src/audioRoutes.ts（git show be5c181:apps/server/src/audioRoutes.ts）。
// 响应是 SSE，最终文本在 `transcript.text.done` 事件的 text 里。
import { readSseData } from './sse';
import { bytesToBase64, encodeWav } from './wav';

export const ASR_URL = 'https://api.stepfun.com/v1/audio/asr/sse';
export const ASR_MODEL = 'stepaudio-3-asr-max';

/**
 * 热词。
 *
 * **实测它不是必需的**：同一段音频带/不带热词都能把「Step酱」认出来（6 次，见
 * docs/BRAIN_MODES.md），差别只在分词 —— 带这份表时偶尔输出「Step 酱」。
 * 留着是因为它免费、对别的专有名词可能有用，而且这个字段本身是验证过能通的；
 * 但不要指望它救什么，也不要因为它去掉就以为名字会转错。
 */
export const ASR_HOTWORDS = ['Step酱', '桌宠', '表情', '截屏'] as const;

/** 单次识别的超时。实测一句话 0.6~1.5s，10 秒还没回来就是出事了。 */
const ASR_TIMEOUT_MS = 10_000;

export type TranscribeOptions = {
  apiKey: string;
  /** 单声道 PCM16 样本。 */
  samples: Int16Array;
  /** samples 的**实际**采样率。写错只会让转写结果莫名其妙，不会报错。 */
  sampleRate: number;
  /** 外部取消（松手后又切了模式、或者被 interrupt）。 */
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** 覆盖热词；不传用 ASR_HOTWORDS。 */
  hotwords?: readonly string[];
};

/** 识别失败时抛这个，消息已经是能直接给用户看的中文。 */
export class AsrError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AsrError';
  }
}

/**
 * 提交一段音频，拿回转写文本。
 *
 * 返回空字符串 = 服务端听了但没听出内容（环境噪声、离麦太远）。这不是错误，
 * 调用方应该轻轻提示一下而不是弹故障 —— 用户只是说得太轻。
 */
export async function transcribePcm16(options: TranscribeOptions): Promise<string> {
  const wav = encodeWav(options.samples, options.sampleRate);
  const body = JSON.stringify({
    audio: {
      data: bytesToBase64(wav),
      input: {
        transcription: {
          model: ASR_MODEL,
          language: 'zh',
          hotwords: [...(options.hotwords ?? ASR_HOTWORDS)],
        },
        format: { type: 'wav' },
      },
    },
  });

  // 自己的超时 + 外部取消合成一个 signal。AbortSignal.any 在 webview 里不一定有，
  // 所以手动转发 —— 这里不能图省事，取消失败的后果是用户已经换了话题，
  // 几秒后突然冒出来上一句的转写，凭空发起一轮对话。
  const abort = new AbortController();
  const timeout = setTimeout(
    () => abort.abort(new AsrError('语音识别超时了，再说一次试试。')),
    ASR_TIMEOUT_MS,
  );
  const forward = (): void => abort.abort(options.signal?.reason);
  if (options.signal?.aborted) forward();
  options.signal?.addEventListener('abort', forward, { once: true });

  try {
    const doFetch = options.fetchImpl ?? fetch;
    const response = await doFetch(ASR_URL, {
      method: 'POST',
      signal: abort.signal,
      headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
      body,
    });
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      await response.body?.cancel().catch(() => {});
      throw new AsrError(
        `语音识别暂时不可用（${response.status}）${detail ? `：${detail.slice(0, 120)}` : ''}。`,
        response.status,
      );
    }
    return readTranscript(response.body);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', forward);
  }
}

/**
 * 从 SSE 流里取最终文本。
 *
 * 只认 `transcript.text.done`。`transcript.text.delta` 也会来（能做实时字幕），
 * 但这一版不用：一段提交的识别本来就是整段回，delta 只比 done 早几十毫秒，
 * 为它多一条 UI 路径不值得。
 */
async function readTranscript(stream: ReadableStream<Uint8Array>): Promise<string> {
  let done = false;
  let text = '';
  for await (const data of readSseData(stream)) {
    let event: { type?: unknown; text?: unknown; error?: unknown };
    try {
      event = JSON.parse(data) as typeof event;
    } catch {
      // 坏帧跳过：一帧解析不了不代表整段识别失败。
      continue;
    }
    if (event.type === 'error') {
      const message =
        typeof event.error === 'string'
          ? event.error
          : typeof (event.error as { message?: unknown } | undefined)?.message === 'string'
            ? String((event.error as { message?: string }).message)
            : '';
      throw new AsrError(`语音识别失败${message ? `：${message.slice(0, 120)}` : ''}。`);
    }
    if (event.type === 'transcript.text.done') {
      done = true;
      text = typeof event.text === 'string' ? event.text.trim() : '';
      break;
    }
  }
  // 流断在 done 之前 = 这段话丢了。和「听了没听出来」必须区分开：
  // 前者该提示重试，后者只是说得太轻。
  if (!done) throw new AsrError('语音识别中断了，再说一次试试。');
  return text;
}
