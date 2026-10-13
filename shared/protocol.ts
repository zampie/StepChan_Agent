import { z } from 'zod';
export const expressions = [
  'neutral',
  'happy',
  'confused',
  'angry',
  'sleepy',
  'surprised',
] as const;
export const motions = ['idle', 'think', 'bounce', 'talk'] as const;
export type Expression = (typeof expressions)[number];
export type Motion = (typeof motions)[number];
export type Activity = 'idle' | 'listening' | 'thinking' | 'speaking';
export const presentationSchema = z
  .object({ expression: z.enum(expressions).optional(), motion: z.enum(motions).optional() })
  .strict();
export type Presentation = z.infer<typeof presentationSchema>;
export const messageSchema = z
  .object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(4000) })
  .strict();
export type Message = z.infer<typeof messageSchema>;
export const requestSchema = z
  .object({
    requestId: z.string().uuid(),
    mode: z.enum(['mock', 'live']),
    messages: z.array(messageSchema).min(1).max(20),
    timezone: z.string().max(100).optional(),
    scenario: z.enum(['normal', 'error', 'disconnect', 'slow']).optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.messages.reduce((n, m) => n + m.content.length, 0) > 16000)
      c.addIssue({ code: 'custom', message: '会话超过 16000 字，请清空后再试。' });
    if (v.messages.at(-1)?.role !== 'user')
      c.addIssue({ code: 'custom', message: '最后一条必须是用户消息。' });
  });
export type ChatRequest = z.infer<typeof requestSchema>;
export function safeUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && url.hostname
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export const toolResultSchema = z
  .object({
    ok: z.boolean(),
    message: z.string(),
    url: z.string().optional(),
    timezone: z.string().optional(),
    iso: z.string().optional(),
  })
  .strict();
export type ToolResult = z.infer<typeof toolResultSchema>;
const base = { requestId: z.string().uuid() };
export const eventSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('status'), activity: z.enum(['thinking', 'speaking']) }),
  z.object({ ...base, type: z.literal('text_delta'), delta: z.string() }),
  z.object({ ...base, type: z.literal('presentation'), ...presentationSchema.shape }).strict(),
  z.object({ ...base, type: z.literal('tool_start'), toolCallId: z.string(), name: z.string() }),
  z.object({
    ...base,
    type: z.literal('tool_end'),
    toolCallId: z.string(),
    name: z.string(),
    result: toolResultSchema,
  }),
  z.object({ ...base, type: z.literal('error'), message: z.string() }),
  z.object({
    ...base,
    type: z.literal('done'),
    status: z.enum(['completed', 'failed', 'cancelled']),
  }),
]);
export type ChatEvent = z.infer<typeof eventSchema>;
