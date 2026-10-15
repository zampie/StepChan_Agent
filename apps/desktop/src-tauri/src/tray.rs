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
//   clipboard       CheckMenuItem：剪贴板感知（默认关）
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
//
// 设置回写策略：托盘是设置的权威写入方（直接调 settings::settings_set 的逻辑，
// 不改 settings.rs），写完再把菜单 id 转发给前端，前端收到后重新 settings_get 即可，
// 不用自己猜语义。
use serde_json::{json, Value};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::settings;
use crate::window;

/// 音色清单。顺序即菜单顺序。
///
/// ⚠️ 必须与 `shared/desktop.ts` 的 `voices` **逐项逐字**一致（id 和中文标签都算）。
/// 跨语言没法共用一份，所以 `tests/settings-parity.test.ts` 会解析本常量并比对。
/// 不一致的后果不是报错，而是同一个音色在设置窗里和右键菜单里叫两个名字 ——
/// 这已经发生过一次（livelybreezy-female 曾是「轻快爽朗」vs「活力轻快」）。
const VOICES: &[(&str, &str)] = &[
    ("yuanqishaonv", "元气少女"),
    ("jilingshaonv", "机灵少女"),
    ("ruanmengnvsheng", "软萌女声"),
    ("linjiameimei", "邻家妹妹"),
    ("livelybreezy-female", "活力轻快"),
];

/// 桌宠大小。id 用整数百分比（scale_<n>），避免 id 里出现小数点。
const SCALES: &[(u32, &str)] = &[(80, "小"), (100, "标准"), (125, "大"), (150, "特大")];

fn bool_at(settings: &Value, key: &str, fallback: bool) -> bool {
    settings
        .get(key)
        .and_then(Value::as_bool)
        .unwrap_or(fallback)
}

/// 直接走 settings.rs 的命令实现回写。只认已知键，不污染存储。
fn write_setting<R: Runtime>(app: &AppHandle<R>, key: &str, value: Value) {
    if let Err(err) = settings::settings_set(app.clone(), json!({ key: value })) {
        eprintln!("[tray] 写设置 {key} 失败：{err}");
    }
}

pub fn build_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let current = settings::read(app);
    let voice_id = current
        .get("voice")
        .and_then(Value::as_str)
        .unwrap_or("yuanqishaonv")
        .to_string();
    let pet_scale = current
        .get("petScale")
        .and_then(Value::as_f64)
        .unwrap_or(1.0);
    let scale_percent = (pet_scale * 100.0).round() as u32;

    let talk = MenuItem::with_id(app, "talk", "和 Step酱 说话", true, None::<&str>)?;

    let voice = CheckMenuItem::with_id(
        app,
        "voice",
        "语音",
        true,
        bool_at(&current, "voiceEnabled", true),
        None::<&str>,
    )?;

    let voice_items: Vec<CheckMenuItem<R>> = VOICES
        .iter()
        .map(|(id, label)| {
            CheckMenuItem::with_id(
                app,
                format!("voice_{id}"),
                *label,
                true,
                *id == voice_id,
                None::<&str>,
            )
        })
        .collect::<tauri::Result<_>>()?;
    let voice_refs: Vec<&dyn tauri::menu::IsMenuItem<R>> = voice_items
        .iter()
        .map(|i| i as &dyn tauri::menu::IsMenuItem<R>)
        .collect();
    let voice_menu = Submenu::with_items(app, "音色", true, &voice_refs)?;

    let screen = CheckMenuItem::with_id(
        app,
        "screen",
        "看屏幕（需录屏权限）",
        true,
        bool_at(&current, "screenAwareness", false),
        None::<&str>,
    )?;
    let app_awareness = CheckMenuItem::with_id(
        app,
        "app_awareness",
        "知道我在用什么应用",
        true,
        bool_at(&current, "appAwareness", false),
        None::<&str>,
    )?;
    // 没有这一项的话 clipboardAwareness 永远打不开，read_clipboard_text 恒返回 None。
    let clipboard = CheckMenuItem::with_id(
        app,
        "clipboard",
        "剪贴板感知",
        true,
        bool_at(&current, "clipboardAwareness", false),
        None::<&str>,
    )?;
    let autonomy = CheckMenuItem::with_id(
        app,
        "autonomy",
        "允许主动搭话",
        true,
        bool_at(&current, "autonomy", false),
        None::<&str>,
    )?;

    let scale_items: Vec<CheckMenuItem<R>> = SCALES
        .iter()
        .map(|(percent, label)| {
            CheckMenuItem::with_id(
                app,
                format!("scale_{percent}"),
                *label,
                true,
                *percent == scale_percent,
                None::<&str>,
            )
        })
        .collect::<tauri::Result<_>>()?;
    let scale_refs: Vec<&dyn tauri::menu::IsMenuItem<R>> = scale_items
        .iter()
        .map(|i| i as &dyn tauri::menu::IsMenuItem<R>)
        .collect();
    let scale_menu = Submenu::with_items(app, "大小", true, &scale_refs)?;

    let settings_item = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?;
    let autostart_item = CheckMenuItem::with_id(
        app,
        "autostart",
        "开机自启",
        true,
        autostart_enabled(app),
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "退出 Step酱", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &talk,
            &PredefinedMenuItem::separator(app)?,
            &voice,
            &voice_menu,
            &PredefinedMenuItem::separator(app)?,
            &screen,
            &app_awareness,
            &clipboard,
            &autonomy,
            &PredefinedMenuItem::separator(app)?,
            &scale_menu,
            &settings_item,
            &autostart_item,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    // 托盘图标：模板图会被系统按亮/暗色自动反色，所以 tray.png 必须是纯黑+alpha。
    let icon = Image::from_bytes(include_bytes!("../icons/tray.png"))?;

    let voice_group = voice_items.clone();
    let scale_group = scale_items.clone();
    let autostart_handle = autostart_item.clone();

    TrayIconBuilder::with_id("stepchan")
        .icon(icon)
        .icon_as_template(true)
        .tooltip("Step酱")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| {
            let id = event.id().0.clone();
            handle_menu(app, &id, &voice_group, &scale_group, &autostart_handle);
            // 不论 Rust 侧做了什么，都把 id 转发给前端：有些命令（talk / 换音色要
            // 重建 realtime 会话）只有前端能执行。
            let _ = app.emit(window::events::TRAY_COMMAND, id);
        })
        .build(app)?;

    wire_drag_drop(app);
    Ok(())
}

fn handle_menu<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    voice_items: &[CheckMenuItem<R>],
    scale_items: &[CheckMenuItem<R>],
    autostart_item: &CheckMenuItem<R>,
) {
    match id {
        "talk" => {
            // 纯前端动作，这里只负责保证窗口可见。
            if let Some(pet) = app.get_webview_window(window::PET_LABEL) {
                let _ = pet.show();
            }
        }
        "voice" => {
            // muda 的 CheckMenuItem 点击后会自己翻转勾选，这里只需把新值落盘。
            let next = !bool_at(&settings::read(app), "voiceEnabled", true);
            write_setting(app, "voiceEnabled", Value::Bool(next));
        }
        "screen" => {
            let next = !bool_at(&settings::read(app), "screenAwareness", false);
            write_setting(app, "screenAwareness", Value::Bool(next));
        }
        "app_awareness" => {
            let next = !bool_at(&settings::read(app), "appAwareness", false);
            write_setting(app, "appAwareness", Value::Bool(next));
        }
        "clipboard" => {
            let next = !bool_at(&settings::read(app), "clipboardAwareness", false);
            write_setting(app, "clipboardAwareness", Value::Bool(next));
        }
        "autonomy" => {
            let next = !bool_at(&settings::read(app), "autonomy", false);
            write_setting(app, "autonomy", Value::Bool(next));
        }
        "settings" => window::show_settings_window(app),
        "autostart" => toggle_autostart(app, autostart_item),
        "quit" => app.exit(0),
        other => {
            if let Some(voice) = other.strip_prefix("voice_") {
                write_setting(app, "voice", Value::String(voice.to_string()));
                // 单选语义要自己维护：muda 的 CheckMenuItem 之间没有互斥关系。
                for item in voice_items {
                    let _ = item.set_checked(item.id().0 == other);
                }
            } else if let Some(percent) = other.strip_prefix("scale_") {
                if let Ok(value) = percent.parse::<f64>() {
                    let scale = (value / 100.0).clamp(0.5, 2.0);
                    write_setting(app, "petScale", json!(scale));
                }
                for item in scale_items {
                    let _ = item.set_checked(item.id().0 == other);
                }
            }
        }
    }
}

/// 拖放：穿透开启时窗口收不到任何拖放事件，所以前端拖放前必须先 setInteractive(true)。
/// 这里只负责把 Drop 转成 shared/desktop.ts 的 DragDropPayload 形状。
fn wire_drag_drop<R: Runtime>(app: &AppHandle<R>) {
    let Some(pet) = app.get_webview_window(window::PET_LABEL) else {
        return;
    };
    let handle = app.clone();
    pet.on_window_event(move |event| {
        if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
            let paths: Vec<String> = paths
                .iter()
                .map(|p| p.to_string_lossy().to_string())
                .collect();
            let _ = handle.emit(
                window::events::DRAG_DROP,
                json!({ "kind": "files", "paths": paths }),
            );
        }
    });
}

#[cfg(desktop)]
fn autostart_enabled<R: Runtime>(app: &AppHandle<R>) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[cfg(not(desktop))]
fn autostart_enabled<R: Runtime>(_app: &AppHandle<R>) -> bool {
    false
}

#[cfg(desktop)]
fn toggle_autostart<R: Runtime>(app: &AppHandle<R>, item: &CheckMenuItem<R>) {
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    let enabled = manager.is_enabled().unwrap_or(false);
    let result = if enabled {
        manager.disable()
    } else {
        manager.enable()
    };
    match result {
        Ok(()) => {
            let _ = item.set_checked(!enabled);
        }
        Err(err) => {
            eprintln!("[tray] 切换开机自启失败：{err}");
            // 失败就把勾选拨回真实状态，别让菜单撒谎。
            let _ = item.set_checked(enabled);
        }
    }
}

#[cfg(not(desktop))]
fn toggle_autostart<R: Runtime>(_app: &AppHandle<R>, _item: &CheckMenuItem<R>) {}

#[cfg(desktop)]
pub fn register_hotkey<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    // 默认 Alt+Space，触发时向前端发 desktopEvents.hotkey。
    // Alt+Space 走 Carbon RegisterEventHotKey，不需要辅助功能权限；
    // 媒体键会走 CGEventTap 并触发 TCC 弹窗，所以一个都不注册。
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

    let accelerator = settings::read(app)
        .get("hotkey")
        .and_then(Value::as_str)
        .unwrap_or("Alt+Space")
        .to_string();

    // 注册失败（被别的应用占了）不该拖垮启动 —— 打日志，让其余功能照常跑。
    if let Err(err) = app
        .global_shortcut()
        .on_shortcut(accelerator.as_str(), |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                let _ = app.emit(window::events::HOTKEY, ());
            }
        })
    {
        eprintln!("[tray] 热键 {accelerator} 注册失败：{err}");
    }
    Ok(())
}
