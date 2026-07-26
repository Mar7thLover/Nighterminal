import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Window buttons and the maximised-state bookkeeping. Because the window is
 * undecorated, the CSS corner radius has to be dropped while maximised —
 * otherwise the rounded shell leaves gaps against the screen edges.
 */
export function wireWindowChrome(): void {
  const win = getCurrentWindow();

  for (const button of document.querySelectorAll<HTMLElement>("[data-win]")) {
    button.addEventListener("click", () => {
      switch (button.dataset.win) {
        case "minimize":
          void win.minimize();
          break;
        case "maximize":
          void win.toggleMaximize();
          break;
        case "close":
          void win.close();
          break;
      }
    });
  }

  // Double-clicking the drag strip maximises, matching every native title bar.
  document
    .querySelector(".drag-space")
    ?.addEventListener("dblclick", () => void win.toggleMaximize());

  const sync = async (): Promise<void> => {
    document.documentElement.classList.toggle(
      "maximized",
      await win.isMaximized(),
    );
  };
  void sync();
  void win.onResized(() => void sync());
}

export function revealWindow(): void {
  const win = getCurrentWindow();
  void win.show().then(() => win.setFocus());
}
