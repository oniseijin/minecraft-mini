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
 * V9 adds the Murder Mystery co-op mode (DESIGN.md §3.6, M7.1): `GameMode`
 * and `GAME_MODES` grow 'murder' (so `startGame` can request it), the mob
 * union grows 'guest' (the NPC guests' positions ride the existing mobs
 * snapshot stream), `gameState` gains an optional `murder` payload (guest
 * roster + per-player coins/charges/jam + the final-minute detector flag)
 * with `phase` widening to the murder phases mingle/bold/hunt, `gameEvent`
 * gains guestKilled/murdererRevealed/zapped/coinPickedUp/gravestoneRead and
 * C→S gains `zapGuest {id}` + `investigateGravestone {x, z}`. Everything
 * parses tolerantly in the v7 spirit: a v9 client keeps parsing v8 payloads
 * (absent `murder` field → key omitted) and v8 clients ignore the extra
 * payload fields and unknown gameEvent kinds.
 *
 * `parseClientMessage` / `parseServerMessage` validate the *shape* of incoming
 * JSON (finite numbers, integer coords); policy (name/chat sanitizing, reach,
 * occupancy) stays server-side.
 */

import type { EditTuple } from './world';
import { SHOP_ITEM_IDS, SWORD_TIERS, type ShopItemId, type SwordTier } from './shop';

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
  /**
   * Which game to start; absent on v2-era clients means 'bedwars'. v9 adds
   * 'murder' (§3.6) — the engine lands in M7.2, until then the server
   * rejects the request with a toast-able error.
   */
  mode: 'bedwars' | 'party' | 'murder';
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

/**
 * Fire the detective zapper at a guest (protocol v9, §3.6): `id` is the
 * guest's mob id. The server validates mode, charges, jam/stun and ~20-block
 * reach; the outcome arrives as the `zapped` gameEvent (a wrong zap shatters
 * the zapper — 10 s jam + 5 s stun, per the kid-first guardrails).
 */
export interface ZapGuestMsg {
  type: 'zapGuest';
  id: number;
}

/**
 * Investigate a gravestone (protocol v9, §3.6): walk up + press E. `x`/`z`
 * locate the stone (the spot its `guestKilled` event reported); the server
 * validates the 30 s cooldown and proximity, and answers with the
 * `gravestoneRead` gameEvent (victim name + age).
 */
export interface InvestigateGravestoneMsg {
  type: 'investigateGravestone';
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
  | ZapGuestMsg
  | InvestigateGravestoneMsg
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

/** v9 adds 'guest': murder-mystery NPC guests (§3.6) riding the mob relay. */
export const MOB_KINDS = ['fox', 'boar', 'giraffe', 'zombie', 'guest'] as const;

export type MobKind = (typeof MOB_KINDS)[number];

/** One mob in a `mobs` snapshot (feet-center position, like players). */
export interface MobSnapshot {
  id: number;
  kind: MobKind;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /**
   * Remaining hit points (fox 6, boar 10, giraffe 14, zombie 10; a fist punch
   * deals 2). Unused for v9 guests — they are not punchable and report a
   * constant; guests die only to the murderer (guestKilled events).
   */
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

/** v9 adds 'murder' (§3.6): Murder Mystery co-op vs a hidden bot murderer. */
export type GameMode = 'sandbox' | 'bedwars' | 'party' | 'murder';

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
export const PARTY_PHASES = ['intermission', 'announce', 'drop', 'scored'] as const;

export type PartyPhase = (typeof PARTY_PHASES)[number];

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
export const PARTY_ITEM_IDS = ['leap', 'speed', 'jump', 'swapper', 'teleporter'] as const;

export type PartyItemId = (typeof PARTY_ITEM_IDS)[number];

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

// --- Murder Mystery co-op (protocol v9, §3.6) ---------------------------------

/** Murder Mystery escalation phases: mingle → bold → hunt (the final minute). */
export const MURDER_PHASES = ['mingle', 'bold', 'hunt'] as const;

export type MurderPhase = (typeof MURDER_PHASES)[number];

/** The six NPC guest shirt colors — nameplates are "Red Guest" … (§3.6). */
export const MURDER_GUEST_COLORS = ['red', 'blue', 'green', 'yellow', 'purple', 'orange'] as const;

export type MurderGuestColor = (typeof MURDER_GUEST_COLORS)[number];

/**
 * Coin tiers (faithful to Hive §3.6): a gold coin is worth 1, an epic blue
 * one 3 and a super purple one 6 (super coins spawn in secluded corners).
 */
export const MURDER_COIN_TIERS = ['gold', 'epic', 'super'] as const;

export type MurderCoinTier = (typeof MURDER_COIN_TIERS)[number];

/**
 * One NPC guest in the `murder` payload. Its position/yaw ride the existing
 * `mobs` snapshot stream (`kind: 'guest'`, same id) — only the roster state
 * travels here.
 */
export interface MurderGuestState {
  /** The guest's MOB id (keys its mobs-snapshot entry and guestKilled events). */
  id: number;
  /** Kid-legible nameplate text ("Red Guest"). */
  name: string;
  /** Shirt tint (one of MURDER_GUEST_COLORS); also the name's prefix. */
  color: MurderGuestColor;
  /** False once the murderer struck (a gravestone marks the spot). */
  alive: boolean;
}

/** Per-player counters keyed by player id (coins held / zapper charges / jam). */
export interface MurderCountState {
  [playerId: number]: number;
}

/**
 * Per-player detector flag (final minute only): true = the murderer is
 * within ~12 blocks — the client pulses the HUD (§3.6 tell 5).
 */
export interface MurderDetectorState {
  [playerId: number]: boolean;
}

/**
 * The murder payload of a `gameState` snapshot (present only while the
 * murder mode runs; sandbox/bedwars/party snapshots omit it). Counters are
 * absolute (coins/charges held now; `jammedUntil` is the server epoch ms
 * until which that player's zapper is jammed) so the 5 Hz snapshots stay
 * stateless — clients interpolate timers locally, as with party deadlines.
 */
export interface MurderStatePayload {
  /** The six NPC guests (plus each one's alive flag) — the deduction cast. */
  guests: MurderGuestState[];
  /** Coins held per player (the "murderer never collects" tell needs this visible). */
  coins: MurderCountState;
  /** Zapper charges per player (start 1, +1 per 10 coins). */
  charges: MurderCountState;
  /** Server epoch ms until each jammed zapper works again (wrong-zap guardrail). */
  jammedUntil: MurderCountState;
  /** Final-minute proximity flag per player (true = murderer within ~12 blocks). */
  detector: MurderDetectorState;
}

/** 5 Hz authoritative match snapshot (bedwars, or party/murder via payload). */
export interface GameStateMsg {
  type: 'gameState';
  /** BedWars: match phase. Party: round phase. Murder (v9): escalation phase. */
  phase: MatchPhase | PartyPhase | MurderPhase;
  /** BedWars: seconds left in the phase. Party: seconds until the drop. */
  timeLeft: number;
  bedsAlive: boolean[];
  players: MatchPlayerState[];
  party?: PartyStatePayload;
  /** Murder Mystery state (v9; absent = pre-v9 server → key omitted). */
  murder?: MurderStatePayload;
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
  // --- Murder Mystery co-op (protocol v9, §3.6) ---
  /**
   * The murderer struck: the guest `victimId` died at [x, y, z] (its
   * gravestone appears there; innocent guests panic-flee the spot).
   */
  | { type: 'gameEvent'; kind: 'guestKilled'; x: number; y: number; z: number; victimId: number }
  /** Match end: the murderer's guest id is revealed (the win/lose moment). */
  | { type: 'gameEvent'; kind: 'murdererRevealed'; id: number }
  /**
   * A zapper shot resolved: `by` is the shooter, `targetId` the guest hit.
   * `correct` is true only when the target WAS the murderer (both humans
   * win); a wrong zap confirms the guest innocent and shatters the shooter's
   * zapper (jam + stun — see the murder payload counters).
   */
  | { type: 'gameEvent'; kind: 'zapped'; by: number; targetId: number; correct: boolean }
  /** A player walked over a coin (server-side proximity): `value` is its worth (1/3/6). */
  | { type: 'gameEvent'; kind: 'coinPickedUp'; playerId: number; value: number }
  /**
   * A gravestone was investigated (walk up + press E, 30 s cooldown): shows
   * the victim + how long ago they fell ("Red Guest — 20s ago").
   */
  | { type: 'gameEvent'; kind: 'gravestoneRead'; x: number; z: number; victimName: string; ageSeconds: number }
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
//
// Table-driven (REFACTORING.md 2c): `decode(data, spec, build)` runs a
// key→parser spec and constructs the message when every field parses;
// `arrayOf`/`oneOf`/`asVec3` compose the shared shapes. The handful of
// documented tolerance quirks (absent-field defaults for older servers,
// killerId coercion, survivorId rejection, sword/rounds/falls pairing, the
// bot flag) stay hand-written below with their comments — they are pinned
// case-by-case by tools/check-protocol.ts and must survive verbatim.

type Parser<T> = (value: unknown) => T | null;

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

/** Runs a key→parser spec; null when any field fails to parse. */
function decode<S extends Record<string, Parser<unknown>>, T>(
  data: Record<string, unknown>,
  spec: S,
  build: (fields: { [K in keyof S]: S[K] extends Parser<infer U> ? U : never }) => T,
): T | null {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(spec)) {
    const value = spec[key](data[key]);
    if (value === null) return null;
    out[key] = value;
  }
  return build(out as { [K in keyof S]: S[K] extends Parser<infer U> ? U : never });
}

/** Parser for an array whose every entry parses. */
const arrayOf = <T>(parse: Parser<T>): Parser<T[]> => (value) => {
  if (!Array.isArray(value)) return null;
  const out: T[] = [];
  for (const entry of value) {
    const parsed = parse(entry);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
};

/** Parser for a fixed string union (kind/item/mode tables). */
const oneOf = <T extends string>(values: readonly T[]): Parser<T> => (value) =>
  typeof value === 'string' && (values as readonly string[]).includes(value) ? (value as T) : null;

/** { x, y, z } record of finite numbers (knockback/leap/shoved dirs, swapped spots). */
const asVec3: Parser<{ x: number; y: number; z: number }> = (value) =>
  isRecord(value) ? decode(value, { x: asNumber, y: asNumber, z: asNumber }, ({ x, y, z }) => ({ x, y, z })) : null;

/** The match modes a client may request via `startGame` (sandbox is local-only). */
export const GAME_MODES = ['bedwars', 'party', 'murder'] as const;

/** The Block Party power-up effect kinds (speed / jump boost). */
export const PARTY_EFFECT_KINDS = ['speed', 'jump'] as const;

const asMobKind = oneOf(MOB_KINDS);
const asShopItemId = oneOf(SHOP_ITEM_IDS);
const asPartyItemId = oneOf(PARTY_ITEM_IDS);
const asStartMode = oneOf(GAME_MODES);
const asCause = oneOf(['combat', 'void'] as const);
const asModeName = oneOf(['sandbox', 'bedwars', 'party', 'murder'] as const);

function asHeldItemId(value: unknown): HeldItemId | null {
  if (value === 'fist') return 'fist';
  return asShopItemId(value);
}

function asSnapshot(value: unknown): PlayerSnapshot | null {
  if (!isRecord(value)) return null;
  return decode(
    value,
    { id: asInt, name: asString, x: asNumber, y: asNumber, z: asNumber, yaw: asNumber, pitch: asNumber },
    ({ id, name, x, y, z, yaw, pitch }) =>
      // v4: the optional bot flag (server sends it only for its test bot).
      value.bot === true ? { id, name, x, y, z, yaw, pitch, bot: true } : { id, name, x, y, z, yaw, pitch },
  );
}

const asSnapshots = arrayOf(asSnapshot);

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

/** `mobDied` position triple [x, y, z] (finite numbers). */
function asPosition(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const [x, y, z] = value as unknown[];
  const nx = asNumber(x);
  const ny = asNumber(y);
  const nz = asNumber(z);
  return nx === null || ny === null || nz === null ? null : [nx, ny, nz];
}

const asMob = (value: unknown): MobSnapshot | null =>
  isRecord(value)
    ? decode(value, { id: asInt, kind: asMobKind, x: asNumber, y: asNumber, z: asNumber, yaw: asNumber, hp: asNumber }, (m) => m)
    : null;

const asMobSnapshots = arrayOf(asMob);

const asModeSpawn = (value: unknown): ModeSpawn | null =>
  isRecord(value) ? decode(value, { x: asNumber, y: asNumber, z: asNumber, yaw: asNumber }, (m) => m) : null;

const asModeSpawns = arrayOf(asModeSpawn);

const asModeBed = (value: unknown): ModeBed | null =>
  isRecord(value) ? decode(value, { x: asInt, y: asInt, z: asInt }, (m) => m) : null;

const asModeBeds = arrayOf(asModeBed);

function asBooleans(value: unknown): boolean[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((entry) => typeof entry === 'boolean') ? (value as boolean[]) : null;
}

/** List of player ids (roundResult fallers). */
const asIntList = arrayOf(asInt);

const asCurrency = (value: unknown): CurrencyState | null =>
  isRecord(value) ? decode(value, { iron: asNumber, gold: asNumber, emerald: asNumber }, (m) => m) : null;

function asInventory(value: unknown): InventoryState | null {
  if (!isRecord(value)) return null;
  const wool = asNumber(value.wool);
  const planks = asNumber(value.planks);
  const apples = asNumber(value.apples);
  const sword = value.sword === null ? null : typeof value.sword === 'string' && (SWORD_TIERS as readonly string[]).includes(value.sword) ? (value.sword as SwordTier) : undefined;
  if (wool === null || planks === null || apples === null || sword === undefined) return null;
  return { wool, planks, apples, sword };
}

const asMatchPlayer = (value: unknown): MatchPlayerState | null =>
  isRecord(value)
    ? decode(
        value,
        {
          id: asInt,
          name: asString,
          team: asInt,
          hp: asNumber,
          alive: (v: unknown) => (typeof v === 'boolean' ? v : null),
          respawnIn: asNumber,
          kills: asNumber,
          currency: asCurrency,
          inventory: asInventory,
        },
        (m) => m,
      )
    : null;

const asMatchPlayers = arrayOf(asMatchPlayer);

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

const asPartyScore = (value: unknown): PartyScoreEntry | null =>
  isRecord(value)
    ? decode(
        value,
        { playerId: asInt, name: asString, score: asNumber, alive: (v: unknown) => (typeof v === 'boolean' ? v : null) },
        (m) => m,
      )
    : null;

const asPartyScores = arrayOf(asPartyScore);

/** A floor cell pair [x, z] (bomb payload + events). */
function asCellPair(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const x = asInt(value[0]);
  const z = asInt(value[1]);
  return x === null || z === null ? null : [x, z];
}

const asPartyBomb = (value: unknown): PartyBombState | null =>
  isRecord(value) ? decode(value, { cell: asCellPair, colorId: asInt, detonatesAt: asNumber }, (m) => m) : null;

const asPartyItemIdList = arrayOf(asPartyItemId);

const asPartyBox = (value: unknown): PartyBoxState | null =>
  isRecord(value) ? decode(value, { cell: asCellPair }, (m) => m) : null;

const asPartyBoxes = arrayOf(asPartyBox);

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

const asPartyEffect = (value: unknown): PartyEffectState | null =>
  isRecord(value)
    ? decode(
        value,
        { playerId: asInt, effect: oneOf(PARTY_EFFECT_KINDS), until: asNumber },
        (m) => m,
      )
    : null;

const asPartyEffects = arrayOf(asPartyEffect);

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

// --- Murder Mystery payload parsers (protocol v9, §3.6) ------------------------

const asMurderGuest = (value: unknown): MurderGuestState | null =>
  isRecord(value)
    ? decode(
        value,
        {
          id: asInt,
          name: asString,
          color: oneOf(MURDER_GUEST_COLORS),
          alive: (v: unknown) => (typeof v === 'boolean' ? v : null),
        },
        (m) => m,
      )
    : null;

const asMurderGuests = arrayOf(asMurderGuest);

/** JSON object keyed by player id (string keys per JSON, validated as ints). */
function asMurderCounts(value: unknown): MurderCountState | null {
  if (!isRecord(value)) return null;
  const out: MurderCountState = {};
  for (const [key, count] of Object.entries(value)) {
    if (!/^\d+$/.test(key)) return null;
    // Integer values: coins/charges are counts, jammedUntil epoch ms.
    const parsed = asInt(count);
    if (parsed === null) return null;
    out[Number(key)] = parsed;
  }
  return out;
}

/** JSON object keyed by player id → boolean (the final-minute detector flag). */
function asMurderDetector(value: unknown): MurderDetectorState | null {
  if (!isRecord(value)) return null;
  const out: MurderDetectorState = {};
  for (const [key, flag] of Object.entries(value)) {
    if (!/^\d+$/.test(key)) return null;
    if (typeof flag !== 'boolean') return null;
    out[Number(key)] = flag;
  }
  return out;
}

function asMurderPayload(value: unknown): MurderStatePayload | null {
  if (!isRecord(value)) return null;
  // The guest roster is the payload's heart — required, no default.
  const guests = asMurderGuests(value.guests);
  if (guests === null) return null;
  // Per-player maps: absent fields = partial/older payload → empty defaults,
  // the exact spirit of party's boxes/items/effects tolerance.
  const coins = value.coins === undefined ? {} : asMurderCounts(value.coins);
  if (coins === null) return null;
  const charges = value.charges === undefined ? {} : asMurderCounts(value.charges);
  if (charges === null) return null;
  const jammedUntil = value.jammedUntil === undefined ? {} : asMurderCounts(value.jammedUntil);
  if (jammedUntil === null) return null;
  const detector = value.detector === undefined ? {} : asMurderDetector(value.detector);
  if (detector === null) return null;
  return { guests, coins, charges, jammedUntil, detector };
}

function asPhase(value: unknown): MatchPhase | PartyPhase | MurderPhase | null {
  return typeof value === 'string' &&
    (value === 'countdown' ||
      value === 'playing' ||
      value === 'ended' ||
      (PARTY_PHASES as readonly string[]).includes(value) ||
      (MURDER_PHASES as readonly string[]).includes(value))
    ? (value as MatchPhase | PartyPhase | MurderPhase)
    : null;
}

function asGameEvent(data: Record<string, unknown>): GameEventMsg | null {
  switch (data.kind) {
    case 'bedBroken':
      return decode(data, { team: asInt, by: asString }, ({ team, by }) => ({ type: 'gameEvent', kind: 'bedBroken', team, by }));
    case 'death': {
      // Quirk (pinned by tools/check-protocol.ts): killerId null → null, any
      // non-int (absent, string, fractional) also coerces to null — the frame
      // survives. The `=== undefined` guard below is dead (asInt never returns
      // undefined) but preserved verbatim.
      const playerId = asInt(data.playerId);
      const cause = asCause(data.cause);
      const killerId = data.killerId === null ? null : asInt(data.killerId);
      const respawnIn = asNumber(data.respawnIn);
      if (playerId === null || cause === null || killerId === undefined || respawnIn === null) return null;
      return { type: 'gameEvent', kind: 'death', playerId, cause, killerId, respawnIn };
    }
    case 'respawn':
      return decode(data, { playerId: asInt }, ({ playerId }) => ({ type: 'gameEvent', kind: 'respawn', playerId }));
    case 'knockback':
      return decode(
        data,
        { playerId: asInt, dir: asVec3, power: asNumber },
        ({ playerId, dir, power }) => ({ type: 'gameEvent', kind: 'knockback', playerId, dir, power }),
      );
    case 'purchase':
      return decode(data, { playerId: asInt, item: asShopItemId }, ({ playerId, item }) => ({ type: 'gameEvent', kind: 'purchase', playerId, item }));
    case 'heal':
      return decode(data, { playerId: asInt, amount: asNumber }, ({ playerId, amount }) => ({ type: 'gameEvent', kind: 'heal', playerId, amount }));
    case 'roundResult': {
      // survivorId: a real int, or EXPLICIT null on a draw — party.ts sends
      // survivor?.id ?? null and the declared type has always allowed null;
      // the parser used to reject it, silently dropping every draw's result
      // (fixed 2026-09-29; corpus pins in tools/check-protocol.ts updated
      // together). Absent/garbage still rejects — only explicit null is the
      // draw, and this stays stricter than death.killerId's coerce-to-null
      // because the win banner keys off survivorId.
      const round = asInt(data.round);
      const fallers = asIntList(data.fallers);
      const survivorId = data.survivorId === null ? null : asInt(data.survivorId);
      const draw = typeof data.draw === 'boolean' ? data.draw : null;
      if (round === null || fallers === null || draw === null) return null;
      if (survivorId === null && data.survivorId !== null) return null;
      return { type: 'gameEvent', kind: 'roundResult', round, fallers, survivorId, draw };
    }
    case 'roundStart':
      return decode(data, { round: asInt }, ({ round }) => ({ type: 'gameEvent', kind: 'roundStart', round }));
    case 'drop':
      return { type: 'gameEvent', kind: 'drop' };
    case 'bombSpawned':
      return decode(data, { cell: asCellPair, colorId: asInt }, ({ cell, colorId }) => ({ type: 'gameEvent', kind: 'bombSpawned', cell, colorId }));
    case 'bombDetonated':
      return decode(data, { cell: asCellPair, colorId: asInt }, ({ cell, colorId }) => ({ type: 'gameEvent', kind: 'bombDetonated', cell, colorId }));
    case 'boxSpawned':
      return decode(data, { cell: asCellPair }, ({ cell }) => ({ type: 'gameEvent', kind: 'boxSpawned', cell }));
    case 'boxPickedUp':
      return decode(data, { playerId: asInt, item: asPartyItemId }, ({ playerId, item }) => ({ type: 'gameEvent', kind: 'boxPickedUp', playerId, item }));
    case 'itemUsed':
      return decode(data, { playerId: asInt, item: asPartyItemId }, ({ playerId, item }) => ({ type: 'gameEvent', kind: 'itemUsed', playerId, item }));
    case 'leap':
      return decode(data, { playerId: asInt, dir: asVec3 }, ({ playerId, dir }) => ({ type: 'gameEvent', kind: 'leap', playerId, dir }));
    case 'teleported':
      return decode(data, { playerId: asInt, x: asNumber, y: asNumber, z: asNumber }, ({ playerId, x, y, z }) => ({ type: 'gameEvent', kind: 'teleported', playerId, x, y, z }));
    case 'swapped':
      return decode(
        data,
        { aId: asInt, bId: asInt, a: asVec3, b: asVec3 },
        ({ aId, bId, a, b }) => ({ type: 'gameEvent', kind: 'swapped', aId, bId, a, b }),
      );
    case 'cellZapped':
      return decode(data, { by: asInt, cell: asCellPair }, ({ by, cell }) => ({ type: 'gameEvent', kind: 'cellZapped', by, cell }));
    case 'shoved':
      return decode(
        data,
        { playerId: asInt, mobId: asInt, dir: asVec3, power: asNumber },
        ({ playerId, mobId, dir, power }) => ({ type: 'gameEvent', kind: 'shoved', playerId, mobId, dir, power }),
      );
    // --- Murder Mystery (protocol v9, §3.6) ---
    case 'guestKilled':
      return decode(
        data,
        { x: asNumber, y: asNumber, z: asNumber, victimId: asInt },
        ({ x, y, z, victimId }) => ({ type: 'gameEvent', kind: 'guestKilled', x, y, z, victimId }),
      );
    case 'murdererRevealed':
      return decode(data, { id: asInt }, ({ id }) => ({ type: 'gameEvent', kind: 'murdererRevealed', id }));
    case 'zapped':
      return decode(
        data,
        { by: asInt, targetId: asInt, correct: (v: unknown) => (typeof v === 'boolean' ? v : null) },
        ({ by, targetId, correct }) => ({ type: 'gameEvent', kind: 'zapped', by, targetId, correct }),
      );
    case 'coinPickedUp':
      return decode(data, { playerId: asInt, value: asInt }, ({ playerId, value }) => ({ type: 'gameEvent', kind: 'coinPickedUp', playerId, value }));
    case 'gravestoneRead':
      return decode(
        data,
        { x: asNumber, z: asNumber, victimName: asString, ageSeconds: asNumber },
        ({ x, z, victimName, ageSeconds }) => ({ type: 'gameEvent', kind: 'gravestoneRead', x, z, victimName, ageSeconds }),
      );
    case 'matchEnd':
      return decode(
        data,
        { winnerId: asInt, winnerName: asString, stats: asMatchEndStats },
        ({ winnerId, winnerName, stats }) => ({ type: 'gameEvent', kind: 'matchEnd', winnerId, winnerName, stats }),
      );
    case 'error':
      return decode(data, { message: asString }, ({ message }) => ({ type: 'gameEvent', kind: 'error', message }));
    case 'countdown':
      return decode(data, { seconds: asNumber }, ({ seconds }) => ({ type: 'gameEvent', kind: 'countdown', seconds }));
    default:
      return null;
  }
}

/** Parses one already-JSON-decoded client frame; null when malformed. */
export function parseClientMessage(data: unknown): ClientMessage | null {
  if (!isRecord(data)) return null;
  switch (data.type) {
    case 'hello':
      return decode(data, { name: asString }, ({ name }) => ({ type: 'hello', name }));
    case 'move':
      return decode(data, { x: asNumber, y: asNumber, z: asNumber, yaw: asNumber, pitch: asNumber }, (m) => ({ type: 'move', ...m }));
    case 'blockEdit':
      return decode(data, { x: asInt, y: asInt, z: asInt, id: asInt }, (m) => ({ type: 'blockEdit', ...m }));
    case 'chat':
      return decode(data, { text: asString }, ({ text }) => ({ type: 'chat', text }));
    case 'startGame': {
      // Quirk (pinned): v2 clients sent no mode; default keeps them working.
      const mode = data.mode === undefined ? 'bedwars' : asStartMode(data.mode);
      return mode === null ? null : { type: 'startGame', mode };
    }
    case 'ready':
      return { type: 'ready' };
    case 'leaveGame':
      return { type: 'leaveGame' };
    case 'attack':
      return decode(data, { id: asInt, held: asHeldItemId }, ({ id, held }) => ({ type: 'attack', id, held }));
    case 'attackMob':
      return decode(data, { id: asInt }, ({ id }) => ({ type: 'attackMob', id }));
    case 'useItem':
      return decode(data, { slot: asInt }, ({ slot }) => ({ type: 'useItem', slot }));
    case 'zapCell':
      return decode(data, { x: asInt, z: asInt }, ({ x, z }) => ({ type: 'zapCell', x, z }));
    // --- Murder Mystery (protocol v9, §3.6) ---
    case 'zapGuest':
      return decode(data, { id: asInt }, ({ id }) => ({ type: 'zapGuest', id }));
    case 'investigateGravestone':
      return decode(data, { x: asInt, z: asInt }, ({ x, z }) => ({ type: 'investigateGravestone', x, z }));
    case 'buy':
      return decode(data, { item: asShopItemId }, ({ item }) => ({ type: 'buy', item }));
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
    case 'welcome':
      return decode(
        data,
        { playerId: asInt, name: asString, seed: asInt, edits: asEditTuples, players: asSnapshots },
        (m) => ({ type: 'welcome', ...m }),
      );
    case 'players':
      return decode(data, { players: asSnapshots }, ({ players }) => ({ type: 'players', players }));
    case 'blockEdits':
      return decode(data, { edits: asEditTuples }, ({ edits }) => ({ type: 'blockEdits', edits }));
    case 'chat':
      return decode(data, { from: asString, text: asString }, ({ from, text }) => ({ type: 'chat', from, text }));
    case 'left':
      return decode(data, { id: asInt }, ({ id }) => ({ type: 'left', id }));
    case 'mobs': {
      const mobs = asMobSnapshots(data.mobs);
      if (mobs === null) return null;
      // Quirk (pinned): v8 day phase — absent = pre-v8 server → undefined and
      // the key is OMITTED (v8 clients keep their local clock); explicit null
      // rejects the frame.
      const dayT = data.dayT === undefined ? undefined : asNumber(data.dayT);
      if (dayT === null) return null;
      return dayT === undefined ? { type: 'mobs', mobs } : { type: 'mobs', mobs, dayT };
    }
    case 'mobDied':
      return decode(data, { id: asInt, kind: asMobKind, at: asPosition }, ({ id, kind, at }) => ({ type: 'mobDied', id, kind, at }));
    case 'modeChanged':
      return decode(
        data,
        { mode: asModeName, seed: asInt, edits: asEditTuples, spawns: asModeSpawns, beds: asModeBeds, yourTeam: asInt },
        (m) => ({ type: 'modeChanged', ...m }),
      );
    case 'gameState': {
      // Quirk (pinned): party snapshots carry the extra payload object;
      // bedwars ones omit it — absent means absent, explicit null rejects.
      const party = data.party === undefined ? undefined : asPartyPayload(data.party);
      if (party === null) return null;
      // Quirk (pinned, v9): murder snapshots carry their payload the same
      // way — absent = pre-v9 server → the key is OMITTED (v9 clients keep
      // parsing v8 snapshots unchanged); explicit null or garbage rejects.
      const murder = data.murder === undefined ? undefined : asMurderPayload(data.murder);
      if (murder === null) return null;
      return decode(
        data,
        { phase: asPhase, timeLeft: asNumber, bedsAlive: asBooleans, players: asMatchPlayers },
        (m) => ({
          type: 'gameState',
          ...m,
          ...(party !== undefined ? { party } : {}),
          ...(murder !== undefined ? { murder } : {}),
        }),
      );
    }
    case 'gameEvent':
      return asGameEvent(data);
    default:
      return null;
  }
}
