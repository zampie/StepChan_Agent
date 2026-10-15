// 桌宠的气泡与字幕。
//
// 这是桌面上唯一的文字界面，所以它必须：
// - 不抢视觉焦点（桌宠是主体，气泡是附属）
// - 不接受点击（否则会在角色旁边留下一块看不见的点击死区，破坏穿透）
// - 说完就消失，不堆积成聊天记录（桌面不是聊天窗）
import { useEffect, useRef, useState } from 'react';

type Props = {
  /**
   * 她正在说的话（流式）。
   *
   * 约定：**新回合开始时调用方要把它清成 ''**（App.tsx 在 activity 跨进「忙」
   * 的那一刻清）。不清的话下面的 effect 会在 speaking 翻 true 时把**上一句**
   * 重新显示出来 —— 上一句 linger 到期只是把 lingering 置 false，petText 还在，
   * 于是新回合一开始旧话又冒出来，一直挂到第一条新字幕盖掉它（音频先于字幕时
   * 能闪好几百毫秒，用户看到的是「说完的话又莫名闪一下」）。
   * 这个复活逻辑不在这里拦，是因为「同一句话连说两遍」也要能正常显示。
   */
  petText: string;
  /**
   * 她睡着了 → **对话气泡全部不显示**。
   *
   * 系统级的提示/报错/链接仍然显示：那些是「出了什么事」而不是聊天内容，
   * 睡着时把连接断了这种事藏起来只会让人更困惑。
   */
  sleeping?: boolean;
  /**
   * 她的音频是否还在播。
   *
   * 气泡的停留**不能**只看文字：`response.audio_transcript.done`（文字完成）
   * 比音频播完早得多，按文字结束就开始倒计时的话，她还在说、气泡已经没了 ——
   * 这就是「回复一闪而过」。所以只要还在出声就一直显示，停了才开始计时。
   */
  speaking: boolean;
  /** 用户正在说的话（realtime 的实时转写）。 */
  userText: string;
  /** 她在想（response.thinking.delta）。 */
  thinking: boolean;
  /** 隐私动作提示，例如「看了一眼屏幕」。必须可见，不能静默。 */
  notice: string | null;
  /** 需要用户点击才打开的链接。 */
  link: string | null;
  onOpenLink: (url: string) => void;
  error: string | null;
};

/** 她停止出声之后气泡还留多久。太短看不完，太长挡桌面。 */
const LINGER_MS = 5000;

export function Bubble({
  petText,
  speaking,
  userText,
  thinking,
  notice,
  link,
  onOpenLink,
  error,
  sleeping = false,
}: Props) {
  const [lingering, setLingering] = useState(false);
  const timer = useRef<number>(0);

  useEffect(() => {
    clearTimeout(timer.current);
    if (!petText) {
      setLingering(false);
      return;
    }
    if (speaking) {
      // 还在说：保持显示，不计时。
      setLingering(true);
      return;
    }
    // 说完了（或者本来就是纯文本回复）才开始计时。
    setLingering(true);
    timer.current = window.setTimeout(() => setLingering(false), LINGER_MS);
    return () => clearTimeout(timer.current);
  }, [petText, speaking]);

  // 睡着时对话气泡一律不显示。除了「她在睡觉就该安静」这一条，还有一个实际
  // 原因：App 在入睡时会清掉在途文本，但清空是异步生效的，而迟到的字幕事件
  // （入睡那一刻服务端还在发的那几条）仍可能把文本填回来 —— 在这里一并挡掉，
  // 比在 App 里追着每条事件判断可靠。
  const showPet = !sleeping && !!petText && (speaking || lingering);
  const showUser = !sleeping && !!userText;
  const showThinking = !sleeping && thinking && !petText;
  if (!showPet && !showUser && !showThinking && !notice && !link && !error) return null;

  return (
    // pointer-events: none 由 CSS 保证；只有链接按钮单独打开点击。
    <div className="bubbles" aria-live="polite">
      {error && <div className="bubble bubble-error">{error}</div>}
      {notice && (
        <div className="bubble bubble-notice">
          <span className="notice-dot" aria-hidden="true" />
          {notice}
        </div>
      )}
      {showUser && <div className="bubble bubble-user">{userText}</div>}
      {showThinking && (
        <div className="bubble bubble-thinking" aria-label="正在思考">
          <i />
          <i />
          <i />
        </div>
      )}
      {showPet && <div className="bubble bubble-pet">{petText}</div>}
      {link && (
        <button type="button" className="bubble bubble-link" onClick={() => onOpenLink(link)}>
          打开 {safeHost(link)}
        </button>
      )}
    </div>
  );
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 40);
  }
}
