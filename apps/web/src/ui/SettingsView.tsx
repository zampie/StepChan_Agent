// 设置窗口（独立的有边框窗口，由托盘菜单打开）。
//
// 托盘菜单本身能切换大部分开关；这个窗口的价值在于把**隐私含义**讲清楚，
// 菜单项的一行文字放不下。默认值与 shared/desktop.ts 的 settingsSchema 一致。
import { useEffect, useState } from 'react';
import { desktop } from '../platform/desktop';
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

  useEffect(() => {
    void desktop
      .getSettings()
      .then(setSettings)
      .catch(() => setError('读取设置失败。'));
    void desktop.screenPermission().then(setScreenPermission);
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
