// 设置：只存用户偏好（音色、各项感知开关、缩放、热键），不存聊天内容或录音。
// 形状必须与 shared/desktop.ts 的 settingsSchema 一致。
use serde_json::{json, Value};
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt;

const STORE: &str = "settings.json";

fn defaults() -> Value {
    json!({
        "voice": "yuanqishaonv",
        "voiceEnabled": true,
        // 隐私相关默认全关。要用户在菜单里主动打开。
        "screenAwareness": false,
        "appAwareness": false,
        "clipboardAwareness": false,
        "autonomy": false,
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
    Ok(current)
}
