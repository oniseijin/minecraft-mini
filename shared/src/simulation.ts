/**
 * Single source of truth for cross-boundary simulation numbers (DESIGN.md
 * §3.1 movement, §3.3 combat, §3.4 party power-ups): every constant here is
 * consumed on BOTH sides of the client/server boundary, so it lives here and
 * nowhere else. Identical values are one constant; deliberate client/server
 * differences are NAMED PAIRS whose names + comments state the difference and
 * why — never unify a pair's values. Changing a value here changes both
 * sides at once (byte-identical behavior is the refactor contract; smoke
 * physics asserts player movement to ±0.01).
 */

// --- gravity + jumping (§3.1) -------------------------------------------------

/** Downward acceleration, m/s² — client player physics and every server walker. */
export const GRAVITY = 30;

/**
 * Jump take-off speeds — a deliberate CLIENT/SERVER PAIR, currently accepted:
 * the client's 9 gives the player a ≈1.35-block apex (feel), while every
 * server-side entity (test bot, mobs) hops with 8.4, the minimum that clears
 * a 1-block ledge (v²/2g ≈ 1.18). The divergence is intentional and visible
 * here on purpose — do not "fix" either side without a design decision.
 */
/** Client player jump: ≈ 1.35-block jump apex. */
export const JUMP_SPEED_PLAYER = 9;
/** Server entity hop (bot.ts + mobs.ts): clears 1 block (v²/2g ≈ 1.18). */
export const JUMP_SPEED_ENTITY = 8.4;

/** Client camera height above the feet (also the water head-check height). */
export const EYE_HEIGHT = 1.62;

/**
 * Client sandbox void plane: feet below this → respawn at the spawn point
 * (client/player.ts warp — NOT a death). Cross-reference: the server's match
 * kill plane is VOID_KILL_Y = 8 in shared/src/arena.ts — different semantics,
 * deliberately different value.
 */
export const VOID_Y = -10;

// --- Block Party power-ups (§3.4.3) ---------------------------------------------
// Speed ×1.4 for 5 s, Jump Boost raises the jump velocity to 13 (≈2.6-block
// apex). The server sends absolute expiry epoch ms; the owning client applies
// the multipliers locally while `Date.now() < until`.

/** Speed power-up multiplier on walk + sprint speed (client-applied). */
export const SPEED_EFFECT_MULTIPLIER = 1.4;
/** Jump Boost power-up: replaces the player jump velocity (≈2.6-block apex). */
export const JUMP_EFFECT_SPEED = 13;
/** Speed / Jump Boost duration in ms (server tracks expiry, client renders the bar). */
export const EFFECT_DURATION_MS = 5000;

// --- combat (§3.3) ----------------------------------------------------------------

/** Melee swing cooldown, ms — server-side rate limit on every attack path. */
export const ATTACK_COOLDOWN_MS = 500;

/**
 * Melee reach — a deliberate CLIENT/SERVER PAIR: the client gates the swing
 * at 3.5 blocks (nearest remote-player AABB, before any block), while the
 * server validates at 4.5 — lenient by 1.0 to absorb position-report latency
 * (20 Hz relay) so honest hits never bounce.
 */
/** Client melee gate before block hits (client/src/main.ts). */
export const ATTACK_REACH_CLIENT = 3.5;
/** Server attack validation (match.ts player-vs-player + mobs.ts punches). */
export const ATTACK_RANGE_SERVER = 4.5;

/**
 * Player target AABB for hits (§3.3 melee ray + the v10 arrow's per-tick
 * segment-vs-AABB): consumed on BOTH sides — client/src/combat.ts re-exports
 * these (melee targeting), server/src/bedwars.ts builds arrow hitboxes from
 * them. One box, one home.
 */
export const TARGET_HALF_WIDTH = 0.35;
export const TARGET_HEIGHT = 1.85;

/**
 * Edit reach — a deliberate CLIENT/SERVER PAIR: the client raycasts edits at
 * 5 blocks, the server validates placements/breaks up to 8 — generous so
 * latency + interpolation never reject a visible edit.
 */
/** Client edit raycast length, blocks (client/src/main.ts). */
export const EDIT_REACH_CLIENT = 5;
/** Server-side reach limit for edits (server/src/index.ts, sandbox + matches). */
export const EDIT_REACH_SERVER = 8;
