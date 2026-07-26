//! Quake-style drop-down: a global hotkey that slams the window down from the
//! top of the screen and takes it away again.
//!
//! The hotkey is registered with Win32 `RegisterHotKey` directly rather than
//! through a plugin. With a null `hwnd` the registration belongs to the
//! *calling thread* and `WM_HOTKEY` is posted to that thread's queue — so one
//! dedicated thread owns both the registration and a message loop, and
//! re-binding means posting it a message rather than touching Win32 from
//! wherever the settings panel happened to call from.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Mutex;

use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

use crate::config::Config;

/// Parsed accelerator: Win32 modifier mask plus a virtual-key code.
type Binding = (u32, u32);

#[derive(Default)]
pub struct Quake {
    /// Thread that owns the registration; 0 until the loop is up.
    thread: AtomicU32,
    /// What the hotkey thread should register on its next wake-up.
    desired: Mutex<Option<Binding>>,
    /// One-shot reply for the `arm()` call currently waiting on a rebind;
    /// `RegisterHotKey` runs on the hotkey thread, so its outcome has to travel
    /// back over a channel.
    reply: Mutex<Option<Sender<bool>>>,
    /// Whether a hotkey is registered *right now*. Gates hide-on-blur: with no
    /// taskbar entry and no tray, hiding a window whose hotkey never bound
    /// would leave no way to bring it back.
    active: AtomicBool,
}

impl Quake {
    pub fn hotkey_active(&self) -> bool {
        self.active.load(Ordering::Acquire)
    }
}

// --------------------------------------------------------------- accelerator

const MOD_ALT: u32 = 0x0001;
const MOD_CONTROL: u32 = 0x0002;
const MOD_SHIFT: u32 = 0x0004;
const MOD_WIN: u32 = 0x0008;
/// Without this a held-down hotkey autorepeats and the window strobes.
const MOD_NOREPEAT: u32 = 0x4000;

/// `"Ctrl+Shift+`"` → `(MOD_CONTROL|MOD_SHIFT|MOD_NOREPEAT, VK_OEM_3)`.
/// Returns `None` for anything we can't bind, which the caller treats as
/// "leave the hotkey unregistered" rather than as an error worth surfacing.
pub fn parse(accelerator: &str) -> Option<Binding> {
    let mut mods = MOD_NOREPEAT;
    let mut key: Option<u32> = None;

    for part in accelerator.split('+') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        match part.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => mods |= MOD_CONTROL,
            "alt" => mods |= MOD_ALT,
            "shift" => mods |= MOD_SHIFT,
            "win" | "super" | "meta" | "cmd" => mods |= MOD_WIN,
            other => {
                if key.is_some() {
                    return None; // two non-modifier keys: not an accelerator
                }
                key = Some(virtual_key(other)?);
            }
        }
    }

    // A bare key would swallow that key system-wide.
    if mods == MOD_NOREPEAT {
        return None;
    }
    key.map(|vk| (mods, vk))
}

fn virtual_key(name: &str) -> Option<u32> {
    if let Some(n) = name.strip_prefix('f') {
        if let Ok(n) = n.parse::<u32>() {
            if (1..=24).contains(&n) {
                return Some(0x70 + n - 1); // VK_F1..VK_F24
            }
        }
    }
    let bytes = name.as_bytes();
    if bytes.len() == 1 {
        let c = bytes[0];
        if c.is_ascii_lowercase() {
            return Some(u32::from(c.to_ascii_uppercase()));
        }
        if c.is_ascii_digit() {
            return Some(u32::from(c));
        }
        // OEM keys, named by the character they carry on a US layout.
        return match c {
            b'`' => Some(0xC0),
            b'-' => Some(0xBD),
            b'=' => Some(0xBB),
            b'[' => Some(0xDB),
            b']' => Some(0xDD),
            b'\\' => Some(0xDC),
            b';' => Some(0xBA),
            b'\'' => Some(0xDE),
            b',' => Some(0xBC),
            b'.' => Some(0xBE),
            b'/' => Some(0xBF),
            _ => None,
        };
    }
    match name {
        "space" => Some(0x20),
        "escape" | "esc" => Some(0x1B),
        "tab" => Some(0x09),
        "backquote" | "grave" => Some(0xC0),
        "insert" => Some(0x2D),
        "home" => Some(0x24),
        "end" => Some(0x23),
        "pageup" => Some(0x21),
        "pagedown" => Some(0x22),
        _ => None,
    }
}

// ------------------------------------------------------------------ geometry

/// Snap the window to the top of whichever monitor holds the pointer, spanning
/// its full width and `height` of its work area.
pub fn drop_down(window: &WebviewWindow, height: f32) {
    let (x, y) = cursor_position(window);
    let monitor = window
        .monitor_from_point(x, y)
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else { return };

    let origin = *monitor.position();
    let size = *monitor.size();
    let rows = ((size.height as f32) * height.clamp(0.2, 1.0)).round() as u32;

    let _ = window.set_position(PhysicalPosition::new(origin.x, origin.y));
    let _ = window.set_size(PhysicalSize::new(size.width, rows.max(120)));
}

/// Physical screen coordinates, which is what `monitor_from_point` matches
/// against. Falls back to the window's own origin when the cursor can't be read
/// (locked workstation, no input device).
fn cursor_position(window: &WebviewWindow) -> (f64, f64) {
    let point = window
        .cursor_position()
        .ok()
        .or_else(|| window.outer_position().ok().map(|p| p.cast::<f64>()));
    match point {
        Some(p) => (p.x, p.y),
        None => (0.0, 0.0),
    }
}

/// Show-and-focus or hide, depending on where the window is now.
pub fn toggle(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let config = crate::config::load(app);
    // "Visible but behind something else" should raise, not hide — that is what
    // the user means by pressing the hotkey while looking at another app.
    let up = window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false);
    if up {
        let _ = window.hide();
    } else {
        drop_down(&window, config.quake_height);
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Window flags that only make sense while the drop-down is armed.
pub fn apply_window_flags(window: &WebviewWindow, config: &Config) {
    let on = config.quake_enabled;
    let _ = window.set_always_on_top(on);
    let _ = window.set_skip_taskbar(on);
}

// ---------------------------------------------------------------- hotkey loop

#[cfg(windows)]
mod win {
    use std::ffi::c_void;

    #[repr(C)]
    pub struct Msg {
        pub hwnd: *mut c_void,
        pub message: u32,
        pub w_param: usize,
        pub l_param: isize,
        pub time: u32,
        pub pt_x: i32,
        pub pt_y: i32,
    }

    #[link(name = "user32")]
    unsafe extern "system" {
        pub fn RegisterHotKey(hwnd: *mut c_void, id: i32, modifiers: u32, vk: u32) -> i32;
        pub fn UnregisterHotKey(hwnd: *mut c_void, id: i32) -> i32;
        pub fn GetMessageW(msg: *mut Msg, hwnd: *mut c_void, min: u32, max: u32) -> i32;
        pub fn PostThreadMessageW(thread: u32, msg: u32, w: usize, l: isize) -> i32;
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        pub fn GetCurrentThreadId() -> u32;
    }

    pub const WM_HOTKEY: u32 = 0x0312;
    /// Our own "re-read the desired binding and re-register" ping.
    pub const WM_REBIND: u32 = 0x0400; // WM_APP
    /// Arbitrary, only has to be unique within our own thread.
    pub const HOTKEY_ID: i32 = 0xC0DE;
}

#[cfg(windows)]
pub fn start(app: &AppHandle) {
    use std::ptr::null_mut;

    let handle = app.clone();
    std::thread::Builder::new()
        .name("quake-hotkey".into())
        .spawn(move || {
            let state = handle.state::<Quake>();
            state
                .thread
                .store(unsafe { win::GetCurrentThreadId() }, Ordering::Release);
            // The desired binding may already have been set before this thread
            // came up; register it before entering the loop. An `arm()` racing
            // this startup may already be waiting on the reply slot.
            let mut registered = rebind(&state, false);
            state.active.store(registered, Ordering::Release);
            if let Some(tx) = state.reply.lock().unwrap().take() {
                let _ = tx.send(registered);
            }

            let mut msg = win::Msg {
                hwnd: null_mut(),
                message: 0,
                w_param: 0,
                l_param: 0,
                time: 0,
                pt_x: 0,
                pt_y: 0,
            };
            loop {
                let got = unsafe { win::GetMessageW(&mut msg, null_mut(), 0, 0) };
                if got <= 0 {
                    break; // WM_QUIT, or the queue died with the process
                }
                match msg.message {
                    win::WM_HOTKEY => {
                        let app = handle.clone();
                        // Window calls must not run on this loop's thread.
                        let _ = handle.run_on_main_thread(move || toggle(&app));
                    }
                    win::WM_REBIND => {
                        let state = handle.state::<Quake>();
                        registered = rebind(&state, registered);
                        state.active.store(registered, Ordering::Release);
                        let reply = state.reply.lock().unwrap().take();
                        if let Some(tx) = reply {
                            let _ = tx.send(registered);
                        }
                    }
                    _ => {}
                }
            }
            if registered {
                unsafe { win::UnregisterHotKey(null_mut(), win::HOTKEY_ID) };
            }
        })
        .ok();
}

/// Drop any existing registration and install the currently desired one.
/// Returns whether a hotkey is registered afterwards.
#[cfg(windows)]
fn rebind(state: &tauri::State<'_, Quake>, registered: bool) -> bool {
    use std::ptr::null_mut;

    if registered {
        unsafe { win::UnregisterHotKey(null_mut(), win::HOTKEY_ID) };
    }
    let Some((mods, vk)) = *state.desired.lock().unwrap() else {
        return false;
    };
    // Fails when another app already owns the combination; the settings panel
    // reports that back rather than pretending the binding took.
    unsafe { win::RegisterHotKey(null_mut(), win::HOTKEY_ID, mods, vk) != 0 }
}

/// Point the hotkey thread at a new binding (or at none), wake it, and wait
/// briefly for the outcome. Returns true when the config is fully in effect:
/// quake off, or the hotkey genuinely registered — a combination another app
/// already owns comes back false instead of pretending the binding took.
pub fn arm(app: &AppHandle, config: &Config) -> bool {
    let binding = if config.quake_enabled {
        parse(&config.quake_hotkey)
    } else {
        None
    };
    let state = app.state::<Quake>();
    *state.desired.lock().unwrap() = binding;

    #[cfg(windows)]
    {
        let (tx, rx) = std::sync::mpsc::channel();
        *state.reply.lock().unwrap() = Some(tx);
        let thread = state.thread.load(Ordering::Acquire);
        if thread != 0 {
            unsafe { win::PostThreadMessageW(thread, win::WM_REBIND, 0, 0) };
            if let Ok(registered) = rx.recv_timeout(std::time::Duration::from_millis(500)) {
                return !config.quake_enabled || registered;
            }
        }
        // The thread is not up yet (early startup): it will pick `desired` up
        // on its own way in and answer through the reply slot it finds armed.
    }
    !config.quake_enabled || binding.is_some()
}

#[cfg(not(windows))]
pub fn start(_app: &AppHandle) {}
