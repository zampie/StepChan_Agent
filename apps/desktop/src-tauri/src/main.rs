// 菜单栏应用不开控制台窗口。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    stepchan_desktop_lib::run()
}
