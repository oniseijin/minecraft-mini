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
  MatchEndStats,
  MatchPhase,
  ModeChangedMsg,
} from '@mc/shared';

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

export interface BwResults {
  winnerId: number;
  winnerName: string;
  stats: MatchEndStats[];
}

/** Recent raw events, oldest first — automation/assertion hook (__mc.bw.events). */
export interface BwRecentEvent {
  kind: string;
  at: number;
  data: Omit<GameEventMsg, 'type'>;
}

export interface BwState {
  readonly active: true;
  myTeam: number;
  myId: number | null;
  spawns: ArenaSpawn[];
  beds: ArenaPoint[];
  phase: MatchPhase | null;
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

const EVENT_CAP = 30;

export function createBwState(): BwState {
  let myTeam = -1;
  let myId: number | null = null;
  const players = new Map<number, BwPlayerView>();

  const me = (): BwPlayerView | null => (myId === null ? null : players.get(myId) ?? null);

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
    events: [],
    results: null,
    get currency(): BwCurrencyView {
      return me()?.currency ?? { iron: 0, gold: 0, emerald: 0 };
    },
    get inv(): BwInventoryView {
      return me()?.inventory ?? { wool: 0, planks: 0, apples: 0, sword: null };
    },
    me,
    player(id) {
      return id === null ? null : players.get(id) ?? null;
    },
    applyModeChanged(msg, myIdNext) {
      myTeam = msg.yourTeam;
      myId = myIdNext;
      this.spawns = msg.spawns.map((spawn) => ({ ...spawn }));
      this.beds = msg.beds.map((bed) => ({ ...bed }));
      this.phase = null;
      this.timeLeft = 0;
      this.bedsAlive = [true, true];
      players.clear();
      this.events.length = 0;
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
          inventory: { ...p.inventory },
        });
      }
    },
    recordEvent(msg) {
      this.events.push({ kind: msg.kind, at: Date.now(), data: msg as Omit<GameEventMsg, 'type'> });
      if (this.events.length > EVENT_CAP) this.events.shift();
    },
  };
}
