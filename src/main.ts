import "@xterm/xterm/css/xterm.css";
import "./styles/base.css";
import "./styles/themes.css";
import "./styles/chrome.css";
import "./styles/term.css";
import "./styles/effects.css";
import "./styles/settings.css";

import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";

import {
  applyChrome,
  config,
  loadConfig,
  onConfigChange,
} from "./config";
import { chromeInfo, quakeApply, quakeDrop, stateLoad, stateSave } from "./ipc";
import type { Session } from "./session";
import { dismissBoot } from "./ui/boot";
import { revealWindow, wireWindowChrome } from "./ui/chrome";
import { ConnectPrompt } from "./ui/connect";
import { CursorGlow } from "./ui/cursor-glow";
import { HOTKEY_WARNING, SettingsPanel } from "./ui/settings";
import { TabBar } from "./ui/tabbar";
import { Workspace } from "./workspace";

function need<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`missing #${id}`);
  return el as T;
}

/** Long enough to coalesce a burst of layout changes, short enough that a hard
 *  kill still loses at most this much of the workspace. */
const SNAPSHOT_DEBOUNCE_MS = 600;

const stage = need("stage");
const panes = need("panes");
const statusBar = need("status");
const stShell = need("st-shell");
const stSize = need("st-size");
const stRenderer = need("st-renderer");
const stBackdrop = need("st-backdrop");
const stPanes = need("st-panes");

const glow = new CursorGlow(stage, need("glow-core"), need("glow-halo"));
const settings = new SettingsPanel(need("app"));
// SSH panes are plain ConPTY sessions running the system OpenSSH client; the
// prompt only assembles the argv (see ui/connect.ts for why).
const connect = new ConnectPrompt(
  need("app"),
  (args) =>
    void workspace.open({
      layout: { kind: "leaf", shell: "ssh.exe", cwd: null, args },
    }),
  () => workspace.focused?.focus(),
);

const tabs = new TabBar(need("tabs"), need("tab-indicator"), {
  onSelect: (key) => workspace.activate(workspace.find(key) ?? null),
  onClose: (key) => {
    const tab = workspace.find(key);
    if (tab !== undefined) workspace.closeTab(tab);
  },
  onReorder: (keys) => {
    workspace.reorderTabs(keys);
    scheduleSnapshot();
  },
});

const workspace = new Workspace(panes, {
  onPaneCreate: (session) =>
    session.term.attachCustomKeyEventHandler(handleTerminalKey),
  onTabOpen: (tab) => {
    tabs.add(tab.key, tab.focused.title);
    tab.el.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const session = workspace.focused;
      if (session !== null) void quickClipboard(session);
    });
  },
  onTabTitle: (tab) => tabs.setLabel(tab.key, tab.focused.title),
  onTabActivate: (tab) => {
    tabs.select(tab?.key ?? null);
    applyImmersive();
    paintStatus();
  },
  onTabDead: (tab, dead) => {
    tabs.setDead(tab.key, dead);
    paintStatus();
  },
  onTabClose: (tab) => {
    tabs.remove(tab.key);
    scheduleSnapshot();
  },
  onFocus: (session) => {
    glow.follow(session);
    paintStatus();
    scheduleSnapshot();
  },
  onGeometry: () => {
    glow.refresh();
    paintStatus();
  },
  onImmersive: () => applyImmersive(),
  onEmpty: () => void getCurrentWindow().close(),
});

// Terminals inside every tab need to be told about font, cursor and scrollback
// changes; the page itself needs the tint and the effect toggles.
onConfigChange((next) => {
  applyChrome(next);
  workspace.applySettings();
  glow.refresh();
});

/**
 * Collapse the status bar while a full-screen TUI owns the focused pane, and
 * bring it back when the app exits. The stage grows into the reclaimed row; the
 * ResizeObserver in Workspace refits and resizes the pty once the transition
 * settles.
 */
function applyImmersive(): void {
  document.documentElement.classList.toggle(
    "immersive",
    workspace.focused?.immersive ?? false,
  );
}

function paintStatus(): void {
  const session = workspace.focused;
  stShell.textContent = session?.shell ?? "—";
  stSize.textContent =
    session === null ? "—" : `${session.term.cols}×${session.term.rows}`;
  stRenderer.textContent = session?.renderer.toUpperCase() ?? "—";
  const count = workspace.paneCount;
  stPanes.textContent = count > 1 ? `${count} panes` : "";
  stPanes.classList.toggle("off", count < 2);
  statusBar.classList.toggle("detached", session !== null && !session.alive);
}

// ------------------------------------------------------------------ snapshot

let snapshotTimer: number | null = null;
/** Last known window geometry, kept up to date by the window's own events —
 *  reading it at save time would mean awaiting inside `beforeunload`. */
let geometry: { x: number; y: number; width: number; height: number } | null =
  null;

/** Persist the workspace shortly after it settles, so a crash or a power cut
 *  still leaves something to restore from. */
function scheduleSnapshot(): void {
  if (!config().restoreSession) return;
  if (snapshotTimer !== null) clearTimeout(snapshotTimer);
  snapshotTimer = window.setTimeout(() => {
    snapshotTimer = null;
    void saveSnapshot();
  }, SNAPSHOT_DEBOUNCE_MS);
}

async function saveSnapshot(): Promise<void> {
  if (!config().restoreSession) return;
  const shape = workspace.snapshot();
  if (shape.tabs.length === 0) return;
  await stateSave({ ...shape, window: geometry }).catch(() => undefined);
}

/**
 * Track window geometry so it can be restored next launch. Quake mode places
 * the window itself, so there is nothing worth remembering there.
 */
async function watchGeometry(): Promise<void> {
  if (config().quakeEnabled) return;
  const win = getCurrentWindow();

  const read = async (): Promise<void> => {
    // A minimised window reports (-32000, -32000) and a stub size; a maximised
    // one reports the screen. Neither is what should come back next launch.
    if ((await win.isMinimized()) || (await win.isMaximized())) return;
    const [position, size] = await Promise.all([
      win.outerPosition(),
      win.innerSize(),
    ]);
    geometry = {
      x: position.x,
      y: position.y,
      width: size.width,
      height: size.height,
    };
    scheduleSnapshot();
  };

  await read();
  void win.onResized(() => void read());
  void win.onMoved(() => void read());
}

/** Put the window back where it was, if it still lands on a visible screen. */
async function restoreGeometry(shape: unknown): Promise<void> {
  if (typeof shape !== "object" || shape === null) return;
  const saved = (shape as { window?: unknown }).window;
  if (typeof saved !== "object" || saved === null) return;
  const box = saved as Record<string, unknown>;
  const values = ["x", "y", "width", "height"].map((key) => box[key]);
  if (!values.every((v) => typeof v === "number" && Number.isFinite(v))) return;
  const [x, y, width, height] = values as number[];
  if (width < 200 || height < 120) return;

  const win = getCurrentWindow();
  await win.setSize(new PhysicalSize(width, height));
  // Clamped by the OS if the monitor it was on is gone, so a stale position
  // can't strand the window off-screen.
  await win.setPosition(new PhysicalPosition(x, y));
}

// ------------------------------------------------------------------ clipboard

async function copySelection(): Promise<void> {
  const text = workspace.focused?.term.getSelection() ?? "";
  if (text.length === 0) return;
  // WebView2 can refuse clipboard access; a copy that silently didn't happen
  // beats an unhandled rejection.
  await navigator.clipboard.writeText(text).catch(() => undefined);
}

async function pasteClipboard(): Promise<void> {
  const session = workspace.focused;
  if (session === null || !session.alive) return;
  const text = await navigator.clipboard.readText().catch(() => "");
  // Route through xterm so bracketed-paste mode is honoured when the shell
  // has asked for it.
  if (text.length > 0) session.term.paste(text);
}

/** Right-click: copy when something is selected, otherwise paste. */
async function quickClipboard(session: Session): Promise<void> {
  if (session.term.hasSelection()) {
    await copySelection();
    session.term.clearSelection();
  } else {
    await pasteClipboard();
  }
}

// ----------------------------------------------------------------- shortcuts

/**
 * Matched on `event.code` so the bindings survive non-US keyboard layouts.
 * Deliberately absent: plain Ctrl+C and Ctrl+V — the former must reach the
 * shell as SIGINT, and the latter already arrives as a native paste event that
 * xterm handles itself.
 */
function matchShortcut(event: KeyboardEvent): (() => void) | null {
  if (event.altKey && !event.ctrlKey && !event.shiftKey) {
    switch (event.code) {
      case "ArrowLeft":
        return () => workspace.focusSide("left");
      case "ArrowRight":
        return () => workspace.focusSide("right");
      case "ArrowUp":
        return () => workspace.focusSide("up");
      case "ArrowDown":
        return () => workspace.focusSide("down");
    }
    return null;
  }

  if (!event.ctrlKey) return null;

  if (event.shiftKey && !event.altKey) {
    switch (event.code) {
      case "KeyT":
        return () => void workspace.open();
      case "KeyS":
        return () => connect.toggle();
      case "KeyW":
        return () => workspace.closeFocused();
      case "KeyD":
        return () => void workspace.split("row");
      case "KeyE":
        return () => void workspace.split("col");
      case "KeyC":
        return () => void copySelection();
      case "KeyV":
        return () => void pasteClipboard();
      case "Tab":
        return () => workspace.activateRelative(-1);
      case "PageUp":
        return () => workspace.activateRelative(-1);
      case "PageDown":
        return () => workspace.activateRelative(1);
    }
    return null;
  }

  if (!event.shiftKey && !event.altKey) {
    switch (event.code) {
      case "Comma":
        return () => settings.toggle();
      case "Tab":
        return () => workspace.activateRelative(1);
      case "PageDown":
        return () => workspace.activateRelative(1);
      case "PageUp":
        return () => workspace.activateRelative(-1);
    }
    return null;
  }

  // AltGr on Windows reports as Ctrl+Alt; on many layouts AltGr+digit types a
  // character, and swallowing it here would make those keys dead.
  if (
    event.altKey &&
    !event.shiftKey &&
    !event.getModifierState("AltGraph")
  ) {
    const digit = /^Digit([1-9])$/.exec(event.code);
    if (digit !== null) {
      const index = Number(digit[1]) - 1;
      return () => workspace.activateIndex(index);
    }
    // Swap the focused pane with a neighbour — the Ctrl twin of Alt+arrows.
    // Not Ctrl+Shift+arrows: PSReadLine binds those to select-by-word, and
    // this app makes a point of not stealing keys the shell uses.
    switch (event.code) {
      case "ArrowLeft":
        return () => workspace.swapSide("left");
      case "ArrowRight":
        return () => workspace.swapSide("right");
      case "ArrowUp":
        return () => workspace.swapSide("up");
      case "ArrowDown":
        return () => workspace.swapSide("down");
    }
  }
  return null;
}

/**
 * Installed on every Terminal. Returning false stops xterm from forwarding the
 * key to the shell; we run the action on keydown only, but swallow the matching
 * keyup too so no stray bytes escape.
 */
function handleTerminalKey(event: KeyboardEvent): boolean {
  // Escape belongs to the shell unless the panel is what is on screen.
  if (event.code === "Escape" && settings.isOpen) {
    if (event.type === "keydown") settings.hide();
    return false;
  }
  const action = matchShortcut(event);
  if (action === null) return true;
  if (event.type === "keydown") {
    event.preventDefault();
    action();
  }
  return false;
}

// Same bindings when focus is on the chrome rather than inside a terminal.
window.addEventListener("keydown", (event) => {
  if (workspace.focused?.term.textarea === document.activeElement) return;
  if (event.code === "Escape" && connect.isOpen) {
    connect.hide();
    return;
  }
  // Keys typed into the settings panel or the SSH prompt are data entry, not
  // commands — without this, typing in the font field could tear tabs open.
  // The two ways of closing keep working: Escape, and the same Ctrl+, that
  // opened the panel.
  if (
    event.target instanceof Element &&
    event.target.closest("#settings, #connect") !== null
  ) {
    if (event.code === "Escape" && settings.isOpen) {
      settings.hide();
    } else if (
      event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey &&
      event.code === "Comma"
    ) {
      event.preventDefault();
      settings.toggle();
    }
    return;
  }
  if (event.code === "Escape" && settings.isOpen) {
    settings.hide();
    return;
  }
  const action = matchShortcut(event);
  if (action === null) return;
  event.preventDefault();
  action();
});

// ---------------------------------------------------------------------- boot

need("new-tab").addEventListener("click", () => void workspace.open());
need("open-ssh").addEventListener("click", () => connect.toggle());
need("open-settings").addEventListener("click", () => settings.toggle());

async function main(): Promise<void> {
  const settingsValues = await loadConfig();
  applyChrome(settingsValues);
  if (!settingsValues.bootAnimation) {
    document.getElementById("boot")?.remove();
  }

  wireWindowChrome();

  const { backdrop } = await chromeInfo().catch(() => ({
    backdrop: "solid" as const,
  }));
  stBackdrop.textContent = backdrop;
  if (backdrop === "solid") {
    // No OS blur to show through — paint an opaque surface instead.
    document.documentElement.classList.add("no-backdrop");
  }

  const saved = settingsValues.restoreSession
    ? await stateLoad().catch(() => null)
    : null;

  // Both of these place the window, so they must run before it is ever shown —
  // otherwise the first frame is visibly in the wrong place. Quake wins: it
  // owns the geometry for as long as it is armed.
  if (settingsValues.quakeEnabled) {
    const ok = await quakeApply();
    // Surfaced in the panel footer — there is no console in a release build.
    // The backend refuses to hide-on-blur while the hotkey is unbound, so the
    // window stays reachable either way.
    if (!ok) settings.warn(HOTKEY_WARNING);
    await quakeDrop();
  } else if (saved !== null) {
    await restoreGeometry(saved).catch(() => undefined);
  }

  // Reveal behind the boot curtain so the first frame is never a white flash.
  revealWindow();

  try {
    const restored =
      saved !== null && (await workspace.restore(saved).catch(() => false));
    if (!restored) await workspace.open();
  } finally {
    // Whatever happened above, the curtain must lift — a failed shell launch
    // shows its error in the pane, not a forever-boot screen.
    void watchGeometry();
    await dismissBoot();
    workspace.focused?.focus();
  }
}

// The webview gets torn down before Rust sees the exit, so this is the last
// chance to write the workspace out.
window.addEventListener("beforeunload", () => void saveSnapshot());

main().catch((error: unknown) => {
  // Should be unreachable — every step above has its own fallback — but a blank
  // window that never reveals would be strictly worse than a broken one.
  console.error(error);
  revealWindow();
  void dismissBoot();
});
