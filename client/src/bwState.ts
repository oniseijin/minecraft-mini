/**
 * Client-side mirror of the BedWars match (M4): the authoritative state lives
 * on the server and streams in as 5 Hz `gameState` snapshots + `gameEvent`
 * frames. This module only stores what the HUD needs and exposes recent
 * events for tests/automation (__mc.bw). Nothing here simulates match rules.
 */

import type {
  ArenaPoint,
  ArenaSpawn,
  GameEventMsg,
  GameStateMsg,
  MatchPhase,
  ModeChangedMsg,
  MurderPhase,
  PartyPhase,
} from '@mc/shared';
import { byId, copySpawns, createEventLog, type MatchResults, type RecentEvent } from './matchMirror';

export interface BwCurrencyView {
  iron: number;
  gold: number;
  emerald: number;
}

export interface BwInventoryView {
  wool: number;
  planks: number;
  apples: number;
  sword: 'wooden' | 'stone' | 'iron' | null;
  /** Bow owned + arrow stock (v10; snapshots pre-v10 omit → false/0). */
  bow: boolean;
  arrows: number;
}

export interface BwPlayerView {
  id: number;
  name: string;
  team: number;
  hp: number;
  alive: boolean;
  respawnIn: number;
  kills: number;
  currency: BwCurrencyView;
  inventory: BwInventoryView;
}

/** Shared match-end shape (matchMirror.ts) under the BedWars name. */
export type BwResults = MatchResults;

/** Recent raw events, oldest first — automation/assertion hook (__mc.bw.events). */
export type BwRecentEvent = RecentEvent;

export interface BwState {
  readonly active: true;
  myTeam: number;
  myId: number | null;
  spawns: ArenaSpawn[];
  beds: ArenaPoint[];
  /** BedWars phases (party/murder snapshots never reach this mirror). */
  phase: MatchPhase | PartyPhase | MurderPhase | null;
  timeLeft: number;
  bedsAlive: boolean[];
  players: Map<number, BwPlayerView>;
  events: BwRecentEvent[];
  results: BwResults | null;
  /** MY currency (view of the matching player entry; zeros until known). */
  readonly currency: BwCurrencyView;
  /** MY inventory (view of the matching player entry). */
  readonly inv: BwInventoryView;
  me(): BwPlayerView | null;
  player(id: number | null): BwPlayerView | null;
  applyModeChanged(msg: ModeChangedMsg, myId: number | null): void;
  applyGameState(msg: GameStateMsg): void;
  recordEvent(msg: GameEventMsg): void;
}

export function createBwState(): BwState {
  let myTeam = -1;
  let myId: number | null = null;
  const players = new Map<number, BwPlayerView>();
  const log = createEventLog();

  const me = (): BwPlayerView | null => byId(players, myId);

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
    spawns: [],
    beds: [],
    phase: null,
    timeLeft: 0,
    bedsAlive: [true, true],
    players,
    events: log.events,
    results: null,
    get currency(): BwCurrencyView {
      return me()?.currency ?? { iron: 0, gold: 0, emerald: 0 };
    },
    get inv(): BwInventoryView {
      return me()?.inventory ?? { wool: 0, planks: 0, apples: 0, sword: null, bow: false, arrows: 0 };
    },
    me,
    player(id) {
      return byId(players, id);
    },
    applyModeChanged(msg, myIdNext) {
      myTeam = msg.yourTeam;
      myId = myIdNext;
      this.spawns = copySpawns(msg);
      this.beds = msg.beds.map((bed) => ({ ...bed }));
      this.phase = null;
      this.timeLeft = 0;
      this.bedsAlive = [true, true];
      players.clear();
      log.clear();
      this.results = null;
    },
    applyGameState(msg) {
      this.phase = msg.phase;
      this.timeLeft = msg.timeLeft;
      this.bedsAlive = [msg.bedsAlive[0] ?? true, msg.bedsAlive[1] ?? true];
      players.clear();
      for (const p of msg.players) {
        players.set(p.id, {
          id: p.id,
          name: p.name,
          team: p.team,
          hp: p.hp,
          alive: p.alive,
          respawnIn: p.respawnIn,
          kills: p.kills,
          currency: { ...p.currency },
          inventory: {
            wool: p.inventory.wool,
            planks: p.inventory.planks,
            apples: p.inventory.apples,
            sword: p.inventory.sword,
            bow: p.inventory.bow ?? false,
            arrows: p.inventory.arrows ?? 0,
          },
        });
      }
    },
    recordEvent: log.record,
  };
}
