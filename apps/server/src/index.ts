import { getProviderConfig } from './providerConfig';
import Fastify from 'fastify';
import staticPlugin from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { requestSchema, type ChatEvent } from '../../../shared/protocol';
import { mockProvider, chatProvider } from './providers';
import { runAgent } from './runtime';
import { validTimezone } from './tools';
import { registerInteractionRoutes } from './interactionRoutes';
import { audioConfig, registerAudioRoutes } from './audioRoutes';
const root = resolve(import.meta.dirname, '../../..');
dotenv.config({ path: resolve(root, '.env'), quiet: true });
export function buildServer() {
  const app = Fastify({ logger: false, bodyLimit: 100000 });
  let active = 0;
  app.addHook('onRequest', async (req, reply) => {
    const host = req.headers.host?.split(':')[0];
    if (!['localhost', '127.0.0.1'].includes(host ?? ''))
      return reply.code(403).send({ message: '仅允许本机访问。' });
    const origin = req.headers.origin;
    if (origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))
      return reply.code(403).send({ message: '不允许此来源。' });
  });
  app.get('/api/health', async () => ({
    ok: true,
    liveConfigured: !!getProviderConfig().key,
    model: getProviderConfig().model,
    provider: getProviderConfig().provider,
    audio: audioConfig(),
  }));
  registerInteractionRoutes(app);
  registerAudioRoutes(app);
  app.post('/api/chat', async (req, reply) => {
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ message: parsed.error.issues[0]?.message ?? '请求格式错误。' });
    const request = parsed.data;
    if (request.timezone && !validTimezone(request.timezone))
      return reply.code(400).send({ message: '浏览器时区无效。' });
    if (request.mode === 'live' && !getProviderConfig().key)
      return reply
        .code(503)
        .send({ message: '尚未配置服务端 API 密钥。请使用演示模式，或配置根目录 .env。' });
    if (active >= 2) return reply.code(429).send({ message: '当前请求较多，请稍后再试。' });
    active++;
    const controller = new AbortController();
    let ended = false;
    const deadline = setTimeout(
      () => controller.abort(new Error('请求超过时限，请重试。')),
      Number(process.env.REQUEST_TIMEOUT_MS) || 60000,
    );
    const close = () => {
      if (!ended) controller.abort(new Error('连接已关闭。'));
    };
    reply.raw.on('close', close);
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
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
        request.mode === 'mock' ? mockProvider(request) : chatProvider(getProviderConfig());
      await runAgent(request, provider, controller.signal, emit);
      emit({ type: 'done', requestId: request.requestId, status: 'completed' });
    } catch (error) {
      if (error instanceof Error && error.message === 'MOCK_DISCONNECT') {
        reply.raw.end();
      } else {
        const allowed = error instanceof Error && /^(模型|本轮|模拟|请求超过)/.test(error.message);
        const message = controller.signal.aborted
          ? '请求已停止或超过时限，请重试。'
          : allowed
            ? error.message
            : '请求未完成，请重试。';
        emit({ type: 'error', requestId: request.requestId, message });
        emit({ type: 'done', requestId: request.requestId, status: 'failed' });
      }
    } finally {
      ended = true;
      active--;
      clearTimeout(deadline);
      clearInterval(heartbeat);
      reply.raw.removeListener('close', close);
      if (!reply.raw.destroyed) reply.raw.end();
    }
  });
  const web = resolve(root, 'apps/web/dist');
  if (existsSync(web)) {
    app.register(staticPlugin, { root: web });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/')
        ? reply.code(404).send({ message: '接口不存在' })
        : reply.sendFile('index.html'),
    );
  }
  return app;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const app = buildServer();
  await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT) || 3001 });
  console.log('Step酱 server: http://127.0.0.1:' + (process.env.PORT || 3001));
}
