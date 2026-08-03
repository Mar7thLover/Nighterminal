//! Where this instance was launched from.
//!
//! Typing `ntps` in a shell is a request to open a terminal *here*, so the
//! process working directory — or a directory named on the command line — has
//! to outrank the configured start directory. Both are read exactly once, at
//! startup: the working directory of a running process is not a stable thing to
//! consult later, and nothing else in the app is allowed to change it.

use std::path::{Path, PathBuf};

/// Flags that introduce a directory. `-d` matches what most terminals use;
/// the long forms exist because the short one is easy to forget.
const DIR_FLAGS: [&str; 3] = ["-d", "--cwd", "--directory"];

pub struct Launch {
    dir: Option<PathBuf>,
}

impl Launch {
    pub fn detect() -> Self {
        Self {
            // An explicit argument beats where the shell happened to be.
            dir: cli_dir().or_else(inherited_dir),
        }
    }

    /// Start directory for new sessions, if this launch implied one.
    pub fn dir(&self) -> Option<String> {
        self.dir
            .as_ref()
            .map(|p| p.to_string_lossy().to_string())
    }
}

/// `ntps D:\work`, `ntps -d D:\work`. Unknown flags are skipped rather than
/// rejected: this is a GUI process with no console to complain into, and a
/// typo should still open a window.
fn cli_dir() -> Option<PathBuf> {
    let mut args = std::env::args_os().skip(1);
    while let Some(arg) = args.next() {
        let text = arg.to_string_lossy().to_string();
        if DIR_FLAGS.contains(&text.as_str()) {
            if let Some(value) = args.next() {
                return usable_dir(Path::new(&value));
            }
            return None;
        }
        // WebView2 and Tauri both pass their own switches through argv.
        if text.starts_with('-') {
            continue;
        }
        return usable_dir(Path::new(&arg));
    }
    None
}

/// The directory the process was started in, unless it is one of the places
/// Windows picks on the user's behalf. A double-clicked exe or a Start-menu
/// shortcut inherits the exe's own folder; "Run" and some launchers hand over
/// `C:\Windows\System32`. Neither is a directory anyone meant to open, and
/// treating them as one would override the configured start directory forever.
fn inherited_dir() -> Option<PathBuf> {
    let cwd = std::env::current_dir().ok()?;
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf));
    if exe_dir.is_some_and(|dir| same_path(&dir, &cwd)) {
        return None;
    }
    if system_dir().is_some_and(|dir| same_path(&dir, &cwd)) {
        return None;
    }
    Some(cwd)
}

fn system_dir() -> Option<PathBuf> {
    let root = std::env::var_os("SystemRoot")?;
    Some(PathBuf::from(root).join("System32"))
}

/// Windows paths are case-insensitive; comparing them any other way would let
/// `c:\windows\system32` slip past the filter above.
fn same_path(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| {
        p.to_string_lossy()
            .trim_end_matches(['\\', '/'])
            .to_lowercase()
    };
    norm(a) == norm(b)
}

/// Resolves a command-line path against the launching shell's directory and
/// keeps it only if it really is a directory — the alternative is a window
/// whose shell silently started somewhere else.
fn usable_dir(path: &Path) -> Option<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().ok()?.join(path)
    };
    absolute.is_dir().then_some(absolute)
}
