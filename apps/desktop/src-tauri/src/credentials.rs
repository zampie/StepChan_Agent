// 凭据：key 只在 Rust 侧读取，webview 通过 invoke 按需取用。
//
// 这是单用户桌面应用的取舍 —— key 本来就在用户本机，没有"服务端藏 key"可言。
// webview 拿到 key 是为了直连 realtime WebSocket（浏览器设不了 Authorization 头，
// 必须用 subprotocol 带 key）。要更严就得加一层 Rust 侧 WS 代理，接口已留好。
use serde::Serialize;
use std::path::{Path, PathBuf};

const DEFAULT_REALTIME_MODEL: &str = "stepaudio-3-realtime-preview";
const DEFAULT_VISION_MODEL: &str = "step-1o-turbo-vision";
const DEFAULT_CHAT_MODEL: &str = "step-3.7-flash";

/// 打包后的 .app 该去哪儿找 key。错误提示里也会报这个路径，别改一处漏一处。
const USER_ENV: &str = ".stepchan/.env";

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

/// 候选 .env 路径，按优先级。
///
/// **不要用相对路径。** 从 Finder 启动的 .app 的工作目录是 `/`，
/// 所以 `".env"` / `"../.env"` 这种写法在打包产物里永远匹配不到 ——
/// 开发时能跑、装好之后就报"拿不到凭据"，而且症状完全不指向原因。
/// 这里全部解析成绝对路径：先从可执行文件往上找（覆盖 `cargo run` 和从项目树里跑的情况），
/// 再从当前工作目录往上找（覆盖 `npm run tauri dev`），最后退到用户级配置。
fn env_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();

    let mut push_ancestors = |start: Option<PathBuf>| {
        if let Some(dir) = start {
            // 12 层足够从 target/debug/bundle/macos/X.app/Contents/MacOS 爬回项目根（要 8 层），
            // 也覆盖装到更深目录的情况。
            for ancestor in dir.ancestors().take(12) {
                out.push(ancestor.join(".env"));
            }
        }
    };

    push_ancestors(
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(Path::to_path_buf)),
    );
    push_ancestors(std::env::current_dir().ok());

    if let Some(home) = std::env::var_os("HOME") {
        let home = Path::new(&home);
        out.push(home.join(USER_ENV));
        out.push(home.join(".config/stepchan/.env"));
    }
    out
}

/// 加载 .env。刻意让文件**覆盖**已存在的环境变量：
/// shell 配置里的旧 export 会把鉴权/额度问题伪装成别的故障（gpt-image-lab 踩过这个坑）。
pub fn load_env() {
    for path in env_candidates() {
        if path.is_file() {
            match dotenvy::from_path_override(&path) {
                Ok(()) => {
                    eprintln!("[credentials] 已加载 {}", path.display());
                    return;
                }
                Err(err) => eprintln!("[credentials] {} 解析失败：{err}", path.display()),
            }
        }
    }
    eprintln!("[credentials] 没找到 .env；试过 {} 个候选路径", env_candidates().len());
}

#[tauri::command]
pub fn get_credentials() -> Result<Credentials, String> {
    let api_key = std::env::var("STEPFUN_API_KEY").unwrap_or_default();
    if api_key.trim().is_empty() {
        // 提示里必须给出可操作的绝对路径 —— "配置一下 key" 对用户没有任何帮助。
        let home = std::env::var("HOME").unwrap_or_else(|_| "~".into());
        return Err(format!(
            "没有找到 STEPFUN_API_KEY。请新建 {home}/{USER_ENV} 并写入：\nSTEPFUN_API_KEY=你的key\n然后重启 Step酱。"
        ));
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

/// 把 webview 里的错误转到进程 stderr。
///
/// 桌宠窗口没有地址栏也没有控制台，WKWebView 的 console 不会进 stderr，
/// 所以前端一旦出错（素材 404、CSP 拦截、WebGL 失败）在打包产物里是完全不可见的 ——
/// 表现只是"桌宠没出现"。这个命令让前端能把错误喊出来，从终端启动就能看到。
#[tauri::command]
pub fn log_frontend(level: String, message: String) {
    eprintln!("[webview/{level}] {message}");
}
