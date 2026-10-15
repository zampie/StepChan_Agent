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
 * 右键菜单里的语速档位。细调（0.8~1.8 连续）在设置窗里。
 * 1.15 是默认档 —— 模型原速听着有点慢。
 */
export const SPEECH_RATE_PRESETS: { label: string; value: number }[] = [
  { label: '慢一点（0.9×）', value: 0.9 },
  { label: '正常（1.15×）', value: 1.15 },
  { label: '快一点（1.4×）', value: 1.4 },
];


export type PetMenuActions = {
  onType: () => void;
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
    const speedMenu = async () => {
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
      return Submenu.new({ id: 'speech_rate', text: '语速', items });
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
