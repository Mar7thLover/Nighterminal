/**
 * Tabs and the panes inside them.
 *
 * A tab owns a layout tree; the workspace owns the tabs. Everything that used
 * to be "the active session" is now "the focused pane of the active tab" — the
 * one place that distinction leaks out is the status bar, which reports the
 * focused pane.
 */

import { config } from "./config";
import {
  isLayoutShape,
  leaf,
  neighbour,
  paneCount,
  removeAt,
  renderLayout,
  serializeLayout,
  sessionsOf,
  splitAt,
  swapLeaves,
  type Direction,
  type LayoutNode,
  type LayoutShape,
  type Side,
} from "./layout";
import { Session } from "./session";

const RESIZE_DEBOUNCE_MS = 50;

export interface Tab {
  readonly key: string;
  readonly el: HTMLDivElement;
  root: LayoutNode;
  focused: Session;
}

export interface WorkspaceHooks {
  /** A pane's Terminal exists but is not mounted yet — the moment to install
   *  anything that has to be there before the first keystroke. */
  onPaneCreate(session: Session): void;
  onTabOpen(tab: Tab): void;
  onTabTitle(tab: Tab): void;
  onTabActivate(tab: Tab | null): void;
  /** A pane in this tab failed to launch (dead=true), or the last failed pane
   *  was closed and the tab is healthy again (dead=false). */
  onTabDead(tab: Tab, dead: boolean): void;
  onTabClose(tab: Tab): void;
  /** Focused pane changed, or its geometry did. */
  onFocus(session: Session | null): void;
  onGeometry(): void;
  onImmersive(): void;
  /** The last tab is gone — nothing left to show. */
  onEmpty(): void;
}

/** One tab as written to `state.json`. */
export interface TabShape {
  layout: LayoutShape;
}

export interface WorkspaceShape {
  tabs: TabShape[];
  active: number;
}

let nextTab = 1;

export class Workspace {
  private readonly tabs: Tab[] = [];
  private activeTab: Tab | null = null;

  /** One observer for every pane: layout, tab switch and window resize all
   *  arrive here, so there is a single place that decides to refit. */
  private readonly observer: ResizeObserver;
  private readonly owners = new Map<Element, Session>();
  private readonly dirty = new Set<Session>();
  private fitTimer: number | null = null;

  constructor(
    private readonly host: HTMLElement,
    private readonly hooks: WorkspaceHooks,
  ) {
    this.observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const session = this.owners.get(entry.target);
        if (session !== undefined) this.dirty.add(session);
      }
      this.scheduleFit();
    });
  }

  get current(): Tab | null {
    return this.activeTab;
  }

  /** The pane keystrokes and the status bar are talking about. */
  get focused(): Session | null {
    return this.activeTab?.focused ?? null;
  }

  get count(): number {
    return this.tabs.length;
  }

  find(key: string): Tab | undefined {
    return this.tabs.find((tab) => tab.key === key);
  }

  /** Panes in the active tab, for the status bar. */
  get paneCount(): number {
    return this.activeTab === null ? 0 : paneCount(this.activeTab.root);
  }

  // ------------------------------------------------------------------- tabs

  async open(shape?: TabShape): Promise<Tab> {
    const el = document.createElement("div");
    el.className = "layout";
    this.host.appendChild(el);

    const pending: { session: Session; restore?: LayoutShape }[] = [];
    const tab: Tab = {
      key: `t${nextTab++}`,
      el,
      // Placeholders; both are replaced before anything can observe them.
      root: null as unknown as LayoutNode,
      focused: null as unknown as Session,
    };

    const build = (node: LayoutShape): LayoutNode => {
      if (node.kind === "split") {
        return {
          kind: "split",
          dir: node.dir,
          ratio: Math.min(0.92, Math.max(0.08, node.ratio)),
          a: build(node.a),
          b: build(node.b),
        };
      }
      const session = this.createSession(tab);
      pending.push({ session, restore: node });
      return leaf(session);
    };

    const shell = config().shell;
    tab.root = build(
      shape?.layout ?? { kind: "leaf", shell, cwd: config().cwd },
    );
    tab.focused = sessionsOf(tab.root)[0];

    this.tabs.push(tab);
    renderLayout(tab.root, tab.el, { onResize: () => this.refit(tab) });
    for (const session of sessionsOf(tab.root)) this.watch(session);
    this.hooks.onTabOpen(tab);

    // Activate before starting: panes must be visible for `fit()` to measure a
    // real cell, which the initial PtySize depends on.
    this.activate(tab);
    await Promise.all(
      pending.map(async ({ session, restore }) => {
        session.mount();
        const from = restore?.kind === "leaf" ? restore : undefined;
        await session.start({
          shell: from?.shell ?? shell,
          args: from?.args ?? null,
          cwd: from?.cwd ?? config().cwd,
        });
      }),
    );
    this.hooks.onGeometry();
    return tab;
  }

  activate(tab: Tab | null): void {
    if (tab !== null && !this.tabs.includes(tab)) return;
    this.activeTab = tab;
    for (const other of this.tabs) other.el.classList.toggle("off", other !== tab);
    if (tab !== null) {
      // Geometry may have gone stale while this tab was hidden.
      for (const session of sessionsOf(tab.root)) {
        session.el.classList.toggle("focused", session === tab.focused);
        session.fit();
      }
      tab.focused.focus();
    }
    this.hooks.onTabActivate(tab);
    this.hooks.onFocus(tab?.focused ?? null);
  }

  activateRelative(delta: number): void {
    if (this.tabs.length < 2 || this.activeTab === null) return;
    const at = this.tabs.indexOf(this.activeTab);
    this.activate(this.tabs[(at + delta + this.tabs.length) % this.tabs.length]);
  }

  activateIndex(index: number): void {
    const tab = this.tabs[index];
    if (tab !== undefined) this.activate(tab);
  }

  /** Match the strip's order after a drag, so Ctrl+Tab cycling, Ctrl+Alt+N and
   *  the snapshot all agree with what the eye sees. */
  reorderTabs(keys: string[]): void {
    const byKey = new Map(this.tabs.map((tab) => [tab.key, tab]));
    const next: Tab[] = [];
    for (const key of keys) {
      const tab = byKey.get(key);
      if (tab !== undefined) {
        next.push(tab);
        byKey.delete(key);
      }
    }
    // Anything the strip didn't mention (mid-close animation) keeps its place.
    next.push(...byKey.values());
    this.tabs.length = 0;
    this.tabs.push(...next);
  }

  closeTab(tab: Tab): void {
    const at = this.tabs.indexOf(tab);
    if (at === -1) return;
    this.tabs.splice(at, 1);
    for (const session of sessionsOf(tab.root)) this.forget(session);
    tab.el.remove();
    this.hooks.onTabClose(tab);

    if (this.tabs.length === 0) {
      this.activeTab = null;
      this.hooks.onTabActivate(null);
      this.hooks.onFocus(null);
      this.hooks.onEmpty();
      return;
    }
    if (this.activeTab === tab) {
      this.activate(this.tabs[Math.min(at, this.tabs.length - 1)]);
    }
  }

  // ------------------------------------------------------------------ panes

  /** Split the focused pane and hand the new one the focus. */
  async split(dir: Direction): Promise<void> {
    const tab = this.activeTab;
    if (tab === null) return;

    // Read the origin's directory before focus moves: a new pane opens where
    // you already are, which is what every terminal with splits does.
    const origin = tab.focused;
    const cwd = origin.cwd ?? config().cwd;

    const session = this.createSession(tab);
    tab.root = splitAt(tab.root, origin, dir, session);
    renderLayout(tab.root, tab.el, { onResize: () => this.refit(tab) });
    this.watch(session);
    // Existing panes just changed size; refit them along with the new one.
    this.refit(tab);

    session.mount();
    this.focus(session);
    await session.start({ shell: config().shell, cwd });
    this.hooks.onGeometry();
  }

  /** Close the focused pane, or the whole tab when it was the last one. */
  closeFocused(): void {
    const tab = this.activeTab;
    if (tab === null) return;
    this.closePane(tab, tab.focused);
  }

  private closePane(tab: Tab, session: Session): void {
    if (paneCount(tab.root) === 1) {
      this.closeTab(tab);
      return;
    }
    const survivors = sessionsOf(tab.root).filter((s) => s !== session);
    const next = removeAt(tab.root, session);
    if (next === null) {
      this.closeTab(tab);
      return;
    }
    tab.root = next;
    this.forget(session);
    renderLayout(tab.root, tab.el, { onResize: () => this.refit(tab) });
    if (tab.focused === session) this.focus(survivors[0]);
    this.refit(tab);
    this.hooks.onTabTitle(tab);
    // Closing the failed pane may have been the point — clear the red dot once
    // no dead-on-arrival pane is left in this tab.
    if (session.launchFailed) {
      this.hooks.onTabDead(tab, survivors.some((s) => s.launchFailed));
    }
  }

  focus(session: Session): void {
    const tab = this.activeTab;
    if (tab === null || !sessionsOf(tab.root).includes(session)) return;
    if (tab.focused !== session) {
      tab.focused.el.classList.remove("focused");
      tab.focused = session;
      this.hooks.onTabTitle(tab);
    }
    session.el.classList.add("focused");
    session.focus();
    this.hooks.onFocus(session);
    this.hooks.onImmersive();
  }

  /** Move focus to the nearest pane in a direction. */
  focusSide(side: Side): void {
    const tab = this.activeTab;
    if (tab === null) return;
    const next = neighbour(tab.root, tab.focused, side);
    if (next !== null) this.focus(next);
  }

  /** Swap the focused pane with its nearest neighbour in a direction. Focus
   *  travels with the pane, so repeated presses keep walking it along. */
  swapSide(side: Side): void {
    const tab = this.activeTab;
    if (tab === null) return;
    const other = neighbour(tab.root, tab.focused, side);
    if (other === null) return;
    if (!swapLeaves(tab.root, tab.focused, other)) return;
    renderLayout(tab.root, tab.el, { onResize: () => this.refit(tab) });
    // The two panes traded sizes; refit both (refit marks the whole tab).
    this.refit(tab);
    // Re-inserting elements into the DOM drops keyboard focus — hand it back.
    tab.focused.focus();
    this.hooks.onGeometry();
  }

  // --------------------------------------------------------------- plumbing

  private createSession(tab: Tab): Session {
    const session = new Session({
      // A background pane renaming itself must not relabel the tab; the tab
      // shows what the focused pane is doing.
      onTitle: (session) => {
        if (tab.focused === session) this.hooks.onTabTitle(tab);
      },
      onGeometry: () => this.hooks.onGeometry(),
      onImmersive: () => this.hooks.onImmersive(),
      onFocus: (session) => {
        if (this.activeTab === tab) this.focus(session);
      },
      onExit: (session) => {
        // A shell that never started stays on screen so its error can be read;
        // a normal `exit` closes its pane, the way any terminal behaves.
        if (session.launchFailed) {
          // Marked whichever tab it happened in — a background tab going red is
          // exactly how you find out something failed to start.
          this.hooks.onTabDead(tab, true);
          return;
        }
        this.closePane(tab, session);
      },
    });
    this.hooks.onPaneCreate(session);
    return session;
  }

  private watch(session: Session): void {
    this.owners.set(session.el, session);
    this.observer.observe(session.el);
  }

  private forget(session: Session): void {
    this.observer.unobserve(session.el);
    this.owners.delete(session.el);
    this.dirty.delete(session);
    session.dispose();
  }

  private refit(tab: Tab): void {
    for (const session of sessionsOf(tab.root)) this.dirty.add(session);
    this.scheduleFit();
  }

  private scheduleFit(): void {
    if (this.fitTimer !== null) clearTimeout(this.fitTimer);
    this.fitTimer = window.setTimeout(() => {
      this.fitTimer = null;
      const pending = [...this.dirty];
      this.dirty.clear();
      for (const session of pending) session.fit();
      this.hooks.onGeometry();
    }, RESIZE_DEBOUNCE_MS);
  }

  /** Push changed settings into every live terminal. */
  applySettings(): void {
    for (const tab of this.tabs) {
      for (const session of sessionsOf(tab.root)) session.applySettings(config());
    }
  }

  // ------------------------------------------------------------ persistence

  snapshot(): WorkspaceShape {
    return {
      tabs: this.tabs.map((tab) => ({ layout: serializeLayout(tab.root) })),
      active: this.activeTab === null ? 0 : this.tabs.indexOf(this.activeTab),
    };
  }

  /** Rebuild from a snapshot. Returns false when there was nothing usable. */
  async restore(shape: unknown): Promise<boolean> {
    const tabs = readShape(shape);
    if (tabs === null) return false;
    for (const tab of tabs.tabs) await this.open(tab);
    this.activateIndex(Math.min(Math.max(tabs.active, 0), this.tabs.length - 1));
    return this.tabs.length > 0;
  }
}

/** `state.json` is a plain file a user may have edited; validate before use. */
function readShape(value: unknown): WorkspaceShape | null {
  if (typeof value !== "object" || value === null) return null;
  const shape = value as Record<string, unknown>;
  if (!Array.isArray(shape.tabs) || shape.tabs.length === 0) return null;

  const tabs: TabShape[] = [];
  for (const entry of shape.tabs) {
    if (typeof entry !== "object" || entry === null) return null;
    const layout = (entry as Record<string, unknown>).layout;
    if (!isLayoutShape(layout)) return null;
    tabs.push({ layout });
  }
  return {
    tabs,
    active: typeof shape.active === "number" ? shape.active : 0,
  };
}
