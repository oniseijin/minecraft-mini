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
 *
 * Mystery boxes + power-ups (protocol v7, DESIGN.md §3.4.3): from round 2,
 * each round spawns 1 box (60% of rounds) or 2 (20%) ~0.5 s into the announce
 * at random free floor cells — the trailing player's boxes bias toward their
 * position (±6 cells, the Mario-Party rubber-band). Walking within 0.8 blocks
 * picks the box up (20 Hz move checks + 5 Hz tick): a weighted random item
 * (Leap 25 / Speed 25 / Jump 20 / Swapper 15 / Teleporter 15) goes into the
 * next free slot of 3; at 3 held a pickup is refused (anti-hoard) and a
 * second teleporter is always refused. Items persist across rounds and are
 * cleared at match end. `useItem {slot}` works in the announce phase only,
 * locked in the final 2 s (both rejections toast via `error` events):
 *   Leap       — velocity impulse along look (+8 h / +5 v; `leap` event),
 *   Speed/Jump — server-tracked 5 s buffs pushed via the snapshot `effects`
 *                (the owning client multiplies its own movement),
 *   Swapper    — swaps both fighters' roster positions (both clients teleport
 *                via `swapped`); needs a living opponent,
 *   Teleporter — moves the user to the nearest announced-color cell
 *                (`teleported`); refused while mid-fall below floor level.
 * The test bot ignores boxes and never uses items (v1).
 *
 * Spectator Color Zapper: when a player falls they may, once before the round
 * is scored (drop + scored phases), `zapCell {x, z}` ONE surviving floor cell
 * — it crumbles (blockEdit to air) with a `cellZapped` event on both clients.
 * `PARTY_BOX_RATE` (share of box rounds, default 0.8), `PARTY_BOX_COUNT`
 * (force 1–2 boxes per eligible round) and `PARTY_ITEM` (force the item in
 * every box) exist for tests.
 */
import {
  AIR,
  EFFECT_DURATION_MS,
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
  type PartyBoxState,
  type PartyEffectState,
  type PartyItemId,
  type PartyItemsState,
  type PartyPhase,
  type ServerMessage,
  type World,
  type ZapCellMsg,
} from '@mc/shared';
import type { ServerPlayer } from './match';
import { leaveMidMatch, rejectEdit, type ServerContext } from './matchLifecycle';

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

// --- mystery boxes + power-ups (protocol v7) -----------------------------------

/** Announce-seconds-in when the round's mystery boxes appear (if any). */
const BOX_DELAY_MS = 500;
/** Walk-over pickup radius (cell-center distance) + feet-y slack. */
const BOX_PICKUP_RADIUS = 0.8;
const BOX_PICKUP_Y_SLACK = 2;
/** Anti-hoard hold cap (Hive's "someone with 6 teleporters" problem). */
const HOLD_CAP = 3;
/** Second-life item: at most one held at a time. */
const TELEPORTER_CAP = 1;
/** Item use is locked inside the final stretch of the announce timer. */
const USE_LOCKOUT_MS = 2000;
/**
 * Speed / Jump Boost duration + client-applied magnitudes (§3.4.3): the
 * numbers live in @mc/shared — EFFECT_DURATION_MS here, and the client-side
 * multipliers SPEED_EFFECT_MULTIPLIER / JUMP_EFFECT_SPEED that this server
 * never applies itself (it only pushes absolute expiry epoch ms).
 */
/** Leap dash impulse (m/s): horizontal along look + vertical pop. */
export const LEAP_HORIZONTAL = 8;
export const LEAP_VERTICAL = 5;
/** Teleporter guard: feet at least this close to floor level to warp. */
const TELEPORTER_MIN_Y = PARTY_FLOOR.y + 0.9;
/** Catch-up bias: the trailing player's boxes spawn within ±6 cells. */
const BOX_CATCHUP_RADIUS = 6;

/** Weighted item odds (§3.4.3): Leap 25, Speed 25, Jump 20, Swapper 15, Teleporter 15. */
const ITEM_WEIGHTS: readonly (readonly [PartyItemId, number])[] = [
  ['leap', 25],
  ['speed', 25],
  ['jump', 20],
  ['swapper', 15],
  ['teleporter', 15],
];
const ITEM_WEIGHT_TOTAL = ITEM_WEIGHTS.reduce((sum, [, weight]) => sum + weight, 0);

const RAW_BOX_RATE = Number(process.env.PARTY_BOX_RATE ?? 0.8);
const BOX_RATE = Math.min(1, Math.max(0, Number.isFinite(RAW_BOX_RATE) ? RAW_BOX_RATE : 0.8));
/**
 * Test knobs: `PARTY_BOX_COUNT` (1 or 2) forces the box count of every
 * eligible round (bypassing the 60%/20% rolls); `PARTY_ITEM` forces the item
 * inside every box (validated against the item ids, else ignored).
 */
const RAW_BOX_COUNT = Number(process.env.PARTY_BOX_COUNT ?? 0);
const FORCED_BOX_COUNT = RAW_BOX_COUNT === 1 || RAW_BOX_COUNT === 2 ? RAW_BOX_COUNT : 0;
const RAW_ITEM = process.env.PARTY_ITEM ?? '';
const FORCED_ITEM: PartyItemId | null =
  ITEM_WEIGHTS.some(([id]) => id === RAW_ITEM) ? (RAW_ITEM as PartyItemId) : null;

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
  /** Mystery boxes currently on the floor (v7; cleared at the drop). */
  boxes: PartyBox[];
  /** Epoch ms when this announce's boxes should appear (null = none). */
  boxSpawnAt: number | null;
  /** How many boxes this announce spawns (decided at announce). */
  boxCount: number;
  /** Held item slots per player (oldest first — slot 0..2). */
  items: Map<number, PartyItemId[]>;
  /** Active speed/jump buffs (absolute epoch ms expiry, 0 = inactive). */
  effects: Map<number, { speedUntil: number; jumpUntil: number }>;
  /** Fallers of the open round with an unused Color Zapper shot. */
  zapReady: Set<number>;
  /** Salt counter so item rolls don't repeat within a round. */
  itemRollSeq: number;
}

/** Server-side mystery box (client mirror: PartyBoxState in the protocol). */
export interface PartyBox {
  cx: number;
  cz: number;
  /** Players already told "satchel full" about this box (toast throttling). */
  refusedFor: Set<number>;
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
export function startPartyMatch(deps: ServerContext, roster: ServerPlayer[]): PartyMatch {
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
    boxes: [],
    boxSpawnAt: null,
    boxCount: 0,
    items: new Map(),
    effects: new Map(),
    zapReady: new Set(),
    itemRollSeq: 0,
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
  const items: PartyItemsState = {};
  for (const [playerId, held] of match.items) {
    if (held.length > 0) items[playerId] = [...held];
  }
  const effects: PartyEffectState[] = [];
  for (const [playerId, fx] of match.effects) {
    if (fx.speedUntil > now) effects.push({ playerId, effect: 'speed', until: fx.speedUntil });
    if (fx.jumpUntil > now) effects.push({ playerId, effect: 'jump', until: fx.jumpUntil });
  }
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
      boxes: match.boxes.map((box) => ({ cell: [box.cx, box.cz] as [number, number] })),
      items,
      effects,
    },
  };
}

/** All client edits are rejected — the floor is fully server-owned. */
export function partyEdit(deps: ServerContext, match: PartyMatch, player: ServerPlayer, msg: BlockEditMsg): boolean {
  rejectEdit(deps.sendTo, match.world, player, msg, 'the dance floor is server-owned', 'party', deps.log);
  return true;
}

/** Void kills only count during the drop window; boxes are picked up on announce moves. */
export function partyOnMoved(deps: ServerContext, match: PartyMatch, player: ServerPlayer): void {
  if (match.phase === 'announce') {
    checkBoxPickups(deps, match);
    return;
  }
  if (match.phase !== 'drop') return;
  const pp = match.players.get(player.id);
  if (!pp || !pp.alive) return;
  if (player.y < VOID_KILL_Y) markFaller(deps, match, pp);
}

function markFaller(deps: ServerContext, match: PartyMatch, pp: PartyRoundPlayer): void {
  if (!pp.alive) return;
  pp.alive = false;
  pp.falls++;
  match.fallers.add(pp.id);
  match.zapReady.add(pp.id); // the fallen player earns their one Color Zapper shot
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

export function partyTick(deps: ServerContext, match: PartyMatch, now: number): void {
  tickBomb(deps, match, now); // fuse runs on 200 ms ticks mid-announce
  tickBoxes(deps, match, now); // scheduled box spawn + lazy pickup checks
  expireEffects(match, now);
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
function tickBomb(deps: ServerContext, match: PartyMatch, now: number): void {
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
function spawnBomb(deps: ServerContext, match: PartyMatch, now: number): void {
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
function detonateBomb(deps: ServerContext, match: PartyMatch): void {
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

// --- mystery boxes + power-ups (protocol v7) -----------------------------------

/** Per-tick box bookkeeping: the scheduled spawn, plus lazy pickup checks. */
function tickBoxes(deps: ServerContext, match: PartyMatch, now: number): void {
  if (match.phase !== 'announce') return;
  if (match.boxes.length === 0 && match.boxSpawnAt !== null && now >= match.boxSpawnAt) {
    match.boxSpawnAt = null;
    spawnBoxes(deps, match);
  }
  if (match.boxes.length > 0) checkBoxPickups(deps, match);
}

/**
 * Decides at announce time whether this round gets mystery boxes (round ≥ 2;
 * `PARTY_BOX_COUNT` forces the count for tests, otherwise 80% of rounds get
 * boxes — 75% of those one box, 25% two, i.e. 60% / 20% of all rounds) and
 * schedules their appearance +0.5 s in.
 */
function scheduleBoxes(match: PartyMatch, now: number): void {
  match.boxes = [];
  match.boxSpawnAt = null;
  match.boxCount = 0;
  if (match.round < 2) return; // round 1 never has boxes
  if (FORCED_BOX_COUNT > 0) {
    match.boxCount = FORCED_BOX_COUNT;
  } else {
    if (partyRand(match.seed, match.round * 57 + 11) >= BOX_RATE) return;
    match.boxCount = partyRand(match.seed, match.round * 57 + 12) < 0.25 ? 2 : 1;
  }
  match.boxSpawnAt = now + BOX_DELAY_MS;
}

/**
 * Spawns the round's mystery boxes on free floor cells. The trailing player's
 * boxes spawn within ±6 cells of their position (catch-up bias); without a
 * trailer (or with no free cell near them) boxes fall back to fully random
 * free cells. Emits one `boxSpawned` event per box.
 */
function spawnBoxes(deps: ServerContext, match: PartyMatch): void {
  const count = match.boxCount;
  match.boxCount = 0;
  if (count <= 0) return;
  const entries = [...match.players.values()].sort((a, b) => a.score - b.score);
  const trailer =
    entries.length === 2 && entries[0].score < entries[1].score ? deps.players.get(entries[0].id) ?? null : null;

  const taken = new Set<string>();
  for (let i = 0; i < count; i++) {
    const cell = pickBoxCell(match, trailer, taken, i);
    if (!cell) break;
    taken.add(`${cell.cx},${cell.cz}`);
    match.boxes.push({ cx: cell.cx, cz: cell.cz, refusedFor: new Set() });
    deps.broadcast({ type: 'gameEvent', kind: 'boxSpawned', cell: [cell.cx, cell.cz] });
    deps.log(
      `[party] round ${match.round}: mystery box at (${cell.cx}, ${cell.cz})` +
        (trailer ? ` (bias: near ${trailer.name})` : ''),
    );
  }
}

/** A random free floor cell, biased around `near` (a roster position) if given. */
function pickBoxCell(
  match: PartyMatch,
  near: ServerPlayer | null,
  taken: Set<string>,
  saltIndex: number,
): { cx: number; cz: number } | null {
  const free = (cx: number, cz: number): boolean =>
    !taken.has(`${cx},${cz}`) && !match.boxes.some((box) => box.cx === cx && box.cz === cz);

  if (near) {
    const px = Math.min(PARTY_FLOOR.maxX, Math.max(PARTY_FLOOR.minX, Math.floor(near.x)));
    const pz = Math.min(PARTY_FLOOR.maxZ, Math.max(PARTY_FLOOR.minZ, Math.floor(near.z)));
    const nearCells: { cx: number; cz: number }[] = [];
    for (let z = Math.max(PARTY_FLOOR.minZ, pz - BOX_CATCHUP_RADIUS); z <= Math.min(PARTY_FLOOR.maxZ, pz + BOX_CATCHUP_RADIUS); z++) {
      for (let x = Math.max(PARTY_FLOOR.minX, px - BOX_CATCHUP_RADIUS); x <= Math.min(PARTY_FLOOR.maxX, px + BOX_CATCHUP_RADIUS); x++) {
        if (free(x, z)) nearCells.push({ cx: x, cz: z });
      }
    }
    if (nearCells.length > 0) {
      return nearCells[Math.floor(partyRand(match.seed, match.round * 57 + 21 + saltIndex) * nearCells.length)] ?? null;
    }
  }

  const all: { cx: number; cz: number }[] = [];
  for (let z = PARTY_FLOOR.minZ; z <= PARTY_FLOOR.maxZ; z++) {
    for (let x = PARTY_FLOOR.minX; x <= PARTY_FLOOR.maxX; x++) {
      if (free(x, z)) all.push({ cx: x, cz: z });
    }
  }
  if (all.length === 0) return null;
  return all[Math.floor(partyRand(match.seed, match.round * 57 + 31 + saltIndex) * all.length)] ?? null;
}

/** Walk-over pickup check for every living (non-bot) fighter — 20 Hz moves + tick. */
function checkBoxPickups(deps: ServerContext, match: PartyMatch): void {
  if (match.phase !== 'announce' || match.boxes.length === 0) return;
  for (const pp of match.players.values()) {
    if (!pp.alive || match.boxes.length === 0) continue;
    const roster = deps.players.get(pp.id);
    if (!roster || roster.bot) continue; // the test bot ignores boxes (v1)
    tryPickup(deps, match, pp, roster);
  }
}

function tryPickup(deps: ServerContext, match: PartyMatch, pp: PartyRoundPlayer, roster: ServerPlayer): void {
  const held = match.items.get(pp.id) ?? [];
  for (let i = match.boxes.length - 1; i >= 0; i--) {
    const box = match.boxes[i];
    const dist = Math.hypot(roster.x - (box.cx + 0.5), roster.z - (box.cz + 0.5));
    if (dist > BOX_PICKUP_RADIUS || Math.abs(roster.y - (PARTY_FLOOR.y + 1)) > BOX_PICKUP_Y_SLACK) continue;

    if (held.length >= HOLD_CAP) {
      if (!box.refusedFor.has(pp.id)) {
        box.refusedFor.add(pp.id);
        deps.sendTo(roster.socket, { type: 'gameEvent', kind: 'error', message: 'Satchel full — 3 items max!' });
        deps.log(`[party] ${pp.name} could not pick up the box at (${box.cx}, ${box.cz}): hold cap`);
      }
      continue;
    }
    const item = rollItem(match, held);
    if (item === 'teleporter' && held.filter((id) => id === 'teleporter').length >= TELEPORTER_CAP) {
      if (!box.refusedFor.has(pp.id)) {
        box.refusedFor.add(pp.id);
        deps.sendTo(roster.socket, { type: 'gameEvent', kind: 'error', message: 'Only one Color Teleporter at a time!' });
        deps.log(`[party] ${pp.name} could not pick up the box at (${box.cx}, ${box.cz}): teleporter cap`);
      }
      continue;
    }
    held.push(item);
    match.items.set(pp.id, held);
    match.boxes.splice(i, 1);
    deps.broadcast({ type: 'gameEvent', kind: 'boxPickedUp', playerId: pp.id, item });
    deps.log(`[party] ${pp.name} picked up ${item} (${held.length}/${HOLD_CAP} held)`);
  }
}

/** Weighted random item (`PARTY_ITEM` forces it for tests). */
function rollItem(match: PartyMatch, held: readonly PartyItemId[]): PartyItemId {
  if (FORCED_ITEM !== null) return FORCED_ITEM;
  let roll = partyRand(match.seed, match.round * 131 + match.itemRollSeq++ * 17 + 5) * ITEM_WEIGHT_TOTAL;
  for (const [id, weight] of ITEM_WEIGHTS) {
    roll -= weight;
    if (roll < 0) return id;
  }
  return ITEM_WEIGHTS[ITEM_WEIGHTS.length - 1][0];
}

/** Drops expired effect entries so the map (and snapshot) stay small. */
function expireEffects(match: PartyMatch, now: number): void {
  for (const [playerId, fx] of match.effects) {
    if (fx.speedUntil <= now && fx.jumpUntil <= now) match.effects.delete(playerId);
  }
}

/**
 * Uses one held item slot. Announce phase only, locked in the final 2 s of
 * the timer (both rejections toast via `error` events); the item is consumed
 * only when its effect applies.
 */
export function partyUseItem(deps: ServerContext, match: PartyMatch, player: ServerPlayer, slot: number): void {
  const now = Date.now();
  const fail = (message: string): void => {
    deps.sendTo(player.socket, { type: 'gameEvent', kind: 'error', message });
    deps.log(`[party] useItem from ${player.name} rejected: ${message}`);
  };
  if (match.phase !== 'announce') return fail('Items only work during the color announce!');
  const pp = match.players.get(player.id);
  if (!pp || !pp.alive) return fail('Only living dancers can use items');
  if (match.roundEndsAt - now <= USE_LOCKOUT_MS) return fail('Locked — final 2 seconds!');
  const held = match.items.get(player.id) ?? [];
  if (slot < 0 || slot >= held.length || !Number.isInteger(slot)) return fail('No item in that slot');
  const item = held[slot];

  switch (item) {
    case 'leap': {
      held.splice(slot, 1);
      // Client yaw convention: yaw 0 faces −Z; forward = (−sin, −cos).
      deps.broadcast({
        type: 'gameEvent',
        kind: 'leap',
        playerId: player.id,
        dir: { x: -Math.sin(player.yaw) * LEAP_HORIZONTAL, y: LEAP_VERTICAL, z: -Math.cos(player.yaw) * LEAP_HORIZONTAL },
      });
      break;
    }
    case 'speed':
    case 'jump': {
      held.splice(slot, 1);
      const until = now + EFFECT_DURATION_MS;
      const fx = match.effects.get(player.id) ?? { speedUntil: 0, jumpUntil: 0 };
      if (item === 'speed') fx.speedUntil = until;
      else fx.jumpUntil = until;
      match.effects.set(player.id, fx);
      break;
    }
    case 'swapper': {
      const other = [...match.players.values()].find((entry) => entry.id !== player.id && entry.alive);
      const otherRoster = other ? deps.players.get(other.id) : undefined;
      if (!other || !otherRoster) return fail('No opponent to swap with');
      held.splice(slot, 1);
      const ax = player.x;
      const ay = player.y;
      const az = player.z;
      player.x = otherRoster.x;
      player.y = otherRoster.y;
      player.z = otherRoster.z;
      otherRoster.x = ax;
      otherRoster.y = ay;
      otherRoster.z = az;
      deps.broadcast({
        type: 'gameEvent',
        kind: 'swapped',
        aId: player.id,
        bId: other.id,
        a: { x: player.x, y: player.y, z: player.z },
        b: { x: ax, y: ay, z: az },
      });
      break;
    }
    case 'teleporter': {
      if (player.y < TELEPORTER_MIN_Y) return fail("Can't teleport while falling!");
      const cell = nearestColorCell(match, player.x, player.z);
      if (!cell) return fail('No safe tile to teleport to');
      held.splice(slot, 1);
      player.x = cell.x;
      player.y = PARTY_FLOOR.y + 1;
      player.z = cell.z;
      deps.broadcast({ type: 'gameEvent', kind: 'teleported', playerId: player.id, x: player.x, y: player.y, z: player.z });
      break;
    }
  }

  deps.broadcast({ type: 'gameEvent', kind: 'itemUsed', playerId: player.id, item });
  deps.log(`[party] ${player.name} used ${item}`);
}

/**
 * Nearest surviving announced-color cell to (x, z) — Chebyshev rings outward
 * from the player's cell, closest Euclidean match within the first ring that
 * has any. The whole floor is intact during announce, so color = block id.
 */
function nearestColorCell(match: PartyMatch, x: number, z: number): { x: number; z: number } | null {
  const px = Math.min(PARTY_FLOOR.maxX, Math.max(PARTY_FLOOR.minX, Math.floor(x)));
  const pz = Math.min(PARTY_FLOOR.maxZ, Math.max(PARTY_FLOOR.minZ, Math.floor(z)));
  for (let radius = 0; radius <= Math.max(PARTY_FLOOR.maxX - PARTY_FLOOR.minX, PARTY_FLOOR.maxZ - PARTY_FLOOR.minZ); radius++) {
    let best: { x: number; z: number } | null = null;
    let bestDist = Infinity;
    for (let cz = pz - radius; cz <= pz + radius; cz++) {
      for (let cx = px - radius; cx <= px + radius; cx++) {
        if (Math.max(Math.abs(cx - px), Math.abs(cz - pz)) !== radius) continue; // ring edge only
        if (cx < PARTY_FLOOR.minX || cx > PARTY_FLOOR.maxX || cz < PARTY_FLOOR.minZ || cz > PARTY_FLOOR.maxZ) continue;
        if (match.world.getBlock(cx, PARTY_FLOOR.y, cz) !== match.colorId) continue;
        const dist = Math.hypot(cx + 0.5 - x, cz + 0.5 - z);
        if (dist < bestDist) {
          bestDist = dist;
          best = { x: cx + 0.5, z: cz + 0.5 };
        }
      }
    }
    if (best) return best;
  }
  return null;
}

// --- spectator Color Zapper (protocol v7) ---------------------------------------

/**
 * The round faller's one revenge shot: remove a surviving floor cell during
 * the fall→scored window (drop + scored phases). Once per fall; the cell must
 * currently be the announced color (i.e. it survived the drop).
 */
export function partyZapCell(deps: ServerContext, match: PartyMatch, player: ServerPlayer, msg: ZapCellMsg): void {
  const fail = (message: string): void => {
    deps.sendTo(player.socket, { type: 'gameEvent', kind: 'error', message });
    deps.log(`[party] zapCell from ${player.name} rejected: ${message}`);
  };
  if (match.phase !== 'drop' && match.phase !== 'scored') return fail('The zapper only works after you fall');
  if (!match.zapReady.has(player.id)) return fail('No zap left this round');
  const { x, z } = msg;
  if (x < PARTY_FLOOR.minX || x > PARTY_FLOOR.maxX || z < PARTY_FLOOR.minZ || z > PARTY_FLOOR.maxZ) {
    return fail('Aim at a dance-floor tile!');
  }
  if (match.world.getBlock(x, PARTY_FLOOR.y, z) !== match.colorId) {
    return fail('That tile is already gone!');
  }
  match.zapReady.delete(player.id);
  match.world.setBlock(x, PARTY_FLOOR.y, z, AIR);
  deps.broadcast({ type: 'blockEdits', edits: [[x, PARTY_FLOOR.y, z, AIR]] });
  deps.broadcast({ type: 'gameEvent', kind: 'cellZapped', by: player.id, cell: [x, z] });
  deps.log(`[party] ${player.name} zapped the floor cell (${x}, ${z})`);
}

/** Both fighters' reported positions are at their spawn tiles (±3/±4 blocks). */
function fightersSettled(deps: ServerContext, match: PartyMatch): boolean {  const entries = [...match.players.values()];
  if (entries.length === 0) return false;
  return entries.every((pp, index) => {
    const spawn = PARTY.spawns[index] ?? PARTY.spawns[0];
    const roster = deps.players.get(pp.id);
    if (!roster) return false;
    return Math.hypot(roster.x - spawn.x, roster.z - spawn.z) < 3 && Math.abs(roster.y - spawn.y) < 4;
  });
}

function beginIntermission(deps: ServerContext, match: PartyMatch, now: number): void {
  // Fresh mosaic: broadcast every floor cell (no-op cells are skipped
  // client-side; cells dropped to air last round are re-placed).
  const floor = generatePartyFloor(match.seed, match.round);
  match.world.applyEdits(floor);
  deps.broadcast({ type: 'blockEdits', edits: floor });

  match.fallers.clear();
  match.bomb = null; // any round's bomb business ends with the round
  match.bombSpawnAt = null;
  match.boxes = []; // unclaimed boxes vanish with the round
  match.boxSpawnAt = null;
  match.boxCount = 0;
  match.zapReady.clear(); // the zapper window closes when the next round starts
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

function beginAnnounce(deps: ServerContext, match: PartyMatch, now: number): void {
  match.roundTimerMs = Math.max(ANNOUNCE_MIN_MS, ANNOUNCE_BASE_MS - ANNOUNCE_RAMP_MS * match.completedRounds);
  let slot = Math.floor(partyRand(match.seed, match.round) * PARTY_COLORS.length);
  if (PARTY_COLORS[slot].id === match.colorId) slot = (slot + 1) % PARTY_COLORS.length; // never twice in a row
  match.colorId = PARTY_COLORS[slot].id;
  match.colorName = PARTY_COLORS[slot].name;
  match.roundEndsAt = now + match.roundTimerMs;
  match.phase = 'announce';
  match.phaseEndsAt = match.roundEndsAt;
  scheduleBomb(match, now); // may arm this round's auto color bomb (+1 s)
  scheduleBoxes(match, now); // may arm this round's mystery boxes (+0.5 s)
  deps.log(`[party] round ${match.round}: ${match.colorName} in ${match.roundTimerMs} ms`);
}

function doDrop(deps: ServerContext, match: PartyMatch, now: number): void {
  // Any bomb still fused (cannot happen with the ≥3 s gate — defensive) or
  // armed fizzles silently: the drop ends the round's bomb business.
  match.bomb = null;
  match.bombSpawnAt = null;
  // Unclaimed mystery boxes vanish at the drop (items already held persist).
  match.boxes = [];
  match.boxSpawnAt = null;
  match.boxCount = 0;
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

function scoreRound(deps: ServerContext, match: PartyMatch, now: number): void {
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

function endMatch(deps: ServerContext, match: PartyMatch, winner: PartyRoundPlayer): void {
  match.phase = 'ended';
  match.phaseEndsAt = Date.now();
  match.items.clear(); // held items are cleared at match end (§3.4.3)
  match.effects.clear();
  match.boxes = [];
  match.zapReady.clear();
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

/** Disconnect handling; true when the match just ended by dropout. */
export function partyOnPlayerLeft(deps: ServerContext, match: PartyMatch, player: ServerPlayer): boolean {
  const winner = leaveMidMatch(match, 'party', player, deps.log);
  if (!winner) return false;
  endMatch(deps, match, winner); // win by default
  return true;
}
