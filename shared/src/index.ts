/**
 * Shared code used by both the client and the server:
 * protocol types, block registry, world model + worldgen, BedWars arena +
 * shop, Block Party arena, Murder Mystery manor, raycasting, cross-boundary
 * simulation constants.
 */

export const PROTOCOL_VERSION = 10; // v10: BedWars bow (§3.3) — bowShot C→S, arrowLaunched/hit gameEvents, inventory gains bow/arrows

export * from './blocks';
export * from './dayclock';
export * from './protocol';
export * from './shop';
export * from './arena';
export * from './partyArena';
export * from './manor';
export * from './world';
export * from './raycast';
export * from './simulation';
