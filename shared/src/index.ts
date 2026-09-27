/**
 * Shared code used by both the client and the server:
 * protocol types, block registry, world model + worldgen, BedWars arena +
 * shop, Block Party arena, raycasting.
 */

export const PROTOCOL_VERSION = 7; // v7: Block Party mystery boxes + power-ups + Color Zapper (§3.4.3)

export * from './blocks';
export * from './protocol';
export * from './shop';
export * from './arena';
export * from './partyArena';
export * from './world';
export * from './raycast';
