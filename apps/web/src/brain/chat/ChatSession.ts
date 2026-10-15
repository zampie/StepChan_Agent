// chat 模式的对话循环：messages → 流式回复 → 工具 → 回灌 → 继续，直到她说完话。
//
// 职责边界和 RealtimeSession 一样：只管「怎么把一轮对话跑完」，不认识桌面能力
// （executeTool 注入）、不认识人设内容（getInstructions 注入）、不碰 AudioContext
// （speak 注入）。所以它能在 Node 里直接实例化测试，也能被探测脚本直接驱动。
//
// 与 realtime 的本质差别：**上下文的权威在这里**。realtime 的对话状态在服务端，
// 我们只能往里追加；chat 模式每轮都把整个 messages 重新发一遍，于是没有 30 分钟
// 上限、可以随时改 system prompt、可以随时换模型，代价是每轮重付输入 token
// （有 prompt cache 兜一部分）。详见 docs/BRAIN_MODES.md。
import { toolArgSchemas, toolNames } from '../../../../../shared/brain';
import type { PetEvent, ToolName, ToolResult } from '../../../../../shared/brain';
import type { ToolDefinition } from '../../../../../shared/realtime';
import { SentenceBuffer } from './sentences';
import { ChatHttpError, streamChatCompletion, type ChatMessage } from './stream';

/**
 * 一轮最多执行多少个工具。与 realtime 侧的 MAX_TOOL_CALLS_PER_TURN 对齐
 * （voice/RealtimeSession.ts），理由相同：防止模型自循环把额度烧光。
 * 两边各自定义而不是共享常量，是为了不让这条线依赖另一条线的文件。
 */
export const MAX_TOOL_CALLS_PER_TURN = 4;
/**
 * 一轮最多跑多少次模型调用。工具额度用完后模型可能还想继续调，
 * 这时我们会把 tools 撤掉强制它说话，所以这个上限只是最后的保险。
 */
const MAX_ROUNDS = 6;
/** 历史里保留多少条非 system 消息。再往前的对话她记不住，这一版也不打算记。 */
const MAX_HISTORY = 24;
/** 「模型返回空回复」的重试次数。实测 flash 在工具执行后出现过空回复。 */
const MAX_EMPTY_RETRIES = 1;

export type TranscriptEntry = { role: 'user' | 'pet'; text: string; at: number };

/** 语音输出侧的最小接口（真实实现是 tts.ts 的 SpeechSynthesizer）。 */
export type SpeechController = {
  speak(text: string): void;
  cancel(): void;
};

export type ChatSessionOptions = {
  getApiKey: () => Promise<string>;
  getModel: () => string;
  /** 每轮重新取 —— 用户刚改的隐私开关要立刻体现在 system prompt 里。 */
  getInstructions: () => string | Promise<string>;
  tools: ToolDefinition[];
  executeTool: (name: ToolName, args: unknown) => Promise<ToolResult>;
  emit: (event: PetEvent) => void;
  /** 不传 = 只出文字不出声（voiceEnabled 关掉时就是这样）。 */
  speech?: SpeechController;
  fetchImpl?: typeof fetch;
};

export class ChatSession {
  /** 不含 system —— system 每轮重新生成，不进历史。 */
  private history: ChatMessage[] = [];
  readonly transcript: TranscriptEntry[] = [];
  /** 每次新回合/打断自增。所有异步回调都要对 epoch。 */
  private epoch = 0;
  private abort: AbortController | null = null;
  private turn: Promise<void> | null = null;
  private sentences = new SentenceBuffer();
  private toolCallsThisTurn = 0;
  /** 幂等：同一 call id 只执行一次。 */
  private toolResults = new Map<string, ToolResult>();
  private speaking = false;

  constructor(private readonly options: ChatSessionOptions) {}

  get busy(): boolean {
    return this.turn !== null;
  }

  /**
   * 打字输入。返回这一轮结束的 promise（测试和探测脚本要 await 它；
   * UI 不需要 —— 它靠事件驱动）。
   */
  async sendText(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    // 新的一句话 = 新回合：先把上一轮掐掉，否则两段话会叠在一起说。
    this.interrupt();
    this.history.push({ role: 'user', content: trimmed });
    this.transcript.push({ role: 'user', text: trimmed, at: Date.now() });
    this.options.emit({ type: 'user_transcript', text: trimmed, final: true });

    const epoch = this.epoch;
    const run = this.runTurn(epoch).finally(() => {
      if (epoch === this.epoch) this.turn = null;
    });
    this.turn = run;
    return run;
  }

  /**
   * 打断。同步完成本地止声，在途请求一起废掉。
   * 已经说出口的部分会留在历史里（她确实说了那半句，不能装作没说过）。
   */
  interrupt(): void {
    this.epoch++;
    this.abort?.abort();
    this.abort = null;
    this.turn = null;
    this.sentences.reset();
    this.toolCallsThisTurn = 0;
    this.toolResults.clear();
    this.options.speech?.cancel();
    if (this.speaking) {
      this.speaking = false;
      this.options.emit({ type: 'activity', value: 'idle' });
    }
  }

  /** 清掉对话历史（换模式、重新开始）。transcript 一起清。 */
  reset(): void {
    this.interrupt();
    this.history = [];
    this.transcript.length = 0;
  }

  // ---- 一轮对话 ----

  private async runTurn(epoch: number): Promise<void> {
    const abort = new AbortController();
    this.abort = abort;
    this.sentences.reset();
    this.toolCallsThisTurn = 0;
    this.toolResults.clear();
    this.options.emit({ type: 'turn_start' });
    this.options.emit({ type: 'activity', value: 'thinking' });

    // 跨 round 累计：UI 的气泡要显示整轮回复，不是单次模型调用的片段。
    let turnText = '';
    let emptyRetries = 0;

    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        if (epoch !== this.epoch) return;
        const instructions = await this.options.getInstructions();
        const apiKey = await this.options.getApiKey();
        if (epoch !== this.epoch) return;

        // 工具额度用完 → 这一轮干脆不给 tools，强制她说话收尾。
        // （比 tool_choice:'none' 保险：不依赖服务端是否支持那个取值。）
        const budgetLeft = this.toolCallsThisTurn < MAX_TOOL_CALLS_PER_TURN;
        const result = await streamChatCompletion({
          apiKey,
          model: this.options.getModel(),
          messages: [{ role: 'system', content: instructions }, ...this.history],
          tools: budgetLeft ? this.options.tools : undefined,
          signal: abort.signal,
          fetchImpl: this.options.fetchImpl,
          onReasoning: (delta) => {
            if (epoch !== this.epoch) return;
            this.options.emit({ type: 'thinking', text: delta });
          },
          onContent: (delta) => {
            if (epoch !== this.epoch) return;
            turnText += delta;
            this.options.emit({ type: 'pet_transcript', text: turnText, final: false });
            // 边出边念：第一个短句一凑齐就送去合成。
            for (const segment of this.sentences.push(delta)) this.say(segment);
          },
        });
        if (epoch !== this.epoch) return;

        const calls = result.toolCalls.filter((call) => call.name);
        if (calls.length === 0) {
          // 没有工具调用 = 这轮说完了。把残句也念掉。
          for (const segment of this.sentences.flush()) this.say(segment);
          if (!result.text.trim()) {
            // 实测过的失败模式：工具执行之后模型返回空回复（见 docs/model-benchmark）。
            // 撤掉 tools 再要一次；还是空就如实告诉用户，不编造内容。
            if (emptyRetries < MAX_EMPTY_RETRIES && !turnText.trim()) {
              emptyRetries++;
              this.toolCallsThisTurn = MAX_TOOL_CALLS_PER_TURN;
              continue;
            }
            if (!turnText.trim()) {
              this.options.emit({
                type: 'error',
                message: '她这轮没说出话来（模型返回空回复），再说一次试试。',
              });
            }
          }
          break;
        }

        // 带工具调用的 assistant 消息必须和它的 tool 结果成对出现，
        // 否则下一轮请求会被服务端 400。所以这两段紧挨着 push。
        this.history.push({
          role: 'assistant',
          content: result.text || null,
          tool_calls: calls.map((call) => ({
            id: call.id,
            type: 'function' as const,
            function: { name: call.name, arguments: call.args },
          })),
        });
        for (const call of calls) {
          const toolResult = await this.runTool(call.id, call.name, call.args, epoch);
          if (epoch !== this.epoch) return;
          this.history.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(toolResult),
          });
        }
        if (result.finishReason === 'length') {
          // 被 max_tokens 截断了，不再继续 —— 继续也只会接着截断。
          break;
        }
      }

      if (epoch !== this.epoch) return;
      const final = turnText.trim();
      if (final) {
        this.history.push({ role: 'assistant', content: final });
        this.transcript.push({ role: 'pet', text: final, at: Date.now() });
        this.options.emit({ type: 'pet_transcript', text: final, final: true });
      }
      this.trimHistory();
    } catch (error) {
      if (epoch !== this.epoch || abort.signal.aborted) {
        // 被打断：把已经说出口的半句留在历史里，这样她不会在下一轮重复一遍。
        // 不加「（被打断）」之类的标记 —— 那种标记会被她当成正文念出来。
        const partial = turnText.trim();
        if (partial) this.history.push({ role: 'assistant', content: partial });
        return;
      }
      const message =
        error instanceof ChatHttpError
          ? error.message
          : `对话出错了：${error instanceof Error ? error.message : '未知错误'}`;
      this.options.emit({ type: 'error', message });
    } finally {
      if (epoch === this.epoch) {
        this.abort = null;
        // 不发 idle —— 声音可能还在播，由播放侧的 drained 回调决定什么时候 idle。
        if (!this.speaking) this.options.emit({ type: 'activity', value: 'idle' });
      }
    }
  }

  private say(segment: string): void {
    if (!segment) return;
    if (!this.options.speech) return;
    this.speaking = true;
    this.options.speech.speak(segment);
  }

  // ---- 工具 ----

  private async runTool(
    callId: string,
    rawName: string,
    rawArgs: string,
    epoch: number,
  ): Promise<ToolResult> {
    // 幂等：同一个 call id 重复到达（模型重复发、我们重试）直接回上次结果，
    // 不重复执行副作用。
    const cached = this.toolResults.get(callId);
    if (cached) return cached;

    const name = rawName as ToolName;
    if (!toolNames.includes(name)) {
      return this.remember(callId, { ok: false, message: `没有叫 ${rawName} 的工具。` });
    }

    this.toolCallsThisTurn++;
    if (this.toolCallsThisTurn > MAX_TOOL_CALLS_PER_TURN) {
      return this.remember(callId, {
        ok: false,
        message: `这一轮已经用掉 ${MAX_TOOL_CALLS_PER_TURN} 次工具了，先把结果告诉用户，别再调了。`,
      });
    }

    let args: unknown;
    try {
      args = rawArgs.trim() ? JSON.parse(rawArgs) : {};
    } catch {
      return this.remember(callId, {
        ok: false,
        message: '参数不是合法 JSON，重新调用一次。',
      });
    }
    // 模型给的参数一律不可信。
    const parsed = toolArgSchemas[name].safeParse(args);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '参数'}: ${issue.message}`)
        .join('；');
      return this.remember(callId, { ok: false, message: `参数不合法（${detail}）。` });
    }

    this.options.emit({ type: 'tool_start', name, args: parsed.data });
    let result: ToolResult;
    try {
      result = await this.options.executeTool(name, parsed.data);
    } catch (error) {
      result = {
        ok: false,
        message: `工具执行失败：${error instanceof Error ? error.message : '未知错误'}。如实告诉用户没做成。`,
      };
    }
    if (epoch === this.epoch) this.options.emit({ type: 'tool_end', name, result });
    return this.remember(callId, result);
  }

  private remember(callId: string, result: ToolResult): ToolResult {
    this.toolResults.set(callId, result);
    return result;
  }

  // ---- 历史 ----

  /**
   * 裁掉太旧的消息。
   *
   * 关键约束：窗口的第一条不能是 tool 结果 —— 它必须跟着那条带 tool_calls 的
   * assistant 一起出现，否则服务端直接 400。所以切点落在 tool 上时要往前让。
   */
  private trimHistory(): void {
    if (this.history.length <= MAX_HISTORY) return;
    let start = this.history.length - MAX_HISTORY;
    while (start > 0 && this.history[start].role === 'tool') start--;
    this.history = this.history.slice(start);
  }

  /** 测试用：当前历史的只读快照。 */
  get messages(): readonly ChatMessage[] {
    return this.history;
  }

  /** 播放侧说「播完了」时调用，用来把 activity 落回 idle。 */
  notifyDrained(): void {
    this.speaking = false;
    if (!this.busy) this.options.emit({ type: 'activity', value: 'idle' });
  }
}
