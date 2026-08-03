/**
 * Which way round the active theme is, read straight from the stylesheet.
 *
 * Lives apart from `nightfall.ts` because both the config layer and the ANSI
 * flattener need it, and neither should have to pull in the xterm ITheme
 * builder (nor make an import cycle out of it).
 */

/** A theme paints on either a dark or a light surface; a great deal follows
 *  from which (see `ansi/flatten-bg.ts` and `config.applyChrome`). */
export type SurfaceMode = "dark" | "light";

/**
 * Resolved lazily: by the time anything asks, the stylesheet is applied and
 * `applyChrome` has stamped `data-theme`. `getComputedStyle` forces a style
 * recalculation, so a read right after a theme switch already sees the new
 * value.
 */
export function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value.length > 0 ? value : fallback;
}

/**
 * Themes declare their surface as `--theme-mode`. Anything that fails to — an
 * unknown theme id, which matches no CSS block at all — reads as dark, which is
 * what the default cascade gives it anyway.
 */
export function themeMode(): SurfaceMode {
  return cssVar("--theme-mode", "dark") === "light" ? "light" : "dark";
}
