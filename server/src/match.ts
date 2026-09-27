/**
 * M4/M5 mode manager (DESIGN.md §3.3 + §3.4) — 'sandbox' ⇄ BedWars Duels
 * 1v1 ⇄ Block Party 1v1.
 *
 * The sandbox path stays exactly as it was: its World + persistent edit
 * overlay are untouched. `startGame` (exactly 2 players online) builds a fresh
 * match world from the shared deterministic generators with its own in-memory
 * overlay (never persisted), assigns slots and swaps every client over with
 * `modeChanged`. While a match runs the manager owns, server-authoritatively:
 *
 * BedWars (match.ts, this file):
 * - edits against the match world (beds: only the ENEMY team may break them;
 *   placing: only shop blocks the buyer owns, consuming stock),
 * - generators, combat validation, hp/regen/death, respawns, elimination +
 *   matchEnd, the 10 s countdown and 10:00 timer with sudden-death bed-break,
 * - the shop (proximity + currency validation) and golden-apple heals,
 * - rematch (`ready` from both), leaveGame → back to sandbox, and disconnects
 *   (the remaining player wins by default).
 *
 * Block Party (party.ts): the round loop (intermission → announce → drop →
 * score), floor re-randomization batches, void-kill fall detection, scoring
 * and first-to-3. All client edits are rejected — the floor is server-owned.
 *
 * State is broadcast as a 5 Hz `gameState` snapshot (party snapshots carry the
 * extra `party` payload); notable moments travel as tagged `gameEvent` frames.
 * The tick runs at 200 ms.
 */
import {
  AIR,
  ARENA,
  ARENA_SEED,
  BED_BLUE,
  BED_RED,
  BLOCKS,
  PLANKS,
  SHOP_ITEMS,
  VOID_KILL_Y,
  WATER,
  WORLD_SIZE_X,
  WORLD_SIZE_Y,
  WORLD_SIZE_Z,
  WOOL_WHITE,
  generateBedwarsArena,
  heldDamage,
  type ArenaSpawn,
  type AttackMsg,
  type BlockEditMsg,
  type BuyMsg,
  type GameEventMsg,
  type GameMode,
  type GameStateMsg,
  type MatchPhase,
  type ModeChangedMsg,
  type PartyPhase,
  type ServerMessage,
  type ShopItemId,
  type SwordTier,
  type World,
} from '@mc/shared';
import type { WebSocket } from 'ws';
import {
  partyEdit,
  partyGameState,
  partyModeChanged,
  partyOnMoved,
  partyOnPlayerLeft,
  partyReady,
  partyTick,
  startPartyMatch,
  type PartyDeps,
  type PartyMatch,
} from './party';

export interface ServerPlayer {
  id: number;
  name: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  socket: WebSocket;
  lastSeen: number;
}

const COUNTDOWN_MS = 10_000;
const MATCH_MS = 10 * 60_000;
const RESPAWN_MS = 5_000;
const ATTACK_COOLDOWN_MS = 500;
const ATTACK_RANGE = 4.5;
const REGEN_DELAY_MS = 5_000;
const REGEN_INTERVAL_MS = 2_500;
const IRON_INTERVAL_S = 1.5;
const GOLD_INTERVAL_S = 4;
const EMERALD_INTERVAL_S = 6;
const MAX_HP = 20;
const HEAL_AMOUNT = 8;
const MAX_APPLES = 9;
const MAX_STACK = 64;
const KNOCKBACK_BASE = 4;

interface MatchPlayer {
  id: number;
  name: string;
  team: 0 | 1;
  hp: number;
  alive: boolean;
  /** Epoch ms of the scheduled respawn; 0 = not respawning. */
  respawnAt: number;
  lastDamageAt: number;
  lastAttackAt: number;
  lastRegenAt: number;
  currency: { iron: number; gold: number; emerald: number };
  wool: number;
  planks: number;
  apples: number;
  sword: SwordTier | null;
  kills: number;
  deaths: number;
}

interface Match {
  world: World;
  players: Map<number, MatchPlayer>;
  bedsAlive: [boolean, boolean];
  phase: 'countdown' | 'playing' | 'ended';
  phaseEndsAt: number;
  ready: Set<number>;
  lastCountdownSent: number;
  ironAcc: number;
  goldAcc: number;
  emeraldAcc: number;
}

export interface MatchDeps {
  /** The persistent sandbox world (read for the sandbox modeChanged overlay). */
  sandboxWorld: World;
  sandboxSeed: number;
  /** Live roster (all connected, joined players). */
  players: Map<number, ServerPlayer>;
  /** Server-side reach limit for edits (same as the sandbox path). */
  reach: number;
  sendTo(socket: WebSocket, msg: ServerMessage): void;
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
  attack(player: ServerPlayer, msg: AttackMsg): void;
  buy(player: ServerPlayer, msg: BuyMsg): void;
  useHeld(player: ServerPlayer): void;
  /** Handles an edit during a match; false → caller applies the sandbox path. */
  edit(player: ServerPlayer, msg: BlockEditMsg): boolean;
  /** Called after every accepted move (void-kill detection). */
  onMoved(player: ServerPlayer): void;
  /** Called after the player was removed from the roster. */
  onPlayerLeft(player: ServerPlayer): void;
  /** modeChanged payload for a (re)joining player, or null while sandbox. */
  modeChangedFor(playerId: number): ModeChangedMsg | null;
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

  const broadcastEvent = (event: GameEventMsg): void => deps.broadcast(event);

  const sendError = (player: ServerPlayer, message: string): void => {
    deps.sendTo(player.socket, { type: 'gameEvent', kind: 'error', message });
  };

  function buildModeChanged(yourTeam: number): ModeChangedMsg {
    if (mode === 'bedwars' && match) {
      return {
        type: 'modeChanged',
        mode: 'bedwars',
        seed: ARENA_SEED,
        edits: match.world.serializeEdits(),
        spawns: ARENA.spawns.map((spawn: ArenaSpawn) => ({ ...spawn })),
        beds: ARENA.beds.map((bed) => ({ ...bed })),
        yourTeam,
      };
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

  function buildGameState(now: number): GameStateMsg {
    const m = match!;
    const timeLeft =
      m.phase === 'ended'
        ? 0
        : Math.max(0, Math.round((m.phaseEndsAt - now) / 1000));
    return {
      type: 'gameState',
      phase: m.phase,
      timeLeft,
      bedsAlive: [m.bedsAlive[0], m.bedsAlive[1]],
      players: [...m.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        team: p.team,
        hp: p.hp,
        alive: p.alive,
        respawnIn: !p.alive && p.respawnAt > 0 ? Math.max(0, Math.ceil((p.respawnAt - now) / 1000)) : 0,
        kills: p.kills,
        currency: { ...p.currency },
        inventory: { wool: p.wool, planks: p.planks, apples: p.apples, sword: p.sword },
      })),
    };
  }

  function startMatch(): void {
    const roster = [...deps.players.values()].sort((a, b) => a.id - b.id).slice(0, 2);
    if (roster.length < 1) {
      deps.log('[bedwars] startMatch with no players — ignored');
      return;
    }
    const m: Match = {
      world: generateBedwarsArena(ARENA_SEED),
      players: new Map(),
      bedsAlive: [true, true],
      phase: 'countdown',
      phaseEndsAt: Date.now() + COUNTDOWN_MS,
      ready: new Set(),
      lastCountdownSent: -1,
      ironAcc: 0,
      goldAcc: 0,
      emeraldAcc: 0,
    };
    roster.forEach((entry, index) => {
      const team: 0 | 1 = index === 0 ? 0 : 1;
      const spawn = ARENA.spawns[team];
      entry.x = spawn.x;
      entry.y = spawn.y;
      entry.z = spawn.z;
      entry.yaw = spawn.yaw;
      m.players.set(entry.id, {
        id: entry.id,
        name: entry.name,
        team,
        hp: MAX_HP,
        alive: true,
        respawnAt: 0,
        lastDamageAt: 0,
        lastAttackAt: 0,
        lastRegenAt: 0,
        currency: { iron: 0, gold: 0, emerald: 0 },
        wool: 0,
        planks: 0,
        apples: 0,
        sword: null,
        kills: 0,
        deaths: 0,
      });
    });
    match = m;
    mode = 'bedwars';
    for (const entry of deps.players.values()) {
      const team = m.players.get(entry.id)?.team ?? -1;
      deps.sendTo(entry.socket, buildModeChanged(team));
    }
    deps.log(
      `[bedwars] match started — ${roster[0].name} (red)` +
        (roster[1] ? ` vs ${roster[1].name} (blue)` : ' — solo practice'),
    );
  }

  /** Party gate is identical to BedWars's; participants get spawn slots 0/1. */
  function startParty(): void {
    const roster = [...deps.players.values()].sort((a, b) => a.id - b.id).slice(0, 2);
    if (roster.length < 1) {
      deps.log('[party] startParty with no players — ignored');
      return;
    }
    party = startPartyMatch(partyDeps, roster);
    mode = 'party';
    for (const entry of deps.players.values()) {
      const slot = party.players.has(entry.id)
        ? [...party.players.keys()].indexOf(entry.id)
        : -1;
      deps.sendTo(entry.socket, buildModeChanged(slot));
    }
  }

  function endMatch(winner: MatchPlayer): void {
    const m = match;
    if (!m || m.phase === 'ended') return;
    m.phase = 'ended';
    broadcastEvent({
      type: 'gameEvent',
      kind: 'matchEnd',
      winnerId: winner.id,
      winnerName: winner.name,
      stats: [...m.players.values()].map((p) => ({ id: p.id, name: p.name, kills: p.kills, deaths: p.deaths })),
    });
    deps.log(`[bedwars] match ended — ${winner.name} wins`);
  }

  function endToSandbox(): void {
    const from = mode;
    mode = 'sandbox';
    match = null;
    party = null;
    for (const entry of deps.players.values()) {
      deps.sendTo(entry.socket, buildModeChanged(-1));
    }
    deps.log(`[${from}] everyone returned to the sandbox`);
  }

  function kill(victim: MatchPlayer, cause: 'combat' | 'void', killerId: number | null, now: number): void {
    const m = match;
    if (!m || !victim.alive) return;
    victim.alive = false;
    victim.hp = 0;
    victim.deaths++;
    const killer = killerId !== null ? m.players.get(killerId) : undefined;
    if (killer && killer.id !== victim.id) killer.kills++;
    const bedAlive = m.bedsAlive[victim.team];
    victim.respawnAt = bedAlive ? now + RESPAWN_MS : 0;
    broadcastEvent({
      type: 'gameEvent',
      kind: 'death',
      playerId: victim.id,
      cause,
      killerId,
      respawnIn: bedAlive ? RESPAWN_MS / 1000 : 0,
    });
    deps.log(`[bedwars] ${victim.name} died (${cause})${bedAlive ? ' — respawning' : ' — eliminated'}`);
    if (!bedAlive) {
      const winner = [...m.players.values()].find((p) => p.team !== victim.team);
      if (winner) endMatch(winner);
    }
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
        if (partyReady(party, player)) {
          deps.log('[party] both players ready — rematch!');
          startParty();
        }
        return;
      }
      const m = match;
      if (!m || m.phase !== 'ended' || !m.players.has(player.id)) return;
      m.ready.add(player.id);
      if (m.ready.size >= Math.min(2, m.players.size)) {
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
      if (mode !== 'bedwars' || !m || m.phase !== 'playing') return;
      const attacker = m.players.get(player.id);
      const target = m.players.get(msg.id);
      if (!attacker || !target || attacker.id === target.id) return;
      if (!attacker.alive || !target.alive) return;
      const targetRoster = deps.players.get(msg.id);
      if (!targetRoster) return;
      const now = Date.now();
      if (now - attacker.lastAttackAt < ATTACK_COOLDOWN_MS) return;
      const dist = Math.hypot(targetRoster.x - player.x, targetRoster.y - player.y, targetRoster.z - player.z);
      if (dist > ATTACK_RANGE) {
        deps.log(`[bedwars] attack from ${player.name} rejected: out of range (${dist.toFixed(1)})`);
        return;
      }
      attacker.lastAttackAt = now;
      const damage = heldDamage(msg.held, attacker.sword);
      target.hp -= damage;
      target.lastDamageAt = now;
      target.lastRegenAt = now;

      // Knockback: mostly along attacker→target with an upward pop.
      let dx = targetRoster.x - player.x;
      let dz = targetRoster.z - player.z;
      const len = Math.hypot(dx, dz) || 1;
      dx /= len;
      dz /= len;
      broadcastEvent({
        type: 'gameEvent',
        kind: 'knockback',
        playerId: target.id,
        dir: { x: dx, y: 0.45, z: dz },
        power: KNOCKBACK_BASE + damage * 0.5,
      });
      deps.log(`[bedwars] ${player.name} hit ${target.name} for ${damage} (hp ${Math.max(0, target.hp)})`);
      if (target.hp <= 0) kill(target, 'combat', attacker.id, now);
    },

    buy(player, msg) {
      const m = match;
      if (mode !== 'bedwars' || !m || m.phase === 'ended') return;
      const mp = m.players.get(player.id);
      if (!mp || !mp.alive) return;
      const item = SHOP_ITEMS.find((entry) => entry.id === msg.item);
      if (!item) return;
      const roster = deps.players.get(player.id);
      if (!roster) return;
      const shop = ARENA.shopPoints[mp.team];
      const dist = Math.hypot(roster.x - shop.x, roster.y - shop.y, roster.z - shop.z);
      if (dist > ARENA.shopRadius) {
        sendError(player, 'Too far from the shop');
        return;
      }
      if (mp.currency[item.currency] < item.price) {
        sendError(player, `Not enough ${item.currency} — ${item.name} costs ${item.price}`);
        return;
      }
      mp.currency[item.currency] -= item.price;
      switch (item.id) {
        case 'wool':
          mp.wool = Math.min(MAX_STACK, mp.wool + 16);
          break;
        case 'planks':
          mp.planks = Math.min(MAX_STACK, mp.planks + 16);
          break;
        case 'wooden_sword':
          mp.sword = 'wooden';
          break;
        case 'stone_sword':
          mp.sword = 'stone';
          break;
        case 'iron_sword':
          mp.sword = 'iron';
          break;
        case 'golden_apple':
          mp.apples = Math.min(MAX_APPLES, mp.apples + 1);
          break;
      }
      broadcastEvent({ type: 'gameEvent', kind: 'purchase', playerId: mp.id, item: item.id satisfies ShopItemId });
      deps.log(`[bedwars] ${player.name} bought ${item.name} (${item.price} ${item.currency})`);
    },

    useHeld(player) {
      const m = match;
      if (mode !== 'bedwars' || !m || m.phase === 'ended') return;
      const mp = m.players.get(player.id);
      if (!mp || !mp.alive) return;
      if (mp.apples <= 0) return;
      if (mp.hp >= MAX_HP) {
        sendError(player, 'Already at full health');
        return;
      }
      mp.apples--;
      mp.hp = Math.min(MAX_HP, mp.hp + HEAL_AMOUNT);
      broadcastEvent({ type: 'gameEvent', kind: 'heal', playerId: mp.id, amount: HEAL_AMOUNT });
    },

    edit(player, msg) {
      if (mode === 'party') {
        // The dance floor is fully server-owned: reject everything.
        return party ? partyEdit(partyDeps, party, player, msg) : true;
      }
      const m = match;
      if (!m) return false;
      const mp = m.players.get(player.id);
      if (!mp) return true; // spectator edits are dropped silently
      const { x, y, z, id } = msg;
      const reject = (why: string): void => {
        deps.sendTo(player.socket, {
          type: 'blockEdits',
          edits: [[x, y, z, m.world.getBlock(x, y, z)]],
        });
        deps.log(`[bedwars] edit from ${player.name} rejected: ${why}`);
      };

      if (
        x < 0 || y < 0 || z < 0 ||
        x >= WORLD_SIZE_X || y >= WORLD_SIZE_Y || z >= WORLD_SIZE_Z
      ) {
        reject('out of bounds');
        return true;
      }
      if (id < 0 || id >= BLOCKS.length) {
        reject(`invalid block id ${id}`);
        return true;
      }
      const dist = Math.hypot(x + 0.5 - player.x, y + 0.5 - player.y, z + 0.5 - player.z);
      if (dist > deps.reach) {
        reject(`out of reach (${dist.toFixed(1)} > ${deps.reach})`);
        return true;
      }

      const target = m.world.getBlock(x, y, z);
      if (id === AIR) {
        // Breaking.
        if (target === BED_RED || target === BED_BLUE) {
          const bedTeam = target === BED_RED ? 0 : 1;
          if (bedTeam === mp.team) {
            reject('you cannot break your own bed');
            return true;
          }
          m.world.setBlock(x, y, z, AIR);
          m.bedsAlive[bedTeam] = false;
          deps.broadcast({ type: 'blockEdits', edits: [[x, y, z, AIR]] });
          broadcastEvent({ type: 'gameEvent', kind: 'bedBroken', team: bedTeam, by: player.name });
          deps.log(`[bedwars] ${player.name} broke the ${bedTeam === 0 ? 'red' : 'blue'} bed!`);
          return true;
        }
        if (target === AIR) {
          reject('empty cell');
          return true;
        }
        if (BLOCKS[target].unbreakable) {
          reject('unbreakable block');
          return true;
        }
        m.world.setBlock(x, y, z, AIR);
        deps.broadcast({ type: 'blockEdits', edits: [[x, y, z, AIR]] });
        return true;
      }

      // Placing: only shop blocks, only with stock (consumes it).
      if (id !== WOOL_WHITE && id !== PLANKS) {
        reject('only shop blocks are placeable in BedWars');
        return true;
      }
      if (target !== AIR && target !== WATER) {
        reject(`cell occupied by ${BLOCKS[target].name}`);
        return true;
      }
      if (id === WOOL_WHITE) {
        if (mp.wool <= 0) {
          reject('no wool left — buy more at the shop');
          return true;
        }
        mp.wool--;
      } else {
        if (mp.planks <= 0) {
          reject('no planks left — buy more at the shop');
          return true;
        }
        mp.planks--;
      }
      m.world.setBlock(x, y, z, id);
      deps.broadcast({ type: 'blockEdits', edits: [[x, y, z, id]] });
      return true;
    },

    onMoved(player) {
      if (mode === 'party') {
        if (party) partyOnMoved(partyDeps, party, player);
        return;
      }
      const m = match;
      if (!m || m.phase !== 'playing') return;
      const mp = m.players.get(player.id);
      if (!mp || !mp.alive) return;
      if (player.y < VOID_KILL_Y) kill(mp, 'void', null, Date.now());
    },

    onPlayerLeft(player) {
      if (mode === 'party') {
        if (!party) return;
        partyOnPlayerLeft(partyDeps, party, player); // may endMatch by dropout
        if (deps.players.size === 0) {
          mode = 'sandbox';
          party = null;
        }
        return;
      }
      const m = match;
      if (!m) return;
      const mp = m.players.get(player.id);
      if (!mp) {
        if (deps.players.size === 0 && mode === 'bedwars') {
          mode = 'sandbox';
          match = null;
        }
        return;
      }
      m.players.delete(player.id);
      m.ready.delete(player.id);
      deps.log(`[bedwars] ${player.name} left mid-match`);
      if (m.phase !== 'ended') {
        const remaining = [...m.players.values()][0];
        if (remaining) endMatch(remaining); // win by default
      }
      if (deps.players.size === 0) {
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

      if (m.phase === 'countdown') {
        const seconds = Math.max(0, Math.ceil((m.phaseEndsAt - now) / 1000));
        if (seconds !== m.lastCountdownSent) {
          m.lastCountdownSent = seconds;
          broadcastEvent({ type: 'gameEvent', kind: 'countdown', seconds });
        }
        if (now >= m.phaseEndsAt) {
          m.phase = 'playing';
          m.phaseEndsAt = now + MATCH_MS;
          broadcastEvent({ type: 'gameEvent', kind: 'countdown', seconds: 0 });
          deps.log('[bedwars] FIGHT!');
        }
      } else if (m.phase === 'playing') {
        // Sudden death: at 0:00 both beds auto-break.
        if (now >= m.phaseEndsAt) {
          m.phaseEndsAt = now;
          for (const team of [0, 1] as const) {
            if (m.bedsAlive[team]) {
              m.bedsAlive[team] = false;
              broadcastEvent({ type: 'gameEvent', kind: 'bedBroken', team, by: 'sudden death' });
              deps.log(`[bedwars] sudden death — ${team === 0 ? 'red' : 'blue'} bed broke`);
            }
          }
        }

        // Island generators: iron 1/1.5 s, gold 1/4 s for every match player;
        // emerald 1/6 s to whoever stands at the mid generator.
        if (dt > 0) {
          m.ironAcc += dt;
          m.goldAcc += dt;
          m.emeraldAcc += dt;
          while (m.ironAcc >= IRON_INTERVAL_S) {
            m.ironAcc -= IRON_INTERVAL_S;
            for (const p of m.players.values()) p.currency.iron++;
          }
          while (m.goldAcc >= GOLD_INTERVAL_S) {
            m.goldAcc -= GOLD_INTERVAL_S;
            for (const p of m.players.values()) p.currency.gold++;
          }
          while (m.emeraldAcc >= EMERALD_INTERVAL_S) {
            m.emeraldAcc -= EMERALD_INTERVAL_S;
            for (const p of m.players.values()) {
              if (!p.alive) continue;
              const roster = deps.players.get(p.id);
              if (!roster) continue;
              const d = Math.hypot(
                roster.x - ARENA.midGenerator.x,
                roster.z - ARENA.midGenerator.z,
              );
              if (d <= ARENA.midGeneratorRadius && Math.abs(roster.y - ARENA.midGenerator.y) < 4) {
                p.currency.emerald++;
              }
            }
          }
        }

        // Regen + respawns.
        for (const p of m.players.values()) {
          if (p.alive) {
            if (
              p.hp < MAX_HP &&
              now - p.lastDamageAt >= REGEN_DELAY_MS &&
              now - p.lastRegenAt >= REGEN_INTERVAL_MS
            ) {
              p.hp++;
              p.lastRegenAt = now;
            }
          } else if (p.respawnAt > 0 && m.bedsAlive[p.team] && now >= p.respawnAt) {
            p.alive = true;
            p.hp = MAX_HP;
            p.respawnAt = 0;
            p.lastDamageAt = 0;
            p.lastRegenAt = now;
            const spawn = ARENA.spawns[p.team];
            const roster = deps.players.get(p.id);
            if (roster) {
              roster.x = spawn.x;
              roster.y = spawn.y;
              roster.z = spawn.z;
              roster.yaw = spawn.yaw;
            }
            broadcastEvent({ type: 'gameEvent', kind: 'respawn', playerId: p.id });
            deps.log(`[bedwars] ${p.name} respawned`);
          }
        }
      }

      // 5 Hz authoritative snapshot.
      deps.broadcast(buildGameState(now));
    },
  };
}
