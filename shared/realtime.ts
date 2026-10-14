// StepFun Realtime（stepaudio-3-realtime-preview）协议契约。
//
// 这里的事件形状来自规划期对 wss://api.stepfun.com/v1/realtime 的真实抓包，
// 不是照抄 OpenAI Realtime 的猜测。与文档不一致的地方以抓包为准，并在注释里标出。
//
// 实测要点：
// - 鉴权：webview 设不了 Authorization 头，必须用 subprotocol：
//     new WebSocket(url, ['realtime', `openai-insecure-api-key.${key}`])
//   query param 形式（?authorization= / ?api_key=）会被拒。
// - 工具必须用嵌套老格式 {type:'function', function:{...}}；扁平格式报
//   "session.tools[0].function.name is required"。
// - 单会话最长 30 分钟（文档）。
// - 模型首次出音后 voice 不可改 → 换音色必须重建会话。
import { z } from 'zod';

export const REALTIME_URL = 'wss://api.stepfun.com/v1/realtime';
export const REALTIME_MODEL = 'stepaudio-3-realtime-preview';
export const REALTIME_SESSION_LIMIT_MS = 30 * 60 * 1000;
// 输入输出都是 pcm16。采样率未在文档中写明，由启动自检实测确定后写入此处。
export const REALTIME_SAMPLE_RATE = 24000;

export function realtimeSubprotocols(apiKey: string): string[] {
  return ['realtime', `openai-insecure-api-key.${apiKey}`];
}

export function realtimeUrl(model = REALTIME_MODEL): string {
  return `${REALTIME_URL}?model=${encodeURIComponent(model)}`;
}

// ---- 工具定义（嵌套格式，别改成扁平） ----
export const toolDefinitionSchema = z
  .object({
    type: z.literal('function'),
    function: z
      .object({
        name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
        description: z.string().min(1),
        parameters: z.object({
          type: z.literal('object'),
          properties: z.record(z.string(), z.unknown()),
          required: z.array(z.string()).optional(),
        }),
      })
      .strict(),
  })
  .strict();
export type ToolDefinition = z.infer<typeof toolDefinitionSchema>;

// ---- 客户端事件 ----
export type SessionConfig = {
  modalities?: ('text' | 'audio')[];
  instructions?: string;
  voice?: string;
  input_audio_format?: 'pcm16';
  output_audio_format?: 'pcm16';
  turn_detection?: {
    type: 'server_vad';
    prefix_padding_ms?: number;
    silence_duration_ms?: number;
    energy_awakeness_threshold?: number;
  } | null;
  input_audio_transcription?: { model: string; language?: string; hotwords?: string[] };
  tools?: ToolDefinition[];
  tool_choice?: 'auto' | 'none' | 'required';
};

export type ClientEvent =
  | { type: 'session.update'; session: SessionConfig }
  | { type: 'input_audio_buffer.append'; audio: string }
  | { type: 'input_audio_buffer.commit' }
  | { type: 'input_audio_buffer.clear' }
  | {
      type: 'conversation.item.create';
      previous_item_id?: string;
      item:
        | { type: 'message'; role: 'user' | 'assistant' | 'system'; content: ItemContent[] }
        | { type: 'function_call_output'; call_id: string; output: string };
    }
  | { type: 'conversation.item.delete'; item_id: string }
  | { type: 'response.create'; response?: { modalities?: ('text' | 'audio')[] } }
  | { type: 'response.cancel' };

export type ItemContent =
  | { type: 'input_text'; text: string }
  | { type: 'input_audio'; audio: string };

// ---- 服务端事件 ----
// 热路径（音频增量）在 parseServerEvent 里走快速通道，不进 zod。
const withId = { event_id: z.string().optional() };

const sessionSchema = z
  .object({
    id: z.string().optional(),
    model: z.string().optional(),
    modalities: z.array(z.string()).optional(),
    instructions: z.string().optional(),
    voice: z.string().optional(),
    input_audio_format: z.string().optional(),
    output_audio_format: z.string().optional(),
  })
  .loose();

const itemSchema = z
  .object({
    id: z.string().optional(),
    type: z.string().optional(),
    role: z.string().optional(),
    status: z.string().optional(),
    name: z.string().optional(),
    call_id: z.string().optional(),
    arguments: z.string().optional(),
    content: z
      .array(z.object({ type: z.string().optional(), transcript: z.string().optional() }).loose())
      .optional(),
  })
  .loose();

const usageSchema = z
  .object({
    total_tokens: z.number().optional(),
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
  })
  .loose();

export const serverEventSchema = z.discriminatedUnion('type', [
  z.object({ ...withId, type: z.literal('session.created'), session: sessionSchema }),
  z.object({ ...withId, type: z.literal('session.updated'), session: sessionSchema }),
  z.object({
    ...withId,
    type: z.literal('error'),
    error: z
      .object({
        type: z.string().optional(),
        code: z.union([z.string(), z.number()]).optional(),
        message: z.string().optional(),
        event_id: z.string().optional(),
      })
      .loose(),
  }),
  // VAD：打断信号就靠 speech_started。
  z.object({
    ...withId,
    type: z.literal('input_audio_buffer.speech_started'),
    audio_start_ms: z.number().optional(),
    item_id: z.string().optional(),
  }),
  z.object({
    ...withId,
    type: z.literal('input_audio_buffer.speech_stopped'),
    audio_end_ms: z.number().optional(),
    item_id: z.string().optional(),
  }),
  z.object({
    ...withId,
    type: z.literal('input_audio_buffer.committed'),
    item_id: z.string().optional(),
    previous_item_id: z.string().optional(),
  }),
  z.object({ ...withId, type: z.literal('input_audio_buffer.cleared') }),
  z.object({
    ...withId,
    type: z.literal('conversation.item.created'),
    item: itemSchema,
    previous_item_id: z.string().optional(),
  }),
  z.object({ ...withId, type: z.literal('conversation.item.deleted'), item_id: z.string().optional() }),
  // 用户说话的实时字幕。
  z.object({
    ...withId,
    type: z.literal('conversation.item.input_audio_transcription.delta'),
    item_id: z.string().optional(),
    delta: z.string().optional(),
  }),
  z.object({
    ...withId,
    type: z.literal('conversation.item.input_audio_transcription.completed'),
    item_id: z.string().optional(),
    transcript: z.string().optional(),
  }),
  z.object({ ...withId, type: z.literal('response.created'), response: z.looseObject({}) }),
  z.object({
    ...withId,
    type: z.literal('response.output_item.added'),
    item: itemSchema,
    output_index: z.number().optional(),
  }),
  z.object({
    ...withId,
    type: z.literal('response.output_item.done'),
    item: itemSchema,
    output_index: z.number().optional(),
  }),
  z.object({ ...withId, type: z.literal('response.content_part.added') }).loose(),
  z.object({ ...withId, type: z.literal('response.content_part.done') }).loose(),
  // 她说的话的字幕流。
  z.object({
    ...withId,
    type: z.literal('response.audio_transcript.delta'),
    delta: z.string().optional(),
    item_id: z.string().optional(),
  }),
  z.object({
    ...withId,
    type: z.literal('response.audio_transcript.done'),
    transcript: z.string().optional(),
    item_id: z.string().optional(),
  }),
  z.object({ ...withId, type: z.literal('response.audio.done'), item_id: z.string().optional() }),
  z.object({ ...withId, type: z.literal('response.text.delta'), delta: z.string().optional() }),
  z.object({ ...withId, type: z.literal('response.text.done'), text: z.string().optional() }),
  // 边想边说：可驱动「思考」表情。
  z.object({ ...withId, type: z.literal('response.thinking.delta'), delta: z.string().optional() }),
  z.object({ ...withId, type: z.literal('response.thinking.done'), thinking: z.string().optional() }),
  z.object({
    ...withId,
    type: z.literal('response.function_call_arguments.delta'),
    call_id: z.string().optional(),
    name: z.string().optional(),
    delta: z.string().optional(),
  }),
  z.object({
    ...withId,
    type: z.literal('response.function_call_arguments.done'),
    call_id: z.string(),
    name: z.string(),
    arguments: z.string(),
  }),
  z.object({
    ...withId,
    type: z.literal('response.done'),
    response: z
      .object({
        id: z.string().optional(),
        status: z.string().optional(),
        output: z.array(itemSchema).optional(),
        usage: usageSchema.optional(),
      })
      .loose(),
  }),
  z.object({ ...withId, type: z.literal('response.cancelled') }).loose(),
  z.object({ ...withId, type: z.literal('rate_limits.updated') }).loose(),
]);
export type KnownServerEvent = z.infer<typeof serverEventSchema>;

// 音频增量单独建模：一次短回复有 ~28 条，不值得过 zod。
export type AudioDeltaEvent = { type: 'response.audio.delta'; delta: string; item_id?: string };
// 没见过的事件不能让连接崩掉 —— 服务端随时可能加事件。
export type UnknownServerEvent = { type: 'unknown'; raw: unknown; rawType: string };
export type ServerEvent = KnownServerEvent | AudioDeltaEvent | UnknownServerEvent;

/** 解析服务端事件，永不抛错。未知类型降级为 'unknown' 而不是中断会话。 */
export function parseServerEvent(raw: string): ServerEvent {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { type: 'unknown', raw, rawType: 'invalid_json' };
  }
  const type = (json as { type?: unknown })?.type;
  if (typeof type !== 'string') return { type: 'unknown', raw: json, rawType: 'missing_type' };
  // 热路径：直接取 delta，不做结构校验。
  if (type === 'response.audio.delta' || type === 'response.output_audio.delta') {
    const delta = (json as { delta?: unknown }).delta;
    return {
      type: 'response.audio.delta',
      delta: typeof delta === 'string' ? delta : '',
      item_id: (json as { item_id?: string }).item_id,
    };
  }
  const parsed = serverEventSchema.safeParse(json);
  return parsed.success ? parsed.data : { type: 'unknown', raw: json, rawType: type };
}
