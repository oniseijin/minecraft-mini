/**
 * Server-driven test bot (protocol v4) — a dummy second player so ONE human
 * can test all 2-player features solo. The bot is a regular roster entry
 * (`ServerPlayer` with `bot: true`, `socket: null`): it shows up in roster
 * snapshots (flagged via `PlayerSnapshot.bot`), counts toward the player
 * count and is dealt into match rosters like any player — one human + the
 * bot is a REAL 1v1, not solo practice.
 *
 * The brain is driven by index.ts on a 10 Hz timer (`tick`) and behaves per
 * mode; the position it writes is fed through the SAME paths a human client
 * uses (`modeManager.onMoved` for void kills + party falls, `modeManager.
 * attack` for combat — identical range/cooldown/damage validation, fist only):
 *
 * - SANDBOX: wander — pick a target within 24 blocks every 3–6 s (20% idle),
 *   walk 4 m/s, hop up 1-block ledges, follow small drops. Never edits blocks
 *   or chats. If it ends up swimming (water at sea level), it heads back
 *   toward spawn and climbs the nearest bank. Targets stay within radius 110
 *   of the island center.
 * - BEDWARS: real opponent — spawns/patrols its own team island (team 1 when
 *   one human + bot; the high id sorts last). When the human is within 10
 *   blocks it walks toward them and, inside 3.2 blocks, melee-attacks through
 *   `modeManager.attack` (range 4.5 / 0.5 s cooldown / fist 2 — a human
 *   validation, just a cautious engagement distance). It can die (combat or
 *   void) and respawns at its island while its bed stands; its bed is
 *   breakable by the human, who wins the real way. It never buys or builds.
 * - PARTY: stands at a random floor cell near its spawn slot each round
 *   (walks there during the announce); on the drop it stands if its cell has
 *   the announced color, otherwise it falls (server physics-lite — the same
 *   void-kill path marks it a faller). Round scoring treats it as a normal
 *   player.
 * - Added MID-match (not one of the two fighters), it idles at the mode's
 *   spectator spawn.
 *
 * `removeBot` mid-match runs the bot through the regular `onPlayerLeft`
 * path: the remaining human wins by default, exactly like a disconnect.
 */
import {
  ARENA,
  PARTY,
  PARTY_FLOOR,
  SEA_LEVEL,
  WATER,
  WORLD_SIZE_X,
  WORLD_SIZE_Z,
  type GameMode,
  type MatchPhase,
  type PartyPhase,
  type World,
} from '@mc/shared';
import type { ServerPlayer } from './match';

/** Fixed roster id (humans get low ids; the high id sorts LAST in match rosters). */
export const BOT_ID = 900001;
export const BOT_NAME = 'Bot Steve';

const WALK_SPEED = 4; // m/s — human walk pace
const GRAVITY = 30; // m/s² — matches the client physics
const JUMP_SPEED = 8.4; // clears 1 block (v²/2g ≈ 1.18)
const ENGAGE_DIST = 10; // start chasing the enemy within this
const ATTACK_DIST = 3.2; // cautious melee engagement distance
const ATTACK_EVERY_MS = 600; // server cooldown is 500 — keep slack
const ISLAND_CENTER = { x: 128.5, z: 128.5 }; // sandbox spawn / swim-home point
const ISLAND_RADIUS = 110; // sandbox wander clamp (of the island center)

/** What the brain needs to know about the current mode (built by match.ts). */
export interface BotInfo {
  mode: GameMode;
  /** World whose terrain the bot walks on (sandbox, arena or party world). */
  world: World;
  phase: MatchPhase | PartyPhase | null;
  /** BedWars team / party spawn slot while the bot is IN the match; else null. */
  team: 0 | 1 | null;
  /** BedWars: roster id of the human opponent (null when none). */
  enemyId: number | null;
  /** Party: 1-based round number + announced color (party wool block id). */
  round: number;
  colorId: number;
  /** Whether the bot's own match entry is alive (a party faller is not). */
  selfAlive: boolean;
  /** Where a non-participant bot idles during a running match. */
  spectator: { x: number; y: number; z: number } | null;
}

export interface BotDeps {
  players: Map<number, ServerPlayer>;
  /** Current mode/world/match info (modeManager.botInfo). */
  info(): BotInfo;
  /** Attacks through the exact human path (modeManager.attack). */
  attack(targetId: number): void;
  /** Feeds the bot's position through the human move path (void kills, party falls). */
  onMoved(): void;
  log(line: string): void;
}

export interface Bot {
  readonly player: ServerPlayer;
  /** @internal Brain state — shared with the movement helpers in this module. */
  readonly brain: Brain;
  /** Advance the brain + physics; called on a timer (~10 Hz). */
  tick(now: number): void;
}

interface Brain {
  mode: GameMode;
  round: number;
  lastTickAt: number;
  targetX: number;
  targetZ: number;
  /** Epoch ms of the next wander re-decision. */
  decideAt: number;
  idle: boolean;
  yVel: number;
  airborne: boolean;
  /** Party: the floor vanished underfoot — fall with no landing. */
  falling: boolean;
  lastAttackAt: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** Feet ground level for a world column (top solid block + 1; 0 over void). */
function groundY(world: World, x: number, z: number): number {
  return world.highestBlock(Math.floor(x), Math.floor(z)) + 1;
}

/** Team island center (generateBedwarsArena: island(64,64) / island(192,64)). */
function islandCenter(team: 0 | 1): { x: number; z: number } {
  const bed = ARENA.beds[team];
  return { x: bed.x + (team === 0 ? 3 : -3), z: bed.z };
}

export function createBot(deps: BotDeps): Bot {
  const player: ServerPlayer = {
    id: BOT_ID,
    name: BOT_NAME,
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    pitch: 0,
    socket: null,
    lastSeen: 0,
    bot: true,
  };
  const brain: Brain = {
    mode: 'sandbox',
    round: 0,
    lastTickAt: 0,
    targetX: 0,
    targetZ: 0,
    decideAt: 0,
    idle: true,
    yVel: 0,
    airborne: false,
    falling: false,
    lastAttackAt: 0,
  };
  const bot: Bot = { player, brain, tick: (now) => tick(bot, deps, now) };
  return bot;
}

// --- per-mode brains ---------------------------------------------------------

function tick(bot: Bot, deps: BotDeps, now: number): void {
  const brain = bot.brain;
  const dt = brain.lastTickAt === 0 ? 0.1 : Math.min((now - brain.lastTickAt) / 1000, 0.5);
  brain.lastTickAt = now;
  const info = deps.info();
  bot.player.lastSeen = now;

  if (info.mode !== brain.mode) {
    brain.mode = info.mode;
    brain.round = info.round;
    brain.airborne = false;
    brain.yVel = 0;
    brain.falling = false;
    brain.idle = true;
    brain.decideAt = 0;
    brain.lastAttackAt = 0;
    if (info.mode === 'party' && info.team !== null) pickPartyCell(bot, info.team);
  } else if (info.mode === 'party' && info.round !== brain.round) {
    // New round: fresh cell, back on the re-placed floor.
    brain.round = info.round;
    brain.airborne = false;
    brain.yVel = 0;
    brain.falling = false;
    brain.idle = true;
    if (info.team !== null) pickPartyCell(bot, info.team);
  }

  if (info.mode === 'party') partyTick(bot, deps, info, dt);
  else if (info.mode === 'bedwars') bedwarsTick(bot, deps, info, now, dt);
  else sandboxTick(bot, deps, info, now, dt);

  // The same position feed a human client gets: void kills (bedwars) and
  // party fall marking both validate against this.
  deps.onMoved();
}

function sandboxTick(bot: Bot, deps: BotDeps, info: BotInfo, now: number, dt: number): void {
  const brain = bot.brain;
  const p = bot.player;

  // Swimming? Head home and climb the nearest bank (buoyed, no ledge limits).
  if (info.world.getBlock(Math.floor(p.x), SEA_LEVEL, Math.floor(p.z)) === WATER) {
    brain.idle = false;
    const dx = ISLAND_CENTER.x - p.x;
    const dz = ISLAND_CENTER.z - p.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 0.35) {
      const step = Math.min(WALK_SPEED * dt, dist);
      moveHorizontally(bot, p.x + (dx / dist) * step, p.z + (dz / dist) * step);
    }
    const g = groundY(info.world, p.x, p.z);
    p.y += clamp(g - p.y, -4 * dt, 4 * dt);
    return;
  }

  if (now >= brain.decideAt) {
    // Pick a fresh wander target within 24 blocks, clamped to the island.
    brain.decideAt = now + 3000 + Math.random() * 3000;
    if (Math.random() < 0.2) {
      brain.idle = true;
      brain.targetX = p.x;
      brain.targetZ = p.z;
    } else {
      brain.idle = false;
      for (let attempt = 0; attempt < 6; attempt++) {
        const ang = Math.random() * Math.PI * 2;
        const r = 6 + Math.random() * 18;
        const x = clamp(p.x + Math.cos(ang) * r, 2, WORLD_SIZE_X - 2);
        const z = clamp(p.z + Math.sin(ang) * r, 2, WORLD_SIZE_Z - 2);
        const dc = Math.hypot(x - ISLAND_CENTER.x, z - ISLAND_CENTER.z);
        const fx = dc > ISLAND_RADIUS ? ISLAND_CENTER.x + ((x - ISLAND_CENTER.x) / dc) * ISLAND_RADIUS : x;
        const fz = dc > ISLAND_RADIUS ? ISLAND_CENTER.z + ((z - ISLAND_CENTER.z) / dc) * ISLAND_RADIUS : z;
        // Prefer dry land; the swim-home path covers the rest.
        if (attempt < 5 && info.world.getBlock(Math.floor(fx), SEA_LEVEL, Math.floor(fz)) === WATER) continue;
        brain.targetX = fx;
        brain.targetZ = fz;
        break;
      }
    }
  }
  if (brain.idle) return;
  if (stepTowards(bot, info, brain.targetX, brain.targetZ, WALK_SPEED, dt, true)) brain.idle = true;
}

function bedwarsTick(bot: Bot, deps: BotDeps, info: BotInfo, now: number, dt: number): void {
  const brain = bot.brain;
  const p = bot.player;
  if (info.team === null) {
    parkAt(bot, info); // joined mid-match → spectate
    return;
  }
  if (!info.selfAlive) return; // dead — the respawn teleports the roster entry

  const enemyId = info.enemyId;
  const enemy = enemyId !== null ? deps.players.get(enemyId) : undefined;
  const dist = enemy ? Math.hypot(enemy.x - p.x, enemy.z - p.z) : Infinity;
  if (enemy && enemyId !== null && dist <= ENGAGE_DIST) {
    // Defend: close in, then swing through the same validated attack path.
    faceTowards(bot, enemy.x, enemy.z);
    if (dist > ATTACK_DIST) {
      stepTowards(bot, info, enemy.x, enemy.z, WALK_SPEED, dt, false);
    } else if (info.phase === 'playing' && now - brain.lastAttackAt >= ATTACK_EVERY_MS) {
      brain.lastAttackAt = now;
      deps.attack(enemyId);
    }
    return;
  }

  // Patrol the home island (flat top — walls/ledges are simply avoided).
  if (now >= brain.decideAt) {
    brain.decideAt = now + 2500 + Math.random() * 3000;
    if (Math.random() < 0.25) {
      brain.idle = true;
    } else {
      brain.idle = false;
      const center = islandCenter(info.team);
      const ang = Math.random() * Math.PI * 2;
      const r = Math.random() * 3;
      brain.targetX = center.x + Math.cos(ang) * r;
      brain.targetZ = center.z + Math.sin(ang) * r;
    }
  }
  if (!brain.idle) stepTowards(bot, info, brain.targetX, brain.targetZ, WALK_SPEED, dt, false);
}

function partyTick(bot: Bot, deps: BotDeps, info: BotInfo, dt: number): void {
  const brain = bot.brain;
  const p = bot.player;
  if (info.team === null) {
    parkAt(bot, info); // joined mid-match → spectate from the platform
    return;
  }

  if (brain.falling) {
    // The floor vanished underfoot: gravity only, like a real fallen player
    // (onMoved marks the faller once y passes the void kill plane).
    brain.yVel -= GRAVITY * dt;
    p.y += brain.yVel * dt;
    if (p.y < 4) p.y = 4; // park below the kill plane
    return;
  }

  if (info.phase === 'drop') {
    // Stand or fall depending on the color underfoot.
    const fx = Math.floor(p.x);
    const fz = Math.floor(p.z);
    const onFloor =
      fx >= PARTY_FLOOR.minX && fx <= PARTY_FLOOR.maxX && fz >= PARTY_FLOOR.minZ && fz <= PARTY_FLOOR.maxZ;
    const color = info.world.getBlock(fx, PARTY_FLOOR.y, fz);
    if (!onFloor || color !== info.colorId) {
      brain.falling = true;
      brain.yVel = 0;
      deps.log(`[bot] round ${info.round}: cell color ${color} ≠ announced ${info.colorId} — falling`);
    }
    return; // right color → freeze in place (survivor)
  }

  if (info.phase === 'announce') {
    brain.idle = false;
    stepTowards(bot, info, brain.targetX, brain.targetZ, WALK_SPEED, dt, false);
  }
  // intermission/scored: stand at the slot spawn (the mode re-centers it).
}

// --- shared movement helpers ---------------------------------------------------

/**
 * One walker step toward (tx, tz); true on arrival. Hops up 1-block ledges,
 * snaps down small drops; walls (>1) are blocked, and ledges/drops >1 are
 * blocked unless `allowDrops` (sandbox cliffs are fine, arena void is not).
 */
function stepTowards(
  bot: Bot,
  info: BotInfo,
  tx: number,
  tz: number,
  speed: number,
  dt: number,
  allowDrops: boolean,
): boolean {
  const brain = bot.brain;
  const p = bot.player;
  const dx = tx - p.x;
  const dz = tz - p.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.35) return true;
  const step = Math.min(speed * dt, dist);
  const nx = p.x + (dx / dist) * step;
  const nz = p.z + (dz / dist) * step;

  if (!brain.airborne) {
    const rise = groundY(info.world, nx, nz) - p.y;
    if (rise < -1.05 && !allowDrops) return false; // ledge/void — stay on the island
    if (rise > 0.05 && !allowDrops) return false; // arenas are flat; beds/pads are walls
    if (rise > 1.05) return false; // wall — too tall to hop
    if (rise > 0.05) {
      brain.airborne = true; // 1-block ledge → hop
      brain.yVel = JUMP_SPEED;
    }
  }
  moveHorizontally(bot, nx, nz);
  if (brain.airborne) {
    integrateVertical(bot, info, dt);
  } else {
    const drop = p.y - groundY(info.world, p.x, p.z);
    if (drop > 0.05) {
      if (drop <= 1.05) p.y -= drop; // small step down
      else {
        brain.airborne = true; // walked off a ledge — fall
        brain.yVel = 0;
      }
    }
  }
  return dist - step < 0.35;
}

/** Turns + advances horizontally (world-bounded); vertical state untouched. */
function moveHorizontally(bot: Bot, nx: number, nz: number): void {
  const p = bot.player;
  faceTowards(bot, nx, nz);
  p.x = clamp(nx, 0.5, WORLD_SIZE_X - 0.5);
  p.z = clamp(nz, 0.5, WORLD_SIZE_Z - 0.5);
}

/** Ballistic vertical step; lands (and clears `airborne`) on the ground. */
function integrateVertical(bot: Bot, info: BotInfo, dt: number): void {
  const brain = bot.brain;
  const p = bot.player;
  const g = groundY(info.world, p.x, p.z);
  brain.yVel -= GRAVITY * dt;
  p.y += brain.yVel * dt;
  if (p.y <= g) {
    p.y = g;
    brain.yVel = 0;
    brain.airborne = false;
  }
}

/** Player-style yaw facing (x, z); level pitch. */
function faceTowards(bot: Bot, x: number, z: number): void {
  const p = bot.player;
  p.yaw = Math.atan2(-(x - p.x), -(z - p.z));
  p.pitch = 0;
}

/** A random floor cell within ~4 cells of the slot's spawn (reachable in one announce). */
function pickPartyCell(bot: Bot, slot: 0 | 1): void {
  const brain = bot.brain;
  const spawn = PARTY.spawns[slot] ?? PARTY.spawns[0];
  brain.targetX =
    clamp(Math.floor(spawn.x) + Math.round((Math.random() - 0.5) * 8), PARTY_FLOOR.minX, PARTY_FLOOR.maxX) + 0.5;
  brain.targetZ =
    clamp(Math.floor(spawn.z) + Math.round((Math.random() - 0.5) * 8), PARTY_FLOOR.minZ, PARTY_FLOOR.maxZ) + 0.5;
}

/** Non-participant during a running match: idle at the mode's spectator spawn. */
function parkAt(bot: Bot, info: BotInfo): void {
  const s = info.spectator;
  if (!s) return;
  bot.player.x = s.x;
  bot.player.y = s.y;
  bot.player.z = s.z;
  bot.player.yaw = 0;
  bot.player.pitch = 0;
}
