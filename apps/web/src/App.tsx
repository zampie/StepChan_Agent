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
import { TouchTalk, isBusyActivity } from './brain/touchTalk';
import { RigRenderer } from './pet';
import { desktop } from './platform/desktop';
import { reportDiagnostic } from './platform/diagnostics';
import { Bubble } from './ui/Bubble';
import { popupPetMenu } from './ui/PetMenu';
import {
  connectionFeedback,
  escapeAction,
  intentDisposition,
  longPressPlan,
  sessionSyncFor,
  shouldListenAfterWake,
} from './ui/uiState';
import { defaultSettings, type Settings } from '../../../shared/desktop';
import type { ActionName, Expression, FxName } from '../../../shared/pet';
import type { PetEvent } from '../../../shared/brain';

const RIG_URL = `${import.meta.env.BASE_URL}rig/rig.json`;
/** petScale = 1 时角色的显示高度（px）。 */
const BASE_SIZE = 300;
/**
 * 用户说完之后自己那条气泡的兜底停留时长。
 *
 * 正常由 turn_start 收掉（她一开口就让位），这个值只在「她没有回应」时起作用。
 * 取 6 秒：够看清自己被听成了什么（ASR 听错时这是唯一的线索），
 * 又不会在没人理的时候一直挂着。
 */
const USER_TEXT_LINGER_MS = 6000;

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
  /**
   * 她睡着了。
   *
   * 原来这个状态只存在渲染器里（rigRef.current.sleeping），于是气泡层压根看不到它。
   * 现在抬到 React state：睡着时要**不聆听、不显示气泡**，这两件事都在这一层。
   */
  const [sleeping, setSleeping] = useState(false);
  const sleepingRef = useRef(false);
  const [draft, setDraft] = useState('');
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  /**
   * 已经同步到会话上的那份设置。
   *
   * 设置有三条写入路径（右键菜单、设置窗、托盘），其中两条只能靠 Rust 的广播
   * 通知到这边，而广播是**发给所有窗口的，包括发起方** —— 直接调用那条路径会和
   * 广播撞在一起。用这个快照去算差异，后到的那次自然退化成空操作，
   * 不会重开麦克风、也不会重连两次。state 不行：事件回调捕获的是旧值。
   */
  const syncedRef = useRef<Settings>(defaultSettings);
  /** 自增一次就重建大脑（换模式/换模型时用）。 */
  const [brainGeneration, setBrainGeneration] = useState(0);

  // 提示/错误各只有一个 timer handle。
  //
  // 原来每处都现场 `window.setTimeout(() => setNotice(null), ...)` 又不存 handle，
  // 于是两条提示叠在一起时，先到的那个 timer 会把**后到的**提示提前抹掉
  // （看起来就是「提示一闪就没了」）。卸载时也没人清，React 会抱怨更新已卸载组件。
  const noticeTimer = useRef(0);
  const errorTimer = useRef(0);
  /** 用户气泡的保险超时。见 armUserTextExpiry。 */
  const userTextTimer = useRef(0);
  const showNotice = useCallback((text: string, ms = 4000) => {
    window.clearTimeout(noticeTimer.current);
    setNotice(text);
    noticeTimer.current = window.setTimeout(() => setNotice(null), ms);
  }, []);
  const showError = useCallback((text: string, ms = 5000) => {
    window.clearTimeout(errorTimer.current);
    setError(text);
    // ms = 0 表示不自动消失 —— 启动失败这类「她根本动不了」的问题不该自己溜走。
    if (ms > 0) errorTimer.current = window.setTimeout(() => setError(null), ms);
  }, []);
  const clearUserTextExpiry = useCallback(() => {
    window.clearTimeout(userTextTimer.current);
    userTextTimer.current = 0;
  }, []);

  /**
   * 转写定稿之后，用户自己的那条气泡最多留多久。
   *
   * 正常情况下它由 turn_start 收掉（她一开口就让位）。但**她不一定会回应** ——
   * 环境噪声被转写成一句话、或者这一轮在服务端丢了，都不会有 turn_start。
   * 没有这个兜底的话气泡就永久留在屏幕上，正好是刚修掉的那个 bug
   * （清空路径只剩一条，一旦那条不走就再也清不掉）。
   */
  const armUserTextExpiry = useCallback(
    (text: string) => {
      clearUserTextExpiry();
      if (!text) return;
      userTextTimer.current = window.setTimeout(() => setUserText(''), USER_TEXT_LINGER_MS);
    },
    [clearUserTextExpiry],
  );

  /**
   * 进入/退出睡眠的**唯一**入口。
   *
   * 原来四处（自动打盹、点击唤醒、右键菜单、awareness 的 wake 意图）各自
   * 直接调 `rig.setSleeping()`，而睡眠要同时管三件事：动画、麦克风、气泡。
   * 散着写必然漏 —— 这正是这个仓库反复踩的那类坑（同一个事实有多个写入点）。
   *
   * 睡着时：
   * - **不聆听**。disableMic() 而不是改 listening 设置 —— 睡觉是临时状态，
   *   不该把用户的开关给改了，醒来要原样恢复。
   * - **不显示气泡**，并且把在途文本清掉（否则醒来会弹出一条睡前的残留）。
   * - 正在说的话掐掉：手动「去睡吧」可能发生在她说话中间。
   */
  const applySleep = useCallback(
    (next: boolean) => {
      if (sleepingRef.current === next) return;
      sleepingRef.current = next;
      setSleeping(next);
      rigRef.current?.setSleeping(next);
      const brain = brainRef.current;
      if (next) {
        setPetText('');
        setUserText('');
        setThinking(false);
        clearUserTextExpiry();
        brain?.interrupt();
        brain?.disableMic();
        return;
      }
      // 醒来：按用户**当前的设置**恢复聆听，而不是记一份睡前快照 ——
      // 她睡着这段时间里用户完全可能去设置里改了语音开关。
      if (brain && shouldListenAfterWake(syncedRef.current)) {
        void brain.enableMic().catch(() => {
          // 麦克风恢复失败有自己的报错路径（onError），这里不重复弹。
        });
      }
    },
    [clearUserTextExpiry],
  );

  useEffect(
    () => () => {
      window.clearTimeout(noticeTimer.current);
      window.clearTimeout(errorTimer.current);
      window.clearTimeout(userTextTimer.current);
    },
    [],
  );

  /**
   * 让她开口的唯一入口（被摸的旁白、主动搭话、输入框发送都走这里）。
   *
   * 原来三处 sendText 各写一遍错误处理，其中两处是 `.catch(() => {})` ——
   * 于是「点了表情变了但不说话」查不出原因，她的主动搭话 / 拖放反应 / 空闲行为
   * **整层失败静默**（点了、表情变了、就是不出声，日志里什么都没有）。
   * 任何让她开不了口的情况都必须冒到界面上，哪怕只是一句笼统的提示。
   */
  const speak = useCallback(
    (text: string) => {
      const brain = brainRef.current;
      if (!brain) {
        showError('她还没准备好说话（大脑没启动）。', 4000);
        return;
      }
      void brain.sendText(text).catch((e: unknown) => {
        showError(e instanceof Error ? e.message : '她这次没说出话来。', 5000);
      });
    },
    [showError],
  );

  // 事件回调（托盘、热键）捕获的是旧 state，所以用 ref 做镜像。
  useEffect(() => {
    composingRef.current = composing;
  }, [composing]);

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
          // final 时**不要立刻清空**。原来写的是 `event.final ? '' : event.text`，
          // 而短句子（「嗯」「好」「停」）常常只来一条 completed、没有中间 delta ——
          // 于是唯一一次赋值就是清空，用户说完话自己的气泡压根没出现过。
          // 现在留着，由两件事收掉它：她开始回应（turn_start），或者保险超时。
          setUserText(event.text);
          if (event.final) armUserTextExpiry(event.text);
          // 刻意**不**在这里清掉她的气泡。原来是「有任何转写就清」，于是环境噪声
          // 产生的半个字也能把她刚说的话瞬间抹掉。她的气泡由下一次回复覆盖，
          // 或者停止出声后自然消失 —— 看不完的回复是真 bug，气泡不及时让位只是观感。
          break;
        case 'thinking':
          setThinking(true);
          rig?.setExpression('curious');
          break;
        case 'turn_start':
          // 新一轮回复开始 → 收掉上一轮的两个气泡。
          //
          // 这件事原来是 UI 自己按「活动状态跨进忙」的边沿推断的，而**同一次
          // 交互里可能有第二个 response**（工具回调之后那次、VAD 吞掉语音事件
          // 那次），它不经过 thinking —— 于是字幕先到、边沿后到，UI 把刚到的
          // 新字幕当成上一句清掉了。症状是「只有语音，没有气泡」。
          // 回合边界只有会话层知道，所以改成由它显式通知（见 shared/brain.ts）。
          setPetText('');
          setUserText('');
          clearUserTextExpiry();
          break;
        case 'activity':
          setThinking(event.value === 'thinking');
          setSpeaking(event.value === 'speaking');
          // 语义见 isBusyActivity 的注释（这个判断错过一次，所以有测试钉住）。
          busyRef.current = isBusyActivity(event.value);
          if (event.value === 'idle') {
            setUserText('');
            clearUserTextExpiry();
          }
          break;
        case 'privacy_notice':
          // 隐私动作必须可见 —— 这条提示不是装饰，是 AGENTS.md 的要求。
          showNotice(noticeText(event.action, event.reason), 4000);
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
          showNotice(event.message, 5000);
          break;
        case 'connection': {
          // 'reconnecting' 原来完全不处理，重连期间界面一动不动 —— 用户只知道
          // 「跟她说话没反应」，和麦克风坏了长得一模一样。要不要提示看 detail，
          // 判断逻辑在 connectionFeedback（有测试钉住，别在这儿再分支一遍）。
          const feedback = connectionFeedback(event.state, event.detail);
          if (feedback.kind === 'clear') {
            window.clearTimeout(errorTimer.current);
            setError(null);
          } else if (feedback.kind === 'notice') showNotice(feedback.text, 5000);
          else if (feedback.kind === 'error') showError(feedback.text, 6000);
          break;
        }
        case 'error':
          showError(event.message, 6000);
          break;
        default:
          break;
      }
    };

    void (async () => {
      const value = await desktop.getSettings();
      if (cancelled) return;
      setSettings(value);
      // 大脑就是按这份设置建起来的，所以它同时是「已同步」的基准 ——
      // 不种下去的话，第一次广播会拿默认值当上一份去比，凭空算出一次重建。
      syncedRef.current = value;
      applyAppearance(value);
      brain = createBrain(value.brainMode);
      brainRef.current = brain;
      unsubscribe = brain.on(handle);
      // 关掉持续聆听时不要在启动就开麦 —— 麦克风权限留到第一次长按再申请。
      if (value.voiceEnabled) await brain.start(value.listening);
    })().catch((e: unknown) =>
      showError(e instanceof Error ? e.message : '启动失败。', 0),
    );

    return () => {
      cancelled = true;
      unsubscribe?.();
      brainRef.current = null;
      void brain?.dispose();
    };
  }, [applyAppearance, brainGeneration, showNotice, showError]);

  // ---- 主动感知（看应用、接拖放、空闲行动） ----
  // Awareness 只产出意图，由这里决定要不要真的让她开口 —— 它不认识 brain，也不认识渲染器。
  useEffect(() => {
    const awareness = new Awareness({
      desktop,
      probe: {
        // 睡着也算「忙」：空闲行为和前台反应都查这个探针，睡觉时不该生成意图
        // （白跑一次模型调用，而且结果会被 onIntent 丢掉）。
        // 不会因此卡住唤醒 —— wake 意图是 notifyInteraction() 直接产出的，不过这道闸。
        busy: () => busyRef.current || sleepingRef.current,
        userTyping: () => typingRef.current,
        visible: () => document.visibilityState === 'visible',
      },
      onIntent: (intent) => {
        // 睡觉是**状态**不是一次性动作：只 playAction('sleep') 的话闲置摇摆和
        // 动作自动回位会把她顶起来，而且醒不过来（wake 得有对应的出口）。
        // 状态转换统一走 applySleep —— 它同时管动画、麦克风和气泡。
        // 睡着时谁能出声，判断在 intentDisposition（有测试钉住）。
        const disposition = intentDisposition(intent.kind, sleepingRef.current);
        if (disposition === 'ignore') return;
        if (disposition === 'sleep') {
          applySleep(true);
          return; // 刻意不说台词，见 intentDisposition 的注释
        }
        if (disposition === 'wake-and-speak') applySleep(false);
        // 背后发生过隐私读取的意图，必须先冒提示再说话。
        if (intent.privacy) showNotice(noticeText(intent.privacy, ''), 4000);
        // 原来这里是 `.catch(() => {})`，于是主动搭话、拖放反应、空闲行为的失败
        // 全都无声无息。统一走 speak()，和被摸开口那条路一个处理方式。
        speak(intent.prompt);
      },
    });
    awarenessRef.current = awareness;
    void awareness.start();
    return () => {
      awarenessRef.current = null;
      awareness.stop();
    };
  }, [showNotice, speak, applySleep]);

  /**
   * 把一份新设置应用到界面**和正在进行的会话**上。设置的三条写入路径全部汇到这里。
   *
   * 为什么要汇到一处：原来只有右键菜单那条会调 refreshSettings()，设置窗和托盘
   * 都只是广播新值、这边收到后只更新缓存、不动会话 —— 于是在设置窗里关掉
   * 「允许说话打断她」**完全无效**，她照常被打断（用户实际报上来的 bug）；
   * 「持续聆听」「音色」「大脑模式」「语音对话」在设置窗里改同样全部静默失效，
   * 界面上开关是关的、行为还是开的，没人能看出哪儿断了。
   *
   * 为什么不干脆只留广播这一条路（那样只有一条路径，更干净）：
   * 浏览器调试路径的 onSettingsChanged 是 noop（见 platform/desktop.ts 的
   * browserFallback），而且 Tauri 的 listen 要等动态 import 完才注册，启动早期的
   * 广播会漏。所以直接调用那条留着，靠 syncedRef 的差异去重 —— Rust 的 emit 是
   * 发给所有窗口的（包括发起方），两条路必然撞上，谁先到谁干活，后到的那次
   * 算出 'none' 就什么都不做，不会重开麦克风、也不会重连两次。
   *
   * 不会转圈：refreshSettings() 只是读设置再推下去（Brain.loadSettings 不回写），
   * 不触发新的广播。
   */
  const syncSession = useCallback(
    (next: Settings) => {
      const prev = syncedRef.current;
      syncedRef.current = next;
      setSettings(next);
      applyAppearance(next);
      // 哪些差异要动会话、哪些不用，判断在 sessionSyncFor（有测试钉住，
      // 别在这儿再分支一遍 —— 原来就是分支散在三处才漏掉两条）。
      const action = sessionSyncFor(prev, next);
      if (action === 'none') return;
      if (action === 'rebuild') {
        // 换大脑实现：由大脑那个 effect 重跑负责，这里只标记。
        setBrainGeneration((n) => n + 1);
        return;
      }
      const brain = brainRef.current;
      if (!brain) return;
      void (async () => {
        if (action === 'start') await brain.start(true);
        else if (action === 'stop') await brain.stop();
        else if (action === 'voice') await brain.setVoice(next.voice);
        else await brain.refreshSettings();
      })().catch((e: unknown) =>
        showError(e instanceof Error ? e.message : '设置没能应用到这次会话。', 5000),
      );
    },
    [applyAppearance, showError],
  );

  // ---- 设置的跨窗口同步 ----
  // 设置窗是另一个 webview，它改了设置这边不会自动知道（反之亦然）。
  // 不同步的症状有两层：轻的是「右键菜单和设置里同一个开关状态不一样」，
  // 重的是设置窗里的改动根本不生效 —— 所以这里必须走 syncSession，而不是只 setSettings。
  useEffect(() => desktop.onSettingsChanged(syncSession), [syncSession]);

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
   * 设置改动的唯一入口（右键菜单用）。
   *
   * 写完之后立刻 syncSession：哪些改动需要重连/换音色/重建大脑由它按差异决定，
   * 不是保守起见全重建（重建会打断她正在说的话）。
   */
  const applySettingsPatch = useCallback(
    (patch: Partial<Settings>) => {
      void desktop
        .setSettings(patch)
        .then(syncSession)
        .catch((e: unknown) =>
          showError(e instanceof Error ? e.message : '保存设置失败。', 5000),
        );
    },
    [syncSession, showError],
  );

  // ---- 托盘、热键、拖放 ----
  const reloadSettings = useCallback(async () => {
    const next = await desktop.getSettings();
    syncSession(next);
    return next;
  }, [syncSession]);

  useEffect(() => {
    const fail = (e: unknown) =>
      showError(e instanceof Error ? e.message : '操作失败。', 5000);

    const offTray = desktop.onTrayCommand((command) => {
      void (async () => {
        // 托盘是设置的权威写入方（Rust 侧直接写，再把菜单 id 转发过来），
        // 所以这里先重读 —— reloadSettings 走 syncSession，顺带把该做的事
        // （开/停语音、换音色、换大脑、改缩放）按差异做掉。
        //
        // 原来这里自己写了 voice / voice_* 两个分支，和右键菜单那条重复了一遍，
        // 而且漏掉了 brainMode 和缩放。现在只留托盘独有的那件事：开输入框。
        await reloadSettings();
        if (command === 'talk') {
          openComposer();
          if (!brainRef.current?.running) await brainRef.current?.start(true);
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
  }, [reloadSettings, openComposer, closeComposer, showError]);

  // ---- Esc：让她闭嘴 ----
  //
  // 监听必须挂在 window 上。原来全仓**唯一**的 Esc 监听在输入框的 onKeyDown 里，
  // 于是「不可打断模式下按 Esc 让她停下」要先双击她把输入框点出来才按得到 ——
  // 而设置里和会话层的文案都是直接告诉用户「按 Esc 或长按她」，两条路当时都不通。
  //
  // 一次 Esc 只干一件事（分派见 escapeAction）：输入框开着就只关框。
  // 原来那处是 interrupt() + closeComposer() 一起做，想关打字框顺手把她掐断了。
  //
  // 注意这是**窗口级**而不是系统级监听：桌宠窗不是 key window 时收不到键盘事件，
  // 所以 Esc 只在应用处于活动状态时有效。刻意不去 Rust 侧注册全局 Esc ——
  // 那会把 Esc 从所有别的应用手里抢走。长按她是不依赖焦点的那条退路。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (escapeAction(composingRef.current) === 'close-composer') closeComposer();
      else brainRef.current?.interrupt();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closeComposer]);

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
      applySleep(false);
      // 双击的第二下不再换表情（见 TAP_DEDUPE_MS）。
      if (!isSecondOfDouble) {
        // 表情是即时的（零延迟）；开口要等模型，所以带冷却且她忙时跳过。
        rigRef.current?.reactToTap(lastHitPart.current);
        const line = touchTalk.current.narrate(lastHitPart.current, busyRef.current);
        // 原来这里是 .catch(() => {}) 把错误吞了，于是「点了表情变了但不说话」
        // 完全查不出原因。任何让她开不了口的情况都要说出来 —— 处理统一在 speak()。
        if (line) speak(line);
      }
    }
  }, [speak]);

  const beginGesture = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      // 手指一按下就先叫醒她。
      //
      // 必须在这里而不是只在 pointerup 的点击分支里：睡着时麦克风是关的，
      // 而长按走的是 beginPushToTalk() —— 持续聆听模式下它只把活动状态切成
      // 「在听」就返回（麦克风本来该是开着的）。不先唤醒的话用户按住、说完、
      // 松手，界面显示在听、实际一个字都没收，又是一次无声失败。
      applySleep(false);
      // 长按要不要启动，判断在 longPressPlan（有测试钉住）。
      //
      // 这里**刻意不再看聆听模式**。原来是 `brain !== null && !brain.listening`，
      // 而 listening 默认 true → pushToTalk 恒为 false → 定时器压根不启动 →
      // beginPushToTalk() 永远不被调用。于是设置里和会话层都写着的
      // 「想让她停下，按 Esc 或长按她」对默认设置的用户完全不可达，
      // 而 RealtimeSession 里那段「持续聆听下长按当『闭嘴听我说』」成了死代码。
      // 两种模式的语义差别由会话层 beginPushToTalk() 自己分辨，手势层不替它判断。
      const plan = longPressPlan({
        voiceEnabled: settings.voiceEnabled,
        hasBrain: brainRef.current !== null,
      });
      if (plan === 'voice-off') {
        // 语音整个关掉时长按**不能静默无事发生** —— 用户按住、说完、松手，
        // 界面毫无反应，看起来就是麦克风坏了（这正是实际发生过的误判）。
        gesture.current = { x: e.clientX, y: e.clientY, moved: false, talking: false, timer: 0 };
        showNotice('语音现在是关着的。右键菜单里打开「语音对话」就能跟我说话啦。', 5000);
        return;
      }
      const timer =
        plan === 'hold'
          ? window.setTimeout(() => {
              const g = gesture.current;
              if (!g || g.moved) return;
              g.talking = true;
              // 按住期间给一个明确的持续状态：侧倾 + 睁大眼 + 耳边音符。
              // 没有这个，用户按住之后完全不知道她有没有在听。
              rigRef.current?.setListeningHold(true);
              void brainRef.current?.beginPushToTalk().catch((err: unknown) => {
                rigRef.current?.setListeningHold(false);
                showError(err instanceof Error ? err.message : '麦克风打不开。', 5000);
              });
            }, LONG_PRESS_MS)
          : 0;
      gesture.current = { x: e.clientX, y: e.clientY, moved: false, talking: false, timer };
    },
    [settings.voiceEnabled, showNotice, showError, applySleep],
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
    // 走 speak()：原来这里的错误用 setError 直接写、没有人清，一条发送失败的
    // 红字会一直挂在她头上。
    speak(text);
  }, [draft, closeComposer, speak]);

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
              applySleep(next);
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
          }, sleeping).then((shown) => {
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
        sleeping={sleeping}
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
              // Esc 不在这儿处理：监听挂在 window 上（见上面那个 effect），
              // 否则输入框开着时一次 Esc 会被两处各处理一遍。
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

