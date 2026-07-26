//! ConPTY session management.
//!
//! Each session owns two threads: a blocking reader that decodes PTY bytes into
//! UTF-8, and a flusher that coalesces those decoded chunks into ~8ms batches
//! before emitting them. Emitting per-read would make the IPC bridge the
//! bottleneck on chatty output (`cargo build`, `dir /s`, …).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// How long decoded output is allowed to pool before being shipped to the UI.
const FLUSH_INTERVAL: Duration = Duration::from_millis(8);
const READ_BUF: usize = 64 * 1024;

pub struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    /// The `Child` itself lives on the waiter thread; this is the handle we keep
    /// so the session can still be killed from a command.
    killer: Box<dyn ChildKiller + Send + Sync>,
    pump: Arc<Pump>,
}

#[derive(Default)]
pub struct PtyState(pub Mutex<HashMap<String, Session>>);

#[derive(Serialize)]
pub struct SpawnResult {
    pub id: String,
    /// Friendly shell name for the status bar ("pwsh", "powershell", "cmd").
    pub shell: String,
}

/// Buffer shared between a session's reader, waiter and flusher threads.
struct Pump {
    text: Mutex<String>,
    /// Cleared by the waiter thread once the shell process is gone.
    ///
    /// This cannot be driven off the reader hitting EOF: ConPTY keeps the
    /// master pipe open for as long as *we* hold the pty, so a read stays
    /// blocked long after the child has exited. The process handle is the only
    /// reliable signal on Windows.
    running: AtomicBool,
    /// Output pools here until the frontend has registered its listener. A
    /// shell can print its prompt before the `listen()` round-trip completes,
    /// and those first bytes would otherwise be dropped on the floor.
    attached: AtomicBool,
}

// ---------------------------------------------------------------- utf-8 seam

/// Pull every complete UTF-8 scalar out of `carry`, leaving a partial trailing
/// sequence in place for the next read. Without this, a multi-byte character
/// split across two PTY reads would be corrupted.
fn drain_utf8(carry: &mut Vec<u8>) -> String {
    let mut out = String::new();
    loop {
        match std::str::from_utf8(carry) {
            Ok(s) => {
                out.push_str(s);
                carry.clear();
                return out;
            }
            Err(err) => {
                let good = err.valid_up_to();
                if good > 0 {
                    if let Ok(s) = std::str::from_utf8(&carry[..good]) {
                        out.push_str(s);
                    }
                }
                match err.error_len() {
                    // Truncated sequence — hold the tail until more bytes land.
                    None => {
                        carry.drain(..good);
                        return out;
                    }
                    // Genuinely invalid bytes — substitute and keep going.
                    Some(bad) => {
                        out.push('\u{FFFD}');
                        carry.drain(..good + bad);
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------- shell probe

fn resolve_in_path(exe: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(exe))
        .find(|candidate| candidate.is_file())
}

/// Prefer PowerShell 7, fall back to Windows PowerShell, then cmd.
fn default_shell() -> String {
    #[cfg(windows)]
    {
        for candidate in ["pwsh.exe", "powershell.exe"] {
            if resolve_in_path(candidate).is_some() {
                return candidate.to_string();
            }
        }
        return "cmd.exe".to_string();
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}

fn friendly_name(program: &str) -> String {
    PathBuf::from(program)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| program.to_string())
}

fn build_command(program: &str, cwd: Option<String>) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(program);

    // Skip the copyright banner so the first thing you see is a prompt.
    let stem = friendly_name(program).to_lowercase();
    if stem == "pwsh" || stem == "powershell" {
        cmd.arg("-NoLogo");
    }

    // A restored directory that has since been deleted must not take the whole
    // session down with it — fall through to home in that case.
    let start = cwd
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .or_else(|| {
            std::env::var_os("USERPROFILE")
                .or_else(|| std::env::var_os("HOME"))
                .map(PathBuf::from)
        });
    if let Some(dir) = start {
        cmd.cwd(dir);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "Nighterminal");
    cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
    cmd
}

// ------------------------------------------------------------------ commands

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyState>,
    shell: Option<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<SpawnResult, String> {
    // An explicit shell wins; otherwise the configured one; otherwise probe.
    let program = shell
        .or_else(|| crate::config::load(&app).shell)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(default_shell);
    let cwd = cwd.or_else(|| crate::config::load(&app).cwd);

    let pair = native_pty_system()
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))?;

    let mut child = pair
        .slave
        .spawn_command(build_command(&program, cwd))
        .map_err(|e| format!("failed to launch {program}: {e}"))?;
    drop(pair.slave);
    let killer = child.clone_killer();

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("reader failed: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("writer failed: {e}"))?;

    let id = uuid::Uuid::new_v4().to_string();
    let pump = Arc::new(Pump {
        text: Mutex::new(String::new()),
        running: AtomicBool::new(true),
        attached: AtomicBool::new(false),
    });

    // Waiter: the authoritative "shell is gone" signal.
    {
        let pump = Arc::clone(&pump);
        std::thread::Builder::new()
            .name(format!("pty-wait-{id}"))
            .spawn(move || {
                let _ = child.wait();
                pump.running.store(false, Ordering::Release);
            })
            .map_err(|e| format!("waiter thread failed: {e}"))?;
    }

    // Reader: blocking PTY reads -> UTF-8 -> shared buffer.
    {
        let pump = Arc::clone(&pump);
        let mut reader = reader;
        std::thread::Builder::new()
            .name(format!("pty-read-{id}"))
            .spawn(move || {
                let mut raw = vec![0u8; READ_BUF];
                let mut carry: Vec<u8> = Vec::new();
                loop {
                    match reader.read(&mut raw) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            carry.extend_from_slice(&raw[..n]);
                            let text = drain_utf8(&mut carry);
                            if !text.is_empty() {
                                if let Ok(mut buf) = pump.text.lock() {
                                    buf.push_str(&text);
                                }
                            }
                        }
                    }
                }
                // Reaching here means the pty was closed (the session was
                // dropped). Exit is reported by the waiter thread, not here.
            })
            .map_err(|e| format!("reader thread failed: {e}"))?;
    }

    // Flusher: batch the buffer to the UI, then announce exit once drained.
    {
        let pump = Arc::clone(&pump);
        let app = app.clone();
        let data_event = format!("pty:data:{id}");
        let exit_event = format!("pty:exit:{id}");
        std::thread::Builder::new()
            .name(format!("pty-flush-{id}"))
            .spawn(move || loop {
                std::thread::sleep(FLUSH_INTERVAL);
                if !pump.attached.load(Ordering::Acquire) {
                    continue;
                }
                let chunk = match pump.text.lock() {
                    Ok(mut buf) if !buf.is_empty() => Some(std::mem::take(&mut *buf)),
                    _ => None,
                };
                match chunk {
                    Some(text) => {
                        if app.emit(&data_event, text).is_err() {
                            break;
                        }
                    }
                    // Buffer drained *and* the process is gone: shell exited.
                    None if !pump.running.load(Ordering::Acquire) => {
                        let _ = app.emit(&exit_event, ());
                        break;
                    }
                    None => {}
                }
            })
            .map_err(|e| format!("flush thread failed: {e}"))?;
    }

    let shell_name = friendly_name(&program);
    state.0.lock().unwrap().insert(
        id.clone(),
        Session {
            master: pair.master,
            writer,
            killer,
            pump,
        },
    );

    Ok(SpawnResult {
        id,
        shell: shell_name,
    })
}

/// Called once the frontend has its `pty:data:*` listener in place; releases
/// the output that pooled in the meantime.
#[tauri::command]
pub fn pty_attach(state: State<'_, PtyState>, id: String) -> Result<(), String> {
    let sessions = state.0.lock().unwrap();
    let session = sessions.get(&id).ok_or("no such session")?;
    session.pump.attached.store(true, Ordering::Release);
    Ok(())
}

#[tauri::command]
pub fn pty_write(state: State<'_, PtyState>, id: String, data: String) -> Result<(), String> {
    let mut sessions = state.0.lock().unwrap();
    let session = sessions.get_mut(&id).ok_or("no such session")?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(
    state: State<'_, PtyState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.0.lock().unwrap();
    let session = sessions.get(&id).ok_or("no such session")?;
    session
        .master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

/// Dropping the `Session` also drops the master pty, which releases the reader
/// thread from its blocking read.
#[tauri::command]
pub fn pty_kill(state: State<'_, PtyState>, id: String) -> Result<(), String> {
    let mut session = match state.0.lock().unwrap().remove(&id) {
        Some(s) => s,
        None => return Ok(()),
    };
    let _ = session.killer.kill();
    Ok(())
}

/// Terminate every live shell — called when the last window closes so we never
/// leave orphaned `powershell.exe` processes behind.
pub fn kill_all(state: &PtyState) {
    let drained: Vec<Session> = state.0.lock().unwrap().drain().map(|(_, s)| s).collect();
    for mut session in drained {
        let _ = session.killer.kill();
    }
}
