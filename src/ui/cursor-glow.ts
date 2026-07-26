import type { Terminal } from "@xterm/xterm";
import type { Session } from "../session";

/**
 * Neon bloom that follows the block cursor.
 *
 * xterm's WebGL renderer can't emit a glow, so the effect lives in two DOM
 * layers stacked above the canvas: a tight core that snaps to the cell, and a
 * wide halo on a slower transition. The lag between them is what reads as a
 * trail when the cursor jumps across a line.
 */

/** Halo size as a multiple of the cell it surrounds. */
const HALO_SCALE_X = 3.2;
const HALO_SCALE_Y = 2.3;

interface Cell {
  w: number;
  h: number;
}

/**
 * Cell metrics come from xterm's render service, which is private API — hence
 * the guarded lookup and the layout-derived fallback. This is the only place
 * that reaches inside the Terminal, so an xterm upgrade only breaks here.
 */
function cellSize(term: Terminal): Cell {
  const probe = term as unknown as {
    _core?: {
      _renderService?: {
        dimensions?: { css?: { cell?: { width: number; height: number } } };
      };
    };
  };
  const cell = probe._core?._renderService?.dimensions?.css?.cell;
  if (cell !== undefined && cell.width > 0 && cell.height > 0) {
    return { w: cell.width, h: cell.height };
  }
  const screen = screenOf(term);
  if (screen !== null && term.cols > 0 && term.rows > 0) {
    return { w: screen.clientWidth / term.cols, h: screen.clientHeight / term.rows };
  }
  return { w: 9, h: 18 };
}

function screenOf(term: Terminal): HTMLElement | null {
  return term.element?.querySelector<HTMLElement>(".xterm-screen") ?? null;
}

export class CursorGlow {
  private session: Session | null = null;
  private detach: (() => void)[] = [];
  private frame = 0;

  constructor(
    private readonly stage: HTMLElement,
    private readonly core: HTMLElement,
    private readonly halo: HTMLElement,
  ) {}

  follow(session: Session | null): void {
    for (const off of this.detach) off();
    this.detach = [];
    this.session = session;

    if (session === null) {
      this.hide();
      return;
    }

    const term = session.term;
    const render = term.onRender(() => this.schedule());
    const move = term.onCursorMove(() => this.schedule());
    this.detach.push(() => render.dispose(), () => move.dispose());

    const textarea = term.textarea;
    if (textarea !== undefined) {
      const onFocus = (): void => this.schedule();
      const onBlur = (): void => this.hide();
      textarea.addEventListener("focus", onFocus);
      textarea.addEventListener("blur", onBlur);
      this.detach.push(() => {
        textarea.removeEventListener("focus", onFocus);
        textarea.removeEventListener("blur", onBlur);
      });
    }

    this.schedule();
  }

  /** Re-place the bloom after a layout change (resize, tab switch). */
  refresh(): void {
    this.schedule();
  }

  private schedule(): void {
    if (this.frame !== 0) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.place();
    });
  }

  private place(): void {
    const session = this.session;
    if (session === null || !session.alive) return this.hide();

    const term = session.term;
    const screen = screenOf(term);
    if (screen === null || term.textarea !== document.activeElement) {
      return this.hide();
    }

    const buffer = term.buffer.active;
    // While scrolled back, cursorY still refers to the live viewport, so the
    // bloom would land on an unrelated row. Hide instead of lying.
    if (buffer.viewportY !== buffer.baseY) return this.hide();
    if (buffer.cursorY < 0 || buffer.cursorY >= term.rows) return this.hide();

    const { w, h } = cellSize(term);
    const screenBox = screen.getBoundingClientRect();
    const stageBox = this.stage.getBoundingClientRect();
    const x = screenBox.left - stageBox.left + buffer.cursorX * w;
    const y = screenBox.top - stageBox.top + buffer.cursorY * h;

    this.core.style.width = `${w}px`;
    this.core.style.height = `${h}px`;
    this.core.style.transform = `translate3d(${x}px, ${y}px, 0)`;

    const hw = w * HALO_SCALE_X;
    const hh = h * HALO_SCALE_Y;
    this.halo.style.width = `${hw}px`;
    this.halo.style.height = `${hh}px`;
    this.halo.style.transform =
      `translate3d(${x - (hw - w) / 2}px, ${y - (hh - h) / 2}px, 0)`;

    this.core.classList.add("on");
    this.halo.classList.add("on");
  }

  private hide(): void {
    this.core.classList.remove("on");
    this.halo.classList.remove("on");
  }
}
