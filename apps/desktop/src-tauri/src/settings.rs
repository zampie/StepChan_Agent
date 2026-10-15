// 设置：只存用户偏好（音色、各项感知开关、缩放、热键），不存聊天内容或录音。
// 形状必须与 shared/desktop.ts 的 settingsSchema 一致。
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_store::StoreExt;

const STORE: &str = "settings.json";

/// 设置变更广播。必须与 shared/desktop.ts 的 desktopEvents.settingsChanged 一致。
pub const SETTINGS_CHANGED: &str = "pet://settings-changed";

/// 设置的默认值**兼白名单**：`settings_set` 只接受这里出现过的键。
///
/// ⚠️ 这份表必须和 `shared/desktop.ts` 的 `settingsSchema` 逐键一致。
/// 它们是同一个形状的两个真相源，少加一个键的后果是**静默丢弃**：
/// 前端写进去不报错、读回来还是默认值，表现为「开关点了没反应、菜单永远打钩」。
/// 这个坑真的踩过（listening 等 6 个键）。`tests/settings-parity.test.ts`
/// 现在会直接解析本函数并与 zod schema 比对，漏一个就红。
fn defaults() -> Value {
    json!({
        "voice": "yuanqishaonv",
        "voiceEnabled": true,
        "listening": true,
        "voiceInterruptible": false,
        "brainMode": "realtime",
        "chatModel": "step-5-preview",
        // 隐私相关默认全关。要用户在菜单里主动打开。
        "screenAwareness": false,
        "appAwareness": false,
        "clipboardAwareness": false,
        "autonomy": false,
        "sleepAfterMinutes": 5,
        "petScale": 1.0,
        "reduceMotion": false,
        "hotkey": "Alt+Space"
    })
}

pub fn read<R: Runtime>(app: &AppHandle<R>) -> Value {
    let mut merged = defaults();
    if let Ok(store) = app.store(STORE) {
        if let (Some(map), Some(obj)) = (merged.as_object_mut(), store.get("settings")) {
            if let Some(saved) = obj.as_object() {
                for (k, v) in saved {
                    if map.contains_key(k) {
                        map.insert(k.clone(), v.clone());
                    }
                }
            }
        }
    }
    merged
}

#[tauri::command]
pub fn settings_get<R: Runtime>(app: AppHandle<R>) -> Value {
    read(&app)
}

#[tauri::command]
pub fn settings_set<R: Runtime>(app: AppHandle<R>, patch: Value) -> Result<Value, String> {
    let mut current = read(&app);
    let map = current.as_object_mut().ok_or("设置格式损坏")?;
    // 只接受已知键，不让未知键污染存储。
    let known = defaults();
    if let Some(incoming) = patch.as_object() {
        for (k, v) in incoming {
            if known.get(k).is_some() {
                map.insert(k.clone(), v.clone());
            }
        }
    }
    let store = app.store(STORE).map_err(|e| e.to_string())?;
    store.set("settings", current.clone());
    store.save().map_err(|e| e.to_string())?;
    // 广播给**所有**窗口。桌宠窗和设置窗各自缓存了一份设置，
    // 不广播的话从一边改完另一边还显示旧值 —— 用户看到的是
    // 「右键菜单和设置里的同一个开关状态不一样」。
    let _ = app.emit(SETTINGS_CHANGED, current.clone());
    Ok(current)
}
