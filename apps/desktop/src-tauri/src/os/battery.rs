// Track D 负责本文件。见 os/mod.rs 顶部的约束说明。
//
// 系统状态：电量 + 本地时间 + 时区 + 系统版本。
// 这一项不涉及隐私，不走 settings 开关 —— 电量和时间不是"读别人的东西"。
//
// 电量用 starship-battery（battery crate 2020 年停更）。它的返回值是 uom 量纲类型，
// 取标量要 .value：state_of_charge() 是 0..1 的 Ratio，time_to_empty() 是秒。
//
// 时间/时区/系统版本刻意不引 chrono 或 objc2-foundation 的 NSDateFormatter：
//   - chrono 是新依赖，Cargo.toml 由 Track A 共享，不擅自加；
//   - objc2-foundation 当前只开了 NSString/NSArray/NSGeometry 三个 feature，
//     NSDate/NSTimeZone/NSDateFormatter 不可用，开 feature 同样要改 Cargo.toml。
// 所以用系统自带二进制（/bin/date、/usr/bin/sw_vers）与 /etc/localtime 符号链接，
// 与截屏走 /usr/sbin/screencapture 是同一个思路：零新依赖。
use serde_json::{json, Value};
use starship_battery::{Manager, State};
use std::process::Command;

/// 跑一个系统二进制并取 trim 过的 stdout；非零退出或空输出都当失败。
fn run(bin: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(bin).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

/// shared/desktop.ts 的 systemStatusSchema.battery：台式机没电池时返回 null。
///
/// 多电池（极少见）只取第一块：这是给聊天用的，不是电源管理面板。
pub fn battery_json() -> Value {
    let manager = match Manager::new() {
        Ok(m) => m,
        Err(_) => return Value::Null,
    };
    let mut iter = match manager.batteries() {
        Ok(b) => b,
        Err(_) => return Value::Null,
    };
    let battery = match iter.next() {
        Some(Ok(b)) => b,
        // 台式 Mac（Mac mini / Studio / Pro）走这里。
        _ => return Value::Null,
    };

    // state_of_charge 是 0..1，schema 要 0..100 且必须落在区间内，所以 clamp。
    let percent = (f64::from(battery.state_of_charge().value) * 100.0).clamp(0.0, 100.0);
    let percent = (percent * 10.0).round() / 10.0;

    let state = match battery.state() {
        State::Charging => "charging",
        State::Discharging => "discharging",
        State::Full => "full",
        State::Empty => "empty",
        // Paused = 已插电但因为充电上限（优化充电）停止充电。
        // schema 没有这个枚举值；对用户来说"插着电"最接近 charging。
        State::Paused => "charging",
        State::Unknown => "unknown",
        // starship-battery 的 State 不是 #[non_exhaustive]，但留个兜底防它升版本。
        #[allow(unreachable_patterns)]
        _ => "unknown",
    };

    // 剩余时间：放电时取 time_to_empty，充电时取 time_to_full，满电/未知给 null。
    // uom 的 Time 单位是秒。
    let seconds = match battery.state() {
        State::Charging | State::Paused => battery.time_to_full().map(|t| t.value),
        State::Discharging => battery.time_to_empty().map(|t| t.value),
        _ => None,
    };
    let minutes = seconds.and_then(|s| {
        // 负数/NaN/荒谬的大值（刚插拔时系统会给垃圾数据）一律丢掉。
        if !s.is_finite() || s < 0.0 || s > 60.0 * 60.0 * 48.0 {
            None
        } else {
            Some((f64::from(s) / 60.0).round() as i64)
        }
    });

    json!({
        "percent": percent,
        "state": state,
        "minutesRemaining": minutes,
    })
}

/// IANA 时区名（如 "Asia/Shanghai"）。/etc/localtime 是指向 zoneinfo 的符号链接。
fn timezone_name() -> String {
    if let Ok(target) = std::fs::read_link("/etc/localtime") {
        let path = target.to_string_lossy();
        if let Some(idx) = path.find("zoneinfo/") {
            let name = &path[idx + "zoneinfo/".len()..];
            if !name.is_empty() {
                return name.to_string();
            }
        }
    }
    // 退化：拿缩写（CST/PDT…）也比空字符串有用。
    run("/bin/date", &["+%Z"]).unwrap_or_else(|| "unknown".into())
}

/// 本地时间，ISO 8601 带 UTC 偏移。
fn local_time() -> String {
    run("/bin/date", &["+%Y-%m-%dT%H:%M:%S%z"]).unwrap_or_default()
}

/// 形如 "macOS 26.6.2 (25G83)"。sw_vers 拿不到就退化到 uname。
fn os_description() -> String {
    match (
        run("/usr/bin/sw_vers", &["-productName"]),
        run("/usr/bin/sw_vers", &["-productVersion"]),
    ) {
        (Some(n), Some(v)) => match run("/usr/bin/sw_vers", &["-buildVersion"]) {
            Some(b) => format!("{n} {v} ({b})"),
            None => format!("{n} {v}"),
        },
        _ => run("/usr/bin/uname", &["-sr"]).unwrap_or_else(|| "macOS".into()),
    }
}

/// shared/desktop.ts 的 systemStatusSchema。
pub fn system_status() -> Value {
    json!({
        "battery": battery_json(),
        "localTime": local_time(),
        "timezone": timezone_name(),
        "os": os_description(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // 这个测试会打印本机真实值 —— 跑 `cargo test -- --nocapture` 看。
    // 断言只检查形状，因为电量每次都不一样。
    #[test]
    fn system_status_matches_schema_shape() {
        let status = system_status();
        println!("system_status = {status:#}");

        let obj = status.as_object().expect("顶层必须是对象");
        assert_eq!(obj.len(), 4, "字段数必须与 systemStatusSchema 严格一致");

        let time = obj["localTime"].as_str().expect("localTime 必须是字符串");
        assert!(!time.is_empty(), "localTime 不能为空");
        assert!(time.contains('T'), "localTime 应为 ISO 8601：{time}");
        assert!(!obj["timezone"].as_str().unwrap().is_empty());
        assert!(!obj["os"].as_str().unwrap().is_empty());

        match &obj["battery"] {
            Value::Null => println!("本机没有电池（台式机）"),
            Value::Object(b) => {
                assert_eq!(b.len(), 3);
                let percent = b["percent"].as_f64().expect("percent 必须是数字");
                assert!((0.0..=100.0).contains(&percent), "percent 越界：{percent}");
                let state = b["state"].as_str().unwrap();
                assert!(
                    ["charging", "discharging", "full", "empty", "unknown"].contains(&state),
                    "state 不在枚举内：{state}"
                );
                // minutesRemaining 必须是 null 或非负整数。
                match &b["minutesRemaining"] {
                    Value::Null => {}
                    Value::Number(n) => {
                        let m = n.as_i64().expect("必须是整数");
                        assert!(m >= 0, "分钟数不能为负：{m}");
                    }
                    other => panic!("minutesRemaining 类型非法：{other}"),
                }
            }
            other => panic!("battery 必须是对象或 null：{other}"),
        }
    }
}
