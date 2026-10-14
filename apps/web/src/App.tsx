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
import { useInteraction } from './agent/useInteraction';
import { VoiceControls } from './audio/VoiceControls';
import { RoomObjects } from './room/RoomObjects';
import { SuggestionBar } from './room/SuggestionBar';
import { suggestionsFor, touchLabels, type InteractionInput } from '../../../shared/room';
import {
  expressions,
  motions,
  safeUrl,
  type Activity,
  type ChatRequest,
} from '../../../shared/protocol';
const toolTitles: Record<string, string> = {
  get_time: '查询时间',
  open_url: '网页链接',
  observe_scene: '观察房间',
  set_light: '调整台灯',
  water_plant: '给盆栽浇水',
  draw_discovery_card: '抽取发现卡',
  reveal_card: '揭晓答案',
  answer_card: '检查答案',
  start_timer: '启动倒计时',
  cancel_timer: '取消倒计时',
  move_to: '移动到物件旁',
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
  const conversation = useInteraction(controller.current);
  const {
    voice,
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
    model,
    setMode,
    live,
    auto,
    setAuto,
    autoCount,
    setAutoCount,
    lastActivity,
    interact,
    cancel,
    cancelAutonomy,
    clear,
    retry,
    canRetry,
  } = conversation;
  const scroll = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState(''),
    [assetError, setAssetError] = useState('');
  const [settings, setSettings] = useState(false),
    [collapsed, setCollapsed] = useState(false),
    [reduced, setReduced] = useState(false),
    [mouths, setMouths] = useState(true);
  const [greeting, setGreeting] = useState('今天，一起发现点什么？'),
    [background, setBackground] = useState('light'),
    [size, setSize] = useState(370),
    [anchor, setAnchor] = useState(false),
    [poseVersion, setPoseVersion] = useState(0),
    [suggestionPage, setSuggestionPage] = useState(0);
  const touchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceBusy = voice.mic !== 'idle' || voice.status !== 'idle';
  const latest = useRef({ input, busy, scene, interact, autoCount, voiceBusy });
  latest.current = { input, busy, scene, interact, autoCount, voiceBusy };
  useEffect(() => {
    if (voice.transcript) {
      setInput(voice.transcript);
      voice.setTranscript('');
      setCollapsed(false);
      lastActivity.current = Date.now();
    }
  }, [voice.transcript]);
  useEffect(() => {
    voice.stop();
  }, [mode]);
  const setState = (a: Activity) => {
    controller.current.setActivity(a);
    setActivity(a);
  };
  const handleInput = (event: InteractionInput) => {
    setCollapsed(false);
    void interact(event);
  };
  useEffect(() => {
    let alive = true;
    const rendererInstance = new PetRenderer(
      host.current!,
      controller.current,
      (s) => {
        if (alive) setAssetError(s);
      },
      (part) => {
        setGreeting(touchLabels[part] + '，收到你的招呼啦');
        if (touchTimer.current) clearTimeout(touchTimer.current);
        touchTimer.current = setTimeout(() => {
          void latest.current.interact({ kind: 'touch', part });
        }, 220);
      },
    );
    renderer.current = rendererInstance;
    void rendererInstance.init();
    return () => {
      alive = false;
      rendererInstance.destroy();
      if (touchTimer.current) clearTimeout(touchTimer.current);
    };
  }, []);
  useEffect(() => {
    renderer.current?.setSize(size);
  }, [size]);
  useEffect(() => {
    renderer.current?.setTarget(scene.petTarget);
  }, [scene.petTarget, scene.petMoveRevision]);
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
    controller.current.mouthEnabled = mouths;
  }, [mouths]);
  useEffect(() => {
    scroll.current?.scrollTo({ top: scroll.current.scrollHeight });
  }, [entries, busy, error]);
  useEffect(() => {
    if (!ready) return;
    const interval = setInterval(() => {
      const current = latest.current;
      if (document.hidden || current.busy || current.voiceBusy || current.input.trim()) return;
      if (current.scene.timer.status === 'running' && current.scene.timer.endsAt <= Date.now()) {
        void current.interact({ kind: 'timer_finished', timerId: current.scene.timer.id });
        return;
      }
      if (!auto || Date.now() - lastActivity.current < 22000) return;
      if (current.autoCount >= 6) {
        setAuto(false);
        return;
      }
      lastActivity.current = Date.now();
      setAutoCount((n) => n + 1);
      void current.interact({ kind: 'autonomy' });
    }, 1000);
    return () => clearInterval(interval);
  }, [auto, ready]);
  const toggleAuto = () => {
    if (auto) {
      setAuto(false);
      cancelAutonomy();
    } else {
      setAuto(true);
      setAutoCount(0);
      lastActivity.current = Date.now() - 19000;
    }
  };
  async function send(text = input, scenario: ChatRequest['scenario'] = 'normal', isRetry = false) {
    if (isRetry) {
      retry();
      return;
    }
    if (!text.trim()) return;
    setInput('');
    setCollapsed(false);
    await interact({ kind: 'text', text }, scenario);
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
          <p>
            自主探索由你开启，每次最多探索 6
            步。聊天与房间状态仅保留在本次会话内存，不读取其他窗口。
          </p>
        </section>
      )}
      <main className={`workspace ${collapsed ? 'chat-collapsed' : ''}`}>
        <section
          className={`stage room-stage ${background} ${scene.light.on ? 'lamp-on' : 'lamp-off'}`}
          aria-label="角色舞台"
        >
          <div className="stage-heading">
            <span className="presence">
              <i />
              {voice.mic === 'recording'
                ? '我在听'
                : voice.status === 'playing'
                  ? '正在说话'
                  : activityLabels[activity]}
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
          <RoomObjects scene={scene} interact={handleInput} ready={ready} />
          <div className="stage-orbit orbit-one" />
          <div className="stage-orbit orbit-two" />
          <Star className="stage-star star-one" size={23} />
          <span className="little-dot" />
          <Sparkles className="stage-star star-two" size={18} />
          <div className="autonomy-controls">
            <button role="switch" aria-checked={auto} onClick={toggleAuto} disabled={!ready}>
              <span className={`autonomy-switch ${auto ? 'enabled' : ''}`} />
              自主探索
            </button>
            <small>{auto ? `正在探索 · ${autoCount}/6 步` : '让她自己找点事做'}</small>
          </div>
          <div className="hello">
            <span>Step酱的小小探索室</span>
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
              <span className="tiny-star">✦</span> {goal}
            </span>
            <small>点点头顶、脸颊、徽章或手</small>
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
              <h2>一起发现点什么</h2>
            </div>
            <div>
              <button
                className="icon-button"
                title="清空会话"
                aria-label="清空会话"
                onClick={() => {
                  if (touchTimer.current) clearTimeout(touchTimer.current);
                  setInput('');
                  setGreeting('今天，一起发现点什么？');
                  renderer.current?.resetPosition();
                  clear();
                }}
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
                }}
              >
                <option value="mock">演示模式</option>
                <option value="live">真实模型{live ? '' : ' · 未配置'}</option>
              </select>
            </label>
            <small>
              {mode === 'mock' ? '预设回复 · 不消耗额度' : `${model || '模型'} · 在线对话`}
            </small>
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
                <span className="speaker">
                  {entry.role === 'user'
                    ? entry.source === 'autonomy'
                      ? '自主探索'
                      : entry.source === 'timer_finished'
                        ? '房间事件'
                        : entry.source === 'touch' || entry.source === 'action'
                          ? '你的互动'
                          : '你'
                    : 'Step酱'}
                </span>
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
                      <strong>{toolTitles[tool.name] ?? '工具请求'}</strong>
                      {tool.result?.ok && <Check size={15} />}
                    </div>
                    <p>
                      {(tool.name === 'observe_scene' && tool.result?.ok
                        ? '已检查灯光、盆栽、发现卡和计时器。'
                        : tool.result?.message) ??
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
              {canRetry && (
                <button disabled={busy} onClick={() => void send('', 'normal', true)}>
                  <RotateCcw size={14} />
                  重试
                </button>
              )}
            </div>
          )}
          {notice && (
            <p className="session-notice" role="status">
              {notice}
            </p>
          )}
          <SuggestionBar
            items={suggestions}
            busy={busy}
            ready={ready}
            onSelect={handleInput}
            onStop={cancel}
            onRotate={() => {
              setSuggestionPage((n) => n + 1);
              setSuggestions(suggestionsFor(scene, suggestionPage + 1));
            }}
          />
          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <VoiceControls
              voice={voice}
              live={mode === 'live'}
              ready={ready}
              onStart={() => {
                cancel();
                lastActivity.current = Date.now();
              }}
              onStop={cancel}
            />
            <div className="input-wrap">
              <textarea
                aria-label="给 Step酱发消息"
                placeholder="想到什么，就说什么吧…"
                value={input}
                maxLength={4000}
                onChange={(e) => {
                  voice.cancelRecording();
                  setInput(e.target.value);
                  if (!busy) setState(e.target.value ? 'listening' : 'idle');
                }}
                onBlur={() => {
                  if (!busy) setState('idle');
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              {(busy || voice.status !== 'idle') && (
                <button
                  type="button"
                  className="interrupt-stop"
                  aria-label="停止回复"
                  onClick={cancel}
                >
                  <Square size={15} />
                </button>
              )}
              <button
                type="submit"
                className="send-button"
                aria-label={busy ? '打断并发送' : '发送消息'}
                disabled={!input.trim() || !ready}
              >
                <ArrowUp size={21} />
              </button>
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
                  {[250, 350, 370, 430, 500].map((n) => (
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
