import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatProvider } from '../apps/server/src/providers';
import { getProviderConfig } from '../apps/server/src/providerConfig';
test('stream usage keeps the final cumulative report and tolerates absent usage fields', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(
        [
          {
            choices: [{ delta: { content: '你' } }],
            usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
          },
          { choices: [{ delta: { content: '好' }, finish_reason: 'stop' }], usage: null },
          {
            choices: [],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 2,
              total_tokens: 12,
              prompt_tokens_details: { cached_tokens: 4 },
            },
          },
        ]
          .map((e) => `data: ${JSON.stringify(e)}\n\n`)
          .join('') + 'data: [DONE]\n\n',
      );
    const result = await chatProvider(getProviderConfig({ STEPFUN_API_KEY: 'test-only' }))(
      [],
      new AbortController().signal,
      () => {},
    );
    assert.equal(result.text, '你好');
    assert.equal(result.usage?.total_tokens, 12);
    assert.equal(result.usage?.prompt_tokens_details?.cached_tokens, 4);
  } finally {
    globalThis.fetch = original;
  }
});
test('StepFun fragmented tools accept empty continuation type without exposing reasoning', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(
        [
          {
            choices: [{ delta: { reasoning: 'hidden', reasoning_content: 'hidden', content: '' } }],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'tool1',
                      type: 'function',
                      function: { name: 'water_plant', arguments: '{' },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: '', type: '', function: { name: '', arguments: '}' } },
                  ],
                },
              },
            ],
          },
          { choices: [{ delta: { content: '' }, finish_reason: 'tool_calls' }] },
        ]
          .map((data) => `data: ${JSON.stringify(data)}\n\n`)
          .join('') + 'data: [DONE]\n\n',
      );
    const chunks: string[] = [];
    const result = await chatProvider(getProviderConfig({ STEPFUN_API_KEY: 'test-only' }))(
      [],
      new AbortController().signal,
      (t) => chunks.push(t),
    );
    assert.deepEqual(result.calls, [
      { id: 'tool1', type: 'function', function: { name: 'water_plant', arguments: '{}' } },
    ]);
    assert.deepEqual(chunks, []);
  } finally {
    globalThis.fetch = original;
  }
});
test('provider selection isolates keys and uses configured model or provider defaults', () => {
  const env = { STEPFUN_API_KEY: 'official-test', OPENROUTER_API_KEY: 'router-test' };
  assert.deepEqual(getProviderConfig(env), {
    provider: 'stepfun',
    key: 'official-test',
    model: 'step-3.7-flash',
    maxTokens: 1024,
  });
  assert.deepEqual(getProviderConfig({ ...env, LLM_PROVIDER: 'openrouter' }), {
    provider: 'openrouter',
    key: 'router-test',
    model: 'stepfun/step-5-preview',
    maxTokens: 1024,
  });
  assert.equal(getProviderConfig({ OPENROUTER_API_KEY: 'router-test' }).key, '');
  assert.throws(() => getProviderConfig({ LLM_PROVIDER: 'unknown' }));
});
test('StepFun and OpenRouter send distinct endpoints and reasoning parameters with working SSE', async () => {
  const original = globalThis.fetch;
  try {
    for (const provider of ['stepfun', 'openrouter'] as const) {
      const config = getProviderConfig({
        LLM_PROVIDER: provider,
        STEPFUN_API_KEY: 'official-test',
        OPENROUTER_API_KEY: 'router-test',
      });
      globalThis.fetch = async (url, init) => {
        assert.equal(
          url,
          provider === 'stepfun'
            ? 'https://api.stepfun.com/v1/chat/completions'
            : 'https://openrouter.ai/api/v1/chat/completions',
        );
        const headers = new Headers(init?.headers),
          body = JSON.parse(String(init?.body));
        assert.equal(headers.get('Authorization'), 'Bearer ' + config.key);
        assert.equal(body.model, config.model);
        assert.equal(body.max_tokens, 1024);
        assert.equal(body.stream, true);
        if (provider === 'stepfun') {
          assert.equal(body.reasoning_effort, 'low');
          assert.equal(body.reasoning, undefined);
          assert.equal(headers.has('HTTP-Referer'), false);
        } else {
          assert.deepEqual(body.reasoning, { effort: 'low' });
          assert.equal(body.reasoning_effort, undefined);
          assert.ok(headers.has('HTTP-Referer'));
        }
        return new Response(
          'data: {"choices":[{"delta":{"content":"你好"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        );
      };
      const chunks: string[] = [];
      const result = await chatProvider(config)(
        [{ role: 'user', content: '你好' }],
        new AbortController().signal,
        (d) => chunks.push(d),
      );
      assert.equal(result.text, '你好');
      assert.deepEqual(chunks, ['你好']);
    }
  } finally {
    globalThis.fetch = original;
  }
});
