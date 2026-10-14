// 桌宠窗口的集成层。
//
// 这里是唯一把三块缝起来的地方：
//   brain/    —— 实时语音会话、工具执行（对外只发 PetEvent）
//   pet/      —— Pixi 骨架渲染器（吃表情/口型/动作）
//   platform/ —— 系统能力（命中区、托盘、热键、拖放）
// 三块互相不 import，所以各自可以独立演进，耦合只落在本文件。
//
// 窗口是透明无边框的，界面只有「角色 + 气泡 + 偶尔出现的输入框」，没有聊天记录面板 ——
// 桌面不是聊天窗。
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Awareness } from './awareness';
import { Brain } from './brain/Brain';
import { RigRenderer } from './pet';
import { desktop } from './platform/desktop';
import hitRegions, { asTouchPart } from './platform/hitRegions';
import { reportDiagnostic } from './platform/diagnostics';
import { Bubble } from './ui/Bubble';
import { defaultSettings, type Settings } from '../../../shared/desktop';
import type { ActionName, Expression, FxName, Spot, TouchPart } from '../../../shared/pet';
import type { PetEvent } from '../../../shared/brain';

const RIG_URL = `${import.meta.env.BASE_URL}rig/rig.json`;
/** petScale = 1 时角色的显示高度（px）。 */
const BASE_SIZE = 300;

/** 部位被摸到时的即时表现。台词由大脑决定，这里只保证手感上立刻有反馈。 */
const TOUCH_REACTION: Record<TouchPart, { expression: Expression; fx?: FxName }> = {
  head: { expression: 'shy', fx: 'heart' },
  cheek: { expression: 'happy', fx: 'sparkle' },
  badge: { expression: 'proud', fx: 'sparkle' },
  hand: { expression: 'curious' },
};

export function App() {
  const hostRef = useRef<HTMLDivElement>(null);
  const rigRef = useRef<RigRenderer | null>(null);
  const brainRef = useRef<Brain | null>(null);
  const awarenessRef = useRef<Awareness | null>(null);
  // awareness 的抑制逻辑要读这些状态，但它不该反向依赖 brain/UI，
  // 所以用 ref 当只读探针喂给它。
  const busyRef = useRef(false);
  const typingRef = useRef(false);

  const [petText, setPetText] = useState('');
  const [userText, setUserText] = useState('');
  const [thinking, setThinking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 素材致命错误，单独存，不被临时错误覆盖。 */
  const [rigError, setRigError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState('');
  const [settings, setSettings] = useState<Settings>(defaultSettings);

  const applyAppearance = useCallback((value: Settings) => {
    rigRef.current?.setSize(Math.round(BASE_SIZE * value.petScale));
    rigRef.current?.setReduceMotion(value.reduceMotion);
  }, []);

  // ---- 渲染器 ----
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const rig = new RigRenderer({
      host,
      manifestUrl: RIG_URL,
      // 素材错误单独存：它是致命的（角色根本不出现），不能被凭据之类的
      // 临时错误覆盖掉，否则现场只剩"桌宠不显示"这一个没有指向性的症状。
      onError: (message) => {
        setRigError(message);
        reportDiagnostic(`rig: ${message} (manifestUrl=${RIG_URL})`);
      },
    });
    rigRef.current = rig;
    void rig.init().then(() => {
      reportDiagnostic(
        `rig ready: canvas=${rig.canvas ? 'yes' : 'no'} host=${host.clientWidth}x${host.clientHeight} degraded=${rig.degraded.length}`,
      );
    });
    return () => {
      rigRef.current = null;
      rig.destroy();
    };
  }, []);

  // 口型由实际播放音量驱动，所以每帧从 brain 读一次，不走事件（事件频率跟不上口型）。
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const brain = brainRef.current;
      const rig = rigRef.current;
      if (brain && rig) rig.setAudioLevel(brain.running ? brain.audioLevel : null);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ---- 大脑 ----
  useEffect(() => {
    const brain = new Brain();
    brainRef.current = brain;

    const unsubscribe = brain.on((event: PetEvent) => {
      const rig = rigRef.current;
      switch (event.type) {
        case 'pet_transcript':
          setPetText(event.text);
          setThinking(false);
          break;
        case 'user_transcript':
          setUserText(event.final ? '' : event.text);
          // 只有听清了实际内容才收掉她的气泡。原来是「有任何转写就清」，
          // 于是一点环境噪声产生的半个字也会把她刚说的话瞬间抹掉 —— 看起来就是「一闪而过」。
          if (event.text.trim().length >= 2) setPetText('');
          break;
        case 'thinking':
          setThinking(true);
          rig?.setExpression('curious');
          break;
        case 'activity':
          setThinking(event.value === 'thinking');
          busyRef.current = event.value !== 'idle';
          if (event.value === 'idle') setUserText('');
          break;
        case 'privacy_notice':
          // 隐私动作必须可见 —— 这条提示不是装饰，是 AGENTS.md 的要求。
          setNotice(noticeText(event.action, event.reason));
          window.setTimeout(() => setNotice(null), 4000);
          break;
        case 'tool_start':
          if (event.name === 'express') applyVisualIntent(rig, event.args);
          // 她自己挪了位置，要同步给空闲行为，否则它可能再把她挪到原地。
          if (event.name === 'move_to') {
            const spot = (event.args as { spot?: Spot }).spot;
            if (spot) awarenessRef.current?.notifyMoved(spot);
          }
          break;
        case 'tool_end':
          if (!event.result.ok) rig?.setExpression('confused');
          break;
        case 'link':
          setLink(event.url);
          break;
        case 'connection':
          if (event.state === 'open') setError(null);
          else if (event.state === 'closed' && event.detail) setError(event.detail);
          break;
        case 'error':
          setError(event.message);
          window.setTimeout(() => setError(null), 6000);
          break;
        default:
          break;
      }
    });

    void desktop
      .getSettings()
      .then(async (value) => {
        setSettings(value);
        applyAppearance(value);
        if (value.voiceEnabled) await brain.start(true);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : '启动失败。'));

    return () => {
      unsubscribe();
      brainRef.current = null;
      void brain.dispose();
    };
  }, [applyAppearance]);

  // ---- 主动感知（看应用、接拖放、空闲行动） ----
  // Awareness 只产出意图，由这里决定要不要真的让她开口 —— 它不认识 brain，也不认识渲染器。
  useEffect(() => {
    const awareness = new Awareness({
      desktop,
      probe: {
        busy: () => busyRef.current,
        userTyping: () => typingRef.current,
        visible: () => document.visibilityState === 'visible',
      },
      onIntent: (intent) => {
        // 背后发生过隐私读取的意图，必须先冒提示再说话。
        if (intent.privacy) {
          setNotice(noticeText(intent.privacy, ''));
          window.setTimeout(() => setNotice(null), 4000);
        }
        if (intent.kind === 'nap') rigRef.current?.playAction('sleep');
        if (intent.kind === 'wake') rigRef.current?.playAction('idle');
        void brainRef.current?.sendText(intent.prompt).catch(() => {});
      },
    });
    awarenessRef.current = awareness;
    void awareness.start();
    return () => {
      awarenessRef.current = null;
      awareness.stop();
    };
  }, []);

  // ---- 命中区推给 Rust ----
  // 穿透判定必须在 Rust 侧（见 hittest.rs 顶部），这里只负责把表喂过去。
  useEffect(() => {
    void desktop.setHitRegions(hitRegions);
  }, []);

  // 被摸到时立刻有反应，不等模型回话。
  useEffect(() => {
    let last = '';
    return desktop.onHitTest((part) => {
      const key = part ?? '';
      if (key === last) return;
      last = key;
      const touch = asTouchPart(part);
      if (!touch) return;
      awarenessRef.current?.notifyInteraction();
      const reaction = TOUCH_REACTION[touch];
      rigRef.current?.setExpression(reaction.expression);
      if (reaction.fx) rigRef.current?.spawnFx(reaction.fx);
    });
  }, []);

  /** 打开输入框。必须同时激活应用：Accessory 策略下窗口不会自动成为 key window，
   *  不激活的话输入框根本点不中、也打不进字。 */
  const openComposer = useCallback(() => {
    setComposing(true);
    awarenessRef.current?.notifyInteraction();
    void desktop.focusPet().catch(() => {});
  }, []);

  // ---- 托盘、热键、拖放 ----
  const reloadSettings = useCallback(async () => {
    const next = await desktop.getSettings();
    setSettings(next);
    applyAppearance(next);
    return next;
  }, [applyAppearance]);

  useEffect(() => {
    const fail = (e: unknown) => setError(e instanceof Error ? e.message : '操作失败。');

    const offTray = desktop.onTrayCommand((command) => {
      void (async () => {
        // 托盘是设置的权威写入方，所以这里先重读，再按新值动作。
        const next = await reloadSettings();
        const brain = brainRef.current;
        if (!brain) return;
        if (command === 'talk') {
          openComposer();
          if (!brain.running) await brain.start(true);
        } else if (command === 'voice') {
          if (next.voiceEnabled) await brain.start(true);
          else await brain.stop();
        } else if (command.startsWith('voice_')) {
          // 换音色要重建会话：模型首次出音后 voice 不可改。
          await brain.setVoice(next.voice);
        }
      })().catch(fail);
    });

    const offHotkey = desktop.onHotkey(() => {
      setComposing((on) => {
        if (on) return false;
        openComposer();
        return true;
      });
      if (!brainRef.current?.running) void brainRef.current?.start(true).catch(fail);
    });

    // 拖放的反应交给 awareness 的 DropReactor（它自己订阅了 onDragDrop 并生成意图），
    // 这里只补一个即时的视觉反馈，不重复生成台词。
    const offDrop = desktop.onDragDrop(() => {
      rigRef.current?.setExpression('surprised');
      rigRef.current?.spawnFx('exclaim');
      awarenessRef.current?.notifyInteraction();
    });

    return () => {
      offTray();
      offHotkey();
      offDrop();
    };
  }, [reloadSettings, openComposer]);

  // ---- 文字输入 ----
  // 拖动：移动超过阈值才交给系统接管。
  //
  // 不能在 pointerdown 就调 startDragging —— 系统一接管，pointerup 就不会回到 webview，
  // 于是「轻点摸头」会全部变成拖动。所以先记起点，等真的拖了几像素再移交。
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const DRAG_THRESHOLD = 4;

  const beginDrag = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    dragStart.current = { x: e.clientX, y: e.clientY };
  }, []);

  const maybeDrag = useCallback((e: React.PointerEvent) => {
    const start = dragStart.current;
    if (!start) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < DRAG_THRESHOLD) return;
    dragStart.current = null;
    rigRef.current?.setDragging(true);
    awarenessRef.current?.notifyInteraction();
    void desktop.startDragging().catch(() => {});
    // 系统接管后收不到 pointerup，所以这里立刻把拖拽表现收掉，
    // 不然挤压拉伸会一直停在拖拽姿态。
    window.setTimeout(() => rigRef.current?.setDragging(false), 120);
  }, []);

  const endDrag = useCallback(() => {
    dragStart.current = null;
    rigRef.current?.setDragging(false);
  }, []);

  const send = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    setComposing(false);
    typingRef.current = false;
    awarenessRef.current?.notifyInteraction();
    void brainRef.current
      ?.sendText(text)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : '发送失败。'));
  }, [draft]);

  return (
    <>
      <div
        className="stage"
        ref={hostRef}
        aria-label="Step酱"
        // 右键 = 打字。桌宠没有菜单栏也没有输入框常驻，右键是最顺手的入口。
        onContextMenu={(e) => {
          e.preventDefault();
          openComposer();
        }}
        onPointerDown={beginDrag}
        onPointerMove={maybeDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />
      <Bubble
        petText={petText}
        userText={userText}
        thinking={thinking}
        notice={notice}
        link={link}
        error={rigError ?? error}
        onOpenLink={(url) => {
          setLink(null);
          void desktop.openUrl(url);
        }}
      />
      {composing && (
        <div className="composer">
          <input
            autoFocus
            value={draft}
            placeholder={settings.voiceEnabled ? '说话，或者打字…' : '打字跟她说…'}
            onChange={(e) => {
              setDraft(e.target.value);
              // 用户在打字时不要插话 —— awareness 的抑制逻辑读这个。
              typingRef.current = e.target.value.length > 0;
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') send();
              if (e.key === 'Escape') {
                setDraft('');
                setComposing(false);
                typingRef.current = false;
              }
            }}
          />
        </div>
      )}
    </>
  );
}

/** express 工具只描述「想表达什么」，怎么插值由渲染器决定。参数已由大脑用 zod 校验过。 */
function applyVisualIntent(rig: RigRenderer | null, args: unknown) {
  if (!rig || typeof args !== 'object' || args === null) return;
  const intent = args as { expression?: Expression; action?: ActionName; fx?: FxName };
  if (intent.expression) rig.setExpression(intent.expression);
  if (intent.action) rig.playAction(intent.action);
  if (intent.fx) rig.spawnFx(intent.fx);
}

function noticeText(action: 'screen' | 'clipboard' | 'frontmost', reason: string): string {
  const what =
    action === 'screen'
      ? '看了一眼你的屏幕'
      : action === 'clipboard'
        ? '读了一次剪贴板'
        : '看了下你在用哪个应用';
  return reason ? `${what}：${reason}` : what;
}

