// 工具执行器。模型 → 真实桌面能力的唯一出口。
//
// 三条贯穿全文的规则：
// 1. 隐私开关关着就明确拒绝，并告诉用户去开哪个开关 —— 不静默失败，
//    因为她必须能向用户解释自己为什么做不到（见 shared/brain.ts 开头）。
// 2. 每次隐私动作都发 privacy_notice 事件，让界面上冒出可见提示。
// 3. 截屏数据只在内存里转一圈，不落盘，不进 transcript。
import type { Credentials, Desktop, Settings } from '../../../../shared/desktop';
import type { PetEvent, ToolName, ToolResult } from '../../../../shared/brain';
import type { Spot, Expression, ActionName, FxName } from '../../../../shared/pet';
import { safeUrl } from './url';

export type ToolContext = {
  desktop: Desktop;
  /** 每次执行前取一次最新设置：用户可能刚在托盘里改过开关。 */
  getSettings: () => Promise<Settings>;
  getCredentials: () => Promise<Credentials>;
  emit: (event: PetEvent) => void;
};

/** 视觉模型请求的超时。截屏 + 推理不应该让她卡住超过这个时间。 */
const VISION_TIMEOUT_MS = 20_000;

function ok(message: string, extra: Partial<ToolResult> = {}): ToolResult {
  return { ok: true, message, ...extra };
}
function fail(message: string): ToolResult {
  return { ok: false, message };
}

export function createToolExecutor(context: ToolContext) {
  // set_timer 的去重：同一个 (label, seconds) 在生效期内重复调用不再排第二个通知。
  // 「survive being called twice」的含义是用户不该收到两条一样的提醒。
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  async function execute(name: ToolName, args: unknown): Promise<ToolResult> {
    switch (name) {
      case 'express':
        return expressTool(args as ExpressArgs);
      case 'glance_screen':
        return glanceScreen(args as { reason: string });
      case 'get_system_status':
        return getSystemStatus();
      case 'get_time':
        return getTime(args as { timezone?: string });
      case 'set_timer':
        return setTimer(args as { seconds: number; label: string });
      case 'read_clipboard':
        return readClipboard();
      case 'open_url':
        return openUrl(args as { url: string });
      case 'move_to':
        return moveTo(args as { spot: Spot });
    }
  }

  type ExpressArgs = {
    expression?: Expression;
    action?: ActionName;
    fx?: FxName;
  };

  // ---- express ----
  // 纯表现，没有系统副作用，立刻返回。
  function expressTool(args: ExpressArgs): ToolResult {
    if (!args.expression && !args.action && !args.fx) {
      return fail('express 至少要给 expression、action、fx 其中一个。');
    }
    // tool_start 事件已经带了 args，渲染器从那里拿表现意图。
    // 这里不再额外发事件，避免同一次表现被 UI 处理两遍。
    const described = [args.expression, args.action, args.fx].filter(Boolean).join(' + ');
    return ok(`已经做出来了（${described}）。用户看得到，不用再用文字描述一遍。`);
  }

  // ---- glance_screen ----
  async function glanceScreen(args: { reason: string }): Promise<ToolResult> {
    const settings = await context.getSettings();
    if (!settings.screenAwareness) {
      // 明确拒绝 + 可操作指引。这条消息会被她念给用户听。
      return fail(
        '屏幕感知是关着的，我看不到屏幕。告诉用户：到菜单栏的 Step酱 图标里打开「屏幕感知」就可以了。不要猜屏幕上有什么。',
      );
    }
    if (!context.desktop.available) {
      return fail('当前是调试环境，截屏能力不可用。如实告诉用户现在看不了。');
    }

    // 开关开着也要有可见提示 —— 这是隐私条款要求的，不是可选项。
    context.emit({ type: 'privacy_notice', action: 'screen', reason: args.reason });

    const capture = await context.desktop.captureScreen();
    if (capture.status === 'denied') {
      return fail(
        `系统没给录屏权限（${capture.message}）。告诉用户：打开「系统设置 → 隐私与安全性 → 屏幕录制」，勾上 Step酱，然后重启一次应用。`,
      );
    }
    if (capture.status === 'error') {
      return fail(`截屏失败：${capture.message}。如实告诉用户没看到。`);
    }

    let credentials: Credentials;
    try {
      credentials = await context.getCredentials();
    } catch {
      return fail('拿不到视觉模型的凭据，这次看不了屏幕。');
    }

    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), VISION_TIMEOUT_MS);
    try {
      const response = await fetch('https://api.stepfun.com/v1/chat/completions', {
        method: 'POST',
        signal: abort.signal,
        headers: {
          Authorization: `Bearer ${credentials.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: credentials.visionModel,
          max_tokens: 300,
          messages: [
            {
              role: 'system',
              content:
                '你在帮一个桌面宠物看它主人的屏幕。用两三句中文说清楚用户正在做什么：什么应用、什么内容、在忙还是在闲。只描述看得见的东西，看不清就说看不清。不要揣测用户的意图，不要念出任何密码、密钥、邮箱或身份证号之类的敏感信息。',
            },
            {
              role: 'user',
              content: [
                { type: 'text', text: `为什么要看：${args.reason}。请描述这张屏幕截图。` },
                {
                  type: 'image_url',
                  // 截图只在这一次请求里存在，不写磁盘、不入 transcript。
                  image_url: { url: `data:image/png;base64,${capture.png}` },
                },
              ],
            },
          ],
        }),
      });
      if (!response.ok) {
        return fail(`视觉模型返回 ${response.status}，这次没看清。如实告诉用户。`);
      }
      const data = (await response.json()) as {
        choices?: { message?: { content?: unknown } }[];
      };
      const raw = data.choices?.[0]?.message?.content;
      const description = typeof raw === 'string' ? raw.trim() : '';
      if (!description) return fail('视觉模型没给出描述，这次没看清。');
      return ok('看到了。下面是画面描述，用你自己的话简短说给用户听，不要照读。', {
        description: description.slice(0, 1200),
      });
    } catch (error) {
      if (abort.signal.aborted) return fail('看屏幕超时了，如实告诉用户这次没看到。');
      return fail(
        `看屏幕失败：${error instanceof Error ? error.message : '未知错误'}。如实告诉用户。`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  // ---- get_system_status ----
  async function getSystemStatus(): Promise<ToolResult> {
    const settings = await context.getSettings();
    const status = await context.desktop.systemStatus();
    if (!status) return fail('读不到系统状态，这次查不了。如实告诉用户。');

    const parts = [`本地时间 ${status.localTime}（${status.timezone}）`, `系统 ${status.os}`];
    if (status.battery) {
      const state =
        status.battery.state === 'charging'
          ? '正在充电'
          : status.battery.state === 'full'
            ? '已充满'
            : status.battery.state === 'discharging'
              ? '用电池'
              : status.battery.state;
      const remaining =
        status.battery.minutesRemaining != null
          ? `，大约还能用 ${status.battery.minutesRemaining} 分钟`
          : '';
      parts.push(`电量 ${Math.round(status.battery.percent)}%（${state}${remaining}）`);
    } else {
      parts.push('读不到电池信息（可能是台式机）');
    }

    if (settings.appAwareness) {
      context.emit({ type: 'privacy_notice', action: 'frontmost', reason: '查看当前前台应用' });
      const app = await context.desktop.frontmostApp();
      parts.push(app ? `当前在用 ${app.name}` : '读不到当前应用');
    } else {
      parts.push('应用感知是关着的，所以我不知道用户在用哪个 App —— 不要猜');
    }
    return ok(parts.join('；') + '。挑用户关心的那一两条说，不要全念出来。');
  }

  // ---- get_time ----
  async function getTime(args: { timezone?: string }): Promise<ToolResult> {
    const now = new Date();
    let timezone = args.timezone;
    if (!timezone) {
      const status = await context.desktop.systemStatus();
      timezone = status?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    }
    try {
      const text = new Intl.DateTimeFormat('zh-CN', {
        timeZone: timezone,
        dateStyle: 'full',
        timeStyle: 'short',
      }).format(now);
      return ok(`现在是 ${text}（${timezone}）。只说用户问的那部分，别把全部念出来。`);
    } catch {
      // 模型给了个不存在的时区 —— 退回本地，并说明。
      const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const text = new Intl.DateTimeFormat('zh-CN', {
        dateStyle: 'full',
        timeStyle: 'short',
      }).format(now);
      return ok(`「${timezone}」不是有效时区，用本地时间代替：${text}（${local}）。`);
    }
  }

  // ---- set_timer ----
  function setTimer(args: { seconds: number; label: string }): ToolResult {
    const key = `${args.seconds}|${args.label}`;
    if (timers.has(key)) {
      // 被调了两次：不排第二个通知，但如实回「已经设过了」而不是假装又设了一个。
      return ok(
        `这个提醒已经设过了（${args.label}，${describeDuration(args.seconds)}后），没有重复设置。告诉用户不用担心，不会响两次。`,
      );
    }
    const handle = setTimeout(() => {
      timers.delete(key);
      void context.desktop
        .notify('Step酱提醒你', args.label)
        .catch((error: unknown) => console.warn('[tools] 通知失败', error));
    }, args.seconds * 1000);
    timers.set(key, handle);
    return ok(
      `倒计时设好了：${describeDuration(args.seconds)}后弹通知提醒「${args.label}」。告诉用户你设了多久。`,
    );
  }

  // ---- read_clipboard ----
  async function readClipboard(): Promise<ToolResult> {
    const settings = await context.getSettings();
    // 剪贴板没有独立开关，跟着屏幕感知走 —— 两者都是「看用户正在处理的内容」。
    if (!settings.screenAwareness) {
      return fail(
        '剪贴板权限是关着的，我读不到。告诉用户：到菜单栏的 Step酱 图标里打开「屏幕感知」就可以了。不要猜剪贴板里有什么。',
      );
    }
    context.emit({ type: 'privacy_notice', action: 'clipboard', reason: '读取剪贴板文字' });
    const text = await context.desktop.readClipboardText();
    if (text == null) return fail('读不到剪贴板（可能是空的，或者里面不是文字）。');
    const trimmed = text.trim();
    if (!trimmed) return ok('剪贴板是空的。');
    return ok(
      `剪贴板里是：${trimmed.slice(0, 800)}${trimmed.length > 800 ? '…（后面还有，没全读）' : ''}。不要整段念出来，说重点。`,
    );
  }

  // ---- open_url ----
  async function openUrl(args: { url: string }): Promise<ToolResult> {
    const url = safeUrl(args.url);
    if (!url) {
      return fail(
        '这个链接不能用：只接受 https 开头、不带用户名密码的正常网址。换一个，或者直接把网址读给用户。',
      );
    }
    // 只发链接卡片，不代替用户点。她不会、也不该读网页内容。
    context.emit({ type: 'link', url });
    return ok(
      `链接卡片已经给用户了：${url}。告诉用户点一下就能打开 —— 你自己看不到网页里的内容，别假装看过。`,
      { url },
    );
  }

  // ---- move_to ----
  async function moveTo(args: { spot: Spot }): Promise<ToolResult> {
    if (!context.desktop.available) {
      return fail('调试环境里挪不动窗口。如实告诉用户。');
    }
    try {
      await context.desktop.moveToSpot(args.spot);
      return ok(`已经挪到 ${args.spot} 了。短短说一句就行。`);
    } catch (error) {
      return fail(`挪不过去：${error instanceof Error ? error.message : '未知错误'}。`);
    }
  }

  return {
    execute,
    /** 卸载时清掉未触发的倒计时，避免应用关了还弹通知。 */
    dispose(): void {
      for (const handle of timers.values()) clearTimeout(handle);
      timers.clear();
    },
    /** 测试用：当前排队中的倒计时数量。 */
    get pendingTimers(): number {
      return timers.size;
    },
  };
}

export type ToolExecutorHandle = ReturnType<typeof createToolExecutor>;

function describeDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}
