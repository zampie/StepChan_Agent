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
//
// 坐标系备忘（查证自 tao 0.37 / tauri-runtime-wry 2.12 的 macOS 实现）：
//   - Monitor::position/size/work_area 都是物理像素，= 逻辑值 × 该显示器自己的
//     scale_factor。所以 逻辑 = 物理 / monitor.scale_factor()。
//   - Window::outer_position/outer_size 是物理像素，= 逻辑值 × 窗口所在屏的
//     scale_factor。所以 逻辑 = 物理 / window.scale_factor()。
//   - set_position 收到 LogicalPosition 时不再换算，直接按逻辑点设 NSWindow frame。
//   因此本文件内部统一用「逻辑点 + 左上原点」这一套坐标，只在读 Tauri 的 physical
//   getter 时除一次对应的 scale factor —— 混合 DPI 下混用两套 scale 就是错位的来源。
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{
    AppHandle, LogicalPosition, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

pub const PET_LABEL: &str = "pet";
pub const SETTINGS_LABEL: &str = "settings";

/// Rust → webview 的事件名。必须与 shared/desktop.ts 的 desktopEvents 完全一致。
pub mod events {
    pub const HIT_TEST: &str = "pet://hit-test";
    pub const TRAY_COMMAND: &str = "pet://tray-command";
    pub const HOTKEY: &str = "pet://hotkey";
    pub const DRAG_DROP: &str = "pet://drag-drop";
}

/// 窗口给得宽松些：角色在 Pixi 里动，窗口不每帧跟着跑。
pub const PET_WIDTH: f64 = 420.0;
pub const PET_HEIGHT: f64 = 520.0;
const SETTINGS_WIDTH: f64 = 420.0;
const SETTINGS_HEIGHT: f64 = 560.0;
/// 落脚点与工作区边缘的留白（逻辑点）。
const EDGE_MARGIN: f64 = 24.0;

/// 补间的代号。新的 move_to_spot 会让旧补间线程自己退出，不会两个打架。
static TWEEN_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug)]
struct LogicalRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

pub fn create_pet_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if app.get_webview_window(PET_LABEL).is_none() {
        let builder =
            WebviewWindowBuilder::new(app, PET_LABEL, WebviewUrl::App("index.html".into()))
                .title("Step酱")
                .inner_size(PET_WIDTH, PET_HEIGHT)
                .transparent(true)
                .decorations(false)
                .shadow(false)
                .always_on_top(true)
                .resizable(false)
                .maximizable(false)
                .minimizable(false)
                .accept_first_mouse(true)
                .visible_on_all_workspaces(true)
                .skip_taskbar(true)
                // 创建时不抢焦点：桌宠出现不该把用户正在打的字打断。
                .focused(false)
                .visible(true)
                // 这是窗口必须用 Rust 建的唯一理由：builder-only API，放行麦克风，
                // 省掉 macOS 14+ 的二次弹窗 / getUserMedia 在 WKWebView 里直接失败。
                .on_permission_request(|_webview, kind| {
                    use tauri::webview::{PermissionKind, PermissionResponse};
                    match kind {
                        PermissionKind::Microphone => PermissionResponse::Allow,
                        _ => PermissionResponse::Default,
                    }
                });

        let window = builder.build()?;

        // 位置等窗口建好、拿到真实 scale factor 之后再算，否则混合 DPI 下会偏。
        if let Some((x, y)) = spot_position(&window, "bottom_right") {
            let _ = window.set_position(LogicalPosition::new(x, y));
        }
    }

    create_settings_window(app)?;
    Ok(())
}

/// 设置窗口：普通带边框窗口，初始隐藏，由托盘按需唤出。
/// 用 hash 路由（#/settings）而不是真路径 —— SPA 下最省事，生产 tauri:// 协议也不用配 rewrite。
fn create_settings_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if app.get_webview_window(SETTINGS_LABEL).is_some() {
        return Ok(());
    }
    WebviewWindowBuilder::new(
        app,
        SETTINGS_LABEL,
        WebviewUrl::App("index.html#/settings".into()),
    )
    .title("Step酱 设置")
    .inner_size(SETTINGS_WIDTH, SETTINGS_HEIGHT)
    .resizable(false)
    .maximizable(false)
    .visible(false)
    .build()?;
    Ok(())
}

/// 托盘点「设置」时调用。Accessory 激活策略下窗口不会自动前置，要显式 set_focus。
pub fn show_settings_window<R: Runtime>(app: &AppHandle<R>) {
    if app.get_webview_window(SETTINGS_LABEL).is_none() {
        let _ = create_settings_window(app);
    }
    if let Some(window) = app.get_webview_window(SETTINGS_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// 全屏共存 + 置顶层级。非 macOS 平台空实现。
///
/// Tauri 的 always_on_top 只给 NSFloatingWindowLevel + CanJoinAllSpaces，
/// 结果是别人开全屏（全屏会占一个独立 Space）时桌宠被挡住。
/// FullScreenAuxiliary 才让窗口能跟进全屏 Space，Stationary 让它不跟着 Space 切换动画滑走。
/// 副作用：调用后 is_always_on_top() 会返回 false（Tauri 只认它自己设的那个 level）。
pub fn apply_macos_overlay_behavior<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(target_os = "macos")]
    {
        let Some(window) = app.get_webview_window(PET_LABEL) else {
            return;
        };
        // NSWindow 是 main-thread-only，派发过去再动。
        let target = window.clone();
        let _ = window.run_on_main_thread(move || {
            use objc2_app_kit::{NSStatusWindowLevel, NSWindow, NSWindowCollectionBehavior};

            let Ok(ptr) = target.ns_window() else {
                return;
            };
            if ptr.is_null() {
                return;
            }
            // SAFETY: ns_window() 返回的就是本窗口的 NSWindow 指针，且我们在主线程。
            let ns_window: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
            ns_window.setCollectionBehavior(
                NSWindowCollectionBehavior::CanJoinAllSpaces
                    | NSWindowCollectionBehavior::FullScreenAuxiliary
                    | NSWindowCollectionBehavior::Stationary,
            );
            ns_window.setLevel(NSStatusWindowLevel);
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
    }
}

/// 把窗口补间到某个落脚点。
///
/// 节流到 ~30 Hz 且跑在后台线程：set_position 内部是 dispatch_async 到主队列，
/// 在命令线程里同步狂刷只会把主队列塞满。
#[tauri::command]
pub fn move_to_spot<R: Runtime>(app: AppHandle<R>, spot: String) -> Result<(), String> {
    let window = app
        .get_webview_window(PET_LABEL)
        .ok_or_else(|| "桌宠窗口不存在".to_string())?;

    let target = spot_position(&window, &spot).ok_or_else(|| format!("未知落脚点：{spot}"))?;
    let start = logical_position(&window).unwrap_or(target);

    let seq = TWEEN_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        // 18 帧 × 33 ms ≈ 600 ms，即 ~30 Hz。
        const STEPS: u32 = 18;
        const FRAME: Duration = Duration::from_millis(33);
        for step in 1..=STEPS {
            // 被新的一次调用顶掉了，直接让位。
            if TWEEN_SEQ.load(Ordering::SeqCst) != seq {
                return;
            }
            let t = ease_out_cubic(f64::from(step) / f64::from(STEPS));
            let x = start.0 + (target.0 - start.0) * t;
            let y = start.1 + (target.1 - start.1) * t;
            let _ = window.set_position(LogicalPosition::new(x, y));
            std::thread::sleep(FRAME);
        }
        if TWEEN_SEQ.load(Ordering::SeqCst) == seq {
            let _ = window.set_position(LogicalPosition::new(target.0, target.1));
        }
    });

    Ok(())
}

#[tauri::command]
pub fn get_work_area<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    // 注意：Monitor.position/size 是物理像素，窗口创建参数是逻辑像素，必须换算。
    // 另外 Tauri 的 cursor_position() 在混合 DPI 下换算有 bug（用主屏高度和主屏
    // scale_factor 套到所有屏），多屏要自己用 NSScreen frames 算（见 hittest.rs）。
    //
    // 返回的 x/y/width/height 是「逻辑点」（＝ webview 里的 CSS px），
    // scaleFactor 一并给出，需要物理像素时自行乘回去。
    let window = app
        .get_webview_window(PET_LABEL)
        .ok_or_else(|| "桌宠窗口不存在".to_string())?;
    let rect = work_area(&window).ok_or_else(|| "读不到显示器工作区".to_string())?;
    let scale = window.scale_factor().unwrap_or(1.0);
    Ok(json!({
        "x": rect.x.round() as i64,
        "y": rect.y.round() as i64,
        "width": rect.width.round().max(1.0) as i64,
        "height": rect.height.round().max(1.0) as i64,
        "scaleFactor": scale,
    }))
}

fn ease_out_cubic(t: f64) -> f64 {
    let inv = 1.0 - t.clamp(0.0, 1.0);
    1.0 - inv * inv * inv
}

/// 窗口当前位置，逻辑点、左上原点。
pub(crate) fn logical_position<R: Runtime>(window: &WebviewWindow<R>) -> Option<(f64, f64)> {
    let scale = window.scale_factor().ok()?;
    if scale <= 0.0 {
        return None;
    }
    let position = window.outer_position().ok()?;
    Some((f64::from(position.x) / scale, f64::from(position.y) / scale))
}

/// 窗口当前外框尺寸，逻辑点。
pub(crate) fn logical_size<R: Runtime>(window: &WebviewWindow<R>) -> (f64, f64) {
    let scale = window.scale_factor().unwrap_or(1.0).max(0.01);
    match window.outer_size() {
        Ok(size) => (
            f64::from(size.width) / scale,
            f64::from(size.height) / scale,
        ),
        Err(_) => (PET_WIDTH, PET_HEIGHT),
    }
}

/// 窗口所在显示器的工作区（排除菜单栏/Dock），逻辑点、左上原点。
fn work_area<R: Runtime>(window: &WebviewWindow<R>) -> Option<LogicalRect> {
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten())?;
    let scale = monitor.scale_factor();
    if scale <= 0.0 {
        return None;
    }
    let area = monitor.work_area();
    Some(LogicalRect {
        x: f64::from(area.position.x) / scale,
        y: f64::from(area.position.y) / scale,
        width: f64::from(area.size.width) / scale,
        height: f64::from(area.size.height) / scale,
    })
}

/// 落脚点 → 逻辑点坐标（左上原点），已夹在工作区内。
/// 名字必须和 shared/pet.ts 的 spots 对齐。
fn spot_position<R: Runtime>(window: &WebviewWindow<R>, spot: &str) -> Option<(f64, f64)> {
    let area = work_area(window)?;
    let (width, height) = logical_size(window);

    let left = area.x + EDGE_MARGIN;
    let right = area.x + area.width - width - EDGE_MARGIN;
    let top = area.y + EDGE_MARGIN;
    let bottom = area.y + area.height - height - EDGE_MARGIN;
    let center_x = area.x + (area.width - width) / 2.0;
    let center_y = area.y + (area.height - height) / 2.0;

    let (x, y) = match spot {
        "bottom_right" => (right, bottom),
        "bottom_left" => (left, bottom),
        "bottom_center" => (center_x, bottom),
        "top_right" => (right, top),
        "top_left" => (left, top),
        "center" => (center_x, center_y),
        _ => return None,
    };

    // 工作区比窗口还小时（极端缩放）夹紧，别让它跑出屏幕。
    let max_x = (area.x + area.width - width).max(area.x);
    let max_y = (area.y + area.height - height).max(area.y);
    Some((x.clamp(area.x, max_x), y.clamp(area.y, max_y)))
}
