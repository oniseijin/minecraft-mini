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
  };
  roster.forEach((entry, index) => {
    const spawn = PARTY.spawns[index] ?? PARTY.spawns[0];
    entry.x = spawn.x;
    entry.y = spawn.y;
    entry.z = spawn.z;
    entry.yaw = spawn.yaw;
    match.players.set(entry.id, { id: entry.id, name: entry.name, score: 0, alive: true, falls: 0 });
  });
  deps.log(`[party] match started — ${roster[0].name} vs ${roster[1].name}`);
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
  deps.log(`[party] round ${match.round}: ${match.colorName} in ${match.roundTimerMs} ms`);
}

function doDrop(deps: PartyDeps, match: PartyMatch, now: number): void {
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
