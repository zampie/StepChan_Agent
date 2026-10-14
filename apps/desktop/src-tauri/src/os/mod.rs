// Track D 负责 os/ 下所有文件。
//
// 隐私底线（AGENTS.md 本轮已显式修改，照这个执行）：
//   截屏、前台应用、剪贴板三项默认关闭，由 settings 控制；
//   关闭时命令返回明确的拒绝消息（不是静默失败），这样她能告诉用户"你得先打开开关"；
//   每次实际读取都要让前端冒出可见提示；截屏数据只在内存里走，不落盘。
//
// 平台约束：
// - 截屏走系统自带的 /usr/sbin/screencapture（见 Cargo.toml 里的理由：screencapturekit
//   硬依赖 apple-metal，需要 macOS 26 SDK，本机只有 Command Line Tools，编不过）。
//   用法：screencapture -x -t png <path>，-x 静音。写到 app cache 目录后立刻读入内存并删除。
//   权限被拒时它会打印 "could not create image from display" —— 这就是判据，
//   不要额外用 CGPreflightScreenCaptureAccess（Apple 正在劝退那组 API）。
//   ⚠️ 实测补充：screencapture **失败时退出码仍然是 0**，错误只写 stderr，
//   所以判据是「产物文件存在且非空」+ stderr 内容分类，不是退出码。详见 screen.rs 头部。
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

use serde_json::Value;
use tauri::{AppHandle, Runtime};

/// 必须与 shared/desktop.ts 的 desktopEvents.frontmostChanged 一致。
pub const FRONTMOST_CHANGED: &str = "pet://frontmost-changed";

/// 剪贴板一次最多回灌多少字符。用户可能复制了一整个文件；
/// 对话里用不上那么多，也别把它塞进模型上下文。
#[cfg(target_os = "macos")]
const CLIPBOARD_MAX_CHARS: usize = 4000;

/// 非 macOS 平台（将来的 Android）上统一的"没有这个能力"回复。
#[cfg(not(target_os = "macos"))]
fn unsupported(what: &str) -> Value {
    serde_json::json!({ "status": "error", "message": format!("当前平台不支持{what}。") })
}

#[tauri::command]
pub fn capture_screen<R: Runtime>(app: AppHandle<R>) -> Value {
    #[cfg(target_os = "macos")]
    {
        screen::capture(&app)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        unsupported("截屏")
    }
}

#[tauri::command]
pub fn screen_permission_status<R: Runtime>(app: AppHandle<R>) -> String {
    #[cfg(target_os = "macos")]
    {
        screen::permission_status(&app)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        "unknown".into()
    }
}

#[tauri::command]
pub fn get_frontmost_app<R: Runtime>(app: AppHandle<R>) -> Option<Value> {
    #[cfg(target_os = "macos")]
    {
        frontmost::frontmost(&app)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        None
    }
}

#[tauri::command]
pub fn get_system_status<R: Runtime>(app: AppHandle<R>) -> Option<Value> {
    let _ = &app;
    #[cfg(target_os = "macos")]
    {
        Some(battery::system_status())
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// 读一次剪贴板文字。受 settings 的 clipboardAwareness 开关控制（默认关）。
///
/// 返回 None 的三种情况前端都当"没读到"：开关关着、剪贴板里不是文字、读取失败。
/// 开关关闭时的"去打开开关"提示由工具层（brain 的 read_clipboard）负责措辞 ——
/// 这个命令的契约是 `Promise<string | null>`，塞不进拒绝消息。
#[tauri::command]
pub fn read_clipboard_text<R: Runtime>(app: AppHandle<R>) -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        use tauri_plugin_clipboard_manager::ClipboardExt;

        if crate::settings::read(&app)["clipboardAwareness"] != Value::Bool(true) {
            return None;
        }
        // 剪贴板里是图片/文件时 read_text 会报错，当作"没有文字"处理。
        let text = app.clipboard().read_text().ok()?;
        if text.trim().is_empty() {
            return None;
        }
        if text.chars().count() > CLIPBOARD_MAX_CHARS {
            let head: String = text.chars().take(CLIPBOARD_MAX_CHARS).collect();
            return Some(format!("{head}…（剪贴板内容过长，只读了前 {CLIPBOARD_MAX_CHARS} 个字）"));
        }
        Some(text)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        None
    }
}

/// 前台应用变化监听，带防抖与配额；变化时发 desktopEvents.frontmostChanged。
pub fn spawn_frontmost_watch<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(target_os = "macos")]
    {
        frontmost::spawn_watch(app);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
    }
}
