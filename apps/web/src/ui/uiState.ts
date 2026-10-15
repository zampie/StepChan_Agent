// 桌宠界面里那些「判断」的纯函数。
//
// 为什么要单独一个文件：App.tsx 是 React + Pixi 的集成层，node 里起不来，所以写在
// 它里面的判断**一行测试都盖不住**。而这个仓库反复踩的坑恰好全是这种判断 ——
// 门控条件写反（`!brain.listening` 门控长按，默认 listening=true 于是长按永远不启动）、
// 分支漏一个 case（设置广播只更新缓存不同步会话，于是设置窗里改开关全部静默无效）。
// 症状一律是**无声失败**，只能靠人肉发现。
//
// 所以凡是能脱开 DOM 的判断都挪到这里，由 tests/ui-state.test.ts 钉住。
// 反之，需要 DOM / React 状态的部分留在 App.tsx，这里不碰。
import type { Settings } from '../../../../shared/desktop';

// ---- 设置改动 → 正在进行的会话要做什么 ----

/**
 * 一次设置改动需要对会话做的动作。
 *
 * - `rebuild`  换大脑实现（realtime ↔ chat、换 chat 模型），必须换实例
 * - `start` / `stop`  语音从无到有 / 从有到无
 * - `voice`   换音色（realtime 首次出音后 voice 不可改，底下会重建连接）
 * - `refresh` 会话内热生效（聆听模式、是否可打断、各项隐私开关）
 * - `none`    纯外观或没有实质变化，不要碰会话
 */
export type SessionSync = 'none' | 'rebuild' | 'start' | 'stop' | 'voice' | 'refresh';

/**
 * 改了**不需要**动会话的键。
 *
 * 刻意把白名单放在「不用刷」这一侧，而不是列出「要刷」的键：以后加设置项时
 * 漏登记的后果是多刷一次 instructions（无害），而不是新开关静默不生效 ——
 * 后者这个仓库已经踩过两次（Rust 白名单漏键、广播不同步会话），
 * 症状都是「开关点了没反应」，没人能从界面上看出哪儿断了。
 *
 * petScale / reduceMotion 由 applyAppearance 直接作用在渲染器上；
 * hotkey 是 Rust 侧注册的，webview 这边无事可做。
 */
const COSMETIC_KEYS: readonly string[] = ['petScale', 'reduceMotion', 'hotkey'];

/**
 * 比较前后两份设置，得出会话要做的动作。
 *
 * **按差异而不是按 patch 的键**决定动作，是因为设置有三条写入路径
 * （右键菜单、设置窗、托盘），只有第一条拿得到 patch；另两条只能收到
 * 「新的完整设置」。按差异算的话三条路径可以共用同一段逻辑，
 * 而且把同一份设置重复喂进来是天然的空操作 —— 直接调用和广播回来撞在一起时
 * 后到的那次自动退化成 `none`，不会重开麦克风或者重连两次。
 */
export function sessionSyncFor(prev: Settings, next: Settings): SessionSync {
  // 换大脑实现优先于一切：新实例自己会按新设置建起来，别的差异不用在这儿管。
  if (prev.brainMode !== next.brainMode || prev.chatModel !== next.chatModel) return 'rebuild';
  if (prev.voiceEnabled !== next.voiceEnabled) return next.voiceEnabled ? 'start' : 'stop';
  // 语音整个关着：没有会话可同步，等用户打开语音时再按那份设置建。
  if (!next.voiceEnabled) return 'none';
  if (prev.voice !== next.voice) return 'voice';
  return changedBeyondCosmetics(prev, next) ? 'refresh' : 'none';
}

function changedBeyondCosmetics(prev: Settings, next: Settings): boolean {
  for (const key of Object.keys(next) as (keyof Settings)[]) {
    if (COSMETIC_KEYS.includes(key)) continue;
    if (prev[key] !== next[key]) return true;
  }
  return false;
}

// ---- Esc ----

/** 按下 Esc 这一下该干什么。 */
export type EscapeAction = 'close-composer' | 'interrupt';

/**
 * Esc 的语义。
 *
 * 一次 Esc 只干一件事：输入框开着就只关输入框，没开才是「闭嘴」。
 * 原来输入框的 onKeyDown 里是 interrupt() + closeComposer() 一起做，
 * 于是用户想关掉打字框却顺手把她的话掐断了 —— 而且那是全仓**唯一**的 Esc 监听，
 * 不先双击她打开输入框根本按不到，设置里写的「按 Esc 让她停下」是句空话。
 * 现在监听挪到 window 上，这个函数是两种场合唯一的分派点。
 */
export function escapeAction(composing: boolean): EscapeAction {
  return composing ? 'close-composer' : 'interrupt';
}

// ---- 长按桌宠 ----

/** 长按（pointerdown 之后按住不动）该怎么处理。 */
export type LongPressPlan =
  /** 语音关着：给一条明确提示，不启动定时器（静默无事发生会被当成麦克风坏了）。 */
  | 'voice-off'
  /** 启动长按定时器，到点进入「按住说话 / 闭嘴听我说」。 */
  | 'hold'
  /** 大脑还没起来，这一下只当普通点击。 */
  | 'ignore';

/**
 * 长按要不要启动。
 *
 * **入参里刻意没有 `listening`**，这正是修掉的 bug：原来写
 * `pushToTalk = brain !== null && !brain.listening`，而 listening 默认 true，
 * 于是默认设置下长按定时器压根不启动、beginPushToTalk() 永远不被调用 ——
 * 文案里承诺的「长按她让她停下」对绝大多数用户直接不可达。
 *
 * 两种聆听模式的语义差别（真开麦采集 vs 只当「闭嘴，听我说」）由会话层
 * beginPushToTalk() 自己分辨，手势层不该替它判断。
 */
export function longPressPlan(input: { voiceEnabled: boolean; hasBrain: boolean }): LongPressPlan {
  if (!input.voiceEnabled) return 'voice-off';
  return input.hasBrain ? 'hold' : 'ignore';
}

// ---- 连接状态 → 要不要给用户反馈 ----

export type ConnectionFeedback =
  /** 连上了，清掉残留的错误。 */
  | { kind: 'clear' }
  | { kind: 'notice'; text: string }
  | { kind: 'error'; text: string }
  /** 用户不需要知道。 */
  | { kind: 'ignore' };

/**
 * 连接状态要不要冒到界面上。
 *
 * 关键是**带不带 detail**，不是状态本身：
 * - `reconnecting` 不带 detail = 30 分钟墙前的静默轮换或换音色重连，
 *   会话层明确要求「用户不应该察觉」，提示它反而是打扰。
 * - `reconnecting` 带 detail = 连接意外断了正在退避重试。原来这里完全不处理，
 *   重连期间界面一动不动，用户只知道「跟她说话没反应」，和麦克风坏了没区别。
 * - `closed` 不带 detail = 我们自己停的（关语音、换模式），本来就该安静。
 */
export function connectionFeedback(
  state: 'connecting' | 'open' | 'closed' | 'reconnecting',
  detail?: string,
): ConnectionFeedback {
  if (state === 'open') return { kind: 'clear' };
  if (state === 'reconnecting') return detail ? { kind: 'notice', text: detail } : { kind: 'ignore' };
  if (state === 'closed') return detail ? { kind: 'error', text: detail } : { kind: 'ignore' };
  return { kind: 'ignore' };
}
