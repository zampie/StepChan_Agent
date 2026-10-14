// chat 模式的对外出口。UI 侧只需要 createBrain / PetBrain 这两个名字。
export {
  ChatBrain,
  type ChatBrainOptions,
  type AudioOutput,
  type AudioOutputEvents,
} from './ChatBrain';
export {
  ChatSession,
  MAX_TOOL_CALLS_PER_TURN,
  type ChatSessionOptions,
  type SpeechController,
  type TranscriptEntry,
} from './ChatSession';
export { SpeechSynthesizer, type SpeechSink, type SpeechSynthesizerOptions } from './tts';
export { SentenceBuffer, spokenText } from './sentences';
export { decodeWav, pcm16ToBase64, resample, toMono, type DecodedWav } from './wav';
export { readSseData } from './sse';
export {
  ChatHttpError,
  streamChatCompletion,
  CHAT_COMPLETIONS_URL,
  type ChatMessage,
  type ChatStreamOptions,
  type ChatStreamResult,
  type StreamedToolCall,
} from './stream';
export { buildChatInstructions, chatInstructionsFor } from './persona';
export { createBrain, type PetBrain, type CreateBrainOptions } from './factory';
