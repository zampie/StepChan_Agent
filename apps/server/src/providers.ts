import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { readSSE } from '../../../shared/sse';
import type { ChatRequest, InteractionRequest } from '../../../shared/protocol';
import type { Scene } from '../../../shared/room';
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
) => Promise<{ text: string; calls: ToolCall[]; usage?: TokenUsage }>;
const usageSchema = z.object({
  prompt_tokens: z.number().nonnegative(),
  completion_tokens: z.number().nonnegative(),
  total_tokens: z.number().nonnegative(),
  prompt_tokens_details: z
    .object({ cached_tokens: z.number().nonnegative().optional() })
    .optional(),
  completion_tokens_details: z
    .object({ reasoning_tokens: z.number().nonnegative().optional() })
    .optional(),
});
export type TokenUsage = z.infer<typeof usageSchema>;
const deltaSchema = z.object({
  error: z.unknown().optional(),
  usage: z.unknown().optional(),
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
                  // StepFun continuation fragments explicitly send type: ''.
                  type: z.enum(['function', '']).optional(),
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
  return chatProvider({ ...config, provider: 'openrouter' });
}
export function chatProvider(config: {
  provider: 'stepfun' | 'openrouter';
  key: string;
  model: string;
  maxTokens: number;
}): Provider {
  return async (messages, signal, onText) => {
    const isStepFun = config.provider === 'stepfun';
    const endpoint = isStepFun
      ? 'https://api.stepfun.com/v1/chat/completions'
      : 'https://openrouter.ai/api/v1/chat/completions';
    const response = await fetch(endpoint, {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${config.key}`,
        'Content-Type': 'application/json',
        ...(!isStepFun
          ? {
              'HTTP-Referer': 'http://localhost:5173',
              'X-Title': 'StepChan Web MVP',
            }
          : {}),
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: config.maxTokens,
        stream: true,
        ...(isStepFun ? { reasoning_effort: 'low' } : { reasoning: { effort: 'low' } }),
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
    let usage: TokenUsage | undefined;
    const fragments = new Map<number, ToolCall>();
    for await (const frame of readSSE(response.body)) {
      if (frame.data === '[DONE]') {
        ended = true;
        break;
      }
      const parsed = deltaSchema.safeParse(JSON.parse(frame.data));
      if (!parsed.success) throw Error('模型服务返回了无法识别的事件。');
      if (parsed.data.error) throw Error('模型服务在生成过程中出错，请稍后重试。');
      // Streaming usage is cumulative per request; keep the latest report, do not sum chunks.
      const reportedUsage = usageSchema.safeParse(parsed.data.usage);
      if (reportedUsage.success) usage = reportedUsage.data;
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
    return { text, calls, ...(usage ? { usage } : {}) };
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
export function mockRoomProvider(request: InteractionRequest, scene: Scene): Provider {
  return async (messages, signal, onText) => {
    await delay(request.scenario === 'slow' ? 30000 : 320, undefined, { signal });
    if (request.scenario === 'error')
      throw Error('模拟服务暂时不可用。已完成的房间操作会保留，可以继续。');
    const last = messages.at(-1)!;
    let text = '';
    const call = (name: string, args: unknown = {}) => ({
      text: '',
      calls: [
        {
          id: crypto.randomUUID(),
          type: 'function' as const,
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    });
    if (last.role === 'tool') {
      const result = JSON.parse(last.content!);
      const previous = messages.at(-2)?.tool_calls?.at(-1)?.function.name;
      if (previous === 'observe_scene')
        text =
          scene.card && !scene.card.revealed
            ? '我在陪你看这张发现卡。你可以直接点选项，也可以随时换个话题。'
            : '我看了看小房间。可以抽张发现卡，或者一起休息一分钟，你想选哪个？';
      else if (previous === 'draw_discovery_card')
        text = `抽到一个小问题：${scene.card?.question} 点一个答案试试，我先不剧透。`;
      else if (previous === 'water_plant' && result.ok)
        text = '浇好水啦，土壤湿润了。小植物也需要恰到好处，今天就不多浇啦。';
      else text = result.ok ? `好啦，${result.message}。` : `这一步没有执行：${result.message}`;
    } else if (request.input.kind === 'touch') {
      const count = Number(messages.at(-1)?.content?.match(/被轻点 (\d+) 次/)?.[1] ?? 1);
      const replies = {
        head:
          count > 1
            ? '又点到头顶啦！我已经注意到你了。要一起抽张卡吗？'
            : '嘿，收到你的摸头招呼了！今天想一起发现什么？',
        cheek: '咦，点到脸颊了！我在听，你可以直接点下面的选项。',
        badge: '这是我的小徽章。比起收集奖章，我更喜欢收集有意思的新发现。',
        hand: '收到你的招呼啦！一起去看看房间里的小东西？',
      };
      text = replies[request.input.part];
    } else if (request.input.kind === 'autonomy') {
      if (scene.plant.moisture < 65) return call('water_plant');
      if (!scene.card) return call('draw_discovery_card');
      if (!scene.light.warm) return call('set_light', { on: true, brightness: 60, warm: true });
      if (scene.petTarget !== 'cards') return call('move_to', { target: 'cards' });
      if (scene.timer.status === 'idle') return call('start_timer', { seconds: 30 });
      text = '房间已经收拾妥当。我就在这里安静待一会儿，你想接话时随时点我。';
    } else if (request.input.kind === 'timer_finished')
      text = '这一小段休息结束啦。要继续探索，还是再放松一会儿？';
    else {
      const content = request.input.kind === 'text' ? request.input.text : '';
      const url = content.match(/https?:\/\/[^\s，。！]+/)?.[0];
      if (url) return call('open_url', { url });
      if (/几点|当前时间/.test(content)) return call('get_time');
      if (/让我猜|不要剧透/.test(content))
        text = '好，我先停在这里，不揭晓答案。下面的选项都可以直接点。';
      else if (/简短|接上|继续刚才/.test(content)) {
        const prior =
          messages.filter((m) => m.role === 'assistant' && m.content).at(-1)?.content ?? '';
        text = prior
          ? `接着刚才说到的「${prior.slice(0, 38)}${prior.length > 38 ? '…' : ''}」。我们可以直接从当前这一步继续。`
          : '好，我说简短一点。点选房间里的物件，就可以一起做点小事。';
      } else if (/浇水/.test(content)) return call('water_plant');
      else if (/关灯|看星星/.test(content))
        return call('set_light', { on: false, brightness: 65, warm: false });
      else if (/开灯|亮一点/.test(content))
        return call('set_light', { on: true, brightness: 85, warm: false });
      else if (/冷知识|抽卡|有趣|猜谜/.test(content)) return call('draw_discovery_card');
      else if (/答案|揭晓/.test(content) && scene.card)
        return call('reveal_card', { cardId: scene.card.id });
      else if (/取消.*计时/.test(content)) return call('cancel_timer');
      else if (/休息|累/.test(content)) return call('start_timer', { seconds: 60 });
      else return call('observe_scene');
    }
    for (const chunk of text.match(/.{1,2}|\n/gu) ?? []) {
      signal.throwIfAborted();
      onText(chunk);
      await delay(48, undefined, { signal });
      if (request.scenario === 'disconnect') throw Error('MOCK_DISCONNECT');
    }
    return { text, calls: [] };
  };
}
