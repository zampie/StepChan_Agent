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
  credentialsStatus: 'credentials_status',
  setApiKey: 'set_api_key',
  setHitRegions: 'set_hit_regions',
  setInteractive: 'set_interactive',
  moveToSpot: 'move_to_spot',
  focusPet: 'focus_pet',
  openSettings: 'open_settings',
  quitApp: 'quit_app',
  workArea: 'get_work_area',
  captureScreen: 'capture_screen',
  screenPermission: 'screen_permission_status',
  frontmostApp: 'get_frontmost_app',
  systemStatus: 'get_system_status',
  readClipboard: 'read_clipboard_text',
  settingsGet: 'settings_get',
  settingsSet: 'settings_set',
  // 把 webview 的错误转到进程 stderr —— 打包产物里没有控制台可看。
  logFrontend: 'log_frontend',
} as const;

// Rust → webview 的事件名。
export const desktopEvents = {
  hitTest: 'pet://hit-test',
  frontmostChanged: 'pet://frontmost-changed',
  trayCommand: 'pet://tray-command',
  hotkey: 'pet://hotkey',
  dragDrop: 'pet://drag-drop',
  /** 设置变更广播。两个窗口各自缓存设置，靠它保持一致。 */
  settingsChanged: 'pet://settings-changed',
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

/**
 * key 的配置状态。**刻意不含 key 本身** —— 界面只需要知道「配好了没有」
 * 和「从哪儿来的」。把明文 key 送进 webview 再渲染到 DOM 是没必要的暴露面。
 */
export const keyStatusSchema = z
  .object({
    configured: z.boolean(),
    /** 前 6 + 后 4 位。够用户确认「是我那把」，不够复用。 */
    fingerprint: z.string(),
    /** 实际生效的来源路径，排障第一眼看它。 */
    source: z.string(),
    /** 设置里写入时会用的路径（~/.stepchan/.env）。 */
    userPath: z.string(),
  })
  .strict();
export type KeyStatus = z.infer<typeof keyStatusSchema>;

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
    // 刻意没有「语速」设置。曾经做过（播放侧 WSOLA 时间伸缩，音高保持得很好），
    // 但 realtime 下加速是在和数据率打架：模型大致按实时出音，按 r 倍消耗就得
    // 垫住 T·(r−1)/r 的音频才不断续 —— 实测 1.15× 要垫 480ms。
    // 而上游恰好 1× 实时时，加速**一点时间都省不下来**（最后一个样本到达的
    // 时刻是固定的），省的只是"她说话的语速"，换掉的是"她多久开口"。
    // 用户试过之后判定这个延迟不可接受，所以整个功能移除，只保留原速。
    /** 持续聆听。关掉之后只能长按桌宠说话（按住说、松手发）。 */
    listening: z.boolean().default(true),
    /**
     * 允许用语音打断她。**默认关闭** —— 环境噪声和她自己的回声都会被当成打断，
     * 关掉之后她会把话说完，想打断就长按或按 Esc。
     */
    voiceInterruptible: z.boolean().default(false),
    /**
     * 大脑模式。
     * - realtime：stepaudio-3-realtime，延迟最低，但工具调用能力弱
     * - chat：走 chat completions 的强模型，更会用工具、更"聪明"，但要多等
     */
    brainMode: z.enum(['realtime', 'chat']).default('realtime'),
    /** chat 模式用哪个模型。 */
    chatModel: z.enum(['step-5-preview', 'step-3.7-flash']).default('step-5-preview'),
    screenAwareness: z.boolean().default(false),
    appAwareness: z.boolean().default(false),
    clipboardAwareness: z.boolean().default(false),
    autonomy: z.boolean().default(false),
    /**
     * 多久没互动就自己去睡（分钟）。0 = 不自动睡。
     *
     * 刻意**不**受 autonomy 开关约束：autonomy 管的是「自己挪位置、主动搭话」
     * 这类会打扰人的行为，而打盹是被动的 —— 她只是换个姿势待着，任何操作都会
     * 把她叫醒。把两者绑在一起会让「想要安静的桌宠」和「不想被挪窗口」变成
     * 一个开关，而用户要的是前者。
     */
    sleepAfterMinutes: z.number().min(0).max(120).default(5),
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
  /** 查 key 配置状态（不含 key 本身）。 */
  credentialsStatus(): Promise<KeyStatus | null>;
  /** 写入 key 到用户级配置并立即生效，不需要重启。 */
  setApiKey(key: string): Promise<KeyStatus>;
  setHitRegions(regions: HitRegion[]): Promise<void>;
  /**
   * 强制窗口进入/退出可交互态。`null` = 交还给 Rust 的命中轮询。
   *
   * 需要它的场合：输入框、拖放落点都在**角色命中区之外**，而窗口默认只在
   * 光标落在角色身上时才接收鼠标 —— 不强制的话那些区域的点击会穿到下层应用。
   */
  setInteractive(interactive: boolean | null): Promise<void>;
  moveToSpot(spot: Spot): Promise<void>;
  /** 激活应用并聚焦桌宠窗口。Accessory 策略下 set_focus 不激活进程，输入框会点不中。 */
  focusPet(): Promise<void>;
  /** 交给系统接管窗口拖动。调用后本次 pointerup 不会回到 webview。 */
  startDragging(): Promise<void>;
  openSettings(): Promise<void>;
  quit(): Promise<void>;
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
  /** 任一窗口改了设置都会收到。返回取消订阅函数。 */
  onSettingsChanged(handler: (settings: Settings) => void): () => void;
};
