import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { ApiError, streamChat } from './AgentClient';
import {
  interactionSchema,
  type Activity,
  type ChatRequest,
  type ToolResult,
  type ChatEvent,
} from '../../../../shared/protocol';
import {
  createScene,
  sceneSchema,
  inputLabel,
  suggestionsFor,
  type Scene,
  type InteractionInput,
  type Suggestion,
} from '../../../../shared/room';
import type { PetController } from '../pet/PetController';
import { useVoice } from '../audio/useVoice';
export type Entry = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  source?: InteractionInput['kind'];
  state?: 'streaming' | 'completed' | 'failed' | 'cancelled';
  tools?: { id: string; name: string; result?: ToolResult }[];
};
export function useInteraction(controller: PetController) {
  const voice = useVoice(controller);
  const [entries, setEntries] = useState<Entry[]>([]),
    [scene, setScene] = useState<Scene>(createScene),
    [suggestions, setSuggestions] = useState<Suggestion[]>(() => suggestionsFor(createScene()));
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [activity, setActivity] = useState<Activity>('idle'),
    [goal, setGoal] = useState('等你一起探索'),
    [ready, setReady] = useState(false);
  const [mode, setMode] = useState<'mock' | 'live'>('mock'),
    [model, setModel] = useState(''),
    [live, setLive] = useState(false),
    [auto, setAuto] = useState(false),
    [autoCount, setAutoCount] = useState(0);
  const sessionId = useRef<string | null>(null),
    active = useRef<{
      id: string;
      abort: AbortController;
      chars: number;
      kind: InteractionInput['kind'];
    } | null>(null),
    alive = useRef(true),
    epoch = useRef(0),
    lastInput = useRef<InteractionInput | null>(null),
    lastActivity = useRef(Date.now());
  const pendingInterrupt = useRef<{ requestId: string; visibleChars: number } | undefined>(
    undefined,
  );
  const sceneRevision = useRef(0);
  const updateScene = (next: Scene) => {
    if (next.revision < sceneRevision.current) return;
    sceneRevision.current = next.revision;
    setScene(next);
    setSuggestions(suggestionsFor(next));
  };
  const initialize = useCallback(async () => {
    const version = ++epoch.current;
    setReady(false);
    try {
      const response = await fetch('/api/sessions', { method: 'POST' });
      if (!response.ok) throw Error('小房间暂时无法建立，请重试。');
      const data = z
        .object({ sessionId: z.string().uuid(), scene: sceneSchema })
        .parse(await response.json());
      if (!alive.current || version !== epoch.current) {
        void fetch(`/api/sessions/${data.sessionId}`, { method: 'DELETE' });
        return;
      }
      sessionId.current = data.sessionId;
      sceneRevision.current = data.scene.revision;
      setScene(data.scene);
      setSuggestions(suggestionsFor(data.scene));
      setReady(true);
      return data.sessionId;
    } catch {
      if (alive.current && version === epoch.current)
        setError('小房间连接失败，请点击清空重新连接。');
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    void initialize();
    fetch('/api/health')
      .then((r) => r.json())
      .then((data) => {
        if (alive.current) {
          setLive(data.liveConfigured);
          voice.setConfigured(!!data.audio?.configured);
          setModel(typeof data.model === 'string' ? data.model : '');
          setMode(data.liveConfigured ? 'live' : 'mock');
        }
      })
      .catch(() => {});
    const cleanupSession = () => {
      if (sessionId.current)
        void fetch(`/api/sessions/${sessionId.current}`, {
          method: 'DELETE',
          keepalive: true,
        }).catch(() => {});
    };
    window.addEventListener('pagehide', cleanupSession);
    return () => {
      alive.current = false;
      epoch.current++;
      active.current?.abort.abort();
      active.current = null;
      cleanupSession();
      sessionId.current = null;
      window.removeEventListener('pagehide', cleanupSession);
    };
  }, [initialize]);
  const finish = (id: string, state: 'completed' | 'failed' | 'cancelled') => {
    if (active.current?.id !== id) return;
    voice.finish(id, state === 'completed');
    controller.finish(id, state === 'completed');
    active.current = null;
    setBusy(false);
    setActivity('idle');
    setEntries((old) => old.map((e) => (e.id === id ? { ...e, state } : e)));
    lastActivity.current = Date.now();
  };
  const cancel = () => {
    voice.stop();
    const current = active.current;
    if (!current) return;
    const interrupted = { requestId: current.id, visibleChars: current.chars };
    pendingInterrupt.current = interrupted;
    const cancelledSession = sessionId.current;
    if (cancelledSession)
      void fetch(`/api/sessions/${cancelledSession}/interrupt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(interrupted),
      })
        .then((r) => r.json())
        .then((data) => {
          if (alive.current && sessionId.current === cancelledSession && data.scene)
            updateScene(sceneSchema.parse(data.scene));
        })
        .catch(() => {});
    current.abort.abort();
    finish(current.id, 'cancelled');
    setGoal('停下来，听你说');
  };
  async function interact(input: InteractionInput, scenario: ChatRequest['scenario'] = 'normal') {
    if (!sessionId.current || !ready) return;
    if (input.kind === 'autonomy' && (active.current || document.hidden)) return;
    const id = crypto.randomUUID();
    const check = interactionSchema.safeParse({
      requestId: id,
      sessionId: sessionId.current,
      mode,
      input,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      scenario,
    });
    if (!check.success) {
      setError('这次输入无效，文字最多 4000 字。');
      return;
    }
    cancel();
    lastActivity.current = Date.now();
    if (input.kind !== 'autonomy' && input.kind !== 'timer_finished') lastInput.current = input;
    const request = { ...check.data, interrupt: pendingInterrupt.current };
    pendingInterrupt.current = undefined;
    const abort = new AbortController();
    active.current = { id, abort, chars: 0, kind: input.kind };
    setBusy(true);
    setActivity('thinking');
    setError('');
    setNotice('');
    controller.begin(id);
    voice.begin(id, mode === 'live');
    if (input.kind === 'touch')
      controller.present(
        { expression: input.part === 'cheek' ? 'surprised' : 'happy', motion: 'bounce' },
        id,
      );
    setEntries((old) => [
      ...old.slice(-79),
      { id: crypto.randomUUID(), role: 'user', source: input.kind, content: inputLabel(input) },
      { id, role: 'assistant', content: '', state: 'streaming', tools: [] },
    ]);
    const onEvent = (event: ChatEvent) => {
      if (active.current?.id !== id || !alive.current) return;
      switch (event.type) {
        case 'text_delta':
          voice.append(id, event.delta);
          active.current.chars += event.delta.length;
          controller.text(id);
          setActivity('speaking');
          setEntries((old) =>
            old.map((e) => (e.id === id ? { ...e, content: e.content + event.delta } : e)),
          );
          break;
        case 'presentation':
          controller.present({ expression: event.expression, motion: event.motion }, id);
          break;
        case 'scene':
          updateScene(event.scene);
          break;
        case 'goal':
          setGoal(event.text);
          break;
        case 'suggestions':
          setSuggestions(event.items);
          break;
        case 'tool_start':
          setEntries((old) =>
            old.map((e) =>
              e.id === id
                ? {
                    ...e,
                    tools: [...(e.tools ?? []), { id: event.toolCallId, name: event.name }],
                  }
                : e,
            ),
          );
          break;
        case 'tool_end':
          setEntries((old) =>
            old.map((e) =>
              e.id === id
                ? {
                    ...e,
                    tools: e.tools?.map((t) =>
                      t.id === event.toolCallId ? { ...t, result: event.result } : t,
                    ),
                  }
                : e,
            ),
          );
          break;
        case 'error':
          setError(event.message);
          if (input.kind === 'autonomy') setAuto(false);
          break;
        case 'done':
          finish(
            id,
            event.status === 'completed'
              ? 'completed'
              : event.status === 'cancelled'
                ? 'cancelled'
                : 'failed',
          );
          break;
      }
    };
    try {
      try {
        await streamChat(request, abort.signal, onEvent);
      } catch (error) {
        // Only a pre-execution HTTP 410 is safe to retry. Never replay an interrupted stream.
        if (
          !(error instanceof ApiError) ||
          error.status !== 410 ||
          active.current?.id !== id ||
          abort.signal.aborted
        )
          throw error;
        voice.stop();
        setAuto(false);
        const renewed = await initialize();
        if (!renewed) throw Error('重新连接失败，请点击清空再试。');
        if (active.current?.id !== id || abort.signal.aborted || !alive.current) return;
        pendingInterrupt.current = undefined;
        setEntries((old) => old.slice(-2));
        setNotice('服务已重新连接，房间和聊天上下文已重置。');
        if (
          input.kind === 'autonomy' ||
          input.kind === 'timer_finished' ||
          (input.kind === 'action' && ['answer_card', 'reveal_card'].includes(input.action.name))
        ) {
          finish(id, 'cancelled');
          setGoal('新房间准备好了，再选一个互动吧');
          setNotice('服务已重新连接，房间已重置，请重新选择互动。');
          return;
        }
        voice.begin(id, mode === 'live');
        await streamChat(
          { ...request, sessionId: renewed, interrupt: undefined },
          abort.signal,
          onEvent,
        );
      }
    } catch (e) {
      if (active.current?.id !== id || !alive.current) return;
      setError(e instanceof Error ? e.message : '请求未完成。');
      finish(id, abort.signal.aborted ? 'cancelled' : 'failed');
      if (input.kind === 'autonomy') setAuto(false);
    }
  }
  function clear() {
    cancel();
    setAuto(false);
    setAutoCount(0);
    if (sessionId.current) void fetch(`/api/sessions/${sessionId.current}`, { method: 'DELETE' });
    sessionId.current = null;
    pendingInterrupt.current = undefined;
    setEntries([]);
    setError('');
    setNotice('');
    lastInput.current = null;
    setGoal('等你一起探索');
    controller.present({ expression: 'neutral', motion: 'idle' });
    void initialize();
  }
  const retry = () =>
    void interact({
      kind: 'text',
      text: '请接上刚才未完成的回复，保留已经发生的动作，不要重复执行。',
    });
  return {
    voice,
    model,
    entries,
    scene,
    suggestions,
    setSuggestions,
    error,
    notice,
    busy,
    activity,
    setActivity,
    goal,
    ready,
    mode,
    setMode,
    live,
    auto,
    setAuto,
    autoCount,
    setAutoCount,
    lastActivity,
    interact,
    cancel,
    cancelAutonomy: () => {
      if (active.current?.kind === 'autonomy') cancel();
    },
    clear,
    retry,
    canRetry: !!lastInput.current,
  };
}
