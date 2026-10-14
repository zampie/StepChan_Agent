export function getProviderConfig(env: NodeJS.ProcessEnv = process.env) {
  const provider = env.LLM_PROVIDER ?? 'stepfun';
  if (provider !== 'stepfun' && provider !== 'openrouter')
    throw Error('LLM_PROVIDER 必须为 stepfun 或 openrouter。');
  return {
    provider,
    key: (provider === 'stepfun' ? env.STEPFUN_API_KEY : env.OPENROUTER_API_KEY) ?? '',
    model:
      provider === 'stepfun'
        ? (env.STEPFUN_MODEL ?? 'step-3.7-flash')
        : (env.OPENROUTER_MODEL ?? 'stepfun/step-5-preview'),
    maxTokens: Math.min(4096, Math.max(128, Number(env.MAX_TOKENS) || 1024)),
  } as const;
}
