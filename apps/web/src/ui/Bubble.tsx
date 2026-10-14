// 桌宠的气泡与字幕。
//
// 这是桌面上唯一的文字界面，所以它必须：
// - 不抢视觉焦点（桌宠是主体，气泡是附属）
// - 不接受点击（否则会在角色旁边留下一块看不见的点击死区，破坏穿透）
// - 说完就消失，不堆积成聊天记录（桌面不是聊天窗）
import { useEffect, useRef, useState } from 'react';

type Props = {
  /** 她正在说的话（流式）。 */
  petText: string;
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

// 她说完后气泡停留多久。太短看不完，太长挡桌面。
const LINGER_MS = 6000;

export function Bubble({ petText, userText, thinking, notice, link, onOpenLink, error }: Props) {
  const [visible, setVisible] = useState(false);
  const timer = useRef<number>(0);

  useEffect(() => {
    if (!petText) return;
    setVisible(true);
    clearTimeout(timer.current);
    // 每次新增文字都重置停留计时 —— 流式输出期间不应该中途消失。
    timer.current = window.setTimeout(() => setVisible(false), LINGER_MS);
    return () => clearTimeout(timer.current);
  }, [petText]);

  const showPet = visible && !!petText;
  if (!showPet && !userText && !thinking && !notice && !link && !error) return null;

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
      {userText && <div className="bubble bubble-user">{userText}</div>}
      {thinking && !petText && (
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
