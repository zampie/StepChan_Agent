// 桌宠的右键菜单。
//
// 用系统原生菜单而不是在 webview 里画一个 HTML 菜单，原因有三：
// 1. 窗口只有 420×520，HTML 菜单会被窗口边界裁掉，而原生菜单可以超出窗口。
// 2. HTML 菜单需要那块区域可点，而窗口默认是穿透的（命中判定只认角色身上），
//    等于又要为菜单单独开一块交互区 —— 输入框刚踩过这个坑。
// 3. 和托盘菜单观感一致，不用自己做高亮、键盘导航、点击外部关闭。
//
// 勾选项的状态每次弹出时按当前设置重建，所以不需要维护菜单实例。
import type { Settings } from '../../../../shared/desktop';

/**
 * 语速档位。细调（0.8~1.8 连续）在设置窗里。
 *
 * **1.00 是默认档**，而且它是唯一一个完全不经过时间伸缩的档
 * （见 audio-playback.js 的旁路路径）：音质上没有任何处理痕迹，首音延迟也最低。
 *
 * 为什么默认不是更快的档：reaction 模式（realtime）的模型按**实时速度**出音，
 * 以 >1 倍播放就得比声音到达更快地消耗它，必须先攒一段缓冲再开口 ——
 * 1.15 档的首音延迟会从约 0.2 秒涨到约 0.65 秒。对桌宠来说"马上应声"比
 * "语速快一点"值钱得多，所以加速是**用户主动选**的，不是默认。
 * （chat 模式是服务端调速，没有这个代价；差异在设置窗里有说明。）
 */
export const SPEECH_RATE_PRESETS: { label: string; value: number }[] = [
  { label: '原速（1.00×）', value: 1.0 },
  { label: '快一点（1.15×）', value: 1.15 },
  { label: '更快（1.30×）', value: 1.3 },
];


export type PetMenuActions = {
  onType: () => void;
  /** 主动让她睡 / 叫醒。和自动打盹走同一个渲染器方法。 */
  onToggleSleep: (next: boolean) => void;
  /** 任意设置项改动都走这一个口子，由集成层决定要不要重建会话。 */
  onPatchSettings: (patch: Partial<Settings>) => void;
  onOpenSettings: () => void;
  onMoveAside: () => void;
  onQuit: () => void;
};

/**
 * 在光标处弹出右键菜单。浏览器里没有原生菜单，返回 false 让调用方退回自己的处理。
 */
export async function popupPetMenu(
  settings: Settings,
  actions: PetMenuActions,
  /** 她现在是不是在睡。菜单文案和勾选都看它。 */
  sleeping = false,
): Promise<boolean> {
  if (!('__TAURI_INTERNALS__' in window)) return false;
  try {
    const { Menu } = await import('@tauri-apps/api/menu');
    const { MenuItem } = await import('@tauri-apps/api/menu/menuItem');
    const { CheckMenuItem } = await import('@tauri-apps/api/menu/checkMenuItem');
    const { PredefinedMenuItem } = await import('@tauri-apps/api/menu/predefinedMenuItem');
    const { Submenu } = await import('@tauri-apps/api/menu/submenu');

    const sep = () => PredefinedMenuItem.new({ item: 'Separator' });
    const check = (id: string, text: string, checked: boolean, action: () => void) =>
      CheckMenuItem.new({ id, text, checked, action });

    // 语速放子菜单里给三个档位。原生菜单没有滑块，细调去设置窗 ——
    // 这里只要「嫌慢/嫌快」一键能改。
    //
    // 子菜单标题带上代价：reaction 模式（realtime）里 >1 的档要靠预缓冲才不断续，
    // 首音会晚约半秒；chat 模式是服务端调速，一点代价都没有。这个差异用户听得出来，
    // 但原生菜单项放不下一段说明，所以压到标题里，细节在设置窗。
    const speedMenu = async () => {
      const cost =
        settings.brainMode === 'realtime' ? '语速（>1 倍出声会晚约半秒）' : '语速';
      const items = await Promise.all(
        SPEECH_RATE_PRESETS.map((preset) =>
          check(
            `rate_${preset.value}`,
            preset.label,
            Math.abs(settings.speechRate - preset.value) < 0.03,
            () => actions.onPatchSettings({ speechRate: preset.value }),
          ),
        ),
      );
      return Submenu.new({ id: 'speech_rate', text: cost, items });
    };

    const items = await Promise.all([
      MenuItem.new({ id: 'type', text: '打字跟她说…', action: actions.onType }),
      sep(),
      check('voice', '语音对话', settings.voiceEnabled, () =>
        actions.onPatchSettings({ voiceEnabled: !settings.voiceEnabled }),
      ),
      speedMenu(),
      // 关掉持续聆听之后改为「长按她说话」，这样环境噪声完全进不来。
      check('listening', '持续聆听（关闭后长按她说话）', settings.listening, () =>
        actions.onPatchSettings({ listening: !settings.listening }),
      ),
      // 默认关：噪声和她自己的回声都会被当成打断。
      check('interruptible', '允许说话打断她', settings.voiceInterruptible, () =>
        actions.onPatchSettings({ voiceInterruptible: !settings.voiceInterruptible }),
      ),
      sep(),
      // 智能模式：realtime 快但工具调用弱，chat 慢但更会办事。
      check('mode_realtime', '反应优先（实时语音）', settings.brainMode === 'realtime', () =>
        actions.onPatchSettings({ brainMode: 'realtime' }),
      ),
      check('mode_chat', '聪明优先（强模型，略慢）', settings.brainMode === 'chat', () =>
        actions.onPatchSettings({ brainMode: 'chat' }),
      ),
      sep(),
      // 睡觉用 MenuItem 而不是 CheckMenuItem：它是一个动作（"去睡吧"/"起来啦"），
      // 不是一个长期偏好 —— 勾选框会让人以为这是个设置项。
      MenuItem.new({
        id: 'sleep',
        text: sleeping ? '起来啦～' : '去睡吧（任何操作都会叫醒）',
        action: () => actions.onToggleSleep(!sleeping),
      }),
      MenuItem.new({ id: 'aside', text: '让一让（挪到角落）', action: actions.onMoveAside }),
      MenuItem.new({ id: 'settings', text: '设置…', action: actions.onOpenSettings }),
      sep(),
      MenuItem.new({ id: 'quit', text: '退出 Step酱', action: actions.onQuit }),
    ]);

    const menu = await Menu.new({ items });
    await menu.popup();
    return true;
  } catch {
    // 菜单失败不该让右键变成「什么都不发生」，交给调用方兜底。
    return false;
  }
}
