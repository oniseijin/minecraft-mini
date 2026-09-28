/**
 * Server-entity locomotion (REFACTORING.md 2d): the walker primitives the
 * test bot (bot.ts) and the mob manager (mobs.ts) each used to carry their
 * own near-identical copy of — one step toward a target (hops 1-block
 * ledges, snaps down small drops, refuses walls, optionally refuses drops
 * > 1 or whole columns like deep water), the ballistic vertical integrator,
 * and the turn+move pieces. Any future server entity reuses these instead
 * of copying them again.
 *
 * The two callers differ only in policy, expressed via LocomotionOptions:
 * the bot allows drops in the sandbox/party but refuses them in the BedWars
 * arena and faces instantly; mobs always allow drops, refuse deep water,
 * turn at per-kind yaw rates and wall-check mid-hop (see
 * `checkRiseWhileAirborne` — known quirk: an airborne mobs walker that gets
 * wall-blocked skips its vertical integration that tick). bot.ts passes
 * (player, brain) — position and vertical state live on separate objects
 * there; mobs pass (mob, mob).
 */

import { GRAVITY, JUMP_SPEED_ENTITY, WORLD_SIZE_X, WORLD_SIZE_Z } from '@mc/shared';

/** Position + facing of a walking entity (a ServerPlayer fits). */
export interface WalkerPos {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** Vertical locomotion state (the bot's Brain / the mob's own fields). */
export interface WalkerVert {
  airborne: boolean;
  yVel: number;
}

export interface LocomotionOptions {
  /** Feet ground level for a column (block coords; top solid block + 1). */
  groundY(bx: number, bz: number): number;
  /** True when the walker must refuse to enter the column entirely (deep water). */
  blockedColumn?(bx: number, bz: number): boolean;
  /** Drops/ledges > 1 block allowed (sandbox cliffs yes, arena void no). */
  allowDrops: boolean;
  /** Turn rate rad/s; Infinity faces instantly (the test bot). */
  yawRate: number;
  /**
   * Run the ledge/wall rise checks even while airborne (mobs' original
   * behavior; the bot only checks while grounded). Preserved per-caller so
   * this extraction stays behavior-identical for both.
   */
  checkRiseWhileAirborne: boolean;
}

export type StepResult = 'arrived' | 'moved' | 'blocked';

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** Yaw facing toward (x, z) along the shortest arc; Infinity snaps instantly. */
export function faceTowards(pos: { x: number; z: number; yaw: number }, x: number, z: number, dt: number, yawRate: number): void {
  const desired = Math.atan2(-(x - pos.x), -(z - pos.z));
  if (!Number.isFinite(yawRate)) {
    pos.yaw = desired;
    return;
  }
  const arc = ((((desired - pos.yaw) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  pos.yaw += arc * Math.min(1, yawRate * dt);
}

/** Turns + advances horizontally (world-bounded); vertical state untouched. */
export function moveHorizontally(pos: WalkerPos, nx: number, nz: number, dt: number, opts: LocomotionOptions): void {
  faceTowards(pos, nx, nz, dt, opts.yawRate);
  pos.x = clamp(nx, 0.5, WORLD_SIZE_X - 0.5);
  pos.z = clamp(nz, 0.5, WORLD_SIZE_Z - 0.5);
}

/** Ballistic vertical step; lands (and clears `airborne`) on the ground. */
export function integrateVertical(pos: WalkerPos, vert: WalkerVert, dt: number, opts: LocomotionOptions): void {
  const g = opts.groundY(Math.floor(pos.x), Math.floor(pos.z));
  vert.yVel -= GRAVITY * dt;
  pos.y += vert.yVel * dt;
  if (pos.y <= g) {
    pos.y = g;
    vert.yVel = 0;
    vert.airborne = false;
  }
}

/**
 * One walker step toward (tx, tz): hops 1-block ledges, snaps down small
 * drops; walls (> 1) are blocked, ledges/drops > 1 are blocked unless
 * `allowDrops` (sandbox cliffs are fine, arena void is not), and whole
 * columns can be refused (mobs' deep water).
 */
export function stepWalker(
  pos: WalkerPos,
  vert: WalkerVert,
  tx: number,
  tz: number,
  speed: number,
  dt: number,
  opts: LocomotionOptions,
): StepResult {
  const dx = tx - pos.x;
  const dz = tz - pos.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.35) return 'arrived';
  const step = Math.min(speed * dt, dist);
  const nx = pos.x + (dx / dist) * step;
  const nz = pos.z + (dz / dist) * step;
  const bx = Math.floor(nx);
  const bz = Math.floor(nz);

  if (opts.blockedColumn?.(bx, bz)) return 'blocked';
  const rise = opts.groundY(bx, bz) - pos.y;
  if (!vert.airborne || opts.checkRiseWhileAirborne) {
    if (rise < -1.05 && !opts.allowDrops) return 'blocked'; // ledge/void — stay on the island
    if (rise > 0.05 && !opts.allowDrops) return 'blocked'; // arenas are flat; beds/pads are walls
    if (rise > 1.05) return 'blocked'; // wall — too tall to hop
  }
  if (!vert.airborne && rise > 0.05) {
    vert.airborne = true; // 1-block ledge → hop
    vert.yVel = JUMP_SPEED_ENTITY;
  }
  moveHorizontally(pos, nx, nz, dt, opts);
  if (vert.airborne) {
    integrateVertical(pos, vert, dt, opts);
  } else {
    const drop = pos.y - opts.groundY(Math.floor(pos.x), Math.floor(pos.z));
    if (drop > 0.05) {
      if (drop <= 1.05) pos.y -= drop; // small step down
      else {
        vert.airborne = true; // walked off a ledge — fall
        vert.yVel = 0;
      }
    }
  }
  return dist - step < 0.35 ? 'arrived' : 'moved';
}
