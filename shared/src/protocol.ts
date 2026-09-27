/**
 * Wire protocol (DESIGN.md §3.2) — JSON text frames carrying discriminated
 * unions. Block edits travel as flat `[x, y, z, blockId]` quads (EditTuple).
 * The deterministic world is NEVER sent: clients generate terrain from the
 * server's `seed` and apply its edit overlay.
 *
 * `parseClientMessage` / `parseServerMessage` validate the *shape* of incoming
 * JSON (finite numbers, integer coords); policy (name/chat sanitizing, reach,
 * occupancy) stays server-side.
 */

import type { EditTuple } from './world';

/** One player's state in a roster snapshot. */
export interface PlayerSnapshot {
  id: number;
  name: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
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

export type ClientMessage = HelloMsg | MoveMsg | BlockEditMsg | ChatSendMsg;

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

export type ServerMessage = WelcomeMsg | PlayersMsg | BlockEditsMsg | ChatBroadcastMsg | LeftMsg;

// --- parsing ----------------------------------------------------------------

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

function asSnapshot(value: unknown): PlayerSnapshot | null {
  if (!isRecord(value)) return null;
  const id = asInt(value.id);
  const name = asString(value.name);
  const x = asNumber(value.x);
  const y = asNumber(value.y);
  const z = asNumber(value.z);
  const yaw = asNumber(value.yaw);
  const pitch = asNumber(value.pitch);
  if (id === null || name === null || x === null || y === null || z === null) return null;
  if (yaw === null || pitch === null) return null;
  return { id, name, x, y, z, yaw, pitch };
}

function asSnapshots(value: unknown): PlayerSnapshot[] | null {
  if (!Array.isArray(value)) return null;
  const out: PlayerSnapshot[] = [];
  for (const entry of value) {
    const snapshot = asSnapshot(entry);
    if (snapshot === null) return null;
    out.push(snapshot);
  }
  return out;
}

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

/** Parses one already-JSON-decoded client frame; null when malformed. */
export function parseClientMessage(data: unknown): ClientMessage | null {
  if (!isRecord(data)) return null;
  switch (data.type) {
    case 'hello': {
      const name = asString(data.name);
      return name === null ? null : { type: 'hello', name };
    }
    case 'move': {
      const x = asNumber(data.x);
      const y = asNumber(data.y);
      const z = asNumber(data.z);
      const yaw = asNumber(data.yaw);
      const pitch = asNumber(data.pitch);
      if (x === null || y === null || z === null || yaw === null || pitch === null) return null;
      return { type: 'move', x, y, z, yaw, pitch };
    }
    case 'blockEdit': {
      const x = asInt(data.x);
      const y = asInt(data.y);
      const z = asInt(data.z);
      const id = asInt(data.id);
      if (x === null || y === null || z === null || id === null) return null;
      return { type: 'blockEdit', x, y, z, id };
    }
    case 'chat': {
      const text = asString(data.text);
      return text === null ? null : { type: 'chat', text };
    }
    default:
      return null;
  }
}

/** Parses one already-JSON-decoded server frame; null when malformed. */
export function parseServerMessage(data: unknown): ServerMessage | null {
  if (!isRecord(data)) return null;
  switch (data.type) {
    case 'welcome': {
      const playerId = asInt(data.playerId);
      const name = asString(data.name);
      const seed = asInt(data.seed);
      const edits = asEditTuples(data.edits);
      const players = asSnapshots(data.players);
      if (playerId === null || name === null || seed === null) return null;
      if (edits === null || players === null) return null;
      return { type: 'welcome', playerId, name, seed, edits, players };
    }
    case 'players': {
      const players = asSnapshots(data.players);
      return players === null ? null : { type: 'players', players };
    }
    case 'blockEdits': {
      const edits = asEditTuples(data.edits);
      return edits === null ? null : { type: 'blockEdits', edits };
    }
    case 'chat': {
      const from = asString(data.from);
      const text = asString(data.text);
      return from === null || text === null ? null : { type: 'chat', from, text };
    }
    case 'left': {
      const id = asInt(data.id);
      return id === null ? null : { type: 'left', id };
    }
    default:
      return null;
  }
}
