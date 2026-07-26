//! Native window dressing: the frosted backdrop and rounded corners that make
//! an undecorated window still feel like a first-class Windows 11 app.

use tauri::WebviewWindow;

/// Which backdrop the OS actually gave us. Surfaced to the UI so the frontend
/// can paint an opaque fallback instead of looking half-broken.
pub const ACRYLIC: &str = "acrylic";
pub const MICA: &str = "mica";
pub const SOLID: &str = "solid";

/// Tint applied to the acrylic layer on Windows 10. Windows 11 22H2+ ignores
/// this and uses the system backdrop material instead.
const TINT: (u8, u8, u8, u8) = (10, 11, 20, 190);

pub fn dress(window: &WebviewWindow) -> &'static str {
    #[cfg(windows)]
    {
        // Do this first: if the backdrop lands but the corners stay square, the
        // frosted layer would bleed past our rounded CSS shell.
        round_corners(window);

        if window_vibrancy::apply_acrylic(window, Some(TINT)).is_ok() {
            return ACRYLIC;
        }
        if window_vibrancy::apply_mica(window, Some(true)).is_ok() {
            return MICA;
        }
        return SOLID;
    }

    #[cfg(not(windows))]
    {
        let _ = window;
        SOLID
    }
}

#[cfg(windows)]
mod dwm {
    use std::ffi::c_void;

    // Declared by hand rather than pulled from the `windows` crate: Tauri
    // vendors its own version of that crate, and matching it would couple us to
    // an internal dependency for two constants and one call.
    #[link(name = "dwmapi")]
    unsafe extern "system" {
        fn DwmSetWindowAttribute(
            hwnd: isize,
            attribute: u32,
            value: *const c_void,
            value_size: u32,
        ) -> i32;
    }

    const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
    const DWMWCP_ROUND: u32 = 2;

    pub fn set_round_corners(hwnd: isize) {
        let preference: u32 = DWMWCP_ROUND;
        unsafe {
            // Fails harmlessly (E_INVALIDARG) on Windows 10, which has no
            // corner-preference attribute.
            DwmSetWindowAttribute(
                hwnd,
                DWMWA_WINDOW_CORNER_PREFERENCE,
                &preference as *const u32 as *const c_void,
                std::mem::size_of::<u32>() as u32,
            );
        }
    }
}

#[cfg(windows)]
fn round_corners(window: &WebviewWindow) {
    if let Ok(handle) = window.hwnd() {
        // `.0` is an isize on older windows-rs and a pointer on newer ones;
        // `as isize` normalises both without naming the type.
        dwm::set_round_corners(handle.0 as isize);
    }
}
