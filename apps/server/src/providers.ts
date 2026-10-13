import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { readSSE } from '../../../shared/sse';
import type { ChatRequest } from '../../../shared/protocol';
import { toolDefinitions } from './tools';
export type ProviderMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
};
export type ToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};
export type Provider = (
  messages: ProviderMessage[],
  signal: AbortSignal,
  onText: (text: string) => void,
) => Promise<{ text: string; calls: ToolCall[] }>;
const deltaSchema = z.object({
  error: z.unknown().optional(),
  choices: z
    .array(
      z.object({
        delta: z
          .object({
            content: z.string().nullable().optional(),
            tool_calls: z
              .array(
                z.object({
                  index: z.number().int().min(0).max(3),
                  id: z.string().optional(),
                  type: z.literal('function').optional(),
                  function: z
                    .object({ name: z.string().optional(), arguments: z.string().optional() })
                    .optional(),
                }),
              )
              .optional(),
          })
          .optional(),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .optional(),
});
export function openRouterProvider(config: {
  key: string;
  model: string;
  maxTokens: number;
}): Provider {
  return async (messages, signal, onText) => {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${config.key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:5173',
        'X-Title': 'StepChan Web MVP',
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: config.maxTokens,
        stream: true,
        reasoning: { effort: 'low' },
        messages,
        tools: toolDefinitions,
        parallel_tool_calls: false,
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw Error(`模型服务返回 HTTP ${response.status}。请检查服务端配置、额度或稍后重试。`);
    }
    if (!response.body) throw Error('模型服务未返回流。');
    let text = '',
      finish: string | null = null,
      ended = false;
    const fragments = new Map<number, ToolCall>();
    for await (const frame of readSSE(response.body)) {
      if (frame.data === '[DONE]') {
        ended = true;
        break;
      }
      const parsed = deltaSchema.safeParse(JSON.parse(frame.data));
      if (!parsed.success) throw Error('模型服务返回了无法识别的事件。');
      if (parsed.data.error) throw Error('模型服务在生成过程中出错，请稍后重试。');
      const choice = parsed.data.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finish = choice.finish_reason;
      if (choice.delta?.content) {
        text += choice.delta.content;
        if (text.length > 12000) throw Error('模型回复过长，已停止。');
        onText(choice.delta.content);
      }
      for (const part of choice.delta?.tool_calls ?? []) {
        const call = fragments.get(part.index) ?? {
          id: '',
          type: 'function',
          function: { name: '', arguments: '' },
        };
        if (part.id) call.id += part.id;
        if (part.function?.name) call.function.name += part.function.name;
        if (part.function?.arguments) call.function.arguments += part.function.arguments;
        if (
          call.function.arguments.length > 8192 ||
          call.id.length > 200 ||
          call.function.name.length > 100
        )
          throw Error('工具请求超过长度限制。');
        fragments.set(part.index, call);
      }
    }
    if (!ended || !finish) throw Error('模型连接提前结束，回复可能未完成。');
    if (finish === 'length') throw Error('模型回复达到长度上限，保留了已生成内容。可以要求继续。');
    if (!['stop', 'tool_calls'].includes(finish)) throw Error('模型未正常完成回复。');
    const calls = [...fragments.values()];
    if (calls.some((c) => !c.id || !c.function.name)) throw Error('模型工具请求不完整。');
    if (!text && !calls.length) throw Error('模型返回了空回复，请重试。');
    return { text, calls };
  };
}
export function mockProvider(request: ChatRequest): Provider {
  return async (messages, signal, onText) => {
    await delay(request.scenario === 'slow' ? 30000 : 280, undefined, { signal });
    if (request.scenario === 'error') throw Error('模拟服务暂时不可用。可以重试或换一个问题。');
    const last = messages.at(-1)!;
    let text = '';
    if (last.role === 'tool') {
      const result = JSON.parse(last.content!);
      text = result.ok ? `收到结果啦。${result.message}` : `这一步没完成：${result.message}`;
    } else {
      const content = last.content ?? '';
      const url = content.match(/https?:\/\/[^\s，。！]+/)?.[0];
      if (url)
        return {
          text: '',
          calls: [
            {
              id: 'mock-link',
              type: 'function',
              function: { name: 'open_url', arguments: JSON.stringify({ url }) },
            },
          ],
        };
      if (/几点|时间/.test(content))
        return {
          text: '',
          calls: [
            { id: 'mock-time', type: 'function', function: { name: 'get_time', arguments: '{}' } },
          ],
        };
      if (/难过|累|不开心/.test(content))
        text = '听起来今天有点累。我们可以先把事情放一放。想聊聊，还是安静休息一会儿？';
      else if (/名字|你好/.test(content))
        text = '你好呀，我是 Step酱！可以一起想问题，也可以随便聊聊。今天想从哪一步开始？';
      else if (/冷知识/.test(content))
        text =
          '一个小发现：金星自转一圈的时间，比绕太阳公转一圈还长。它的一天，真的可以比一年更漫长。宇宙的作息表很有自己的想法。';
      else
        text =
          '好呀，我们先把它拆成一小步：你希望最后得到什么结果？明确终点以后，就容易找到今天能开始的事情了。\n\n这是演示模式的预设回复。切换到真实模型后，就能和我自由讨论啦。';
    }
    for (const chunk of text.match(/.{1,3}|\n/gu) ?? []) {
      signal.throwIfAborted();
      onText(chunk);
      await delay(30, undefined, { signal });
      if (request.scenario === 'disconnect') throw Error('MOCK_DISCONNECT');
    }
    return { text, calls: [] };
  };
}
