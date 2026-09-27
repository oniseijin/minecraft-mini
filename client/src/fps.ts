/** Update interval for the FPS readout. */
const UPDATE_MS = 500;

export interface FpsCounter {
  /** Call once per animation frame with the frame timestamp. */
  tick(now: number): void;
}

/**
 * Frames-per-second counter that refreshes `target` twice a second.
 * `target`'s initial content acts as the placeholder before the first tick.
 */
export function createFpsCounter(target: HTMLElement): FpsCounter {
  let frames = 0;
  let windowStart = performance.now();

  return {
    tick(now: number) {
      frames += 1;
      const elapsed = now - windowStart;
      if (elapsed >= UPDATE_MS) {
        target.textContent = `FPS: ${Math.round((frames * 1000) / elapsed)}`;
        frames = 0;
        windowStart = now;
      }
    },
  };
}
