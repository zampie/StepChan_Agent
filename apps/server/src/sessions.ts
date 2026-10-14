import { createScene, type Scene, type InteractionInput, inputLabel } from '../../../shared/room';
import type { ProviderMessage } from './providers';
export type Run = {
  id: string;
  controller: AbortController;
  messages: ProviderMessage[];
  text: string;
  draft: string;
  segments: { message: ProviderMessage; offset: number }[];
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  input: InteractionInput;
};
export class Session {
  readonly id = crypto.randomUUID();
  scene: Scene = createScene();
  updatedAt = Date.now();
  turns: ProviderMessage[][] = [];
  active: Run | null = null;
  recent = new Map<string, Run>();
  autonomyTimes: number[] = [];
  goal = '等你一起探索';
  touches: Partial<Record<string, number>> = {};
  begin(id: string, input: InteractionInput) {
    if (this.recent.has(id)) throw Error('重复请求，请勿重复发送。');
    if (this.active) this.finish(this.active, 'cancelled');
    this.updatedAt = Date.now();
    const content =
      input.kind === 'text'
        ? input.text
        : `【${input.kind === 'autonomy' ? '自主调度事件' : input.kind === 'timer_finished' ? '环境事件' : '用户交互事件'}】${inputLabel(input)}。这不是用户键入的原话。`;
    const messages: ProviderMessage[] = [
      {
        role: input.kind === 'autonomy' || input.kind === 'timer_finished' ? 'system' : 'user',
        content,
      },
    ];
    if (input.kind === 'touch') {
      this.touches[input.part] = (this.touches[input.part] ?? 0) + 1;
      messages.push({
        role: 'system',
        content: `本次会话该部位被轻点 ${this.touches[input.part]} 次。自然回应，不制造内疚。`,
      });
    }
    const run: Run = {
      id,
      controller: new AbortController(),
      messages,
      text: '',
      draft: '',
      segments: [],
      status: 'running',
      input,
    };
    this.turns.push(messages);
    this.active = run;
    this.recent.set(id, run);
    while (this.recent.size > 12) this.recent.delete(this.recent.keys().next().value!);
    while (
      this.turns.length > 1 &&
      (this.turns.length > 16 || JSON.stringify(this.turns).length > 30000)
    )
      this.turns.shift();
    return run;
  }
  isCurrent(run: Run) {
    return this.active === run && run.status === 'running' && !run.controller.signal.aborted;
  }
  append(run: Run, delta: string) {
    if (!this.isCurrent(run)) return;
    run.text += delta;
    run.draft += delta;
  }
  commit(run: Run, toolCalls?: ProviderMessage['tool_calls']) {
    if (!this.isCurrent(run)) return;
    if (run.draft || toolCalls?.length) {
      const message: ProviderMessage = {
        role: 'assistant',
        content: run.draft || null,
        ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
      };
      run.segments.push({ message, offset: run.text.length - run.draft.length });
      run.messages.push(message);
      run.draft = '';
    }
  }
  finish(run: Run, status: 'completed' | 'cancelled' | 'failed', visibleChars?: number) {
    if (run.status === 'running') {
      this.commit(run);
      run.status = status;
      if (status !== 'completed')
        run.messages.push({
          role: 'system',
          content: `【运行记录】上一段回复${status === 'cancelled' ? '被打断' : '未完成'}。已执行的工具结果和房间状态仍有效，不要重复执行已完成的动作。`,
        });
      if (this.active === run) this.active = null;
      run.controller.abort();
      this.updatedAt = Date.now();
      this.goal =
        status === 'completed'
          ? '这一步完成了，接下来由你决定'
          : status === 'cancelled'
            ? '停下来，听你说'
            : '先停一下，可以重试';
    }
    if (visibleChars !== undefined) {
      for (const segment of run.segments) {
        if (segment.message.content)
          segment.message.content = segment.message.content.slice(
            0,
            Math.max(0, visibleChars - segment.offset),
          );
      }
    }
  }
  interrupt(id: string, visibleChars?: number) {
    const run = this.recent.get(id);
    if (!run) return;
    // The server may finish before buffered text reaches the browser.
    if (
      run.status === 'completed' &&
      visibleChars !== undefined &&
      visibleChars < run.text.length
    ) {
      run.status = 'cancelled';
      run.messages.push({
        role: 'system',
        content:
          '【运行记录】用户在接收完文字前打断了回复。仅保留其已收到的文字，已执行的工具仍有效，不要重复执行。',
      });
    }
    this.finish(run, 'cancelled', visibleChars);
  }
  context() {
    return this.turns.flat();
  }
}
export class SessionStore {
  private sessions = new Map<string, Session>();
  create() {
    this.sweep();
    if (this.sessions.size >= 64) throw Error('会话数量达到上限，请关闭闲置页面。');
    const session = new Session();
    this.sessions.set(session.id, session);
    return session;
  }
  get(id: string) {
    this.sweep();
    return this.sessions.get(id);
  }
  delete(id: string) {
    const s = this.sessions.get(id);
    if (s?.active) s.finish(s.active, 'cancelled');
    this.sessions.delete(id);
  }
  clear() {
    for (const id of this.sessions.keys()) this.delete(id);
  }
  private sweep() {
    for (const [id, s] of this.sessions) if (Date.now() - s.updatedAt > 3600000) this.delete(id);
  }
}
