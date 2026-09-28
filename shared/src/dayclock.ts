/**
 * Shared day-night clock (M5.4) — the single source of truth for the sandbox's
 * time of day, used by the cosmetic client sky (client/src/daynight.ts) and by
 * the server's zombie gating (night-only spawns, dawn burn).
 *
 * `dayPhase(elapsedMs)` maps "ms since the clock's epoch" to a phase in [0, 1):
 * 0 sunrise · 0.25 noon · 0.5 sunset · 0.75 midnight. The phase starts at
 * DAY_PHASE_START (mid-morning) so a freshly booted server greets players with
 * the same bright sky the client-only clock always began with, then both sides
 * advance through the same 10-minute cycle — the server's mobs snapshot carries
 * its dayT so clients re-anchor to it (protocol v8).
 */

/** One full day-night cycle: 10 real minutes (was client-only before M5.4). */
export const DAY_LENGTH_MS = 600_000;

/** Phase at elapsedMs = 0: mid-morning, "a full day of light ahead". */
export const DAY_PHASE_START = 0.1;

/**
 * The night band, in dayT. The sun sets at 0.5 and rises at 1.0/0.0; the sky
 * is visually dark by ~0.52 and the dawn glow starts ~0.985, so zombies roam
 * the clearly-dark stretch [0.55, 0.98) — dusk well underway until first light.
 */
export const NIGHT_START_DAY_T = 0.55;
export const NIGHT_END_DAY_T = 0.98;

/** Day-night phase for `elapsedMs` since the clock epoch, in [0, 1). */
export function dayPhase(elapsedMs: number): number {
  return (((DAY_PHASE_START + elapsedMs / DAY_LENGTH_MS) % 1) + 1) % 1;
}

/** True while zombies may spawn (and burn the moment this turns false). */
export function isNightDayT(dayT: number): boolean {
  return dayT >= NIGHT_START_DAY_T && dayT < NIGHT_END_DAY_T;
}
