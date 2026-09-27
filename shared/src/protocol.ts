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

/** Ask the server to start a BedWars match (needs exactly 2 players online). */
export interface StartGameMsg {
  type: 'startGame';
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
  | BuyMsg
  | UseHeldMsg;

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

export type GameMode = 'sandbox' | 'bedwars';

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
 * spectator). Sandbox carries the original seed + the persistent overlay.
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

/** 5 Hz authoritative match snapshot while in bedwars. */
export interface GameStateMsg {
  type: 'gameState';
  phase: MatchPhase;
  /** Seconds left in the current phase (0 in `ended`). */
  timeLeft: number;
  bedsAlive: boolean[];
  players: MatchPlayerState[];
}

export interface MatchEndStats {
  id: number;
  name: string;
  kills: number;
  deaths: number;
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
  return { id, name, x, y, z, yaw, pitch };
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
    out.push({ id, name, kills, deaths });
  }
  return out;
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
    case 'startGame':
      return { type: 'startGame' };
    case 'ready':
      return { type: 'ready' };
    case 'leaveGame':
      return { type: 'leaveGame' };
    case 'attack': {
      const id = asInt(data.id);
      const held = asHeldItemId(data.held);
      return id === null || held === null ? null : { type: 'attack', id, held };
    }
    case 'buy': {
      const item = asShopItemId(data.item);
      return item === null ? null : { type: 'buy', item };
    }
    case 'useHeld':
      return { type: 'useHeld' };
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
    case 'modeChanged': {
      const mode = data.mode === 'sandbox' || data.mode === 'bedwars' ? data.mode : null;
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
      const phase =
        data.phase === 'countdown' || data.phase === 'playing' || data.phase === 'ended' ? data.phase : null;
      const timeLeft = asNumber(data.timeLeft);
      const bedsAlive = asBooleans(data.bedsAlive);
      const players = asMatchPlayers(data.players);
      if (phase === null || timeLeft === null || bedsAlive === null || players === null) return null;
      return { type: 'gameState', phase, timeLeft, bedsAlive, players };
    }
    case 'gameEvent':
      return asGameEvent(data);
    default:
      return null;
  }
}
