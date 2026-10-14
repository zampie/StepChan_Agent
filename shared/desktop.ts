// 系统能力契约：webview 与 Rust 之间唯一的边界。
//
// 两条规则，不要绕过：
// 1. 浏览器里跑的时候所有能力都不可用（available=false），UI 必须优雅降级而不是报错。
//    这是为了保留浏览器调试路径，也是 Android 移植的接缝。
// 2. 涉及隐私的能力（屏幕、前台应用、剪贴板）默认关闭，每次使用要有可见提示。
//    见 AGENTS.md 的隐私条款 —— 不偷偷越线。
import { z } from 'zod';
import type { Spot } from './pet';

// Tauri command 名字集中在此，避免前后端各写一遍字符串。
// 通知和开链接不在这里 —— 它们直接走 @tauri-apps/plugin-notification /
// plugin-opener 的 JS 接口，没必要为了两个一行的包装再加 Rust command。
export const commands = {
  credentials: 'get_credentials',
  setHitRegions: 'set_hit_regions',
  setInteractive: 'set_interactive',
  moveToSpot: 'move_to_spot',
  workArea: 'get_work_area',
  captureScreen: 'capture_screen',
  screenPermission: 'screen_permission_status',
  frontmostApp: 'get_frontmost_app',
  systemStatus: 'get_system_status',
  readClipboard: 'read_clipboard_text',
  settingsGet: 'settings_get',
  settingsSet: 'settings_set',
} as const;

// Rust → webview 的事件名。
export const desktopEvents = {
  hitTest: 'pet://hit-test',
  frontmostChanged: 'pet://frontmost-changed',
  trayCommand: 'pet://tray-command',
  hotkey: 'pet://hotkey',
  dragDrop: 'pet://drag-drop',
} as const;

export const credentialsSchema = z
  .object({
    apiKey: z.string().min(1),
    realtimeModel: z.string().min(1),
    visionModel: z.string().min(1),
    chatModel: z.string().min(1),
  })
  .strict();
export type Credentials = z.infer<typeof credentialsSchema>;

// 归一化到 0..1 的命中矩形，坐标系与素材画布一致（沿用 hitRegions.ts 的约定）。
// 表情/动作切换时推给 Rust，Rust 侧轮询光标做命中测试 —— JS 的 mousemove 在
// 穿透开启后收不到事件，会逻辑自锁，所以必须在 Rust 侧判定。
export const hitRegionSchema = z
  .object({
    part: z.string().min(1),
    x0: z.number().min(0).max(1),
    y0: z.number().min(0).max(1),
    x1: z.number().min(0).max(1),
    y1: z.number().min(0).max(1),
  })
  .strict();
export type HitRegion = z.infer<typeof hitRegionSchema>;

export const screenCaptureSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('ok'),
      // base64 PNG，不落盘。
      png: z.string().min(1),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    })
    .strict(),
  // 录屏权限被拒：要给出可操作的提示，不是笼统失败。
  z.object({ status: z.literal('denied'), message: z.string() }).strict(),
  z.object({ status: z.literal('error'), message: z.string() }).strict(),
]);
export type ScreenCapture = z.infer<typeof screenCaptureSchema>;

export const frontmostAppSchema = z
  .object({ name: z.string(), bundleId: z.string() })
  .strict()
  .nullable();
export type FrontmostApp = z.infer<typeof frontmostAppSchema>;

export const systemStatusSchema = z
  .object({
    battery: z
      .object({
        percent: z.number().min(0).max(100),
        state: z.enum(['charging', 'discharging', 'full', 'empty', 'unknown']),
        minutesRemaining: z.number().int().nonnegative().nullable(),
      })
      .strict()
      .nullable(),
    localTime: z.string(),
    timezone: z.string(),
    os: z.string(),
  })
  .strict();
export type SystemStatus = z.infer<typeof systemStatusSchema>;

// 工作区（排除菜单栏和 Dock 之后的可用区域）。
// **单位是逻辑点（= webview 的 CSS px），不是物理像素**，另附 scaleFactor。
// Tauri 的 Monitor getter 返回物理像素，Rust 侧已经除过对应显示器的 scale factor；
// 混合 DPI 下混用两套 scale 就是错位的来源，所以这里只认一种单位。
export const workAreaSchema = z
  .object({
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    scaleFactor: z.number().positive(),
  })
  .strict();
export type WorkArea = z.infer<typeof workAreaSchema>;

// 用户可改的设置。只存设置，不存聊天内容。
export const settingsSchema = z
  .object({
    voice: z.string().default('yuanqishaonv'),
    voiceEnabled: z.boolean().default(true),
    screenAwareness: z.boolean().default(false),
    appAwareness: z.boolean().default(false),
    clipboardAwareness: z.boolean().default(false),
    autonomy: z.boolean().default(false),
    petScale: z.number().min(0.5).max(2).default(1),
    reduceMotion: z.boolean().default(false),
    hotkey: z.string().default('Alt+Space'),
  })
  .strict();
export type Settings = z.infer<typeof settingsSchema>;
export const defaultSettings: Settings = settingsSchema.parse({});

export type DragDropPayload =
  | { kind: 'files'; paths: string[] }
  | { kind: 'text'; text: string };

/**
 * 桌面能力。浏览器里用 browserFallback() 返回的实现，所有方法安全地什么都不做。
 * 新增能力必须同时更新 browserFallback，否则浏览器路径会炸。
 */
export type Desktop = {
  readonly available: boolean;
  credentials(): Promise<Credentials>;
  setHitRegions(regions: HitRegion[]): Promise<void>;
  /** 由 Rust 侧轮询驱动；这里只用于强制进入/退出交互态（例如拖放期间）。 */
  setInteractive(interactive: boolean): Promise<void>;
  moveToSpot(spot: Spot): Promise<void>;
  workArea(): Promise<WorkArea | null>;
  captureScreen(): Promise<ScreenCapture>;
  screenPermission(): Promise<'granted' | 'denied' | 'unknown'>;
  frontmostApp(): Promise<FrontmostApp>;
  systemStatus(): Promise<SystemStatus | null>;
  readClipboardText(): Promise<string | null>;
  notify(title: string, body: string): Promise<void>;
  openUrl(url: string): Promise<void>;
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  /** 返回取消订阅函数。 */
  onTrayCommand(handler: (command: string) => void): () => void;
  onHotkey(handler: () => void): () => void;
  onDragDrop(handler: (payload: DragDropPayload) => void): () => void;
  onFrontmostChanged(handler: (app: FrontmostApp) => void): () => void;
  onHitTest(handler: (part: string | null) => void): () => void;
};
