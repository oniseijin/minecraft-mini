/**
 * Murder Mystery co-op engine (DESIGN.md §3.6, M7.2) — the server half of the
 * whodunit: 1–2 human Detectives vs 6 wandering NPC guests, one of whom is
 * secretly the murderer. party.ts is the structural template: a stateless-
 * functions module around a `MurderMatch` state object with (deps, match, …)
 * signatures — startMurderMatch / murderModeChanged / murderGameState /
 * murderTick / murderEdit / murderOnMoved / murderOnPlayerLeft — dispatched
 * by match.ts like the party arms.
 *
 * The match world is the generated manor (shared/src/manor.ts) — guests walk
 * it with the shared locomotion primitives (locomotion.ts stepWalker, the
 * mobs.ts policy: hop 1-block ledges, refuse walls, refuse drops) and their
 * positions ride the existing dirty-only `mobs` snapshot stream as
 * kind:'guest' entries (ids 1001+, living guests only — absent = despawned
 * client-side). The sandbox MobManager pauses outside 'sandbox', so these
 * are the only mob frames during a match.
 *
 * Cast & roles (§3.6): six guests (Red/Blue/Green/Yellow/Purple/Orange Guest)
 * wander idle-heavy like sandbox mobs; one is the murderer, identical in look
 * and idle behavior. Vs guests its melee is an instant kill (Hive sword) that
 * leaves a gravestone; vs humans it takes 2 hits (kid-first: first hit is a
 * knockback event, second kills → ghost via the death event).
 *
 * Deduction tells (the kid-readable behavior set):
 *   1. the murderer never biases toward coins (innocents window-shop) and
 *      never flees anything;
 *   2. innocent guests panic-flee fresh gravestones and witnessed strikes —
 *      the murderer never reacts to bodies;
 *   3. in the bold phase the murderer occasionally stops and watches a
 *      nearby human (~1.5 s);
 *   4. gravestones appear where the murderer has been (circumstantial);
 *   5. in the hunt phase the per-player `detector` flag (gameState.murder)
 *      is true while the murderer is within 12 blocks — the guaranteed
 *      final-minute climax.
 *
 * Escalation (5:00 Hive clock): 0–90 s mingle (kills only fully-isolated
 * guests: victim ≥12 from every living human, ≥8 from every other living
 * guest), then bold (isolation relaxed to ≥8, decisions every 5–8 s, watch
 * tell on), last 60 s hunt (chase the nearest living human at 5.0 — under
 * the 5.6 player sprint, so outrunning works).
 *
 * Coins & zapper: gold/epic/super coins worth 1/3/6 appear one every ~4 s
 * (cap 14 on the floor; super ONLY at the four secluded corners); walking
 * within 0.8 picks one up (party-box rule, checked on the 20 Hz move relay
 * and every tick); +1 zapper charge per 10 coins. A correct zap kills the
 * murderer → both humans win; a wrong zap confirms the guest innocent,
 * shatters the zapper (10 s jam; the client applies the 5 s stun from
 * jammedUntil — M7.3) and knocks the shooter back. Gravestone investigation
 * (walk up + press E): 30 s cooldown, answers victim + age.
 *
 * Endings all broadcast murdererRevealed{id} then matchEnd: correct zap →
 * humans win; both humans dead → murderer wins; timer expiry → humans win
 * (the murderer ran out of time); a disconnect hands the win to the
 * remaining detective (leaveMidMatch, party precedent). `ready` from the
 * players rematches (the shared recordReady gate works on MurderMatch).
 *
 * Test-forcing envs (read once at module init, mob-manager style):
 * MM_ROUND_MS (round length), MM_MURDERER_GUEST (1..6 forces the killer),
 * MM_ESCALATE_AT_MS (elapsed ms when hunt begins), MM_COIN_TIER (forces
 * every coin spawn to one tier — super still spawns only at the corners).
 */
import {
  AIR,
  MANOR,
  MURDER_COIN_TIERS,
  MURDER_GUEST_COLORS,
  MURDER_SEED,
  generateManorWorld,
  type BlockEditMsg,
  type GameStateMsg,
  type InvestigateGravestoneMsg,
  type MatchEndStats,
  type ModeChangedMsg,
  type MurderCoinTier,
  type MurderCountState,
  type MurderDetectorState,
  type MurderGuestColor,
  type MurderPhase,
  type ServerMessage,
  type World,
  type ZapGuestMsg,
} from '@mc/shared';
import type { ServerPlayer } from './match';
import { leaveMidMatch, rejectEdit, type ServerContext } from './matchLifecycle';
import { faceTowards, stepWalker, type LocomotionOptions, type StepResult } from './locomotion';

// --- tuning (Hive numbers per DESIGN.md §3.6) ----------------------------------

/** 5:00 round clock — the Hive Murder Mystery timer (MM_ROUND_MS forces it). */
const ROUND_MS = readEnvMs('MM_ROUND_MS', 300_000);
/** 0–90 s mingle: the murderer only strikes fully-isolated guests. */
const MINGLE_MS = 90_000;
/** Final 60 s hunt: chase + Detector (Hive endgame). */
const HUNT_MS = 60_000;
/** Elapsed ms when the hunt begins (MM_ESCALATE_AT_MS forces it for tests). */
const ESCALATE_AT_MS = readEnvMs('MM_ESCALATE_AT_MS', Math.max(MINGLE_MS, ROUND_MS - HUNT_MS));
/** Detector (final minute): pulses while the murderer is within this. */
const DETECTOR_RANGE = 12;
/** Detective zapper reach (the party zap-beam precedent). */
const ZAP_RANGE = 20;
/** Walk-over pickup radius + feet-y slack — the party mystery-box rule. */
const COIN_PICKUP_RADIUS = 0.8;
const COIN_PICKUP_Y_SLACK = 2;
/** Hive: innocents earn a 1-shot zapper per 10 gold. */
const COINS_PER_CHARGE = 10;
/** Coin values (faithful): gold 1 / epic 3 / super 6. */
const COIN_VALUES: Record<MurderCoinTier, number> = { gold: 1, epic: 3, super: 6 };
/** Live floor coins at once; one spawns every COIN_SPAWN_MS. */
const COIN_CAP = 14;
const COIN_SPAWN_MS = 4_000;
/** Unforced tier roll: 70% gold / 30% epic (super only via the corner rule). */
const GOLD_CHANCE = 0.7;
/** Wrong-zap guardrails (kid-first): the zapper jams 10 s; the shooter is
 * stunned 5 s — applied CLIENT-side from jammedUntil (M7.3), so this module
 * only owns the authoritative jam. */
const JAM_MS = 10_000;
const STUN_MS = 5_000;
/** Gravestone investigation: 30 s per-player cooldown (Hive Sheriff rule). */
const INVESTIGATE_CD_MS = 30_000;
/** The requested (x, z) must be within this of a gravestone. */
const INVESTIGATE_RANGE = 3;
/** Murderer melee vs humans: 2 hits to kill (kid-first), first hit knocks. */
const HUMAN_HP = 2;
const HUMAN_MELEE_RANGE = 1.8;
/** No same-tick / spam double hits — one swing per window (zombie-shove precedent). */
const SWING_COOLDOWN_MS = 1_200;
/** Murderer walk 4.3 (strike approach) / chase 5.0 — under the 5.6 player
 * sprint, so the hunt stays outrunnable. Mingle/bold WANDERING uses
 * GUEST_WALK below: the murderer moves identically to innocents until it
 * strikes (no speed tell). */
const MURDERER_WALK = 4.3;
const MURDERER_CHASE = 5.0;
/** Innocent guests stroll at 3.2; panic-flee is 2× (mob precedent). */
const GUEST_WALK = 3.2;
const GUEST_FLEE = 6.4;
const GUEST_YAW_RATE = 8;

// --- brains ---------------------------------------------------------------------

/** Wander re-decision window (innocents + the murderers' idle walk). */
const WANDER_DECIDE_MIN_MS = 6_000;
const WANDER_DECIDE_MAX_MS = 15_000;
const IDLE_CHANCE = 0.4;
/** Murderer decision cadence: 8–15 s in mingle, 5–8 s in bold. */
const DECIDE_MINGLE_MIN_MS = 8_000;
const DECIDE_MINGLE_MAX_MS = 15_000;
const DECIDE_BOLD_MIN_MS = 5_000;
const DECIDE_BOLD_MAX_MS = 8_000;
/** Strike isolation: victim ≥ this from every living human (mingle/bold)… */
const STRIKE_HUMAN_DIST_MINGLE = 12;
const STRIKE_HUMAN_DIST_BOLD = 8;
/** …and ≥ this from every other living guest. */
const STRIKE_GUEST_DIST = 8;
/** Kill contact range on guests (Hive sword: instant). */
const GUEST_KILL_RANGE = 1.2;
/** The watch tell (bold): stop and face a human within 10 for ~1.5 s. */
const WATCH_RANGE = 10;
const WATCH_MS = 1_500;
const WATCH_CHANCE = 0.4;
/** Chase/strike wall-slide: on a blocked step, detour via the courtyard. */
const DETOUR_MS = 1_200;
/** Panic: flee 5 s from fresh gravestones (≤10 s old, ≤6 away) and witnessed strikes (≤10 away). */
const PANIC_MS = 5_000;
const GRAVESTONE_PANIC_RADIUS = 6;
const GRAVESTONE_FRESH_MS = 10_000;
const WITNESS_RADIUS = 10;
/** Knockback impulse (client-applied velocity delta, zombie-shove math). */
const KNOCKBACK_POWER = 6;
const KNOCKBACK_UP = 0.45;
/** Innocents window-shop: may wander toward a coin within this (never consume). */
const COIN_BIAS_RADIUS = 8;
const COIN_BIAS_CHANCE = 0.5;
/** Guest mob ids start at 1001 — the sandbox MobManager's ids never reach this. */
const GUEST_ID_BASE = 1001;
/** Guests are not punchable — the mobs snapshot carries this constant (protocol v9 note). */
const GUEST_HP = 2;
/** Dirty-only guest relay: at most every ~180 ms, only when changed (mobs.ts pattern). */
const SNAPSHOT_MIN_MS = 180;

// --- test-forcing envs (read once at module init) --------------------------------

function readEnvMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** MM_MURDERER_GUEST: guest index 1..6 forces the killer; 0/absent = seeded pick. */
const FORCED_MURDERER_INDEX = (() => {
  const raw = Number(process.env.MM_MURDERER_GUEST);
  return Number.isInteger(raw) && raw >= 1 && raw <= MURDER_GUEST_COLORS.length ? raw : 0;
})();

/** MM_COIN_TIER: forces every spawn's tier ('gold' | 'epic' | 'super'). */
const FORCED_COIN_TIER: MurderCoinTier | null = (MURDER_COIN_TIERS as readonly string[]).includes(
  process.env.MM_COIN_TIER ?? '',
)
  ? (process.env.MM_COIN_TIER as MurderCoinTier)
  : null;

// --- state ------------------------------------------------------------------------

export interface MurderPlayer {
  id: number;
  name: string;
  alive: boolean;
  /** Two murderer hits to kill (kid-first; the first hit knocks). */
  hp: number;
  /** Lifetime coins collected (drives charge earning; visible in the HUD). */
  coins: number;
  /** Zapper charges held (start 1, +1 per COINS_PER_CHARGE collected). */
  charges: number;
  /** Charges already earned from coins — so a spent charge stays spent. */
  chargesFromCoins: number;
  /** Wrong-zap jam: the zapper is unusable until this epoch ms. */
  jammedUntil: number;
  /** Gravestone-investigation cooldown expiry. */
  investigateCdUntil: number;
  /** Position mirror (refreshed on every accepted move) — murderGameState
   * computes the detector map without deps, so positions live on the match. */
  x: number;
  y: number;
  z: number;
  deaths: number;
}

export type GuestBrainMode = 'wander' | 'stalk' | 'strike' | 'hunt' | 'flee';

export interface MurderGuest {
  id: number;
  /** Kid-legible nameplate text ("Red Guest"). */
  name: string;
  color: MurderGuestColor;
  alive: boolean;
  x: number;
  y: number;
  z: number;
  yaw: number;
  airborne: boolean;
  yVel: number;
  mode: GuestBrainMode;
  targetX: number;
  targetZ: number;
  /** Epoch ms of the next wander/decision. */
  nextDecisionAt: number;
  /** Watch tell: stands facing this player until watchUntil (bold phase). */
  watchTargetId: number | null;
  watchUntil: number;
  /** Panic: flees until this epoch ms along fleeAng. */
  fleeUntil: number;
  fleeAng: number;
  /** Strike walk: the guest being stalked. */
  strikeTargetId: number | null;
  /** Wall-slide detour (via the courtyard center) active until this epoch ms. */
  detourUntil: number;
  /** Murderer melee swing cooldown anchor. */
  swingAt: number;
  idle: boolean;
}

export interface MurderGravestone {
  x: number;
  y: number;
  z: number;
  victimId: number;
  diedAt: number;
}

export interface MurderCoin {
  id: number;
  x: number;
  y: number;
  z: number;
  tier: MurderCoinTier;
}

export interface MurderMatch {
  world: World;
  players: Map<number, MurderPlayer>;
  ready: Set<number>;
  phase: MurderPhase | 'ended';
  startedAt: number;
  endsAt: number;
  /** The secretly murderous guest's id (revealed only at match end). */
  murdererGuestId: number;
  guests: MurderGuest[];
  gravestones: MurderGravestone[];
  coins: MurderCoin[];
  /** Standable cells scanned once at start — coin spawns + guest seeds. */
  standable: { x: number; y: number; z: number }[];
  rng: () => number;
  nextCoinId: number;
  nextCoinAt: number;
  /** Last broadcast guest snapshot (dirty detection, mobs.ts pattern). */
  lastMobsSent: string;
  lastMobsAt: number;
}

/** Deterministic mulberry32 (mobs.ts precedent) — per-match randomness. */
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
const round2 = (v: number): number => Math.round(v * 100) / 100;

// --- match setup -----------------------------------------------------------------

/** Walkable interior cells: flat floor with 2 blocks of headroom. */
function scanStandable(world: World): { x: number; y: number; z: number }[] {
  const cells: { x: number; y: number; z: number }[] = [];
  for (let x = MANOR.minX; x <= MANOR.maxX; x++) {
    for (let z = MANOR.minZ; z <= MANOR.maxZ; z++) {
      const top = world.highestBlock(x, z);
      if (top !== MANOR.floorY) continue; // wall columns / anything odd
      if (world.getBlock(x, top + 1, z) !== AIR || world.getBlock(x, top + 2, z) !== AIR) continue;
      cells.push({ x: x + 0.5, y: top + 1, z: z + 0.5 });
    }
  }
  return cells;
}

/**
 * Farthest-point sampling over the standable cells (seeded): guests seed
 * spread across the manor and away from the humans' spawns.
 */
function pickSpreadCells(
  match: MurderMatch,
  roster: ServerPlayer[],
  count: number,
): { x: number; y: number; z: number }[] {
  const fallback = { x: 31.5, y: 31, z: 31.5 };
  if (match.standable.length === 0) return Array.from({ length: count }, () => fallback);
  const distanceTo = (cell: { x: number; z: number }, others: { x: number; z: number }[]): number => {
    let min = Infinity;
    for (const other of others) {
      min = Math.min(min, Math.hypot(other.x - cell.x, other.z - cell.z));
    }
    return min;
  };
  const picked: { x: number; y: number; z: number }[] = [];
  const anchors: { x: number; y: number; z: number }[] = roster.map((p) => ({ x: p.x, y: p.y, z: p.z }));
  let current = match.standable[0];
  let bestDist = -1;
  for (const cell of match.standable) {
    const d = distanceTo(cell, anchors);
    if (d > bestDist) {
      bestDist = d;
      current = cell;
    }
  }
  for (let i = 0; i < count; i++) {
    picked.push(current);
    anchors.push(current);
    let best = current;
    bestDist = -1;
    for (const cell of match.standable) {
      const d = distanceTo(cell, anchors);
      if (d > bestDist) {
        bestDist = d;
        best = cell;
      }
    }
    current = best;
  }
  return picked;
}

/** Starts a fresh match: the manor world, humans at the south entrance, six guests seeded into the rooms, one secret murderer. */
export function startMurderMatch(deps: ServerContext, roster: ServerPlayer[]): MurderMatch {
  const world = generateManorWorld();
  const now = Date.now();
  const match: MurderMatch = {
    world,
    players: new Map(),
    ready: new Set(),
    phase: 'mingle',
    startedAt: now,
    endsAt: now + ROUND_MS,
    murdererGuestId: 0,
    guests: [],
    gravestones: [],
    coins: [],
    standable: scanStandable(world),
    rng: mulberry32((MURDER_SEED ^ now) >>> 0),
    nextCoinId: 1,
    nextCoinAt: now + COIN_SPAWN_MS,
    lastMobsSent: '',
    lastMobsAt: 0,
  };

  // Humans first (guests seed away from their spawns).
  roster.forEach((entry, index) => {
    const spawn = MANOR.spawns[index] ?? MANOR.spawns[0];
    entry.x = spawn.x;
    entry.y = spawn.y;
    entry.z = spawn.z;
    entry.yaw = spawn.yaw;
    match.players.set(entry.id, {
      id: entry.id,
      name: entry.name,
      alive: true,
      hp: HUMAN_HP,
      coins: 0,
      charges: 1,
      chargesFromCoins: 0,
      jammedUntil: 0,
      investigateCdUntil: 0,
      x: spawn.x,
      y: spawn.y,
      z: spawn.z,
      deaths: 0,
    });
  });

  const seeds = pickSpreadCells(match, roster, MURDER_GUEST_COLORS.length);
  MURDER_GUEST_COLORS.forEach((color, i) => {
    const seed = seeds[i] ?? seeds[0];
    match.guests.push({
      id: GUEST_ID_BASE + i,
      name: `${color[0].toUpperCase()}${color.slice(1)} Guest`,
      color,
      alive: true,
      x: seed.x,
      y: seed.y,
      z: seed.z,
      yaw: match.rng() * Math.PI * 2,
      airborne: false,
      yVel: 0,
      mode: 'wander',
      targetX: seed.x,
      targetZ: seed.z,
      nextDecisionAt: now + match.rng() * WANDER_DECIDE_MAX_MS,
      watchTargetId: null,
      watchUntil: 0,
      fleeUntil: 0,
      fleeAng: 0,
      strikeTargetId: null,
      detourUntil: 0,
      swingAt: 0,
      idle: true,
    });
  });

  const murdererIndex =
    FORCED_MURDERER_INDEX > 0 ? FORCED_MURDERER_INDEX - 1 : Math.floor(match.rng() * match.guests.length);
  match.murdererGuestId = match.guests[murdererIndex].id;

  deps.log(
    `[murder] match started — ${roster.map((p) => p.name).join(' vs ')} — 6 guests seeded` +
      `, murderer ${FORCED_MURDERER_INDEX > 0 ? `forced (slot ${FORCED_MURDERER_INDEX})` : 'seeded'} in secret`,
  );
  return match;
}

/** World-swap payload: the whole manor rides as the initial edit batch. */
export function murderModeChanged(match: MurderMatch, yourTeam: number): ModeChangedMsg {
  return {
    type: 'modeChanged',
    mode: 'murder',
    seed: MURDER_SEED,
    edits: match.world.serializeEdits(),
    spawns: MANOR.spawns.map((spawn) => ({ ...spawn })),
    beds: [],
    yourTeam,
  };
}

/**
 * 5 Hz snapshot: phase (mingle/bold/hunt, 'ended' after the match), seconds
 * left, and the murder payload — guest roster, per-player coin/charge
 * counters, active jams, and the final-minute detector flags (true only in
 * the hunt phase, per living player, while the murderer is within 12).
 */
export function murderGameState(match: MurderMatch, now: number): GameStateMsg {
  const coins: MurderCountState = {};
  const charges: MurderCountState = {};
  const jammedUntil: MurderCountState = {};
  const detector: MurderDetectorState = {};
  const murderer = match.guests.find((guest) => guest.id === match.murdererGuestId);
  for (const pp of match.players.values()) {
    coins[pp.id] = pp.coins;
    charges[pp.id] = pp.charges;
    if (pp.jammedUntil > now) jammedUntil[pp.id] = pp.jammedUntil;
    detector[pp.id] =
      match.phase === 'hunt' &&
      pp.alive &&
      murderer !== undefined &&
      Math.hypot(pp.x - murderer.x, pp.y - murderer.y, pp.z - murderer.z) <= DETECTOR_RANGE;
  }
  return {
    type: 'gameState',
    phase: match.phase,
    timeLeft: Math.max(0, Math.round((match.endsAt - now) / 1000)),
    bedsAlive: [],
    players: [],
    murder: {
      guests: match.guests.map((guest) => ({
        id: guest.id,
        name: guest.name,
        color: guest.color,
        alive: guest.alive,
      })),
      coinItems: match.coins.map((coin) => ({
        id: coin.id,
        x: coin.x,
        y: coin.y,
        z: coin.z,
        tier: coin.tier,
      })),
      coins,
      charges,
      jammedUntil,
      detector,
    },
  };
}

/** All client edits are rejected — the manor is fully server-owned. */
export function murderEdit(deps: ServerContext, match: MurderMatch, player: ServerPlayer, msg: BlockEditMsg): boolean {
  rejectEdit(deps.sendTo, match.world, player, msg, 'the manor is server-owned', 'murder', deps.log);
  return true;
}

/** Coin pickups (party-box rule) + cheap murderer-melee checks on every move. */
export function murderOnMoved(deps: ServerContext, match: MurderMatch, player: ServerPlayer): void {
  const pp = match.players.get(player.id);
  if (!pp) return;
  pp.x = player.x;
  pp.y = player.y;
  pp.z = player.z;
  if (match.phase === 'ended' || !pp.alive) return;
  checkCoinPickups(deps, match);
  tryMurdererMelee(deps, match, Date.now());
}

// --- tick -------------------------------------------------------------------------

function phaseAt(elapsed: number): MurderPhase {
  if (elapsed >= ESCALATE_AT_MS) return 'hunt';
  if (elapsed >= Math.min(MINGLE_MS, ESCALATE_AT_MS)) return 'bold';
  return 'mingle';
}

/**
 * 200 ms tick: escalation phases, coin spawns + lazy pickups, the guest
 * brains (murderer + innocents), melee, and the dirty-only guest snapshot.
 */
export function murderTick(deps: ServerContext, match: MurderMatch, now: number, dt: number): void {
  if (match.phase === 'ended') return;
  if (now >= match.endsAt) {
    // Timer expiry: the murderer ran out of time — the Detectives win (§3.6).
    const survivor =
      [...match.players.values()].find((pp) => pp.alive) ?? [...match.players.values()][0];
    if (survivor) {
      endMurderMatch(deps, match, survivor.id, survivor.name, 'the murderer ran out of time — the Detectives win');
    } else {
      match.phase = 'ended';
    }
    return;
  }
  match.phase = phaseAt(now - match.startedAt);

  tickCoinSpawns(match, now);
  checkCoinPickups(deps, match); // lazy pickups, party tickBoxes pattern

  for (const guest of match.guests) {
    if (!guest.alive) continue;
    if (guest.id === match.murdererGuestId) stepMurderer(deps, match, guest, now, dt);
    else stepInnocent(match, guest, now, dt);
  }
  tryMurdererMelee(deps, match, now); // hunt contact (also checked on every human move)
  broadcastGuests(deps, match, false);
}

// --- coins -------------------------------------------------------------------------

function tickCoinSpawns(match: MurderMatch, now: number): void {
  if (now < match.nextCoinAt || match.coins.length >= COIN_CAP) return;
  match.nextCoinAt = now + COIN_SPAWN_MS;
  const tier = FORCED_COIN_TIER ?? (match.rng() < GOLD_CHANCE ? 'gold' : 'epic');
  const cell = pickCoinCell(match, tier);
  if (!cell) return;
  match.coins.push({ id: match.nextCoinId++, x: cell.x, y: cell.y, z: cell.z, tier });
}

/**
 * A free standable cell for the tier. Super coins spawn ONLY at the four
 * secluded corners (§3.6) — including when MM_COIN_TIER forces the tier, so
 * the map rule survives test forcing (4 supers can exist at once at most).
 */
function pickCoinCell(match: MurderMatch, tier: MurderCoinTier): { x: number; y: number; z: number } | null {
  const taken = (x: number, z: number): boolean =>
    match.coins.some((coin) => Math.hypot(coin.x - x, coin.z - z) < 1);
  if (tier === 'super') {
    const free = MANOR.superCoinSpots.filter((spot) => !taken(spot.x, spot.z));
    if (free.length === 0) return null;
    return free[Math.floor(match.rng() * free.length)];
  }
  const free = match.standable.filter((cell) => !taken(cell.x, cell.z));
  if (free.length === 0) return null;
  return free[Math.floor(match.rng() * free.length)];
}

/** Walk-over pickup check for every living player (20 Hz moves + tick). */
function checkCoinPickups(deps: ServerContext, match: MurderMatch): void {
  if (match.coins.length === 0) return;
  for (const pp of match.players.values()) {
    if (!pp.alive || match.coins.length === 0) continue;
    const roster = deps.players.get(pp.id);
    if (!roster) continue;
    for (let i = match.coins.length - 1; i >= 0; i--) {
      const coin = match.coins[i];
      const dist = Math.hypot(roster.x - coin.x, roster.z - coin.z);
      if (dist > COIN_PICKUP_RADIUS || Math.abs(roster.y - coin.y) > COIN_PICKUP_Y_SLACK) continue;
      match.coins.splice(i, 1);
      const value = COIN_VALUES[coin.tier];
      pp.coins += value;
      const earned = Math.floor(pp.coins / COINS_PER_CHARGE);
      while (pp.chargesFromCoins < earned) {
        pp.chargesFromCoins++;
        pp.charges++;
        deps.log(`[murder] ${pp.name} earned a zapper charge (${pp.charges} held, ${pp.coins} coins)`);
      }
      deps.broadcast({ type: 'gameEvent', kind: 'coinPickedUp', playerId: pp.id, value });
    }
  }
}

// --- guest locomotion ----------------------------------------------------------------

/** The guest locomotion policy: flat manor, walls refuse, drops refuse. */
function manorLoco(match: MurderMatch): LocomotionOptions {
  return {
    groundY: (bx, bz) => match.world.highestBlock(bx, bz) + 1,
    allowDrops: false, // one flat slab — a guest never drops off it
    yawRate: GUEST_YAW_RATE,
    checkRiseWhileAirborne: true,
  };
}

/** One walker step through the manor (hops 1-block ledges, refuses walls). */
function stepGuest(
  match: MurderMatch,
  guest: MurderGuest,
  tx: number,
  tz: number,
  speed: number,
  dt: number,
): StepResult {
  return stepWalker(guest, guest, tx, tz, speed, dt, manorLoco(match));
}

// --- innocent guests -----------------------------------------------------------------

function stepInnocent(match: MurderMatch, guest: MurderGuest, now: number, dt: number): void {
  if (guest.mode === 'flee' && now >= guest.fleeUntil) {
    guest.mode = 'wander';
    guest.nextDecisionAt = now; // re-decide immediately
  }
  // Fresh-gravestone panic (the murderer never does this — tell #2).
  if (guest.mode !== 'flee') {
    const stone = nearFreshGravestone(match, guest, now);
    if (stone) panic(match, guest, stone.x, stone.z, now);
  }

  if (now < guest.fleeUntil) {
    guest.idle = false;
    // Flee along the panic heading, clamped so a guest never leaves the manor.
    const fx = clamp(guest.x + Math.cos(guest.fleeAng) * 8, MANOR.minX + 2, MANOR.maxX - 2);
    const fz = clamp(guest.z + Math.sin(guest.fleeAng) * 8, MANOR.minZ + 2, MANOR.maxZ - 2);
    if (stepGuest(match, guest, fx, fz, GUEST_FLEE, dt) === 'blocked') {
      guest.fleeAng += Math.PI / 2; // slide along the obstacle (mob precedent)
    }
    return;
  }

  if (now >= guest.nextDecisionAt) pickWander(match, guest, now, true);
  if (guest.idle) return;
  if (stepGuest(match, guest, guest.targetX, guest.targetZ, GUEST_WALK, dt) !== 'moved') {
    // Arrived (or blocked) — stand until the next wander decision.
    guest.idle = true;
    guest.targetX = guest.x;
    guest.targetZ = guest.z;
  }
}

function nearFreshGravestone(match: MurderMatch, guest: MurderGuest, now: number): MurderGravestone | null {
  for (const stone of match.gravestones) {
    if (now - stone.diedAt > GRAVESTONE_FRESH_MS) continue;
    if (Math.hypot(guest.x - stone.x, guest.z - stone.z) <= GRAVESTONE_PANIC_RADIUS) return stone;
  }
  return null;
}

function panic(match: MurderMatch, guest: MurderGuest, fromX: number, fromZ: number, now: number): void {
  guest.mode = 'flee';
  guest.fleeUntil = now + PANIC_MS;
  guest.fleeAng = Math.atan2(guest.z - fromZ, guest.x - fromX); // directly away
  guest.strikeTargetId = null;
  guest.watchTargetId = null;
  guest.idle = false;
}

/**
 * Idle-heavy wander (mob precedent). `coinBias` is the window-shopping tell:
 * innocents may drift toward a nearby coin (never consuming it); the murderer
 * passes false — it NEVER biases to coins (tell #1).
 */
function pickWander(match: MurderMatch, guest: MurderGuest, now: number, coinBias: boolean): void {
  guest.nextDecisionAt = now + WANDER_DECIDE_MIN_MS + match.rng() * (WANDER_DECIDE_MAX_MS - WANDER_DECIDE_MIN_MS);
  if (match.rng() < IDLE_CHANCE) {
    guest.idle = true;
    guest.targetX = guest.x;
    guest.targetZ = guest.z;
    return;
  }
  guest.idle = false;
  if (coinBias) {
    const coin = match.coins.find((c) => Math.hypot(c.x - guest.x, c.z - guest.z) <= COIN_BIAS_RADIUS);
    if (coin && match.rng() < COIN_BIAS_CHANCE) {
      guest.targetX = clamp(coin.x + (match.rng() - 0.5) * 2, MANOR.minX + 1.5, MANOR.maxX - 1.5);
      guest.targetZ = clamp(coin.z + (match.rng() - 0.5) * 2, MANOR.minZ + 1.5, MANOR.maxZ - 1.5);
      return;
    }
  }
  for (let attempt = 0; attempt < 6; attempt++) {
    const ang = match.rng() * Math.PI * 2;
    const r = 3 + match.rng() * 11; // 3–14 blocks
    const x = clamp(guest.x + Math.cos(ang) * r, MANOR.minX + 2, MANOR.maxX - 2);
    const z = clamp(guest.z + Math.sin(ang) * r, MANOR.minZ + 2, MANOR.maxZ - 2);
    if (match.world.highestBlock(Math.floor(x), Math.floor(z)) !== MANOR.floorY) continue; // not a wall
    guest.targetX = x;
    guest.targetZ = z;
    return;
  }
  guest.targetX = guest.x; // boxed in — stand still this stint
  guest.targetZ = guest.z;
}

// --- the murderer --------------------------------------------------------------------

function strikeHumanDist(phase: MurderPhase | 'ended'): number {
  return phase === 'mingle' ? STRIKE_HUMAN_DIST_MINGLE : STRIKE_HUMAN_DIST_BOLD;
}

/** Nearest living human's roster entry (live positions from the registry). */
function nearestLivingHuman(
  deps: ServerContext,
  match: MurderMatch,
  guest: MurderGuest,
): { roster: ServerPlayer; dist: number } | null {
  let best: ServerPlayer | null = null;
  let bestDist = Infinity;
  for (const pp of match.players.values()) {
    if (!pp.alive) continue;
    const roster = deps.players.get(pp.id);
    if (!roster) continue;
    const dist = Math.hypot(roster.x - guest.x, roster.y - guest.y, roster.z - guest.z);
    if (dist < bestDist) {
      best = roster;
      bestDist = dist;
    }
  }
  return best ? { roster: best, dist: bestDist } : null;
}

/** Distance from a spot to the nearest living human (strike isolation rule). */
function minHumanDist(deps: ServerContext, match: MurderMatch, x: number, y: number, z: number): number {
  let min = Infinity;
  for (const pp of match.players.values()) {
    if (!pp.alive) continue;
    const roster = deps.players.get(pp.id);
    if (!roster) continue;
    min = Math.min(min, Math.hypot(roster.x - x, roster.y - y, roster.z - z));
  }
  return min;
}

/** Distance from a guest to the nearest other living guest (strike isolation rule). */
function minOtherGuestDist(match: MurderMatch, victim: MurderGuest): number {
  let min = Infinity;
  for (const guest of match.guests) {
    if (!guest.alive || guest.id === victim.id) continue;
    min = Math.min(min, Math.hypot(guest.x - victim.x, guest.y - victim.y, guest.z - victim.z));
  }
  return min;
}

function stepMurderer(deps: ServerContext, match: MurderMatch, murderer: MurderGuest, now: number, dt: number): void {
  // Hunt phase: chase the nearest living human (zombie-chase precedent).
  if (match.phase === 'hunt') {
    murderer.mode = 'hunt';
    murderer.strikeTargetId = null;
    murderer.watchTargetId = null;
    const prey = nearestLivingHuman(deps, match, murderer);
    if (!prey) return;
    if (now < murderer.detourUntil) {
      // Wall-slide: head for the courtyard center, then re-chase.
      stepGuest(match, murderer, MANOR.spectatorSpot.x, MANOR.spectatorSpot.z, MURDERER_CHASE, dt);
      return;
    }
    if (stepGuest(match, murderer, prey.roster.x, prey.roster.z, MURDERER_CHASE, dt) === 'blocked') {
      murderer.detourUntil = now + DETOUR_MS;
    }
    return;
  }

  // The watch tell (bold): stand still and face a nearby human (tell #3).
  if (murderer.mode === 'stalk') {
    const watched = murderer.watchTargetId !== null ? deps.players.get(murderer.watchTargetId) : undefined;
    if (now < murderer.watchUntil && watched) {
      faceTowards(murderer, watched.x, watched.z, dt, GUEST_YAW_RATE);
      return;
    }
    murderer.mode = 'wander';
    murderer.watchTargetId = null;
    murderer.nextDecisionAt = now; // decide again right away
  }

  // The strike walk: close on the isolated victim (MURDERER_WALK).
  if (murderer.mode === 'strike') {
    const victim = match.guests.find((guest) => guest.id === murderer.strikeTargetId);
    if (!victim || !victim.alive) {
      murderer.mode = 'wander';
      murderer.strikeTargetId = null;
      murderer.nextDecisionAt = now;
    } else if (minHumanDist(deps, match, victim.x, victim.y, victim.z) < strikeHumanDist(match.phase)) {
      // A witness approached mid-walk — abort (mingle kills stay unwitnessed).
      murderer.mode = 'wander';
      murderer.strikeTargetId = null;
      murderer.nextDecisionAt = now + 2_000;
    } else if (now < murderer.detourUntil) {
      stepGuest(match, murderer, MANOR.spectatorSpot.x, MANOR.spectatorSpot.z, MURDERER_WALK, dt);
    } else {
      if (stepGuest(match, murderer, victim.x, victim.z, MURDERER_WALK, dt) === 'blocked') {
        murderer.detourUntil = now + DETOUR_MS;
      }
      if (Math.hypot(murderer.x - victim.x, murderer.y - victim.y, murderer.z - victim.z) <= GUEST_KILL_RANGE) {
        killGuest(deps, match, murderer, victim, now);
      }
    }
    return;
  }

  // Mingle/bold wander: idle-heavy, identical to the innocents (no speed tell).
  if (now >= murderer.nextDecisionAt) murdererDecide(deps, match, murderer, now);
  if (murderer.idle) return;
  if (stepGuest(match, murderer, murderer.targetX, murderer.targetZ, GUEST_WALK, dt) !== 'moved') {
    murderer.idle = true;
    murderer.targetX = murderer.x;
    murderer.targetZ = murderer.z;
  }
}

/** Mingle/bold decision: maybe the watch tell (bold), maybe a strike on an isolated victim. */
function murdererDecide(deps: ServerContext, match: MurderMatch, murderer: MurderGuest, now: number): void {
  const bold = match.phase === 'bold';
  murderer.nextDecisionAt = now +
    (bold ? DECIDE_BOLD_MIN_MS : DECIDE_MINGLE_MIN_MS) +
    match.rng() * ((bold ? DECIDE_BOLD_MAX_MS : DECIDE_MINGLE_MAX_MS) - (bold ? DECIDE_BOLD_MIN_MS : DECIDE_MINGLE_MIN_MS));
  if (match.rng() < IDLE_CHANCE) {
    murderer.idle = true;
    murderer.targetX = murderer.x;
    murderer.targetZ = murderer.z;
  } else {
    murderer.idle = false;
    pickWanderTarget(match, murderer); // plain wander — NEVER a coin bias (tell #1)
  }

  if (bold && match.rng() < WATCH_CHANCE) {
    const human = nearestLivingHuman(deps, match, murderer);
    if (human && human.dist <= WATCH_RANGE) {
      murderer.mode = 'stalk';
      murderer.watchTargetId = human.roster.id;
      murderer.watchUntil = now + WATCH_MS;
      return;
    }
  }

  // Strike consideration: the nearest living innocent, if fully isolated.
  const victim = nearestLivingInnocent(match, murderer);
  if (!victim) return;
  if (
    minHumanDist(deps, match, victim.x, victim.y, victim.z) >= strikeHumanDist(match.phase) &&
    minOtherGuestDist(match, victim) >= STRIKE_GUEST_DIST
  ) {
    murderer.mode = 'strike';
    murderer.strikeTargetId = victim.id;
    murderer.idle = false;
  }
}

/** Plain wander target for the murderer (no coin bias — the pickWander tell split). */
function pickWanderTarget(match: MurderMatch, guest: MurderGuest): void {
  for (let attempt = 0; attempt < 6; attempt++) {
    const ang = match.rng() * Math.PI * 2;
    const r = 3 + match.rng() * 11;
    const x = clamp(guest.x + Math.cos(ang) * r, MANOR.minX + 2, MANOR.maxX - 2);
    const z = clamp(guest.z + Math.sin(ang) * r, MANOR.minZ + 2, MANOR.maxZ - 2);
    if (match.world.highestBlock(Math.floor(x), Math.floor(z)) !== MANOR.floorY) continue;
    guest.targetX = x;
    guest.targetZ = z;
    return;
  }
  guest.targetX = guest.x;
  guest.targetZ = guest.z;
}

function nearestLivingInnocent(match: MurderMatch, murderer: MurderGuest): MurderGuest | null {
  let best: MurderGuest | null = null;
  let bestDist = Infinity;
  for (const guest of match.guests) {
    if (!guest.alive || guest.id === murderer.id) continue;
    const dist = Math.hypot(guest.x - murderer.x, guest.y - murderer.y, guest.z - murderer.z);
    if (dist < bestDist) {
      best = guest;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * The strike lands: instant kill (Hive sword), a gravestone marks the spot,
 * innocent witnesses within 10 panic-flee 5 s (the murderer never reacts —
 * tell #2), and the cast snapshot pushes immediately.
 */
function killGuest(deps: ServerContext, match: MurderMatch, murderer: MurderGuest, victim: MurderGuest, now: number): void {
  victim.alive = false;
  const stone: MurderGravestone = {
    x: Math.floor(victim.x),
    y: MANOR.floorY,
    z: Math.floor(victim.z),
    victimId: victim.id,
    diedAt: now,
  };
  match.gravestones.push(stone);
  deps.broadcast({
    type: 'gameEvent',
    kind: 'guestKilled',
    x: round2(victim.x),
    y: round2(victim.y),
    z: round2(victim.z),
    victimId: victim.id,
  });
  for (const guest of match.guests) {
    if (!guest.alive || guest.id === murderer.id) continue;
    if (Math.hypot(guest.x - victim.x, guest.z - victim.z) <= WITNESS_RADIUS) {
      panic(match, guest, victim.x, victim.z, now);
    }
  }
  murderer.mode = 'wander';
  murderer.strikeTargetId = null;
  murderer.nextDecisionAt = now; // think again next tick
  broadcastGuests(deps, match, true); // the cast changed
  deps.log(`[murder] ${victim.name} was got — gravestone at (${stone.x}, ${stone.z})`);
}

/**
 * Murderer melee vs humans: first hit knocks (red-flash chase drama), the
 * second kills → ghost. One swing per cooldown window. Called from the tick
 * (the murderer walks into you) and murderOnMoved (you walk into it).
 */
function tryMurdererMelee(deps: ServerContext, match: MurderMatch, now: number): void {
  const murderer = match.guests.find((guest) => guest.id === match.murdererGuestId);
  if (!murderer || !murderer.alive) return;
  for (const pp of match.players.values()) {
    if (!pp.alive) continue;
    const roster = deps.players.get(pp.id);
    if (!roster) continue;
    const dist = Math.hypot(roster.x - murderer.x, roster.y - murderer.y, roster.z - murderer.z);
    if (dist > HUMAN_MELEE_RANGE) continue;
    if (now - murderer.swingAt < SWING_COOLDOWN_MS) return; // one swing per window
    murderer.swingAt = now;
    pp.hp -= 1;
    const dx = roster.x - murderer.x;
    const dz = roster.z - murderer.z;
    const len = Math.hypot(dx, dz) || 1;
    if (pp.hp <= 0) {
      pp.alive = false;
      pp.deaths++;
      deps.broadcast({
        type: 'gameEvent',
        kind: 'death',
        playerId: pp.id,
        cause: 'combat',
        killerId: murderer.id,
        respawnIn: 0,
      });
      deps.log(`[murder] ${pp.name} was got by the murderer — ghost`);
      checkMurdererWins(deps, match);
    } else {
      deps.broadcast({
        type: 'gameEvent',
        kind: 'knockback',
        playerId: pp.id,
        dir: { x: dx / len, y: KNOCKBACK_UP, z: dz / len },
        power: KNOCKBACK_POWER,
      });
      deps.log(`[murder] the murderer struck ${pp.name} (${pp.hp} hp left)`);
    }
    return;
  }
}

/** Both humans dead → the murderer wins (§3.6). */
function checkMurdererWins(deps: ServerContext, match: MurderMatch): void {
  if (match.players.size === 0) return;
  const murderer = match.guests.find((guest) => guest.id === match.murdererGuestId);
  if ([...match.players.values()].some((pp) => pp.alive)) return;
  endMurderMatch(
    deps,
    match,
    match.murdererGuestId,
    murderer ? murderer.name : 'The Murderer',
    'both detectives were got — the murderer wins',
  );
}

// --- zapper + investigation -----------------------------------------------------------

/**
 * The detective zapper (C→S zapGuest): mode running, sender alive, target a
 * living guest, charges > 0, not jammed, within ZAP_RANGE of the roster
 * position. Invalid target/range toast an error and consume nothing.
 */
export function murderZapGuest(deps: ServerContext, match: MurderMatch, player: ServerPlayer, msg: ZapGuestMsg): void {
  const now = Date.now();
  const fail = (message: string): void => {
    deps.sendTo(player.socket, { type: 'gameEvent', kind: 'error', message });
    deps.log(`[murder] zapGuest from ${player.name} rejected: ${message}`);
  };
  if (match.phase === 'ended') return fail('The match is over');
  const pp = match.players.get(player.id);
  if (!pp) return fail('Only detectives can zap');
  if (!pp.alive) return fail('Ghosts cannot zap');
  const guest = match.guests.find((entry) => entry.id === msg.id);
  if (!guest || !guest.alive) return fail('Aim at a living guest!');
  if (pp.charges <= 0) return fail('No zapper charges — 10 coins earn another');
  if (now <= pp.jammedUntil) return fail('Your zapper is jammed!');
  const dist = Math.hypot(player.x - guest.x, player.y - guest.y, player.z - guest.z);
  if (dist > ZAP_RANGE) return fail(`Too far — the zapper reaches ${ZAP_RANGE} blocks`);

  pp.charges -= 1;
  if (guest.id === match.murdererGuestId) {
    // Correct: the murderer is killed and revealed — both humans win.
    guest.alive = false;
    deps.broadcast({ type: 'gameEvent', kind: 'zapped', by: player.id, targetId: guest.id, correct: true });
    deps.log(`[murder] ${player.name} zapped the murderer — humans win!`);
    endMurderMatch(deps, match, player.id, player.name, `${player.name} zapped the murderer`);
    return;
  }
  // Wrong zap (kid-first guardrail): the guest is confirmed innocent, the
  // zapper shatters — a 10 s jam, and the client applies the 5 s stun from
  // jammedUntil (the knockback event stands in for the stun impulse).
  deps.broadcast({ type: 'gameEvent', kind: 'zapped', by: player.id, targetId: guest.id, correct: false });
  pp.jammedUntil = now + JAM_MS;
  const dx = player.x - guest.x;
  const dz = player.z - guest.z;
  const len = Math.hypot(dx, dz) || 1;
  deps.broadcast({
    type: 'gameEvent',
    kind: 'knockback',
    playerId: player.id,
    dir: { x: dx / len, y: KNOCKBACK_UP, z: dz / len },
    power: KNOCKBACK_POWER,
  });
  panic(match, guest, player.x, player.z, now); // the zap scared the innocent
  deps.log(`[murder] ${player.name} zapped ${guest.name} — innocent! zapper jammed ${JAM_MS / 1000}s`);
}

/**
 * Gravestone investigation (C→S investigateGravestone): the requested (x, z)
 * must sit within 3 blocks of a gravestone, 30 s cooldown per player; answers
 * with the victim's name + age (broadcast — everyone learns the spot).
 */
export function murderInvestigate(
  deps: ServerContext,
  match: MurderMatch,
  player: ServerPlayer,
  msg: InvestigateGravestoneMsg,
): void {
  const now = Date.now();
  const fail = (message: string): void => {
    deps.sendTo(player.socket, { type: 'gameEvent', kind: 'error', message });
    deps.log(`[murder] investigateGravestone from ${player.name} rejected: ${message}`);
  };
  if (match.phase === 'ended') return fail('The match is over');
  const pp = match.players.get(player.id);
  if (!pp) return fail('Only detectives can investigate');
  if (!pp.alive) return fail('Ghosts cannot investigate');
  if (now <= pp.investigateCdUntil) return fail('You need a moment before investigating again');
  const stone = match.gravestones.find(
    (entry) => Math.hypot(entry.x - msg.x, entry.z - msg.z) <= INVESTIGATE_RANGE,
  );
  if (!stone) return fail('No gravestone there');
  pp.investigateCdUntil = now + INVESTIGATE_CD_MS;
  const victim = match.guests.find((guest) => guest.id === stone.victimId);
  const ageSeconds = Math.max(0, Math.round((now - stone.diedAt) / 1000));
  deps.broadcast({
    type: 'gameEvent',
    kind: 'gravestoneRead',
    x: stone.x,
    z: stone.z,
    victimName: victim ? victim.name : 'A Guest',
    ageSeconds,
  });
  deps.log(`[murder] ${player.name} read the gravestone at (${stone.x}, ${stone.z}) — ${ageSeconds}s old`);
}

// --- endings -------------------------------------------------------------------------

/**
 * Every ending broadcasts murdererRevealed{id} then matchEnd (party endMatch
 * shape). winnerId is the zap shooter / surviving detective on a humans win,
 * the murderer's GUEST id on a murderer win.
 */
function endMurderMatch(deps: ServerContext, match: MurderMatch, winnerId: number, winnerName: string, why: string): void {
  if (match.phase === 'ended') return;
  match.phase = 'ended';
  match.endsAt = Date.now();
  deps.broadcast({ type: 'gameEvent', kind: 'murdererRevealed', id: match.murdererGuestId });
  const stats: MatchEndStats[] = [...match.players.values()].map((pp) => ({
    id: pp.id,
    name: pp.name,
    kills: 0,
    deaths: pp.deaths,
  }));
  deps.broadcast({ type: 'gameEvent', kind: 'matchEnd', winnerId, winnerName, stats });
  deps.log(`[murder] match ended — ${why}`);
}

/** Disconnect handling; true when the match just ended by dropout. */
export function murderOnPlayerLeft(deps: ServerContext, match: MurderMatch, player: ServerPlayer): boolean {
  const winner = leaveMidMatch(match, 'murder', player, deps.log);
  if (!winner) return false;
  // Win by default for whoever remains (party precedent).
  endMurderMatch(deps, match, winner.id, winner.name, `${winner.name} wins by default — the other detective left`);
  return true;
}

// --- guest snapshot ---------------------------------------------------------------------

/**
 * Dirty-only `mobs` relay for the LIVING guests (kind:'guest', hp constant —
 * absent ids despawn client-side). The sandbox MobManager is paused during a
 * match, so this is the only mob traffic; ids 1001+ never collide with it.
 */
function broadcastGuests(deps: ServerContext, match: MurderMatch, force: boolean): void {
  const msg = {
    type: 'mobs' as const,
    mobs: match.guests
      .filter((guest) => guest.alive)
      .sort((a, b) => a.id - b.id)
      .map((guest) => ({
        id: guest.id,
        kind: 'guest' as const,
        x: Math.round(guest.x * 1000) / 1000,
        y: Math.round(guest.y * 1000) / 1000,
        z: Math.round(guest.z * 1000) / 1000,
        yaw: Math.round(guest.yaw * 1000) / 1000,
        hp: GUEST_HP,
      })),
  };
  const serialized = JSON.stringify(msg);
  const now = Date.now();
  if (!force && (serialized === match.lastMobsSent || now - match.lastMobsAt < SNAPSHOT_MIN_MS)) return;
  match.lastMobsSent = serialized;
  match.lastMobsAt = now;
  deps.broadcast(msg satisfies ServerMessage);
}

// The client-applied stun window (see murderZapGuest) — pinned here so the
// guardrail numbers stay documented next to the jam they ride on.
void STUN_MS;
