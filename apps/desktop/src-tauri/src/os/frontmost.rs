// Track D 负责本文件。见 os/mod.rs 顶部的约束说明。
//
// 前台应用感知：只读**应用名 + bundle id**。不读窗口标题 ——
// 读标题要辅助功能权限，AGENTS.md 明确不申请。NSWorkspace 这条路没有 TCC 提示。
//
// 线程：objc2-app-kit 0.3 里 NSWorkspace / NSRunningApplication 都是普通
// extern_class!（没有 MainThreadOnly 标记，方法签名里也没有 MainThreadMarker 参数），
// 也就是 objc2 认定它们可以在任意线程调用。所以这里**不需要** run_on_main_thread，
// 命令和轮询线程都直接调。需要主线程的是 NSScreen / NSWindow / NSApplication
// 那一类，但本文件一个都没用到。
//
// 配额：这是给聊天用的，不是遥测。轮询 3 秒一次，只在**真的变了**时发事件，
// 并且卡死两道闸：相邻事件至少 MIN_INTERVAL，每 RATE_WINDOW 最多 MAX_PER_WINDOW 条。
// 用户疯狂 alt-tab 也不会把前端淹掉。
use objc2_app_kit::NSWorkspace;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Runtime};

use crate::settings;

/// 轮询间隔。AppKit 调用很便宜，但没必要更快 —— 这是对话素材，不是遥测。
const POLL_INTERVAL: Duration = Duration::from_secs(3);
/// 相邻两条事件之间的最小间隔：挡住连续 alt-tab 的突发。
const MIN_INTERVAL: Duration = Duration::from_secs(8);
/// 滑动窗口内的事件上限：挡住"每 8 秒稳定换一个应用"这种持续性噪音。
///
/// 两个常数要配着看：MIN_INTERVAL 单独就把速率压到 60/8 ≈ 7 条/分钟，
/// 所以 MAX_PER_WINDOW 必须小于它才真的起作用（否则窗口闸是死代码 ——
/// 这是单测里实际撞出来的，原先 12s / 5 条的组合窗口闸永远不会触发）。
const MAX_PER_WINDOW: usize = 4;
const RATE_WINDOW: Duration = Duration::from_secs(60);

/// 最近一次读到的前台应用。开关关闭时会被清空（不留痕）。
/// 存在的意义：让轮询线程和命令共享同一份观测，命令不必每次都 fork AppKit 调用。
static CACHE: Mutex<Option<(String, String)>> = Mutex::new(None);

/// 直接问 AppKit。返回 (localizedName, bundleIdentifier)。
///
/// 没有名字的进程（后台 helper、无 GUI 的 agent）一律丢掉 —— 对话里提不起来。
fn read_frontmost() -> Option<(String, String)> {
    let app = NSWorkspace::sharedWorkspace().frontmostApplication()?;
    let name = app.localizedName().map(|s| s.to_string()).unwrap_or_default();
    if name.trim().is_empty() {
        return None;
    }
    // bundle id 可能为 None（没打包的二进制，比如 tauri dev 下的自己）。
    // schema 的 bundleId 是 z.string()，允许空串，所以这里退化成 ""。
    let bundle = app
        .bundleIdentifier()
        .map(|s| s.to_string())
        .unwrap_or_default();
    Some((name, bundle))
}

/// 我们自己。用来把「切到 Step酱」这件事从事件流里剔掉：
/// 她自己被点一下不算用户换了应用，否则 A→Step酱→A 会白白烧掉两条配额。
fn own_ids<R: Runtime>(app: &AppHandle<R>) -> Vec<String> {
    let mut ids = vec![app.config().identifier.clone()];
    if let Some(name) = app.config().product_name.clone() {
        ids.push(name);
    }
    ids
}

fn is_own(ids: &[String], name: &str, bundle: &str) -> bool {
    ids.iter()
        .any(|id| (!bundle.is_empty() && id == bundle) || id == name)
}

fn to_json(observed: &(String, String)) -> Value {
    json!({ "name": observed.0, "bundleId": observed.1 })
}

/// shared/desktop.ts 的 frontmostAppSchema。开关关闭时返回 None（前端解析成 null）。
pub fn frontmost<R: Runtime>(app: &AppHandle<R>) -> Option<Value> {
    if settings::read(app)["appAwareness"] != Value::Bool(true) {
        // 关掉开关的瞬间就把观测丢掉，别让旧值继续被读到。
        *CACHE.lock() = None;
        return None;
    }

    // 这条路没有主线程要求，直接读最新值；读不到就退回缓存（最多 3 秒旧）。
    match read_frontmost() {
        Some(observed) => {
            let value = to_json(&observed);
            *CACHE.lock() = Some(observed);
            Some(value)
        }
        None => CACHE.lock().as_ref().map(to_json),
    }
}

/// 滑动窗口 + 最小间隔的双闸限流。
struct Budget {
    recent: VecDeque<Instant>,
}

impl Budget {
    fn new() -> Self {
        Self {
            recent: VecDeque::new(),
        }
    }

    /// 现在允许发一条吗？允许的话顺手记账。
    fn allow(&mut self, now: Instant) -> bool {
        while let Some(&front) = self.recent.front() {
            if now.duration_since(front) >= RATE_WINDOW {
                self.recent.pop_front();
            } else {
                break;
            }
        }
        if let Some(&last) = self.recent.back() {
            if now.duration_since(last) < MIN_INTERVAL {
                return false;
            }
        }
        if self.recent.len() >= MAX_PER_WINDOW {
            return false;
        }
        self.recent.push_back(now);
        true
    }
}

/// 前台应用变化监听。变化时发 desktopEvents.frontmostChanged（"pet://frontmost-changed"）。
pub fn spawn_watch<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    let ids = own_ids(app);
    let result = std::thread::Builder::new()
        .name("stepchan-frontmost".into())
        .spawn(move || {
            let mut budget = Budget::new();
            // 上一次「认定的」前台应用。注意它只在开关打开时推进。
            let mut last: Option<(String, String)> = None;

            loop {
                std::thread::sleep(POLL_INTERVAL);

                // 开关关闭：不读、不发、清状态。重新打开后第一次观测不发事件
                // （last 被清空 → 下一轮才算"变化"），避免一开开关就冒一句话。
                if settings::read(&handle)["appAwareness"] != Value::Bool(true) {
                    if last.is_some() {
                        last = None;
                        *CACHE.lock() = None;
                    }
                    continue;
                }

                let Some(observed) = read_frontmost() else {
                    continue;
                };

                // 切到我们自己：不更新 last，这样切回去不会被当成"变化"。
                if is_own(&ids, &observed.0, &observed.1) {
                    continue;
                }

                *CACHE.lock() = Some(observed.clone());

                let first_observation = last.is_none();
                if last.as_ref() == Some(&observed) {
                    continue;
                }
                last = Some(observed.clone());

                // 开关刚打开（或刚启动）的第一次观测只是建立基线，不是"换了应用"。
                if first_observation {
                    continue;
                }

                if !budget.allow(Instant::now()) {
                    // 配额用完就丢掉这条。last 已经推进，所以不会在窗口结束后
                    // 补发一条过期的变化。
                    continue;
                }

                let _ = handle.emit(crate::os::FRONTMOST_CHANGED, to_json(&observed));
            }
        });
    if let Err(e) = result {
        eprintln!("[frontmost] 监听线程起不来，前台应用感知不可用：{e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 打印本机真实前台应用。`cargo test -- --nocapture` 可见。
    #[test]
    fn reads_real_frontmost_app() {
        match read_frontmost() {
            Some((name, bundle)) => {
                println!("frontmost = name={name:?} bundleId={bundle:?}");
                assert!(!name.trim().is_empty());
            }
            // 无头/无登录会话下可能确实没有前台应用，不该因此让测试失败。
            None => println!("frontmost = None（当前没有可识别的前台 GUI 应用）"),
        }
    }

    #[test]
    fn budget_enforces_min_interval_and_window() {
        // 常数写死在断言里，改常数就得改这里 —— 这是故意的，速率是产品行为。
        assert_eq!(MIN_INTERVAL, Duration::from_secs(8));
        assert_eq!(MAX_PER_WINDOW, 4);
        assert_eq!(RATE_WINDOW, Duration::from_secs(60));

        let mut budget = Budget::new();
        let t0 = Instant::now();
        let at = |s: u64| t0 + Duration::from_secs(s);

        // 第 1 条放行。
        assert!(budget.allow(at(0)));
        // 最小间隔内的全部拦掉（用户疯狂 alt-tab）。
        assert!(!budget.allow(at(1)));
        assert!(!budget.allow(at(7)));
        // 刚好到最小间隔 → 放行。第 2、3、4 条。
        assert!(budget.allow(at(8)));
        assert!(budget.allow(at(16)));
        assert!(budget.allow(at(24)));
        // 第 5 条：间隔够了，但 60 秒窗口里已经有 4 条 → 被窗口闸拦住。
        assert!(!budget.allow(at(32)));
        assert!(!budget.allow(at(40)));
        // t=60 时最早那条（t=0）滑出窗口，恢复放行。
        assert!(budget.allow(at(60)));
    }

    #[test]
    fn own_app_is_recognised() {
        let ids = vec!["com.stepfun.stepchan.pet".to_string(), "Step酱".to_string()];
        assert!(is_own(&ids, "Step酱", "com.stepfun.stepchan.pet"));
        // tauri dev 下 bundle id 可能是空的，靠名字也要认出来。
        assert!(is_own(&ids, "Step酱", ""));
        assert!(!is_own(&ids, "Safari", "com.apple.Safari"));
        // 空 bundle id 不该跟别人的空 bundle id 混在一起。
        assert!(!is_own(&ids, "SomeHelper", ""));
    }
}
