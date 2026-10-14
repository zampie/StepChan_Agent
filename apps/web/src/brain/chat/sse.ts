// chat 模式的 SSE 读取。/v1/chat/completions 的流式响应。
//
// 实测的协议形状（2026-10-14，api.stepfun.com）：
// - 帧之间用空行（`\n\n`）分隔，每帧一行 `data: {...}`；
// - 流以 `data: [DONE]` 结束，之后连接才关；
// - 最后一帧之前还有一帧 `choices: []`（只带 usage），不能当成有内容的帧处理。
//
// 踩过的坑：`for await` 里 `break` 会触发生成器的 finally，而在 finally 里
// `await reader.cancel()` 在 Node 26 下**不会 settle**（整个进程挂住，报
// unsettled top-level await）。所以这里只做 fire-and-forget 的 cancel。
// 要提前终止请用 AbortSignal，不要靠 cancel。

/** 单帧上限。正常帧 1~3KB，超过这个量级说明流坏了，不如早点报错。 */
const MAX_FRAME_BYTES = 1024 * 1024;

/**
 * 把响应体解成一串 `data:` 负载（不含 `[DONE]`，遇到它就正常结束）。
 * 不解析 JSON —— 解析失败的策略由调用方决定。
 */
export async function* readSseData(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length > MAX_FRAME_BYTES) throw Error('SSE 帧过大，流异常。');
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const raw = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const data = raw
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n');
        if (!data) continue;
        if (data === '[DONE]') return;
        yield data;
      }
      if (done) return;
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
}
