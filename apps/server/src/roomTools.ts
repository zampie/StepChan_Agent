import { roomActionSchema, type Scene, type RoomAction } from '../../../shared/room';
import type { ToolResult } from '../../../shared/protocol';
const cards = [
  {
    question: '哪颗行星自转一圈，比绕太阳一圈还久？',
    options: ['金星', '火星', '木星'],
    answerIndex: 0,
    explanation: '金星自转约 243 个地球日，公转约 225 个地球日。这里比较的是自转周期与公转周期。',
  },
  {
    question: '章鱼有几颗心脏？',
    options: ['一颗', '两颗', '三颗'],
    answerIndex: 2,
    explanation: '章鱼有三颗心脏：两颗将血液送向鳃，另一颗把血液送向全身。',
  },
  {
    question: '太阳光到达地球大约需要多久？',
    options: ['8 分钟', '8 秒', '8 小时'],
    answerIndex: 0,
    explanation: '平均约 8 分 20 秒，距离变化时也会略有变化。',
  },
  {
    question: '下面哪一种动物属于哺乳动物？',
    options: ['企鹅', '海豚', '鲨鱼'],
    answerIndex: 1,
    explanation: '海豚属于哺乳动物，用肺呼吸，需要浮到水面换气。',
  },
];
export const roomToolDefinitions = [
  {
    name: 'observe_scene',
    description: '读取小房间当前状态。不得声称看到其他窗口。',
    properties: {},
  },
  {
    name: 'set_light',
    description: '改变台灯与房间照明。用于用户希望亮一点、暗一点、休息或看星星。',
    properties: {
      on: { type: 'boolean' },
      brightness: { type: 'integer', minimum: 10, maximum: 100 },
      warm: { type: 'boolean' },
    },
    required: ['on', 'brightness', 'warm'],
  },
  {
    name: 'water_plant',
    description: '给偏干的盆栽浇水。湿度已高时拒绝重复浇水。',
    properties: {},
  },
  {
    name: 'draw_discovery_card',
    description: '抽一张带选项的发现卡，适用于冷知识、猜谜、找话题。先让用户猜，不提前公布答案。',
    properties: {},
  },
  {
    name: 'reveal_card',
    description: '用户希望知道答案时揭晓当前卡片。',
    properties: { cardId: { type: 'string' } },
    required: ['cardId'],
  },
  {
    name: 'answer_card',
    description: '验证用户对当前卡片的答案，0/1/2 表示选项索引。',
    properties: {
      cardId: { type: 'string' },
      answerIndex: { type: 'integer', minimum: 0, maximum: 2 },
    },
    required: ['cardId', 'answerIndex'],
  },
  {
    name: 'start_timer',
    description: '启动页面内休息倒计时，10 到 1800 秒。不是离线系统提醒。',
    properties: { seconds: { type: 'integer', minimum: 10, maximum: 1800 } },
    required: ['seconds'],
  },
  { name: 'cancel_timer', description: '取消当前页面倒计时。', properties: {} },
  {
    name: 'move_to',
    description: '角色整体移动到房间指定物件附近，不代表手臂或步行动画。',
    properties: { target: { type: 'string', enum: ['center', 'lamp', 'plant', 'cards', 'timer'] } },
    required: ['target'],
  },
].map((t) => ({
  type: 'function',
  function: {
    name: t.name,
    description: t.description,
    parameters: {
      type: 'object',
      properties: t.properties,
      required: t.required ?? [],
      additionalProperties: false,
    },
  },
}));
export function refreshTimer(scene: Scene, now = Date.now()) {
  if (scene.timer.status === 'running' && scene.timer.endsAt <= now) {
    scene.timer.status = 'completed';
    scene.lastAction = '倒计时完成，可以继续或休息';
    scene.revision++;
    return true;
  }
  return false;
}
export function applyRoomTool(
  scene: Scene,
  name: string,
  args: unknown,
  now = Date.now(),
): ToolResult | null {
  if (name === 'observe_scene') {
    if (!args || typeof args !== 'object' || Object.keys(args).length)
      return { ok: false, message: '观察房间不需要参数。' };
    refreshTimer(scene, now);
    return { ok: true, message: JSON.stringify(scene), revision: scene.revision };
  }
  if (!roomToolDefinitions.some((t) => t.function.name === name)) return null;
  const data = typeof args === 'object' && args !== null ? { ...args, name } : null;
  const parsed = roomActionSchema.safeParse(data);
  if (!parsed.success) return { ok: false, message: '物件操作参数无效。' };
  const a: RoomAction = parsed.data;
  let message = '';
  switch (a.name) {
    case 'set_light':
      scene.light = { on: a.on, brightness: a.brightness, warm: a.warm };
      message = a.on
        ? `台灯已调整为 ${a.brightness}% ${a.warm ? '暖光' : '自然光'}`
        : '台灯已关闭，星光亮起来了';
      break;
    case 'water_plant':
      if (scene.plant.moisture >= 65)
        return { ok: false, message: '土壤已经湿润，不需要再浇水。', revision: scene.revision };
      scene.plant.moisture = Math.min(100, scene.plant.moisture + 45);
      scene.plant.waterCount++;
      message = `盆栽已浇水，湿度 ${scene.plant.moisture}%`;
      break;
    case 'draw_discovery_card': {
      const index = scene.card ? (Number(scene.card.id.split('-')[1]) + 1) % cards.length : 0;
      const card = cards[index];
      scene.card = {
        id: `card-${index}-${scene.revision}`,
        question: card.question,
        options: [...card.options],
        revealed: false,
      };
      message = `抽到了发现卡：${card.question} 选项：${card.options.join(' / ')}。邀请用户猜猜看。`;
      break;
    }
    case 'answer_card':
    case 'reveal_card': {
      if (!scene.card || scene.card.id !== a.cardId)
        return { ok: false, message: '这张卡片已被换掉，请使用当前卡片。' };
      const card = cards[Number(scene.card.id.split('-')[1])];
      scene.card.revealed = true;
      scene.card.answerIndex = card.answerIndex;
      scene.card.explanation = card.explanation;
      message =
        (a.name === 'answer_card'
          ? a.answerIndex === card.answerIndex
            ? '答对了！'
            : '这次还没猜中。'
          : '答案揭晓：') + card.explanation;
      break;
    }
    case 'start_timer':
      refreshTimer(scene, now);
      if (scene.timer.status === 'running')
        return { ok: false, message: '已有倒计时在运行，请先取消它。' };
      scene.timer = {
        id: crypto.randomUUID(),
        status: 'running',
        endsAt: now + a.seconds * 1000,
        seconds: a.seconds,
      };
      message = `已开始 ${a.seconds} 秒页面倒计时`;
      break;
    case 'cancel_timer':
      scene.timer = { id: '', status: 'idle', endsAt: 0, seconds: 0 };
      message = '倒计时已取消';
      break;
    case 'move_to':
      scene.petTarget = a.target;
      scene.petMoveRevision = scene.revision + 1;
      message = `Step酱已前往 ${a.target}`;
      break;
  }
  scene.revision++;
  scene.lastAction = message;
  return { ok: true, message, revision: scene.revision };
}
