// 桌宠的右键菜单。
//
// 用系统原生菜单而不是在 webview 里画一个 HTML 菜单，原因有三：
// 1. 窗口只有 420×520，HTML 菜单会被窗口边界裁掉，而原生菜单可以超出窗口。
// 2. HTML 菜单需要那块区域可点，而窗口默认是穿透的（命中判定只认角色身上），
//    等于又要为菜单单独开一块交互区，容易和穿透逻辑打架。
// 3. 和托盘菜单观感一致，不用自己做高亮、键盘导航、点击外部关闭。
import type { Settings } from '../../../../shared/desktop';

export type PetMenuActions = {
  onType: () => void;
  onToggleVoice: (next: boolean) => void;
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
    const menu = await Menu.new({
      items: [
        { id: 'type', text: '打字跟她说…', action: actions.onType },
        {
          id: 'voice',
          text: settings.voiceEnabled ? '关闭语音' : '开启语音',
          action: () => actions.onToggleVoice(!settings.voiceEnabled),
        },
        { item: 'Separator' },
        { id: 'aside', text: '让一让（挪到角落）', action: actions.onMoveAside },
        { id: 'settings', text: '设置…', action: actions.onOpenSettings },
        { item: 'Separator' },
        { id: 'quit', text: '退出 Step酱', action: actions.onQuit },
      ],
    });
    await menu.popup();
    return true;
  } catch {
    // 菜单失败不该让右键变成「什么都不发生」，交给调用方兜底。
    return false;
  }
}
