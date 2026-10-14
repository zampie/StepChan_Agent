import { RefreshCw, Hand, Pause } from 'lucide-react';
import type { InteractionInput, Suggestion } from '../../../../shared/room';
export function SuggestionBar({
  items,
  busy,
  ready,
  onSelect,
  onRotate,
  onStop,
}: {
  items: Suggestion[];
  busy: boolean;
  ready: boolean;
  onSelect: (i: InteractionInput) => void;
  onRotate: () => void;
  onStop: () => void;
}) {
  return (
    <div className="suggestion-bar" aria-label="交互建议">
      <div className="suggestion-heading">
        <span>{busy ? '随时接话，我会停下来听' : '不用打字，也能一起玩'}</span>
        <button aria-label="换一组建议" onClick={onRotate}>
          <RefreshCw size={12} />
        </button>
      </div>
      <div className="suggestion-buttons">
        {busy && (
          <>
            <button
              onClick={() => onSelect({ kind: 'text', text: '简短一点，请接着刚才说到的地方。' })}
            >
              简短一点
            </button>
            <button
              onClick={() => onSelect({ kind: 'text', text: '先停一下，让我猜，不要剧透答案。' })}
            >
              <Hand size={12} />
              让我猜
            </button>
            <button onClick={onStop}>
              <Pause size={12} />
              先停一下
            </button>
          </>
        )}
        {items.map((item, i) => (
          <button key={item.label + i} disabled={!ready} onClick={() => onSelect(item.input)}>
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}
