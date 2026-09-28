/**
 * M4/M5 mode manager (DESIGN.md §3.3 + §3.4) — 'sandbox' ⇄ BedWars Duels
 * 1v1 ⇄ Block Party 1v1. Since REFACTORING.md 2b.1 this file is the MODE
 * REGISTRY: it owns gameMode, the live match references and the glue —
 * roster picking, modeChanged fan-out, rematch gates, the everyone-left
 * reset, healthz/phase + botInfo surfaces.
 *
 * The rules live next door, as stateless (deps, state, …) functions:
 * - BedWars: bedwars.ts (edits/beds, generators, combat, shop, respawns,
 *   sudden death, results).
 * - Block Party: party.ts (the round loop, floor re-randomization, void-kill
 *   falls, scoring, first-to-3).
 *
 * The sandbox path stays exactly as it was: its World + persistent edit
 * overlay are untouched. State is broadcast as a 5 Hz `gameState` snapshot
 * (party snapshots carry the extra `party` payload); notable moments travel
 * as tagged `gameEvent` frames. The tick runs at 200 ms.
 */
import {
  ARENA,
  PARTY,
  type GameMode,
  type MatchPhase,
  type ModeChangedMsg,
  type PartyPhase,
  type ServerMessage,
  type World,
  type ZapCellMsg,
} from '@mc/shared';
import type { WebSocket } from 'ws';
import type { BotInfo } from './bot';
import {
  partyEdit,
  partyGameState,
  partyModeChanged,
  partyOnMoved,
  partyOnPlayerLeft,
  partyTick,
  partyUseItem,
  partyZapCell,
  startPartyMatch,
  type PartyDeps,
  type PartyMatch,
} from './party';
import {
  bedwarsAttack,
  bedwarsBuy,
  bedwarsEdit,
  bedwarsModeChanged,
  bedwarsOnMoved,
  bedwarsOnPlayerLeft,
  bedwarsTick,
  bedwarsUseHeld,
  startBedwarsMatch,
  type Match,
} from './bedwars';
import { announceMode, everyoneLeft, pickRoster, recordReady } from './matchLifecycle';

export interface ServerPlayer {
  id: number;
  name: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  /** Live socket; null for the server-driven test bot (it has no connection). */
  socket: WebSocket | null;
  lastSeen: number;
  /** True only for the test bot roster entry (relayed via PlayerSnapshot.bot). */
  bot?: boolean;
}

export interface MatchDeps {
  /** The persistent sandbox world (read for the sandbox modeChanged overlay). */
  sandboxWorld: World;
  sandboxSeed: number;
  /** Live roster (all connected, joined players). */
  players: Map<number, ServerPlayer>;
  /** Server-side reach limit for edits (same as the sandbox path). */
  reach: number;
  sendTo(socket: WebSocket | null, msg: ServerMessage): void;
  broadcast(msg: ServerMessage): void;
  log(line: string): void;
}

export interface ModeManager {
  readonly mode: GameMode;
  /** BedWars or party phase when a match runs, null in sandbox (healthz/debug). */
  readonly phase: MatchPhase | PartyPhase | null;
  /** Starts the requested game (exactly 2 players online, none running). */
  startGame(player: ServerPlayer, mode: 'bedwars' | 'party'): void;
  ready(player: ServerPlayer): void;
  leaveGame(player: ServerPlayer): void;
  attack(player: ServerPlayer, msg: import('@mc/shared').AttackMsg): void;
  buy(player: ServerPlayer, msg: import('@mc/shared').BuyMsg): void;
  useHeld(player: ServerPlayer): void;
  /** Block Party: use a held mystery-box item slot (party.ts validates). */
  useItem(player: ServerPlayer, slot: number): void;
  /** Block Party: the round faller's one spectate Color Zapper shot. */
  zapCell(player: ServerPlayer, msg: ZapCellMsg): void;
  /** Handles an edit during a match; false → caller applies the sandbox path. */
  edit(player: ServerPlayer, msg: import('@mc/shared').BlockEditMsg): boolean;
  /** Called after every accepted move (void-kill detection). */
  onMoved(player: ServerPlayer): void;
  /** Called after the player was removed from the roster. */
  onPlayerLeft(player: ServerPlayer): void;
  /** modeChanged payload for a (re)joining player, or null while sandbox. */
  modeChangedFor(playerId: number): ModeChangedMsg | null;
  /** What the test bot's brain needs to know about the current mode (bot.ts). */
  botInfo(playerId: number): BotInfo;
  tick(now: number): void;
}

export function createModeManager(deps: MatchDeps): ModeManager {
  let mode: GameMode = 'sandbox';
  let match: Match | null = null;
  let party: PartyMatch | null = null;
  let lastTickAt = 0;

  const partyDeps: PartyDeps = {
    players: deps.players,
    sendTo: deps.sendTo,
    broadcast: deps.broadcast,
    log: deps.log,
  };

  const sendError = (player: ServerPlayer, message: string): void => {
    deps.sendTo(player.socket, { type: 'gameEvent', kind: 'error', message });
  };

  function buildModeChanged(yourTeam: number): ModeChangedMsg {
    if (mode === 'bedwars' && match) {
      return bedwarsModeChanged(match, yourTeam);
    }
    if (mode === 'party' && party) {
      // yourTeam doubles as the spawn slot (0/1); −1 spectates from the platform.
      return partyModeChanged(party, yourTeam);
    }
    return {
      type: 'modeChanged',
      mode: 'sandbox',
      seed: deps.sandboxSeed,
      edits: deps.sandboxWorld.serializeEdits(),
      spawns: [],
      beds: [],
      yourTeam: -1,
    };
  }

  function startMatch(): void {
    const roster = pickRoster(deps.players, '[bedwars] startMatch with no players — ignored', deps.log);
    if (!roster) return;
    match = startBedwarsMatch(deps, roster);
    const m = match;
    mode = 'bedwars';
    announceMode(deps.sendTo, deps.players, (entry) => buildModeChanged(m.players.get(entry.id)?.team ?? -1));
  }

  /** Party gate is identical to BedWars's; participants get spawn slots 0/1. */
  function startParty(): void {
    const roster = pickRoster(deps.players, '[party] startParty with no players — ignored', deps.log);
    if (!roster) return;
    party = startPartyMatch(partyDeps, roster);
    const p = party;
    mode = 'party';
    announceMode(deps.sendTo, deps.players, (entry) =>
      buildModeChanged(p.players.has(entry.id) ? [...p.players.keys()].indexOf(entry.id) : -1),
    );
  }

  function endToSandbox(): void {
    const from = mode;
    mode = 'sandbox';
    match = null;
    party = null;
    announceMode(deps.sendTo, deps.players, () => buildModeChanged(-1));
    deps.log(`[${from}] everyone returned to the sandbox`);
  }

  return {
    get mode() {
      return mode;
    },
    get phase() {
      return party?.phase ?? match?.phase ?? null;
    },

    startGame(player, wanted) {
      if (mode !== 'sandbox') {
        const running = mode === 'party' ? 'Block Party' : 'BedWars';
        sendError(player, `A ${running} match is already running`);
        return;
      }
      if (deps.players.size < 1) {
        sendError(player, 'Nobody online to play with');
        return;
      }
      if (wanted === 'party') startParty();
      else startMatch();
    },

    ready(player) {
      if (mode === 'party') {
        if (!party) return;
        if (recordReady(party, player)) {
          deps.log('[party] both players ready — rematch!');
          startParty();
        }
        return;
      }
      const m = match;
      if (!m) return;
      if (recordReady(m, player)) {
        deps.log('[bedwars] both players ready — rematch!');
        startMatch();
      }
    },

    leaveGame() {
      if (mode !== 'bedwars' && mode !== 'party') return;
      endToSandbox();
    },

    attack(player, msg) {
      const m = match;
      if (mode !== 'bedwars' || !m) return;
      bedwarsAttack(deps, m, player, msg);
    },

    buy(player, msg) {
      const m = match;
      if (mode !== 'bedwars' || !m) return;
      bedwarsBuy(deps, m, player, msg);
    },

    useHeld(player) {
      const m = match;
      if (mode !== 'bedwars' || !m) return;
      bedwarsUseHeld(deps, m, player);
    },

    useItem(player, slot) {
      if (mode !== 'party' || !party) return;
      partyUseItem(partyDeps, party, player, slot);
    },

    zapCell(player, msg) {
      if (mode !== 'party' || !party) return;
      partyZapCell(partyDeps, party, player, msg);
    },

    edit(player, msg) {
      if (mode === 'party') {
        // The dance floor is fully server-owned: reject everything.
        return party ? partyEdit(partyDeps, party, player, msg) : true;
      }
      const m = match;
      if (!m) return false;
      return bedwarsEdit(deps, m, player, msg);
    },

    onMoved(player) {
      if (mode === 'party') {
        if (party) partyOnMoved(partyDeps, party, player);
        return;
      }
      const m = match;
      if (!m) return;
      bedwarsOnMoved(deps, m, player);
    },

    onPlayerLeft(player) {
      if (mode === 'party') {
        if (!party) return;
        partyOnPlayerLeft(partyDeps, party, player); // may endMatch by dropout
        if (everyoneLeft(deps.players)) {
          mode = 'sandbox';
          party = null;
        }
        return;
      }
      const m = match;
      if (!m) return;
      bedwarsOnPlayerLeft(deps, m, player); // may endMatch by win-by-default
      if (everyoneLeft(deps.players) && mode === 'bedwars') {
        mode = 'sandbox';
        match = null;
      }
    },

    modeChangedFor(playerId) {
      if (mode === 'party' && party) {
        const slot = [...party.players.keys()].indexOf(playerId);
        return buildModeChanged(slot);
      }
      if (mode !== 'bedwars' || !match) return null;
      return buildModeChanged(match.players.get(playerId)?.team ?? -1);
    },

    botInfo(playerId) {
      if (mode === 'party' && party) {
        const slot = [...party.players.keys()].indexOf(playerId);
        const pp = party.players.get(playerId);
        return {
          mode: 'party',
          world: party.world,
          phase: party.phase,
          team: slot === 0 || slot === 1 ? slot : null,
          enemyId: null,
          round: party.round,
          colorId: party.colorId,
          selfAlive: pp ? pp.alive : false,
          spectator: { ...PARTY.spectatorSpawn },
        };
      }
      if (mode === 'bedwars' && match) {
        const mp = match.players.get(playerId);
        const enemy = mp ? [...match.players.values()].find((p) => p.team !== mp.team) : undefined;
        return {
          mode: 'bedwars',
          world: match.world,
          phase: match.phase,
          team: mp?.team ?? null,
          enemyId: enemy?.id ?? null,
          round: 0,
          colorId: 0,
          selfAlive: mp ? mp.alive : false,
          spectator: { ...ARENA.spectatorSpawn },
        };
      }
      return {
        mode: 'sandbox',
        world: deps.sandboxWorld,
        phase: null,
        team: null,
        enemyId: null,
        round: 0,
        colorId: 0,
        selfAlive: true,
        spectator: null,
      };
    },

    tick(now) {
      const dt = lastTickAt === 0 ? 0 : Math.min((now - lastTickAt) / 1000, 1);
      lastTickAt = now;

      if (mode === 'party') {
        if (!party) return;
        partyTick(partyDeps, party, now);
        deps.broadcast(partyGameState(party, now)); // 5 Hz snapshot
        return;
      }

      const m = match;
      if (!m) return;
      bedwarsTick(deps, m, now, dt);
    },
  };
}
