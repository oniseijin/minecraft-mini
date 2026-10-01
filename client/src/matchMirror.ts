/**
 * Shared scaffolding for the per-mode client state mirrors (REFACTORING.md
 * Phase 3): bwState/partyState/murderState all keep the same recent-event ring
 * (the __mc.*.events automation hook), the same {winnerId, winnerName, stats}
 * results shape, and the same null-safe by-id roster lookup. Only the
 * genuinely identical pieces live here — each mirror's snapshot payload and
 * its reset body stay bespoke in its own module (the shapes really do differ
 * per mode), so this is extraction, not a forced base class.
 */

import type { ArenaSpawn, GameEventMsg, MatchEndStats, ModeChangedMsg } from '@mc/shared';

/** Recent raw event, oldest first — automation/assertion hook (__mc.*.events). */
export interface RecentEvent {
  kind: string;
  at: number;
  data: Omit<GameEventMsg, 'type'>;
}

/** Match-end results banner payload — identical shape in all three modes. */
export interface MatchResults {
  winnerId: number;
  winnerName: string;
  stats: MatchEndStats[];
}

const EVENT_CAP = 30;

export interface EventLog {
  /**
   * The live ring array — one array for the mirror's lifetime (the mirrors
   * clear in place, so references captured early keep working).
   */
  readonly events: RecentEvent[];
  record(msg: GameEventMsg): void;
  clear(): void;
}

/** The capped recent-events ring every mirror exposes to tests/automation. */
export function createEventLog(): EventLog {
  const events: RecentEvent[] = [];
  return {
    events,
    record(msg) {
      events.push({ kind: msg.kind, at: Date.now(), data: msg as Omit<GameEventMsg, 'type'> });
      if (events.length > EVENT_CAP) events.shift();
    },
    clear() {
      events.length = 0;
    },
  };
}

/** Null-safe roster lookup — the shared shape of me()/player()/guest(). */
export function byId<V>(map: Map<number, V>, id: number | null): V | null {
  return id === null ? null : map.get(id) ?? null;
}

/** Defensive copy of a modeChanged payload's spawn slots (the mirrors' prologue). */
export function copySpawns(msg: ModeChangedMsg): ArenaSpawn[] {
  return msg.spawns.map((spawn) => ({ ...spawn }));
}
