// 凭据：key 只在 Rust 侧读取，webview 通过 invoke 按需取用。
//
// 这是单用户桌面应用的取舍 —— key 本来就在用户本机，没有"服务端藏 key"可言。
// webview 拿到 key 是为了直连 realtime WebSocket（浏览器设不了 Authorization 头，
// 必须用 subprotocol 带 key）。要更严就得加一层 Rust 侧 WS 代理，接口已留好。
use serde::Serialize;

const DEFAULT_REALTIME_MODEL: &str = "stepaudio-3-realtime-preview";
const DEFAULT_VISION_MODEL: &str = "step-1o-turbo-vision";
const DEFAULT_CHAT_MODEL: &str = "step-3.7-flash";

#[derive(Serialize)]
pub struct Credentials {
    #[serde(rename = "apiKey")]
    api_key: String,
    #[serde(rename = "realtimeModel")]
    realtime_model: String,
    #[serde(rename = "visionModel")]
    vision_model: String,
    #[serde(rename = "chatModel")]
    chat_model: String,
}

/// 从项目根 .env 加载。文件优先于已存在的进程环境变量 —— shell 配置里的旧 export
/// 会把鉴权/额度问题伪装成别的故障（gpt-image-lab 踩过这个坑）。
pub fn load_env() {
    for candidate in [".env", "../.env", "../../.env", "../../../.env", "../../../../.env"] {
        if std::path::Path::new(candidate).exists() {
            let _ = dotenvy::from_filename_override(candidate);
            return;
        }
    }
    // 打包后的 .app 里没有项目目录，退回用户配置文件。
    if let Some(home) = std::env::var_os("HOME") {
        let path = std::path::Path::new(&home).join(".stepchan/.env");
        if path.exists() {
            let _ = dotenvy::from_path_override(&path);
        }
    }
}

#[tauri::command]
pub fn get_credentials() -> Result<Credentials, String> {
    let api_key = std::env::var("STEPFUN_API_KEY").unwrap_or_default();
    if api_key.trim().is_empty() {
        return Err(
            "没有找到 STEPFUN_API_KEY。请在项目根目录 .env 或 ~/.stepchan/.env 里配置后重启。"
                .into(),
        );
    }
    Ok(Credentials {
        api_key,
        realtime_model: std::env::var("STEPFUN_REALTIME_MODEL")
            .unwrap_or_else(|_| DEFAULT_REALTIME_MODEL.into()),
        vision_model: std::env::var("STEPFUN_VISION_MODEL")
            .unwrap_or_else(|_| DEFAULT_VISION_MODEL.into()),
        chat_model: std::env::var("STEPFUN_MODEL").unwrap_or_else(|_| DEFAULT_CHAT_MODEL.into()),
    })
}
