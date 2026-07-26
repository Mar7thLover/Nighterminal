/**
 * Tab strip. The active-tab highlight is one travelling pill (`#tab-indicator`)
 * rather than a background on each tab — a single element sliding between
 * positions reads much smoother than N elements cross-fading.
 */

export interface TabBarHost {
  onSelect(key: string): void;
  onClose(key: string): void;
}

const CLOSE_ANIM_MS = 170;

const CLOSE_ICON =
  '<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">' +
  '<path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.4" ' +
  'stroke-linecap="round"/></svg>';

export class TabBar {
  private readonly tabs = new Map<string, HTMLDivElement>();
  private activeKey: string | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly indicator: HTMLElement,
    private readonly host: TabBarHost,
  ) {
    // The pill is positioned from layout, so it has to be recomputed whenever
    // the strip reflows (window resize, tabs shrinking to fit).
    new ResizeObserver(() => this.moveIndicator(false)).observe(this.root);
  }

  add(key: string, label: string): void {
    const tab = document.createElement("div");
    tab.className = "tab";
    tab.dataset.key = key;
    tab.setAttribute("role", "tab");

    const dot = document.createElement("span");
    dot.className = "dot";

    const text = document.createElement("span");
    text.className = "label";
    text.textContent = label;

    const close = document.createElement("button");
    close.className = "close";
    close.title = "关闭标签页 (Ctrl+Shift+W)";
    close.setAttribute("aria-label", "关闭标签页");
    close.innerHTML = CLOSE_ICON;

    tab.append(dot, text, close);
    this.root.appendChild(tab);
    this.tabs.set(key, tab);

    tab.addEventListener("mousedown", (event) => {
      if (event.button === 1) {
        // Middle-click closes, as everywhere else with tabs.
        event.preventDefault();
        this.host.onClose(key);
      } else if (event.button === 0 && event.target !== close) {
        this.host.onSelect(key);
      }
    });
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      this.host.onClose(key);
    });
  }

  setLabel(key: string, label: string): void {
    const text = this.tabs.get(key)?.querySelector(".label");
    if (text !== null && text !== undefined) text.textContent = label;
  }

  setDead(key: string, dead: boolean): void {
    this.tabs.get(key)?.classList.toggle("dead", dead);
  }

  select(key: string | null): void {
    this.activeKey = key;
    for (const [id, tab] of this.tabs) tab.classList.toggle("active", id === key);
    this.moveIndicator(true);
  }

  remove(key: string): void {
    const tab = this.tabs.get(key);
    if (tab === undefined) return;
    this.tabs.delete(key);

    // Pin its current offset, then take it out of flow so the surviving tabs
    // reflow at once and the pill only has to travel once.
    tab.style.left = `${tab.offsetLeft}px`;
    tab.style.width = `${tab.offsetWidth}px`;
    tab.classList.add("closing");
    window.setTimeout(() => tab.remove(), CLOSE_ANIM_MS);
    this.moveIndicator(true);
  }

  private moveIndicator(animate: boolean): void {
    const tab =
      this.activeKey === null ? undefined : this.tabs.get(this.activeKey);
    if (tab === undefined) {
      this.indicator.style.opacity = "0";
      return;
    }
    if (!animate) this.indicator.style.transition = "none";
    this.indicator.style.opacity = "1";
    this.indicator.style.width = `${tab.offsetWidth}px`;
    this.indicator.style.transform = `translate3d(${tab.offsetLeft}px, -50%, 0)`;
    if (!animate) {
      // Force a reflow so the suppressed transition can't leak into the next
      // style change.
      void this.indicator.offsetWidth;
      this.indicator.style.transition = "";
    }
  }
}
