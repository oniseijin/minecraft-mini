/**
 * Debug overlay (F3-style): FPS + position, facing chunk, chunk counts,
 * draw calls and the targeted block. The whole readout refreshes ~4×/s.
 */

const UPDATE_MS = 250; // ~4 updates per second

export interface DebugInfo {
  x: number;
  y: number;
  z: number;
  chunkX: number;
  chunkZ: number;
  chunksLoaded: number;
  chunksVisible: number;
  drawCalls: number;
  /** e.g. "grass (128, 40, 127)", empty when nothing is targeted. */
  target: string;
}

export interface DebugOverlay {
  /** Call once per animation frame with the frame timestamp. */
  tick(now: number): void;
  setInfo(info: DebugInfo): void;
}

export function createDebugOverlay(target: HTMLElement): DebugOverlay {
  let frames = 0;
  let windowStart = performance.now();
  let info: DebugInfo | null = null;

  function render(fps: number): void {
    const lines = [`FPS: ${fps}`];
    if (info) {
      lines.push(
        `XYZ: ${info.x.toFixed(1)} / ${info.y.toFixed(1)} / ${info.z.toFixed(1)}`,
        `Chunk: ${info.chunkX}, ${info.chunkZ}`,
        `Chunks: ${info.chunksVisible} visible / ${info.chunksLoaded} loaded`,
        `Draw calls: ${info.drawCalls}`,
        `Target: ${info.target || '—'}`,
      );
    }
    target.textContent = lines.join('\n');
  }

  return {
    setInfo(next: DebugInfo) {
      info = next;
    },
    tick(now: number) {
      frames += 1;
      const elapsed = now - windowStart;
      if (elapsed < UPDATE_MS) return;
      const fps = Math.round((frames * 1000) / elapsed);
      frames = 0;
      windowStart = now;
      render(fps);
    },
  };
}
