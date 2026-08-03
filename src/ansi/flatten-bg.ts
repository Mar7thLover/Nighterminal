/**
 * Rewrites app-painted "terminal background" fills to the *real* default
 * background.
 *
 * TUIs assume the terminal is opaque and paint their own background colour
 * behind highlighted spans — Claude Code, for example, emits
 * `ESC[48;2;0;0;0m`. On a black terminal that fill is invisible, which is
 * exactly what the app intends. On a translucent one it punches a solid black
 * hole through the glass.
 *
 * Mapping those fills onto SGR 49 restores the intended appearance. Only
 * near-*neutral* fills on the same side as the terminal's own background are
 * touched, so deliberate colour fills survive: a blue selection band
 * (`48;2;38;79;120`) or a dark red error strip still render.
 *
 * Which side that is comes from the theme. A dark theme flattens near-blacks,
 * because that is what an app paints when it believes the terminal is dark; a
 * light theme flattens near-whites, for the same reason in reverse. The two
 * rules are never both on: on a light surface a black fill is an app that
 * decided the terminal was dark, and rewriting *that* to 49 would drop its
 * light-on-black text onto a light background, unreadable. Left alone it is
 * merely a black band — visible, but legible, and the app can be told (see the
 * OSC 11 reply in `session.ts`) to stop drawing it.
 *
 * Colon-separated SGR (`48:2::r:g:b`) is left alone — it is rare, and passing
 * it through unchanged is the safe failure mode.
 */

import type { SurfaceMode } from "../theme/surface";

/** How far from pure black (or pure white) a fill may sit and still be
 *  standing in for the terminal background. */
const MARGIN = 42;
/** ...and how far from neutral. Keeps saturated fills intact. */
const MAX_SPREAD = 18;
/** Never stall the stream waiting for an escape that will not arrive. */
const MAX_CARRY = 64;

const SGR = /\x1b\[([0-9;:]*)m/g;

/** 256-colour index to RGB; null for the 16 palette slots. */
function palette256(n: number): [number, number, number] | null {
  if (n >= 232 && n <= 255) {
    const v = 8 + (n - 232) * 10;
    return [v, v, v];
  }
  if (n >= 16 && n <= 231) {
    const i = n - 16;
    const level = (step: number): number => (step === 0 ? 0 : 55 + step * 40);
    return [level(Math.floor(i / 36)), level(Math.floor(i / 6) % 6), level(i % 6)];
  }
  return null;
}

export class BackgroundFlattener {
  private carry = "";

  constructor(private mode: SurfaceMode = "dark") {}

  /** Follow a theme switch. The carry buffer is a half-read escape sequence,
   *  not palette state, so it survives the change untouched. */
  setMode(mode: SurfaceMode): void {
    this.mode = mode;
  }

  push(chunk: string): string {
    let text = this.carry + chunk;
    this.carry = "";

    const cut = incompleteTail(text);
    if (cut < text.length) {
      const tail = text.slice(cut);
      if (tail.length > MAX_CARRY) {
        // Not a real escape sequence; stop holding it back.
        text = text.slice(0, cut) + tail;
      } else {
        this.carry = tail;
        text = text.slice(0, cut);
      }
    }

    SGR.lastIndex = 0;
    return text.replace(SGR, (whole, params: string) => {
      const rewritten = this.rewriteParams(params);
      return rewritten === null ? whole : `\x1b[${rewritten}m`;
    });
  }

  private isBackgroundFill(r: number, g: number, b: number): boolean {
    const hi = Math.max(r, g, b);
    const lo = Math.min(r, g, b);
    if (hi - lo > MAX_SPREAD) return false;
    return this.mode === "dark" ? hi <= MARGIN : lo >= 255 - MARGIN;
  }

  private isIndexBackgroundFill(n: number): boolean {
    // The palette's own ends: black on a dark surface, white on a light one.
    // Neither resolves through `palette256`, which only covers the cube.
    if (this.mode === "dark" && n === 0) return true;
    if (this.mode === "light" && (n === 7 || n === 15)) return true;
    const rgb = palette256(n);
    return rgb !== null && this.isBackgroundFill(rgb[0], rgb[1], rgb[2]);
  }

  /** The named background slot that means "same as the terminal": SGR 40 on a
   *  dark surface, SGR 47 on a light one. */
  private get namedFill(): string {
    return this.mode === "dark" ? "40" : "47";
  }

  private rewriteParams(params: string): string | null {
    const parts = params.split(";");
    const out: string[] = [];
    let changed = false;

    for (let i = 0; i < parts.length; i++) {
      const token = parts[i];

      if (token === "48") {
        const mode = parts[i + 1];
        if (mode === "2" && i + 4 < parts.length) {
          const r = Number(parts[i + 2]);
          const g = Number(parts[i + 3]);
          const b = Number(parts[i + 4]);
          if (this.isBackgroundFill(r, g, b)) {
            out.push("49");
            changed = true;
          } else {
            out.push("48", "2", parts[i + 2], parts[i + 3], parts[i + 4]);
          }
          i += 4;
          continue;
        }
        if (mode === "5" && i + 2 < parts.length) {
          if (this.isIndexBackgroundFill(Number(parts[i + 2]))) {
            out.push("49");
            changed = true;
          } else {
            out.push("48", "5", parts[i + 2]);
          }
          i += 2;
          continue;
        }
        out.push(token);
        continue;
      }

      if (token === this.namedFill) {
        out.push("49");
        changed = true;
        continue;
      }

      out.push(token);
    }

    return changed ? out.join(";") : null;
  }
}

/**
 * Where an incomplete escape sequence begins, or `text.length` if the tail is
 * safe to emit. Without this a `ESC[48;2;0;0;0m` split across two PTY batches
 * would slip through unrewritten.
 */
function incompleteTail(text: string): number {
  const esc = text.lastIndexOf("\x1b");
  if (esc === -1) return text.length;
  const rest = text.slice(esc);
  // A finished CSI ends on a byte in @..~.
  if (/^\x1b\[[0-9;:?<>!]*[@-~]/.test(rest)) return text.length;
  // A CSI still accumulating its parameters, or a bare ESC.
  if (/^\x1b\[[0-9;:?<>!]*$/.test(rest) || rest.length === 1) return esc;
  // Anything else (OSC, charset selection…) — xterm's parser handles partials.
  return text.length;
}
