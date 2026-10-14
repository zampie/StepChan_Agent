// Step酱 桌面外壳。
//
// 模块归属（并行开发时不要越界改别人的文件）：
//   window.rs / tray.rs / hittest.rs  -> Track A（桌面外壳）
//   os/*.rs                            -> Track D（第四面墙系统能力）
//   settings.rs / credentials.rs       -> 集成层（两个 track 都读，谁都不要改）
//
// 窗口刻意不写在 tauri.conf.json 的 app.windows 里：麦克风需要
// WebviewWindowBuilder 的 on_permission_request，而那是 builder-only API，
// 配置文件里没有对应键。所以窗口必须在 setup() 里用 Rust 建。
mod credentials;
mod hittest;
mod os;
mod settings;
mod tray;
mod window;

use tauri::Manager;

pub fn run() {
    // key 从项目根目录 .env 读。刻意让文件优先于进程环境变量：
    // shell 里残留的旧 export 会把鉴权问题伪装成别的故障。
    credentials::load_env();

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build());

    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
                if let Some(w) = app.get_webview_window(window::PET_LABEL) {
                    let _ = w.show();
                }
            }))
            .plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                None,
            ));
    }

    builder
        .invoke_handler(tauri::generate_handler![
            credentials::get_credentials,
            settings::settings_get,
            settings::settings_set,
            hittest::set_hit_regions,
            hittest::set_interactive,
            window::move_to_spot,
            window::get_work_area,
            os::capture_screen,
            os::screen_permission_status,
            os::get_frontmost_app,
            os::get_system_status,
            os::read_clipboard_text,
        ])
        .setup(|app| {
            // 菜单栏专用：不占 Dock。运行时设置而不是只靠 Info.plist 的 LSUIElement，
            // 因为后者在 tauri dev 下不生效。
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            window::create_pet_window(app.handle())?;
            window::apply_macos_overlay_behavior(app.handle());
            tray::build_tray(app.handle())?;

            #[cfg(desktop)]
            tray::register_hotkey(app.handle())?;

            hittest::spawn_cursor_poll(app.handle());
            os::spawn_frontmost_watch(app.handle());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Step酱 启动失败");
}
