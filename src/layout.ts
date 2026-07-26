/**
 * Split layout: a binary tree of panes, one tree per tab.
 *
 * Sizing is done with `flex-grow` rather than percentages so a split always
 * fills its container exactly, at any window size, with no arithmetic of our
 * own — the divider only has to rewrite two numbers.
 */

import type { Session } from "./session";

export type Direction = "row" | "col";

export interface Leaf {
  kind: "leaf";
  session: Session;
}

export interface Split {
  kind: "split";
  dir: Direction;
  /** Share of the container taken by `a`, 0…1. */
  ratio: number;
  a: LayoutNode;
  b: LayoutNode;
}

export type LayoutNode = Leaf | Split;

/** Below this a pane has no usable grid left. */
const MIN_RATIO = 0.08;
const SPLITTER_PX = 5;

export function leaf(session: Session): Leaf {
  return { kind: "leaf", session };
}

export function sessionsOf(node: LayoutNode): Session[] {
  return node.kind === "leaf"
    ? [node.session]
    : [...sessionsOf(node.a), ...sessionsOf(node.b)];
}

export function paneCount(node: LayoutNode): number {
  return node.kind === "leaf" ? 1 : paneCount(node.a) + paneCount(node.b);
}

/**
 * Replace the leaf holding `session` with a split of it and `next`. Returns the
 * new root — which differs from the old one only when the split happened at the
 * top of the tree.
 */
export function splitAt(
  root: LayoutNode,
  session: Session,
  dir: Direction,
  next: Session,
): LayoutNode {
  const replacement: Split = {
    kind: "split",
    dir,
    ratio: 0.5,
    a: leaf(session),
    b: leaf(next),
  };
  return replaceLeaf(root, session, replacement) ?? root;
}

/**
 * Drop the pane holding `session`; its sibling takes over the space. Returns
 * the new root, or null when that pane was the last one in the tree.
 */
export function removeAt(root: LayoutNode, session: Session): LayoutNode | null {
  const result = without(root, session);
  // `undefined` means the session wasn't in this tree at all.
  return result === undefined ? root : result;
}

/**
 * Returns what `node` becomes once `session` is gone: a subtree, `null` when
 * the node itself was that pane, or `undefined` when the pane isn't in here.
 * A split can never return `null` — removing one of its two children always
 * leaves the other standing.
 */
function without(
  node: LayoutNode,
  session: Session,
): LayoutNode | null | undefined {
  if (node.kind === "leaf") {
    return node.session === session ? null : undefined;
  }
  const a = without(node.a, session);
  if (a !== undefined) {
    if (a === null) return node.b;
    node.a = a;
    return node;
  }
  const b = without(node.b, session);
  if (b !== undefined) {
    if (b === null) return node.a;
    node.b = b;
    return node;
  }
  return undefined;
}

function replaceLeaf(
  node: LayoutNode,
  session: Session,
  replacement: LayoutNode,
): LayoutNode | null {
  if (node.kind === "leaf") {
    return node.session === session ? replacement : null;
  }
  for (const side of ["a", "b"] as const) {
    const swapped = replaceLeaf(node[side], session, replacement);
    if (swapped !== null) {
      node[side] = swapped;
      return node;
    }
  }
  return null;
}

// ------------------------------------------------------------------ rendering

export interface LayoutHost {
  /** A divider was dragged; panes need refitting. */
  onResize(): void;
}

/**
 * Rebuild `container` from the tree. Pane elements are moved rather than
 * recreated, so terminals keep their scrollback across a re-layout.
 */
export function renderLayout(
  root: LayoutNode,
  container: HTMLElement,
  host: LayoutHost,
): void {
  container.replaceChildren(build(root, host));
}

function build(node: LayoutNode, host: LayoutHost): HTMLElement {
  if (node.kind === "leaf") {
    node.session.el.style.flex = "1 1 0";
    return node.session.el;
  }

  const box = document.createElement("div");
  box.className = `split ${node.dir}`;

  const a = build(node.a, host);
  const b = build(node.b, host);
  applyRatio(node, a, b);

  const divider = document.createElement("div");
  divider.className = "splitter";
  divider.addEventListener("pointerdown", (event) =>
    startDrag(event, node, box, a, b, host),
  );

  box.append(a, divider, b);
  return box;
}

function applyRatio(node: Split, a: HTMLElement, b: HTMLElement): void {
  a.style.flex = `${node.ratio} 1 0`;
  b.style.flex = `${1 - node.ratio} 1 0`;
}

function startDrag(
  event: PointerEvent,
  node: Split,
  box: HTMLElement,
  a: HTMLElement,
  b: HTMLElement,
  host: LayoutHost,
): void {
  event.preventDefault();
  const divider = event.currentTarget as HTMLElement;
  divider.setPointerCapture(event.pointerId);
  divider.classList.add("dragging");
  document.documentElement.classList.add(
    node.dir === "row" ? "resizing-x" : "resizing-y",
  );

  const move = (move: PointerEvent): void => {
    const box_ = box.getBoundingClientRect();
    // The divider occupies real space, so the usable span is short by its size;
    // ignoring that makes the pane drift away from the pointer.
    const span =
      (node.dir === "row" ? box_.width : box_.height) - SPLITTER_PX;
    if (span <= 0) return;
    const offset =
      node.dir === "row" ? move.clientX - box_.left : move.clientY - box_.top;
    node.ratio = Math.min(
      1 - MIN_RATIO,
      Math.max(MIN_RATIO, (offset - SPLITTER_PX / 2) / span),
    );
    applyRatio(node, a, b);
  };

  const end = (): void => {
    divider.removeEventListener("pointermove", move);
    divider.removeEventListener("pointerup", end);
    divider.removeEventListener("pointercancel", end);
    divider.classList.remove("dragging");
    document.documentElement.classList.remove("resizing-x", "resizing-y");
    host.onResize();
  };

  divider.addEventListener("pointermove", move);
  divider.addEventListener("pointerup", end);
  divider.addEventListener("pointercancel", end);
}

// ----------------------------------------------------------------- navigation

export type Side = "left" | "right" | "up" | "down";

/**
 * Nearest pane in a direction, chosen geometrically rather than by walking the
 * tree: with nested splits the tree neighbour is often not the one under the
 * user's eyes.
 */
export function neighbour(
  root: LayoutNode,
  from: Session,
  side: Side,
): Session | null {
  const origin = centre(from.el);
  let best: Session | null = null;
  let bestScore = Infinity;

  for (const session of sessionsOf(root)) {
    if (session === from) continue;
    const point = centre(session.el);
    const dx = point.x - origin.x;
    const dy = point.y - origin.y;
    const along =
      side === "left" ? -dx : side === "right" ? dx : side === "up" ? -dy : dy;
    if (along <= 1) continue; // not on that side at all
    // Distance along the direction of travel dominates; drift across it only
    // breaks ties between panes in the same column or row.
    const across = side === "left" || side === "right" ? Math.abs(dy) : Math.abs(dx);
    const score = along + across * 2;
    if (score < bestScore) {
      bestScore = score;
      best = session;
    }
  }
  return best;
}

function centre(el: HTMLElement): { x: number; y: number } {
  const box = el.getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
}

// -------------------------------------------------------------- serialisation

/** Tree shape without the live sessions, for `state.json`. */
export type LayoutShape =
  | { kind: "leaf"; shell: string | null; cwd: string | null }
  | { kind: "split"; dir: Direction; ratio: number; a: LayoutShape; b: LayoutShape };

export function serializeLayout(node: LayoutNode): LayoutShape {
  if (node.kind === "leaf") {
    const snapshot = node.session.snapshot();
    return { kind: "leaf", shell: snapshot.shell, cwd: snapshot.cwd };
  }
  return {
    kind: "split",
    dir: node.dir,
    ratio: node.ratio,
    a: serializeLayout(node.a),
    b: serializeLayout(node.b),
  };
}

/**
 * Structural check for a snapshot read back off disk — it may have been
 * hand-edited, or written by an older build.
 */
export function isLayoutShape(value: unknown): value is LayoutShape {
  if (typeof value !== "object" || value === null) return false;
  const node = value as Record<string, unknown>;
  if (node.kind === "leaf") return true;
  if (node.kind !== "split") return false;
  return (
    (node.dir === "row" || node.dir === "col") &&
    typeof node.ratio === "number" &&
    isLayoutShape(node.a) &&
    isLayoutShape(node.b)
  );
}
