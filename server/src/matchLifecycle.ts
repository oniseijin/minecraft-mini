/**
 * Shared match-mode lifecycle helpers (REFACTORING.md 2b.2): the identical
 * roster-pick / ready-gate / leave-with-win-by-default / everyone-left /
 * modeChanged-fan-out / edit-reject-echo shapes that bedwars.ts, party.ts,
 * match.ts and index.ts each used to carry their own copy of. A third
 * mini-game reuses these instead of copying them again.
 */

import type { ModeChangedMsg, ServerMessage, World } from '@mc/shared';
import type { WebSocket } from 'ws';
import type { ServerPlayer } from './match';

/** Picks the match roster: the first two joiners by id, or null when nobody is online. */
export function pickRoster(
  players: Map<number, ServerPlayer>,
  emptyLog: string,
  log: (line: string) => void,
): ServerPlayer[] | null {
  const roster = [...players.values()].sort((a, b) => a.id - b.id).slice(0, 2);
  if (roster.length < 1) {
    log(emptyLog);
    return null;
  }
  return roster;
}

/** Structural ready-gate state (bedwars Match and party PartyMatch both fit). */
export interface ReadyGateState {
  phase: string;
  players: Map<number, unknown>;
  ready: Set<number>;
}

/** Records a ready vote after a match ends; true when both remaining players want the rematch. */
export function recordReady(state: ReadyGateState, player: ServerPlayer): boolean {
  if (state.phase !== 'ended' || !state.players.has(player.id)) return false;
  state.ready.add(player.id);
  return state.ready.size >= Math.min(2, state.players.size);
}

/** Structural match state for the leave path (both modes fit). */
export interface LeaveMatchState<MP extends { id: number }> {
  phase: string;
  ready: Set<number>;
  players: Map<number, MP>;
}

/**
 * Disconnect during a match: roster removal + the left log; returns the
 * win-by-default winner when the match was still running and someone
 * remains (the caller runs their mode's endMatch), else null.
 */
export function leaveMidMatch<MP extends { id: number }>(
  state: LeaveMatchState<MP>,
  label: string,
  player: ServerPlayer,
  log: (line: string) => void,
): MP | null {
  state.ready.delete(player.id);
  const entry = state.players.get(player.id);
  if (!entry) return null;
  state.players.delete(player.id);
  log(`[${label}] ${player.name} left mid-match`);
  if (state.phase !== 'ended') {
    const remaining = [...state.players.values()][0];
    if (remaining) return remaining; // win by default
  }
  return null;
}

/** True when the last connection dropped (the registry resets to sandbox). */
export function everyoneLeft(players: Map<number, ServerPlayer>): boolean {
  return players.size === 0;
}

/** modeChanged fan-out to every connected player (payload computed per player). */
export function announceMode(
  sendTo: (socket: WebSocket | null, msg: ServerMessage) => void,
  players: Map<number, ServerPlayer>,
  payloadFor: (player: ServerPlayer) => ModeChangedMsg,
): void {
  for (const entry of players.values()) sendTo(entry.socket, payloadFor(entry));
}

/**
 * Edit rejection echo: implicitly correct the client with the true current
 * cell value and log why (the sandbox path in index.ts, BedWars edits, and
 * the party floor rejection all share this shape).
 */
export function rejectEdit(
  sendTo: (socket: WebSocket | null, msg: ServerMessage) => void,
  world: World,
  player: ServerPlayer,
  cell: { x: number; y: number; z: number },
  why: string,
  label: string,
  log: (line: string) => void,
): void {
  sendTo(player.socket, {
    type: 'blockEdits',
    edits: [[cell.x, cell.y, cell.z, world.getBlock(cell.x, cell.y, cell.z)]],
  });
  log(`[${label}] edit from ${player.name} rejected: ${why}`);
}
