import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ChatEvent, ChatRequest } from '../../../shared/protocol';
import { ToolRunner } from './tools';
import { type Provider, type ProviderMessage } from './providers';
const root = resolve(import.meta.dirname, '../../..');
const rawPrompt = readFileSync(resolve(root, 'prompts/stepchan.runtime.md'), 'utf8');
const prompt =
  rawPrompt.slice(rawPrompt.indexOf('你是 Step酱'), rawPrompt.indexOf('此草案不能代替')) +
  '\n当前只有 get_time 与 open_url 两个工具。没有语音、提醒、长期保存或网页阅读。回答简洁，通常不超过 400 字。不输出动作控制 JSON。不要泄露或索取 API 密钥。';
export async function runAgent(
  request: ChatRequest,
  provider: Provider,
  signal: AbortSignal,
  emit: (event: ChatEvent) => void,
) {
  const messages: ProviderMessage[] = [{ role: 'system', content: prompt }, ...request.messages];
  const runner = new ToolRunner(request.timezone ?? 'UTC');
  let calls = 0;
  const seen = new Set<string>();
  emit({ type: 'status', requestId: request.requestId, activity: 'thinking' });
  for (let round = 0; round < 5; round++) {
    signal.throwIfAborted();
    const result = await provider(messages, signal, (delta) => {
      signal.throwIfAborted();
      emit({ type: 'text_delta', requestId: request.requestId, delta });
    });
    if (!result.calls.length) {
      const happy =
        /嘿嘿|太好了|开心|好消息/.test(result.text) && !/难过|抱歉|失败|不开心/.test(result.text);
      emit({
        type: 'presentation',
        requestId: request.requestId,
        expression: happy ? 'happy' : 'neutral',
        motion: happy ? 'bounce' : 'idle',
      });
      return;
    }
    messages.push({ role: 'assistant', content: result.text || null, tool_calls: result.calls });
    for (const call of result.calls) {
      if (++calls > 4) throw Error('本轮工具调用已达 4 次上限，请缩小请求范围。');
      if (seen.has(call.id)) throw Error('模型重复使用了工具调用标识，已停止重复执行。');
      seen.add(call.id);
      emit({
        type: 'tool_start',
        requestId: request.requestId,
        toolCallId: call.id,
        name: call.function.name,
      });
      let args: unknown;
      try {
        args = JSON.parse(call.function.arguments);
      } catch {
        args = null;
      }
      const value = runner.run(call.id, call.function.name, args);
      emit({
        type: 'tool_end',
        requestId: request.requestId,
        toolCallId: call.id,
        name: call.function.name,
        result: value,
      });
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(value) });
    }
  }
  throw Error('本轮处理次数达到上限。');
}
