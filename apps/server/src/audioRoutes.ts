import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { readSSE } from '../../../shared/sse';
import { spokenText } from '../../../shared/audio';

export const voiceInstruction =
  '保留原音色活力轻快、自然亲近的特点。像活泼的小学生和好朋友分享新发现：声音清脆明亮、轻盈有童真，带一点开心的笑意和好奇。音调比平常略高，语速轻快，吐字清楚，用短而自然的停顿；句尾只轻轻上扬。用日常聊天的音量，不拉长尾音，不刻意夹嗓或撒娇，不用成熟的气声、播音腔或客服腔。';
export const audioConfig = () => ({
  configured: !!process.env.STEPFUN_API_KEY,
  ttsModel: 'stepaudio-3-tts',
  asrModel: 'stepaudio-3-asr-max',
  voice: process.env.STEPFUN_TTS_VOICE || 'livelybreezy-female',
});
export function validRecording(wav: Buffer): boolean {
  if (
    wav.length < 44 ||
    wav.toString('ascii', 0, 4) !== 'RIFF' ||
    wav.toString('ascii', 8, 16) !== 'WAVEfmt ' ||
    wav.toString('ascii', 36, 40) !== 'data'
  )
    return false;
  const rate = wav.readUInt32LE(24),
    length = wav.readUInt32LE(40);
  return (
    wav.readUInt32LE(4) === wav.length - 8 &&
    wav.readUInt32LE(16) === 16 &&
    wav.readUInt16LE(20) === 1 &&
    wav.readUInt16LE(22) === 1 &&
    wav.readUInt16LE(34) === 16 &&
    wav.readUInt16LE(32) === 2 &&
    [16000, 24000, 44100, 48000].includes(rate) &&
    wav.readUInt32LE(28) === rate * 2 &&
    length === wav.length - 44 &&
    length % 2 === 0 &&
    length >= rate * 0.4 &&
    length <= rate * 2 * 30
  );
}
export async function transcribe(stream: ReadableStream<Uint8Array>): Promise<string> {
  for await (const frame of readSSE(stream)) {
    if (frame.data === '[DONE]') break;
    const event = z
      .object({ type: z.string(), text: z.string().max(4000).optional() })
      .parse(JSON.parse(frame.data));
    if (event.type === 'error') throw Error('语音识别失败，请重试。');
    if (event.type === 'transcript.text.done') {
      if (!event.text?.trim()) throw Error('没有听清，请靠近麦克风再说一次。');
      return event.text.trim();
    }
  }
  throw Error('语音识别中断，请重试。');
}
const ttsSchema = z.object({ text: z.string().trim().min(1).max(600) }).strict();
const asrSchema = z
  .object({
    audio: z
      .string()
      .min(64)
      .max(3_840_060)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict();
export function registerAudioRoutes(app: FastifyInstance) {
  let active = 0;
  for (const kind of ['tts', 'asr'] as const) {
    app.post(
      `/api/audio/${kind}`,
      { bodyLimit: kind === 'asr' ? 3_850_000 : 8000 },
      async (req, reply) => {
        reply.header('Cache-Control', 'no-store');
        const parsed = (kind === 'tts' ? ttsSchema : asrSchema).safeParse(req.body);
        if (!parsed.success) return reply.code(400).send({ message: '语音请求格式无效。' });
        const config = audioConfig();
        if (!config.configured)
          return reply.code(503).send({ message: '请先配置服务端 StepFun 密钥。' });
        let payload: object;
        if ('text' in parsed.data) {
          const text = spokenText(parsed.data.text);
          if (!text) return reply.code(400).send({ message: '没有可朗读的文字。' });
          payload = {
            model: config.ttsModel,
            voice: config.voice,
            input: text,
            instruction: voiceInstruction,
            response_format: 'wav',
            sample_rate: 24000,
          };
        } else {
          const wav = Buffer.from(parsed.data.audio, 'base64');
          if (!validRecording(wav))
            return reply.code(400).send({ message: '录音需为 0.2–30 秒的单声道 PCM16 WAV。' });
          payload = {
            audio: {
              data: parsed.data.audio,
              input: {
                transcription: {
                  model: config.asrModel,
                  language: 'zh',
                  hotwords: ['Step酱', '发现卡', '盆栽'],
                },
                format: { type: 'wav' },
              },
            },
          };
        }
        if (active >= 3) return reply.code(429).send({ message: '语音正在处理中，请稍后再试。' });
        active++;
        const abort = new AbortController();
        const close = () => abort.abort();
        reply.raw.on('close', close);
        const timeout = setTimeout(() => abort.abort(), 45000);
        try {
          const response = await fetch(
            `https://api.stepfun.com/v1/audio/${kind === 'tts' ? 'speech' : 'asr/sse'}`,
            {
              method: 'POST',
              signal: abort.signal,
              headers: {
                Authorization: `Bearer ${process.env.STEPFUN_API_KEY}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(payload),
            },
          );
          if (!response.ok || !response.body) {
            await response.body?.cancel();
            return reply
              .code(502)
              .send({ message: `语音服务暂不可用（${response.status}），请稍后重试。` });
          }
          if (kind === 'asr') return { text: await transcribe(response.body) };
          // Bound provider data in memory; no recordings or generated speech written to disk.
          const chunks: Uint8Array[] = [];
          let bytes = 0;
          const reader = response.body.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              bytes += value.length;
              if (bytes > 8_000_000) {
                abort.abort();
                throw Error('语音回复过长，请改用短句。');
              }
              chunks.push(value);
            }
          } finally {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
          }
          const wav = Buffer.concat(chunks);
          if (wav.toString('ascii', 0, 4) !== 'RIFF') throw Error('语音服务返回格式无效。');
          return reply.type('audio/wav').send(wav);
        } catch (error) {
          const message =
            error instanceof Error && /^(语音|没有听清)/.test(error.message)
              ? error.message
              : '语音请求未完成或超时，请重试。';
          return reply.code(502).send({ message });
        } finally {
          clearTimeout(timeout);
          reply.raw.removeListener('close', close);
          active--;
        }
      },
    );
  }
}
