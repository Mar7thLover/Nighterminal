import type { ITerminalOptions } from "@xterm/xterm";

import { configGet, configSave } from "./ipc";

/**
 * Mirrors `src-tauri/src/config.rs` field for field (serde renames to
 * camelCase). Rust owns defaults and range clamping; this side never invents a
 * value, it only ever renders and edits what came back.
 */
export interface Config {
  fontFamily: string;
  fontSize: number;
  scrollback: number;
  cursorStyle: "block" | "bar" | "underline";
  cursorBlink: boolean;
  shell: string | null;
  cwd: string | null;

  opacity: number;
  aurora: boolean;
  cursorGlow: boolean;
  bootAnimation: boolean;

  restoreSession: boolean;

  quakeEnabled: boolean;
  quakeHotkey: string;
  quakeHeight: number;
  quakeHideOnBlur: boolean;
}

/**
 * Only reached when the backend call itself fails (which would mean the app is
 * already in trouble) — kept so the UI still has something to render.
 */
const FALLBACK: Config = {
  fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, "Microsoft YaHei", monospace',
  fontSize: 13.5,
  scrollback: 10_000,
  cursorStyle: "block",
  cursorBlink: false,
  shell: null,
  cwd: null,
  opacity: 0.5,
  aurora: true,
  cursorGlow: true,
  bootAnimation: true,
  restoreSession: false,
  quakeEnabled: false,
  quakeHotkey: "Ctrl+`",
  quakeHeight: 0.45,
  quakeHideOnBlur: true,
};

let current: Config = FALLBACK;
const listeners = new Set<(config: Config) => void>();

export function config(): Config {
  return current;
}

export async function loadConfig(): Promise<Config> {
  current = await configGet().catch(() => FALLBACK);
  return current;
}

/**
 * Writes a patch through to disk and republishes the sanitised result — so
 * every subscriber sees the *clamped* value, not the one that was typed.
 */
export async function updateConfig(patch: Partial<Config>): Promise<Config> {
  const merged = { ...current, ...patch };
  current = await configSave(merged).catch(() => merged);
  for (const listener of listeners) listener(current);
  return current;
}

export function onConfigChange(listener: (config: Config) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ------------------------------------------------------------------- applying

/**
 * The parts of the config that belong to the page rather than to a Terminal.
 *
 * Colour still lives entirely in `styles/base.css`; what the config overrides
 * here is the *tint alpha* over the OS backdrop, which is a preference rather
 * than part of the palette.
 */
export function applyChrome(config: Config): void {
  const root = document.documentElement;
  root.style.setProperty("--tint-term", `rgba(9, 10, 18, ${config.opacity})`);
  root.classList.toggle("no-aurora", !config.aurora);
  root.classList.toggle("no-glow", !config.cursorGlow);
  root.style.setProperty("--font-mono", config.fontFamily);
}

/** The subset of xterm options the settings panel is allowed to drive. */
export function terminalOverrides(config: Config): Partial<ITerminalOptions> {
  return {
    fontFamily: config.fontFamily,
    fontSize: config.fontSize,
    scrollback: config.scrollback,
    cursorStyle: config.cursorStyle,
    cursorBlink: config.cursorBlink,
  };
}
