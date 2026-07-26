import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { Config } from "./config";

export interface SpawnResult {
  id: string;
  /** Friendly shell name for the status bar ("pwsh", "powershell", "cmd"). */
  shell: string;
}

export type Backdrop = "acrylic" | "mica" | "solid";

export interface ChromeInfo {
  backdrop: Backdrop;
}

export function chromeInfo(): Promise<ChromeInfo> {
  return invoke<ChromeInfo>("chrome_info");
}

export function ptySpawn(
  cols: number,
  rows: number,
  options: { shell?: string; cwd?: string } = {},
): Promise<SpawnResult> {
  return invoke<SpawnResult>("pty_spawn", {
    shell: options.shell ?? null,
    cwd: options.cwd ?? null,
    cols,
    rows,
  });
}

/**
 * Releases output that pooled on the Rust side. Call only after `onPtyData` has
 * resolved, otherwise the shell's first prompt can outrun the listener.
 */
export function ptyAttach(id: string): Promise<void> {
  return invoke("pty_attach", { id });
}

export function ptyWrite(id: string, data: string): Promise<void> {
  return invoke("pty_write", { id, data });
}

export function ptyResize(
  id: string,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke("pty_resize", { id, cols, rows });
}

export function ptyKill(id: string): Promise<void> {
  return invoke("pty_kill", { id });
}

/** Decoded, ~8ms-coalesced output batches from the shell. */
export function onPtyData(
  id: string,
  handle: (chunk: string) => void,
): Promise<UnlistenFn> {
  return listen<string>(`pty:data:${id}`, (event) => handle(event.payload));
}

/** Fires once, after the final output batch, when the shell process is gone. */
export function onPtyExit(id: string, handle: () => void): Promise<UnlistenFn> {
  return listen<null>(`pty:exit:${id}`, () => handle());
}

// ------------------------------------------------------------------- config

export function configGet(): Promise<Config> {
  return invoke<Config>("config_get");
}

/** Returns the config as stored, with every value clamped to its valid range. */
export function configSave(config: Config): Promise<Config> {
  return invoke<Config>("config_save", { config });
}

export function configPath(): Promise<string> {
  return invoke<string>("config_path");
}

// -------------------------------------------------------------- persistence

/** Opaque workspace snapshot; only the frontend knows its shape. */
export function stateLoad<T>(): Promise<T | null> {
  return invoke<T | null>("state_load");
}

export function stateSave(state: unknown): Promise<void> {
  return invoke("state_save", { state });
}

export function stateClear(): Promise<void> {
  return invoke("state_clear");
}

// --------------------------------------------------------------- quake mode

/**
 * Re-registers the global hotkey from the saved config. Resolves false when the
 * accelerator could not be bound, so the panel can say so.
 */
export function quakeApply(): Promise<boolean> {
  return invoke<boolean>("quake_apply");
}

/** Snap the window to the top of the active monitor. */
export function quakeDrop(): Promise<void> {
  return invoke("quake_drop");
}
