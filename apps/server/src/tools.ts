import { z } from 'zod';
import { safeUrl, type ToolResult } from '../../../shared/protocol';
import { createScene, type Scene } from '../../../shared/room';
import { applyRoomTool, roomToolDefinitions } from './roomTools';
export const toolDefinitions = [
  ...roomToolDefinitions,
  {
    type: 'function',
    function: {
      name: 'get_time',
      description: '查询 IANA 时区的真实当前时间。省略则使用用户时区。',
      parameters: {
        type: 'object',
        properties: { timezone: { type: 'string' } },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_url',
      description: '应用户请求准备 HTTPS 链接卡片。不会打开、下载或读取网页，用户必须自己点击。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
        additionalProperties: false,
      },
    },
  },
];
export function validTimezone(value: string) {
  try {
    new Intl.DateTimeFormat('zh-CN', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}
export class ToolRunner {
  private results = new Map<string, ToolResult>();
  private count = 0;
  constructor(
    private timezone = 'UTC',
    private scene: Scene = createScene(),
  ) {}
  run(id: string, name: string, args: unknown): ToolResult {
    const cached = this.results.get(id);
    if (cached) return cached;
    if (++this.count > 4) return { ok: false, message: '本轮工具调用已达 4 次上限。' };
    let result: ToolResult;
    const roomResult = applyRoomTool(this.scene, name, args);
    if (roomResult) result = roomResult;
    else if (name === 'get_time') {
      const parsed = z
        .object({ timezone: z.string().max(100).optional() })
        .strict()
        .safeParse(args);
      const zone = parsed.success ? (parsed.data.timezone ?? this.timezone) : '';
      if (!parsed.success || !validTimezone(zone))
        result = { ok: false, message: '时区无效，请使用 Asia/Shanghai 等 IANA 时区。' };
      else {
        const now = new Date();
        result = {
          ok: true,
          timezone: zone,
          iso: now.toISOString(),
          message: `${new Intl.DateTimeFormat('zh-CN', { timeZone: zone, dateStyle: 'full', timeStyle: 'medium', hour12: false }).format(now)}（${zone}）`,
        };
      }
    } else if (name === 'open_url') {
      const parsed = z
        .object({ url: z.string().max(2048) })
        .strict()
        .safeParse(args);
      const url = parsed.success ? safeUrl(parsed.data.url) : null;
      result = url
        ? { ok: true, url, message: '链接已准备好，请点击“打开网页”。尚未打开或读取网页。' }
        : { ok: false, message: '仅接受不含账号密码的有效 HTTPS 链接。' };
    } else result = { ok: false, message: '不支持这个工具。' };
    this.results.set(id, result);
    return result;
  }
}
