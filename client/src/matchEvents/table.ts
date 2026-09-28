/**
 * Per-mode gameEvent dispatch (REFACTORING.md 2a.4): each mode module exports
 * an optional-handler table keyed by event kind; unknown kinds are skipped,
 * exactly like the switch's implicit default. Shared by bw.ts / party.ts /
 * sandbox.ts so adding a mode is "new table + one dispatch arm".
 */

import type { GameEventMsg } from '@mc/shared';

/** The gameEvent kind union. */
export type GameEventKind = GameEventMsg['kind'];

/** The concrete message variant for one kind. */
export type EventOf<K extends GameEventKind> = Extract<GameEventMsg, { kind: K }>;

/** Optional handler per gameEvent kind. */
export type EventTable<C> = {
  [K in GameEventKind]?: (msg: EventOf<K>, ctx: C) => void;
};

/** Runs the registered handler for msg.kind, if any. */
export function dispatchEvent<C>(table: EventTable<C>, msg: GameEventMsg, ctx: C): void {
  // Sound by construction: table entries are keyed by (and receive) their own kind.
  (table[msg.kind] as ((m: GameEventMsg, c: C) => void) | undefined)?.(msg, ctx);
}
