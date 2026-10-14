import { getProviderConfig } from './providerConfig';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { interactionSchema, type ChatEvent } from '../../../shared/protocol';
import { SessionStore } from './sessions';
import { runInteraction } from './interactionRuntime';
import { chatProvider, mockRoomProvider } from './providers';
import { validTimezone } from './tools';
import { refreshTimer } from './roomTools';
const interruptSchema = z
  .object({ requestId: z.string().uuid(), visibleChars: z.number().int().min(0).max(50000) })
  .strict();
export function registerInteractionRoutes(app: FastifyInstance) {
  const store = new SessionStore();
  let inFlight = 0;
  app.addHook('onClose', async () => store.clear());
  app.post('/api/sessions', async (_req, reply) => {
    try {
      const s = store.create();
      return reply.code(201).send({ sessionId: s.id, scene: s.scene });
    } catch {
      return reply.code(429).send({ message: '会话数量达到上限，请关闭闲置页面。' });
    }
  });
  app.delete<{ Params: { id: string } }>('/api/sessions/:id', async (req) => {
    store.delete(req.params.id);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/sessions/:id/interrupt', async (req, reply) => {
    const p = interruptSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ message: '中断参数无效。' });
    const s = store.get(req.params.id);
    if (!s) return reply.code(404).send({ message: '会话已失效。' });
    s.interrupt(p.data.requestId, p.data.visibleChars);
    return { ok: true, scene: s.scene };
  });
  app.post('/api/interact', async (req, reply) => {
    const parsed = interactionSchema.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ message: '交互参数无效，文字最多 4000 字。' });
    const request = parsed.data;
    const session = store.get(request.sessionId);
    if (!session)
      return reply.code(410).send({ message: '会话已过期或服务已重启，请点击清空重新开始。' });
    if (request.timezone && !validTimezone(request.timezone))
      return reply.code(400).send({ message: '时区无效。' });
    if (request.mode === 'live' && !getProviderConfig().key)
      return reply.code(503).send({ message: '尚未配置服务端模型密钥，请选择演示模式。' });
    if (session.recent.has(request.requestId))
      return reply.code(409).send({ message: '此请求已经处理，不能重复执行。' });
    if (request.input.kind === 'autonomy') {
      if (session.active) return reply.code(409).send({ message: '正在回应你，暂不自主行动。' });
      session.autonomyTimes = session.autonomyTimes.filter((t) => Date.now() - t < 60000);
      if (session.autonomyTimes.length >= 3)
        return reply.code(429).send({ message: '自主探索休息一下，稍后继续。' });
      session.autonomyTimes.push(Date.now());
    }
    if (request.input.kind === 'timer_finished') {
      if (
        session.scene.timer.id !== request.input.timerId ||
        session.scene.timer.status !== 'running' ||
        session.scene.timer.endsAt > Date.now()
      )
        return reply.code(409).send({ message: '这个倒计时尚未结束或已处理。' });
    }
    if (inFlight >= 6) return reply.code(429).send({ message: '当前请求较多，请稍后再试。' });
    if (request.interrupt)
      session.interrupt(request.interrupt.requestId, request.interrupt.visibleChars);
    refreshTimer(session.scene);
    const run = session.begin(request.requestId, request.input);
    inFlight++;
    let ended = false;
    const timeout = setTimeout(
      () => session.finish(run, 'failed'),
      Number(process.env.REQUEST_TIMEOUT_MS) || 60000,
    );
    const close = () => {
      if (!ended) session.finish(run, 'cancelled');
    };
    reply.raw.on('close', close);
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    });
    const emit = (event: ChatEvent) => {
      if (!reply.raw.destroyed && !ended)
        reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const heartbeat = setInterval(() => {
      if (!reply.raw.destroyed) reply.raw.write(': heartbeat\n\n');
    }, 10000);
    try {
      const provider =
        request.mode === 'mock'
          ? mockRoomProvider(request, session.scene)
          : chatProvider(getProviderConfig());
      await runInteraction(session, run, request, provider, emit);
      if (session.isCurrent(run)) {
        session.finish(run, 'completed');
        emit({ type: 'goal', requestId: run.id, text: session.goal });
        emit({ type: 'done', requestId: run.id, status: 'completed' });
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'MOCK_DISCONNECT') {
        session.finish(run, 'failed');
        reply.raw.end();
      } else if (run.status === 'cancelled') {
        emit({ type: 'done', requestId: run.id, status: 'cancelled' });
      } else {
        const message =
          error instanceof Error && /^(模型|本轮|模拟)/.test(error.message)
            ? error.message
            : '请求已停止或未能完成，可以继续交互。';
        session.finish(run, 'failed');
        emit({ type: 'error', requestId: run.id, message });
        emit({ type: 'done', requestId: run.id, status: 'failed' });
      }
    } finally {
      ended = true;
      inFlight--;
      clearTimeout(timeout);
      clearInterval(heartbeat);
      reply.raw.removeListener('close', close);
      if (!reply.raw.destroyed) reply.raw.end();
    }
  });
}
