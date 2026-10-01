/**
 * Client-side mirror of the Block Party match (M5): the authoritative state
 * lives on the server and streams in as 5 Hz `gameState` snapshots (with the
 * `party` payload) + `gameEvent` frames. This module only stores what the HUD
 * needs and exposes recent events for tests/automation (__mc.party.events).
 * Nothing here simulates match rules.
 */

import type {
  ArenaSpawn,
  GameEventMsg,
  GameStateMsg,
  MatchPhase,
  ModeChangedMsg,
  MurderPhase,
  PartyEffectState,
  PartyItemId,
  PartyPhase,
} from '@mc/shared';
import { byId, copySpawns, createEventLog, type MatchResults, type RecentEvent } from './matchMirror';

export interface PartyScoreView {
  playerId: number;
  name: string;
  score: number;
  alive: boolean;
}

/** Client mirror of the fused auto color bomb (protocol v5). */
export interface PartyBombView {
  /** Floor cell [x, z]. */
  cell: [number, number];
  colorId: number;
  /** Server epoch ms of detonation (fuse is interpolated locally). */
  detonatesAt: number;
}

/** Active movement buffs for one player (protocol v7; expiry interpolated). */
export interface PartyEffectsView {
  speedUntil: number;
  jumpUntil: number;
}

/** Shared match-end shape (matchMirror.ts) under the party name. */
export type PartyResults = MatchResults;

/** Recent raw events, oldest first — automation/assertion hook (__mc.party.events). */
export type PartyRecentEvent = RecentEvent;

export interface PartyState {
  readonly active: true;
  /** Spawn slot (0/1); −1 = spectating from the platform (mid-match joiner). */
  myTeam: number;
  myId: number | null;
  spawns: ArenaSpawn[];
  /** Party phases; the shared union also admits bedwars/murder phases (never sent here). */
  phase: MatchPhase | PartyPhase | MurderPhase | null;
  round: number;
  colorId: number;
  colorName: string;
  /** Announce duration of the current round (ms) — the countdown bar's width. */
  roundTimerMs: number;
  /** Server epoch ms when the announce ends (clients interpolate locally). */
  roundEndsAt: number;
  /** The fused auto bomb while one is on the floor, else null. */
  bomb: PartyBombView | null;
  /** Mystery boxes on the floor as cells (protocol v7; cleared at the drop). */
  boxes: [number, number][];
  /** Held item slots per player id (≤3 entries, oldest first). */
  items: Map<number, PartyItemId[]>;
  /** Active speed/jump buffs per player id (expiry = server epoch ms). */
  effects: Map<number, PartyEffectsView>;
  scores: Map<number, PartyScoreView>;
  events: PartyRecentEvent[];
  results: PartyResults | null;
  me(): PartyScoreView | null;
  player(id: number | null): PartyScoreView | null;
  /** True while I'm an alive fighter (not eliminated, not a spectator). */
  meAlive(): boolean;
  applyModeChanged(msg: ModeChangedMsg, myId: number | null): void;
  applyGameState(msg: GameStateMsg): void;
  recordEvent(msg: GameEventMsg): void;
}

export function createPartyState(): PartyState {
  let myTeam = -1;
  let myId: number | null = null;
  const scores = new Map<number, PartyScoreView>();
  const log = createEventLog();

  const me = (): PartyScoreView | null => byId(scores, myId);

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
    phase: null,
    round: 0,
    colorId: 0,
    colorName: '',
    roundTimerMs: 4500,
    roundEndsAt: 0,
    bomb: null,
    boxes: [],
    items: new Map(),
    effects: new Map(),
    scores,
    events: log.events,
    results: null,
    me,
    player(id) {
      return byId(scores, id);
    },
    meAlive() {
      return me()?.alive ?? false;
    },
    applyModeChanged(msg, myIdNext) {
      myTeam = msg.yourTeam;
      myId = myIdNext;
      this.spawns = copySpawns(msg);
      this.phase = null;
      this.round = 0;
      this.colorId = 0;
      this.colorName = '';
      this.roundTimerMs = 4500;
      this.roundEndsAt = 0;
      this.bomb = null;
      this.boxes = [];
      this.items.clear();
      this.effects.clear();
      scores.clear();
      log.clear();
      this.results = null;
    },
    applyGameState(msg) {
      const party = msg.party;
      if (!party) return; // never expected outside party mode
      this.phase = msg.phase;
      this.round = party.round;
      this.colorId = party.colorId;
      this.colorName = party.colorName;
      this.roundTimerMs = party.roundTimerMs;
      this.roundEndsAt = party.roundEndsAt;
      this.bomb = party.bomb ? { ...party.bomb, cell: [...party.bomb.cell] as [number, number] } : null;
      this.boxes = (party.boxes ?? []).map((box) => [...box.cell] as [number, number]);
      this.items.clear();
      for (const [playerId, held] of Object.entries(party.items ?? {})) {
        this.items.set(Number(playerId), [...held]);
      }
      this.effects.clear();
      const effectList: readonly PartyEffectState[] = party.effects ?? [];
      for (const effect of effectList) {
        const view = this.effects.get(effect.playerId) ?? { speedUntil: 0, jumpUntil: 0 };
        if (effect.effect === 'speed') view.speedUntil = effect.until;
        else view.jumpUntil = effect.until;
        this.effects.set(effect.playerId, view);
      }
      scores.clear();
      for (const entry of party.scores) {
        scores.set(entry.playerId, { ...entry });
      }
    },
    recordEvent: log.record,
  };
}
