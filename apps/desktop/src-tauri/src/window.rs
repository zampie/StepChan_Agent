// Track A 负责本文件。
//
// 要求（这些是查证过的约束，不是建议）：
// 1. 窗口必须在这里用 WebviewWindowBuilder 建，并挂 on_permission_request
//    放行 PermissionKind::Microphone。那是 builder-only API，配置文件里没有。
//    不挂的话 macOS 14+ 会弹两次权限框，且在 WKWebView 里 getUserMedia 可能直接失败。
// 2. 窗口属性：transparent / decorations(false) / shadow(false) / always_on_top /
//    resizable(false) / accept_first_mouse(true) / visible_on_all_workspaces(true)。
//    accept_first_mouse 必开，否则对未聚焦的桌宠点第一下会被应用激活吞掉。
// 3. macOSPrivateApi 在 2.12.1+ 是 no-op，不要设。
// 4. 要浮在全屏应用之上，Tauri 自带 always_on_top 不够（只给 NSFloatingWindowLevel
//    + CanJoinAllSpaces）。必须在 apply_macos_overlay_behavior 里走 objc2-app-kit
//    设 FullScreenAuxiliary | Stationary | CanJoinAllSpaces，并把 level 提到
//    NSStatusWindowLevel。注意之后 is_always_on_top() 会返回 false，别依赖那个 getter。
// 5. 窗口位移节流到 ~30 Hz，粗粒度移动用。角色自身动画在 Pixi 里做，
//    不要每帧从 JS 调 set_position（每次都是 IPC + 主队列跳转）。
use tauri::{AppHandle, Runtime};

pub const PET_LABEL: &str = "pet";
pub const SETTINGS_LABEL: &str = "settings";

pub fn create_pet_window<R: Runtime>(_app: &AppHandle<R>) -> tauri::Result<()> {
    // TODO(Track A)
    Ok(())
}

/// 全屏共存 + 置顶层级。非 macOS 平台空实现。
pub fn apply_macos_overlay_behavior<R: Runtime>(_app: &AppHandle<R>) {
    // TODO(Track A)
}

#[tauri::command]
pub fn move_to_spot<R: Runtime>(_app: AppHandle<R>, _spot: String) -> Result<(), String> {
    // TODO(Track A)
    Err("move_to_spot 未实现".into())
}

#[tauri::command]
pub fn get_work_area<R: Runtime>(_app: AppHandle<R>) -> Result<serde_json::Value, String> {
    // TODO(Track A)
    // 注意：Monitor.position/size 是物理像素，窗口创建参数是逻辑像素，必须换算。
    // 另外 Tauri 的 cursor_position() 在混合 DPI 下换算有 bug（用主屏高度和主屏
    // scale_factor 套到所有屏），多屏要自己用 NSScreen frames 算。
    Err("get_work_area 未实现".into())
}
