//! On-disk settings.
//!
//! The file is the user's, not ours: it is read leniently (every field has a
//! default, unknown keys are ignored, a corrupt file falls back to defaults
//! rather than refusing to start) and written whole. The frontend owns the
//! meaning of these values — this module only guarantees they survive a
//! restart.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// Written next to `state.json` in the app config dir.
const FILE: &str = "config.json";

fn default_font_family() -> String {
    "\"Cascadia Code\", \"Cascadia Mono\", Consolas, \"Microsoft YaHei\", monospace".into()
}
fn default_font_size() -> f32 {
    13.5
}
fn default_opacity() -> f32 {
    0.5
}
fn default_scrollback() -> u32 {
    10_000
}
fn default_cursor_style() -> String {
    "block".into()
}
fn default_true() -> bool {
    true
}
fn default_quake_hotkey() -> String {
    "Ctrl+`".into()
}
fn default_quake_height() -> f32 {
    0.45
}
fn default_theme() -> String {
    "nightfall".into()
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    // ---- terminal
    #[serde(default = "default_font_family")]
    pub font_family: String,
    #[serde(default = "default_font_size")]
    pub font_size: f32,
    #[serde(default = "default_scrollback")]
    pub scrollback: u32,
    #[serde(default = "default_cursor_style")]
    pub cursor_style: String,
    pub cursor_blink: bool,
    /// Render programming ligatures (=> != …) when the font has them.
    pub ligatures: bool,
    /// `None` means "probe for pwsh, then powershell, then cmd".
    pub shell: Option<String>,
    /// Where new sessions start. `None` means the user's home directory.
    pub cwd: Option<String>,

    // ---- appearance
    /// Colour theme id, matched against `:root[data-theme=…]` rules in CSS.
    /// Unknown ids are harmless — nothing matches and the default cascade
    /// applies — so this is not whitelisted here; adding a theme touches only
    /// the CSS and the settings panel's option list.
    #[serde(default = "default_theme")]
    pub theme: String,
    /// Alpha of the smoked-glass tint over the OS backdrop, 0…1.
    #[serde(default = "default_opacity")]
    pub opacity: f32,
    #[serde(default = "default_true")]
    pub aurora: bool,
    #[serde(default = "default_true")]
    pub cursor_glow: bool,
    #[serde(default = "default_true")]
    pub boot_animation: bool,

    // ---- behaviour
    /// Reopen last session's tabs and splits on launch.
    pub restore_session: bool,

    // ---- quake mode
    pub quake_enabled: bool,
    #[serde(default = "default_quake_hotkey")]
    pub quake_hotkey: String,
    /// Fraction of the work area the dropped-down window covers, 0.2…1.
    #[serde(default = "default_quake_height")]
    pub quake_height: f32,
    pub quake_hide_on_blur: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            font_family: default_font_family(),
            font_size: default_font_size(),
            scrollback: default_scrollback(),
            cursor_style: default_cursor_style(),
            cursor_blink: false,
            ligatures: false,
            shell: None,
            cwd: None,
            theme: default_theme(),
            opacity: default_opacity(),
            aurora: true,
            cursor_glow: true,
            boot_animation: true,
            restore_session: false,
            quake_enabled: false,
            quake_hotkey: default_quake_hotkey(),
            quake_height: default_quake_height(),
            quake_hide_on_blur: true,
        }
    }
}

impl Config {
    /// Clamp anything a hand-edited file could put out of range. Called on both
    /// load and save so neither path can hand the UI a value it can't render.
    fn sanitize(&mut self) {
        self.font_size = self.font_size.clamp(6.0, 40.0);
        self.opacity = self.opacity.clamp(0.0, 1.0);
        self.scrollback = self.scrollback.clamp(0, 500_000);
        self.quake_height = self.quake_height.clamp(0.2, 1.0);
        if !matches!(
            self.cursor_style.as_str(),
            "block" | "bar" | "underline"
        ) {
            self.cursor_style = default_cursor_style();
        }
        if self.font_family.trim().is_empty() {
            self.font_family = default_font_family();
        }
        self.theme = self.theme.trim().to_string();
        if self.theme.is_empty() {
            self.theme = default_theme();
        }
        // quake_hotkey is deliberately NOT validated here: sanitize also runs
        // on save, and silently swapping an unparseable recorded combination
        // for the default would kill the settings panel's "组合键无效" warning
        // (quake_apply reports the failure honestly, and hide-on-blur is gated
        // on a live registration, so an unusable string is visible and safe).
    }
}

/// `%APPDATA%\dev.nighterminal.app`, created on demand.
pub fn dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("no config dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    Ok(dir)
}

pub fn load(app: &AppHandle) -> Config {
    let mut config = dir(app)
        .ok()
        .and_then(|d| fs::read_to_string(d.join(FILE)).ok())
        // A file we can't parse is not worth failing over: the settings panel
        // will rewrite it whole on the next change.
        .and_then(|text| serde_json::from_str::<Config>(&text).ok())
        .unwrap_or_default();
    config.sanitize();
    config
}

// ------------------------------------------------------------------ commands

#[tauri::command]
pub fn config_get(app: AppHandle) -> Config {
    load(&app)
}

#[tauri::command]
pub fn config_save(app: AppHandle, config: Config) -> Result<Config, String> {
    let mut config = config;
    config.sanitize();
    let path = dir(&app)?.join(FILE);
    let text =
        serde_json::to_string_pretty(&config).map_err(|e| format!("cannot encode config: {e}"))?;
    fs::write(&path, text).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    Ok(config)
}

/// Surfaced in the settings panel so the file can be hand-edited.
#[tauri::command]
pub fn config_path(app: AppHandle) -> Result<String, String> {
    Ok(dir(&app)?.join(FILE).to_string_lossy().to_string())
}
