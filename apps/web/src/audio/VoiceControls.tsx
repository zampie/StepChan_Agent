import { useRef } from 'react';
import { Mic, Volume2, VolumeX, Square, Play } from 'lucide-react';
import type { useVoice } from './useVoice';
type Props = {
  voice: ReturnType<typeof useVoice>;
  live: boolean;
  ready: boolean;
  onStart: () => void;
  onStop: () => void;
};
export function VoiceControls({ voice, live, ready, onStart, onStop }: Props) {
  const pressed = useRef(false);
  const available = live && voice.configured && ready;
  const start = () => {
    if (!available || pressed.current || voice.mic === 'transcribing') return;
    pressed.current = true;
    onStart();
    void voice.startRecording();
  };
  const end = () => {
    if (!pressed.current) return;
    pressed.current = false;
    void voice.endRecording();
  };
  const cancel = () => {
    pressed.current = false;
    voice.cancelRecording();
  };
  const label =
    voice.mic === 'requesting'
      ? '请允许麦克风'
      : voice.mic === 'recording'
        ? '松开，转成文字'
        : voice.mic === 'transcribing'
          ? '正在听写…'
          : '按住说话';
  return (
    <div className="voice-controls">
      <div className="voice-actions">
        <button
          type="button"
          aria-label="语音朗读"
          aria-pressed={voice.enabled}
          disabled={!available}
          onClick={() => void voice.toggle()}
          title="开启后朗读新回复"
        >
          {voice.enabled ? <Volume2 size={16} /> : <VolumeX size={16} />}
          {voice.enabled ? '声音开' : '声音关'}
        </button>
        <button
          type="button"
          className={`hold-to-talk ${voice.mic === 'recording' ? 'recording' : ''}`}
          aria-label="按住说话"
          disabled={!available || voice.mic === 'transcribing'}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.currentTarget.focus();
            e.currentTarget.setPointerCapture(e.pointerId);
            start();
          }}
          onPointerUp={end}
          onPointerCancel={cancel}
          onLostPointerCapture={end}
          onContextMenu={(e) => e.preventDefault()}
          onKeyDown={(e) => {
            if ([' ', 'Enter'].includes(e.key)) {
              e.preventDefault();
              if (!e.repeat) start();
            }
            if (e.key === 'Escape') cancel();
          }}
          onKeyUp={(e) => {
            if ([' ', 'Enter'].includes(e.key)) {
              e.preventDefault();
              end();
            }
          }}
          onBlur={() => {
            if (pressed.current) cancel();
          }}
        >
          <Mic size={16} />
          {label}
        </button>
        <button
          type="button"
          disabled={!available || voice.mic !== 'idle'}
          onClick={() => {
            onStop();
            void voice.preview();
          }}
        >
          <Play size={14} />
          试听
        </button>
        {(voice.status !== 'idle' || voice.mic !== 'idle') && (
          <button type="button" aria-label="停止语音" onClick={onStop}>
            <Square size={14} />
            停止
          </button>
        )}
      </div>
      <small role="status">
        {!live
          ? '演示模式不调用语音服务'
          : voice.mic === 'recording'
            ? '我在听 · 最长 30 秒 · 松开后可修改文字'
            : voice.mic === 'transcribing'
              ? '识别中，文字会放进输入框'
              : voice.status === 'playing'
                ? 'Step酱正在说话，随时可以打断'
                : voice.status === 'loading'
                  ? '正在准备声音…'
                  : '清亮童真 · 按住录音，松开后确认发送'}
      </small>
      {voice.error && (
        <p className="voice-error" role="alert">
          {voice.error}
        </p>
      )}
    </div>
  );
}
