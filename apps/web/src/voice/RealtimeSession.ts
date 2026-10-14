// 一个 WebSocket 实时会话的全部状态机。
//
// 职责边界：本类只管协议与音频通道，不认识桌面能力，也不认识人设内容 ——
// 工具执行器和 instructions 都由构造参数注入（见 brain/Brain.ts）。
//
// 几个硬约束（来自 shared/realtime.ts 开头的实测记录）：
// - 鉴权必须走 subprotocol，webview 设不了 header。
// - 工具是嵌套格式。
// - 单会话 30 分钟上限 → 到点前主动静默重建，并把上下文摘要带过去。
// - 首次出音后 voice 不可改 → 换音色也只能重建。
import {
  REALTIME_SESSION_LIMIT_MS,
  parseServerEvent,
  realtimeSubprotocols,
  realtimeUrl,
  type ClientEvent,
  type ServerEvent,
  type SessionConfig,
  type ToolDefinition,
} from '../../../../shared/realtime';
import type { PetEvent, ToolName, ToolResult } from '../../../../shared/brain';
import { toolArgSchemas, toolNames } from '../../../../shared/brain';
import { SpeechStream } from './SpeechStream';
import { MicStream } from './MicStream';

/** 一轮最多执行多少个工具。防止模型自循环把额度烧光。 */
export const MAX_TOOL_CALLS_PER_TURN = 4;
/** 提前多久重建会话。留足时间让当前这轮说完。 */
const ROTATE_MARGIN_MS = 90_000;
/** 文字输入后，等多久判定「她答应了却没真的调工具」。 */
const TOOL_NUDGE_DELAY_MS = 1200;

export type ToolExecutor = (name: ToolName, args: unknown) => Promise<ToolResult>;

export type RealtimeSessionOptions = {
  apiKey: string;
  model?: string;
  voice: string;
  instructions: string;
  tools: ToolDefinition[];
  executeTool: ToolExecutor;
  /** 发事件给 UI。 */
  emit: (event: PetEvent) => void;
  /**
   * 判断一句文字输入是否「明显应该调工具」。返回工具名则在模型没调工具时补一刀。
   * 放在外面是因为这属于人设/业务判断，不属于协议。
   */
  textNeedsTool?: (text: string) => ToolName | null;
  /** 换会话时带过去的上下文摘要。 */
  summarize?: (transcript: TranscriptEntry[]) => string;
  onLevel?: (level: number) => void;
};

export type TranscriptEntry = { role: 'user' | 'pet'; text: string; at: number };

type PendingCall = { callId: string; name: string; args: string };

export class RealtimeSession {
  private ws: WebSocket | null = null;
  private speech: SpeechStream;
  private mic: MicStream;
  /** 每次 connect 自增。所有异步回调都要对 epoch，防止旧连接的迟到消息污染新会话。 */
  private epoch = 0;
  private closedByUs = false;
  private rotating = false;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private rotateTimer: ReturnType<typeof setTimeout> | null = null;
  private nudgeTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private micWanted = false;

  private toolCallsThisTurn = 0;
  /** 幂等：同一 call_id 只执行一次；重复的直接回上次的结果。 */
  private toolResults = new Map<string, ToolResult>();
  private inFlightTools = new Set<string>();
  private responseActive = false;
  private hadAudioOutput = false;
  private awaitingToolFor: ToolName | null = null;
  /**
   * 打断之后到下一个 response.created 之间，丢弃所有音频增量。
   *
   * 实测：发出 response.cancel 之后还会再到 4 条 response.audio.delta（在途的），
   * 之后流才安静。不丢掉它们的话，刚 flush 的环又被填上，她会在被打断后
   * 再蹦出小半个字。
   */
  private suppressAudio = false;
  /** 已压音量、等待确认是不是真人声的状态。 */
  private pendingBargeIn = false;
  private bargeInTimer: ReturnType<typeof setTimeout> | null = null;

  private userPartial = '';
  private petPartial = '';
  readonly transcript: TranscriptEntry[] = [];

  constructor(private options: RealtimeSessionOptions) {
    this.speech = new SpeechStream({
      onLevel: (level) => this.options.onLevel?.(level),
      onDrained: () => {
        // 说完了：回 idle 或 listening，由麦克风状态决定。
        if (!this.responseActive) this.setActivity(this.micWanted ? 'listening' : 'idle');
      },
      onStarted: () => this.setActivity('speaking'),
      onError: (message) => this.options.emit({ type: 'error', message }),
    });
    this.mic = new MicStream({
      onFrame: (base64) => this.send({ type: 'input_audio_buffer.append', audio: base64 }),
      onError: (message) => this.options.emit({ type: 'error', message }),
      onSampleRateMismatch: (actual, target) =>
        console.warn(`[RealtimeSession] 麦克风采样率 ${actual}Hz ≠ ${target}Hz，已重采样。`),
    });
  }

  get audioLevel(): number {
    return this.speech.audioLevel;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** 建立会话。withMic=false 用于纯打字模式（不碰麦克风权限）。 */
  async start(withMic: boolean): Promise<void> {
    this.started = true;
    this.micWanted = withMic;
    await this.speech.start();
    await this.connect(false);
    if (withMic) await this.enableMic();
  }

  async enableMic(): Promise<void> {
    this.micWanted = true;
    if (!this.started) return;
    try {
      await this.mic.start();
      this.setActivity('listening');
    } catch {
      // 错误已经通过 onError 发出去了；降级为纯打字，不抛给调用方。
      this.micWanted = false;
    }
  }

  disableMic(): void {
    this.micWanted = false;
    this.mic.stop();
    this.setActivity('idle');
  }

  private setActivity(value: 'idle' | 'listening' | 'thinking' | 'speaking'): void {
    this.options.emit({ type: 'activity', value });
  }

  // ---- 连接 ----

  private async connect(isRotation: boolean): Promise<void> {
    const epoch = ++this.epoch;
    this.clearTimers();
    this.closedByUs = false;
    this.options.emit({
      type: 'connection',
      state: isRotation ? 'reconnecting' : 'connecting',
    });

    let ws: WebSocket;
    try {
      ws = new WebSocket(
        realtimeUrl(this.options.model),
        realtimeSubprotocols(this.options.apiKey),
      );
    } catch (error) {
      this.options.emit({
        type: 'error',
        message: `无法建立语音连接：${error instanceof Error ? error.message : '未知错误'}`,
      });
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      if (epoch !== this.epoch) {
        ws.close();
        return;
      }
      this.attempts = 0;
      this.options.emit({ type: 'connection', state: 'open' });
      this.sendSessionUpdate(isRotation);
      // 到 30 分钟墙之前主动换会话。
      this.rotateTimer = setTimeout(
        () => void this.rotate(),
        Math.max(10_000, REALTIME_SESSION_LIMIT_MS - ROTATE_MARGIN_MS),
      );
      this.setActivity(this.micWanted ? 'listening' : 'idle');
    });

    ws.addEventListener('message', (event: MessageEvent) => {
      if (epoch !== this.epoch) return;
      if (typeof event.data !== 'string') return; // 协议里没有二进制帧
      let parsed: ServerEvent;
      try {
        parsed = parseServerEvent(event.data);
      } catch (error) {
        // parseServerEvent 承诺不抛；真抛了也不能让会话死掉。
        console.error('[RealtimeSession] 解析异常', error);
        return;
      }
      try {
        this.handle(parsed);
      } catch (error) {
        console.error('[RealtimeSession] 处理事件失败', parsed.type, error);
      }
    });

    ws.addEventListener('error', () => {
      if (epoch !== this.epoch) return;
      console.warn('[RealtimeSession] WebSocket error');
    });

    ws.addEventListener('close', (event: CloseEvent) => {
      if (epoch !== this.epoch) return;
      this.ws = null;
      this.clearTimers();
      this.speech.flush();
      if (this.closedByUs) {
        this.options.emit({ type: 'connection', state: 'closed' });
        return;
      }
      // 1000 既可能是服务端到点收摊，也可能是我们自己轮换 —— 轮换走 rotate()，
      // 到这里的 1000 一律按「意外」处理，但提示语区分开。
      const expected = event.code === 1000 || event.code === 1001;
      this.options.emit({
        type: 'connection',
        state: 'reconnecting',
        detail: expected ? '会话到期，正在重新连接' : `连接中断（${event.code}）`,
      });
      this.scheduleReconnect();
    });
  }

  private sendSessionUpdate(isRotation: boolean): void {
    let instructions = this.options.instructions;
    if (isRotation && this.options.summarize) {
      const summary = this.options.summarize(this.transcript);
      if (summary) {
        // 带摘要而不是全量 transcript：全量会把 30 分钟的对话重新灌一遍，
        // 又慢又贵，而且她会开始复述旧内容。
        instructions = `${instructions}\n\n# 刚才聊到哪了\n${summary}\n（这是上一段会话的摘要。不要主动提「我们重连了」这种事，自然接着聊。）`;
      }
    }
    const session: SessionConfig = {
      modalities: ['text', 'audio'],
      instructions,
      voice: this.options.voice,
      input_audio_format: 'pcm16',
      output_audio_format: 'pcm16',
      turn_detection: {
        type: 'server_vad',
        // 文档默认值在桌宠场景下不可用：silence_duration_ms 默认 **100ms**，
        // 说话里任何一个自然停顿都会被当成「说完了」，于是一句话被切成好几个回合；
        // energy_awakeness_threshold 默认 2500（范围 0–5000）在室内环境下偏低，
        // 键盘声、风扇、远处人声都能把她唤起来，噪声全进了对话。
        // 这里按「一句话说完再回」调：停顿容忍到 700ms，能量门限抬到 3400。
        prefix_padding_ms: 300,
        silence_duration_ms: 700,
        energy_awakeness_threshold: 3400,
      },
      input_audio_transcription: {
        model: 'stepaudio-3-asr-max',
        language: 'zh',
        hotwords: ['Step酱', '阶跃娘', '阶跃星辰', '星星笔记', '呆毛'],
      },
      tools: this.options.tools,
      tool_choice: 'auto',
    };
    this.send({ type: 'session.update', session });
  }

  private scheduleReconnect(): void {
    if (!this.started || this.closedByUs) return;
    this.attempts++;
    if (this.attempts > 8) {
      this.options.emit({
        type: 'connection',
        state: 'closed',
        detail: '多次重连失败，先歇一下。点一下她再试。',
      });
      return;
    }
    // 指数退避 + 抖动，避免服务端抖动时所有客户端同频重试。
    const delay = Math.min(15_000, 500 * 2 ** (this.attempts - 1)) + Math.random() * 400;
    this.reconnectTimer = setTimeout(() => void this.connect(true), delay);
  }

  /** 30 分钟墙前的静默重建。用户不应该察觉。 */
  private async rotate(): Promise<void> {
    if (this.rotating || !this.started) return;
    this.rotating = true;
    try {
      // 正在说话就等她说完，避免切在半句上。
      if (this.responseActive) {
        await new Promise((r) => setTimeout(r, 4000));
      }
      this.closedByUs = true;
      this.ws?.close(1000, 'rotate');
      this.ws = null;
      this.speech.flush();
      this.resetTurnState();
      await this.connect(true);
    } finally {
      this.rotating = false;
    }
  }

  /** 换音色 = 重建会话（首次出音后 voice 不可改）。 */
  async setVoice(voice: string): Promise<void> {
    if (voice === this.options.voice) return;
    this.options = { ...this.options, voice };
    if (!this.started) return;
    if (!this.hadAudioOutput && this.connected) {
      // 还没出过音，直接改就行，省一次重连。
      this.sendSessionUpdate(false);
      return;
    }
    await this.rotate();
  }

  setInstructions(instructions: string): void {
    this.options = { ...this.options, instructions };
    if (this.connected) this.sendSessionUpdate(false);
  }

  // ---- 发送 ----

  private send(event: ClientEvent): boolean {
    const ws = this.ws;
    if (ws?.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(event));
      return true;
    } catch (error) {
      console.warn('[RealtimeSession] 发送失败', event.type, error);
      return false;
    }
  }

  /** 打字输入。 */
  sendText(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    // 打字也算一次新回合：先把她正在说的掐掉，否则两段话会叠在一起。
    this.interrupt();
    this.transcript.push({ role: 'user', text: trimmed, at: Date.now() });
    this.options.emit({ type: 'user_transcript', text: trimmed, final: true });
    this.resetTurnState();
    this.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: trimmed }] },
    });
    this.send({ type: 'response.create' });
    this.setActivity('thinking');

    // 实测过的坑：她可能只是「口头答应」而不真的调工具。见 armToolNudge 的注释。
    this.armToolNudge(trimmed);
  }

  private nudgeToolCall(name: ToolName): void {
    console.info(`[RealtimeSession] 文字输入未触发 ${name}，补发 tool_choice:required。`);
    // 用系统消息说清楚「必须真的调」，再强制一次。失败就失败，不编造结果。
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'system',
        content: [
          {
            type: 'input_text',
            text: `上一轮你没有真的调用工具。用户的请求需要 ${name}。现在立刻调用它；如果你判断不该调用，就直接告诉用户你做不到，绝对不要声称自己已经做过。`,
          },
        ],
      },
    });
    this.send({ type: 'response.create' });
    this.awaitingToolFor = null;
  }

  /**
   * 打断。barge-in 的核心：必须同步完成本地止声，网络那一刀是顺带的。
   * 顺序很重要 —— 先 flush 本地再 cancel 远端，反过来会多播 200ms。
   */
  /** 人声持续这么久仍没出转写，也按真人处理 —— 不能让打断一直等 ASR。 */
  private static readonly BARGE_CONFIRM_MS = 400;

  private cancelBargeInTimer(): void {
    if (this.bargeInTimer) {
      clearTimeout(this.bargeInTimer);
      this.bargeInTimer = null;
    }
    this.pendingBargeIn = false;
  }

  /** VAD 说有人开口：先压音量，等确认。 */
  private beginBargeIn(): void {
    if (this.pendingBargeIn) return;
    // 她本来就没在说话，没什么要打断的，直接当新回合。
    if (!this.responseActive && this.speech.audioLevel <= 0) {
      this.interrupt();
      return;
    }
    this.pendingBargeIn = true;
    this.speech.duck();
    this.bargeInTimer = setTimeout(() => {
      this.bargeInTimer = null;
      if (this.pendingBargeIn) this.confirmBargeIn();
    }, RealtimeSession.BARGE_CONFIRM_MS);
  }

  /** 确认是真人声 → 执行不可逆的打断。 */
  private confirmBargeIn(): void {
    if (!this.pendingBargeIn) return;
    this.interrupt();
  }

  /** 判定为噪声误触发 → 恢复音量，让她把话说完。 */
  private cancelBargeIn(): void {
    this.cancelBargeInTimer();
    this.speech.unduck();
    if (this.responseActive) this.setActivity('speaking');
    else this.setActivity('idle');
  }

  interrupt(): void {
    this.cancelBargeInTimer();
    const hadAudio = this.speech.audioLevel > 0 || this.responseActive;
    this.speech.flush();
    this.speech.unduck();
    // 先立起丢弃闸门，再发 cancel —— cancel 之后还会有在途增量（实测 4 条）。
    this.suppressAudio = true;
    if (this.responseActive) this.send({ type: 'response.cancel' });
    this.responseActive = false;
    if (this.nudgeTimer) {
      clearTimeout(this.nudgeTimer);
      this.nudgeTimer = null;
    }
    this.awaitingToolFor = null;
    if (hadAudio) this.petPartial = '';
  }

  /**
   * 「她答应了却没真的调工具」的兜底。
   *
   * 实测过两次，两种输入都会：
   * - 文字「挪到右下角去吧」→ 正常发了 move_to。
   * - 语音「你能不能挪到屏幕右下角去，别挡着我了」→ 只说了「好的，我这就挪到右下角去」，
   *   **没有发任何 function call**。
   * 所以这不是文字输入独有的问题，语音回合也要兜。命中了就用
   * tool_choice:'required' 补一刀；补不成她会说「做不到」，而不是继续撒谎。
   */
  private armToolNudge(utterance: string): void {
    const expected = this.options.textNeedsTool?.(utterance) ?? null;
    this.awaitingToolFor = expected;
    if (!expected) return;
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
    this.nudgeTimer = setTimeout(() => {
      if (this.awaitingToolFor !== expected) return;
      if (this.toolCallsThisTurn > 0) return;
      this.nudgeToolCall(expected);
    }, TOOL_NUDGE_DELAY_MS);
  }

  private resetTurnState(): void {
    this.toolCallsThisTurn = 0;
    this.toolResults.clear();
    this.inFlightTools.clear();
  }

  // ---- 接收 ----

  private handle(event: ServerEvent): void {
    switch (event.type) {
      case 'session.created':
      case 'session.updated':
      case 'rate_limits.updated':
      case 'conversation.item.created':
      case 'conversation.item.deleted':
      case 'response.content_part.added':
      case 'response.content_part.done':
      case 'response.output_item.added':
      case 'input_audio_buffer.cleared':
      case 'input_audio_buffer.committed':
        return;

      case 'error': {
        const message = event.error.message ?? '语音服务返回了一个错误。';
        console.warn('[RealtimeSession] server error', event.error);
        this.options.emit({ type: 'error', message });
        return;
      }

      // ---- 打断：headline feature ----
      case 'input_audio_buffer.speech_started': {
        // 不立刻打断 —— 打断是不可逆的（flush + response.cancel 砍掉的音频回不来），
        // 而 VAD 会被咳嗽、键盘、关门声误触发。先压音量：听觉上已经是「她让你说」，
        // 再等确认（听到实际转写，或者人声持续超过 BARGE_CONFIRM_MS）才真打断。
        // 噪声那一下只会让音量抖一下，她会继续说完。
        this.beginBargeIn();
        this.userPartial = '';
        this.setActivity('listening');
        return;
      }
      case 'input_audio_buffer.speech_stopped': {
        // 还没确认就结束了 → 判定为误触发，恢复音量、让她接着说。
        if (this.pendingBargeIn) {
          this.cancelBargeIn();
          return;
        }
        this.setActivity('thinking');
        return;
      }

      // ---- 字幕 ----
      case 'conversation.item.input_audio_transcription.delta': {
        this.userPartial += event.delta ?? '';
        // 听到实际内容 = 确认是人在说话，这时才执行不可逆的打断。
        if (this.userPartial.trim()) this.confirmBargeIn();
        this.options.emit({ type: 'user_transcript', text: this.userPartial, final: false });
        return;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const text = (event.transcript ?? this.userPartial).trim();
        this.userPartial = '';
        if (!text) return;
        this.transcript.push({ role: 'user', text, at: Date.now() });
        this.options.emit({ type: 'user_transcript', text, final: true });
        // 语音回合同样会出现「嘴上答应、不调工具」，所以这里也要兜一刀。
        this.armToolNudge(text);
        return;
      }
      case 'response.audio_transcript.delta':
      case 'response.text.delta': {
        this.petPartial += event.delta ?? '';
        this.options.emit({ type: 'pet_transcript', text: this.petPartial, final: false });
        return;
      }
      case 'response.audio_transcript.done':
      case 'response.text.done': {
        const payload =
          event.type === 'response.audio_transcript.done' ? event.transcript : event.text;
        const text = (payload ?? this.petPartial).trim();
        this.petPartial = '';
        if (!text) return;
        this.transcript.push({ role: 'pet', text, at: Date.now() });
        this.options.emit({ type: 'pet_transcript', text, final: true });
        return;
      }

      case 'response.thinking.delta': {
        const text = event.delta ?? '';
        if (text) this.options.emit({ type: 'thinking', text });
        this.setActivity('thinking');
        return;
      }
      case 'response.thinking.done':
        return;

      // ---- 音频 ----
      case 'response.audio.delta': {
        // 被打断后在途的增量必须丢掉，否则刚清空的环又被填上。
        if (this.suppressAudio) return;
        this.hadAudioOutput = true;
        this.speech.enqueue(event.delta);
        return;
      }
      case 'response.audio.done':
        return;

      case 'response.created': {
        this.responseActive = true;
        // 新的一轮开始了，之前打断留下的在途音频已经结束。
        this.suppressAudio = false;
        this.resetTurnState();
        return;
      }
      case 'response.cancelled': {
        this.responseActive = false;
        return;
      }
      case 'response.done': {
        this.responseActive = false;
        const status = (event.response as { status?: string }).status;
        if (status === 'failed') {
          this.options.emit({ type: 'error', message: '这一轮没说完，再说一次试试。' });
        }
        if (!this.speech.audioLevel) {
          this.setActivity(this.micWanted ? 'listening' : 'idle');
        }
        return;
      }
      case 'response.output_item.done':
        return;

      // ---- 工具 ----
      case 'response.function_call_arguments.delta':
        return;
      case 'response.function_call_arguments.done': {
        void this.runTool({ callId: event.call_id, name: event.name, args: event.arguments });
        return;
      }

      case 'unknown': {
        // 服务端随时可能加事件。记一笔继续跑，绝不断会话。
        console.debug('[RealtimeSession] 未知事件', event.rawType);
        return;
      }
    }
  }

  private async runTool(call: PendingCall): Promise<void> {
    this.awaitingToolFor = null;
    const name = call.name as ToolName;

    // 幂等：同一个 call_id 重复到达（重试/重放）直接回上次结果，不重复执行副作用。
    const cached = this.toolResults.get(call.callId);
    if (cached) {
      this.replyTool(call.callId, cached, false);
      return;
    }
    if (this.inFlightTools.has(call.callId)) return;

    if (!toolNames.includes(name)) {
      this.replyTool(call.callId, { ok: false, message: `没有叫 ${call.name} 的工具。` }, true);
      return;
    }

    this.toolCallsThisTurn++;
    if (this.toolCallsThisTurn > MAX_TOOL_CALLS_PER_TURN) {
      const result: ToolResult = {
        ok: false,
        message: `这一轮已经用掉 ${MAX_TOOL_CALLS_PER_TURN} 次工具了，先把结果告诉用户，别再调了。`,
      };
      this.toolResults.set(call.callId, result);
      this.replyTool(call.callId, result, true);
      return;
    }

    let args: unknown;
    try {
      args = call.args.trim() ? JSON.parse(call.args) : {};
    } catch {
      this.replyTool(
        call.callId,
        { ok: false, message: '参数不是合法 JSON，重新调用一次。' },
        true,
      );
      return;
    }
    // 模型给的参数一律不可信。
    const schema = toolArgSchemas[name];
    const parsed = schema.safeParse(args);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join('.') || '参数'}: ${i.message}`)
        .join('；');
      this.replyTool(call.callId, { ok: false, message: `参数不合法（${detail}）。` }, true);
      return;
    }

    this.inFlightTools.add(call.callId);
    this.options.emit({ type: 'tool_start', name, args: parsed.data });
    let result: ToolResult;
    try {
      result = await this.options.executeTool(name, parsed.data);
    } catch (error) {
      result = {
        ok: false,
        message: `工具执行失败：${error instanceof Error ? error.message : '未知错误'}。如实告诉用户没做成。`,
      };
    } finally {
      this.inFlightTools.delete(call.callId);
    }
    this.toolResults.set(call.callId, result);
    this.options.emit({ type: 'tool_end', name, result });
    this.replyTool(call.callId, result, true);
  }

  /** 回灌工具结果并要求她继续说。 */
  private replyTool(callId: string, result: ToolResult, createResponse: boolean): void {
    const ok = this.send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(result) },
    });
    if (ok && createResponse) this.send({ type: 'response.create' });
  }

  // ---- 收摊 ----

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.rotateTimer) clearTimeout(this.rotateTimer);
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
    this.reconnectTimer = null;
    this.rotateTimer = null;
    this.nudgeTimer = null;
  }

  async stop(): Promise<void> {
    this.started = false;
    this.micWanted = false;
    this.closedByUs = true;
    this.epoch++;
    this.clearTimers();
    this.mic.stop();
    this.speech.flush();
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close(1000, 'stop');
    } catch {
      /* 已经关了 */
    }
    this.resetTurnState();
    this.responseActive = false;
    this.options.emit({ type: 'activity', value: 'idle' });
    this.options.emit({ type: 'connection', state: 'closed' });
  }

  async dispose(): Promise<void> {
    await this.stop();
    await this.speech.dispose();
  }
}
