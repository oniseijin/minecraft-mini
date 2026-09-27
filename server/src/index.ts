/**
 * minecraft-mini server entry (M3 + M4) — one HTTP server on :8080 serving
 * `GET /healthz`, the built client (`client/dist`) and a `ws` endpoint at
 * `/ws`. Run with `npm start` (or `npm run lan` — same thing, both print the
 * LAN join URLs; `npm run dev` adds tsx watch).
 *
 * The server is authoritative for block edits and relays movement: worldgen
 * is deterministic and shared, so only a persistent edit overlay (DESIGN §3.1)
 * is ever synced — joining clients get {seed, edits} and generate locally.
 * Movement is trusted + relayed as a 20 Hz roster snapshot (only when it
 * changed); edits are validated (bounds, id, occupancy, unbreakable, reach)
 * and broadcast to everyone including the editor; rejected edits echo the
 * true cell value back to the sender as an implicit correction.
 *
 * M4 delegates the BedWars 1v1 mode to the mode manager (match.ts): the
 * sandbox world + its persisted overlay stay untouched, matches run in a
 * separate in-memory arena world. All match authority (hp, currency, beds,
 * attacks, buys, timers) lives there.
 *
 * Protocol v4 adds the server-driven test bot (bot.ts): `addBot`/`removeBot`
 * spawn/remove ONE roster-flagged dummy player so a solo human can play real
 * 1v1 matches. It has no socket — its brain runs on a timer and goes through
 * the same move/attack validation paths as humans.
 *
 * The edit overlay persists to `server/data/world-edits.json` (overridable
 * with MC_EDITS_FILE for tests): written every 5 s when dirty and on
 * SIGINT/SIGTERM, loaded and validated on boot.
 */
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import {
  AIR,
  BLOCKS,
  WATER,
  WORLD_SIZE_X,
  WORLD_SIZE_Y,
  WORLD_SIZE_Z,
  generateWorld,
  parseClientMessage,
  type BlockEditMsg,
  type EditTuple,
  type MoveMsg,
  type PlayerSnapshot,
  type ServerMessage,
} from '@mc/shared';
import { createModeManager, type ServerPlayer } from './match';
import { BOT_ID, BOT_NAME, createBot, type Bot } from './bot';

const here = path.dirname(fileURLToPath(import.meta.url));
const SEED = 1337;
const CLIENT_DIST = path.resolve(here, '../../client/dist');
const EDITS_FILE = process.env.MC_EDITS_FILE ?? path.resolve(here, '../data/world-edits.json');

const requestedPort = Number(process.env.PORT ?? 8080);
const PORT = Number.isFinite(requestedPort) && requestedPort > 0 ? requestedPort : 8080;

const SPAWN_X = 128;
const SPAWN_Z = 128;

const SNAPSHOT_MS = 50; // 20 Hz roster relay
const MATCH_TICK_MS = 200; // BedWars match tick + 5 Hz gameState
const SAVE_INTERVAL_MS = 5000;
const HEARTBEAT_MS = 10000;
const IDLE_TIMEOUT_MS = 30000; // terminate connections silent for this long
/** Server-side reach limit for edits (a bit looser than the client's 5). */
const REACH = 8;
/** Movement clamp: world bounds ± this slack. */
const BOUND_SLACK = 64;

const MAX_NAME_LEN = 16;
const MAX_CHAT_LEN = 200;

interface SaveFile {
  version: number;
  seed: number;
  savedAt: number;
  edits: EditTuple[];
}

// --- state ------------------------------------------------------------------

const world = generateWorld(SEED);
const SPAWN = { x: SPAWN_X + 0.5, y: world.highestBlock(SPAWN_X, SPAWN_Z) + 1, z: SPAWN_Z + 0.5 };

const players = new Map<number, ServerPlayer>();
/** Every live socket (joined or not) — heartbeat + idle timeout bookkeeping. */
const connections = new Map<WebSocket, { lastActivity: number }>();

/** The one server-driven test bot, or null (protocol v4 addBot/removeBot). */
let bot: Bot | null = null;

let nextId = 1;
let editsDirty = false;
let rosterDirty = false;

// --- persistence ------------------------------------------------------------

function loadEdits(): void {
  if (!existsSync(EDITS_FILE)) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(EDITS_FILE, 'utf8'));
  } catch (error) {
    console.warn(`[server] ignoring corrupt edits file: ${String(error)}`);
    return;
  }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as SaveFile).edits)) {
    console.warn('[server] ignoring edits file with unexpected shape');
    return;
  }
  const entries: unknown[] = (parsed as SaveFile).edits;
  const valid: EditTuple[] = [];
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 4) continue;
    if (!entry.every((v) => typeof v === 'number' && Number.isInteger(v))) continue;
    const [x, y, z, id] = entry as number[];
    if (
      x < 0 || y < 0 || z < 0 ||
      x >= WORLD_SIZE_X || y >= WORLD_SIZE_Y || z >= WORLD_SIZE_Z ||
      id < 0 || id >= BLOCKS.length
    ) {
      continue;
    }
    valid.push([x, y, z, id] as EditTuple);
  }
  world.applyEdits(valid);
  console.log(`[server] loaded ${valid.length}/${entries.length} edits from ${EDITS_FILE}`);
}

function saveEdits(force = false): void {
  if (!editsDirty && !force) return;
  const payload: SaveFile = {
    version: 1,
    seed: SEED,
    savedAt: Date.now(),
    edits: world.serializeEdits(),
  };
  try {
    mkdirSync(path.dirname(EDITS_FILE), { recursive: true });
    const tmp = `${EDITS_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload));
    renameSync(tmp, EDITS_FILE);
    editsDirty = false;
    console.log(`[server] saved ${payload.edits.length} edits → ${EDITS_FILE}`);
  } catch (error) {
    console.error(`[server] failed to save edits: ${String(error)}`);
  }
}

// --- sanitize helpers -------------------------------------------------------

function sanitizeName(raw: string): string {
  const cleaned = raw.replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, MAX_NAME_LEN);
  return cleaned.length > 0 ? cleaned : 'Player';
}

/** Dedupes against active players: "Ryan", then "Ryan (2)", "Ryan (3)", … */
function uniqueName(base: string): string {
  const taken = new Set([...players.values()].map((player) => player.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Strips ASCII control chars (U+0000-U+001F, U+007F) so chat stays single-line. */
function sanitizeChat(raw: string): string {
  return raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_CHAT_LEN);
}

// --- messaging --------------------------------------------------------------

function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

function sendTo(socket: WebSocket | null, msg: ServerMessage): void {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

function broadcast(msg: ServerMessage): void {
  for (const player of players.values()) sendTo(player.socket, msg);
}

function snapshotList(): PlayerSnapshot[] {
  return [...players.values()].map((player) => ({
    id: player.id,
    name: player.name,
    x: player.x,
    y: player.y,
    z: player.z,
    yaw: player.yaw,
    pitch: player.pitch,
    ...(player.bot ? { bot: true } : {}),
  }));
}

// --- BedWars mode manager (match.ts) -----------------------------------------

const modeManager = createModeManager({
  sandboxWorld: world,
  sandboxSeed: SEED,
  players,
  reach: REACH,
  sendTo,
  broadcast,
  log: (line) => console.log(line),
});

// --- join / move / edits / chat ----------------------------------------------

function joinPlayer(socket: WebSocket, rawName: string): ServerPlayer {
  const id = nextId++;
  const name = uniqueName(sanitizeName(rawName));
  const player: ServerPlayer = {
    id,
    name,
    x: SPAWN.x,
    y: SPAWN.y,
    z: SPAWN.z,
    yaw: 0,
    pitch: 0,
    socket,
    lastSeen: Date.now(),
  };
  players.set(id, player);
  rosterDirty = true;
  sendTo(socket, {
    type: 'welcome',
    playerId: id,
    name,
    seed: SEED,
    edits: world.serializeEdits(),
    players: snapshotList().filter((entry) => entry.id !== id),
  });
  console.log(
    `[server] ${name} (#${id}) joined — ${players.size} online, ` +
      `${world.edits.size} overlay edits`,
  );
  return player;
}

function applyMove(player: ServerPlayer, msg: MoveMsg): void {
  const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
  player.x = clamp(msg.x, -BOUND_SLACK, WORLD_SIZE_X + BOUND_SLACK);
  player.y = clamp(msg.y, -BOUND_SLACK, WORLD_SIZE_Y + BOUND_SLACK);
  player.z = clamp(msg.z, -BOUND_SLACK, WORLD_SIZE_Z + BOUND_SLACK);
  player.yaw = msg.yaw;
  player.pitch = msg.pitch;
  player.lastSeen = Date.now();
  rosterDirty = true;
}

function applyBlockEdit(player: ServerPlayer, msg: BlockEditMsg): void {
  const { x, y, z, id } = msg;
  const reject = (why: string): void => {
    // Implicit correction: echo the true current cell value back.
    sendTo(player.socket, {
      type: 'blockEdits',
      edits: [[x, y, z, world.getBlock(x, y, z)]],
    });
    console.log(`[server] edit from ${player.name} rejected: ${why}`);
  };

  if (x < 0 || y < 0 || z < 0 || x >= WORLD_SIZE_X || y >= WORLD_SIZE_Y || z >= WORLD_SIZE_Z) {
    return reject('out of bounds');
  }
  if (id < 0 || id >= BLOCKS.length) return reject(`invalid block id ${id}`);
  // Mode-reserved blocks (beds, generators, party floor wools) must never
  // enter the persistent sandbox overlay — the mode manager accepts them only
  // inside matches, under its own rules.
  if (id !== AIR && BLOCKS[id].reserved) {
    return reject(`reserved ${modeManager.mode === 'party' ? 'Block Party' : 'BedWars'} block`);
  }

  const current = world.getBlock(x, y, z);
  if (id === AIR && BLOCKS[current].unbreakable) return reject('unbreakable block');
  if (id !== AIR && current !== AIR && current !== WATER) {
    return reject(`cell occupied by ${BLOCKS[current].name}`);
  }
  const dist = Math.hypot(x + 0.5 - player.x, y + 0.5 - player.y, z + 0.5 - player.z);
  if (dist > REACH) return reject(`out of reach (${dist.toFixed(1)} > ${REACH})`);

  world.setBlock(x, y, z, id);
  editsDirty = true;
  player.lastSeen = Date.now();
  broadcast({ type: 'blockEdits', edits: [[x, y, z, id]] });
}

// --- test bot (protocol v4) --------------------------------------------------

function sendGameError(player: ServerPlayer, message: string): void {
  sendTo(player.socket, { type: 'gameEvent', kind: 'error', message });
}

/** Spawns the single test bot (a regular roster entry, flagged via `bot`). */
function addBot(requester: ServerPlayer): void {
  if (bot) {
    sendGameError(requester, 'A test bot is already in the game');
    return;
  }
  bot = createBot({
    players,
    info: () => modeManager.botInfo(BOT_ID),
    attack: (targetId) => {
      if (bot) modeManager.attack(bot.player, { type: 'attack', id: targetId, held: 'fist' });
    },
    onMoved: () => {
      if (bot) modeManager.onMoved(bot.player);
    },
    log: (line) => console.log(line),
  });
  bot.player.x = SPAWN.x;
  bot.player.y = SPAWN.y;
  bot.player.z = SPAWN.z;
  players.set(BOT_ID, bot.player);
  rosterDirty = true;
  console.log(`[server] ${BOT_NAME} (#${BOT_ID}) joined (test bot) — ${players.size} online`);
}

/** Removes the test bot; mid-match this is a normal disconnect (other wins). */
function removeBot(requester: ServerPlayer): void {
  const leaving = bot;
  if (!leaving) {
    sendGameError(requester, 'No test bot in the game');
    return;
  }
  bot = null;
  players.delete(leaving.player.id);
  rosterDirty = true;
  broadcast({ type: 'left', id: leaving.player.id });
  modeManager.onPlayerLeft(leaving.player);
  console.log(`[server] ${leaving.player.name} (#${leaving.player.id}) left (test bot removed) — ${players.size} online`);
}

  function removeConnection(socket: WebSocket): void {
    if (!connections.has(socket)) return;
    connections.delete(socket);
    for (const [id, player] of players) {
      if (player.socket !== socket) continue;
      players.delete(id);
      rosterDirty = true;
      broadcast({ type: 'left', id });
      modeManager.onPlayerLeft(player); // mid-match disconnect → other wins
      console.log(`[server] ${player.name} (#${id}) left — ${players.size} online`);
    }
  }

// --- main -------------------------------------------------------------------

export async function main(): Promise<void> {
  loadEdits();

  const app = express();
  app.get('/healthz', (_req, res) => {
    const humans = [...players.values()].filter((player) => !player.bot).length;
    res.json({
      ok: true,
      players: players.size,
      humans,
      bots: players.size - humans,
      edits: world.edits.size,
      mode: modeManager.mode,
    });
  });
  if (existsSync(CLIENT_DIST)) {
    app.use(express.static(CLIENT_DIST));
  } else {
    app.get('/', (_req, res) => {
      res
        .type('text')
        .send(
          'client/dist not built yet. Run `npm run build`, or `npm run dev` ' +
            'for the Vite dev server at http://localhost:5173',
        );
    });
  }

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (socket: WebSocket) => {
    connections.set(socket, { lastActivity: Date.now() });
    let me: ServerPlayer | null = null;

    socket.on('message', (data: RawData) => {
      const conn = connections.get(socket);
      if (conn) conn.lastActivity = Date.now();
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawDataToString(data));
      } catch {
        return;
      }
      const msg = parseClientMessage(parsed);
      if (!msg) return;

      switch (msg.type) {
        case 'hello':
          if (!me) {
            me = joinPlayer(socket, msg.name);
            // Joining mid-match: swap the newcomer into the running game
            // (as a spectator when they are not one of the two fighters).
            const modeChanged = modeManager.modeChangedFor(me.id);
            if (modeChanged) sendTo(socket, modeChanged);
          }
          break;
        case 'move':
          if (me) {
            applyMove(me, msg);
            modeManager.onMoved(me); // void-kill detection
          }
          break;
        case 'blockEdit':
          if (me) {
            // The mode manager owns edits during a match (bed rules, shop
            // blocks, match-world overlay); sandbox path otherwise.
            if (!modeManager.edit(me, msg)) applyBlockEdit(me, msg);
          }
          break;
        case 'chat': {
          if (!me) break;
          const text = sanitizeChat(msg.text);
          if (text.length > 0) broadcast({ type: 'chat', from: me.name, text });
          break;
        }
        case 'startGame':
          if (me) modeManager.startGame(me, msg.mode);
          break;
        case 'ready':
          if (me) modeManager.ready(me);
          break;
        case 'leaveGame':
          if (me) modeManager.leaveGame(me);
          break;
        case 'attack':
          if (me) modeManager.attack(me, msg);
          break;
        case 'buy':
          if (me) modeManager.buy(me, msg);
          break;
        case 'useHeld':
          if (me) modeManager.useHeld(me);
          break;
        case 'addBot':
          if (me) addBot(me);
          break;
        case 'removeBot':
          if (me) removeBot(me);
          break;
      }
    });

    socket.on('pong', () => {
      const conn = connections.get(socket);
      if (conn) conn.lastActivity = Date.now();
    });
    socket.on('close', () => removeConnection(socket));
    socket.on('error', () => removeConnection(socket));
  });

  const snapshotTimer = setInterval(() => {
    if (!rosterDirty) return;
    rosterDirty = false;
    broadcast({ type: 'players', players: snapshotList() });
  }, SNAPSHOT_MS);

  // BedWars match tick (200 ms): phases, generators, regen, respawns,
  // sudden death + the 5 Hz gameState snapshot.
  const matchTimer = setInterval(() => modeManager.tick(Date.now()), MATCH_TICK_MS);

  // Test bot brain (10 Hz): wander/chase/party physics + roster position.
  // Its moves are server-authored (no move messages), so mark the roster
  // dirty here — the 20 Hz snapshot timer relays the bot like any player.
  const botTimer = setInterval(() => {
    if (!bot) return;
    bot.tick(Date.now());
    rosterDirty = true;
  }, 100);

  const heartbeatTimer = setInterval(() => {
    const now = Date.now();
    for (const [socket, conn] of connections) {
      if (now - conn.lastActivity > IDLE_TIMEOUT_MS) {
        socket.terminate();
        continue;
      }
      if (socket.readyState === WebSocket.OPEN) socket.ping();
    }
  }, HEARTBEAT_MS);

  const saveTimer = setInterval(() => saveEdits(), SAVE_INTERVAL_MS);

  const shutdown = (signal: string): void => {
    console.log(`\n[server] ${signal} — saving world edits…`);
    clearInterval(snapshotTimer);
    clearInterval(heartbeatTimer);
    clearInterval(saveTimer);
    clearInterval(matchTimer);
    clearInterval(botTimer);
    saveEdits(true);
    for (const socket of connections.keys()) socket.terminate();
    wss.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  server.listen(PORT, () => {
    console.log('[server] minecraft-mini LAN server');
    console.log(`[server]   local  http://localhost:${PORT}`);
    for (const url of lanUrls()) console.log(`[server]   LAN    ${url}`);
    console.log('[server]   Share the LAN address with players on your Wi-Fi.');
  });
}

/** All non-internal IPv4 interfaces as playable LAN URLs. */
function lanUrls(): string[] {
  const urls: string[] = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const info of interfaces ?? []) {
      if (info.family === 'IPv4' && !info.internal) urls.push(`http://${info.address}:${PORT}`);
    }
  }
  return urls;
}

// Side-effect entry (tsx): running this file starts the server. Nobody imports
// it, so there is no double-start guard to worry about.
void main();
