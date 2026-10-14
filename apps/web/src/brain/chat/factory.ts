// 大脑工厂。UI 侧按 settings.brainMode 拿一个实现，之后只认 PetBrain 这个接口，
// 不需要知道底下是 WebSocket 还是 HTTP。
//
// PetBrain 不是新契约，而是**对现有 Brain 公开面的描述**。下面两条 type 断言
// 会在 npm run typecheck 时检查「两个实现是否还一致」—— 哪天 Brain 的公开面变了
// 而 ChatBrain 没跟上（或者反过来），typecheck 当场报错，而不是等 UI 运行时炸。
import type { PetEvent } from '../../../../../shared/brain';
import type { Settings } from '../../../../../shared/desktop';
import { Brain, type BrainOptions } from '../Brain';
import { ChatBrain, type ChatBrainOptions } from './ChatBrain';

export type BrainTranscriptEntry = { role: 'user' | 'pet'; text: string; at: number };

/** 两种大脑的共同公开面。 */
export type PetBrain = {
  on(listener: (event: PetEvent) => void): () => void;
  start(withMic?: boolean): Promise<void>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
  sendText(text: string): Promise<void>;
  setVoice(voice: string): Promise<void>;
  refreshSettings(): Promise<Settings>;
  interrupt(): void;
  enableMic(): Promise<void>;
  disableMic(): void;
  /**
   * 「按住说话」。持续聆听关掉之后，长按桌宠是唯一的语音入口。
   * chat 模式这一版没有语音输入，实现成安全的空操作（见 ChatBrain）。
   */
  beginPushToTalk(): Promise<void>;
  endPushToTalk(): void;
  readonly pushToTalkActive: boolean;
  /** 持续聆听开关的当前值。UI 用它决定要不要显示长按提示。 */
  readonly listening: boolean;
  /** 语音能不能自动打断她。手动 interrupt() 不受它影响。 */
  readonly voiceInterruptible: boolean;
  readonly audioLevel: number;
  readonly running: boolean;
  readonly transcript: readonly BrainTranscriptEntry[];
};

/** 编译期断言：T 必须可赋给 U。 */
type AssertAssignable<T extends U, U> = T;
type RealtimeBrainConforms = AssertAssignable<Brain, PetBrain>;
type ChatBrainConforms = AssertAssignable<ChatBrain, PetBrain>;
// 用一下，免得被当成纯粹的死代码删掉。
export type BrainImplementations = [RealtimeBrainConforms, ChatBrainConforms];

export type CreateBrainOptions = BrainOptions & ChatBrainOptions;

/**
 * 按模式造一个大脑。
 *
 * 模式切换是「换一个实例」而不是「改一个实例的状态」—— 两种模式的上下文权威
 * 不在同一边（realtime 在服务端，chat 在我们这儿），想原地切换就得把上下文
 * 搬过去，那是混合模式才要解决的问题（见 docs/BRAIN_MODES.md）。
 * 这一版的行为是：切模式 = 新开一段对话，旧的 transcript 丢掉。
 */
export function createBrain(
  mode: Settings['brainMode'],
  options: CreateBrainOptions = {},
): PetBrain {
  return mode === 'chat' ? new ChatBrain(options) : new Brain(options);
}
