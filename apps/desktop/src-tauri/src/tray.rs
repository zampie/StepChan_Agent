// Track A 负责本文件。
//
// 托盘菜单项（事件名发到前端 desktopEvents.trayCommand，载荷是菜单 id）：
//   talk            唤起对话（等同热键）
//   voice           CheckMenuItem：语音开关
//   voice_<id>      子菜单：音色选择（yuanqishaonv / jilingshaonv / ruanmengnvsheng /
//                   linjiameimei / livelybreezy-female）。注意换音色必须重建
//                   realtime 会话 —— 模型首次出音后 voice 不可改。
//   screen          CheckMenuItem：屏幕感知（默认关）
//   app_awareness   CheckMenuItem：前台应用感知（默认关）
//   autonomy        CheckMenuItem：自主行动（默认关）
//   scale_<n>       子菜单：桌宠大小
//   settings        打开设置窗口
//   autostart       CheckMenuItem：开机自启
//   quit            退出
//
// 约束：
// - Cargo 的 tray-icon feature 已开。图标用 icons/tray.png + icon_as_template(true)。
// - show_menu_on_left_click(false)；menuOnLeftClick 自 v2.2 起失效，别用。
// - 勾选状态要从 settings::read() 初始化，并在变更后回写 settings。
// - 热键走 Carbon RegisterEventHotKey，无需辅助功能权限 —— 但媒体键会走
//   CGEventTap 并要求权限，所以不要注册媒体键。
// - macOS 上热键注册必须在主线程，插件内部会派发并阻塞等待。
use tauri::{AppHandle, Runtime};

pub fn build_tray<R: Runtime>(_app: &AppHandle<R>) -> tauri::Result<()> {
    // TODO(Track A)
    Ok(())
}

#[cfg(desktop)]
pub fn register_hotkey<R: Runtime>(_app: &AppHandle<R>) -> tauri::Result<()> {
    // TODO(Track A)：默认 Alt+Space，触发时向前端发 desktopEvents.hotkey
    Ok(())
}
