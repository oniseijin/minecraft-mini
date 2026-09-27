/**
 * Per-player identity helpers shared by nameplates, chat and the Tab player
 * list: one stable color per server player id (hash → hue), used everywhere a
 * player is named so "who is that" is answerable at a glance. Client-side
 * only — no protocol changes.
 */

/** A remote avatar that hasn't moved for this long is marked AFK. */
export const AFK_AFTER_MS = 45_000;

/** Stable per-player color: 32-bit id hash → hue (readable on sky and blocks). */
export function playerColor(id: number): string {
  const hue = Math.abs(Math.imul(id ^ 0x9e3779b1, 0x85ebca6b)) % 360;
  return `hsl(${hue}, 85%, 72%)`;
}

/** Fallback for contexts that only have a name (chat senders before the roster resolves). */
export function nameColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193) >>> 0;
  return `hsl(${h % 360}, 85%, 72%)`;
}
