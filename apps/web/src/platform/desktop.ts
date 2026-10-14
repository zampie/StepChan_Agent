// 桌面能力适配层。实现 shared/desktop.ts 的 Desktop 契约。
//
// 这一层的存在意义：前端其余代码不直接 import @tauri-apps/api，
// 所以同一份前端在浏览器里也能跑（能力全部降级为 no-op），
// 调试路径不丢，Android 移植时也只需要换这一个文件。
import {
  commands,
  credentialsSchema,
  defaultSettings,
  desktopEvents,
  frontmostAppSchema,
  screenCaptureSchema,
  settingsSchema,
  systemStatusSchema,
  workAreaSchema,
  type Credentials,
  type Desktop,
  type DragDropPayload,
  type FrontmostApp,
  type HitRegion,
  type ScreenCapture,
  type Settings,
  type SystemStatus,
  type WorkArea,
} from '../../../../shared/desktop';
import type { Spot } from '../../../../shared/pet';

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

function noop(): () => void {
  return () => {};
}

/** 浏览器里的实现：所有系统能力安全地什么都不做。 */
function browserFallback(): Desktop {
  let settings: Settings = { ...defaultSettings };
  return {
    available: false,
    async credentials(): Promise<Credentials> {
      // 浏览器调试走 vite 的 dev-only 端点，仅在 127.0.0.1 下可用。
      const response = await fetch('/__dev/credentials');
      if (!response.ok) throw Error('浏览器调试模式需要 vite dev server 提供凭据。');
      return credentialsSchema.parse(await response.json());
    },
    async setHitRegions() {},
    async setInteractive() {},
    async moveToSpot() {},
    async focusPet() {},
    async startDragging() {},
    async workArea() {
      return null;
    },
    async captureScreen(): Promise<ScreenCapture> {
      return { status: 'error', message: '浏览器里无法截屏，请在桌面版使用。' };
    },
    async screenPermission() {
      return 'unknown' as const;
    },
    async frontmostApp() {
      return null;
    },
    async systemStatus() {
      return null;
    },
    async readClipboardText() {
      return null;
    },
    async notify(title, body) {
      console.info('[notify]', title, body);
    },
    async openUrl(url) {
      window.open(url, '_blank', 'noopener,noreferrer');
    },
    async getSettings() {
      return settings;
    },
    async setSettings(patch) {
      settings = settingsSchema.parse({ ...settings, ...patch });
      return settings;
    },
    onTrayCommand: noop,
    onHotkey: noop,
    onDragDrop: noop,
    onFrontmostChanged: noop,
    onHitTest: noop,
  };
}

function tauriDesktop(): Desktop {
  // 动态 import：浏览器构建里这些模块不会被求值。
  const core = () => import('@tauri-apps/api/core');
  const event = () => import('@tauri-apps/api/event');
  const invoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
    (await core()).invoke<T>(cmd, args);
  const listen = <T>(name: string, handler: (payload: T) => void): (() => void) => {
    let dispose: (() => void) | null = null;
    let cancelled = false;
    void event().then(async ({ listen: tauriListen }) => {
      const un = await tauriListen<T>(name, (e) => handler(e.payload));
      if (cancelled) un();
      else dispose = un;
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  };

  return {
    available: true,
    async credentials() {
      return credentialsSchema.parse(await invoke(commands.credentials));
    },
    async setHitRegions(regions: HitRegion[]) {
      await invoke(commands.setHitRegions, { regions });
    },
    async setInteractive(interactive: boolean | null) {
      await invoke(commands.setInteractive, { interactive });
    },
    async moveToSpot(spot: Spot) {
      await invoke(commands.moveToSpot, { spot });
    },
    async focusPet() {
      await invoke(commands.focusPet);
    },
    async startDragging() {
      // 走窗口 API 而不是自己算位移：系统接管后拖动跟手、跨屏也正确。
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().startDragging();
    },
    async workArea(): Promise<WorkArea | null> {
      const parsed = workAreaSchema.safeParse(await invoke(commands.workArea));
      return parsed.success ? parsed.data : null;
    },
    async captureScreen(): Promise<ScreenCapture> {
      const parsed = screenCaptureSchema.safeParse(await invoke(commands.captureScreen));
      return parsed.success ? parsed.data : { status: 'error', message: '截屏返回格式异常。' };
    },
    async screenPermission() {
      const value = await invoke<string>(commands.screenPermission);
      return value === 'granted' || value === 'denied' ? value : 'unknown';
    },
    async frontmostApp(): Promise<FrontmostApp> {
      const parsed = frontmostAppSchema.safeParse(await invoke(commands.frontmostApp));
      return parsed.success ? parsed.data : null;
    },
    async systemStatus(): Promise<SystemStatus | null> {
      const parsed = systemStatusSchema.safeParse(await invoke(commands.systemStatus));
      return parsed.success ? parsed.data : null;
    },
    async readClipboardText() {
      return (await invoke<string | null>(commands.readClipboard)) ?? null;
    },
    async notify(title: string, body: string) {
      // 走插件的 JS 接口，不额外加 Rust command。macOS 上不需要先申请权限，
      // 但按插件文档仍要先问一次，否则 sendNotification 会被静默丢掉。
      const { isPermissionGranted, requestPermission, sendNotification } = await import(
        '@tauri-apps/plugin-notification'
      );
      if (!(await isPermissionGranted()) && (await requestPermission()) !== 'granted') return;
      sendNotification({ title, body });
    },
    async openUrl(url: string) {
      // 作用域由 capabilities 的 opener:allow-open-url 限制在 https://*。
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(url);
    },
    async getSettings() {
      return settingsSchema.parse(await invoke(commands.settingsGet));
    },
    async setSettings(patch: Partial<Settings>) {
      return settingsSchema.parse(await invoke(commands.settingsSet, { patch }));
    },
    onTrayCommand(handler) {
      return listen<string>(desktopEvents.trayCommand, handler);
    },
    onHotkey(handler) {
      return listen<unknown>(desktopEvents.hotkey, () => handler());
    },
    onDragDrop(handler) {
      return listen<DragDropPayload>(desktopEvents.dragDrop, handler);
    },
    onFrontmostChanged(handler) {
      return listen<FrontmostApp>(desktopEvents.frontmostChanged, handler);
    },
    onHitTest(handler) {
      return listen<string | null>(desktopEvents.hitTest, handler);
    },
  };
}

export const desktop: Desktop = isTauri ? tauriDesktop() : browserFallback();
