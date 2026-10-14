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
use parking_lot::Mutex;
use serde::Deserialize;
use tauri::{AppHandle, Runtime};

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

pub fn spawn_cursor_poll<R: Runtime>(_app: &AppHandle<R>) {
    // TODO(Track A)
}
