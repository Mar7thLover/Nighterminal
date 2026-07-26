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
 * near-*neutral* darks are touched, so deliberate colour fills survive: a blue
 * selection band (`48;2;38;79;120`) or a dark red error strip still render.
 *
 * Colon-separated SGR (`48:2::r:g:b`) is left alone — it is rare, and passing
 * it through unchanged is the safe failure mode.
 */

/** A fill this dark on every channel is standing in for the terminal bg. */
const MAX_CHANNEL = 42;
/** ...and this close to neutral. Keeps saturated dark fills intact. */
const MAX_SPREAD = 18;
/** Never stall the stream waiting for an escape that will not arrive. */
const MAX_CARRY = 64;

const SGR = /\x1b\[([0-9;:]*)m/g;

function isBackgroundFill(r: number, g: number, b: number): boolean {
  const hi = Math.max(r, g, b);
  const lo = Math.min(r, g, b);
  return hi <= MAX_CHANNEL && hi - lo <= MAX_SPREAD;
}

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

function isIndexBackgroundFill(n: number): boolean {
  // Index 0 is ANSI black, which the theme renders as a near-black navy.
  if (n === 0) return true;
  const rgb = palette256(n);
  return rgb !== null && isBackgroundFill(rgb[0], rgb[1], rgb[2]);
}

function rewriteParams(params: string): string | null {
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
        if (isBackgroundFill(r, g, b)) {
          out.push("49");
          changed = true;
        } else {
          out.push("48", "2", parts[i + 2], parts[i + 3], parts[i + 4]);
        }
        i += 4;
        continue;
      }
      if (mode === "5" && i + 2 < parts.length) {
        if (isIndexBackgroundFill(Number(parts[i + 2]))) {
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

    // SGR 40 — ANSI black background.
    if (token === "40") {
      out.push("49");
      changed = true;
      continue;
    }

    out.push(token);
  }

  return changed ? out.join(";") : null;
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

export class BackgroundFlattener {
  private carry = "";

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
      const rewritten = rewriteParams(params);
      return rewritten === null ? whole : `\x1b[${rewritten}m`;
    });
  }
}
