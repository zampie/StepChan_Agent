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
import { createBrain, type PetBrain } from './brain/chat';
import { TouchTalk } from './brain/touchTalk';
import { setSpeechRate } from './voice/SpeechStream';
import { RigRenderer } from './pet';
import { desktop } from './platform/desktop';
import { reportDiagnostic } from './platform/diagnostics';
import { Bubble } from './ui/Bubble';
import { popupPetMenu } from './ui/PetMenu';
import { defaultSettings, type Settings } from '../../../shared/desktop';
import type { ActionName, Expression, FxName } from '../../../shared/pet';
import type { PetEvent } from '../../../shared/brain';

const RIG_URL = `${import.meta.env.BASE_URL}rig/rig.json`;
/** petScale = 1 时角色的显示高度（px）。 */
const BASE_SIZE = 300;

export function App() {
  const hostRef = useRef<HTMLDivElement>(null);
  const rigRef = useRef<RigRenderer | null>(null);
  const brainRef = useRef<PetBrain | null>(null);
  const awarenessRef = useRef<Awareness | null>(null);
  // awareness 的抑制逻辑要读这些状态，但它不该反向依赖 brain/UI，
  // 所以用 ref 当只读探针喂给它。
  const busyRef = useRef(false);
  const typingRef = useRef(false);
  /** composing 的镜像，给事件回调读 —— 回调捕获的 state 是旧值。 */
  const composingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  /** Rust 命中轮询报的最后一个部位，轻点时用它选反应集合。 */
  const lastHitPart = useRef<string | null>(null);

  const [petText, setPetText] = useState('');
  const [userText, setUserText] = useState('');
  const [thinking, setThinking] = useState(false);
  /** 她的音频还在播。气泡靠它决定要不要开始倒计时。 */
  const [speaking, setSpeaking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 素材致命错误，单独存，不被临时错误覆盖。 */
  const [rigError, setRigError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState('');
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  /** 自增一次就重建大脑（换模式/换模型时用）。 */
  const [brainGeneration, setBrainGeneration] = useState(0);

  // 事件回调（托盘、热键）捕获的是旧 state，所以用 ref 做镜像。
  useEffect(() => {
    composingRef.current = composing;
  }, [composing]);

  const applyAppearance = useCallback((value: Settings) => {
    rigRef.current?.setSize(Math.round(BASE_SIZE * value.petScale));
    rigRef.current?.setReduceMotion(value.reduceMotion);
    // 语速是模块级的：这一下会立刻作用到正在说话的实例，也会让之后新建的
    // SpeechStream（RealtimeSession / ChatBrain 各自 new 的）自动带上倍率，
    // 所以那两条链路都不用改。
    setSpeechRate(value.speechRate);
  }, []);

  // ---- 渲染器 ----
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const rig = new RigRenderer({
      host,
      manifestUrl: RIG_URL,
      // 命中区**随姿势变**。原来推一张按 idle 立姿量的静态表，于是 sleep 侧躺时
      // 一个矩形都命中不到 → 整个窗口穿透，用户点不中她（实际报过的 bug）。
      // 现在由渲染器在换姿势时把该姿势的实测矩形发过来。
      onPoseRegions: (regions) => {
        void desktop.setHitRegions(regions).catch(() => {});
      },
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
  //
  // 实例由 createBrain 按 settings.brainMode 决定（realtime 或 chat），两者公开面
  // 由 PetBrain 约束、并有编译期断言保证一致，所以这里和下面的事件处理都不区分模式。
  // 换模式 = 换实例（brainGeneration 自增触发本 effect 重跑），因为两种模式的
  // 上下文权威不在同一边，原地切换要搬上下文 —— 那是混合模式才解决的问题。
  useEffect(() => {
    let cancelled = false;
    let brain: PetBrain | null = null;
    let unsubscribe: (() => void) | null = null;

    const handle = (event: PetEvent) => {
      const rig = rigRef.current;
      switch (event.type) {
        case 'pet_transcript':
          setPetText(event.text);
          setThinking(false);
          break;
        case 'user_transcript':
          setUserText(event.final ? '' : event.text);
          // 刻意**不**在这里清掉她的气泡。原来是「有任何转写就清」，于是环境噪声
          // 产生的半个字也能把她刚说的话瞬间抹掉。她的气泡由下一次回复覆盖，
          // 或者停止出声后自然消失 —— 看不完的回复是真 bug，气泡不及时让位只是观感。
          break;
        case 'thinking':
          setThinking(true);
          rig?.setExpression('curious');
          break;
        case 'activity':
          setThinking(event.value === 'thinking');
          setSpeaking(event.value === 'speaking');
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
          break;
        case 'tool_end':
          if (!event.result.ok) rig?.setExpression('confused');
          break;
        case 'link':
          setLink(event.url);
          break;
        case 'notice':
          // 不是错误，所以用提示气泡（和隐私提示同一条），不配红色告警样式。
          setNotice(event.message);
          window.setTimeout(() => setNotice(null), 5000);
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
    };

    void (async () => {
      const value = await desktop.getSettings();
      if (cancelled) return;
      setSettings(value);
      applyAppearance(value);
      brain = createBrain(value.brainMode);
      brainRef.current = brain;
      unsubscribe = brain.on(handle);
      // 关掉持续聆听时不要在启动就开麦 —— 麦克风权限留到第一次长按再申请。
      if (value.voiceEnabled) await brain.start(value.listening);
    })().catch((e: unknown) =>
      setError(e instanceof Error ? e.message : '启动失败。'),
    );

    return () => {
      cancelled = true;
      unsubscribe?.();
      brainRef.current = null;
      void brain?.dispose();
    };
  }, [applyAppearance, brainGeneration]);

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
        // 睡觉是**状态**不是一次性动作：只 playAction('sleep') 的话闲置摇摆和
        // 动作自动回位会把她顶起来，而且醒不过来（wake 得有对应的出口）。
        if (intent.kind === 'nap') rigRef.current?.setSleeping(true);
        if (intent.kind === 'wake') rigRef.current?.setSleeping(false);
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

  // ---- 设置的跨窗口同步 ----
  // 设置窗是另一个 webview，它改了设置这边不会自动知道（反之亦然）。
  // 用户看到的症状是「右键菜单和设置里同一个开关状态不一样」。
  useEffect(() => {
    return desktop.onSettingsChanged((next) => {
      setSettings(next);
      applyAppearance(next);
    });
  }, [applyAppearance]);

  // Rust 的命中轮询只用来**记录**光标压在哪个部位；反应由单击触发。
  //
  // 原来是一悬停就换表情，但那样光标路过她身上就会乱变，而且和「每单击一次
  // 换一个」冲突 —— 悬停反应会把洗牌袋提前消耗掉。
  useEffect(() => {
    return desktop.onHitTest((part) => {
      lastHitPart.current = part;
    });
  }, []);

  /** 打开输入框。必须同时激活应用：Accessory 策略下窗口不会自动成为 key window，
   *  不激活的话输入框根本点不中、也打不进字。 */
  const openComposer = useCallback(() => {
    setComposing(true);
    awarenessRef.current?.notifyInteraction();
    // 两件事都必需，缺一个就打不进字：
    // 1. 输入框在窗口底部，**在角色命中区之外** —— Rust 的光标轮询只在光标落在
    //    角色身上时才让窗口接收鼠标，所以输入框那片默认是穿透的，点击会穿到下层应用。
    //    必须强制进入交互态，直到输入框关闭。
    // 2. Accessory 策略下窗口不会自动成为 key window，不激活应用就拿不到键盘焦点。
    void (async () => {
      await desktop.setInteractive(true).catch(() => {});
      await desktop.focusPet().catch(() => {});
      // 必须等应用真的激活之后再 focus：窗口还不是 key window 的时候
      // autoFocus 会静默失效，表现就是「框在那儿但打不进字」。
      inputRef.current?.focus();
    })();
  }, []);

  const closeComposer = useCallback(() => {
    setComposing(false);
    setDraft('');
    typingRef.current = false;
    // 交还给 Rust 的命中轮询，否则整个窗口会一直吃掉点击、不再穿透。
    void desktop.setInteractive(null).catch(() => {});
  }, []);

  /**
   * 设置改动的唯一入口（右键菜单、托盘、设置窗都走这里）。
   *
   * 哪些改动需要重建语音会话是有依据的，不是保守起见全重建：
   * - voiceEnabled：从无到有要建会话，从有到无要停。
   * - voice（音色）：realtime 首次出音后 voice 不可改，只能重建。
   * - brainMode：换的是整个大脑实现，必须重建。
   * 其余（聆听模式、是否可打断、缩放、减少动效）都是会话内热生效，
   * 重建反而会打断正在说的话。
   */
  const applySettingsPatch = useCallback(
    (patch: Partial<Settings>) => {
      void (async () => {
        const next = await desktop.setSettings(patch);
        setSettings(next);
        applyAppearance(next);
        const brain = brainRef.current;
        if (!brain) return;

        if ('voiceEnabled' in patch) {
          if (next.voiceEnabled) await brain.start(true);
          else await brain.stop();
          return;
        }
        if ('voice' in patch) {
          await brain.setVoice(next.voice);
          return;
        }
        if ('brainMode' in patch || 'chatModel' in patch) {
          // 大脑换实现：由 reloadBrain 负责，这里只标记。
          setBrainGeneration((n) => n + 1);
          return;
        }
        await brain.refreshSettings();
      })().catch((e: unknown) =>
        setError(e instanceof Error ? e.message : '保存设置失败。'),
      );
    },
    [applyAppearance],
  );

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
      if (composingRef.current) closeComposer();
      else openComposer();
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
  // ---- 指针手势：一条 pointer 流上要同时分辨「轻点 / 长按说话 / 拖动」 ----
  //
  // 三者互斥，判定顺序是：先看有没有移动（移动 → 拖动），再看按了多久
  // （够久 → 长按说话），都不是才算轻点。
  //
  // 拖动不能在 pointerdown 就 startDragging：系统一接管，pointerup 就不再回到
  // webview，于是每次轻点都会变成拖动，「摸头」彻底没了。所以等移动超过阈值再移交。
  const gesture = useRef<{
    x: number;
    y: number;
    moved: boolean;
    talking: boolean;
    timer: number;
  } | null>(null);
  /** 移动超过这么多像素就算拖动，不再算点击或长按。 */
  const DRAG_THRESHOLD = 4;
  /** 按住这么久算长按说话。短于它的按压算轻点。 */
  const LONG_PRESS_MS = 260;
  /**
   * 两次轻点间隔小于此值时，第二次不再触发表情反应。
   *
   * 双击是"打开输入框"的手势，但它必然由两次 pointerup 组成，所以不处理的话
   * 一次双击会连换两次表情。刻意**不**用「延迟到确认不是双击再反应」的做法 ——
   * 那会给单击加上 250ms 的迟滞，桌宠这种交互里能明显感觉到。
   * 所以保留第一次的即时反馈，只吞掉第二次。
   */
  const TAP_DEDUPE_MS = 320;
  const lastTapAt = useRef(0);
  /** 被摸时让她开口的旁白生成器（带冷却，连点不刷屏）。 */
  const touchTalk = useRef(new TouchTalk());

  /** 收尾：无论是松手、取消还是指针离开，都必须保证麦克风被放掉。 */
  const finishGesture = useCallback(() => {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    window.clearTimeout(g.timer);
    rigRef.current?.setDragging(false);
    // 必须无条件关掉：pointercancel / pointerleave 也走这里，
    // 漏掉的话她会一直歪着头睁着眼、耳边挂着音符。
    rigRef.current?.setListeningHold(false);
    if (g.talking) {
      // 长按结束 → 提交这一轮（Brain 内部会判断是不是太短而丢弃）。
      brainRef.current?.endPushToTalk();
      return;
    }
    if (!g.moved) {
      const now = Date.now();
      const isSecondOfDouble = now - lastTapAt.current < TAP_DEDUPE_MS;
      lastTapAt.current = now;
      awarenessRef.current?.notifyInteraction();
      // 点一下就该醒。awareness 的 wake 意图会走模型（要等回复），
      // 但视觉上必须立刻醒，否则点了还躺着像卡住。
      rigRef.current?.setSleeping(false);
      // 双击的第二下不再换表情（见 TAP_DEDUPE_MS）。
      if (!isSecondOfDouble) {
        // 表情是即时的（零延迟）；开口要等模型，所以带冷却且她忙时跳过。
        rigRef.current?.reactToTap(lastHitPart.current);
        const line = touchTalk.current.narrate(lastHitPart.current, busyRef.current);
        if (line) void brainRef.current?.sendText(line).catch(() => {});
      }
    }
  }, []);

  const beginGesture = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      // 长按 = 按住说话的条件，**问大脑而不是读设置**。
      //
      // 原来写的是 `!settings.listening`，但 listening 默认是 true，而聪明模式
      // 根本没有「持续聆听」这回事（没有服务端 VAD）—— 于是长按在聪明模式下
      // 永远不成立，功能对默认设置的用户直接不可达。
      // 大脑的 listening getter 才是权威：realtime 跟随设置，chat 恒为 false。
      const brain = brainRef.current;
      // 语音整个关掉时长按**不能静默无事发生** —— 用户按住、说完、松手，
      // 界面毫无反应，看起来就是麦克风坏了（这正是实际发生过的误判）。
      // 所以这里给一条明确提示，而不是让条件判断悄悄吞掉这次长按。
      if (!settings.voiceEnabled) {
        gesture.current = { x: e.clientX, y: e.clientY, moved: false, talking: false, timer: 0 };
        setNotice('语音现在是关着的。右键菜单里打开「语音对话」就能跟我说话啦。');
        window.setTimeout(() => setNotice(null), 5000);
        return;
      }
      const pushToTalk = brain !== null && !brain.listening;
      const timer = pushToTalk
        ? window.setTimeout(() => {
            const g = gesture.current;
            if (!g || g.moved) return;
            g.talking = true;
            // 按住期间给一个明确的持续状态：侧倾 + 睁大眼 + 耳边音符。
            // 没有这个，用户按住之后完全不知道她有没有在听。
            rigRef.current?.setListeningHold(true);
            void brainRef.current?.beginPushToTalk().catch((err: unknown) => {
              rigRef.current?.setListeningHold(false);
              setError(err instanceof Error ? err.message : '麦克风打不开。');
            });
          }, LONG_PRESS_MS)
        : 0;
      gesture.current = { x: e.clientX, y: e.clientY, moved: false, talking: false, timer };
    },
    [settings.voiceEnabled],
  );

  const moveGesture = useCallback((e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g || g.moved) return;
    if (Math.hypot(e.clientX - g.x, e.clientY - g.y) < DRAG_THRESHOLD) return;
    g.moved = true;
    window.clearTimeout(g.timer);
    // 已经在说话了就不抢成拖动 —— 说话中轻微手抖不该把她拖走。
    if (g.talking) return;
    gesture.current = null;
    rigRef.current?.setDragging(true);
    awarenessRef.current?.notifyInteraction();
    void desktop.startDragging().catch(() => {});
    // 系统接管后收不到 pointerup，所以这里就把拖拽表现收掉，
    // 否则悬挂姿态会一直停在那儿。
    window.setTimeout(() => rigRef.current?.setDragging(false), 140);
  }, []);

  const send = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    closeComposer();
    awarenessRef.current?.notifyInteraction();
    void brainRef.current
      ?.sendText(text)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : '发送失败。'));
  }, [draft, closeComposer]);

  return (
    <>
      <div
        className="stage"
        ref={hostRef}
        aria-label="Step酱"
        onContextMenu={(e) => {
          e.preventDefault();
          void popupPetMenu(settings, {
            onType: openComposer,
            onPatchSettings: applySettingsPatch,
            onToggleSleep: (next) => {
              rigRef.current?.setSleeping(next);
              // 主动叫醒也算一次互动，否则空闲计时还在跑、马上又会自己睡回去。
              if (!next) awarenessRef.current?.notifyInteraction();
            },
            onOpenSettings: () => void desktop.openSettings().catch(() => {}),
            onMoveAside: () => {
              // 用户显式触发的位移才允许；模型没有这个工具（见 shared/brain.ts 头部）。
              awarenessRef.current?.notifyMoved('bottom_right');
              void desktop.moveToSpot('bottom_right').catch(() => {});
            },
            onQuit: () => void desktop.quit().catch(() => {}),
          }, rigRef.current?.sleeping ?? false).then((shown) => {
            // 原生菜单起不来时退回直接开输入框，不要让右键变成「什么都没发生」。
            if (!shown) openComposer();
          });
        }}
        // 双击 = 开/关输入框。
        onDoubleClick={() => (composingRef.current ? closeComposer() : openComposer())}
        onPointerDown={beginGesture}
        onPointerMove={moveGesture}
        onPointerUp={finishGesture}
        // pointercancel / pointerleave 也必须收尾，否则麦克风不放、
        // 系统的录音指示灯一直亮着。
        onPointerCancel={finishGesture}
        onPointerLeave={finishGesture}
      />
      <Bubble
        petText={petText}
        speaking={speaking}
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
            ref={inputRef}
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
                // 不可打断模式下，Esc 是用户唯一的「闭嘴」手段。
                brainRef.current?.interrupt();
                closeComposer();
              }
            }}
          />
          {/* 三种关法都给：× 最直观，Esc 给键盘用户，再双击一次和打开的手势对称。 */}
          <button
            type="button"
            className="composer-close"
            aria-label="关闭输入框"
            title="关闭（Esc）"
            onClick={closeComposer}
          >
            ×
          </button>
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

