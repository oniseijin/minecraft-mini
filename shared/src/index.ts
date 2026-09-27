/**
 * Shared code used by both the client and the server:
 * protocol types, block registry, world model + worldgen, raycasting.
 */

export const PROTOCOL_VERSION = 1;

export * from './blocks';
export * from './protocol';
export * from './world';
export * from './raycast';
