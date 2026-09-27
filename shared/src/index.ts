/**
 * Shared code used by both the client and the server:
 * protocol types, block registry, world model + worldgen, BedWars arena +
 * shop, raycasting.
 */

export const PROTOCOL_VERSION = 2;

export * from './blocks';
export * from './protocol';
export * from './shop';
export * from './arena';
export * from './world';
export * from './raycast';
