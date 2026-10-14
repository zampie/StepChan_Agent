// Track D 负责本文件。见 os/mod.rs 顶部的约束说明。
//
// 截屏：走系统自带的 /usr/sbin/screencapture（内部就是 ScreenCaptureKit，
// 走同一套 TCC「屏幕与系统录制」权限，零新依赖，也不需要整个 Xcode）。
//
// 实测结论（不要凭假设改这里）：
// - screencapture **失败时仍然 exit 0**。用不存在的目录做目标时它打印
//   "screencapture: cannot write file to intended destination, <path>" 到 **stderr**，
//   退出码却是 0。所以退出码不是判据，**产物文件存在且非空**才是。
//   权限被拒时它打印 "could not create image from display"（二进制里还有
//   "could not create image from rect" / "...from window" 两个同族串，
//   对应 -R / -l 模式），同样不保证非零退出。
//   → 判定顺序：先看文件，再用 stderr 分类（TCC 拒绝 vs 其他错误）。
// - 一张 5120×2880 的 Retina 全屏 PNG 是 5.9–7.1 MB，base64 之后 7.9–9.5 MB。
//   直接塞进 HTTP body 不现实，所以用 /usr/bin/sips（同样是系统二进制）缩到
//   最长边 MAX_EDGE 再编码。实测缩放耗时约 0.1s。
// - 缩放档位实测（同一张 5120×2880）：
//     1280×720   PNG 634 KB  / base64 846 KB
//     1600×900   PNG 849–980 KB / base64 1.1–1.3 MB
//     2048×1152  PNG 1.77 MB / base64 2.35 MB            ← 当前默认
//     2560×1440  PNG 2.24 MB / base64 2.99 MB
//   主流视觉模型本来就把最长边压到 ~1568px，单看「她在干什么」1600 就够。
//   但「这段代码有问题吗」是明确的使用场景，而 2560 逻辑点的桌面压到 1600 时
//   文字只有 0.625×，代码基本糊掉 —— 所以取 2048，用翻倍的 body 换可读的文字。
// - sips 的 -Z 是「最长边不超过 N」，比目标小的图不会被放大，所以可以无条件跑。
//
// 隐私：产物写进 app cache 目录，读进内存后**立刻删除**（Drop guard 保证即使
// 中途 return 也会删）。AGENTS.md 禁止截屏落盘。
use base64::Engine;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, Runtime};

use crate::settings;

const SCREENCAPTURE: &str = "/usr/sbin/screencapture";
const SIPS: &str = "/usr/bin/sips";

/// 缩放后的最长边。见文件头的档位实测表。
const MAX_EDGE: u32 = 2048;

/// TCC 拒绝时 screencapture 打印的串族（display / rect / window 三种模式）。
const TCC_DENIED_MARKER: &str = "could not create image";

/// 开关关闭时的提示。必须点名菜单项，这样她能直接告诉用户去点哪儿。
const SWITCH_OFF: &str = "我现在看不到你的屏幕。点一下菜单栏里的 Step酱 图标，\
把「屏幕感知」勾上，我就能看了 —— 默认是关着的，截的图只在内存里过一遍，不会存盘。";

/// 系统级权限被拒时的提示。要可操作：说清去哪、点什么、以及必须重启。
const TCC_DENIED: &str = "系统没放我看屏幕。去「系统设置 → 隐私与安全性 → 屏幕与系统录制」，\
把 Step酱 打开，然后**退出再重新启动** Step酱（授权绑定在程序签名上，不重启不生效）。";

/// 权限探测结果缓存：避免前端每次渲染都 fork 一个进程。
/// granted 永久缓存（TCC 变更要求重启进程才生效），其余短 TTL 后重探。
static PERMISSION_CACHE: Mutex<Option<(Instant, &'static str)>> = Mutex::new(None);
const PERMISSION_TTL: Duration = Duration::from_secs(10);

/// 离开作用域就删文件。中途 return / panic 都不会留下截图。
struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn denied(message: &str) -> Value {
    json!({ "status": "denied", "message": message })
}

fn error(message: impl Into<String>) -> Value {
    json!({ "status": "error", "message": message.into() })
}

/// app cache 目录下的一个唯一路径。纳秒 + pid 足够避免并发碰撞。
fn scratch_path<R: Runtime>(app: &AppHandle<R>, tag: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("拿不到缓存目录：{e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("建不了缓存目录：{e}"))?;
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    Ok(dir.join(format!("{tag}-{}-{nanos}.png", std::process::id())))
}

/// 产物是否真的生成了。screencapture 的退出码不可信，所以只信文件。
fn produced(path: &Path) -> bool {
    std::fs::metadata(path).map(|m| m.len() > 0).unwrap_or(false)
}

enum Shot {
    Ok,
    /// TCC 拒绝。
    Denied,
    /// 其他失败（写不进去、找不到显示器…），带上 screencapture 自己的话。
    Failed(String),
}

/// 跑一次 screencapture，按「文件是否生成」+ stderr 分类。
fn run_capture(path: &Path, extra: &[&str]) -> Shot {
    let mut cmd = Command::new(SCREENCAPTURE);
    // -x 静音（不播快门声），-t png 指定格式。
    cmd.args(["-x", "-t", "png"]).args(extra).arg(path);

    let out = match cmd.output() {
        Ok(o) => o,
        Err(e) => return Shot::Failed(format!("{SCREENCAPTURE} 起不来：{e}")),
    };

    if produced(path) {
        return Shot::Ok;
    }

    // 文件没出来。错误信息在 stderr（stdout 一般是空的，但一起看更稳）。
    let mut text = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if text.is_empty() {
        text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    }
    if text.contains(TCC_DENIED_MARKER) {
        return Shot::Denied;
    }
    if text.is_empty() {
        text = format!("screencapture 没有产出文件（退出码 {:?}）", out.status.code());
    }
    Shot::Failed(text)
}

/// 用 sips 把最长边压到 MAX_EDGE。成功返回新路径，失败返回 None（调用方退回原图）。
fn downscale<R: Runtime>(app: &AppHandle<R>, src: &Path) -> Option<Scratch> {
    let dst = scratch_path(app, "shot-small").ok()?;
    let out = Command::new(SIPS)
        .args(["-Z", &MAX_EDGE.to_string(), "-s", "format", "png"])
        .arg(src)
        .arg("--out")
        .arg(&dst)
        .output()
        .ok()?;
    let guard = Scratch(dst);
    if out.status.success() && produced(&guard.0) {
        Some(guard)
    } else {
        // guard 在这里析构，半成品文件被删掉。
        None
    }
}

/// 从 PNG 的 IHDR 里读宽高。固定偏移：8 字节签名 + 4 长度 + 4 "IHDR"，
/// 然后两个大端 u32。比再 fork 一次 sips 便宜，也不用解码图片。
fn png_size(bytes: &[u8]) -> Option<(u32, u32)> {
    const SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
    if bytes.len() < 24 || !bytes.starts_with(SIGNATURE) || &bytes[12..16] != b"IHDR" {
        return None;
    }
    let read = |o: usize| u32::from_be_bytes([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]]);
    let (w, h) = (read(16), read(20));
    // schema 要求正整数。
    if w == 0 || h == 0 {
        None
    } else {
        Some((w, h))
    }
}

/// 返回 shared/desktop.ts 的 screenCaptureSchema 形状。
pub fn capture<R: Runtime>(app: &AppHandle<R>) -> Value {
    // 1. 开关。关着的时候给可操作的拒绝消息，不静默失败。
    if settings::read(app)["screenAwareness"] != Value::Bool(true) {
        return denied(SWITCH_OFF);
    }

    let raw = match scratch_path(app, "shot") {
        Ok(p) => Scratch(p),
        Err(e) => return error(e),
    };

    // 2. 抓图。-m 只抓主显示器：screencapture 的多屏语义是「一个文件一块屏」，
    //    只给一个路径时行为不确定，固定抓主屏更可预期。
    match run_capture(&raw.0, &["-m"]) {
        Shot::Ok => {}
        Shot::Denied => {
            // 探测缓存同步成 denied，省掉前端紧接着的一次探测。
            *PERMISSION_CACHE.lock() = Some((Instant::now(), "denied"));
            return denied(TCC_DENIED);
        }
        Shot::Failed(why) => return error(format!("截屏失败：{why}")),
    }
    *PERMISSION_CACHE.lock() = Some((Instant::now(), "granted"));

    // 3. 缩放。失败就用原图（大，但总比没有好）。
    let small = downscale(app, &raw.0);
    let source = small.as_ref().map_or(&raw.0, |s| &s.0);

    // 4. 读进内存。raw/small 两个 guard 在函数返回时把文件都删掉。
    let bytes = match std::fs::read(source) {
        Ok(b) => b,
        Err(e) => return error(format!("读不回截屏数据：{e}")),
    };

    let (width, height) = match png_size(&bytes) {
        Some(size) => size,
        None => return error("截屏产物不是合法 PNG。"),
    };

    json!({
        "status": "ok",
        "png": base64::engine::general_purpose::STANDARD.encode(&bytes),
        "width": width,
        "height": height,
    })
}

/// "granted" | "denied" | "unknown"，不弹窗、不留可见痕迹。
///
/// 做法：抓 1×1 区域（`-R0,0,1,1`，Retina 下实际产出 2×2、约 1.1 KB），
/// 配 -x 不出快门声、不写用户可见的文件，产物立刻删。
/// 刻意不用 CGPreflightScreenCaptureAccess —— Apple 正在劝退那组 API（见 os/mod.rs）。
///
/// 注意：1×1 探测走的是和正式截屏**同一个** TCC 闸门。在本机（已授权）实测它完全静默；
/// 未授权时会不会触发系统弹窗无法在本机验证，见报告里的「未验证」部分。
pub fn permission_status<R: Runtime>(app: &AppHandle<R>) -> String {
    if let Some((at, value)) = *PERMISSION_CACHE.lock() {
        // granted 永久有效：TCC 授权变化要重启进程才生效。
        if value == "granted" || at.elapsed() < PERMISSION_TTL {
            return value.to_string();
        }
    }

    let probe = match scratch_path(app, "probe") {
        Ok(p) => Scratch(p),
        // 连缓存目录都没有，说不出结论。
        Err(_) => return "unknown".into(),
    };

    let value = match run_capture(&probe.0, &["-R0,0,1,1"]) {
        Shot::Ok => "granted",
        Shot::Denied => "denied",
        Shot::Failed(_) => "unknown",
    };
    if value != "unknown" {
        *PERMISSION_CACHE.lock() = Some((Instant::now(), value));
    }
    value.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_size_reads_ihdr() {
        // 签名 + 长度(13) + "IHDR" + 宽 1600 + 高 900
        let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
        bytes.extend_from_slice(&13u32.to_be_bytes());
        bytes.extend_from_slice(b"IHDR");
        bytes.extend_from_slice(&1600u32.to_be_bytes());
        bytes.extend_from_slice(&900u32.to_be_bytes());
        assert_eq!(png_size(&bytes), Some((1600, 900)));
    }

    #[test]
    fn png_size_rejects_garbage() {
        assert_eq!(png_size(b"not a png at all, really not"), None);
        assert_eq!(png_size(b""), None);
        // 签名对但 IHDR 不对。
        let mut bad = b"\x89PNG\r\n\x1a\n".to_vec();
        bad.extend_from_slice(&[0u8; 16]);
        assert_eq!(png_size(&bad), None);
    }

    // 真的跑一次 screencapture，验证「产物文件」判据和 1×1 探测。
    // 不依赖 AppHandle，所以在普通 cargo test 下就能跑。
    #[test]
    fn screencapture_probe_behaves_as_documented() {
        let dir = std::env::temp_dir().join(format!("stepchan-screen-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let probe = Scratch(dir.join("probe.png"));

        match run_capture(&probe.0, &["-R0,0,1,1"]) {
            Shot::Ok => {
                let bytes = std::fs::read(&probe.0).unwrap();
                let size = png_size(&bytes).expect("探测产物应当是合法 PNG");
                println!("1×1 探测 → granted，产物 {} 字节，尺寸 {size:?}", bytes.len());
                // Retina 下 1 逻辑像素 = 2 物理像素，所以这里是 2×2 而不是 1×1。
                assert!(size.0 <= 4 && size.1 <= 4, "探测不该抓出大图：{size:?}");
            }
            Shot::Denied => println!("1×1 探测 → denied（本机未授权屏幕录制）"),
            Shot::Failed(why) => println!("1×1 探测 → unknown：{why}"),
        }

        // 写不进去的目标：实测 screencapture 退出码是 0，错误只在 stderr，
        // 文件不会生成 —— 这正是「只信文件」判据存在的原因。
        let bogus = Path::new("/stepchan-nonexistent-dir/shot.png");
        match run_capture(bogus, &["-m"]) {
            Shot::Failed(why) => println!("写入失败路径 → Failed（符合预期）：{why}"),
            Shot::Denied => println!("写入失败路径 → Denied（本机未授权，先撞上 TCC）"),
            Shot::Ok => panic!("不该成功：{bogus:?}"),
        }

        drop(probe);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
