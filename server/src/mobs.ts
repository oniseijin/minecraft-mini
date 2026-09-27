/**
 * Sandbox mobs (DESIGN.md §3.5, M5.3 Phase 1) — passive foxes + boars.
 *
 * Server-simulated like the test bot (bot.ts) — the SAME stepTowards /
 * integrateVertical locomotion patterns — but as a separate lightweight
 * entity list (mobs are not roster players). index.ts drives the brain at
 * 8 Hz and relays a dirty-only ~5 Hz `mobs` snapshot; clients render dumb
 * interpolated avatars (client/src/mobs.ts) and punch them via `attackMob`.
 *
 * - Population: 3 foxes + 3 boars, spawned on dry land (grass/dirt/sand tops,
 *   never water), within 80 blocks of some player, ≥16 blocks from every
 *   other mob, at highestBlock + 1. MC_MOB_CAP (default 8) caps the alive
 *   total including respawns.
 * - Wander: idle-heavy (40% idle stints), fresh target ≤16 blocks away every
 *   6–15 s; fox 3.5 m/s, boar 2.5 m/s with lazier turns; 1-block ledges are
 *   hopped, walls and water deeper than 1 block turn the mob around.
 * - Panic: a validated punch sets a 5 s flee directly away from the attacker
 *   at 2× speed (idle ignored) plus a knockback impulse; hp ≤ 0 → `mobDied`
 *   broadcast + respawn scheduled 45–75 s out (MC_MOB_RESPAWN_MS overrides
 *   for tests; the respawn point again requires a player within 80).
 * - Despawn >64 blocks from every player (silently — respawned later).
 * - Everything pauses while mode ≠ 'sandbox': BedWars/Party matches must not
 *   see or simulate mobs. Resuming forces one fresh snapshot (clients clear
 *   their renderers on modeChanged).
 *
 * Mobs never edit blocks and never interact with players or the bot beyond
 * being punchable. All randomness flows through a seeded rng so a given
 * server boot produces the same population.
 */
import {
  AIR,
  DIRT,
  GRASS,
  SAND,
  SEA_LEVEL,
  WORLD_SIZE_X,
  WORLD_SIZE_Z,
  type GameMode,
  type MobKind,
  type MobSnapshot,
  type ServerMessage,
  type World,
} from '@mc/shared';
import type { ServerPlayer } from './match';

// --- tuning -----------------------------------------------------------------

const MOB_TICK_MS = 125; // 8 Hz brain (index.ts timer cadence)
const SNAPSHOT_MIN_MS = 180; // ~5 Hz dirty-only relay
const BASE_PER_KIND = 3; // 3 foxes + 3 boars
const MOB_CAP = readEnvInt('MC_MOB_CAP', 8); // alive total, respawns included
const RESPAWN_MS = readEnvInt('MC_MOB_RESPAWN_MS', 0); // 0 → 45–75 s range
const RESPAWN_MIN_MS = 45_000;
const RESPAWN_MAX_MS = 75_000;

const MOB_DAMAGE = 2; // fist punch — the sandbox has no weapons
const ATTACK_RANGE = 4.5; // same as player-vs-player validation
const ATTACK_COOLDOWN_MS = 500; // per player
const PANIC_MS = 5000; // flee duration after a hit
const KNOCKBACK_SPEED = 5.5; // m/s impulse on hit (decays fast)
const KNOCKBACK_DAMP = 6; // 1/s exponential decay of the impulse

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
const SPAWN_ATTEMPTS = 60; // dry-land spot search per spawn

const GRAVITY = 30; // matches client physics + bot.ts
const JUMP_SPEED = 8.4; // clears 1 block (v²/2g ≈ 1.18)

const SPECS: Record<MobKind, { hp: number; speed: number; yawRate: number }> = {
  fox: { hp: 6, speed: 3.5, yawRate: 12 }, // quick, nimble turns
  boar: { hp: 10, speed: 2.5, yawRate: 6 }, // slower, wider turns
};

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

/** One-step outcome of the walker (bot.ts stepTowards, extended). */
type StepResult = 'moved' | 'arrived' | 'blocked';

export function createMobManager(deps: MobDeps, seed: number): MobManager {
  const rng = mulberry32(seed ^ 0x5f3759df);
  const mobs = new Map<number, Mob>();
  const respawnQueue: { kind: MobKind; dueAt: number }[] = [];
  const lastAttackAt = new Map<number, number>(); // per-player punch cooldown

  let nextId = 1;
  let lastTickAt = 0;
  let paused = true; // starts true: also forces the first snapshot
  let resumeGraceUntil = 0;
  let lastSent = ''; // serialized last broadcast snapshot (dirty detection)
  let lastBroadcastAt = 0;

  // --- world queries ---------------------------------------------------------

  /** Water depth at a column > 1 block (or void) → mobs refuse to enter. */
  function deepWater(x: number, z: number): boolean {
    const top = deps.world.highestBlock(x, z);
    return top < SEA_LEVEL - 1;
  }

  /** Feet ground level for a column (top solid block + 1). */
  function groundY(x: number, z: number): number {
    return deps.world.highestBlock(x, z) + 1;
  }

  // --- spawning ----------------------------------------------------------------

  /** Dry-land spot within 80 of some player, ≥16 from every other mob. */
  function findSpawn(): { x: number; y: number; z: number } | null {
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

  function spawnMob(kind: MobKind, now: number): boolean {
    const spot = findSpawn();
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
    });
    deps.log(`[mobs] ${kind} #${id} spawned at (${spot.x.toFixed(0)}, ${spot.y}, ${spot.z.toFixed(0)})`);
    return true;
  }

  /**
   * Tops the population up to 3 foxes + 3 boars. Deaths/despawns are covered
   * by their SCHEDULED respawns (a kind's queue entries count toward its
   * target) — this only seeds at boot and backfills if a spawn spot was
   * temporarily unavailable.
   */
  function ensurePopulation(now: number): void {
    const alive: Record<MobKind, number> = { fox: 0, boar: 0 };
    const queued: Record<MobKind, number> = { fox: 0, boar: 0 };
    for (const mob of mobs.values()) alive[mob.kind]++;
    for (const entry of respawnQueue) queued[entry.kind]++;
    for (const kind of ['fox', 'boar'] as const) {
      const missing = BASE_PER_KIND - alive[kind] - queued[kind];
      for (let n = 0; n < missing && mobs.size < MOB_CAP; n++) {
        if (!spawnMob(kind, now)) break; // no players near / no dry spot yet
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

  // --- locomotion (adapted from bot.ts) ----------------------------------------

  function faceTowards(mob: Mob, x: number, z: number, dt: number): void {
    const desired = Math.atan2(-(x - mob.x), -(z - mob.z));
    const arc = ((((desired - mob.yaw) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    mob.yaw += arc * Math.min(1, SPECS[mob.kind].yawRate * dt); // boar turns wider
  }

  function moveHorizontally(mob: Mob, nx: number, nz: number, dt: number): void {
    faceTowards(mob, nx, nz, dt);
    mob.x = clamp(nx, 0.5, WORLD_SIZE_X - 0.5);
    mob.z = clamp(nz, 0.5, WORLD_SIZE_Z - 0.5);
  }

  /** Ballistic vertical step; lands (and clears `airborne`) on the ground. */
  function integrateVertical(mob: Mob, dt: number): void {
    const g = groundY(Math.floor(mob.x), Math.floor(mob.z));
    mob.yVel -= GRAVITY * dt;
    mob.y += mob.yVel * dt;
    if (mob.y <= g) {
      mob.y = g;
      mob.yVel = 0;
      mob.airborne = false;
    }
  }

  /**
   * One walker step toward (tx, tz): hops 1-block ledges, refuses walls and
   * water deeper than 1 block ('blocked'), snaps down small drops. True on
   * arrival — bot.ts's stepTowards with the mob water rule added.
   */
  function stepTowards(mob: Mob, tx: number, tz: number, speed: number, dt: number): StepResult {
    const dx = tx - mob.x;
    const dz = tz - mob.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.35) return 'arrived';
    const step = Math.min(speed * dt, dist);
    const nx = mob.x + (dx / dist) * step;
    const nz = mob.z + (dz / dist) * step;

    if (deepWater(Math.floor(nx), Math.floor(nz))) return 'blocked';
    const rise = groundY(Math.floor(nx), Math.floor(nz)) - mob.y;
    if (rise > 1.05) return 'blocked'; // wall — too tall to hop
    if (rise > 0.05 && !mob.airborne) {
      mob.airborne = true; // 1-block ledge → hop
      mob.yVel = JUMP_SPEED;
    }
    moveHorizontally(mob, nx, nz, dt);
    if (mob.airborne) integrateVertical(mob, dt);
    else {
      const drop = mob.y - groundY(Math.floor(mob.x), Math.floor(mob.z));
      if (drop > 0.05) {
        if (drop <= 1.05) mob.y -= drop; // small step down
        else {
          mob.airborne = true; // walked off a ledge — fall
          mob.yVel = 0;
        }
      }
    }
    return dist - step < 0.35 ? 'arrived' : 'moved';
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

  function stepMob(mob: Mob, now: number, dt: number): void {
    const spec = SPECS[mob.kind];

    // Knockback impulse (fast exponential decay; refused into deep water).
    const kmag = Math.hypot(mob.kvx, mob.kvz);
    if (kmag > 0.05) {
      const nx = mob.x + mob.kvx * dt;
      const nz = mob.z + mob.kvz * dt;
      if (!deepWater(Math.floor(nx), Math.floor(nz))) moveHorizontally(mob, nx, nz, dt);
      const decay = Math.exp(-KNOCKBACK_DAMP * dt);
      mob.kvx *= decay;
      mob.kvz *= decay;
    }

    if (now < mob.panicUntil) {
      // Flee directly away from the last attacker at 2× speed (idle ignored).
      mob.idle = false;
      const fx = mob.x + Math.cos(mob.fleeAng) * 8;
      const fz = mob.z + Math.sin(mob.fleeAng) * 8;
      const result = stepTowards(mob, fx, fz, spec.speed * 2, dt);
      if (result === 'blocked') mob.fleeAng += Math.PI / 2; // slide along the obstacle
      return;
    }

    if (now >= mob.decideAt) pickWanderTarget(mob, now);
    if (mob.idle) return;
    if (stepTowards(mob, mob.targetX, mob.targetZ, spec.speed, dt) !== 'moved') {
      // Arrived (or blocked) — stand until the next wander decision.
      mob.idle = true;
      mob.targetX = mob.x;
      mob.targetZ = mob.z;
    }
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
    deps.log(`[mobs] ${mob.kind} #${mob.id} died — respawning in ${
      RESPAWN_MS > 0 ? RESPAWN_MS : '45–75'
    } s`);
    scheduleRespawn(mob.kind, now);
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
        scheduleRespawn(mob.kind, now);
        deps.log(`[mobs] ${mob.kind} #${mob.id} despawned (far) — respawn scheduled`);
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
      if (dist > ATTACK_RANGE) {
        deps.log(`[mobs] attack from ${attacker.name} rejected: out of range (${dist.toFixed(1)})`);
        return;
      }
      lastAttackAt.set(attacker.id, now);

      mob.hp -= MOB_DAMAGE;
      mob.panicUntil = now + PANIC_MS;
      mob.decideAt = Math.max(mob.decideAt, mob.panicUntil);
      const dx = mob.x - attacker.x;
      const dz = mob.z - attacker.z;
      const len = Math.hypot(dx, dz) || 1;
      mob.fleeAng = Math.atan2(dz, dx); // directly away from the attacker
      mob.kvx = (dx / len) * KNOCKBACK_SPEED;
      mob.kvz = (dz / len) * KNOCKBACK_SPEED;
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
