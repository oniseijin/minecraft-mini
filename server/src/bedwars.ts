/**
 * BedWars match engine (REFACTORING.md 2b.1, extracted from match.ts): the
 * mode registry in match.ts owns the live Match reference + gameMode; these
 * stateless functions implement the rules in the same (deps, match, …) shape
 * party.ts uses —
 *
 * - edits against the match world (beds: only the ENEMY team may break them;
 *   placing: only shop blocks the buyer owns, consuming stock),
 * - generators, combat validation, hp/regen/death, respawns, elimination +
 *   matchEnd, the 10 s countdown and 10:00 timer with sudden-death bed-break,
 * - the shop (proximity + currency validation) and golden-apple heals,
 * - the bow (protocol v10, §3.3): charged `bowShot`s spend arrows and fly as
 *   per-tick ballistic segments (shared parabola + GRAVITY) with block/player
 *   impact; both combat paths emit the `hit` damage-numbers event.
 *
 * Rematch (ready from both), leaveGame → sandbox and the everyone-left reset
 * live in the registry; a 5 Hz gameState snapshot closes every tick.
 */

import {
  AIR,
  ARENA,
  ARENA_SEED,
  ARROW_MAX_CHARGE,
  ARROW_MIN_CHARGE,
  ATTACK_COOLDOWN_MS,
  ATTACK_RANGE_SERVER,
  BED_BLUE,
  BED_RED,
  BLOCKS,
  EYE_HEIGHT,
  PLANKS,
  SHOP_ITEMS,
  TARGET_HEIGHT,
  TARGET_HALF_WIDTH,
  VOID_KILL_Y,
  WATER,
  WORLD_SIZE_X,
  WORLD_SIZE_Y,
  WORLD_SIZE_Z,
  WOOL_WHITE,
  arrowDamage,
  arrowPosition,
  arrowSpeed,
  generateBedwarsArena,
  heldDamage,
  raycast,
  type ArenaSpawn,
  type AttackMsg,
  type BlockEditMsg,
  type BowShotMsg,
  type BuyMsg,
  type GameEventMsg,
  type GameStateMsg,
  type ModeChangedMsg,
  type ServerMessage,
  type ShopItemId,
  type SwordTier,
  type World,
} from '@mc/shared';
import type { ServerPlayer } from './match';
import { leaveMidMatch, rejectEdit, type ServerContext } from './matchLifecycle';

const COUNTDOWN_MS = 10_000;
const MATCH_MS = 10 * 60_000;
const RESPAWN_MS = 5_000;
// ATTACK_COOLDOWN_MS + ATTACK_RANGE_SERVER live in @mc/shared — the same
// numbers mobs.ts punches with; the client's tighter melee gate is
// ATTACK_REACH_CLIENT (the 1.0 slack absorbs position-report latency).
const REGEN_DELAY_MS = 5_000;
const REGEN_INTERVAL_MS = 2_500;
const IRON_INTERVAL_S = 1.5;
const GOLD_INTERVAL_S = 4;
const EMERALD_INTERVAL_S = 6;
const MAX_HP = 20;
const HEAL_AMOUNT = 8;
const MAX_APPLES = 9;
const MAX_STACK = 64;
const KNOCKBACK_BASE = 4;
// --- bow (protocol v10, §3.3) ----------------------------------------------
// ARROW_MIN/MAX_CHARGE + the damage/speed formulas live in @mc/shared (the
// client's charge bar ramps across the same numbers). The flight step matches
// the match tick cadence — the client renders the SAME parabola
// (arrowPosition) parameterized by flight time, so both sides agree given
// (from, dir, power) + the shared GRAVITY.
const ARROW_TICK_S = 0.2; // one ballistic segment per match tick
const ARROW_MAX_TICKS = 40; // 8 s aloft — plenty for the 48-block gap
const ARROW_POOL_CAP = 16; // runaway guard on concurrent arrows per match

/** One arrow in flight (stateless per-tick ballistics — no per-tick state). */
interface FlyingArrow {
  ownerId: number;
  /** Server-resolved damage at launch (charge → arrowDamage). */
  damage: number;
  /** Eye-height launch spot + normalized aim + launch speed (m/s). */
  from: { x: number; y: number; z: number };
  dir: { x: number; y: number; z: number };
  power: number;
  /** Completed 0.2 s flight steps (the next tick flies segment ticks→ticks+1). */
  ticks: number;
}

export interface MatchPlayer {
  id: number;
  name: string;
  team: 0 | 1;
  hp: number;
  alive: boolean;
  /** Epoch ms of the scheduled respawn; 0 = not respawning. */
  respawnAt: number;
  lastDamageAt: number;
  lastAttackAt: number;
  lastRegenAt: number;
  currency: { iron: number; gold: number; emerald: number };
  wool: number;
  planks: number;
  apples: number;
  sword: SwordTier | null;
  /** Bow owned (shop purchase) — arrows are spent per shot, no pickup (v1). */
  bow: boolean;
  arrows: number;
  kills: number;
  deaths: number;
}

export interface Match {
  world: World;
  players: Map<number, MatchPlayer>;
  bedsAlive: [boolean, boolean];
  phase: 'countdown' | 'playing' | 'ended';
  phaseEndsAt: number;
  ready: Set<number>;
  lastCountdownSent: number;
  ironAcc: number;
  goldAcc: number;
  emeraldAcc: number;
  /** Arrows currently in flight (stepped one 0.2 s segment per tick). */
  arrows: FlyingArrow[];
}

function broadcastEvent(deps: ServerContext, event: GameEventMsg): void {
  deps.broadcast(event);
}

function sendError(deps: ServerContext, player: ServerPlayer, message: string): void {
  deps.sendTo(player.socket, { type: 'gameEvent', kind: 'error', message });
}

/** Builds a fresh match from the picked roster: teams, spawn teleports, state. */
export function startBedwarsMatch(deps: ServerContext, roster: ServerPlayer[]): Match {
  const m: Match = {
    world: generateBedwarsArena(ARENA_SEED),
    players: new Map(),
    bedsAlive: [true, true],
    phase: 'countdown',
    phaseEndsAt: Date.now() + COUNTDOWN_MS,
    ready: new Set(),
    lastCountdownSent: -1,
    ironAcc: 0,
    goldAcc: 0,
    emeraldAcc: 0,
    arrows: [],
  };
  roster.forEach((entry, index) => {
    const team: 0 | 1 = index === 0 ? 0 : 1;
    const spawn = ARENA.spawns[team];
    entry.x = spawn.x;
    entry.y = spawn.y;
    entry.z = spawn.z;
    entry.yaw = spawn.yaw;
    m.players.set(entry.id, {
      id: entry.id,
      name: entry.name,
      team,
      hp: MAX_HP,
      alive: true,
      respawnAt: 0,
      lastDamageAt: 0,
      lastAttackAt: 0,
      lastRegenAt: 0,
      currency: { iron: 0, gold: 0, emerald: 0 },
      wool: 0,
      planks: 0,
      apples: 0,
      sword: null,
      bow: false,
      arrows: 0,
      kills: 0,
      deaths: 0,
    });
  });
  deps.log(
    `[bedwars] match started — ${roster[0].name} (red)` +
      (roster[1] ? ` vs ${roster[1].name} (blue)` : ' — solo practice'),
  );
  return m;
}

/** modeChanged payload for BedWars (`yourTeam` is the receiver's team, −1 spectates). */
export function bedwarsModeChanged(match: Match, yourTeam: number): ModeChangedMsg {
  return {
    type: 'modeChanged',
    mode: 'bedwars',
    seed: ARENA_SEED,
    edits: match.world.serializeEdits(),
    spawns: ARENA.spawns.map((spawn: ArenaSpawn) => ({ ...spawn })),
    beds: ARENA.beds.map((bed) => ({ ...bed })),
    yourTeam,
  };
}

/** The 5 Hz authoritative snapshot. */
export function bedwarsGameState(match: Match, now: number): GameStateMsg {
  const timeLeft =
    match.phase === 'ended'
      ? 0
      : Math.max(0, Math.round((match.phaseEndsAt - now) / 1000));
  return {
    type: 'gameState',
    phase: match.phase,
    timeLeft,
    bedsAlive: [match.bedsAlive[0], match.bedsAlive[1]],
    players: [...match.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      team: p.team,
      hp: p.hp,
      alive: p.alive,
      respawnIn: !p.alive && p.respawnAt > 0 ? Math.max(0, Math.ceil((p.respawnAt - now) / 1000)) : 0,
      kills: p.kills,
      currency: { ...p.currency },
      inventory: { wool: p.wool, planks: p.planks, apples: p.apples, sword: p.sword, bow: p.bow, arrows: p.arrows },
    })),
  };
}

function endMatch(deps: ServerContext, m: Match, winner: MatchPlayer): void {
  if (m.phase === 'ended') return;
  m.phase = 'ended';
  broadcastEvent(deps, {
    type: 'gameEvent',
    kind: 'matchEnd',
    winnerId: winner.id,
    winnerName: winner.name,
    stats: [...m.players.values()].map((p) => ({ id: p.id, name: p.name, kills: p.kills, deaths: p.deaths })),
  });
  deps.log(`[bedwars] match ended — ${winner.name} wins`);
}

/**
 * The victim's bed just disappeared while they were dead awaiting respawn:
 * the wait is over for good. Emits the eliminating death (respawnIn 0 hides
 * the client's respawn overlay) and ends the match if that decides it.
 * Without this, a bed broken during the 5 s respawn window soft-locks the
 * match — `kill()` already made its elimination check, so nobody can
 * respawn, no final kill can land and `matchEnd` never fires (the rematch
 * playtest deadlock: the "next match" never starts because this one never
 * ends). No-op for living players or those not awaiting a respawn.
 */
function cancelRespawn(deps: ServerContext, m: Match, victim: MatchPlayer | undefined, killerId: number | null): void {
  if (!victim || victim.alive || victim.respawnAt <= 0) return;
  victim.respawnAt = 0;
  broadcastEvent(deps, {
    type: 'gameEvent',
    kind: 'death',
    playerId: victim.id,
    cause: 'combat',
    killerId,
    respawnIn: 0,
  });
  deps.log(`[bedwars] ${victim.name}'s bed fell while respawning — eliminated`);
  const winner = [...m.players.values()].find((p) => p.team !== victim.team);
  if (winner) endMatch(deps, m, winner);
}

function kill(deps: ServerContext, m: Match, victim: MatchPlayer, cause: 'combat' | 'void', killerId: number | null, now: number): void {
  if (!victim.alive) return;
  victim.alive = false;
  victim.hp = 0;
  victim.deaths++;
  const killer = killerId !== null ? m.players.get(killerId) : undefined;
  if (killer && killer.id !== victim.id) killer.kills++;
  const bedAlive = m.bedsAlive[victim.team];
  victim.respawnAt = bedAlive ? now + RESPAWN_MS : 0;
  broadcastEvent(deps, {
    type: 'gameEvent',
    kind: 'death',
    playerId: victim.id,
    cause,
    killerId,
    respawnIn: bedAlive ? RESPAWN_MS / 1000 : 0,
  });
  deps.log(`[bedwars] ${victim.name} died (${cause})${bedAlive ? ' — respawning' : ' — eliminated'}`);
  if (!bedAlive) {
    const winner = [...m.players.values()].find((p) => p.team !== victim.team);
    if (winner) endMatch(deps, m, winner);
  }
}

export function bedwarsAttack(deps: ServerContext, m: Match, player: ServerPlayer, msg: AttackMsg): void {
  if (m.phase !== 'playing') return;
  const attacker = m.players.get(player.id);
  const target = m.players.get(msg.id);
  if (!attacker || !target || attacker.id === target.id) return;
  if (!attacker.alive || !target.alive) return;
  const targetRoster = deps.players.get(msg.id);
  if (!targetRoster) return;
  const now = Date.now();
  if (now - attacker.lastAttackAt < ATTACK_COOLDOWN_MS) return;
  const dist = Math.hypot(targetRoster.x - player.x, targetRoster.y - player.y, targetRoster.z - player.z);
  if (dist > ATTACK_RANGE_SERVER) {
    deps.log(`[bedwars] attack from ${player.name} rejected: out of range (${dist.toFixed(1)})`);
    return;
  }
  attacker.lastAttackAt = now;
  const damage = heldDamage(msg.held, attacker.sword);
  target.hp -= damage;
  target.lastDamageAt = now;
  target.lastRegenAt = now;

  // Knockback: mostly along attacker→target with an upward pop.
  let dx = targetRoster.x - player.x;
  let dz = targetRoster.z - player.z;
  const len = Math.hypot(dx, dz) || 1;
  dx /= len;
  dz /= len;
  broadcastEvent(deps, {
    type: 'gameEvent',
    kind: 'knockback',
    playerId: target.id,
    dir: { x: dx, y: 0.45, z: dz },
    power: KNOCKBACK_BASE + damage * 0.5,
  });
  // v10: both combat paths emit `hit` — the damage-numbers event (§3.3 M6.2).
  broadcastEvent(deps, {
    type: 'gameEvent',
    kind: 'hit',
    targetId: target.id,
    byId: attacker.id,
    damage,
    cause: 'melee',
  });
  deps.log(`[bedwars] ${player.name} hit ${target.name} for ${damage} (hp ${Math.max(0, target.hp)})`);
  if (target.hp <= 0) kill(deps, m, target, 'combat', attacker.id, now);
}

export function bedwarsBuy(deps: ServerContext, m: Match, player: ServerPlayer, msg: BuyMsg): void {
  if (m.phase === 'ended') return;
  const mp = m.players.get(player.id);
  if (!mp || !mp.alive) return;
  const item = SHOP_ITEMS.find((entry) => entry.id === msg.item);
  if (!item) return;
  const roster = deps.players.get(player.id);
  if (!roster) return;
  const shop = ARENA.shopPoints[mp.team];
  const dist = Math.hypot(roster.x - shop.x, roster.y - shop.y, roster.z - shop.z);
  if (dist > ARENA.shopRadius) {
    sendError(deps, player, 'Too far from the shop');
    return;
  }
  if (mp.currency[item.currency] < item.price) {
    sendError(deps, player, `Not enough ${item.currency} — ${item.name} costs ${item.price}`);
    return;
  }
  mp.currency[item.currency] -= item.price;
  switch (item.id) {
    case 'wool':
      mp.wool = Math.min(MAX_STACK, mp.wool + 16);
      break;
    case 'planks':
      mp.planks = Math.min(MAX_STACK, mp.planks + 16);
      break;
    case 'wooden_sword':
      mp.sword = 'wooden';
      break;
    case 'stone_sword':
      mp.sword = 'stone';
      break;
    case 'iron_sword':
      mp.sword = 'iron';
      break;
    case 'golden_apple':
      mp.apples = Math.min(MAX_APPLES, mp.apples + 1);
      break;
    case 'bow':
      mp.bow = true;
      break;
    case 'arrows':
      mp.arrows = Math.min(MAX_STACK, mp.arrows + 6);
      break;
  }
  broadcastEvent(deps, { type: 'gameEvent', kind: 'purchase', playerId: mp.id, item: item.id satisfies ShopItemId });
  deps.log(`[bedwars] ${player.name} bought ${item.name} (${item.price} ${item.currency})`);
}

export function bedwarsUseHeld(deps: ServerContext, m: Match, player: ServerPlayer): void {
  if (m.phase === 'ended') return;
  const mp = m.players.get(player.id);
  if (!mp || !mp.alive) return;
  if (mp.apples <= 0) return;
  if (mp.hp >= MAX_HP) {
    sendError(deps, player, 'Already at full health');
    return;
  }
  mp.apples--;
  mp.hp = Math.min(MAX_HP, mp.hp + HEAL_AMOUNT);
  broadcastEvent(deps, { type: 'gameEvent', kind: 'heal', playerId: mp.id, amount: HEAL_AMOUNT });
}

// --- bow: launch + ballistic flight (protocol v10, §3.3) -----------------------

/**
 * Entry t ∈ [0, 1] of the segment A→A+t·(B−A) into the AABB, or null
 * (slab test — the client/src/combat.ts rayVsAabb shape, segment-scaled).
 */
function segmentVsAabb(
  ax: number,
  ay: number,
  az: number,
  dx: number,
  dy: number,
  dz: number,
  box: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number },
): number | null {
  let tMin = 0;
  let tMax = 1;
  const test = (o: number, d: number, lo: number, hi: number): boolean => {
    if (Math.abs(d) < 1e-9) return o >= lo && o <= hi;
    const inv = 1 / d;
    let t1 = (lo - o) * inv;
    let t2 = (hi - o) * inv;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    return tMin <= tMax;
  };
  if (!test(ax, dx, box.minX, box.maxX)) return null;
  if (!test(ay, dy, box.minY, box.maxY)) return null;
  if (!test(az, dz, box.minZ, box.maxZ)) return null;
  return tMin;
}

/** Removes one arrow (the pool is small — index splice, order = age). */
function removeArrow(m: Match, arrow: FlyingArrow): void {
  const i = m.arrows.indexOf(arrow);
  if (i >= 0) m.arrows.splice(i, 1);
}

/**
 * Flies one 0.2 s ballistic segment (ticks → ticks+1) along the shared
 * parabola (arrowPosition): block raycast + player AABBs along the segment,
 * nearest impact wins. Player hit → damage + knockback along the flight dir
 * + the `hit` event; arrows stop on any impact (no block damage, no pickup).
 */
function stepArrow(deps: ServerContext, m: Match, arrow: FlyingArrow, now: number): void {
  const t0 = arrow.ticks * ARROW_TICK_S;
  arrow.ticks++;
  const t1 = arrow.ticks * ARROW_TICK_S;
  const a = arrowPosition(arrow.from, arrow.dir, arrow.power, t0);
  const b = arrowPosition(arrow.from, arrow.dir, arrow.power, t1);
  // Off the arena into the void — done (the client mirror applies the same cut).
  if (b.y < VOID_KILL_Y) {
    removeArrow(m, arrow);
    return;
  }
  const sx = b.x - a.x;
  const sy = b.y - a.y;
  const sz = b.z - a.z;

  // Block impact along the segment (maxDist 1 = the whole segment; dist is
  // segment-scaled, directly comparable with the AABB ts below).
  const blockHit = raycast(m.world, a, { x: sx, y: sy, z: sz }, 1);
  const tBlock = blockHit !== null ? blockHit.dist : null;

  // Player hits: AABBs around the roster position (the same authoritative
  // source melee range-checks), owner excluded.
  let victim: MatchPlayer | null = null;
  let tVictim: number | null = null;
  for (const p of m.players.values()) {
    if (p.id === arrow.ownerId || !p.alive) continue;
    const roster = deps.players.get(p.id);
    if (!roster) continue;
    const t = segmentVsAabb(
      a.x,
      a.y,
      a.z,
      sx,
      sy,
      sz,
      {
        minX: roster.x - TARGET_HALF_WIDTH,
        minY: roster.y,
        minZ: roster.z - TARGET_HALF_WIDTH,
        maxX: roster.x + TARGET_HALF_WIDTH,
        maxY: roster.y + TARGET_HEIGHT,
        maxZ: roster.z + TARGET_HALF_WIDTH,
      },
    );
    if (t !== null && (tVictim === null || t < tVictim)) {
      victim = p;
      tVictim = t;
    }
  }

  if (victim !== null && (tBlock === null || (tVictim !== null && tVictim <= tBlock))) {
    victim.hp -= arrow.damage;
    victim.lastDamageAt = now;
    victim.lastRegenAt = now;
    // Knockback along the flight dir, melee-shaped (horizontal + 0.45 up-pop).
    let kx = sx;
    let kz = sz;
    const len = Math.hypot(kx, kz);
    if (len > 0.001) {
      kx /= len;
      kz /= len;
    } else {
      kx = 0;
      kz = 0;
    }
    broadcastEvent(deps, {
      type: 'gameEvent',
      kind: 'knockback',
      playerId: victim.id,
      dir: { x: kx, y: 0.45, z: kz },
      power: KNOCKBACK_BASE + arrow.damage * 0.5,
    });
    broadcastEvent(deps, {
      type: 'gameEvent',
      kind: 'hit',
      targetId: victim.id,
      byId: arrow.ownerId,
      damage: arrow.damage,
      cause: 'arrow',
    });
    const shooter = m.players.get(arrow.ownerId);
    deps.log(
      `[bedwars] ${shooter?.name ?? 'Someone'}'s arrow hit ${victim.name} for ${arrow.damage} (hp ${Math.max(0, victim.hp)})`,
    );
    removeArrow(m, arrow);
    if (victim.hp <= 0) kill(deps, m, victim, 'combat', arrow.ownerId, now);
    return;
  }
  if (tBlock !== null) {
    removeArrow(m, arrow); // stuck in terrain — no block damage
    return;
  }
  if (arrow.ticks >= ARROW_MAX_TICKS) removeArrow(m, arrow);
}

/**
 * Loose a charged arrow (v10 `bowShot`): validates phase, ownership, ammo and
 * the shared attack cooldown, spends one arrow, broadcasts `arrowLaunched`
 * and immediately flies the first 0.2 s segment (point-blank shots resolve
 * at once; later segments ride the 200 ms match tick).
 */
export function bedwarsBowShot(deps: ServerContext, m: Match, player: ServerPlayer, msg: BowShotMsg): void {
  if (m.phase !== 'playing') return;
  const shooter = m.players.get(player.id);
  const roster = deps.players.get(player.id);
  if (!shooter || !roster || !shooter.alive) return;
  if (!shooter.bow) return;
  if (shooter.arrows <= 0) return;
  const now = Date.now();
  if (now - shooter.lastAttackAt < ATTACK_COOLDOWN_MS) return;
  shooter.lastAttackAt = now;
  shooter.arrows--;
  const charge = Math.max(ARROW_MIN_CHARGE, Math.min(ARROW_MAX_CHARGE, msg.charge));
  const cosPitch = Math.cos(roster.pitch);
  const dir = {
    x: -Math.sin(roster.yaw) * cosPitch,
    y: Math.sin(roster.pitch),
    z: -Math.cos(roster.yaw) * cosPitch,
  };
  const from = { x: roster.x, y: roster.y + EYE_HEIGHT, z: roster.z };
  const power = arrowSpeed(charge);
  const arrow: FlyingArrow = {
    ownerId: shooter.id,
    damage: arrowDamage(charge),
    from,
    dir,
    power,
    ticks: 0,
  };
  if (m.arrows.length < ARROW_POOL_CAP) m.arrows.push(arrow);
  broadcastEvent(deps, { type: 'gameEvent', kind: 'arrowLaunched', by: shooter.id, from, dir, power });
  stepArrow(deps, m, arrow, now);
  deps.log(
    `[bedwars] ${player.name} fired an arrow (charge ${charge.toFixed(2)}, ${power.toFixed(1)} m/s, ${arrow.damage} dmg, ${shooter.arrows} left)`,
  );
}

/** Applies a BedWars edit; true = handled by the match (caller skips the sandbox path). */
export function bedwarsEdit(deps: ServerContext, m: Match, player: ServerPlayer, msg: BlockEditMsg): boolean {
  const mp = m.players.get(player.id);
  if (!mp) return true; // spectator edits are dropped silently
  const { x, y, z, id } = msg;
  const reject = (why: string): void => {
    rejectEdit(deps.sendTo, m.world, player, { x, y, z }, why, 'bedwars', deps.log);
  };

  if (
    x < 0 || y < 0 || z < 0 ||
    x >= WORLD_SIZE_X || y >= WORLD_SIZE_Y || z >= WORLD_SIZE_Z
  ) {
    reject('out of bounds');
    return true;
  }
  if (id < 0 || id >= BLOCKS.length) {
    reject(`invalid block id ${id}`);
    return true;
  }
  const dist = Math.hypot(x + 0.5 - player.x, y + 0.5 - player.y, z + 0.5 - player.z);
  if (dist > deps.reach) {
    reject(`out of reach (${dist.toFixed(1)} > ${deps.reach})`);
    return true;
  }

  const target = m.world.getBlock(x, y, z);
  if (id === AIR) {
    // Breaking.
    if (target === BED_RED || target === BED_BLUE) {
      const bedTeam = target === BED_RED ? 0 : 1;
      if (bedTeam === mp.team) {
        reject('you cannot break your own bed');
        return true;
      }
      m.world.setBlock(x, y, z, AIR);
      m.bedsAlive[bedTeam] = false;
      deps.broadcast({ type: 'blockEdits', edits: [[x, y, z, AIR]] });
      broadcastEvent(deps, { type: 'gameEvent', kind: 'bedBroken', team: bedTeam, by: player.name });
      deps.log(`[bedwars] ${player.name} broke the ${bedTeam === 0 ? 'red' : 'blue'} bed!`);
      // A fighter of that team may be mid respawn-wait — now eliminated.
      const waiter = [...m.players.values()].find((p) => p.team === bedTeam && !p.alive && p.respawnAt > 0);
      cancelRespawn(deps, m, waiter, player.id);
      return true;
    }
    if (target === AIR) {
      reject('empty cell');
      return true;
    }
    if (BLOCKS[target].unbreakable) {
      reject('unbreakable block');
      return true;
    }
    m.world.setBlock(x, y, z, AIR);
    deps.broadcast({ type: 'blockEdits', edits: [[x, y, z, AIR]] });
    return true;
  }

  // Placing: only shop blocks, only with stock (consumes it).
  if (id !== WOOL_WHITE && id !== PLANKS) {
    reject('only shop blocks are placeable in BedWars');
    return true;
  }
  if (target !== AIR && target !== WATER) {
    reject(`cell occupied by ${BLOCKS[target].name}`);
    return true;
  }
  if (id === WOOL_WHITE) {
    if (mp.wool <= 0) {
      reject('no wool left — buy more at the shop');
      return true;
    }
    mp.wool--;
  } else {
    if (mp.planks <= 0) {
      reject('no planks left — buy more at the shop');
      return true;
    }
    mp.planks--;
  }
  m.world.setBlock(x, y, z, id);
  deps.broadcast({ type: 'blockEdits', edits: [[x, y, z, id]] });
  return true;
}

/** Void-kill detection after every accepted move. */
export function bedwarsOnMoved(deps: ServerContext, m: Match, player: ServerPlayer): void {
  if (m.phase !== 'playing') return;
  const mp = m.players.get(player.id);
  if (!mp || !mp.alive) return;
  if (player.y < VOID_KILL_Y) kill(deps, m, mp, 'void', null, Date.now());
}

/** Disconnect handling: roster removal + win-by-default (registry resets the mode). */
export function bedwarsOnPlayerLeft(deps: ServerContext, m: Match, player: ServerPlayer): void {
  const winner = leaveMidMatch(m, 'bedwars', player, deps.log);
  if (winner) endMatch(deps, m, winner);
}

/** The 200 ms match tick: countdown, sudden death, generators, regen, respawns. */
export function bedwarsTick(deps: ServerContext, m: Match, now: number, dt: number): void {
  if (m.phase !== 'playing') {
    m.arrows.length = 0; // no flight outside the fight (countdown/ended)
  }
  if (m.phase === 'countdown') {
    const seconds = Math.max(0, Math.ceil((m.phaseEndsAt - now) / 1000));
    if (seconds !== m.lastCountdownSent) {
      m.lastCountdownSent = seconds;
      broadcastEvent(deps, { type: 'gameEvent', kind: 'countdown', seconds });
    }
    if (now >= m.phaseEndsAt) {
      m.phase = 'playing';
      m.phaseEndsAt = now + MATCH_MS;
      broadcastEvent(deps, { type: 'gameEvent', kind: 'countdown', seconds: 0 });
      deps.log('[bedwars] FIGHT!');
    }
  } else if (m.phase === 'playing') {
    // Sudden death: at 0:00 both beds auto-break.
    if (now >= m.phaseEndsAt) {
      m.phaseEndsAt = now;
      for (const team of [0, 1] as const) {
        if (m.bedsAlive[team]) {
          m.bedsAlive[team] = false;
          broadcastEvent(deps, { type: 'gameEvent', kind: 'bedBroken', team, by: 'sudden death' });
          deps.log(`[bedwars] sudden death — ${team === 0 ? 'red' : 'blue'} bed broke`);
        }
      }
      // With the beds gone, any respawn still pending is a final silence:
      // cancel those waits (one of them may decide the match).
      for (const p of [...m.players.values()]) cancelRespawn(deps, m, p, null);
    }

    // Island generators: iron 1/1.5 s, gold 1/4 s for every match player;
    // emerald 1/6 s to whoever stands at the mid generator.
    if (dt > 0) {
      m.ironAcc += dt;
      m.goldAcc += dt;
      m.emeraldAcc += dt;
      while (m.ironAcc >= IRON_INTERVAL_S) {
        m.ironAcc -= IRON_INTERVAL_S;
        for (const p of m.players.values()) p.currency.iron++;
      }
      while (m.goldAcc >= GOLD_INTERVAL_S) {
        m.goldAcc -= GOLD_INTERVAL_S;
        for (const p of m.players.values()) p.currency.gold++;
      }
      while (m.emeraldAcc >= EMERALD_INTERVAL_S) {
        m.emeraldAcc -= EMERALD_INTERVAL_S;
        for (const p of m.players.values()) {
          if (!p.alive) continue;
          const roster = deps.players.get(p.id);
          if (!roster) continue;
          const d = Math.hypot(
            roster.x - ARENA.midGenerator.x,
            roster.z - ARENA.midGenerator.z,
          );
          if (d <= ARENA.midGeneratorRadius && Math.abs(roster.y - ARENA.midGenerator.y) < 4) {
            p.currency.emerald++;
          }
        }
      }
    }

    // Regen + respawns.
    for (const p of m.players.values()) {
      if (p.alive) {
        if (
          p.hp < MAX_HP &&
          now - p.lastDamageAt >= REGEN_DELAY_MS &&
          now - p.lastRegenAt >= REGEN_INTERVAL_MS
        ) {
          p.hp++;
          p.lastRegenAt = now;
        }
      } else if (p.respawnAt > 0 && m.bedsAlive[p.team] && now >= p.respawnAt) {
        p.alive = true;
        p.hp = MAX_HP;
        p.respawnAt = 0;
        p.lastDamageAt = 0;
        p.lastRegenAt = now;
        const spawn = ARENA.spawns[p.team];
        const roster = deps.players.get(p.id);
        if (roster) {
          roster.x = spawn.x;
          roster.y = spawn.y;
          roster.z = spawn.z;
          roster.yaw = spawn.yaw;
        }
        broadcastEvent(deps, { type: 'gameEvent', kind: 'respawn', playerId: p.id });
        deps.log(`[bedwars] ${p.name} respawned`);
      }
    }

    // Ballistic arrows: one 0.2 s segment each (launch already flew segment 0).
    for (const arrow of [...m.arrows]) stepArrow(deps, m, arrow, now);
  }

  // 5 Hz authoritative snapshot.
  deps.broadcast(bedwarsGameState(m, now));
}
