import type { ITerminalOptions, ITheme } from "@xterm/xterm";

import { terminalOverrides, type Config } from "../config";

/**
 * The palette lives in `styles/base.css` as custom properties; this module
 * reads it back rather than restating it, so there is exactly one place to edit
 * when retheming. Values are resolved lazily — by the time the first Terminal
 * is constructed the stylesheet is always applied, in dev and in a bundle.
 */
function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value.length > 0 ? value : fallback;
}

export function nightfallTheme(): ITheme {
  return {
    // Fully transparent: the smoked-glass tint is a DOM layer (`#stage`), which
    // keeps the WebGL renderer on its simplest, best-tested code path.
    background: "rgba(0, 0, 0, 0)",
    foreground: cssVar("--term-fg", "#d8def0"),
    cursor: cssVar("--term-cursor", "#5ef2ff"),
    cursorAccent: cssVar("--term-cursor-ink", "#05060b"),
    selectionBackground: cssVar("--term-selection", "rgba(94,242,255,0.24)"),
    selectionInactiveBackground: "rgba(94, 242, 255, 0.12)",

    black: cssVar("--ansi-black", "#12141f"),
    red: cssVar("--ansi-red", "#ff5e7a"),
    green: cssVar("--ansi-green", "#5ef2a8"),
    yellow: cssVar("--ansi-yellow", "#ffd25e"),
    blue: cssVar("--ansi-blue", "#5ea8ff"),
    magenta: cssVar("--ansi-magenta", "#a06bff"),
    cyan: cssVar("--ansi-cyan", "#5ef2ff"),
    white: cssVar("--ansi-white", "#c8d0e8"),
    brightBlack: cssVar("--ansi-bright-black", "#3a4058"),
    brightRed: cssVar("--ansi-bright-red", "#ff89a0"),
    brightGreen: cssVar("--ansi-bright-green", "#8cf7c4"),
    brightYellow: cssVar("--ansi-bright-yellow", "#ffe08c"),
    brightBlue: cssVar("--ansi-bright-blue", "#8cc4ff"),
    brightMagenta: cssVar("--ansi-bright-magenta", "#c39bff"),
    brightCyan: cssVar("--ansi-bright-cyan", "#9bf8ff"),
    brightWhite: cssVar("--ansi-bright-white", "#f0f4ff"),
  };
}

/**
 * Which xterm renderer to use.
 *
 * WebGL is the faster path, but xterm warns that it does not properly support
 * `allowTransparency`: glyphs are cached in a texture atlas with their
 * background baked in, so on a translucent surface some styled runs (italic,
 * dim) render as text-shaped opaque blocks. The DOM renderer composites
 * against the real page background and has no such problem — and at terminal
 * sizes it is more than fast enough.
 */
export const RENDERER: "webgl" | "dom" = "dom";

export function nightfallOptions(settings: Config): ITerminalOptions {
  return {
    theme: nightfallTheme(),
    allowTransparency: true,
    // Required by the unicode11 addon.
    allowProposedApi: true,
    fontWeight: 400,
    fontWeightBold: 600,
    // Both must stay neutral: the DOM renderer tiles real font glyphs, so any
    // extra leading or tracking opens gaps that break box-drawing characters
    // into dashes. (WebGL hid this by synthesising box glyphs via customGlyphs.)
    lineHeight: 1,
    letterSpacing: 0,
    cursorInactiveStyle: "outline",
    smoothScrollDuration: 90,
    scrollSensitivity: 1.2,
    drawBoldTextInBrightColors: false,
    rescaleOverlappingGlyphs: true,
    rightClickSelectsWord: false,
    // Lets xterm compensate for the ways ConPTY reports reflow differently
    // from a real pty.
    windowsPty: { backend: "conpty" },
    // Font, size, scrollback and cursor come from the user's config. Blink
    // defaults to off: the bloom overlay already breathes, and two rhythms on
    // screen fight each other.
    ...terminalOverrides(settings),
  };
}
