/**
 * Cosmetic day-night cycle (~10 real minutes): the sun orbits the island while
 * light color/intensity, hemisphere intensity and the sky/fog color lerp
 * between full day, warm sunrise/sunset and cool night. Gameplay-neutral and
 * always playable — the ambient floor never drops to pitch black.
 *
 * Time of day: 0 sunrise · 0.25 noon · 0.5 sunset · 0.75 midnight.
 *
 * M5.4: the phase itself lives in the shared day clock (shared/src/dayclock.ts)
 * — the server broadcasts its dayT inside every `mobs` snapshot and the client
 * re-anchors via `setPhase`, so every tab sees the same sky and the zombies'
 * night band matches what's on screen. Offline (no snapshots yet) the local
 * clock starting at the same mid-morning phase is indistinguishable from the
 * old behavior.
 */

import * as THREE from 'three';
import { DAY_LENGTH_MS, DAY_PHASE_START } from '@mc/shared';

const DAY_LENGTH_S = DAY_LENGTH_MS / 1000; // one shared source of truth for the cycle length

const DAY_SKY = 0x87ceeb;
const NIGHT_SKY = 0x0b1d3a;
const HORIZON_TINT = 0xff9a4d; // sunrise/sunset glow blended into the sky

const DAY_SUN_INTENSITY = 1.8;
const NIGHT_LIGHT_INTENSITY = 0.18; // moonlight — keeps the world readable
const DAY_HEMI_INTENSITY = 1.1;
const NIGHT_HEMI_INTENSITY = 0.32; // ambient floor at night

export interface DayNightOptions {
  sun: THREE.DirectionalLight;
  hemisphere: THREE.HemisphereLight;
  setSkyColor(hex: number): void;
  /** Starting time of day in [0, 1). Defaults to mid-morning. */
  start?: number;
}

export interface DayNight {
  /** Advance the cycle. `dt` in seconds. */
  update(dt: number): void;
  timeOfDay(): number;
  /**
   * Re-anchor the phase to the server's day clock (a `mobs` snapshot's dayT,
   * extrapolated by the caller to "now"). Keeps drifting impossible: the next
   * `update` advances from the anchored phase.
   */
  setPhase(t: number): void;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** Smoothstep over [0, 1] — plateau at both ends, soft transition between. */
function smooth01(x: number): number {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function createDayNight(options: DayNightOptions): DayNight {
  const { sun, hemisphere, setSkyColor } = options;
  let t = options.start ?? DAY_PHASE_START; // begin mid-morning: a full day of light ahead

  const daySky = new THREE.Color(DAY_SKY);
  const nightSky = new THREE.Color(NIGHT_SKY);
  const horizonTint = new THREE.Color(HORIZON_TINT);
  const sky = new THREE.Color();
  const warmSun = new THREE.Color(0xffd9a0);
  const whiteSun = new THREE.Color(0xfff6e8);
  const moonColor = new THREE.Color(0x93b8ff);
  const sunDir = new THREE.Vector3();

  function update(dt: number): void {
    t = (t + dt / DAY_LENGTH_S) % 1;
    const angle = t * Math.PI * 2;
    const elevation = Math.sin(angle); // > 0 day, < 0 night

    // Sun orbit; tilted toward +Z so the light is never axis-aligned.
    sunDir.set(Math.cos(angle), elevation, 0.35).normalize();

    // Sky/hemisphere wake slightly before the sun, so dawn glows early.
    const skyDay = smooth01((elevation + 0.1) / 0.2);
    // Sun intensity stays at its night floor until the disc is actually up,
    // so the switch to moon direction at the horizon is invisible.
    const sunDay = smooth01(elevation / 0.25);

    // Warm glow while the sun sits near the horizon.
    const horizon = clamp01(1 - Math.abs(elevation) / 0.22);
    sky.copy(nightSky).lerp(daySky, skyDay).lerp(horizonTint, horizon * 0.45 * skyDay);
    setSkyColor(sky.getHex());

    hemisphere.intensity = lerp(NIGHT_HEMI_INTENSITY, DAY_HEMI_INTENSITY, skyDay);

    if (elevation > -0.02) {
      sun.position.copy(sunDir).multiplyScalar(100);
      sun.color.copy(warmSun).lerp(whiteSun, clamp01(elevation * 3));
      sun.intensity = lerp(NIGHT_LIGHT_INTENSITY, DAY_SUN_INTENSITY, sunDay);
    } else {
      // Night: the same light plays moon, mirrored across the horizon.
      sun.position.copy(sunDir).multiplyScalar(-100);
      sun.color.copy(moonColor);
      sun.intensity = NIGHT_LIGHT_INTENSITY;
    }
  }

  return {
    update,
    timeOfDay: () => t,
    setPhase(next: number): void {
      t = ((next % 1) + 1) % 1;
    },
  };
}
