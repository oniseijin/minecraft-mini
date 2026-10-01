/**
 * Shared snapshot-interpolation core (REFACTORING.md Phase 3): remotePlayer.ts
 * and mobs.ts both render entity avatars ~100 ms in the past — a small capped
 * sample buffer, position lerp + shortest-arc yaw interpolation between the
 * pair of samples surrounding render time, and a walk swing proportional to
 * the rendered horizontal speed. The math is single-sourced here; the per-
 * caller constants differ deliberately (players relay at 20 Hz, mobs at ~5 Hz;
 * each rig's swing is tuned separately) and arrive as named options.
 */

/** One buffered entity sample (server-relayed position + yaw at time `t`). */
export interface InterpSample {
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** Rendered this far behind the newest snapshot — smooths relay jitter. */
export const INTERP_DELAY_MS = 100;

export interface SampleBufferOptions {
  /** Drop samples older than `renderT - keepMs` (roster 20 Hz → 1000; mobs ~5 Hz → 1500). */
  keepMs: number;
  /** Hard cap regardless of age (24 player frames / 16 mob frames). */
  keepCount: number;
}

/** Interpolated pose at one render time. */
export interface InterpPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export interface SampleBuffer {
  push(sample: InterpSample): void;
  /**
   * Prunes expired samples, then interpolates the pose at `renderT` — clamped
   * at both ends of the buffer. null while empty (a freshly created avatar
   * holds its spawn pose until the first sample arrives).
   */
  at(renderT: number): InterpPose | null;
}

function shortestArc(from: number, to: number): number {
  return ((((to - from) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
}

export function createSampleBuffer(options: SampleBufferOptions): SampleBuffer {
  const samples: InterpSample[] = [];

  return {
    push(sample) {
      samples.push(sample);
      if (samples.length > options.keepCount) samples.splice(0, samples.length - options.keepCount);
    },
    at(renderT) {
      while (samples.length > 2 && samples[1].t < renderT - options.keepMs) samples.shift();

      if (samples.length === 0) return null;

      // Find the pair surrounding renderT (or clamp at both ends).
      let i = samples.length - 1;
      while (i > 0 && samples[i].t > renderT) i--;
      const a = samples[i];
      const b = samples[Math.min(i + 1, samples.length - 1)];
      const span = b.t - a.t;
      const alpha = span > 0 ? Math.max(0, Math.min(1, (renderT - a.t) / span)) : 1;
      return {
        x: a.x + (b.x - a.x) * alpha,
        y: a.y + (b.y - a.y) * alpha,
        z: a.z + (b.z - a.z) * alpha,
        yaw: a.yaw + shortestArc(a.yaw, b.yaw) * alpha,
      };
    },
  };
}

export interface WalkSwingOptions {
  /** Swing amplitude (radians) at full speed. */
  maxAmplitude: number;
  /** Horizontal speed (m/s) that reaches full amplitude. */
  speedRef: number;
}

export interface WalkSwing {
  /**
   * Feeds the rendered position; returns the current swing (radians). The
   * speed is measured from the rendered motion (not the snapshot stream), the
   * amplitude eases toward its speed-scaled target, and the phase advances
   * with distance.
   */
  update(x: number, z: number, dt: number): number;
  /** The speed measured by the last update (m/s) — mobs' idle neck sway reads it. */
  readonly speed: number;
}

export function createWalkSwing(startX: number, startZ: number, options: WalkSwingOptions): WalkSwing {
  let lastX = startX;
  let lastZ = startZ;
  let swingPhase = 0;
  let swingAmp = 0;
  let speed = 0;

  return {
    get speed() {
      return speed;
    },
    update(x, z, dt) {
      speed = dt > 0 ? Math.hypot(x - lastX, z - lastZ) / dt : 0;
      lastX = x;
      lastZ = z;
      const targetAmp = Math.min(speed / options.speedRef, 1) * options.maxAmplitude;
      swingAmp += (targetAmp - swingAmp) * Math.min(1, 10 * dt);
      swingPhase += speed * dt * 2.2 * Math.PI;
      return Math.sin(swingPhase) * swingAmp;
    },
  };
}
