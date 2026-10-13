import Markdown from 'react-markdown';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  Square,
  Sparkles,
  MessageCircle,
  Settings2,
  RotateCcw,
  Trash2,
  ChevronRight,
  ExternalLink,
  Clock,
  Check,
  FlaskConical,
  X,
  PanelRightClose,
  PanelRightOpen,
  Star,
} from 'lucide-react';
import { PetController } from './pet/PetController';
import { PetRenderer } from './pet/PetRenderer';
import { streamChat } from './agent/AgentClient';
import {
  expressions,
  motions,
  requestSchema,
  safeUrl,
  type Activity,
  type ChatRequest,
  type Message,
  type ToolResult,
} from '../../../shared/protocol';
type ToolCard = { id: string; name: string; result?: ToolResult };
type Entry = Message & {
  id: string;
  state?: 'streaming' | 'completed' | 'failed' | 'cancelled';
  tools?: ToolCard[];
};
const expressionLabels = ['平静', '开心', '困惑', '生气', '困倦', '惊讶'];
const activityLabels: Record<Activity, string> = {
  idle: '在这里陪你',
  listening: '我在听',
  thinking: '让我想一想',
  speaking: '正在回复',
};
export function App() {
  const debug = location.pathname === '/debug/pet';
  const host = useRef<HTMLDivElement>(null),
    renderer = useRef<PetRenderer | null>(null),
    controller = useRef(new PetController());
  const active = useRef<{ id: string; abort: AbortController } | null>(null),
    scroll = useRef<HTMLDivElement>(null);
  const [entries, setEntries] = useState<Entry[]>([]),
    [input, setInput] = useState(''),
    [error, setError] = useState(''),
    [assetError, setAssetError] = useState('');
  const [busy, setBusy] = useState(false),
    [activity, setActivity] = useState<Activity>('idle'),
    [mode, setMode] = useState<'mock' | 'live'>('mock');
  const [live, setLive] = useState(false),
    [settings, setSettings] = useState(false),
    [collapsed, setCollapsed] = useState(false),
    [reduced, setReduced] = useState(false),
    [mouths, setMouths] = useState(true);
  const [greeting, setGreeting] = useState('今天想从哪一步开始？'),
    [background, setBackground] = useState('light'),
    [size, setSize] = useState(430),
    [anchor, setAnchor] = useState(false),
    [poseVersion, setPoseVersion] = useState(0);
  const lastRequest = useRef<Message[] | null>(null),
    greetingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setState = (a: Activity) => {
    controller.current.setActivity(a);
    setActivity(a);
  };
  useEffect(() => {
    let alive = true;
    const r = new PetRenderer(
      host.current!,
      controller.current,
      (s) => {
        if (alive) setAssetError(s);
      },
      () => {
        setGreeting('嘿，我在！一起发现点新东西？');
        if (greetingTimer.current) clearTimeout(greetingTimer.current);
        greetingTimer.current = setTimeout(() => setGreeting('今天想从哪一步开始？'), 3500);
      },
    );
    renderer.current = r;
    void r.init();
    fetch('/api/health')
      .then((r) => r.json())
      .then((data) => {
        if (alive) {
          setLive(data.liveConfigured);
          if (data.liveConfigured) setMode('live');
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
      r.destroy();
      active.current?.abort.abort();
      active.current = null;
      if (greetingTimer.current) clearTimeout(greetingTimer.current);
    };
  }, []);
  useEffect(() => {
    renderer.current?.setSize(size);
  }, [size]);
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => {
      controller.current.reduced = reduced || media.matches;
    };
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [reduced]);
  useEffect(() => {
    scroll.current?.scrollTo({ top: scroll.current.scrollHeight });
  }, [entries, busy, error]);
  useEffect(() => {
    controller.current.mouthEnabled = mouths;
  }, [mouths]);
  const finish = (id: string, state: 'completed' | 'failed' | 'cancelled') => {
    if (active.current?.id !== id) return;
    controller.current.finish(id, state === 'completed');
    active.current = null;
    setBusy(false);
    setActivity('idle');
    setEntries((old) => old.map((e) => (e.id === id ? { ...e, state } : e)));
  };
  const cancel = () => {
    const current = active.current;
    if (!current) return;
    current.abort.abort();
    finish(current.id, 'cancelled');
  };
  const clear = () => {
    cancel();
    setEntries([]);
    setError('');
    lastRequest.current = null;
    controller.current.present({ expression: 'neutral', motion: 'idle' });
  };
  async function send(text = input, scenario: ChatRequest['scenario'] = 'normal', retry = false) {
    if (active.current || (!text.trim() && !retry)) return;
    let history: Message[];
    if (retry && lastRequest.current) history = lastRequest.current;
    else
      history = [
        ...entries
          .filter((e) => e.role === 'user' || e.state === 'completed')
          .filter((e) => e.content)
          .map(({ role, content }) => ({ role, content })),
        { role: 'user' as const, content: text.trim() },
      ];
    const id = crypto.randomUUID();
    const request = {
      requestId: id,
      mode,
      messages: history,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      scenario,
    };
    const validation = requestSchema.safeParse(request);
    if (!validation.success) {
      setError('单条最多 4000 字，会话最多 20 条、16000 字。请缩短输入或清空会话后重试。');
      return;
    }
    const abort = new AbortController();
    active.current = { id, abort };
    lastRequest.current = history;
    setError('');
    setInput('');
    setBusy(true);
    setActivity('thinking');
    controller.current.begin(id);
    setCollapsed(false);
    setEntries((old) => [
      ...old,
      ...(retry ? [] : [{ id: crypto.randomUUID(), role: 'user' as const, content: text.trim() }]),
      { id, role: 'assistant', content: '', state: 'streaming', tools: [] },
    ]);
    try {
      await streamChat(validation.data, abort.signal, (event) => {
        if (active.current?.id !== id) return;
        if (event.type === 'text_delta') {
          controller.current.text(id);
          setActivity('speaking');
          setEntries((old) =>
            old.map((e) => (e.id === id ? { ...e, content: e.content + event.delta } : e)),
          );
        } else if (event.type === 'presentation') {
          controller.current.present({ expression: event.expression, motion: event.motion }, id);
        } else if (event.type === 'tool_start') {
          setEntries((old) =>
            old.map((e) =>
              e.id === id
                ? { ...e, tools: [...(e.tools ?? []), { id: event.toolCallId, name: event.name }] }
                : e,
            ),
          );
        } else if (event.type === 'tool_end') {
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
        } else if (event.type === 'error') setError(event.message);
        else if (event.type === 'done')
          finish(
            id,
            event.status === 'completed'
              ? 'completed'
              : event.status === 'cancelled'
                ? 'cancelled'
                : 'failed',
          );
      });
    } catch (e) {
      if (active.current?.id !== id) return;
      if (abort.signal.aborted) finish(id, 'cancelled');
      else {
        setError(e instanceof Error ? e.message : '请求未完成，请重试。');
        finish(id, 'failed');
      }
    }
  }
  const debugUpdate = (fn: () => void) => {
    fn();
    setPoseVersion((v) => v + 1);
  };
  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="/">
          <span className="brand-icon">
            <Sparkles size={21} />
          </span>
          <strong>Step酱</strong>
          <span className="brand-note">你的小小探索伙伴</span>
        </a>
        <nav>
          <a href={debug ? '/' : '/debug/pet'}>
            <FlaskConical size={16} />
            {debug ? '返回陪伴' : '角色实验室'}
          </a>
          <button
            className="icon-button"
            aria-label="设置"
            aria-expanded={settings}
            onClick={() => setSettings(!settings)}
          >
            <Settings2 size={20} />
          </button>
        </nav>
      </header>
      {settings && (
        <section className="settings-panel">
          <div>
            <strong>陪伴设置</strong>
            <button
              className="icon-button"
              aria-label="关闭设置"
              onClick={() => setSettings(false)}
            >
              <X size={18} />
            </button>
          </div>
          <label>
            <input
              type="checkbox"
              checked={reduced}
              onChange={(e) => setReduced(e.target.checked)}
            />
            减少动态效果
          </label>
          <label>
            <input type="checkbox" checked={mouths} onChange={(e) => setMouths(e.target.checked)} />
            说话嘴型（仅平静表情）
          </label>
          <p>主动闲聊已关闭。不会读取其他窗口，也不会保存聊天或人物偏好。</p>
        </section>
      )}
      <main className={`workspace ${collapsed ? 'chat-collapsed' : ''}`}>
        <section className={`stage ${background}`} aria-label="角色舞台">
          <div className="stage-heading">
            <span className="presence">
              <i />
              {activityLabels[activity]}
            </span>
            <button
              className="icon-button"
              aria-label="重置角色位置"
              title="重置位置"
              onClick={() => renderer.current?.resetPosition()}
            >
              <RotateCcw size={17} />
            </button>
          </div>
          <div className="stage-orbit orbit-one" />
          <div className="stage-orbit orbit-two" />
          <Star className="stage-star star-one" size={23} />
          <span className="little-dot" />
          <Sparkles className="stage-star star-two" size={18} />
          <div className="hello">
            <span>你好呀，我是 Step酱</span>
            <h1>{greeting}</h1>
          </div>
          <div className="pet-area" ref={host} aria-label="Step酱，可在舞台内拖动" role="img" />
          {anchor && <div className="anchor-guide" />}
          {assetError && (
            <div className="asset-error" role="alert">
              {assetError}
            </div>
          )}
          <div className="pet-shadow" />
          <div className="stage-footer">
            <span>
              <span className="tiny-star">✦</span> 一起往前迈一步吧
            </span>
            <small>拖动我，换个位置</small>
          </div>
          {collapsed && (
            <button className="reopen" onClick={() => setCollapsed(false)}>
              <PanelRightOpen size={18} />
              打开聊天
            </button>
          )}
        </section>
        <section className="chat" aria-label="聊天面板" hidden={collapsed}>
          <header className="chat-header">
            <div>
              <MessageCircle size={19} />
              <h2>和 Step酱聊聊</h2>
            </div>
            <div>
              <button
                className="icon-button"
                title="清空会话"
                aria-label="清空会话"
                onClick={clear}
              >
                <Trash2 size={17} />
              </button>
              <button
                className="icon-button"
                aria-label="收起聊天"
                onClick={() => setCollapsed(true)}
              >
                <PanelRightClose size={18} />
              </button>
            </div>
          </header>
          <div className="mode-bar">
            <label>
              <span className={`mode-dot ${mode}`} />
              <select
                aria-label="对话模式"
                value={mode}
                disabled={busy}
                onChange={(e) => {
                  setMode(e.target.value as 'mock' | 'live');
                  setError('');
                }}
              >
                <option value="mock">演示模式</option>
                <option value="live">真实模型{live ? '' : ' · 未配置'}</option>
              </select>
            </label>
            <small>{mode === 'mock' ? '预设回复 · 不消耗额度' : 'Step 5 · 在线对话'}</small>
          </div>
          <div
            className="conversation"
            ref={scroll}
            role="log"
            aria-label="聊天记录"
            aria-live="polite"
          >
            <div className="welcome-message">
              <span className="avatar">
                <Sparkles size={18} />
              </span>
              <div>
                <span className="speaker">Step酱</span>
                <p>
                  世界上还有那么多不知道的事情呢。
                  <br />
                  有什么新想法，或者只是想聊聊天？
                </p>
              </div>
            </div>
            {entries.length === 0 && (
              <div className="starter-list">
                <p>从一件小事开始</p>
                {[
                  {
                    icon: <Sparkles size={16} />,
                    label: '分享一个有趣的冷知识',
                    text: '分享一个有趣的冷知识',
                  },
                  { icon: <Clock size={16} />, label: '现在几点了？', text: '现在几点了？' },
                  {
                    icon: <MessageCircle size={16} />,
                    label: '今天有一点累',
                    text: '今天有一点累',
                  },
                ].map((item) => (
                  <button key={item.label} onClick={() => void send(item.text)}>
                    {item.icon}
                    <span>{item.label}</span>
                    <ChevronRight size={16} />
                  </button>
                ))}
              </div>
            )}
            {entries.map((entry) => (
              <div className={`message ${entry.role}`} key={entry.id}>
                <span className="speaker">{entry.role === 'user' ? '你' : 'Step酱'}</span>
                {entry.content && (
                  <div className="message-text">
                    <Markdown
                      skipHtml
                      components={{
                        img: ({ alt }) => <span>{alt ? `[图片：${alt}]` : '[图片]'}</span>,
                        a: ({ href, children }) =>
                          href && safeUrl(href) ? (
                            <a href={safeUrl(href)!} target="_blank" rel="noopener noreferrer">
                              {children}
                            </a>
                          ) : (
                            <span>{children}</span>
                          ),
                      }}
                    >
                      {entry.content}
                    </Markdown>
                  </div>
                )}
                {entry.tools?.map((tool) => (
                  <div className="tool-card" key={tool.id}>
                    <div>
                      {tool.name === 'get_time' ? <Clock size={16} /> : <ExternalLink size={16} />}
                      <strong>
                        {tool.name === 'get_time'
                          ? '查询时间'
                          : tool.name === 'open_url'
                            ? '网页链接'
                            : '工具请求'}
                      </strong>
                      {tool.result?.ok && <Check size={15} />}
                    </div>
                    <p>
                      {tool.result?.message ??
                        (entry.state === 'streaming' ? '正在处理…' : '处理已中断')}
                    </p>
                    {tool.result?.url && safeUrl(tool.result.url) && (
                      <>
                        <code>{safeUrl(tool.result.url)}</code>
                        <a
                          href={safeUrl(tool.result.url)!}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          打开网页 <ExternalLink size={13} />
                        </a>
                      </>
                    )}
                  </div>
                ))}
                {entry.state === 'streaming' && !entry.content && (
                  <div className="thinking">
                    <span />
                    <span />
                    <span />
                    <small>让我理一下思路</small>
                  </div>
                )}
                {entry.state === 'cancelled' && (
                  <small className="incomplete">已停止 · 内容未完成</small>
                )}
                {entry.state === 'failed' && <small className="incomplete">回复未完成</small>}
              </div>
            ))}
          </div>
          {error && (
            <div className="error-banner" role="alert">
              <p>{error}</p>
              {lastRequest.current && (
                <button disabled={busy} onClick={() => void send('', 'normal', true)}>
                  <RotateCcw size={14} />
                  重试
                </button>
              )}
            </div>
          )}
          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <div className="input-wrap">
              <textarea
                aria-label="给 Step酱发消息"
                placeholder="想到什么，就说什么吧…"
                value={input}
                maxLength={4000}
                onChange={(e) => {
                  setInput(e.target.value);
                  if (!busy) setState(e.target.value ? 'listening' : 'idle');
                }}
                onBlur={() => {
                  if (!busy) setState('idle');
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    if (!busy) void send();
                  }
                }}
              />
              {busy ? (
                <button
                  type="button"
                  className="send-button stop"
                  aria-label="停止回复"
                  onClick={cancel}
                >
                  <Square size={17} />
                </button>
              ) : (
                <button
                  type="submit"
                  className="send-button"
                  aria-label="发送消息"
                  disabled={!input.trim()}
                >
                  <ArrowUp size={21} />
                </button>
              )}
            </div>
            <div className="composer-foot">
              <span>Enter 发送 · Shift + Enter 换行</span>
              <span>{input.length > 3500 ? `${input.length}/4000` : '只在此刻，不保存聊天'}</span>
            </div>
          </form>
        </section>
      </main>
      <footer className="page-footer">
        <span>
          <i />
          安静陪伴，随时出发
        </span>
        <span>Step酱的探索空间</span>
      </footer>
      {debug && (
        <section className="debug-panel">
          <header>
            <div>
              <h2>角色实验室</h2>
              <p>
                所有表现控制均不调用模型。嘴型已通过 250 / 350 / 500px 检查，仅在 neutral 上启用。
              </p>
            </div>
            <code data-testid="pet-state">
              {controller.current.expression} / {controller.current.motion} / {activity}{' '}
              <span hidden>{poseVersion}</span>
            </code>
          </header>
          <div className="debug-grid">
            <fieldset>
              <legend>完整表情</legend>
              {expressions.map((e, i) => (
                <button
                  key={e}
                  onClick={() => debugUpdate(() => controller.current.present({ expression: e }))}
                >
                  {expressionLabels[i]} · {e}
                </button>
              ))}
            </fieldset>
            <fieldset>
              <legend>整体动作</legend>
              {motions.map((m) => (
                <button key={m} onClick={() => debugUpdate(() => controller.current.play(m))}>
                  {m}
                </button>
              ))}
              <button onClick={() => debugUpdate(() => controller.current.cancelMotion())}>
                停止动作
              </button>
              <p>blink / wave / 独立头部与呆毛：缺少素材，未启用。</p>
            </fieldset>
            <fieldset>
              <legend>Activity 与嘴型</legend>
              {(['idle', 'listening', 'thinking', 'speaking'] as Activity[]).map((a) => (
                <button key={a} onClick={() => setState(a)}>
                  {a}
                </button>
              ))}
              <select
                aria-label="嘴型预览"
                defaultValue="none"
                onChange={(e) =>
                  debugUpdate(() => {
                    controller.current.previewMouth =
                      e.target.value === 'none' ? null : (e.target.value as 'closed');
                  })
                }
              >
                <option value="none">隐藏嘴型</option>
                <option value="closed">closed</option>
                <option value="open_small">open_small</option>
                <option value="open_big">open_big</option>
              </select>
              <p>只在 neutral 上显示。其它表情立即隐藏。</p>
            </fieldset>
            <fieldset>
              <legend>显示检查</legend>
              <label>
                背景
                <select
                  aria-label="舞台背景"
                  value={background}
                  onChange={(e) => setBackground(e.target.value)}
                >
                  <option value="light">浅色</option>
                  <option value="dark">深色</option>
                  <option value="checker">棋盘格</option>
                </select>
              </label>
              <label>
                画布尺寸
                <select
                  aria-label="角色尺寸"
                  value={size}
                  onChange={(e) => setSize(Number(e.target.value))}
                >
                  {[250, 350, 430, 500].map((n) => (
                    <option key={n} value={n}>
                      {n}px
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={anchor}
                  onChange={(e) => setAnchor(e.target.checked)}
                />
                中心参考线
              </label>
              <button onClick={() => renderer.current?.simulateMissing()}>
                模拟 happy 资源缺失
              </button>
            </fieldset>
            <fieldset>
              <legend>Mock 故障场景</legend>
              {(['normal', 'error', 'disconnect', 'slow'] as const).map((s) => (
                <button
                  key={s}
                  disabled={busy || mode !== 'mock'}
                  onClick={() => void send('测试请求', s)}
                >
                  {s}
                </button>
              ))}
              <p>slow 可测试等待和取消；disconnect 会保留部分文本并恢复可输入。</p>
            </fieldset>
          </div>
        </section>
      )}
    </div>
  );
}
