// 设置窗口（独立的有边框窗口，由托盘菜单打开）。
//
// 托盘菜单本身能切换大部分开关；这个窗口的价值在于把**隐私含义**讲清楚，
// 菜单项的一行文字放不下。默认值与 shared/desktop.ts 的 settingsSchema 一致。
import { useEffect, useState } from 'react';
import { desktop } from '../platform/desktop';
import { probeMicrophone, type MicProbeResult } from '../platform/micProbe';
import { defaultSettings, type Settings } from '../../../../shared/desktop';

const VOICES = [
  { id: 'yuanqishaonv', label: '元气少女' },
  { id: 'jilingshaonv', label: '机灵少女' },
  { id: 'ruanmengnvsheng', label: '软萌女声' },
  { id: 'linjiameimei', label: '邻家妹妹' },
  { id: 'livelybreezy-female', label: '活力轻快' },
];

// 隐私开关单独一组，并且写清代价。不把它们和缩放、热键混在一起列。
const PRIVACY: { key: keyof Settings; label: string; detail: string }[] = [
  {
    key: 'screenAwareness',
    label: '允许她看屏幕',
    detail:
      '她需要时会截一张当前屏幕交给视觉模型，用来聊你正在做的事。每次都会在气泡里提示，截图只在内存中处理、不保存。需要系统的「屏幕与系统录制」权限。',
  },
  {
    key: 'appAwareness',
    label: '允许她知道你在用哪个应用',
    detail: '只读应用名称，不读窗口标题和内容。切换应用时她偶尔会搭话，有冷却和次数上限。',
  },
  {
    key: 'clipboardAwareness',
    label: '允许她读剪贴板文字',
    detail: '只在她明确需要时读一次，每次都会提示。不会主动轮询。',
  },
  {
    key: 'autonomy',
    label: '允许她自己在桌面上走动',
    detail: '空闲时她会换个位置待着、久了会打瞌睡。不涉及读取任何内容。',
  },
];

export function SettingsView() {
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [screenPermission, setScreenPermission] = useState<string>('unknown');
  const [error, setError] = useState<string | null>(null);
  const [mic, setMic] = useState<MicProbeResult | null>(null);
  const [micRunning, setMicRunning] = useState(false);
  const [keyStatus, setKeyStatus] = useState<Awaited<
    ReturnType<typeof desktop.credentialsStatus>
  >>(null);
  const [keyDraft, setKeyDraft] = useState('');

  useEffect(() => {
    void desktop
      .getSettings()
      .then(setSettings)
      .catch(() => setError('读取设置失败。'));
    void desktop.screenPermission().then(setScreenPermission);
    void desktop.credentialsStatus().then(setKeyStatus).catch(() => {});
  }, []);

  const runMicProbe = async () => {
    setMicRunning(true);
    try {
      setMic(await probeMicrophone());
    } finally {
      setMicRunning(false);
    }
  };

  // 桌宠窗和设置窗是两个独立的 webview，各自缓存一份设置。不订阅广播的话，
  // 从右键菜单改完开关，开着的设置窗还显示旧值（用户报过「两边不同步」）。
  useEffect(() => {
    return desktop.onSettingsChanged(setSettings);
  }, []);

  const update = async (patch: Partial<Settings>) => {
    try {
      setSettings(await desktop.setSettings(patch));
      setError(null);
      if ('screenAwareness' in patch) setScreenPermission(await desktop.screenPermission());
    } catch {
      setError('保存设置失败。');
    }
  };

  return (
    <div className="settings">
      <h1>Step酱</h1>
      {!desktop.available && (
        <p className="settings-warn">
          当前在浏览器里运行，系统能力不可用，设置只在本页生效。桌面版才有完整功能。
        </p>
      )}
      {error && <p className="settings-warn">{error}</p>}

      <section>
        <h2>声音</h2>
        <label className="row">
          <input
            type="checkbox"
            checked={settings.voiceEnabled}
            onChange={(e) => void update({ voiceEnabled: e.target.checked })}
          />
          <span>开启语音对话</span>
        </label>
        <label className="row">
          <span>音色</span>
          <select
            value={settings.voice}
            onChange={(e) => void update({ voice: e.target.value })}
          >
            {VOICES.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        </label>
        {/* 模型首次出音后音色不可改，所以换音色要重建会话 —— 用户需要知道会断一下。 */}
        <p className="hint">换音色会重新建立一次语音连接，正在说的话会中断。</p>
      </section>

      <section>
        <h2>怎么听</h2>
        <label className="row">
          <input
            type="checkbox"
            checked={settings.listening}
            onChange={(e) => void update({ listening: e.target.checked })}
          />
          <span>持续聆听</span>
        </label>
        <p className="hint">
          关掉之后她不会一直开着麦克风，只在你<strong>长按她</strong>的时候听 ——
          环境噪声就完全进不来了。
        </p>
        <label className="row">
          <input
            type="checkbox"
            checked={settings.voiceInterruptible}
            onChange={(e) => void update({ voiceInterruptible: e.target.checked })}
          />
          <span>允许说话打断她</span>
        </label>
        <p className="hint">
          默认关闭。开着的话，环境噪声和她自己从扬声器出来的声音都可能被当成打断。
          关闭时想让她停下，按 Esc 或长按她。
        </p>
      </section>

      <section>
        <h2>麦克风</h2>
        <p className="hint">
          麦克风出问题时的症状和「语音开关关着」「授权过期」「被别的应用占用」
          完全一样 —— 按住、说完、松手，什么都没发生。这个自检会把断在哪一步说清楚。
        </p>
        <p className="hint">
          <strong>点下面的按钮之后请立刻说话</strong> —— 自检要靠真实人声才能判断
          采集链路通不通。不说话的话它只会采到本底噪声。
        </p>
        <button type="button" onClick={() => void runMicProbe()} disabled={micRunning}>
          {micRunning ? '请说话…' : '检查麦克风（点完就说话）'}
        </button>
        {mic && (
          <div className="probe">
            {mic.steps.map((step) => (
              <div key={step.label} className={step.ok ? 'probe-ok' : 'probe-bad'}>
                {step.ok ? '✓' : '✗'} {step.label}：{step.detail}
              </div>
            ))}
            <p className="hint">{mic.advice}</p>
          </div>
        )}
      </section>

      <section>
        <h2>API Key</h2>
        {keyStatus?.configured ? (
          <p className="hint">
            已配置（{keyStatus.fingerprint}），来自 {keyStatus.source || '环境变量'}。
          </p>
        ) : (
          <p className="settings-warn">还没有 key，她没法说话也没法思考。</p>
        )}
        <label className="row">
          <input
            type="password"
            placeholder="粘贴 StepFun API key"
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
          />
          <button
            type="button"
            disabled={!keyDraft.trim()}
            onClick={() => {
              void desktop
                .setApiKey(keyDraft.trim())
                .then((status) => {
                  setKeyStatus(status);
                  setKeyDraft('');
                  setError(null);
                })
                .catch((e: unknown) =>
                  setError(e instanceof Error ? e.message : '保存 key 失败。'),
                );
            }}
          >
            保存
          </button>
        </label>
        <p className="hint">
          会写进 {keyStatus?.userPath || '~/.stepchan/.env'}（仅本人可读），立即生效不用重启。
          界面只会显示指纹，不会显示完整 key。
        </p>
      </section>

      <section>
        <h2>大脑</h2>
        <label className="row">
          <input
            type="radio"
            name="brainMode"
            checked={settings.brainMode === 'realtime'}
            onChange={() => void update({ brainMode: 'realtime' })}
          />
          <span>反应优先</span>
        </label>
        <p className="hint">
          实时语音模型，说完到出声约 0.2 秒。代价是工具调用不太可靠 ——
          有时会嘴上答应却没真去做（已经做了兜底，但不是百分百）。
        </p>
        <label className="row">
          <input
            type="radio"
            name="brainMode"
            checked={settings.brainMode === 'chat'}
            onChange={() => void update({ brainMode: 'chat' })}
          />
          <span>聪明优先</span>
        </label>
        <p className="hint">
          走强模型，更会主动看屏幕、用工具、把事办成，但要多等一会儿。
        </p>
        {settings.brainMode === 'chat' && (
          <label className="row">
            <span>模型</span>
            <select
              value={settings.chatModel}
              onChange={(e) =>
                void update({ chatModel: e.target.value as Settings['chatModel'] })
              }
            >
              <option value="step-5-preview">step-5-preview（更聪明）</option>
              <option value="step-3.7-flash">step-3.7-flash（更快）</option>
            </select>
          </label>
        )}
      </section>

      <section>
        <h2>睡觉</h2>
        <label className="row">
          <span>多久不理她就去睡</span>
          <input
            type="number"
            min={0}
            max={120}
            step={1}
            value={settings.sleepAfterMinutes}
            onChange={(e) => {
              // 清空字段时 Number('') 是 0，直接存下去就变成「永不睡」；
              // 非法输入是 NaN，会被 zod 的 min(0) 拒掉并弹"保存失败"。
              // 两种都不是用户的意图，所以只在拿到有效数字时才保存。
              const next = Number(e.target.value);
              if (e.target.value === '' || !Number.isFinite(next)) return;
              void update({ sleepAfterMinutes: Math.round(next) });
            }}
          />
          <span className="value">分钟</span>
        </label>
        <p className="hint">
          填 0 就不会自动睡。任何操作（说话、点她、按热键）都会把她叫醒。
          这一项**不受**「允许她自己在桌面上走动」约束 —— 打盹是被动的，不会打扰你。
        </p>
      </section>

      <section>
        <h2>她能感知什么</h2>
        <p className="hint">以下全部默认关闭。开启后她才会用到，且每次使用都有可见提示。</p>
        {PRIVACY.map((item) => (
          <label className="row row-block" key={item.key}>
            <span className="row-head">
              <input
                type="checkbox"
                checked={Boolean(settings[item.key])}
                onChange={(e) => void update({ [item.key]: e.target.checked } as Partial<Settings>)}
              />
              <span>{item.label}</span>
            </span>
            <span className="detail">{item.detail}</span>
            {item.key === 'screenAwareness' && settings.screenAwareness && (
              <span className="detail">
                系统录屏权限：
                {screenPermission === 'granted'
                  ? '已授权'
                  : screenPermission === 'denied'
                    ? '未授权 —— 请到 系统设置 → 隐私与安全性 → 屏幕与系统录制 里勾选 Step酱，然后重启应用。'
                    : '未知（首次使用时系统会询问）'}
              </span>
            )}
          </label>
        ))}
      </section>

      <section>
        <h2>外观</h2>
        <label className="row">
          <span>大小</span>
          <input
            type="range"
            min={0.5}
            max={2}
            step={0.1}
            value={settings.petScale}
            onChange={(e) => void update({ petScale: Number(e.target.value) })}
          />
          <span className="value">{settings.petScale.toFixed(1)}×</span>
        </label>
        <label className="row">
          <input
            type="checkbox"
            checked={settings.reduceMotion}
            onChange={(e) => void update({ reduceMotion: e.target.checked })}
          />
          <span>减少动态效果</span>
        </label>
      </section>

      <section>
        <h2>快捷键</h2>
        <p className="hint">按 {settings.hotkey} 唤起对话。</p>
      </section>

      <footer className="settings-foot">
        聊天内容、录音和截图都不会保存到磁盘。这里只保存上面这些设置。
      </footer>
    </div>
  );
}
