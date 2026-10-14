// 一次流式 chat completion 请求。只管协议，不认识人设、工具语义和桌面能力。
//
// 与 realtime 的差别：这里没有会话，每一轮都把完整 messages 重新发一遍 ——
// 上下文的权威在我们手里（见 docs/BRAIN_MODES.md）。好处是没有 30 分钟上限、
// 可以随时改 system prompt、可以随时换模型；代价是每轮都要重付输入 token。
import type { ToolDefinition } from '../../../../../shared/realtime';
import { readSseData } from './sse';

export const CHAT_COMPLETIONS_URL = 'https://api.stepfun.com/v1/chat/completions';

/** 一轮回复的 token 上限。她被要求只说 1~3 句，给足余量即可。 */
const MAX_TOKENS = 600;

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant';
      // 带 tool_calls 时 content 常常是空串，要传 null —— 空串在部分实现里会被当成「说过话」。
      content: string | null;
      tool_calls?: {
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }[];
    }
  | { role: 'tool'; tool_call_id: string; content: string };

export type StreamedToolCall = { id: string; name: string; args: string };

export type ChatStreamResult = {
  text: string;
  reasoning: string;
  toolCalls: StreamedToolCall[];
  finishReason: string | null;
};

export type ChatStreamOptions = {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  /** 不传 = 这一轮不给工具（用于「工具额度用完了，现在必须说话」）。 */
  tools?: ToolDefinition[];
  signal?: AbortSignal;
  /** 正文增量。按到达顺序回调，用来喂字幕和按句 TTS。 */
  onContent?: (delta: string) => void;
  /** 思考过程增量。step-5-preview 是推理模型，正文之前会先出一段 reasoning_content。 */
  onReasoning?: (delta: string) => void;
  /** 注入点，测试里塞假的。 */
  fetchImpl?: typeof fetch;
};

/** 请求失败时抛这个，带上状态码，便于上层给出能行动的提示。 */
export class ChatHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(describeStatus(status, body));
  }
}

function describeStatus(status: number, body: string): string {
  if (status === 401 || status === 403)
    return 'API key 被拒了（401/403），检查一下 .env 里的 key。';
  if (status === 404) return '这个模型在当前 key 下不存在（404）。';
  if (status === 429) return '调用太频繁了（429），等一下再说一句。';
  if (status >= 500) return `模型服务暂时不可用（${status}）。`;
  return `对话请求失败（${status}）：${body.slice(0, 200)}`;
}

/**
 * 发一次流式请求并把增量喂给回调，结束后返回这一轮的完整结果。
 *
 * 注意 tool_calls 增量的形状（实测）：第一条带 id / type / function.name 和
 * arguments 的开头，**后续每条的 id、type、name 都是空字符串占位**。
 * 无条件覆盖会把 id 和 name 清空，结果是工具名变成空、回灌时 400。
 */
export async function streamChatCompletion(options: ChatStreamOptions): Promise<ChatStreamResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const body: Record<string, unknown> = {
    model: options.model,
    stream: true,
    messages: options.messages,
    max_tokens: MAX_TOKENS,
  };
  if (options.tools?.length) {
    body.tools = options.tools;
    body.tool_choice = 'auto';
  }

  const response = await doFetch(CHAT_COMPLETIONS_URL, {
    method: 'POST',
    signal: options.signal,
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok || !response.body) {
    let detail = '';
    try {
      detail = await response.text();
    } catch {
      /* 读不到就算了，状态码已经够用 */
    }
    throw new ChatHttpError(response.status, detail);
  }

  let text = '';
  let reasoning = '';
  let finishReason: string | null = null;
  // 按 index 聚合，不按 id —— 第一条之后的增量里 id 是空的。
  const calls = new Map<number, StreamedToolCall>();

  for await (const data of readSseData(response.body)) {
    let event: StreamChunk;
    try {
      event = JSON.parse(data) as StreamChunk;
    } catch {
      // 坏帧跳过，不让一帧垃圾毁掉整轮。
      console.warn('[chat] 跳过无法解析的 SSE 帧');
      continue;
    }
    // 最后一帧的 choices 是空数组（只带 usage），不是内容帧。
    const choice = event.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta ?? {};

    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      reasoning += delta.reasoning_content;
      options.onReasoning?.(delta.reasoning_content);
    }
    if (typeof delta.content === 'string' && delta.content) {
      text += delta.content;
      options.onContent?.(delta.content);
    }
    for (const raw of delta.tool_calls ?? []) {
      const index = raw.index ?? 0;
      const call = calls.get(index) ?? { id: '', name: '', args: '' };
      // 只在非空时覆盖。见函数头注释。
      if (raw.id) call.id = raw.id;
      if (raw.function?.name) call.name = raw.function.name;
      if (raw.function?.arguments) call.args += raw.function.arguments;
      calls.set(index, call);
    }
  }

  return { text, reasoning, toolCalls: [...calls.values()], finishReason };
}

type StreamChunk = {
  choices?: {
    index?: number;
    finish_reason?: string | null;
    delta?: {
      content?: unknown;
      reasoning_content?: unknown;
      tool_calls?: {
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
  }[];
};
