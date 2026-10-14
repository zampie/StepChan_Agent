// 大脑契约：人设、工具、以及大脑发给 UI/渲染器的事件。
//
// 「房间」已删除。工具面向真实桌面，不再操作虚构的台灯盆栽。
// 涉及隐私的工具（看屏幕、读剪贴板、看前台应用）在设置里默认关闭，
// 关闭时工具会返回明确的拒绝消息，而不是静默失败 —— 她需要知道自己被限制了，
// 这样才能说「我现在看不到你的屏幕，你要先在菜单里打开」。
import { z } from 'zod';
import { expressions, actions, fxNames, spots } from './pet';
import type { ToolDefinition } from './realtime';

export const toolNames = [
  'express',
  'glance_screen',
  'get_system_status',
  'get_time',
  'set_timer',
  'read_clipboard',
  'open_url',
  'move_to',
] as const;
export type ToolName = (typeof toolNames)[number];

// 工具参数的运行时校验。模型给的参数一律不可信。
export const toolArgSchemas = {
  express: z
    .object({
      expression: z.enum(expressions).optional(),
      action: z.enum(actions).optional(),
      fx: z.enum(fxNames).optional(),
    })
    .strict(),
  glance_screen: z.object({ reason: z.string().max(200) }).strict(),
  get_system_status: z.object({}).strict(),
  get_time: z.object({ timezone: z.string().max(100).optional() }).strict(),
  set_timer: z
    .object({
      seconds: z.number().int().min(10).max(7200),
      label: z.string().min(1).max(60),
    })
    .strict(),
  read_clipboard: z.object({}).strict(),
  open_url: z.object({ url: z.string().max(2048) }).strict(),
  move_to: z.object({ spot: z.enum(spots) }).strict(),
} as const satisfies Record<ToolName, z.ZodType>;

// 注意嵌套格式 —— 扁平格式会被 realtime 拒绝（见 shared/realtime.ts 开头）。
export const toolDefinitions: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'express',
      description:
        '改变你自己的表情、动作或冒出的小特效。想让用户看到你的情绪时就调用，不要只用文字描述表情。',
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string', enum: [...expressions] },
          action: { type: 'string', enum: [...actions] },
          fx: { type: 'string', enum: [...fxNames] },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glance_screen',
      description:
        '看一眼用户当前的屏幕并得到画面描述。用户问「我在干什么」「看看这个」「这段代码有问题吗」时调用。用户未开启屏幕感知时会被拒绝。',
      parameters: {
        type: 'object',
        properties: { reason: { type: 'string', description: '你为什么要看，会展示给用户' } },
        required: ['reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_system_status',
      description: '查询电量、本地时间、系统版本，以及（若已开启）当前前台应用。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_time',
      description: '查询真实当前时间。省略时区则用用户本地时区。',
      parameters: { type: 'object', properties: { timezone: { type: 'string' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_timer',
      description: '设一个真实的系统通知倒计时，时间到会弹出 macOS 通知并提醒用户。',
      parameters: {
        type: 'object',
        properties: {
          seconds: { type: 'integer', description: '10 到 7200 秒' },
          label: { type: 'string', description: '提醒内容' },
        },
        required: ['seconds', 'label'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_clipboard',
      description: '读一次用户的剪贴板文字。用户未开启剪贴板权限时会被拒绝。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_url',
      description: '准备一个 HTTPS 链接卡片。你不会打开或读取网页，必须由用户点击。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'move_to',
      description: '把自己挪到屏幕的某个位置。用户说「让开」「去角落」或你想换个地方待着时调用。',
      parameters: {
        type: 'object',
        properties: { spot: { type: 'string', enum: [...spots] } },
        required: ['spot'],
      },
    },
  },
];

export const toolResultSchema = z
  .object({
    ok: z.boolean(),
    // 回灌给模型的文字。失败时必须说清为什么，让她能向用户解释。
    message: z.string(),
    // open_url 的链接卡片。
    url: z.string().optional(),
    // glance_screen 的画面描述。
    description: z.string().optional(),
  })
  .strict();
export type ToolResult = z.infer<typeof toolResultSchema>;

// 大脑 → UI 的事件。UI 不直接读 realtime 事件。
export type PetEvent =
  | { type: 'connection'; state: 'connecting' | 'open' | 'closed' | 'reconnecting'; detail?: string }
  | { type: 'activity'; value: 'idle' | 'listening' | 'thinking' | 'speaking' }
  // 用户说话的实时字幕。
  | { type: 'user_transcript'; text: string; final: boolean }
  // 她说话的实时字幕。
  | { type: 'pet_transcript'; text: string; final: boolean }
  | { type: 'thinking'; text: string }
  | { type: 'tool_start'; name: ToolName; args: unknown }
  | { type: 'tool_end'; name: ToolName; result: ToolResult }
  // 隐私动作的可见提示：看屏幕/读剪贴板时必须冒出来。
  | { type: 'privacy_notice'; action: 'screen' | 'clipboard' | 'frontmost'; reason: string }
  | { type: 'link'; url: string }
  // 需要告诉用户、但**不是错误**的提示（例如「聪明优先模式现在只支持打字」）。
  // 和 error 分开是因为 UI 会给 error 配告警样式，把正常的能力说明显示成红色报错
  // 会让用户以为出故障了。
  | { type: 'notice'; message: string }
  | { type: 'error'; message: string };
