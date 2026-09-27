/**
 * Block Party 1v1 round loop (DESIGN.md §3.4) — the server-authoritative
 * dance-floor elimination game, imported and dispatched by match.ts.
 *
 * The match world is an empty void world + the spectator platform; the 25×25
 * floor mosaic is per-round edit state. Round loop, driven by the 200 ms tick:
 *
 *   intermission 2.5 s — re-randomize the floor (one blockEdits batch, all
 *     625 cells: no-op cells are skipped by both World.setBlock and the
 *     client's applyServerEdits), reset + re-center both players; the announce
 *     additionally waits for both fighters to report in at their spawn tiles
 *     (a slow client may still be meshing the arena) or until the grace cap,
 *   announce — pick the round color (seeded rand, never twice in a row) and
 *     broadcast it with `roundTimerMs = max(750, 4500 − 300 × completedRounds)`
 *     plus the absolute `roundEndsAt` deadline (clients render the shrinking
 *     countdown + accelerating ticks locally between the 5 Hz snapshots),
 *   drop — every non-announced floor cell vanishes (one batched edit list)
 *     and a 1.5 s fall window opens: a reported position below VOID_KILL_Y
 *     marks that player a faller (alive players below y=29 at window end are
 *     backstopped as fallers too — mid-fall, past saving),
 *   score — exactly one faller: survivor +1; both or neither fall: draw, no
 *     score. First to 3 round wins ends the match (matchEnd, stats carry
 *     rounds/falls); otherwise the next intermission starts.
 *
 * Eliminated players stay for the round as spectators (death event; the
 * client enables free-fly from the spectator platform). Disconnects hand the
 * win to the remaining player; `ready` from both rematches; leaveGame returns
 * everyone to the sandbox (match.ts owns both flows).
 *
 * Auto color bombs (protocol v5, the faithful Hive feature): from round 2,
 * `PARTY_BOMB_RATE` (env, default 0.4) of rounds spawn ONE bomb ~1 s into the
 * announce — but only if ≥ 3 s of announce remain at that moment (late fast
 * rounds naturally have none). The cell is always a NON-announced color, so
 * reaching the blast is a real race. The server owns the 2 s fuse: at
 * `detonatesAt` the 3×3 patch around the cell is painted into the announced
 * safe color (one batched blockEdits stream + `bombDetonated`) — those cells
 * are then ordinary safe floor and survive the drop like any other. Nobody
 * carries or plants anything: camp the patch or sprint for it at the drop.
 * A new round's re-deal overwrites the painted cells as usual. Bombs are
 * cleared each round; the test bot ignores them entirely (v1).
 */
import {
  AIR,
  PARTY,
  PARTY_COLORS,
  PARTY_FLOOR,
  PARTY_SEED,
  VOID_KILL_Y,
  generatePartyFloor,
  generatePartyWorld,
  partyPlatformEdits,
  partyRand,
  type BlockEditMsg,
  type GameStateMsg,
  type MatchEndStats,
  type ModeChangedMsg,
  type PartyPhase,
  type ServerMessage,
  type World,
} from '@mc/shared';
import type { ServerPlayer } from './match';

const INTERMISSION_MS = 2500;
/**
 * Fair-start guard: the announce waits until both fighters' reported
 * positions are at their spawn tiles (slow clients may still be meshing the
 * arena during the intermission) — but never longer than this grace past the
 * normal intermission end, so a stuck client cannot stall the match.
 */
const SETTLE_GRACE_MS = 4000;
const DROP_WINDOW_MS = 1500;
const SCORED_MS = 2000;
/** Announce countdown ramp: 4.5 s shrinking 0.3 s per completed round, floor 0.75 s. */
const ANNOUNCE_BASE_MS = 4500;
const ANNOUNCE_RAMP_MS = 300;
const ANNOUNCE_MIN_MS = 750;
/** Round wins needed to take the match. */
const WINS_NEEDED = 3;
/** At window end, an "alive" player below this feet-y is scored as a faller. */
const FALL_BACKSTOP_Y = 29;

// --- auto color bomb (protocol v5) --------------------------------------------

/** Announce-seconds-in when the bomb appears (if this round gets one). */
const BOMB_DELAY_MS = 1000;
/** Server-authoritative fuse: spawn → detonation. */
const BOMB_FUSE_MS = 2000;
/** The bomb only spawns if this much announce time remains at spawn moment. */
const BOMB_MIN_REMAINING_MS = 3000;
/** Blast paints a (2×radius+1)² disc — the Hive's small 3×3 patch. */
const BOMB_PAINT_RADIUS = 1;
/**
 * Share of rounds (from round 2 on) that get a bomb. Seeded per round, so a
 * given (seed, round) is deterministic for a fixed rate; `PARTY_BOMB_RATE`
 * exists for tests (`PARTY_BOMB_RATE=1` forces a bomb every eligible round).
 */
const rawBombRate = Number(process.env.PARTY_BOMB_RATE ?? 0.4);
const BOMB_RATE = Math.min(1, Math.max(0, Number.isFinite(rawBombRate) ? rawBombRate : 0.4));

export interface PartyDeps {
  players: Map<number, ServerPlayer>;
  sendTo(socket: ServerPlayer['socket'], msg: ServerMessage): void;
  broadcast(msg: ServerMessage): void;
  log(line: string): void;
}

export interface PartyRoundPlayer {
  id: number;
  name: string;
  /** Rounds won. */
  score: number;
  alive: boolean;
  falls: number;
}

export interface PartyMatch {
  world: World;
  seed: number;
  players: Map<number, PartyRoundPlayer>;
  ready: Set<number>;
  phase: PartyPhase | 'ended';
  phaseEndsAt: number;
  /** Latest intermission end + grace — the announce cannot start after this. */
  settleByAt: number;
  /** 1-based round number. */
  round: number;
  /** Scored rounds so far — drives the announce ramp. */
  completedRounds: number;
  colorId: number;
  colorName: string;
  roundTimerMs: number;
  roundEndsAt: number;
  /** Fallers of the open drop window (death events already sent). */
  fallers: Set<number>;
  /** The fused auto bomb while one is on the floor, else null (protocol v5). */
  bomb: PartyBomb | null;
  /**
   * Epoch ms when this announce's bomb should appear (null = this round has
   * none — round 1, rate gate, or too-fast announce). Decided at announce.
   */
  bombSpawnAt: number | null;
}

/** Server-side bomb state (client mirror: PartyBombState in the protocol). */
export interface PartyBomb {
  cx: number;
  cz: number;
  /** The announced color the blast will paint. */
  colorId: number;
  detonatesAt: number;
}

/** Starts a fresh match: void world + platform + the round-1 floor mosaic. */
export function startPartyMatch(deps: PartyDeps, roster: ServerPlayer[]): PartyMatch {
  const world = generatePartyWorld();
  world.applyEdits(partyPlatformEdits());
  world.applyEdits(generatePartyFloor(PARTY_SEED, 1));

  const match: PartyMatch = {
    world,
    seed: PARTY_SEED,
    players: new Map(),
    ready: new Set(),
    phase: 'intermission',
    phaseEndsAt: Date.now() + INTERMISSION_MS,
    settleByAt: Date.now() + INTERMISSION_MS + SETTLE_GRACE_MS,
    round: 1,
    completedRounds: 0,
    colorId: PARTY_COLORS[0].id,
    colorName: PARTY_COLORS[0].name,
    roundTimerMs: ANNOUNCE_BASE_MS,
    roundEndsAt: Date.now(),
    fallers: new Set(),
    bomb: null,
    bombSpawnAt: null,
  };
  roster.forEach((entry, index) => {
    const spawn = PARTY.spawns[index] ?? PARTY.spawns[0];
    entry.x = spawn.x;
    entry.y = spawn.y;
    entry.z = spawn.z;
    entry.yaw = spawn.yaw;
    match.players.set(entry.id, { id: entry.id, name: entry.name, score: 0, alive: true, falls: 0 });
  });
  deps.log(
    `[party] match started — ${roster[0].name}` +
      (roster[1] ? ` vs ${roster[1].name}` : ' — solo practice'),
  );
  return match;
}

/** World-swap payload: initial edits are platform + the current floor mosaic. */
export function partyModeChanged(match: PartyMatch, yourTeam: number): ModeChangedMsg {
  return {
    type: 'modeChanged',
    mode: 'party',
    seed: match.seed,
    edits: match.world.serializeEdits(),
    spawns: PARTY.spawns.map((spawn) => ({ ...spawn })),
    beds: [],
    yourTeam,
  };
}

/** 5 Hz snapshot; the absolute announce deadline lets clients interpolate. */
export function partyGameState(match: PartyMatch, now: number): GameStateMsg {
  return {
    type: 'gameState',
    phase: match.phase,
    timeLeft: Math.max(0, Math.round((match.phaseEndsAt - now) / 1000)),
    bedsAlive: [],
    players: [],
    party: {
      round: match.round,
      colorId: match.colorId,
      colorName: match.colorName,
      roundTimerMs: match.roundTimerMs,
      roundEndsAt: match.phase === 'announce' ? match.roundEndsAt : match.phaseEndsAt,
      scores: [...match.players.values()].map((p) => ({ playerId: p.id, name: p.name, score: p.score, alive: p.alive })),
      bomb: match.bomb
        ? { cell: [match.bomb.cx, match.bomb.cz], colorId: match.bomb.colorId, detonatesAt: match.bomb.detonatesAt }
        : null,
    },
  };
}

/** All client edits are rejected — the floor is fully server-owned. */
export function partyEdit(deps: PartyDeps, match: PartyMatch, player: ServerPlayer, msg: BlockEditMsg): boolean {
  deps.sendTo(player.socket, {
    type: 'blockEdits',
    edits: [[msg.x, msg.y, msg.z, match.world.getBlock(msg.x, msg.y, msg.z)]],
  });
  deps.log(`[party] edit from ${player.name} rejected: the dance floor is server-owned`);
  return true;
}

/** Void kills only count during the drop window, and only for the living. */
export function partyOnMoved(deps: PartyDeps, match: PartyMatch, player: ServerPlayer): void {
  if (match.phase !== 'drop') return;
  const pp = match.players.get(player.id);
  if (!pp || !pp.alive) return;
  if (player.y < VOID_KILL_Y) markFaller(deps, match, pp);
}

function markFaller(deps: PartyDeps, match: PartyMatch, pp: PartyRoundPlayer): void {
  if (!pp.alive) return;
  pp.alive = false;
  pp.falls++;
  match.fallers.add(pp.id);
  deps.broadcast({
    type: 'gameEvent',
    kind: 'death',
    playerId: pp.id,
    cause: 'void',
    killerId: null,
    respawnIn: 0,
  });
  deps.log(`[party] ${pp.name} fell in round ${match.round}`);
}

export function partyTick(deps: PartyDeps, match: PartyMatch, now: number): void {
  tickBomb(deps, match, now); // fuse runs on 200 ms ticks mid-announce
  if (now < match.phaseEndsAt) return;

  switch (match.phase) {
    case 'intermission':
      // Fair start: wait for both fighters to report in at their spawn tiles
      // (or run out of grace) before taking control of the clock again.
      if (now >= match.settleByAt || fightersSettled(deps, match)) {
        beginAnnounce(deps, match, now);
      } else {
        match.phaseEndsAt = now + 200; // re-check on the next ticks
      }
      break;
    case 'announce':
      doDrop(deps, match, now);
      break;
    case 'drop':
      scoreRound(deps, match, now);
      break;
    case 'scored':
      match.round++;
      beginIntermission(deps, match, now);
      break;
    case 'ended':
      break;
  }
}

// --- auto color bomb (protocol v5) ---------------------------------------------

/** Per-tick bomb bookkeeping: the scheduled spawn and the fuse. */
function tickBomb(deps: PartyDeps, match: PartyMatch, now: number): void {
  if (match.phase !== 'announce') return;

  if (match.bomb === null && match.bombSpawnAt !== null && now >= match.bombSpawnAt) {
    match.bombSpawnAt = null;
    spawnBomb(deps, match, now);
  }
  if (match.bomb !== null && now >= match.bomb.detonatesAt) {
    detonateBomb(deps, match);
  }
}

/**
 * Decides at announce time whether this round gets a bomb (round ≥ 2, seeded
 * rate gate, and ≥ 3 s of announce left at the spawn moment — late fast
 * rounds naturally have none) and schedules its appearance +1 s in.
 */
function scheduleBomb(match: PartyMatch, now: number): void {
  match.bomb = null;
  match.bombSpawnAt = null;
  if (match.round < 2) return; // round 1 never has a bomb
  if (partyRand(match.seed, match.round * 31 + 7) >= BOMB_RATE) return;
  if (match.roundTimerMs - BOMB_DELAY_MS < BOMB_MIN_REMAINING_MS) return;
  match.bombSpawnAt = now + BOMB_DELAY_MS;
}

/**
 * Spawns the bomb on a deterministic random floor cell that is currently NOT
 * the announced color — reaching the blast is a real race (forum-endorsed
 * tweak). The floor is complete during announce, so every in-bounds cell
 * holds a wool block.
 */
function spawnBomb(deps: PartyDeps, match: PartyMatch, now: number): void {
  const candidates: [number, number][] = [];
  for (let z = PARTY_FLOOR.minZ; z <= PARTY_FLOOR.maxZ; z++) {
    for (let x = PARTY_FLOOR.minX; x <= PARTY_FLOOR.maxX; x++) {
      if (match.world.getBlock(x, PARTY_FLOOR.y, z) !== match.colorId) candidates.push([x, z]);
    }
  }
  if (candidates.length === 0) return; // whole floor is safe — nothing to boost
  const pick = Math.floor(partyRand(match.seed, match.round * 31 + 13) * candidates.length);
  const [cx, cz] = candidates[Math.min(pick, candidates.length - 1)];
  match.bomb = { cx, cz, colorId: match.colorId, detonatesAt: now + BOMB_FUSE_MS };
  deps.broadcast({ type: 'gameEvent', kind: 'bombSpawned', cell: [cx, cz], colorId: match.colorId });
  deps.log(`[party] round ${match.round}: color bomb fused at (${cx}, ${cz}) — detonates in ${BOMB_FUSE_MS} ms`);
}

/**
 * Fuse is out: paint the 3×3 patch around the bomb into the announced safe
 * color (one batched blockEdits stream). The cells are ordinary safe floor
 * afterwards — they survive the drop with no special-casing, and the next
 * round's re-deal overwrites them as usual.
 */
function detonateBomb(deps: PartyDeps, match: PartyMatch): void {
  const bomb = match.bomb;
  if (!bomb) return;
  match.bomb = null;
  const edits: [number, number, number, number][] = [];
  for (let z = bomb.cz - BOMB_PAINT_RADIUS; z <= bomb.cz + BOMB_PAINT_RADIUS; z++) {
    for (let x = bomb.cx - BOMB_PAINT_RADIUS; x <= bomb.cx + BOMB_PAINT_RADIUS; x++) {
      if (z < PARTY_FLOOR.minZ || z > PARTY_FLOOR.maxZ || x < PARTY_FLOOR.minX || x > PARTY_FLOOR.maxX) continue;
      edits.push([x, PARTY_FLOOR.y, z, match.colorId]);
    }
  }
  match.world.applyEdits(edits);
  deps.broadcast({ type: 'blockEdits', edits });
  deps.broadcast({ type: 'gameEvent', kind: 'bombDetonated', cell: [bomb.cx, bomb.cz], colorId: bomb.colorId });
  deps.log(`[party] round ${match.round}: color bomb detonated at (${bomb.cx}, ${bomb.cz}) — ${edits.length} cells safe`);
}

/** Both fighters' reported positions are at their spawn tiles (±3/±4 blocks). */
function fightersSettled(deps: PartyDeps, match: PartyMatch): boolean {
  const entries = [...match.players.values()];
  if (entries.length === 0) return false;
  return entries.every((pp, index) => {
    const spawn = PARTY.spawns[index] ?? PARTY.spawns[0];
    const roster = deps.players.get(pp.id);
    if (!roster) return false;
    return Math.hypot(roster.x - spawn.x, roster.z - spawn.z) < 3 && Math.abs(roster.y - spawn.y) < 4;
  });
}

function beginIntermission(deps: PartyDeps, match: PartyMatch, now: number): void {
  // Fresh mosaic: broadcast every floor cell (no-op cells are skipped
  // client-side; cells dropped to air last round are re-placed).
  const floor = generatePartyFloor(match.seed, match.round);
  match.world.applyEdits(floor);
  deps.broadcast({ type: 'blockEdits', edits: floor });

  match.fallers.clear();
  match.bomb = null; // any round's bomb business ends with the round
  match.bombSpawnAt = null;
  [...match.players.values()].forEach((pp, index) => {
    pp.alive = true;
    const spawn = PARTY.spawns[index] ?? PARTY.spawns[0];
    const roster = deps.players.get(pp.id);
    if (roster) {
      roster.x = spawn.x;
      roster.y = spawn.y;
      roster.z = spawn.z;
      roster.yaw = spawn.yaw;
    }
  });

  match.phase = 'intermission';
  match.phaseEndsAt = now + INTERMISSION_MS;
  match.settleByAt = now + INTERMISSION_MS + SETTLE_GRACE_MS;
  deps.broadcast({ type: 'gameEvent', kind: 'roundStart', round: match.round });
  const standings = [...match.players.values()].map((p) => `${p.name} ${p.score}`).join(' — ');
  deps.log(`[party] round ${match.round} starting (${standings})`);
}

function beginAnnounce(deps: PartyDeps, match: PartyMatch, now: number): void {
  match.roundTimerMs = Math.max(ANNOUNCE_MIN_MS, ANNOUNCE_BASE_MS - ANNOUNCE_RAMP_MS * match.completedRounds);
  let slot = Math.floor(partyRand(match.seed, match.round) * PARTY_COLORS.length);
  if (PARTY_COLORS[slot].id === match.colorId) slot = (slot + 1) % PARTY_COLORS.length; // never twice in a row
  match.colorId = PARTY_COLORS[slot].id;
  match.colorName = PARTY_COLORS[slot].name;
  match.roundEndsAt = now + match.roundTimerMs;
  match.phase = 'announce';
  match.phaseEndsAt = match.roundEndsAt;
  scheduleBomb(match, now); // may arm this round's auto color bomb (+1 s)
  deps.log(`[party] round ${match.round}: ${match.colorName} in ${match.roundTimerMs} ms`);
}

function doDrop(deps: PartyDeps, match: PartyMatch, now: number): void {
  // Any bomb still fused (cannot happen with the ≥3 s gate — defensive) or
  // armed fizzles silently: the drop ends the round's bomb business.
  match.bomb = null;
  match.bombSpawnAt = null;
  const edits: [number, number, number, number][] = [];
  for (let z = PARTY_FLOOR.minZ; z <= PARTY_FLOOR.maxZ; z++) {
    for (let x = PARTY_FLOOR.minX; x <= PARTY_FLOOR.maxX; x++) {
      if (match.world.getBlock(x, PARTY_FLOOR.y, z) !== match.colorId) {
        edits.push([x, PARTY_FLOOR.y, z, AIR]);
      }
    }
  }
  match.world.applyEdits(edits);
  deps.broadcast({ type: 'blockEdits', edits });
  deps.broadcast({ type: 'gameEvent', kind: 'drop' });
  match.phase = 'drop';
  match.phaseEndsAt = now + DROP_WINDOW_MS;
  deps.log(`[party] round ${match.round} floor dropped — ${match.colorName} survives`);
}

function scoreRound(deps: PartyDeps, match: PartyMatch, now: number): void {
  // Backstop: anyone still "alive" but mid-fall below floor level loses too.
  for (const pp of match.players.values()) {
    if (!pp.alive) continue;
    const roster = deps.players.get(pp.id);
    if (roster && roster.y < FALL_BACKSTOP_Y) markFaller(deps, match, pp);
  }

  const fallers = [...match.fallers];
  const survivor = fallers.length === 1
    ? [...match.players.values()].find((p) => p.alive) ?? null
    : null;
  if (survivor) survivor.score++;
  const draw = fallers.length !== 1;
  deps.broadcast({ type: 'gameEvent', kind: 'roundResult', round: match.round, fallers, survivorId: survivor?.id ?? null, draw });
  match.completedRounds++;

  const winner = [...match.players.values()].find((p) => p.score >= WINS_NEEDED);
  if (winner) {
    endMatch(deps, match, winner);
  } else {
    match.phase = 'scored';
    match.phaseEndsAt = now + SCORED_MS;
    deps.log(
      `[party] round ${match.round} ${draw ? 'draw' : `${survivor?.name} survives`} — ` +
        `${fallers.length} fell`,
    );
  }
}

function endMatch(deps: PartyDeps, match: PartyMatch, winner: PartyRoundPlayer): void {
  match.phase = 'ended';
  match.phaseEndsAt = Date.now();
  const stats: MatchEndStats[] = [...match.players.values()].map((p) => ({
    id: p.id,
    name: p.name,
    kills: 0,
    deaths: p.falls,
    rounds: p.score,
    falls: p.falls,
  }));
  deps.broadcast({ type: 'gameEvent', kind: 'matchEnd', winnerId: winner.id, winnerName: winner.name, stats });
  deps.log(`[party] match ended — ${winner.name} wins ${winner.score} round(s)`);
}

/** Rematch vote; true when both participants are ready (caller restarts). */
export function partyReady(match: PartyMatch, player: ServerPlayer): boolean {
  if (match.phase !== 'ended' || !match.players.has(player.id)) return false;
  match.ready.add(player.id);
  return match.ready.size >= Math.min(2, match.players.size);
}

/** Disconnect handling; true when the match just ended by dropout. */
export function partyOnPlayerLeft(deps: PartyDeps, match: PartyMatch, player: ServerPlayer): boolean {
  match.ready.delete(player.id);
  const pp = match.players.get(player.id);
  if (!pp) return false;
  match.players.delete(player.id);
  deps.log(`[party] ${player.name} left mid-match`);
  if (match.phase !== 'ended') {
    const remaining = [...match.players.values()][0];
    if (remaining) {
      endMatch(deps, match, remaining); // win by default
      return true;
    }
  }
  return false;
}
