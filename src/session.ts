import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import type { UnlistenFn } from "@tauri-apps/api/event";

import { BackgroundFlattener } from "./ansi/flatten-bg";
import { config, terminalOverrides, type Config } from "./config";
import { RENDERER, nightfallOptions, nightfallTheme } from "./theme/nightfall";
import {
  onPtyData,
  onPtyExit,
  ptyAttach,
  ptyKill,
  ptyResize,
  ptySpawn,
  ptyWrite,
  type SpawnResult,
} from "./ipc";

export type Renderer = "webgl" | "dom";

/** A shell exiting sooner than this is treated as a launch failure. */
const LAUNCH_GRACE_MS = 1500;

export interface SessionHooks {
  onTitle(session: Session): void;
  onExit(session: Session): void;
  onGeometry(session: Session): void;
  /** A full-screen TUI took over this session's grid, or handed it back. */
  onImmersive(session: Session): void;
  /** The user clicked or tabbed into this pane. */
  onFocus(session: Session): void;
}

/** What survives a restart: enough to put the pane back where it was. */
export interface SessionSnapshot {
  shell: string | null;
  cwd: string | null;
}

let nextKey = 1;

export class Session {
  readonly key = `s${nextKey++}`;
  readonly term: Terminal;
  readonly el: HTMLDivElement;
  renderer: Renderer = "dom";

  ptyId: string | null = null;
  shell = "shell";
  /**
   * The shell this pane was *asked* to run — an explicit path from the config
   * or a restored leaf, or null for "auto-probe". Snapshots record this rather
   * than what the probe resolved: pinning a probed "pwsh.exe" would make every
   * restored pane die if pwsh is later uninstalled, where a null re-probes and
   * falls back gracefully.
   */
  private requestedShell: string | null = null;
  title = "shell";
  alive = true;
  /** The shell died within the launch grace period — probably never started. */
  launchFailed = false;
  /**
   * True while a full-screen app owns the grid. Signalled by the alternate
   * screen buffer (`ESC[?1049h`), which is what every full-screen TUI switches
   * to — Claude Code, vim, less, htop, lazygit.
   */
  immersive = false;
  /**
   * Last directory the shell reported, via OSC 7 or OSC 9;9. Shells without
   * that integration leave it null, and restore falls back to the configured
   * start directory.
   */
  cwd: string | null = null;

  private readonly fitAddon = new FitAddon();
  private readonly unlisteners: UnlistenFn[] = [];
  /** Keeps TUI-painted black fills from punching holes through the glass. */
  private readonly flattener = new BackgroundFlattener();
  /** Keystrokes that arrive before the pty handshake completes. */
  private pendingInput = "";
  private spawnedAt = 0;
  private mounted = false;
  private disposed = false;
  /** Theme id baked into the current ITheme, to skip no-op retheming. */
  private appliedTheme = config().theme;

  constructor(private readonly hooks: SessionHooks) {
    this.el = document.createElement("div");
    this.el.className = "pane";
    this.term = new Terminal(nightfallOptions(config()));
  }

  /**
   * Attaches the renderer. Must run *after* `el` is in the document: xterm
   * measures a real cell from live layout, and a detached element measures as
   * zero.
   */
  mount(): void {
    if (this.mounted || this.disposed) return;
    this.mounted = true;

    this.term.loadAddon(this.fitAddon);
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = "11";

    // Must be opened before the WebGL addon can acquire a context.
    this.term.open(this.el);
    this.term.loadAddon(new WebLinksAddon());
    this.renderer = this.tryWebgl() ? "webgl" : "dom";

    this.term.onData((data) => {
      if (this.ptyId === null) {
        this.pendingInput += data;
      } else if (this.alive) {
        void ptyWrite(this.ptyId, data);
      }
    });

    // Fires only when the grid genuinely changes, so this never spams ConPTY.
    this.term.onResize(({ cols, rows }) => {
      if (this.ptyId !== null) void ptyResize(this.ptyId, cols, rows);
      this.hooks.onGeometry(this);
    });

    this.term.buffer.onBufferChange(() => {
      const immersive = this.term.buffer.active.type === "alternate";
      if (immersive === this.immersive) return;
      this.immersive = immersive;
      this.hooks.onImmersive(this);
    });

    this.term.onTitleChange((raw) => {
      const next = compactTitle(raw);
      if (next.length === 0 || next === this.title) return;
      this.title = next;
      this.hooks.onTitle(this);
    });

    this.watchDirectory();

    // Mousedown rather than click, and on the pane rather than the textarea, so
    // the padding around the grid also claims focus.
    this.el.addEventListener("mousedown", () => this.hooks.onFocus(this));
    this.term.textarea?.addEventListener("focus", () => this.hooks.onFocus(this));
  }

  /**
   * Both conventions for "I am now in this directory": OSC 7 carries a file://
   * URL (the de-facto Unix standard), OSC 9;9 a bare Windows path (what
   * PowerShell's shell integration emits).
   */
  private watchDirectory(): void {
    this.term.parser.registerOscHandler(7, (payload) => {
      try {
        const url = new URL(payload);
        if (url.protocol === "file:") {
          // `/C:/Users/x` -> `C:\Users\x`
          const path = decodeURIComponent(url.pathname).replace(
            /^\/(?=[A-Za-z]:)/,
            "",
          );
          this.cwd = path.replace(/\//g, "\\");
        }
      } catch {
        // Malformed sequence from some program — nothing to do but ignore it.
      }
      return true;
    });

    this.term.parser.registerOscHandler(9, (payload) => {
      // OSC 9 is overloaded (9;4 is progress, plain text is a toast); only the
      // 9;9 sub-command carries a directory.
      if (payload.startsWith("9;")) {
        const path = payload.slice(2).trim();
        if (path.length > 0) this.cwd = path;
      }
      // Not consumed: other handlers may still want the notification forms.
      return false;
    });
  }

  /**
   * The WebGL renderer is the fast path but can fail outright (no WebGL2) or
   * lose its context later; either way we fall back to the DOM renderer rather
   * than leaving a blank canvas.
   */
  private tryWebgl(): boolean {
    if (RENDERER !== "webgl") return false;
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => addon.dispose());
      this.term.loadAddon(addon);
      return true;
    } catch {
      return false;
    }
  }

  async start(restore?: SessionSnapshot): Promise<void> {
    this.fit();
    this.requestedShell = restore?.shell ?? config().shell;
    let spawned: SpawnResult;
    try {
      spawned = await ptySpawn(this.term.cols, this.term.rows, {
        shell: restore?.shell ?? undefined,
        cwd: restore?.cwd ?? undefined,
      });
    } catch (error) {
      // The shell never started (bad path, most likely). The pane stays on
      // screen wearing the error instead of the whole open() falling over.
      this.failLaunch(error);
      return;
    }
    const { id, shell } = spawned;
    if (this.disposed) {
      void ptyKill(id);
      return;
    }

    this.ptyId = id;
    this.shell = shell;
    this.title = shell;
    this.spawnedAt = performance.now();
    // The tab was created before we knew which shell we'd get.
    this.hooks.onTitle(this);

    this.unlisteners.push(
      await onPtyData(id, (chunk) => this.term.write(this.flattener.push(chunk))),
      await onPtyExit(id, () => this.handleExit()),
    );
    // Listeners are live — let the backend release what it buffered.
    await ptyAttach(id);

    if (this.pendingInput.length > 0) {
      void ptyWrite(id, this.pendingInput);
      this.pendingInput = "";
    }
  }

  private handleExit(): void {
    if (!this.alive) return;
    this.alive = false;
    this.launchFailed = performance.now() - this.spawnedAt < LAUNCH_GRACE_MS;
    this.el.classList.add("dead");
    if (this.launchFailed) {
      // SGR 31 rather than a truecolor literal so the line follows the theme.
      this.term.write(
        `\r\n\x1b[31m● ${this.shell} exited immediately — ` +
          `whatever it printed above is the whole story.\x1b[0m\r\n`,
      );
    }
    this.hooks.onExit(this);
  }

  /** `pty_spawn` itself failed. Same outcome as a shell that died instantly:
   *  the pane stays, shows why in red, and the tab's dot goes red. */
  private failLaunch(error: unknown): void {
    if (this.disposed) return;
    this.alive = false;
    this.launchFailed = true;
    this.el.classList.add("dead");
    const detail = error instanceof Error ? error.message : String(error);
    this.term.write(`\r\n\x1b[31m● ${detail}\x1b[0m\r\n`);
    this.hooks.onExit(this);
  }

  /** Live-apply the settings that can change without respawning the shell. */
  applySettings(settings: Config): void {
    if (this.disposed) return;
    const options = terminalOverrides(settings);
    for (const [key, value] of Object.entries(options)) {
      (this.term.options as Record<string, unknown>)[key] = value;
    }
    // Rebuild the ITheme only on an actual theme switch — it forces a full
    // repaint, which a font-size nudge shouldn't pay for. `applyChrome` has
    // already stamped the new `data-theme`, so the CSS variables read fresh.
    if (settings.theme !== this.appliedTheme) {
      this.appliedTheme = settings.theme;
      this.term.options.theme = nightfallTheme();
    }
    this.fit();
  }

  fit(): void {
    if (this.disposed || !this.mounted) return;
    // A pane in a hidden tab measures zero; fitting it would clamp the grid to
    // 1×1 and make ConPTY reflow the scrollback for nothing.
    if (this.el.clientWidth === 0 || this.el.clientHeight === 0) return;
    try {
      this.fitAddon.fit();
    } catch {
      // Not laid out yet; the next fit will catch it.
    }
  }

  focus(): void {
    this.term.focus();
  }

  snapshot(): SessionSnapshot {
    // What this pane was asked to run — the configured default may have
    // changed since, and restoring should bring back what was open. "Auto"
    // stays null so the restore re-probes instead of pinning a probe result.
    return { shell: this.requestedShell, cwd: this.cwd };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.unlisteners) off();
    this.unlisteners.length = 0;
    if (this.ptyId !== null) void ptyKill(this.ptyId);
    this.term.dispose();
    this.el.remove();
  }
}

/**
 * Tabs are ~190px wide, so trim what ConPTY hands us down to the part that
 * identifies the session: `D:\Projects\Nighterminal` -> `Nighterminal`, and
 * `powershell.exe` -> `powershell`.
 */
export function compactTitle(raw: string): string {
  let text = raw.trim();
  if (/[\\/]/.test(text)) {
    text = text.split(/[\\/]/).filter(Boolean).pop() ?? text;
  }
  return text.replace(/\.exe$/i, "");
}
