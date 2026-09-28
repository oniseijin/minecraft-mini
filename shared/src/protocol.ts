/**
 * Wire protocol (DESIGN.md §3.2) — JSON text frames carrying discriminated
 * unions. Block edits travel as flat `[x, y, z, blockId]` quads (EditTuple).
 * The deterministic world is NEVER sent: clients generate terrain from the
 * server's `seed` and apply its edit overlay.
 *
 * M4 adds the BedWars 1v1 mode: `startGame`/`ready`/`leaveGame`/`attack`/
 * `buy`/`useHeld` (C→S) and `modeChanged`/`gameState`/`gameEvent` (S→C).
 * `gameEvent` is a tagged union (`kind`) covering bedBroken, death, respawn,
 * knockback, purchase, heal, matchEnd, countdown and toast-able errors.
 *
 * M5 (Block Party 1v1) rides the same frames: `startGame` gains a `mode`
 * ('bedwars' | 'party'), `modeChanged` may carry a 'party' world swap, party
 * `gameState` snapshots add the optional `party` payload (round, color,
 * deadlines, scores) and `gameEvent` gains roundStart/drop/roundResult.
 *
 * V4 adds the server-driven test bot: `addBot`/`removeBot` (C→S) and an
 * optional `bot` flag on `PlayerSnapshot`. The bot is otherwise a regular
 * roster player — no new S→C frames.
 *
 * V5 adds the Block Party auto color bomb (server-driven, no player actions):
 * the party `gameState` payload gains `bomb` (fused bomb cell + detonation
 * deadline, null when none) and `gameEvent` gains `bombSpawned`/`bombDetonated`.
 * No new C→S messages — v4 clients parsing a v5 server simply ignore the
 * extra payload field and unknown gameEvent kinds (parsers reject unknown
 * kinds, which only drops the cosmetic event).
 *
 * V6 adds sandbox mobs (DESIGN.md §3.5, M5.3 Phase 1): the server relays a
 * dirty-only `mobs` snapshot ({id, kind, x, y, z, yaw, hp} per animal) plus a
 * one-shot `mobDied`, and clients punch mobs via `attackMob {id}` — validated
 * server-side like player attacks (range + per-player cooldown).
 *
 * V7 adds Block Party mystery boxes + power-ups (DESIGN.md §3.4.3): the party
 * `gameState` payload gains `boxes` (live mystery-box cells), `items`
 * (per-player held item slots, ≤3) and `effects` (active speed/jump buffs with
 * absolute expiry); clients use held items via `useItem {slot}` and the round's
 * faller gets ONE spectate zap via `zapCell {x, z}`. New gameEvents:
 * boxSpawned, boxPickedUp, itemUsed, leap, teleported, swapped, cellZapped.
 * All additions are optional-field tolerant in the same spirit as v5: a v7
 * parser accepts v6 payloads (missing fields default to empty), and v6 clients
 * parsing a v7 server ignore the extra payload fields and unknown gameEvents.
 *
 * V8 adds the mob Phase 2 (DESIGN.md §3.5, M5.4): the `MobKind` union grows
 * 'zombie' + 'giraffe', the `mobs` snapshot gains `dayT` (the server's shared
 * day-night phase 0..1 — absent on v7 servers, so the parser stays tolerant)
 * and `gameEvent` gains `shoved {playerId, mobId, dir, power}` — a zombie's
 * contact shove using the exact knockback event client math (dir is the
 * velocity delta to ADD). Zombies are deathless to players (no health/damage
 * in the sandbox); punching one is validated by the existing attackMob path.
 *
 * `parseClientMessage` / `parseServerMessage` validate the *shape* of incoming
 * JSON (finite numbers, integer coords); policy (name/chat sanitizing, reach,
 * occupancy) stays server-side.
 */

import type { EditTuple } from './world';
import type { ShopItemId, SwordTier } from './shop';

/** One player's state in a roster snapshot. */
export interface PlayerSnapshot {
  id: number;
  name: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  /** Present (true) only for the server-driven test bot. */
  bot?: boolean;
}

// --- client → server --------------------------------------------------------

export interface HelloMsg {
  type: 'hello';
  name: string;
}

/** Client throttles to 20 Hz; server clamps to world bounds ± slack. */
export interface MoveMsg {
  type: 'move';
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

/** Server validates (bounds, id, occupancy, unbreakable, reach) and relays. */
export interface BlockEditMsg {
  type: 'blockEdit';
  x: number;
  y: number;
  z: number;
  id: number;
}

export interface ChatSendMsg {
  type: 'chat';
  text: string;
}

/** Ask the server to start a match (needs exactly 2 players online). */
export interface StartGameMsg {
  type: 'startGame';
  /** Which game to start; absent on v2-era clients means 'bedwars'. */
  mode: 'bedwars' | 'party';
}

/** Rematch vote during the `ended` phase — both players must send it. */
export interface ReadyMsg {
  type: 'ready';
}

/** Leave the match; everyone returns to the sandbox world. */
export interface LeaveGameMsg {
  type: 'leaveGame';
}

/** Client-side melee hit: `id` is the target player, `held` the selected item. */
export interface AttackMsg {
  type: 'attack';
  id: number;
  held: HeldItemId;
}

/** Shop purchase near the team's island shop; server validates currency. */
export interface BuyMsg {
  type: 'buy';
  item: ShopItemId;
}

/** Consume the held item (golden apple heal). */
export interface UseHeldMsg {
  type: 'useHeld';
}

/**
 * Ask the server to spawn the server-driven test bot (at most one at a time).
 * The bot is a regular roster player — clients render its avatar/nameplate
 * from the normal snapshots; v4 just needs the request frames.
 */
export interface AddBotMsg {
  type: 'addBot';
}

/** Remove the test bot again (mid-match this counts as its disconnect). */
export interface RemoveBotMsg {
  type: 'removeBot';
}

/** Punch a sandbox mob (protocol v6); the server validates range + cooldown. */
export interface AttackMobMsg {
  type: 'attackMob';
  id: number;
}

/**
 * Use one held Block Party item slot (protocol v7, 0–2). The server validates
 * party mode, announce phase, the final-2 s lockout and slot occupancy;
 * rejections arrive as `error` gameEvents (client toasts them).
 */
export interface UseItemMsg {
  type: 'useItem';
  slot: number;
}

/**
 * Spectate Color Zapper (protocol v7): the round's faller removes ONE
 * surviving floor cell during the fall→scored window. Server validates the
 * sender, the once-per-fall limit and that the cell survives the drop.
 */
export interface ZapCellMsg {
  type: 'zapCell';
  x: number;
  z: number;
}

/** What the attacker claims to hold — `fist` or an owned shop item. */
export type HeldItemId = 'fist' | ShopItemId;

export type ClientMessage =
  | HelloMsg
  | MoveMsg
  | BlockEditMsg
  | ChatSendMsg
  | StartGameMsg
  | ReadyMsg
  | LeaveGameMsg
  | AttackMsg
  | AttackMobMsg
  | BuyMsg
  | UseHeldMsg
  | UseItemMsg
  | ZapCellMsg
  | AddBotMsg
  | RemoveBotMsg;

// --- server → client --------------------------------------------------------

export interface WelcomeMsg {
  type: 'welcome';
  playerId: number;
  /** The sanitized (possibly deduped) name the server assigned. */
  name: string;
  seed: number;
  /** Persistent edit overlay to apply on top of the locally generated world. */
  edits: EditTuple[];
  /** Current roster, excluding the joining player. */
  players: PlayerSnapshot[];
}

/** 20 Hz roster snapshot, broadcast only when something changed. */
export interface PlayersMsg {
  type: 'players';
  players: PlayerSnapshot[];
}

/** Broadcast to ALL clients (including the editor, as the ack). */
export interface BlockEditsMsg {
  type: 'blockEdits';
  edits: EditTuple[];
}

export interface ChatBroadcastMsg {
  type: 'chat';
  from: string;
  text: string;
}

/** A player left; removal is also covered by the next players snapshot. */
export interface LeftMsg {
  type: 'left';
  id: number;
}

// --- sandbox mobs (protocol v6; v8 adds zombies + giraffes, DESIGN.md §3.5) ---

export type MobKind = 'fox' | 'boar' | 'giraffe' | 'zombie';

/** One mob in a `mobs` snapshot (feet-center position, like players). */
export interface MobSnapshot {
  id: number;
  kind: MobKind;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Remaining hit points (fox 6, boar 10, giraffe 14, zombie 10; a fist punch deals 2). */
  hp: number;
}

/**
 * Dirty-only mob relay (~5 Hz while anything moved); absent mobs despawned.
 * `dayT` (v8) is the server's shared day-night phase 0..1 — clients re-anchor
 * their cosmetic sky to it and it is what zombies are gated on. Absent on v7
 * servers (the parser treats it as optional).
 */
export interface MobsMsg {
  type: 'mobs';
  mobs: MobSnapshot[];
  dayT?: number;
}

/** A mob's hp hit 0 — clients play a poof; the server respawns it later. */
export interface MobDiedMsg {
  type: 'mobDied';
  id: number;
  kind: MobKind;
  /** Feet position where it died (poof origin). */
  at: [number, number, number];
}

export type GameMode = 'sandbox' | 'bedwars' | 'party';

export interface ModeSpawn {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export interface ModeBed {
  x: number;
  y: number;
  z: number;
}

/**
 * World swap: bedwars carries the arena seed, its (usually fresh) edit
 * overlay, team-indexed spawns + beds and the recipient's team (−1 =
 * spectator). Party carries an empty void world + the initial floor/platform
 * edits and the recipient's spawn slot (−1 = spectator). Sandbox carries the
 * original seed + the persistent overlay.
 */
export interface ModeChangedMsg {
  type: 'modeChanged';
  mode: GameMode;
  seed: number;
  edits: EditTuple[];
  spawns: ModeSpawn[];
  beds: ModeBed[];
  yourTeam: number;
}

export interface CurrencyState {
  iron: number;
  gold: number;
  emerald: number;
}

export interface InventoryState {
  wool: number;
  planks: number;
  apples: number;
  sword: SwordTier | null;
}

export interface MatchPlayerState {
  id: number;
  name: string;
  team: number;
  hp: number;
  alive: boolean;
  /** Seconds until respawn (0 while alive or eliminated). */
  respawnIn: number;
  kills: number;
  currency: CurrencyState;
  inventory: InventoryState;
}

export type MatchPhase = 'countdown' | 'playing' | 'ended';

/** Block Party round phases (inside one match). */
export type PartyPhase = 'intermission' | 'announce' | 'drop' | 'scored';

/** Per-player round score line (party mode). */
export interface PartyScoreEntry {
  playerId: number;
  name: string;
  score: number;
  alive: boolean;
}

/**
 * A fused auto color bomb (protocol v5): floor cell [x, z], the block id it
 * will paint (the round's announced safe color) and the server epoch ms when
 * its fuse ends and the 3×3 patch is painted.
 */
export interface PartyBombState {
  /** Floor cell [x, z] the bomb sits on (the block layer is PARTY_FLOOR.y). */
  cell: [number, number];
  /** The announced safe color (a party wool block id) the blast paints. */
  colorId: number;
  /** Server epoch ms of detonation — clients interpolate the fuse locally. */
  detonatesAt: number;
}

// --- Block Party mystery boxes + power-ups (protocol v7, §3.4.3) --------------

/** The five Mystery Box items (weighted spawn odds, announce-phase use). */
export type PartyItemId = 'leap' | 'speed' | 'jump' | 'swapper' | 'teleporter';

/** One mystery box on the floor: its cell (pick up by walking within 0.8). */
export interface PartyBoxState {
  cell: [number, number];
}

/** An active movement buff pushed to its owner via the party snapshot. */
export interface PartyEffectState {
  playerId: number;
  effect: 'speed' | 'jump';
  /** Server epoch ms when the effect ends — clients apply it until then. */
  until: number;
}

/** Held item slots by player id (≤ HOLD_CAP=3 entries; teleporter ≤ 1). */
export interface PartyItemsState {
  [playerId: number]: PartyItemId[];
}

/**
 * The party payload of a `gameState` snapshot (present only while the party
 * mode runs; bedwars snapshots keep the flat fields above). `roundEndsAt` is
 * the server's epoch-ms deadline for the current phase so clients can render
 * the shrinking countdown locally at full frame rate between the 5 Hz
 * snapshots — clocks on one LAN are effectively in sync.
 */
export interface PartyStatePayload {
  round: number;
  /** Announced floor color: a party wool block id (20–27). */
  colorId: number;
  /** Human color name ("Teal") for the colorblind-friendly UI. */
  colorName: string;
  /** Announce duration of the CURRENT round (ms) — the bar's full width. */
  roundTimerMs: number;
  /** Server epoch ms when the announce ends and the floor drops. */
  roundEndsAt: number;
  scores: PartyScoreEntry[];
  /** The fused auto bomb while one is on the floor, else null (v5). */
  bomb: PartyBombState | null;
  /** Mystery boxes currently on the floor (v7; cleared at the drop). */
  boxes: PartyBoxState[];
  /** Held item slots per player (v7; persist across rounds, cleared at match end). */
  items: PartyItemsState;
  /** Active speed/jump buffs with absolute expiry (v7; owner applies locally). */
  effects: PartyEffectState[];
}

/** 5 Hz authoritative match snapshot (bedwars, or party via `party`). */
export interface GameStateMsg {
  type: 'gameState';
  phase: MatchPhase | PartyPhase;
  /** BedWars: seconds left in the phase. Party: seconds until the drop. */
  timeLeft: number;
  bedsAlive: boolean[];
  players: MatchPlayerState[];
  party?: PartyStatePayload;
}

export interface MatchEndStats {
  id: number;
  name: string;
  kills: number;
  deaths: number;
  /** Party mode: rounds won + times fallen (kills/deaths stay 0/falls). */
  rounds?: number;
  falls?: number;
}

export type GameEventMsg =
  | { type: 'gameEvent'; kind: 'bedBroken'; team: number; by: string }
  | {
      type: 'gameEvent';
      kind: 'death';
      playerId: number;
      cause: 'combat' | 'void';
      killerId: number | null;
      /** Seconds until respawn, 0 when eliminated. */
      respawnIn: number;
    }
  | { type: 'gameEvent'; kind: 'respawn'; playerId: number }
  | {
      type: 'gameEvent';
      kind: 'knockback';
      playerId: number;
      /** Normalized-ish impulse direction (slight upward bias). */
      dir: { x: number; y: number; z: number };
      power: number;
    }
  | { type: 'gameEvent'; kind: 'purchase'; playerId: number; item: ShopItemId }
  | { type: 'gameEvent'; kind: 'heal'; playerId: number; amount: number }
  // --- Block Party (M5) ---
  /** A round's intermission began: floor re-randomized, players re-centered. */
  | { type: 'gameEvent'; kind: 'roundStart'; round: number }
  /** The announced color's rivals just vanished — 1.5 s to fall or stand. */
  | { type: 'gameEvent'; kind: 'drop' }
  | {
      type: 'gameEvent';
      kind: 'roundResult';
      round: number;
      /** Player ids that fell this round. */
      fallers: number[];
      /** The lone survivor (null on a draw — both fell or neither did). */
      survivorId: number | null;
      draw: boolean;
    }
  // --- Block Party auto color bomb (protocol v5) ---
  /** A fused bomb appeared on a (non-safe) floor cell — server-driven only. */
  | { type: 'gameEvent'; kind: 'bombSpawned'; cell: [number, number]; colorId: number }
  /** The fuse ran out: the 3×3 patch around the cell is now the safe color. */
  | { type: 'gameEvent'; kind: 'bombDetonated'; cell: [number, number]; colorId: number }
  // --- Block Party mystery boxes + power-ups (protocol v7) ---
  /** A mystery box appeared on a free floor cell (~0.5 s into the announce). */
  | { type: 'gameEvent'; kind: 'boxSpawned'; cell: [number, number] }
  /** A player walked over a mystery box and gained the item inside. */
  | { type: 'gameEvent'; kind: 'boxPickedUp'; playerId: number; item: PartyItemId }
  /** A held item was consumed (announce phase, outside the final-2 s lockout). */
  | { type: 'gameEvent'; kind: 'itemUsed'; playerId: number; item: PartyItemId }
  /**
   * Leap impulse: `dir` is the velocity delta to ADD (≈ +8 m/s along the
   * user's look direction, +5 m/s up) — the knockback event's client math.
   */
  | { type: 'gameEvent'; kind: 'leap'; playerId: number; dir: { x: number; y: number; z: number } }
  /** The server moved a player (Color Teleporter): their client re-anchors. */
  | { type: 'gameEvent'; kind: 'teleported'; playerId: number; x: number; y: number; z: number }
  /**
   * Swapper: both fighters traded positions. `a` is the NEW position for
   * `aId` (the old spot of `bId`), `b` the new position for `bId`.
   */
  | {
      type: 'gameEvent';
      kind: 'swapped';
      aId: number;
      bId: number;
      a: { x: number; y: number; z: number };
      b: { x: number; y: number; z: number };
    }
  /** The round's faller used their one Color Zapper shot: the cell crumbles. */
  | { type: 'gameEvent'; kind: 'cellZapped'; by: number; cell: [number, number] }
  // --- Sandbox zombies (protocol v8, §3.5 Phase 2) ---
  /**
   * A zombie shoved a player: `dir` is the velocity delta to ADD (the exact
   * knockback/leap client math) — the sandbox itself stays deathless, this is
   * a pure physics nudge + cosmetic. The server applies no damage.
   */
  | {
      type: 'gameEvent';
      kind: 'shoved';
      playerId: number;
      /** The zombie that did the shoving. */
      mobId: number;
      dir: { x: number; y: number; z: number };
      power: number;
    }
  | {
      type: 'gameEvent';
      kind: 'matchEnd';
      winnerId: number;
      winnerName: string;
      stats: MatchEndStats[];
    }
  /** Toast-able rejections (startGame with <2 players, unaffordable buys, …). */
  | { type: 'gameEvent'; kind: 'error'; message: string }
  /** Countdown ticks; seconds ≤ 0 means "FIGHT!". */
  | { type: 'gameEvent'; kind: 'countdown'; seconds: number };

export type ServerMessage =
  | WelcomeMsg
  | PlayersMsg
  | BlockEditsMsg
  | ChatBroadcastMsg
  | LeftMsg
  | MobsMsg
  | MobDiedMsg
  | ModeChangedMsg
  | GameStateMsg
  | GameEventMsg;

// --- parsing ----------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Any finite number (positions, angles). */
function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function asSnapshot(value: unknown): PlayerSnapshot | null {
  if (!isRecord(value)) return null;
  const id = asInt(value.id);
  const name = asString(value.name);
  const x = asNumber(value.x);
  const y = asNumber(value.y);
  const z = asNumber(value.z);
  const yaw = asNumber(value.yaw);
  const pitch = asNumber(value.pitch);
  if (id === null || name === null || x === null || y === null || z === null) return null;
  if (yaw === null || pitch === null) return null;
  // v4: the optional bot flag (server sends it only for its test bot).
  return value.bot === true ? { id, name, x, y, z, yaw, pitch, bot: true } : { id, name, x, y, z, yaw, pitch };
}

function asSnapshots(value: unknown): PlayerSnapshot[] | null {
  if (!Array.isArray(value)) return null;
  const out: PlayerSnapshot[] = [];
  for (const entry of value) {
    const snapshot = asSnapshot(entry);
    if (snapshot === null) return null;
    out.push(snapshot);
  }
  return out;
}

function asEditTuples(value: unknown): EditTuple[] | null {
  if (!Array.isArray(value)) return null;
  const out: EditTuple[] = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 4) return null;
    const [x, y, z, id] = entry as unknown[];
    if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z) || !Number.isInteger(id)) {
      return null;
    }
    out.push([x, y, z, id] as EditTuple);
  }
  return out;
}

const MOB_KINDS: readonly string[] = ['fox', 'boar', 'giraffe', 'zombie'];

function asMobKind(value: unknown): MobKind | null {
  return typeof value === 'string' && MOB_KINDS.includes(value) ? (value as MobKind) : null;
}

/** `mobDied` position triple [x, y, z] (finite numbers). */
function asPosition(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const [x, y, z] = value as unknown[];
  const nx = asNumber(x);
  const ny = asNumber(y);
  const nz = asNumber(z);
  return nx === null || ny === null || nz === null ? null : [nx, ny, nz];
}

function asMob(value: unknown): MobSnapshot | null {
  if (!isRecord(value)) return null;
  const id = asInt(value.id);
  const kind = asMobKind(value.kind);
  const x = asNumber(value.x);
  const y = asNumber(value.y);
  const z = asNumber(value.z);
  const yaw = asNumber(value.yaw);
  const hp = asNumber(value.hp);
  if (id === null || kind === null || x === null || y === null || z === null) return null;
  if (yaw === null || hp === null) return null;
  return { id, kind, x, y, z, yaw, hp };
}

function asMobSnapshots(value: unknown): MobSnapshot[] | null {
  if (!Array.isArray(value)) return null;
  const out: MobSnapshot[] = [];
  for (const entry of value) {
    const mob = asMob(entry);
    if (mob === null) return null;
    out.push(mob);
  }
  return out;
}

const SHOP_ITEM_IDS: readonly string[] = [
  'wool',
  'planks',
  'wooden_sword',
  'stone_sword',
  'iron_sword',
  'golden_apple',
];

const SWORD_TIERS: readonly string[] = ['wooden', 'stone', 'iron'];

function asShopItemId(value: unknown): ShopItemId | null {
  return typeof value === 'string' && SHOP_ITEM_IDS.includes(value) ? (value as ShopItemId) : null;
}

function asHeldItemId(value: unknown): HeldItemId | null {
  if (value === 'fist') return 'fist';
  return asShopItemId(value);
}

function asModeSpawn(value: unknown): ModeSpawn | null {
  if (!isRecord(value)) return null;
  const x = asNumber(value.x);
  const y = asNumber(value.y);
  const z = asNumber(value.z);
  const yaw = asNumber(value.yaw);
  if (x === null || y === null || z === null || yaw === null) return null;
  return { x, y, z, yaw };
}

function asModeSpawns(value: unknown): ModeSpawn[] | null {
  if (!Array.isArray(value)) return null;
  const out: ModeSpawn[] = [];
  for (const entry of value) {
    const spawn = asModeSpawn(entry);
    if (spawn === null) return null;
    out.push(spawn);
  }
  return out;
}

function asModeBed(value: unknown): ModeBed | null {
  if (!isRecord(value)) return null;
  const x = asInt(value.x);
  const y = asInt(value.y);
  const z = asInt(value.z);
  if (x === null || y === null || z === null) return null;
  return { x, y, z };
}

function asModeBeds(value: unknown): ModeBed[] | null {
  if (!Array.isArray(value)) return null;
  const out: ModeBed[] = [];
  for (const entry of value) {
    const bed = asModeBed(entry);
    if (bed === null) return null;
    out.push(bed);
  }
  return out;
}

function asBooleans(value: unknown): boolean[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((entry) => typeof entry === 'boolean') ? (value as boolean[]) : null;
}

/** List of player ids (roundResult fallers). */
function asIntList(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const out: number[] = [];
  for (const entry of value) {
    const id = asInt(entry);
    if (id === null) return null;
    out.push(id);
  }
  return out;
}

function asCurrency(value: unknown): CurrencyState | null {
  if (!isRecord(value)) return null;
  const iron = asNumber(value.iron);
  const gold = asNumber(value.gold);
  const emerald = asNumber(value.emerald);
  if (iron === null || gold === null || emerald === null) return null;
  return { iron, gold, emerald };
}

function asInventory(value: unknown): InventoryState | null {
  if (!isRecord(value)) return null;
  const wool = asNumber(value.wool);
  const planks = asNumber(value.planks);
  const apples = asNumber(value.apples);
  const sword = value.sword === null ? null : typeof value.sword === 'string' && SWORD_TIERS.includes(value.sword) ? (value.sword as SwordTier) : undefined;
  if (wool === null || planks === null || apples === null || sword === undefined) return null;
  return { wool, planks, apples, sword };
}

function asMatchPlayer(value: unknown): MatchPlayerState | null {
  if (!isRecord(value)) return null;
  const id = asInt(value.id);
  const name = asString(value.name);
  const team = asInt(value.team);
  const hp = asNumber(value.hp);
  const alive = typeof value.alive === 'boolean' ? value.alive : null;
  const respawnIn = asNumber(value.respawnIn);
  const kills = asNumber(value.kills);
  const currency = asCurrency(value.currency);
  const inventory = asInventory(value.inventory);
  if (
    id === null || name === null || team === null || hp === null ||
    alive === null || respawnIn === null || kills === null ||
    currency === null || inventory === null
  ) {
    return null;
  }
  return { id, name, team, hp, alive, respawnIn, kills, currency, inventory };
}

function asMatchPlayers(value: unknown): MatchPlayerState[] | null {
  if (!Array.isArray(value)) return null;
  const out: MatchPlayerState[] = [];
  for (const entry of value) {
    const player = asMatchPlayer(entry);
    if (player === null) return null;
    out.push(player);
  }
  return out;
}

function asMatchEndStats(value: unknown): MatchEndStats[] | null {
  if (!Array.isArray(value)) return null;
  const out: MatchEndStats[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const id = asInt(entry.id);
    const name = asString(entry.name);
    const kills = asNumber(entry.kills);
    const deaths = asNumber(entry.deaths);
    if (id === null || name === null || kills === null || deaths === null) return null;
    const rounds = entry.rounds === undefined ? undefined : asNumber(entry.rounds);
    const falls = entry.falls === undefined ? undefined : asNumber(entry.falls);
    if (rounds === null || falls === null) return null;
    out.push(rounds !== undefined || falls !== undefined
      ? { id, name, kills, deaths, rounds, falls }
      : { id, name, kills, deaths });
  }
  return out;
}

const GAME_MODES: readonly string[] = ['bedwars', 'party'];

function asStartMode(value: unknown): 'bedwars' | 'party' | null {
  return typeof value === 'string' && GAME_MODES.includes(value) ? (value as 'bedwars' | 'party') : null;
}

function asPartyScores(value: unknown): PartyScoreEntry[] | null {
  if (!Array.isArray(value)) return null;
  const out: PartyScoreEntry[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const playerId = asInt(entry.playerId);
    const name = asString(entry.name);
    const score = asNumber(entry.score);
    const alive = typeof entry.alive === 'boolean' ? entry.alive : null;
    if (playerId === null || name === null || score === null || alive === null) return null;
    out.push({ playerId, name, score, alive });
  }
  return out;
}

/** A floor cell pair [x, z] (bomb payload + events). */
function asCellPair(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const x = asInt(value[0]);
  const z = asInt(value[1]);
  return x === null || z === null ? null : [x, z];
}

function asPartyBomb(value: unknown): PartyBombState | null {
  if (!isRecord(value)) return null;
  const cell = asCellPair(value.cell);
  const colorId = asInt(value.colorId);
  const detonatesAt = asNumber(value.detonatesAt);
  if (cell === null || colorId === null || detonatesAt === null) return null;
  return { cell, colorId, detonatesAt };
}

// --- mystery boxes + power-ups (protocol v7) -----------------------------------

const PARTY_ITEM_IDS: readonly string[] = ['leap', 'speed', 'jump', 'swapper', 'teleporter'];

function asPartyItemId(value: unknown): PartyItemId | null {
  return typeof value === 'string' && PARTY_ITEM_IDS.includes(value) ? (value as PartyItemId) : null;
}

function asPartyItemIdList(value: unknown): PartyItemId[] | null {
  if (!Array.isArray(value)) return null;
  const out: PartyItemId[] = [];
  for (const entry of value) {
    const item = asPartyItemId(entry);
    if (item === null) return null;
    out.push(item);
  }
  return out;
}

function asPartyBoxes(value: unknown): PartyBoxState[] | null {
  if (!Array.isArray(value)) return null;
  const out: PartyBoxState[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const cell = asCellPair(entry.cell);
    if (cell === null) return null;
    out.push({ cell });
  }
  return out;
}

/** JSON object keyed by player id (string keys per JSON, validated as ints). */
function asPartyItems(value: unknown): PartyItemsState | null {
  if (!isRecord(value)) return null;
  const out: PartyItemsState = {};
  for (const [key, list] of Object.entries(value)) {
    if (!/^\d+$/.test(key)) return null;
    const items = asPartyItemIdList(list);
    if (items === null) return null;
    out[Number(key)] = items;
  }
  return out;
}

const PARTY_EFFECT_KINDS: readonly string[] = ['speed', 'jump'];

function asPartyEffects(value: unknown): PartyEffectState[] | null {
  if (!Array.isArray(value)) return null;
  const out: PartyEffectState[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const playerId = asInt(entry.playerId);
    const effect = typeof entry.effect === 'string' && PARTY_EFFECT_KINDS.includes(entry.effect)
      ? (entry.effect as 'speed' | 'jump')
      : null;
    const until = asNumber(entry.until);
    if (playerId === null || effect === null || until === null) return null;
    out.push({ playerId, effect, until });
  }
  return out;
}

function asPartyPayload(value: unknown): PartyStatePayload | null {
  if (!isRecord(value)) return null;
  const round = asInt(value.round);
  const colorId = asInt(value.colorId);
  const colorName = asString(value.colorName);
  const roundTimerMs = asNumber(value.roundTimerMs);
  const roundEndsAt = asNumber(value.roundEndsAt);
  const scores = asPartyScores(value.scores);
  if (round === null || colorId === null || colorName === null) return null;
  if (roundTimerMs === null || roundEndsAt === null || scores === null) return null;
  // v5: the fused bomb (null when none). Absent field = v4 server → null, so
  // v5 clients keep parsing v4 party snapshots unchanged.
  const bomb = value.bomb === undefined || value.bomb === null ? null : asPartyBomb(value.bomb);
  if (bomb === null && value.bomb !== undefined && value.bomb !== null) return null;
  // v7: mystery boxes / items / effects. Absent fields = pre-v7 server →
  // empty defaults, so v7 clients keep parsing older snapshots unchanged.
  const boxes = value.boxes === undefined ? [] : asPartyBoxes(value.boxes);
  if (boxes === null) return null;
  const items = value.items === undefined ? {} : asPartyItems(value.items);
  if (items === null) return null;
  const effects = value.effects === undefined ? [] : asPartyEffects(value.effects);
  if (effects === null) return null;
  return { round, colorId, colorName, roundTimerMs, roundEndsAt, scores, bomb, boxes, items, effects };
}

const PARTY_PHASES: readonly string[] = ['intermission', 'announce', 'drop', 'scored'];

function asPhase(value: unknown): MatchPhase | PartyPhase | null {
  if (typeof value !== 'string') return null;
  if (value === 'countdown' || value === 'playing' || value === 'ended') return value;
  return PARTY_PHASES.includes(value) ? (value as PartyPhase) : null;
}

function asGameEvent(data: Record<string, unknown>): GameEventMsg | null {
  switch (data.kind) {
    case 'bedBroken': {
      const team = asInt(data.team);
      const by = asString(data.by);
      return team === null || by === null ? null : { type: 'gameEvent', kind: 'bedBroken', team, by };
    }
    case 'death': {
      const playerId = asInt(data.playerId);
      const cause = data.cause === 'combat' || data.cause === 'void' ? data.cause : null;
      const killerId = data.killerId === null ? null : asInt(data.killerId);
      const respawnIn = asNumber(data.respawnIn);
      if (playerId === null || cause === null || killerId === undefined || respawnIn === null) return null;
      return { type: 'gameEvent', kind: 'death', playerId, cause, killerId, respawnIn };
    }
    case 'respawn': {
      const playerId = asInt(data.playerId);
      return playerId === null ? null : { type: 'gameEvent', kind: 'respawn', playerId };
    }
    case 'knockback': {
      const playerId = asInt(data.playerId);
      const dir = isRecord(data.dir)
        ? {
            x: asNumber(data.dir.x),
            y: asNumber(data.dir.y),
            z: asNumber(data.dir.z),
          }
        : null;
      const power = asNumber(data.power);
      if (playerId === null || dir === null || dir.x === null || dir.y === null || dir.z === null || power === null) {
        return null;
      }
      return { type: 'gameEvent', kind: 'knockback', playerId, dir: { x: dir.x, y: dir.y, z: dir.z }, power };
    }
    case 'purchase': {
      const playerId = asInt(data.playerId);
      const item = asShopItemId(data.item);
      return playerId === null || item === null ? null : { type: 'gameEvent', kind: 'purchase', playerId, item };
    }
    case 'heal': {
      const playerId = asInt(data.playerId);
      const amount = asNumber(data.amount);
      return playerId === null || amount === null ? null : { type: 'gameEvent', kind: 'heal', playerId, amount };
    }
    case 'roundResult': {
      const round = asInt(data.round);
      const fallers = asIntList(data.fallers);
      const survivorId = data.survivorId === null ? null : asInt(data.survivorId);
      const draw = typeof data.draw === 'boolean' ? data.draw : null;
      if (round === null || fallers === null || survivorId === null || draw === null) return null;
      return { type: 'gameEvent', kind: 'roundResult', round, fallers, survivorId, draw };
    }
    case 'roundStart': {
      const round = asInt(data.round);
      return round === null ? null : { type: 'gameEvent', kind: 'roundStart', round };
    }
    case 'drop':
      return { type: 'gameEvent', kind: 'drop' };
    case 'bombSpawned': {
      const cell = asCellPair(data.cell);
      const colorId = asInt(data.colorId);
      return cell === null || colorId === null ? null : { type: 'gameEvent', kind: 'bombSpawned', cell, colorId };
    }
    case 'bombDetonated': {
      const cell = asCellPair(data.cell);
      const colorId = asInt(data.colorId);
      return cell === null || colorId === null ? null : { type: 'gameEvent', kind: 'bombDetonated', cell, colorId };
    }
    case 'boxSpawned': {
      const cell = asCellPair(data.cell);
      return cell === null ? null : { type: 'gameEvent', kind: 'boxSpawned', cell };
    }
    case 'boxPickedUp': {
      const playerId = asInt(data.playerId);
      const item = asPartyItemId(data.item);
      return playerId === null || item === null ? null : { type: 'gameEvent', kind: 'boxPickedUp', playerId, item };
    }
    case 'itemUsed': {
      const playerId = asInt(data.playerId);
      const item = asPartyItemId(data.item);
      return playerId === null || item === null ? null : { type: 'gameEvent', kind: 'itemUsed', playerId, item };
    }
    case 'leap': {
      const playerId = asInt(data.playerId);
      const dir = isRecord(data.dir)
        ? { x: asNumber(data.dir.x), y: asNumber(data.dir.y), z: asNumber(data.dir.z) }
        : null;
      if (playerId === null || dir === null || dir.x === null || dir.y === null || dir.z === null) return null;
      return { type: 'gameEvent', kind: 'leap', playerId, dir: { x: dir.x, y: dir.y, z: dir.z } };
    }
    case 'teleported': {
      const playerId = asInt(data.playerId);
      const x = asNumber(data.x);
      const y = asNumber(data.y);
      const z = asNumber(data.z);
      if (playerId === null || x === null || y === null || z === null) return null;
      return { type: 'gameEvent', kind: 'teleported', playerId, x, y, z };
    }
    case 'swapped': {
      const aId = asInt(data.aId);
      const bId = asInt(data.bId);
      const a = isRecord(data.a)
        ? { x: asNumber(data.a.x), y: asNumber(data.a.y), z: asNumber(data.a.z) }
        : null;
      const b = isRecord(data.b)
        ? { x: asNumber(data.b.x), y: asNumber(data.b.y), z: asNumber(data.b.z) }
        : null;
      if (
        aId === null || bId === null || a === null || b === null ||
        a.x === null || a.y === null || a.z === null ||
        b.x === null || b.y === null || b.z === null
      ) {
        return null;
      }
      return {
        type: 'gameEvent',
        kind: 'swapped',
        aId,
        bId,
        a: { x: a.x, y: a.y, z: a.z },
        b: { x: b.x, y: b.y, z: b.z },
      };
    }
    case 'cellZapped': {
      const by = asInt(data.by);
      const cell = asCellPair(data.cell);
      return by === null || cell === null ? null : { type: 'gameEvent', kind: 'cellZapped', by, cell };
    }
    case 'shoved': {
      const playerId = asInt(data.playerId);
      const mobId = asInt(data.mobId);
      const dir = isRecord(data.dir)
        ? { x: asNumber(data.dir.x), y: asNumber(data.dir.y), z: asNumber(data.dir.z) }
        : null;
      const power = asNumber(data.power);
      if (playerId === null || mobId === null || dir === null || dir.x === null || dir.y === null || dir.z === null || power === null) {
        return null;
      }
      return { type: 'gameEvent', kind: 'shoved', playerId, mobId, dir: { x: dir.x, y: dir.y, z: dir.z }, power };
    }
    case 'matchEnd': {
      const winnerId = asInt(data.winnerId);
      const winnerName = asString(data.winnerName);
      const stats = asMatchEndStats(data.stats);
      return winnerId === null || winnerName === null || stats === null
        ? null
        : { type: 'gameEvent', kind: 'matchEnd', winnerId, winnerName, stats };
    }
    case 'error': {
      const message = asString(data.message);
      return message === null ? null : { type: 'gameEvent', kind: 'error', message };
    }
    case 'countdown': {
      const seconds = asNumber(data.seconds);
      return seconds === null ? null : { type: 'gameEvent', kind: 'countdown', seconds };
    }
    default:
      return null;
  }
}

/** Parses one already-JSON-decoded client frame; null when malformed. */
export function parseClientMessage(data: unknown): ClientMessage | null {
  if (!isRecord(data)) return null;
  switch (data.type) {
    case 'hello': {
      const name = asString(data.name);
      return name === null ? null : { type: 'hello', name };
    }
    case 'move': {
      const x = asNumber(data.x);
      const y = asNumber(data.y);
      const z = asNumber(data.z);
      const yaw = asNumber(data.yaw);
      const pitch = asNumber(data.pitch);
      if (x === null || y === null || z === null || yaw === null || pitch === null) return null;
      return { type: 'move', x, y, z, yaw, pitch };
    }
    case 'blockEdit': {
      const x = asInt(data.x);
      const y = asInt(data.y);
      const z = asInt(data.z);
      const id = asInt(data.id);
      if (x === null || y === null || z === null || id === null) return null;
      return { type: 'blockEdit', x, y, z, id };
    }
    case 'chat': {
      const text = asString(data.text);
      return text === null ? null : { type: 'chat', text };
    }
    case 'startGame': {
      // v2 clients sent no mode; default keeps them working.
      const mode = data.mode === undefined ? 'bedwars' : asStartMode(data.mode);
      return mode === null ? null : { type: 'startGame', mode };
    }
    case 'ready':
      return { type: 'ready' };
    case 'leaveGame':
      return { type: 'leaveGame' };
    case 'attack': {
      const id = asInt(data.id);
      const held = asHeldItemId(data.held);
      return id === null || held === null ? null : { type: 'attack', id, held };
    }
    case 'attackMob': {
      const id = asInt(data.id);
      return id === null ? null : { type: 'attackMob', id };
    }
    case 'useItem': {
      const slot = asInt(data.slot);
      return slot === null ? null : { type: 'useItem', slot };
    }
    case 'zapCell': {
      const x = asInt(data.x);
      const z = asInt(data.z);
      return x === null || z === null ? null : { type: 'zapCell', x, z };
    }
    case 'buy': {
      const item = asShopItemId(data.item);
      return item === null ? null : { type: 'buy', item };
    }
    case 'useHeld':
      return { type: 'useHeld' };
    case 'addBot':
      return { type: 'addBot' };
    case 'removeBot':
      return { type: 'removeBot' };
    default:
      return null;
  }
}

/** Parses one already-JSON-decoded server frame; null when malformed. */
export function parseServerMessage(data: unknown): ServerMessage | null {
  if (!isRecord(data)) return null;
  switch (data.type) {
    case 'welcome': {
      const playerId = asInt(data.playerId);
      const name = asString(data.name);
      const seed = asInt(data.seed);
      const edits = asEditTuples(data.edits);
      const players = asSnapshots(data.players);
      if (playerId === null || name === null || seed === null) return null;
      if (edits === null || players === null) return null;
      return { type: 'welcome', playerId, name, seed, edits, players };
    }
    case 'players': {
      const players = asSnapshots(data.players);
      return players === null ? null : { type: 'players', players };
    }
    case 'blockEdits': {
      const edits = asEditTuples(data.edits);
      return edits === null ? null : { type: 'blockEdits', edits };
    }
    case 'chat': {
      const from = asString(data.from);
      const text = asString(data.text);
      return from === null || text === null ? null : { type: 'chat', from, text };
    }
    case 'left': {
      const id = asInt(data.id);
      return id === null ? null : { type: 'left', id };
    }
    case 'mobs': {
      const mobs = asMobSnapshots(data.mobs);
      if (mobs === null) return null;
      // v8: the server's shared day phase. Absent = pre-v8 server → undefined,
      // so v8 clients keep parsing older snapshots (they keep their local clock).
      const dayT = data.dayT === undefined ? undefined : asNumber(data.dayT);
      if (dayT === null) return null;
      return dayT === undefined ? { type: 'mobs', mobs } : { type: 'mobs', mobs, dayT };
    }
    case 'mobDied': {
      const id = asInt(data.id);
      const kind = asMobKind(data.kind);
      const at = asPosition(data.at);
      if (id === null || kind === null || at === null) return null;
      return { type: 'mobDied', id, kind, at };
    }
    case 'modeChanged': {
      const mode = data.mode === 'sandbox' || data.mode === 'bedwars' || data.mode === 'party' ? data.mode : null;
      const seed = asInt(data.seed);
      const edits = asEditTuples(data.edits);
      const spawns = asModeSpawns(data.spawns);
      const beds = asModeBeds(data.beds);
      const yourTeam = asInt(data.yourTeam);
      if (mode === null || seed === null || yourTeam === null) return null;
      if (edits === null || spawns === null || beds === null) return null;
      return { type: 'modeChanged', mode, seed, edits, spawns, beds, yourTeam };
    }
    case 'gameState': {
      const phase = asPhase(data.phase);
      const timeLeft = asNumber(data.timeLeft);
      const bedsAlive = asBooleans(data.bedsAlive);
      const players = asMatchPlayers(data.players);
      if (phase === null || timeLeft === null || bedsAlive === null || players === null) return null;
      // Party snapshots carry the extra payload object; bedwars ones omit it.
      const party = data.party === undefined ? undefined : asPartyPayload(data.party);
      if (party === null) return null;
      return party !== undefined
        ? { type: 'gameState', phase, timeLeft, bedsAlive, players, party }
        : { type: 'gameState', phase, timeLeft, bedsAlive, players };
    }
    case 'gameEvent':
      return asGameEvent(data);
    default:
      return null;
  }
}
