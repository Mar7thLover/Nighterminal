mod config;
mod launch;
mod pty;
mod quake;
mod state;
mod window;

use serde::Serialize;
use std::sync::Mutex;
use tauri::{Manager, RunEvent, State, WindowEvent};

/// What the native layer managed to give us, reported to the status bar.
#[derive(Serialize, Clone)]
pub struct ChromeInfo {
    backdrop: &'static str,
}

struct Chrome(Mutex<&'static str>);

#[tauri::command]
fn chrome_info(chrome: State<'_, Chrome>) -> ChromeInfo {
    ChromeInfo {
        backdrop: *chrome.0.lock().unwrap(),
    }
}

/// Tell Windows whether this window is currently a light or a dark surface.
///
/// Only the frontend knows: a theme is a CSS block, and its mode is a token in
/// that block (see `styles/base.css`). Passing the *mode* rather than the theme
/// id keeps this side free of any palette knowledge, and DWM needs to be told
/// because the system backdrop tints itself from the window's immersive-dark
/// flag — a light theme over a dark-tinted acrylic reads as muddy grey.
#[tauri::command]
fn chrome_theme(app: tauri::AppHandle, light: bool) {
    if let Some(main) = app.get_webview_window("main") {
        let theme = if light {
            tauri::Theme::Light
        } else {
            tauri::Theme::Dark
        };
        let _ = main.set_theme(Some(theme));
    }
}

/// Re-arm the global hotkey and the always-on-top/taskbar flags after the
/// settings panel writes a new config. Reports whether the hotkey actually
/// registered — not just whether it parsed — so the panel can flag a
/// combination some other program already owns. Async so the wait for the
/// hotkey thread's answer never blocks the main thread.
#[tauri::command]
async fn quake_apply(app: tauri::AppHandle) -> bool {
    let settings = config::load(&app);
    if let Some(main) = app.get_webview_window("main") {
        quake::apply_window_flags(&main, &settings);
    }
    quake::arm(&app, &settings)
}

/// Drop the window into position without toggling it — used at startup when
/// quake mode is already armed.
#[tauri::command]
fn quake_drop(app: tauri::AppHandle) {
    let settings = config::load(&app);
    if let Some(main) = app.get_webview_window("main") {
        quake::drop_down(&main, settings.quake_height);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(pty::PtyState::default())
        .manage(quake::Quake::default())
        .manage(Chrome(Mutex::new(window::SOLID)))
        // Read here, before anything can chdir: the process working directory
        // is what `ntps` in a project folder is really passing us.
        .manage(launch::Launch::detect())
        .invoke_handler(tauri::generate_handler![
            chrome_info,
            chrome_theme,
            quake_apply,
            quake_drop,
            config::config_get,
            config::config_save,
            config::config_path,
            state::state_load,
            state::state_save,
            state::state_clear,
            pty::pty_spawn,
            pty::pty_attach,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
        ])
        .setup(|app| {
            let settings = config::load(app.handle());
            if let Some(main) = app.get_webview_window("main") {
                let kind = window::dress(&main);
                *app.state::<Chrome>().0.lock().unwrap() = kind;
                quake::apply_window_flags(&main, &settings);
            }
            quake::start(app.handle());
            let _ = quake::arm(app.handle(), &settings);
            Ok(())
        })
        .on_window_event(|window, event| {
            // A drop-down console gets out of the way the moment focus leaves.
            if let WindowEvent::Focused(false) = event {
                let app = window.app_handle();
                // Only hide while the hotkey is genuinely registered: with no
                // taskbar entry and no tray, a hidden window whose hotkey never
                // bound would be unrecoverable. Checked first because it is a
                // plain atomic read, sparing a config-file parse on every blur
                // while quake is off.
                if app.state::<quake::Quake>().hotkey_active() {
                    let settings = config::load(app);
                    if settings.quake_enabled && settings.quake_hide_on_blur {
                        let _ = window.hide();
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to start Nighterminal")
        .run(|app, event| {
            // Reap every shell on the way out; ConPTY children outlive us otherwise.
            if let RunEvent::Exit = event {
                pty::kill_all(&app.state::<pty::PtyState>());
            }
        });
}
