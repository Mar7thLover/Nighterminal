//! Workspace snapshot for session restore.
//!
//! The payload is deliberately opaque here — a `serde_json::Value` the frontend
//! writes and reads back. Tabs and split layouts are a frontend concept, and
//! teaching Rust their shape would mean editing two files every time the layout
//! model grows a field.

use std::fs;

use serde_json::Value;
use tauri::AppHandle;

use crate::config;

const FILE: &str = "state.json";

#[tauri::command]
pub fn state_load(app: AppHandle) -> Option<Value> {
    let path = config::dir(&app).ok()?.join(FILE);
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

#[tauri::command]
pub fn state_save(app: AppHandle, state: Value) -> Result<(), String> {
    let path = config::dir(&app)?.join(FILE);
    let text = serde_json::to_string(&state).map_err(|e| format!("cannot encode state: {e}"))?;
    fs::write(&path, text).map_err(|e| format!("cannot write {}: {e}", path.display()))
}

/// Called when restore is switched off, so a stale snapshot can't come back if
/// it is switched on again months later.
#[tauri::command]
pub fn state_clear(app: AppHandle) -> Result<(), String> {
    let path = config::dir(&app)?.join(FILE);
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("cannot remove {}: {e}", path.display())),
    }
}
