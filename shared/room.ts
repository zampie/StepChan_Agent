import { z } from 'zod';
export const targets = ['center', 'lamp', 'plant', 'cards', 'timer'] as const;
export const touchParts = ['head', 'cheek', 'badge', 'hand'] as const;
export type TouchPart = (typeof touchParts)[number];
export const touchLabels: Record<TouchPart, string> = {
  head: '轻点头顶',
  cheek: '轻点脸颊',
  badge: '看看徽章',
  hand: '碰一下手',
};
export const roomActionSchema = z.discriminatedUnion('name', [
  z
    .object({
      name: z.literal('set_light'),
      on: z.boolean(),
      brightness: z.number().int().min(10).max(100),
      warm: z.boolean(),
    })
    .strict(),
  z.object({ name: z.literal('water_plant') }).strict(),
  z.object({ name: z.literal('draw_discovery_card') }).strict(),
  z.object({ name: z.literal('reveal_card'), cardId: z.string().max(50) }).strict(),
  z
    .object({
      name: z.literal('answer_card'),
      cardId: z.string().max(50),
      answerIndex: z.number().int().min(0).max(2),
    })
    .strict(),
  z
    .object({ name: z.literal('start_timer'), seconds: z.number().int().min(10).max(1800) })
    .strict(),
  z.object({ name: z.literal('cancel_timer') }).strict(),
  z.object({ name: z.literal('move_to'), target: z.enum(targets) }).strict(),
]);
export type RoomAction = z.infer<typeof roomActionSchema>;
export const interactionInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string().trim().min(1).max(4000) }).strict(),
  z.object({ kind: z.literal('action'), action: roomActionSchema }).strict(),
  z.object({ kind: z.literal('touch'), part: z.enum(touchParts) }).strict(),
  z.object({ kind: z.literal('autonomy') }).strict(),
  z.object({ kind: z.literal('timer_finished'), timerId: z.string().uuid() }).strict(),
]);
export type InteractionInput = z.infer<typeof interactionInputSchema>;
export const sceneSchema = z.object({
  revision: z.number().int().nonnegative(),
  light: z.object({ on: z.boolean(), brightness: z.number(), warm: z.boolean() }),
  plant: z.object({ moisture: z.number(), waterCount: z.number().int() }),
  card: z
    .object({
      id: z.string(),
      question: z.string(),
      options: z.array(z.string()),
      revealed: z.boolean(),
      answerIndex: z.number().optional(),
      explanation: z.string().optional(),
    })
    .nullable(),
  timer: z.object({
    id: z.string(),
    status: z.enum(['idle', 'running', 'completed']),
    endsAt: z.number(),
    seconds: z.number(),
  }),
  petTarget: z.enum(targets),
  petMoveRevision: z.number().int().min(0),
  lastAction: z.string(),
});
export type Scene = z.infer<typeof sceneSchema>;
export const createScene = (): Scene => ({
  revision: 0,
  light: { on: true, brightness: 65, warm: false },
  plant: { moisture: 28, waterCount: 0 },
  card: null,
  timer: { id: '', status: 'idle', endsAt: 0, seconds: 0 },
  petTarget: 'center',
  petMoveRevision: 0,
  lastAction: '小房间准备好了',
});
export const suggestionSchema = z.object({
  label: z.string().max(30),
  input: interactionInputSchema,
});
export type Suggestion = z.infer<typeof suggestionSchema>;
export function suggestionsFor(scene: Scene, page = 0): Suggestion[] {
  if (scene.card && !scene.card.revealed)
    return [
      ...scene.card.options.map((label, answerIndex) => ({
        label,
        input: {
          kind: 'action' as const,
          action: { name: 'answer_card' as const, cardId: scene.card!.id, answerIndex },
        },
      })),
      {
        label: '告诉我答案',
        input: { kind: 'action', action: { name: 'reveal_card', cardId: scene.card.id } },
      },
    ];
  if (page % 2)
    return [
      { label: '现在几点了？', input: { kind: 'text', text: '现在几点了？' } },
      { label: '今天有一点累', input: { kind: 'text', text: '今天有一点累' } },
      { label: '你在做什么？', input: { kind: 'text', text: '你现在在做什么？请看一下房间。' } },
    ];
  return [
    {
      label: scene.card ? '再抽一张' : '来张发现卡',
      input: { kind: 'action', action: { name: 'draw_discovery_card' } },
    },
    scene.plant.moisture < 65
      ? { label: '一起浇水', input: { kind: 'action', action: { name: 'water_plant' } } }
      : {
          label: scene.light.on ? '关灯看星星' : '把灯打开',
          input: {
            kind: 'action',
            action: { name: 'set_light', on: !scene.light.on, brightness: 65, warm: false },
          },
        },
    scene.timer.status === 'running'
      ? { label: '取消倒计时', input: { kind: 'action', action: { name: 'cancel_timer' } } }
      : {
          label: '休息一分钟',
          input: { kind: 'action', action: { name: 'start_timer', seconds: 60 } },
        },
  ];
}
export function inputLabel(input: InteractionInput): string {
  if (input.kind === 'text') return input.text;
  if (input.kind === 'touch') return touchLabels[input.part];
  if (input.kind === 'autonomy') return 'Step酱开始自主探索';
  if (input.kind === 'timer_finished') return '倒计时结束';
  const a = input.action;
  switch (a.name) {
    case 'set_light':
      return a.on ? `调整台灯 · ${a.brightness}%${a.warm ? ' 暖光' : ''}` : '关掉台灯';
    case 'water_plant':
      return '给盆栽浇水';
    case 'draw_discovery_card':
      return '抽一张发现卡';
    case 'reveal_card':
      return '揭晓卡片答案';
    case 'answer_card':
      return `我选第 ${a.answerIndex + 1} 个答案`;
    case 'start_timer':
      return `休息 ${a.seconds} 秒`;
    case 'cancel_timer':
      return '取消倒计时';
    case 'move_to':
      return `走到 ${a.target} 旁边`;
  }
}
