// Track A 负责本文件。这是整个桌宠交互最容易做错的一块，先读完注释再写。
//
// 为什么命中测试必须在 Rust 侧：
//   setIgnoresMouseEvents(true) 会连 mousemove 一起屏蔽。一旦开了穿透，
//   webview 就再也收不到"光标回到角色身上"的事件 —— 用 JS 的 mousemove 驱动
//   穿透开关会自锁。而 NSEvent::mouseLocation() 是全局查询，不受窗口事件屏蔽影响，
//   所以在 Rust 后台线程轮询它做命中判定，只在状态翻转时调 set_ignore_cursor_events。
//
// 要点：
// 1. 轮询 30–60 Hz。每次都调 set_ignore_cursor_events 会浪费主队列，必须只在变化时调。
// 2. 切换是异步派发到主队列的，有一个主循环的延迟。快速划过时点击可能落在旧状态上 →
//    进入交互态时把命中区外扩 4–8 px，离开时收回（滞回），避免边缘抖动。
// 3. 命中数据由前端通过 set_hit_regions 推来（归一化 0..1，坐标系＝素材画布），
//    表情/动作切换时重推。Rust 侧要把它和窗口位置/尺寸/scale factor 换算成屏幕坐标。
// 4. 混合 DPI 下不要用 Tauri 的 cursor_position()（它用主屏高度和主屏 scale_factor
//    套到所有屏，外接 1x 屏或屏幕在主屏上方时结果是错的）。自己用 NSEvent::mouseLocation()
//    + NSScreen frames 算。
// 5. 穿透开启时窗口也收不到拖放事件 —— 所以 set_interactive 要能被前端强制拉到交互态
//    （拖放期间），结束后交还给轮询。
// 6. 命中结果通过 desktopEvents.hitTest 发给前端（part 名或 null），让她能对
//    "摸头/摸脸"做反应。
//
// 坐标系（和 window.rs 同一套）：统一在「逻辑点 + 左上原点 + 全局虚拟桌面」里比较。
//   - 光标：NSEvent::mouseLocation() 给的是逻辑点、**左下**原点（原点在零号屏左下角）。
//     翻成左上原点要减：y_topleft = 零号屏 frame 高度 - y。这正是 tao 换算窗口坐标时
//     用的那个参照（util::bottom_left_to_top_left 用 CGDisplay::main() 的高度），
//     所以两者可以直接比。
//   - 窗口：outer_position/outer_size 是物理像素，除以 window.scale_factor() 得逻辑点。
//     Tauri 的 cursor_position() 的 bug 就在于它把主屏的 scale_factor 乘到了所有屏，
//     而窗口位置用的是窗口自己那块屏的 scale —— 两边不是同一个空间。全程待在逻辑点
//     空间里就绕开了这个坑。
//   - NSScreen 是 main-thread-only，所以零号屏高度在主线程算好缓存起来，
//     轮询线程只读缓存，并每 2 秒派一次刷新（接显示器/改分辨率时跟上）。
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow};

use crate::window;

#[derive(Deserialize, Clone, Debug)]
pub struct HitRegion {
    pub part: String,
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
}

static REGIONS: Mutex<Vec<HitRegion>> = Mutex::new(Vec::new());
/// 前端强制交互态（拖放期间）。None = 交还给轮询。
static FORCED: Mutex<Option<bool>> = Mutex::new(None);

/// 当前是否处于穿透态。窗口刚建出来时是不穿透的，所以初值 false。
/// 只用它来判断「要不要真的去调 set_ignore_cursor_events」。
static IGNORING: AtomicBool = AtomicBool::new(false);
/// 上一次发给前端的命中部位，用于只在变化时发事件。
static LAST_PART: Mutex<Option<String>> = Mutex::new(None);
/// 零号屏（带菜单栏那块，全局原点所在）的逻辑高度，f64 的 bits。
static FLIP_HEIGHT: AtomicU64 = AtomicU64::new(0);

/// 轮询周期：~45 Hz。
const POLL: Duration = Duration::from_millis(22);
/// 屏幕几何刷新间隔。
const METRICS_REFRESH: Duration = Duration::from_secs(2);
/// 滞回：非交互态下外扩这么多逻辑点就算命中（提前于光标抵达，补上主队列那一帧的延迟）。
const ENTER_PAD: f64 = 6.0;
/// 交互态下要离开得更远才放手。LEAVE_PAD > ENTER_PAD 形成稳定的滞回带，
/// 否则（比如交互态反而内缩）边缘会以轮询频率来回自激震荡。
const LEAVE_PAD: f64 = 10.0;

pub fn regions() -> Vec<HitRegion> {
    REGIONS.lock().clone()
}

pub fn forced() -> Option<bool> {
    *FORCED.lock()
}

#[tauri::command]
pub fn set_hit_regions(regions: Vec<HitRegion>) {
    *REGIONS.lock() = regions;
}

#[tauri::command]
pub fn set_interactive(interactive: Option<bool>) {
    *FORCED.lock() = interactive;
}

pub fn spawn_cursor_poll<R: Runtime>(app: &AppHandle<R>) {
    // setup() 跑在主线程，这里能直接算一次初值，不用等第一次异步刷新。
    read_flip_height_on_main_thread();

    let app = app.clone();
    std::thread::spawn(move || {
        let mut last_refresh = Instant::now();
        loop {
            std::thread::sleep(POLL);
            if last_refresh.elapsed() >= METRICS_REFRESH {
                last_refresh = Instant::now();
                refresh_screen_metrics(&app);
            }
            tick(&app);
        }
    });
}

fn tick<R: Runtime>(app: &AppHandle<R>) {
    let Some(pet) = app.get_webview_window(window::PET_LABEL) else {
        return;
    };

    // 拖放期间前端会把它拉到 true：穿透窗口连 DragDrop 事件都收不到。
    if let Some(forced) = forced() {
        apply_ignore(&pet, !forced);
        return;
    }

    let regions = regions();
    if regions.is_empty() {
        // 前端还没推命中区（或刚清空）。此时既不该把整个 420×520 的透明框变成
        // 点击黑洞，也不该把窗口彻底变成穿透让人摸不到 —— 保持现状，等它推过来。
        return;
    }

    let Some((cursor_x, cursor_y)) = global_cursor_logical() else {
        return;
    };
    let Some((win_x, win_y)) = window::logical_position(&pet) else {
        return;
    };
    let (win_w, win_h) = window::logical_size(&pet);
    if win_w <= 0.0 || win_h <= 0.0 {
        return;
    }

    // 当前是交互态就用更宽的边界（难离开），穿透态用较窄的（但仍外扩，提前进入）。
    let pad = if IGNORING.load(Ordering::Relaxed) {
        ENTER_PAD
    } else {
        LEAVE_PAD
    };
    let pad_u = pad / win_w;
    let pad_v = pad / win_h;

    // 归一化到素材画布坐标系（0..1），和前端推来的 HitRegion 同一套。
    let u = (cursor_x - win_x) / win_w;
    let v = (cursor_y - win_y) / win_h;

    let part = regions
        .into_iter()
        .find(|r| {
            u >= r.x0 - pad_u && u <= r.x1 + pad_u && v >= r.y0 - pad_v && v <= r.y1 + pad_v
        })
        .map(|r| r.part);

    apply_ignore(&pet, part.is_none());
    emit_part(app, part);
}

/// 只在状态翻转时调 set_ignore_cursor_events —— 每 tick 都调会白占主队列。
fn apply_ignore<R: Runtime>(window: &WebviewWindow<R>, ignore: bool) {
    if IGNORING.swap(ignore, Ordering::SeqCst) != ignore {
        let _ = window.set_ignore_cursor_events(ignore);
    }
}

fn emit_part<R: Runtime>(app: &AppHandle<R>, part: Option<String>) {
    let mut last = LAST_PART.lock();
    if *last == part {
        return;
    }
    *last = part.clone();
    drop(last);
    // 载荷是 string | null，对齐 shared/desktop.ts 的 onHitTest。
    let _ = app.emit(window::events::HIT_TEST, part);
}

fn flip_height() -> f64 {
    f64::from_bits(FLIP_HEIGHT.load(Ordering::Relaxed))
}

/// 全局光标位置，逻辑点、左上原点，与窗口坐标同一空间。
#[cfg(target_os = "macos")]
fn global_cursor_logical() -> Option<(f64, f64)> {
    let flip = flip_height();
    if flip <= 0.0 {
        return None;
    }
    // mouseLocation 是类方法且不要求主线程（NSEvent 不是 MainThreadOnly）。
    let point = objc2_app_kit::NSEvent::mouseLocation();
    Some((point.x, flip - point.y))
}

#[cfg(not(target_os = "macos"))]
fn global_cursor_logical() -> Option<(f64, f64)> {
    None
}

/// 派发到主线程刷新屏幕几何。NSScreen 是 main-thread-only，不能在轮询线程里碰。
fn refresh_screen_metrics<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(target_os = "macos")]
    {
        let _ = app.run_on_main_thread(read_flip_height_on_main_thread);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
    }
}

/// 只在主线程调用。
fn read_flip_height_on_main_thread() {
    #[cfg(target_os = "macos")]
    {
        use objc2::MainThreadMarker;
        use objc2_app_kit::NSScreen;

        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        // screens[0] 是带菜单栏那块屏，全局坐标原点就在它左下角 —— 也正是
        // tao 换算窗口坐标时用的参照。不要用 mainScreen()（那是"有键盘焦点的屏"）。
        if let Some(screen) = NSScreen::screens(mtm).firstObject() {
            let height = screen.frame().size.height as f64;
            if height > 0.0 {
                FLIP_HEIGHT.store(height.to_bits(), Ordering::Relaxed);
            }
        }
    }
}
