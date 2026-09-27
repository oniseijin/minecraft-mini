/**
 * Shared code used by both the client and the server:
 * protocol types, block registry, world model + worldgen, BedWars arena +
 * shop, Block Party arena, raycasting.
 */

export const PROTOCOL_VERSION = 6; // v6: sandbox mobs (mobs/mobDied/attackMob, §3.5)

export * from './blocks';
export * from './protocol';
export * from './shop';
export * from './arena';
export * from './partyArena';
export * from './world';
export * from './raycast';
