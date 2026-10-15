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
                    // 记下生效来源：排障时第一眼要看的就是"到底读了哪个文件"。
                    std::env::set_var("STEPCHAN_ENV_SOURCE", path.display().to_string());
                    return;
                }
                Err(err) => eprintln!("[credentials] {} 解析失败：{err}", path.display()),
            }
        }
    }
    eprintln!("[credentials] 没找到 .env；试过 {} 个候选路径", env_candidates().len());
}

/// key 的配置状态。**刻意不含 key 本身** —— 界面只需要知道「配好了没有」
/// 和「从哪儿来的」，把明文 key 送进 webview 再渲染到 DOM 是没必要的暴露面。
#[derive(Serialize)]
pub struct KeyStatus {
    configured: bool,
    /// 指纹：前 6 + 后 4 位。足够让用户确认"是我那把 key"，又不足以复用。
    fingerprint: String,
    /// 实际生效的来源路径，排障第一眼要看的就是这个。
    source: String,
    #[serde(rename = "userPath")]
    user_path: String,
}

fn fingerprint(key: &str) -> String {
    let n = key.chars().count();
    if n == 0 {
        return String::new();
    }
    if n <= 12 {
        return "•".repeat(n);
    }
    let head: String = key.chars().take(6).collect();
    let tail: String = key.chars().skip(n - 4).collect();
    format!("{head}…{tail}")
}

fn user_env_path() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| Path::new(&home).join(USER_ENV))
}

#[tauri::command]
pub fn credentials_status() -> KeyStatus {
    let key = std::env::var("STEPFUN_API_KEY").unwrap_or_default();
    let user_path = user_env_path()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    KeyStatus {
        configured: !key.trim().is_empty(),
        fingerprint: fingerprint(key.trim()),
        source: std::env::var("STEPCHAN_ENV_SOURCE").unwrap_or_default(),
        user_path,
    }
}

/// 把 key 写进用户级配置并立即生效。
///
/// 为什么写 `~/.stepchan/.env` 而不是塞进 tauri-plugin-store 的 settings.json：
/// 两者都是本机明文，但 .env 已经是这个项目既有的凭据位置（Rust 侧的加载顺序
/// 认它），写同一个地方意味着「设置里配」和「手动编辑文件」不会打架。
/// 真要更安全得上 Keychain，那是另一件事，不该顺手混进来。
///
/// 权限设成 0600：默认的 0644 会让同机其他用户能读到 key。
#[tauri::command]
pub fn set_api_key(key: String) -> Result<KeyStatus, String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("key 不能为空。".into());
    }
    // 只做最低限度的形状检查：真假只有调用时才知道，这里拦住明显的粘贴错误
    //（整段 JSON、带引号、含空格换行）就够了。
    if key.contains(char::is_whitespace) || key.len() < 8 {
        return Err("这看起来不像一个 API key（含空格或过短）。请只粘贴 key 本身。".into());
    }
    let path = user_env_path().ok_or("读不到 HOME，无法确定配置文件位置。")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("建目录失败：{e}"))?;
    }

    // 保留文件里的其他键（模型名、音色等），只替换 STEPFUN_API_KEY 这一行。
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let mut lines: Vec<String> = existing
        .lines()
        .filter(|l| !l.trim_start().starts_with("STEPFUN_API_KEY="))
        .map(str::to_string)
        .collect();
    lines.push(format!("STEPFUN_API_KEY={key}"));
    let body = lines.join("
") + "
";
    std::fs::write(&path, body).map_err(|e| format!("写入失败：{e}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // 写完立刻收紧权限。默认 0644 同机其他用户可读。
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }

    // 立即生效，不要求重启。
    std::env::set_var("STEPFUN_API_KEY", key);
    std::env::set_var("STEPCHAN_ENV_SOURCE", path.display().to_string());
    Ok(credentials_status())
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
