import { eventSchema, type ChatEvent, type ChatRequest } from '../../../../shared/protocol';
import { readSSE } from '../../../../shared/sse';
export async function streamChat(
  request: ChatRequest,
  signal: AbortSignal,
  onEvent: (event: ChatEvent) => void,
) {
  const controller = new AbortController();
  const stop = () => controller.abort(signal.reason);
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  const timer = setTimeout(() => controller.abort(new Error('等待回复超时，请重试。')), 20000);
  const deadline = setTimeout(
    () => controller.abort(new Error('本次请求超过 60 秒，请重试。')),
    60000,
  );
  let done = false,
    first = true;
  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({ message: '连接服务失败。' }));
      throw Error(data.message ?? '请求失败。');
    }
    if (!response.body) throw Error('没有收到回复流。');
    for await (const frame of readSSE(response.body)) {
      let value: unknown;
      try {
        value = JSON.parse(frame.data);
      } catch {
        throw Error('收到损坏的事件，请重试。');
      }
      const result = eventSchema.safeParse(value);
      if (!result.success) {
        if (frame.event === 'presentation') continue;
        throw Error('回复事件格式不正确。');
      }
      const event = result.data;
      if (event.requestId !== request.requestId || done) continue;
      if (first) {
        clearTimeout(timer);
        first = false;
      }
      if (event.type !== frame.event) throw Error('回复事件类型不匹配。');
      onEvent(event);
      if (event.type === 'done') {
        done = true;
        break;
      }
    }
    if (!done) throw Error('连接中断，回复未完成。可以重试。');
  } catch (error) {
    if (controller.signal.aborted && !signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    clearTimeout(deadline);
    signal.removeEventListener('abort', stop);
    controller.abort();
  }
}
