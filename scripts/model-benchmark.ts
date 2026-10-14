import fs from 'node:fs/promises';
import dotenv from 'dotenv';
import { Session } from '../apps/server/src/sessions';
import { runInteraction } from '../apps/server/src/interactionRuntime';
import { chatProvider, type Provider, type TokenUsage } from '../apps/server/src/providers';
import type { InteractionInput } from '../shared/room';
dotenv.config({ quiet: true });
if (!process.env.STEPFUN_API_KEY) throw Error('Configure the server STEPFUN_API_KEY first.');
const repetitions = Number(process.env.BENCH_REPETITIONS) || 3;
const scenarios: { name: string; input: InteractionInput; check: (s: Session) => boolean }[] = [
  {
    name: '简短问候',
    input: { kind: 'text', text: '你好呀，Step酱。用一句话和我打个招呼吧。' },
    check: (s) => true,
  },
  { name: '脸颊触碰', input: { kind: 'touch', part: 'cheek' }, check: (s) => true },
  {
    name: '浇水工具',
    input: { kind: 'text', text: '帮我给盆栽浇一次水，然后简单告诉我结果。' },
    check: (s) => s.scene.plant.waterCount === 1,
  },
  {
    name: '发现卡工具',
    input: { kind: 'text', text: '给我抽一张发现卡，让我猜答案，先别剧透。' },
    check: (s) => !!s.scene.card && !s.scene.card.revealed,
  },
  { name: '自主探索', input: { kind: 'autonomy' }, check: (s) => s.scene.revision > 0 },
];
const rows: Record<string, unknown>[] = [];
await fs.mkdir('artifacts', { recursive: true });
for (let repeat = 0; repeat < repetitions; repeat++)
  for (const scenario of scenarios) {
    const models =
      repeat % 2 ? ['step-3.7-flash', 'step-5-preview'] : ['step-5-preview', 'step-3.7-flash'];
    for (const model of models) {
      const s = new Session(),
        id = crypto.randomUUID(),
        run = s.begin(id, scenario.input);
      const usage: TokenUsage[] = [];
      let apiCalls = 0,
        firstTextMs: number | null = null,
        firstEffectMs: number | null = null;
      const tools: string[] = [];
      let error: string | null = null;
      const actual = chatProvider({
        provider: 'stepfun',
        model,
        key: process.env.STEPFUN_API_KEY!,
        maxTokens: 1024,
      });
      const provider: Provider = async (...args) => {
        apiCalls++;
        const result = await actual(...args);
        if (result.usage) usage.push(result.usage);
        return result;
      };
      const started = performance.now(),
        timeout = setTimeout(() => s.finish(run, 'failed'), 60000);
      try {
        await runInteraction(
          s,
          run,
          {
            sessionId: s.id,
            requestId: id,
            mode: 'live',
            input: scenario.input,
            timezone: 'Asia/Shanghai',
          },
          provider,
          (e) => {
            if (e.type === 'text_delta') firstTextMs ??= performance.now() - started;
            if (e.type === 'tool_end' && e.result.ok) {
              tools.push(e.name);
              firstEffectMs ??= performance.now() - started;
            }
          },
        );
        s.finish(run, 'completed');
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        s.finish(run, 'failed');
      } finally {
        clearTimeout(timeout);
      }
      const total = (key: 'prompt_tokens' | 'completion_tokens' | 'total_tokens') =>
        usage.reduce((n, u) => n + u[key], 0);
      const row = {
        model,
        scenario: scenario.name,
        repeat: repeat + 1,
        firstTextMs,
        firstEffectMs,
        durationMs: performance.now() - started,
        apiCalls,
        usageReports: usage.length,
        promptTokens: total('prompt_tokens'),
        completionTokens: total('completion_tokens'),
        totalTokens: total('total_tokens'),
        cachedTokens: usage.reduce((n, u) => n + (u.prompt_tokens_details?.cached_tokens ?? 0), 0),
        reasoningTokens: usage.reduce(
          (n, u) => n + (u.completion_tokens_details?.reasoning_tokens ?? 0),
          0,
        ),
        success: !error && scenario.check(s) && run.text.length > 0,
        error,
        tools,
        text: run.text,
        usage,
      };
      rows.push(row);
      console.log(JSON.stringify({ ...row, usage: undefined, text: undefined }));
      await fs.writeFile(
        'artifacts/model-benchmark.json',
        JSON.stringify(
          {
            createdAt: new Date().toISOString(),
            repetitions,
            reasoningEffort: 'low',
            maxTokens: 1024,
            method:
              'Fresh session per trial; production runInteraction and real tools; alternating models; latest provider usage per call summed across rounds; sequential calls.',
            rows,
          },
          null,
          2,
        ),
      );
    }
  }
