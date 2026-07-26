/** Minimum time the boot overlay stays up, so its animation can complete. */
const MIN_SHOW_MS = 700;
const FADE_MS = 500;

const started = performance.now();

/**
 * Dismisses the boot curtain once the first session is live *and* the scanline
 * has had time to finish — whichever takes longer.
 */
export async function dismissBoot(): Promise<void> {
  const overlay = document.getElementById("boot");
  if (overlay === null) return;

  const elapsed = performance.now() - started;
  if (elapsed < MIN_SHOW_MS) {
    await new Promise((done) => window.setTimeout(done, MIN_SHOW_MS - elapsed));
  }

  overlay.classList.add("done");
  window.setTimeout(() => overlay.remove(), FADE_MS);
}
