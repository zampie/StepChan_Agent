// Track D 负责 os/ 下所有文件。
//
// 隐私底线（AGENTS.md 本轮已显式修改，照这个执行）：
//   截屏、前台应用、剪贴板三项默认关闭，由 settings 控制；
//   关闭时命令返回明确的拒绝消息（不是静默失败），这样她能告诉用户"你得先打开开关"；
//   每次实际读取都要让前端冒出可见提示；截屏数据只在内存里走，不落盘。
//
// 平台约束：
// - 截屏用 screencapturekit（真 ScreenCaptureKit）。不要 xcap —— 它 macOS 路径还是
//   已废弃的 CGWindowListCreateImage，会让系统提示用户"该应用在绕过安全设置"。
// - 录屏权限是 TCC「屏幕与系统录制」，没有 Info.plist 键可声明。可用
//   CGPreflightScreenCaptureAccess 预检（不触发弹窗）、CGRequestScreenCaptureAccess 触发；
//   但 Apple 正在劝退这组 API，拿不准就用 SCShareableContent::get() 的 SCError 当判据。
// - 前台应用名走 NSWorkspace::frontmostApplication()，无 TCC 提示。
//   读窗口标题才需要辅助功能权限 —— 不要读标题。
// - 电量用 starship-battery（battery crate 2020 年就停更了）。
// - TCC 授权绑定代码签名，ad-hoc 签名每次重建都会重新弹窗。
#[cfg(target_os = "macos")]
mod battery;
#[cfg(target_os = "macos")]
mod frontmost;
#[cfg(target_os = "macos")]
mod screen;

use tauri::{AppHandle, Runtime};

#[tauri::command]
pub fn capture_screen<R: Runtime>(_app: AppHandle<R>) -> serde_json::Value {
    // TODO(Track D)：返回 shared/desktop.ts 的 screenCaptureSchema 形状
    serde_json::json!({ "status": "error", "message": "截屏未实现" })
}

#[tauri::command]
pub fn screen_permission_status() -> String {
    // TODO(Track D)："granted" | "denied" | "unknown"
    "unknown".into()
}

#[tauri::command]
pub fn get_frontmost_app<R: Runtime>(_app: AppHandle<R>) -> Option<serde_json::Value> {
    // TODO(Track D)
    None
}

#[tauri::command]
pub fn get_system_status<R: Runtime>(_app: AppHandle<R>) -> Option<serde_json::Value> {
    // TODO(Track D)
    None
}

#[tauri::command]
pub fn read_clipboard_text<R: Runtime>(_app: AppHandle<R>) -> Option<String> {
    // TODO(Track D)：要先查 settings 的开关
    None
}

/// 前台应用变化监听，带防抖与配额；变化时发 desktopEvents.frontmostChanged。
pub fn spawn_frontmost_watch<R: Runtime>(_app: &AppHandle<R>) {
    // TODO(Track D)
}
