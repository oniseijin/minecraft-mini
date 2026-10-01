/**
 * M4/M5/M7 mode manager (DESIGN.md §3.3 + §3.4 + §3.6) — 'sandbox' ⇄ BedWars
 * Duels 1v1 ⇄ Block Party 1v1 ⇄ Murder Mystery co-op. Since REFACTORING.md
 * 2b.1 this file is the MODE REGISTRY: it owns gameMode, the live match
 * references and the glue — roster picking, modeChanged fan-out, rematch
 * gates, the everyone-left reset, healthz/phase + botInfo surfaces.
 *
 * The rules live next door, as stateless (deps, state, …) functions:
 * - BedWars: bedwars.ts (edits/beds, generators, combat, shop, respawns,
 *   sudden death, results).
 * - Block Party: party.ts (the round loop, floor re-randomization, void-kill
 *   falls, scoring, first-to-3).
 * - Murder Mystery: murder.ts (the manor, guest/murderer brains, coins,
 *   zapper, gravestones, timer).
 *
 * The sandbox path stays exactly as it was: its World + persistent edit
 * overlay are untouched. State is broadcast as a 5 Hz `gameState` snapshot
 * (party/murder snapshots carry the extra `party`/`murder` payload); notable
 * moments travel as tagged `gameEvent` frames. The tick runs at 200 ms.
 */
import {
  ARENA,
  MANOR,
  PARTY,
  type GameMode,
  type InvestigateGravestoneMsg,
  type MatchPhase,
  type ModeChangedMsg,
  type MurderPhase,
  type PartyPhase,
  type ServerMessage,
  type World,
  type ZapCellMsg,
  type ZapGuestMsg,
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
  type PartyMatch,
} from './party';
import {
  bedwarsAttack,
  bedwarsBowShot,
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
import {
  murderEdit,
  murderGameState,
  murderModeChanged,
  murderOnMoved,
  murderOnPlayerLeft,
  murderTick,
  murderZapGuest,
  murderInvestigate,
  startMurderMatch,
  type MurderMatch,
} from './murder';
import { announceMode, everyoneLeft, pickRoster, recordReady, type ServerContext } from './matchLifecycle';

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

/** The registry's deps: the shared message plumbing + the sandbox world it hosts. */
export interface MatchDeps extends ServerContext {
  /** The persistent sandbox world (read for the sandbox modeChanged overlay). */
  sandboxWorld: World;
  sandboxSeed: number;
}

export interface ModeManager {
  readonly mode: GameMode;
  /** BedWars/party/murder phase when a match runs, null in sandbox (healthz/debug). */
  readonly phase: MatchPhase | PartyPhase | MurderPhase | null;
  /** Starts the requested game (exactly 2 players online, none running). */
  startGame(player: ServerPlayer, mode: 'bedwars' | 'party' | 'murder'): void;
  ready(player: ServerPlayer): void;
  leaveGame(player: ServerPlayer): void;
  attack(player: ServerPlayer, msg: import('@mc/shared').AttackMsg): void;
  /** BedWars: loose a charged arrow (bedwars.ts validates + simulates, v10). */
  bowShot(player: ServerPlayer, msg: import('@mc/shared').BowShotMsg): void;
  buy(player: ServerPlayer, msg: import('@mc/shared').BuyMsg): void;
  useHeld(player: ServerPlayer): void;
  /** Block Party: use a held mystery-box item slot (party.ts validates). */
  useItem(player: ServerPlayer, slot: number): void;
  /** Block Party: the round faller's one spectate Color Zapper shot. */
  zapCell(player: ServerPlayer, msg: ZapCellMsg): void;
  /** Murder Mystery: fire the detective zapper at a guest (murder.ts validates). */
  zapGuest(player: ServerPlayer, msg: ZapGuestMsg): void;
  /** Murder Mystery: read a gravestone (murder.ts validates). */
  investigateGravestone(player: ServerPlayer, msg: InvestigateGravestoneMsg): void;
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
  let murder: MurderMatch | null = null;
  let lastTickAt = 0;

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
    if (mode === 'murder' && murder) {
      // yourTeam doubles as the manor spawn slot (0/1); −1 spectates.
      return murderModeChanged(murder, yourTeam);
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
    party = startPartyMatch(deps, roster);
    const p = party;
    mode = 'party';
    announceMode(deps.sendTo, deps.players, (entry) =>
      buildModeChanged(p.players.has(entry.id) ? [...p.players.keys()].indexOf(entry.id) : -1),
    );
  }

  /** Murder gate is identical to the others (solo hunt is valid, §3.6); spawn slots 0/1. */
  function startMurder(): void {
    const roster = pickRoster(deps.players, '[murder] startMurder with no players — ignored', deps.log);
    if (!roster) return;
    murder = startMurderMatch(deps, roster);
    const m = murder;
    mode = 'murder';
    announceMode(deps.sendTo, deps.players, (entry) =>
      buildModeChanged(m.players.has(entry.id) ? [...m.players.keys()].indexOf(entry.id) : -1),
    );
  }

  function endToSandbox(): void {
    const from = mode;
    mode = 'sandbox';
    match = null;
    party = null;
    murder = null;
    announceMode(deps.sendTo, deps.players, () => buildModeChanged(-1));
    deps.log(`[${from}] everyone returned to the sandbox`);
  }

  return {
    get mode() {
      return mode;
    },
    get phase() {
      return murder?.phase ?? party?.phase ?? match?.phase ?? null;
    },

    startGame(player, wanted) {
      if (mode !== 'sandbox') {
        const running = mode === 'party' ? 'Block Party' : mode === 'murder' ? 'Murder Mystery' : 'BedWars';
        sendError(player, `A ${running} match is already running`);
        return;
      }
      if (deps.players.size < 1) {
        sendError(player, 'Nobody online to play with');
        return;
      }
      if (wanted === 'party') startParty();
      else if (wanted === 'murder') startMurder();
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
      if (mode === 'murder') {
        if (!murder) return;
        if (recordReady(murder, player)) {
          deps.log('[murder] both players ready — rematch!');
          startMurder();
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
      if (mode !== 'bedwars' && mode !== 'party' && mode !== 'murder') return;
      endToSandbox();
    },

    attack(player, msg) {
      const m = match;
      if (mode !== 'bedwars' || !m) return;
      bedwarsAttack(deps, m, player, msg);
    },

    bowShot(player, msg) {
      const m = match;
      if (mode !== 'bedwars' || !m) return;
      bedwarsBowShot(deps, m, player, msg);
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
      partyUseItem(deps, party, player, slot);
    },

    zapCell(player, msg) {
      if (mode !== 'party' || !party) return;
      partyZapCell(deps, party, player, msg);
    },

    zapGuest(player, msg) {
      if (mode !== 'murder' || !murder) return;
      murderZapGuest(deps, murder, player, msg);
    },

    investigateGravestone(player, msg) {
      if (mode !== 'murder' || !murder) return;
      murderInvestigate(deps, murder, player, msg);
    },

    edit(player, msg) {
      if (mode === 'party') {
        // The dance floor is fully server-owned: reject everything.
        return party ? partyEdit(deps, party, player, msg) : true;
      }
      if (mode === 'murder') {
        // The manor is fully server-owned: reject everything.
        return murder ? murderEdit(deps, murder, player, msg) : true;
      }
      const m = match;
      if (!m) return false;
      return bedwarsEdit(deps, m, player, msg);
    },

    onMoved(player) {
      if (mode === 'party') {
        if (party) partyOnMoved(deps, party, player);
        return;
      }
      if (mode === 'murder') {
        if (murder) murderOnMoved(deps, murder, player);
        return;
      }
      const m = match;
      if (!m) return;
      bedwarsOnMoved(deps, m, player);
    },

    onPlayerLeft(player) {
      if (mode === 'party') {
        if (!party) return;
        partyOnPlayerLeft(deps, party, player); // may endMatch by dropout
        if (everyoneLeft(deps.players)) {
          mode = 'sandbox';
          party = null;
        }
        return;
      }
      if (mode === 'murder') {
        if (!murder) return;
        murderOnPlayerLeft(deps, murder, player); // may endMatch by dropout
        if (everyoneLeft(deps.players)) {
          mode = 'sandbox';
          murder = null;
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
      if (mode === 'murder' && murder) {
        const slot = [...murder.players.keys()].indexOf(playerId);
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
      if (mode === 'murder' && murder) {
        const slot = [...murder.players.keys()].indexOf(playerId);
        const pp = murder.players.get(playerId);
        // Feeds the M7.4 fellow-Detective brain in bot.ts (§3.6: the bot
        // wanders + collects coins but never zaps); this arm only supplies
        // the manor world, the phase, and the bot's slot/alive flag.
        return {
          mode: 'murder',
          world: murder.world,
          phase: murder.phase,
          team: slot === 0 || slot === 1 ? slot : null,
          enemyId: null,
          round: 0,
          colorId: 0,
          selfAlive: pp ? pp.alive : false,
          spectator: { ...MANOR.spectatorSpot },
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
        partyTick(deps, party, now);
        deps.broadcast(partyGameState(party, now)); // 5 Hz snapshot
        return;
      }

      if (mode === 'murder') {
        if (!murder) return;
        murderTick(deps, murder, now, dt);
        deps.broadcast(murderGameState(murder, now)); // 5 Hz snapshot
        return;
      }

      const m = match;
      if (!m) return;
      bedwarsTick(deps, m, now, dt);
    },
  };
}
