/**
 * Client-side mirror of the Murder Mystery match (M7.3, DESIGN.md §3.6): the
 * authoritative state lives on the server and streams in as 5 Hz `gameState`
 * snapshots (with the `murder` payload) + `gameEvent` frames. This module only
 * stores what the HUD/renderer need and exposes recent events for tests
 * (__mc.murder.events). Nothing here simulates match rules — the zapper jam,
 * charges and coin pickups are all server-owned; the client renders.
 *
 * Guest positions do NOT live here: they ride the `mobs` snapshot stream
 * (kind 'guest') straight into the mob renderer, exactly like sandbox mobs.
 * Per-player counters are kept for ME only (the co-op HUD is first-person);
 * the guest roster carries every guest's alive flag.
 */

import type {
  GameEventMsg,
  GameStateMsg,
  ModeChangedMsg,
  MurderCoinTier,
  MurderGuestColor,
  MurderPhase,
} from '@mc/shared';
import { byId, createEventLog, type MatchResults, type RecentEvent } from './matchMirror';

/** Coins needed for the next zapper charge — HUD progress only (server rule). */
export const COINS_PER_CHARGE = 10;

/** Shirt tint per guest color (mobs.ts person rig; the mesher-style palette). */
export const GUEST_SHIRT_HEX: Record<MurderGuestColor, number> = {
  red: 0xc94b3f,
  blue: 0x3f6fc9,
  green: 0x3f9a4f,
  yellow: 0xd9b23f,
  purple: 0x8a4fc9,
  orange: 0xd9823f,
};

/** CSS colors for the HUD roster dots + the guests' nameplate text. */
export const GUEST_CSS: Record<MurderGuestColor, string> = {
  red: '#e06c5f',
  blue: '#6f96e0',
  green: '#5fc97a',
  yellow: '#e8c95f',
  purple: '#a86fe0',
  orange: '#e09a5f',
};

export interface MurderGuestView {
  id: number;
  /** Kid-legible nameplate text ("Red Guest"). */
  name: string;
  color: MurderGuestColor;
  alive: boolean;
}

export interface MurderCoinView {
  id: number;
  x: number;
  y: number;
  z: number;
  tier: MurderCoinTier;
}

/**
 * One gravestone (client-side list, built from guestKilled events): the
 * server's stone cell is the FLOORED event spot, so both the map key and the
 * investigate send use the floored coordinates.
 */
export interface MurderGravestoneView {
  /** Floored stone cell (the investigateGravestone payload). */
  x: number;
  y: number;
  z: number;
  victimId: number;
  /** Resolved from the roster at event time ("Red Guest"); unknown → undefined. */
  victimName?: string;
  /** My epoch ms when the guestKilled event arrived (freshness display). */
  diedAt: number;
}

/** Shared match-end shape (matchMirror.ts) under the murder name. */
export type MurderResults = MatchResults;

/** Recent raw events, oldest first — automation/assertion hook (__mc.murder.events). */
export type MurderRecentEvent = RecentEvent;

export interface MurderState {
  readonly active: true;
  /** Manor spawn slot (0/1); −1 = spectating (mid-match joiner). */
  myTeam: number;
  myId: number | null;
  phase: MurderPhase | 'ended' | null;
  /** Seconds left from the last snapshot (the HUD interpolates via endsAt). */
  timeLeft: number;
  /** My epoch ms deadline — Date.now() + timeLeft·1000 at the last snapshot. */
  endsAt: number;
  guests: Map<number, MurderGuestView>;
  coinItems: Map<number, MurderCoinView>;
  /** MY coins held (progress to the next charge: coins / COINS_PER_CHARGE). */
  coins: number;
  /** MY zapper charges (start 1, +1 per 10 coins; a wrong zap costs one). */
  charges: number;
  /** MY jam expiry (server epoch ms; 0 = usable). */
  jammedUntil: number;
  /** Final-minute Detector for ME: true while the murderer is within ~12. */
  detectorNear: boolean;
  /** ME — false once the murderer got me (ghost free-fly). */
  alive: boolean;
  /** Gravestones by "x,z" (guestKilled events; the roster names the victims). */
  gravestones: Map<string, MurderGravestoneView>;
  events: MurderRecentEvent[];
  results: MurderResults | null;
  guest(id: number | null): MurderGuestView | null;
  /** Records a guestKilled spot; returns the stone (null if already known). */
  addGravestone(x: number, y: number, z: number, victimId: number): MurderGravestoneView | null;
  applyModeChanged(msg: ModeChangedMsg, myId: number | null): void;
  applyGameState(msg: GameStateMsg): void;
  recordEvent(msg: GameEventMsg): void;
}

export function createMurderState(): MurderState {
  let myTeam = -1;
  let myId: number | null = null;
  const guests = new Map<number, MurderGuestView>();
  const coinItems = new Map<number, MurderCoinView>();
  const gravestones = new Map<string, MurderGravestoneView>();
  const log = createEventLog();

  const guest = (id: number | null): MurderGuestView | null => byId(guests, id);

  return {
    active: true,
    get myTeam() {
      return myTeam;
    },
    set myTeam(value: number) {
      myTeam = value;
    },
    get myId() {
      return myId;
    },
    set myId(value: number | null) {
      myId = value;
    },
    phase: null,
    timeLeft: 0,
    endsAt: 0,
    guests,
    coinItems,
    coins: 0,
    charges: 0,
    jammedUntil: 0,
    detectorNear: false,
    alive: true,
    gravestones,
    events: log.events,
    results: null,
    guest,
    addGravestone(x, y, z, victimId) {
      const key = `${Math.floor(x)},${Math.floor(z)}`;
      if (gravestones.has(key)) return null;
      const stone: MurderGravestoneView = {
        x: Math.floor(x),
        y,
        z: Math.floor(z),
        victimId,
        victimName: guests.get(victimId)?.name,
        diedAt: Date.now(),
      };
      gravestones.set(key, stone);
      return stone;
    },
    applyModeChanged(msg, myIdNext) {
      myTeam = msg.yourTeam;
      myId = myIdNext;
      this.phase = null;
      this.timeLeft = 0;
      this.endsAt = 0;
      guests.clear();
      coinItems.clear();
      gravestones.clear();
      this.coins = 0;
      this.charges = 0;
      this.jammedUntil = 0;
      this.detectorNear = false;
      this.alive = true;
      log.clear();
      this.results = null;
    },
    applyGameState(msg) {
      const murder = msg.murder;
      if (!murder) return; // pre-v9 server (or sandbox relay) — nothing to mirror
      // A murder snapshot's phase is one of ours (or 'ended'); anything else
      // would mean a misdelivered frame — keep null rather than misfile it.
      const phase = msg.phase;
      this.phase =
        phase === 'ended' || phase === 'mingle' || phase === 'bold' || phase === 'hunt' ? phase : null;
      this.timeLeft = msg.timeLeft;
      this.endsAt = Date.now() + msg.timeLeft * 1000;
      guests.clear();
      for (const entry of murder.guests) {
        guests.set(entry.id, { ...entry });
      }
      coinItems.clear();
      for (const coin of murder.coinItems ?? []) {
        coinItems.set(coin.id, { ...coin });
      }
      this.coins = myId !== null ? (murder.coins[myId] ?? 0) : 0;
      this.charges = myId !== null ? (murder.charges[myId] ?? 0) : 0;
      this.jammedUntil = myId !== null ? (murder.jammedUntil[myId] ?? 0) : 0;
      this.detectorNear = myId !== null ? (murder.detector[myId] === true) : false;
      // Refresh the roster's alive flags into recorded gravestones too —
      // names are stable, but a late joiner may learn them only now.
      for (const stone of gravestones.values()) {
        if (stone.victimName === undefined) stone.victimName = guests.get(stone.victimId)?.name;
      }
    },
    recordEvent: log.record,
  };
}
