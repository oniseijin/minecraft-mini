/**
 * Shared code used by both the client and the server:
 * protocol types, block registry, world model + worldgen, BedWars arena +
 * shop, Block Party arena, Murder Mystery manor, raycasting, cross-boundary
 * simulation constants.
 */

export const PROTOCOL_VERSION = 9; // v9: murder mystery mode (§3.6) — 'murder' game mode, gameState.murder, guest mob kind, zapGuest/investigateGravestone

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
