/**
 * Sandbox mobs (DESIGN.md §3.5, M5.3 Phase 1 + M5.4 Phase 2) — passive foxes,
 * boars and giraffes, plus night-only zombies.
 *
 * Server-simulated like the test bot (bot.ts) — the SAME stepTowards /
 * integrateVertical locomotion patterns — but as a separate lightweight
 * entity list (mobs are not roster players). index.ts drives the brain at
 * 8 Hz and relays a dirty-only ~5 Hz `mobs` snapshot (which also carries the
 * server's `dayT` so every client's sky + zombies stay in sync); clients
 * render dumb interpolated avatars (client/src/mobs.ts) and punch them via
 * `attackMob`.
 *
 * - Day clock (M5.4): dayPhase(now − bootAt) from shared/src/dayclock.ts, with
 *   MC_DAY_T / MC_MOB_FORCE_NIGHT / MC_MOB_FORCE_DAY pins for tests. Passive
 *   population: 3 foxes + 3 boars + 1–2 giraffes, spawned on dry land
 *   (grass/dirt/sand tops, never water), within 80 blocks of some player,
 *   ≥16 blocks from every other mob, at highestBlock + 1. MC_MOB_CAP
 *   (default 8) caps the alive PASSIVE total including respawns.
 * - Wander: idle-heavy (40% idle stints), fresh target ≤16 blocks away every
 *   6–15 s; fox 3.5 m/s, boar 2.5, giraffe 1.8 with lazier turns; 1-block
 *   ledges are hopped, walls and water deeper than 1 block turn the mob around.
 * - Panic: a validated punch sets a 5 s flee directly away from the attacker
 *   at 2× speed (idle ignored) plus a knockback impulse; hp ≤ 0 → `mobDied`
 *   broadcast + respawn scheduled 45–75 s out (MC_MOB_RESPAWN_MS overrides
 *   for tests; the respawn point again requires a player within 80).
 * - Zombies (Phase 2, kid-safe): spawn ONLY inside the night band, on dry land
 *   16–32 blocks from a player (≥16 from EVERY player — outside detection),
 *   at most MC_ZOMBIE_CAP (default 2) alive; the cap counts alive only, so a
 *   punched-down zombie simply frees its slot. Brain: 3D detection radius 16
 *   (nearest roster player incl. the bot) with hysteresis to 24, chase via
 *   stepTowards at 2.8 m/s with the 1-block hop; beyond 24 they shamble toward
 *   the nearest player at 1.6 m/s (so freshly spawned ones walk in). Within
 *   1.2 blocks they shove: a `shoved` gameEvent (pure knockback — the sandbox
 *   stays DEATHLESS, no hp/damage) on a 1.5 s per-zombie cooldown. A punch
 *   staggers them 0.5 s (they turn toward the attacker, never flee); hp ≤ 0
 *   → poof with NO scheduled respawn. At dawn every zombie burns away (poof,
 *   no respawn until the next night). Despawn >64 from every player like the
 *   passive kinds (zombies silently — no respawn scheduled).
 * - Despawn >64 blocks from every player (silently — respawned later).
 * - Everything pauses while mode ≠ 'sandbox': BedWars/Party matches must not
 *   see or simulate mobs. Resuming forces one fresh snapshot (clients clear
 *   their renderers on modeChanged).
 *
 * Mobs never edit blocks. All randomness flows through a seeded rng so a given
 * server boot produces the same population.
 */
import {
  AIR,
  ATTACK_COOLDOWN_MS,
  ATTACK_RANGE_SERVER,
  DIRT,
  GRASS,
  SAND,
  SEA_LEVEL,
  WORLD_SIZE_X,
  WORLD_SIZE_Z,
  dayPhase,
  isNightDayT,
  NIGHT_END_DAY_T,
  NIGHT_START_DAY_T,
  type GameMode,
  type MobKind,
  type ServerMessage,
  type World,
} from '@mc/shared';
import type { ServerPlayer } from './match';
import { faceTowards, moveHorizontally, stepWalker, type LocomotionOptions, type StepResult } from './locomotion';

// --- tuning -----------------------------------------------------------------

const MOB_TICK_MS = 125; // 8 Hz brain (index.ts timer cadence)
const SNAPSHOT_MIN_MS = 180; // ~5 Hz dirty-only relay
const PASSIVE_KINDS = ['fox', 'boar', 'giraffe'] as const;
const BASE_PER_KIND: Record<(typeof PASSIVE_KINDS)[number], number> = { fox: 3, boar: 3, giraffe: 0 }; // giraffe filled in per boot (1–2)
const MOB_CAP = readEnvInt('MC_MOB_CAP', 8); // alive PASSIVE total, respawns included
const RESPAWN_MS = readEnvInt('MC_MOB_RESPAWN_MS', 0); // 0 → 45–75 s range
const RESPAWN_MIN_MS = 45_000;
const RESPAWN_MAX_MS = 75_000;

const MOB_DAMAGE = 2; // fist punch — the sandbox has no weapons
// ATTACK_RANGE_SERVER ("same as player-vs-player validation") +
// ATTACK_COOLDOWN_MS live in @mc/shared — the same combat numbers match.ts
// validates BedWars attacks with (the client's tighter gate is
// ATTACK_REACH_CLIENT; the server stays lenient for position-report latency).
const PANIC_MS = 5000; // flee duration after a hit
const KNOCKBACK_SPEED = 5.5; // m/s impulse on hit (decays fast)
const KNOCKBACK_DAMP = 6; // 1/s exponential decay of the impulse

// Zombies (§3.5 Phase 2).
const ZOMBIE_CAP = readEnvInt('MC_ZOMBIE_CAP', 2); // alive at night
const ZOMBIE_SPAWN_MIN = 16; // from a player — outside detection
const ZOMBIE_SPAWN_MAX = 32;
const ZOMBIE_DETECT = 16; // starts chasing (Bedrock number)
const ZOMBIE_LOSE_INTEREST = 24; // above this the fast chase drops back to a shamble
const ZOMBIE_SHOVE_RANGE = 1.2; // contact
const ZOMBIE_SHOVE_COOLDOWN_MS = 1500; // per zombie
const ZOMBIE_SHOVE_POWER = 5.5; // dir·power is the client's velocity delta
const ZOMBIE_SHOVE_UP = 0.45; // upward bias in the normalized shove dir
const ZOMBIE_STAGGER_MS = 500; // punched: stand still + turn toward the attacker
const ZOMBIE_KNOCKBACK_SPEED = 2.5; // tiny pop on hit (no flee)

const DECIDE_MIN_MS = 6000; // wander re-decision window
const DECIDE_MAX_MS = 15_000;
const IDLE_CHANCE = 0.4; // idle stints
const TARGET_MIN_DIST = 3;
const TARGET_MAX_DIST = 16;

const DESPAWN_DIST = 64; // from EVERY player
/** After resuming from a match, wait before distance-despawns (stale positions). */
const RESUME_GRACE_MS = 3000;
const SPAWN_PLAYER_DIST = 80; // within this of SOME player
const MOB_MIN_SEPARATION = 16; // between mobs at spawn time
const ZOMBIE_MIN_SEPARATION = 8; // zombies are transient — pack a little tighter
const SPAWN_ATTEMPTS = 60; // dry-land spot search per spawn

// GRAVITY + JUMP_SPEED_ENTITY live in @mc/shared — same numbers as bot.ts and
// the client player physics (the entity hop is deliberately below the
// client player's JUMP_SPEED_PLAYER; see shared/src/simulation.ts).

/**
 * Movement speeds per kind: passive kinds wander at `wander` and panic-flee at
 * `flee` (2× wander, as before); zombies chase at `chase` and shamble at
 * `wander` when nobody is within detection.
 */
const SPECS: Record<MobKind, { hp: number; wander: number; flee: number; chase: number; yawRate: number }> = {
  fox: { hp: 6, wander: 3.5, flee: 7.0, chase: 0, yawRate: 12 }, // quick, nimble turns
  boar: { hp: 10, wander: 2.5, flee: 5.0, chase: 0, yawRate: 6 }, // slower, wider turns
  giraffe: { hp: 14, wander: 1.8, flee: 3.6, chase: 0, yawRate: 4 }, // slowest, widest turns
  zombie: { hp: 10, wander: 1.6, flee: 0, chase: 2.8, yawRate: 10 }, // shamble in, sprint the last 16
};

/** Day phase pin for tests (env): MC_DAY_T beats the night/day force flags. */
function readDayTPin(): number | null {
  const raw = process.env.MC_DAY_T;
  if (raw !== undefined && raw !== '') {
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 0 && value < 1) return value;
  }
  if (process.env.MC_MOB_FORCE_NIGHT !== undefined && process.env.MC_MOB_FORCE_NIGHT !== '') {
    return 0.75; // midnight
  }
  if (process.env.MC_MOB_FORCE_DAY !== undefined && process.env.MC_MOB_FORCE_DAY !== '') {
    return 0.25; // noon
  }
  return null;
}

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** Deterministic mulberry32 — same seed → same population per boot. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

interface Mob {
  id: number;
  kind: MobKind;
  x: number;
  y: number;
  z: number;
  yaw: number;
  hp: number;
  targetX: number;
  targetZ: number;
  /** Epoch ms of the next wander decision. */
  decideAt: number;
  idle: boolean;
  airborne: boolean;
  yVel: number;
  /** Knockback impulse velocity (decays exponentially). */
  kvx: number;
  kvz: number;
  /** Epoch ms until which the mob flees the last attacker; 0 = calm. */
  panicUntil: number;
  /** Heading (radians) directly away from the attacker while panicked. */
  fleeAng: number;
  /** Zombies only: standing-stunned until this epoch ms (0 = never). */
  staggerUntil: number;
  /** Zombies only: epoch ms of their last shove (cooldown gating). */
  shoveAt: number;
  /** Zombies only: currently aware of a player (chase hysteresis). */
  aggro: boolean;
}

export interface MobDeps {
  /** The persistent sandbox world — the only world mobs ever walk on. */
  world: World;
  /** Live roster (positions feed spawn/despawn/attack validation). */
  players: Map<number, ServerPlayer>;
  /** Current mode; mobs pause completely outside 'sandbox'. */
  mode(): GameMode;
  broadcast(msg: ServerMessage): void;
  log(line: string): void;
}

export interface MobManager {
  /** Advance brains + physics; called on a timer (~8 Hz). */
  tick(now: number): void;
  /** Validated punch (C→S attackMob): range/cooldown like player attacks. */
  attackMob(attacker: ServerPlayer, mobId: number): void;
  /** Forces the next tick to broadcast a snapshot (new joiner / mode return). */
  markDirty(): void;
}

export function createMobManager(deps: MobDeps, seed: number): MobManager {
  const rng = mulberry32(seed ^ 0x5f3759df);
  const mobs = new Map<number, Mob>();
  const respawnQueue: { kind: MobKind; dueAt: number }[] = [];
  const lastAttackAt = new Map<number, number>(); // per-player punch cooldown

  // Giraffe head-count for THIS boot: 1–2 (seeded — the smoke test allows both).
  BASE_PER_KIND.giraffe = 1 + (rng() < 0.5 ? 1 : 0);

  const DAY_T_PIN = readDayTPin();
  const BOOT_AT = Date.now();
  let lastDayT = 0.1;
  let night = isNightDayT(lastDayT);

  let nextId = 1;
  let lastTickAt = 0;
  let paused = true; // starts true: also forces the first snapshot
  let resumeGraceUntil = 0;
  let lastSent = ''; // serialized last broadcast snapshot (dirty detection)
  let lastBroadcastAt = 0;

  /** The server's shared time of day — the same phase the clients render. */
  function dayT(now: number): number {
    lastDayT = DAY_T_PIN ?? dayPhase(now - BOOT_AT);
    return lastDayT;
  }

  // --- world queries ---------------------------------------------------------

  /** Water depth at a column > 1 block (or void) → mobs refuse to enter. */
  function deepWater(x: number, z: number): boolean {
    const top = deps.world.highestBlock(x, z);
    return top < SEA_LEVEL - 1;
  }

  // --- spawning ----------------------------------------------------------------

  interface SpawnSpot {
    x: number;
    y: number;
    z: number;
  }

  /** Dry-land spot within 80 of some player, ≥16 from every other mob. */
  function findSpawn(): SpawnSpot | null {
    const anchors = [...deps.players.values()];
    if (anchors.length === 0) return null;
    for (let attempt = 0; attempt < SPAWN_ATTEMPTS; attempt++) {
      const anchor = anchors[Math.floor(rng() * anchors.length)];
      const ang = rng() * Math.PI * 2;
      const r = 12 + rng() * (SPAWN_PLAYER_DIST - 12);
      const x = clamp(anchor.x + Math.cos(ang) * r, 2, WORLD_SIZE_X - 2);
      const z = clamp(anchor.z + Math.sin(ang) * r, 2, WORLD_SIZE_Z - 2);
      const bx = Math.floor(x);
      const bz = Math.floor(z);
      const top = deps.world.highestBlock(bx, bz);
      if (top < SEA_LEVEL - 1) continue; // underwater column
      const topId = deps.world.getBlock(bx, top, bz);
      if (topId !== GRASS && topId !== DIRT && topId !== SAND) continue; // trees/water/edits
      if (deps.world.getBlock(bx, top + 1, bz) !== AIR) continue; // blocked surface
      let tooClose = Math.hypot(x - anchor.x, z - anchor.z) < 4; // not in the player's face
      if (!tooClose) {
        for (const mob of mobs.values()) {
          if (Math.hypot(mob.x - x, mob.z - z) < MOB_MIN_SEPARATION) {
            tooClose = true;
            break;
          }
        }
      }
      if (tooClose) continue;
      return { x, y: top + 1, z };
    }
    return null;
  }

  /**
   * Zombie spot: dry land 16–32 blocks from a random player and ≥16 from
   * EVERY player (outside detection — they shamble in), ≥8 from other mobs.
   */
  function findZombieSpawn(): SpawnSpot | null {
    const anchors = [...deps.players.values()];
    if (anchors.length === 0) return null;
    for (let attempt = 0; attempt < SPAWN_ATTEMPTS; attempt++) {
      const anchor = anchors[Math.floor(rng() * anchors.length)];
      const ang = rng() * Math.PI * 2;
      const r = ZOMBIE_SPAWN_MIN + rng() * (ZOMBIE_SPAWN_MAX - ZOMBIE_SPAWN_MIN);
      const x = clamp(anchor.x + Math.cos(ang) * r, 2, WORLD_SIZE_X - 2);
      const z = clamp(anchor.z + Math.sin(ang) * r, 2, WORLD_SIZE_Z - 2);
      const bx = Math.floor(x);
      const bz = Math.floor(z);
      const top = deps.world.highestBlock(bx, bz);
      if (top < SEA_LEVEL - 1) continue; // underwater column
      const topId = deps.world.getBlock(bx, top, bz);
      if (topId !== GRASS && topId !== DIRT && topId !== SAND) continue; // trees/water/edits
      if (deps.world.getBlock(bx, top + 1, bz) !== AIR) continue; // blocked surface
      let tooClose = false;
      for (const player of anchors) {
        if (Math.hypot(player.x - x, player.z - z) < ZOMBIE_SPAWN_MIN) {
          tooClose = true; // never pop into detection range
          break;
        }
      }
      if (!tooClose) {
        for (const mob of mobs.values()) {
          if (Math.hypot(mob.x - x, mob.z - z) < ZOMBIE_MIN_SEPARATION) {
            tooClose = true;
            break;
          }
        }
      }
      if (tooClose) continue;
      return { x, y: top + 1, z };
    }
    return null;
  }

  function spawnMob(kind: MobKind, now: number): boolean {
    const spot = kind === 'zombie' ? findZombieSpawn() : findSpawn();
    if (spot === null) return false;
    const id = nextId++;
    mobs.set(id, {
      id,
      kind,
      x: spot.x,
      y: spot.y,
      z: spot.z,
      yaw: rng() * Math.PI * 2,
      hp: SPECS[kind].hp,
      targetX: spot.x,
      targetZ: spot.z,
      decideAt: now + rng() * DECIDE_MAX_MS,
      idle: true,
      airborne: false,
      yVel: 0,
      kvx: 0,
      kvz: 0,
      panicUntil: 0,
      fleeAng: 0,
      staggerUntil: 0,
      shoveAt: 0,
      aggro: false,
    });
    deps.log(`[mobs] ${kind} #${id} spawned at (${spot.x.toFixed(0)}, ${spot.y}, ${spot.z.toFixed(0)})`);
    return true;
  }

  /**
   * Tops the passive population up to 3 foxes + 3 boars + 1–2 giraffes, and
   * (at night) the zombie cap. Passive deaths/despawns are covered by their
   * SCHEDULED respawns (a kind's queue entries count toward its target) —
   * this only seeds at boot and backfills if a spawn spot was temporarily
   * unavailable. Zombies have no respawn queue: the cap counts ALIVE only, so
   * a killed zombie frees its slot for a fresh night spawn.
   */
  function ensurePopulation(now: number): void {
    const alive: Record<MobKind, number> = { fox: 0, boar: 0, giraffe: 0, zombie: 0 };
    const queued: Record<MobKind, number> = { fox: 0, boar: 0, giraffe: 0, zombie: 0 };
    for (const mob of mobs.values()) alive[mob.kind]++;
    for (const entry of respawnQueue) queued[entry.kind]++;
    let passive = mobs.size - alive.zombie;
    for (const kind of PASSIVE_KINDS) {
      const missing = BASE_PER_KIND[kind] - alive[kind] - queued[kind];
      for (let n = 0; n < missing; n++) {
        if (passive >= MOB_CAP) break;
        if (!spawnMob(kind, now)) break; // no players near / no dry spot yet
        passive++;
      }
    }
    if (night) {
      for (let n = alive.zombie; n < ZOMBIE_CAP; n++) {
        if (!spawnMob('zombie', now)) break; // no 16–32 dry spot this tick — retry next
      }
    }
  }

  function scheduleRespawn(kind: MobKind, now: number): void {
    const delay = RESPAWN_MS > 0 ? RESPAWN_MS : RESPAWN_MIN_MS + rng() * (RESPAWN_MAX_MS - RESPAWN_MIN_MS);
    respawnQueue.push({ kind, dueAt: now + delay });
  }

  function processRespawns(now: number): void {
    for (let i = respawnQueue.length - 1; i >= 0; i--) {
      const entry = respawnQueue[i];
      if (now < entry.dueAt || mobs.size >= MOB_CAP) continue;
      if (spawnMob(entry.kind, now)) respawnQueue.splice(i, 1); // else retry next tick
    }
  }

  // --- locomotion (shared module, REFACTORING.md 2d) -----------------------------

  /** The mob locomotion policy: drops always allowed, deep water refused, per-kind turn rates. */
  function mobLoco(mob: Mob): LocomotionOptions {
    return {
      groundY: (bx, bz) => deps.world.highestBlock(bx, bz) + 1,
      blockedColumn: deepWater,
      allowDrops: true,
      yawRate: SPECS[mob.kind].yawRate,
      checkRiseWhileAirborne: true,
    };
  }

  /**
   * One walker step toward (tx, tz): hops 1-block ledges, refuses walls and
   * water deeper than 1 block ('blocked'), snaps down small drops. True on
   * arrival — the shared stepWalker with the mob water rule via options.
   */
  function stepTowards(mob: Mob, tx: number, tz: number, speed: number, dt: number): StepResult {
    return stepWalker(mob, mob, tx, tz, speed, dt, mobLoco(mob));
  }

  // --- brain -------------------------------------------------------------------

  function pickWanderTarget(mob: Mob, now: number): void {
    mob.decideAt = now + DECIDE_MIN_MS + rng() * (DECIDE_MAX_MS - DECIDE_MIN_MS);
    if (rng() < IDLE_CHANCE) {
      mob.idle = true;
      return;
    }
    mob.idle = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      const ang = rng() * Math.PI * 2;
      const r = TARGET_MIN_DIST + rng() * (TARGET_MAX_DIST - TARGET_MIN_DIST);
      const x = clamp(mob.x + Math.cos(ang) * r, 2, WORLD_SIZE_X - 2);
      const z = clamp(mob.z + Math.sin(ang) * r, 2, WORLD_SIZE_Z - 2);
      if (deepWater(Math.floor(x), Math.floor(z))) continue; // prefer dry targets
      mob.targetX = x;
      mob.targetZ = z;
      return;
    }
    mob.targetX = mob.x; // surrounded by water — stand still this stint
    mob.targetZ = mob.z;
  }

  /** Nearest roster player in 3D (humans + the test bot), or null. */
  function nearestPlayer(mob: Mob): { player: ServerPlayer; dist: number } | null {
    let best: ServerPlayer | null = null;
    let bestDist = Infinity;
    for (const player of deps.players.values()) {
      const dist = Math.hypot(player.x - mob.x, player.y - mob.y, player.z - mob.z);
      if (dist < bestDist) {
        best = player;
        bestDist = dist;
      }
    }
    return best ? { player: best, dist: bestDist } : null;
  }

  /** Knockback impulse (fast exponential decay; refused into deep water). */
  function applyKnockback(mob: Mob, dt: number): void {
    const kmag = Math.hypot(mob.kvx, mob.kvz);
    if (kmag <= 0.05) return;
    const nx = mob.x + mob.kvx * dt;
    const nz = mob.z + mob.kvz * dt;
    if (!deepWater(Math.floor(nx), Math.floor(nz))) moveHorizontally(mob, nx, nz, dt, mobLoco(mob));
    const decay = Math.exp(-KNOCKBACK_DAMP * dt);
    mob.kvx *= decay;
    mob.kvz *= decay;
  }

  function stepMob(mob: Mob, now: number, dt: number): void {
    if (mob.kind === 'zombie') {
      stepZombie(mob, now, dt);
      return;
    }

    applyKnockback(mob, dt);

    if (now < mob.panicUntil) {
      // Flee directly away from the last attacker at 2× speed (idle ignored).
      mob.idle = false;
      const fx = mob.x + Math.cos(mob.fleeAng) * 8;
      const fz = mob.z + Math.sin(mob.fleeAng) * 8;
      const result = stepTowards(mob, fx, fz, SPECS[mob.kind].flee, dt);
      if (result === 'blocked') mob.fleeAng += Math.PI / 2; // slide along the obstacle
      return;
    }

    if (now >= mob.decideAt) pickWanderTarget(mob, now);
    if (mob.idle) return;
    if (stepTowards(mob, mob.targetX, mob.targetZ, SPECS[mob.kind].wander, dt) !== 'moved') {
      // Arrived (or blocked) — stand until the next wander decision.
      mob.idle = true;
      mob.targetX = mob.x;
      mob.targetZ = mob.z;
    }
  }

  /** Zombie brain (§3.5 Phase 2): shamble toward players, chase, shove. */
  function stepZombie(mob: Mob, now: number, dt: number): void {
    applyKnockback(mob, dt);
    if (now < mob.staggerUntil) return; // punched — stand still a beat

    const target = nearestPlayer(mob);
    if (target === null) return; // nobody online; despawnFar clears the corpse walk
    const spec = SPECS.zombie;

    // Chase hysteresis: aggro inside 16, hold until 24, shamble beyond.
    if (target.dist <= ZOMBIE_DETECT) mob.aggro = true;
    else if (target.dist > ZOMBIE_LOSE_INTEREST) mob.aggro = false;

    if (target.dist <= ZOMBIE_SHOVE_RANGE) {
      // Contact: face the victim and shove (pure knockback — deathless sandbox).
      faceTowards(mob, target.player.x, target.player.z, dt, SPECS.zombie.yawRate);
      if (now - mob.shoveAt >= ZOMBIE_SHOVE_COOLDOWN_MS) {
        mob.shoveAt = now;
        const dx = target.player.x - mob.x;
        const dz = target.player.z - mob.z;
        const len = Math.hypot(dx, dz) || 1;
        deps.broadcast({
          type: 'gameEvent',
          kind: 'shoved',
          playerId: target.player.id,
          mobId: mob.id,
          dir: { x: dx / len, y: ZOMBIE_SHOVE_UP, z: dz / len },
          power: ZOMBIE_SHOVE_POWER,
        });
        deps.log(`[mobs] zombie #${mob.id} shoved ${target.player.name} (${target.dist.toFixed(1)} away)`);
      }
      return; // standing right in the player's face — no need to walk on
    }

    const speed = mob.aggro ? spec.chase : spec.wander;
    stepTowards(mob, target.player.x, target.player.z, speed, dt);
  }

  // --- death / despawn -----------------------------------------------------------

  function killMob(mob: Mob, now: number): void {
    mobs.delete(mob.id);
    broadcastSnapshot(true);
    deps.broadcast({
      type: 'mobDied',
      id: mob.id,
      kind: mob.kind,
      at: [
        Math.round(mob.x * 100) / 100,
        Math.round(mob.y * 100) / 100,
        Math.round(mob.z * 100) / 100,
      ],
    });
    if (mob.kind === 'zombie') {
      deps.log(`[mobs] zombie #${mob.id} down — no respawn until the next night (cap counts alive only)`);
      return; // zombies never ride the respawn queue
    }
    deps.log(`[mobs] ${mob.kind} #${mob.id} died — respawning in ${
      RESPAWN_MS > 0 ? RESPAWN_MS : '45–75'
    } s`);
    scheduleRespawn(mob.kind, now);
  }

  /** Dawn: every zombie burns away (poof + burn FX client-side), no respawn. */
  function burnZombies(): void {
    const burned = [...mobs.values()].filter((mob) => mob.kind === 'zombie');
    for (const mob of burned) {
      mobs.delete(mob.id);
      deps.broadcast({
        type: 'mobDied',
        id: mob.id,
        kind: mob.kind,
        at: [
          Math.round(mob.x * 100) / 100,
          Math.round(mob.y * 100) / 100,
          Math.round(mob.z * 100) / 100,
        ],
      });
      deps.log(`[mobs] zombie #${mob.id} burned away at dawn`);
    }
    if (burned.length > 0) broadcastSnapshot(true); // one forced snapshot for the whole dawn purge
  }

  function despawnFar(now: number): void {
    if (now < resumeGraceUntil) return; // stale roster positions right after a mode switch
    const anchors = [...deps.players.values()];
    for (const mob of [...mobs.values()]) {
      const nearest = anchors.length
        ? Math.min(...anchors.map((p) => Math.hypot(p.x - mob.x, p.y - mob.y, p.z - mob.z)))
        : Infinity; // nobody online → despawn everything
      if (nearest > DESPAWN_DIST || mob.y < 0.5) {
        mobs.delete(mob.id);
        if (mob.kind !== 'zombie') scheduleRespawn(mob.kind, now); // zombies wait for the next night
        deps.log(`[mobs] ${mob.kind} #${mob.id} despawned (far)${mob.kind === 'zombie' ? '' : ' — respawn scheduled'}`);
      }
    }
  }

  // --- snapshots -------------------------------------------------------------------

  function snapshot() {
    return {
      type: 'mobs' as const,
      mobs: [...mobs.values()]
        .sort((a, b) => a.id - b.id)
        .map((mob) => ({
          id: mob.id,
          kind: mob.kind,
          x: Math.round(mob.x * 1000) / 1000,
          y: Math.round(mob.y * 1000) / 1000,
          z: Math.round(mob.z * 1000) / 1000,
          yaw: Math.round(mob.yaw * 1000) / 1000,
          hp: mob.hp,
        })),
      dayT: Math.round(lastDayT * 10000) / 10000,
    };
  }

  /** Broadcasts when dirty; `force` skips the change check (deaths/joins). */
  function broadcastSnapshot(force: boolean): void {
    const msg = snapshot();
    const serialized = JSON.stringify(msg);
    if (!force && serialized === lastSent) return;
    lastSent = serialized;
    lastBroadcastAt = Date.now();
    deps.broadcast(msg);
  }

  // --- manager -----------------------------------------------------------------

  return {
    tick(now: number) {
      const mode = deps.mode();
      if (mode !== 'sandbox') {
        paused = true; // matches never simulate or broadcast mobs
        return;
      }
      if (paused) {
        paused = false;
        lastTickAt = now;
        lastSent = ''; // clients cleared during the match — resend everything
        // Returning players' positions may still be the match arena (stale
        // roster coords) — don't distance-despawn against them until the
        // first real move updates arrive.
        resumeGraceUntil = now + RESUME_GRACE_MS;
      }
      const dt = lastTickAt === 0 ? 0.1 : Math.min((now - lastTickAt) / 1000, 0.5);
      lastTickAt = now;

      // Shared day clock: gate zombie spawns on night; burn them at dawn.
      const phase = dayT(now);
      const isNight = isNightDayT(phase);
      if (night && !isNight) burnZombies();
      night = isNight;

      ensurePopulation(now);
      processRespawns(now);
      despawnFar(now);

      for (const mob of mobs.values()) stepMob(mob, now, dt);

      if (now - lastBroadcastAt >= SNAPSHOT_MIN_MS) broadcastSnapshot(false);
    },

    attackMob(attacker, mobId) {
      if (deps.mode() !== 'sandbox') return;
      const mob = mobs.get(mobId);
      if (!mob) return;
      const now = Date.now();
      const last = lastAttackAt.get(attacker.id) ?? 0;
      if (now - last < ATTACK_COOLDOWN_MS) return;
      const dist = Math.hypot(mob.x - attacker.x, mob.y - attacker.y, mob.z - attacker.z);
      if (dist > ATTACK_RANGE_SERVER) {
        deps.log(`[mobs] attack from ${attacker.name} rejected: out of range (${dist.toFixed(1)})`);
        return;
      }
      lastAttackAt.set(attacker.id, now);

      mob.hp -= MOB_DAMAGE;
      const dx = mob.x - attacker.x;
      const dz = mob.z - attacker.z;
      const len = Math.hypot(dx, dz) || 1;
      if (mob.kind === 'zombie') {
        // Kid-safe hostility: a punch STAGGERS the zombie (brief stand-still,
        // turns toward the attacker) — never a flee. Small pop for feel.
        mob.staggerUntil = now + ZOMBIE_STAGGER_MS;
        mob.decideAt = Math.max(mob.decideAt, mob.staggerUntil);
        mob.yaw = Math.atan2(-(attacker.x - mob.x), -(attacker.z - mob.z));
        mob.kvx = (dx / len) * ZOMBIE_KNOCKBACK_SPEED;
        mob.kvz = (dz / len) * ZOMBIE_KNOCKBACK_SPEED;
      } else {
        mob.panicUntil = now + PANIC_MS;
        mob.decideAt = Math.max(mob.decideAt, mob.panicUntil);
        mob.fleeAng = Math.atan2(dz, dx); // directly away from the attacker
        mob.kvx = (dx / len) * KNOCKBACK_SPEED;
        mob.kvz = (dz / len) * KNOCKBACK_SPEED;
      }
      if (!mob.airborne) {
        mob.airborne = true; // little hurt pop
        mob.yVel = 4;
      }
      deps.log(`[mobs] ${attacker.name} hit ${mob.kind} #${mob.id} for ${MOB_DAMAGE} (hp ${Math.max(0, mob.hp)})`);
      if (mob.hp <= 0) killMob(mob, now);
      else broadcastSnapshot(true); // hp drop visible on the next frame
    },

    markDirty() {
      lastSent = '';
    },
  };
}

// Night band constants re-exported for readability of the debug log below.
void NIGHT_START_DAY_T;
void NIGHT_END_DAY_T;
