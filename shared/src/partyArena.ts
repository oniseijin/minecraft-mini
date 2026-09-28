/**
 * Deterministic Block Party arena (DESIGN.md §3.4): a floating 25×25 wool
 * dance floor at y=30 centered on (128, 64) — cells x 116–140, z 52–76 — over
 * an EMPTY void world (all air, no bedrock, no terrain), plus a 3×3 cobble
 * spectator platform off the floor's south edge at (128, 30, 84).
 *
 * Unlike the BedWars arena, the floor itself is per-round state: each round
 * re-randomizes the mosaic, so the match world starts as pure void and every
 * floor cell travels as an edit (initial batch in `modeChanged`, later rounds
 * as `blockEdits` batches). Only the spectator platform is baked here.
 *
 * Determinism rules: integer-hash only (same discipline as worldgen) — the
 * server and every client compute the exact same mosaic from (seed, round).
 */

import { PARTY_COLORS, COBBLE } from './blocks';
import { CHUNKS_X, CHUNKS_Z, CHUNK_VOLUME, World, type EditTuple } from './world';
import type { ArenaSpawn } from './arena';

export const PARTY_SEED = 90210;

/** Inclusive floor bounds; `y` is the block layer players stand on. */
export const PARTY_FLOOR = {
  minX: 116,
  maxX: 140, // 25 cells wide
  minZ: 52,
  maxZ: 76, // 25 cells deep
  y: 30,
} as const;

export const PARTY = {
  /** Feet spawns on the center floor cells, facing each other (yaw 0 = −Z). */
  spawns: [
    { x: 128.5, y: 31, z: 63.5, yaw: Math.PI }, // north slot, faces south…
    { x: 128.5, y: 31, z: 65.5, yaw: 0 }, // …south slot, faces north
  ] as ArenaSpawn[],
  /** Eliminated players fly free from the spectator platform. */
  spectatorSpawn: { x: 128.5, y: 31, z: 84.5 },
  spectateCells: { minX: 127, maxX: 129, minZ: 83, maxZ: 85, y: 30 } as const,
} as const;

/** 32-bit integer hash → [0, 1). Stable across platforms (no floats, no Date). */
function hash3(a: number, b: number, c: number): number {
  let h = Math.imul(a, 0x27d4eb2d) ^ Math.imul(b, 0x165667b1) ^ Math.imul(c, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** The floor color (party wool block id) of one cell for a (seed, round) mosaic. */
export function partyColorAt(seed: number, round: number, cx: number, cz: number): number {
  const slot = Math.floor(hash3(cx, cz, seed ^ Math.imul(round, 0x85ebca6b)) * PARTY_COLORS.length);
  return PARTY_COLORS[slot].id;
}

/** Deterministic scalar in [0, 1) from (seed, salt) — e.g. the round's color pick. */
export function partyRand(seed: number, salt: number): number {
  return hash3(seed, salt, 0x51ab3c9f);
}

/** The full 25×25 mosaic for one round as an edit list (625 entries, row-major). */
export function generatePartyFloor(seed: number, round: number): EditTuple[] {
  const edits: EditTuple[] = [];
  for (let cz = 0; cz <= PARTY_FLOOR.maxZ - PARTY_FLOOR.minZ; cz++) {
    for (let cx = 0; cx <= PARTY_FLOOR.maxX - PARTY_FLOOR.minX; cx++) {
      edits.push([PARTY_FLOOR.minX + cx, PARTY_FLOOR.y, PARTY_FLOOR.minZ + cz, partyColorAt(seed, round, cx, cz)]);
    }
  }
  return edits;
}

/** The static 3×3 spectator platform edits (cobble south of the floor). */
export function partyPlatformEdits(): EditTuple[] {
  const edits: EditTuple[] = [];
  const { minX, maxX, minZ, maxZ, y } = PARTY.spectateCells;
  for (let z = minZ; z <= maxZ; z++) {
    for (let x = minX; x <= maxX; x++) {
      edits.push([x, y, z, COBBLE]);
    }
  }
  return edits;
}

/**
 * The party match world: every chunk exists but is pure air — void below, no
 * bedrock, no terrain. Floor + platform arrive as edits on top of this.
 */
export function generatePartyWorld(): World {
  const world = new World();
  for (let cz = 0; cz < CHUNKS_Z; cz++) {
    for (let cx = 0; cx < CHUNKS_X; cx++) {
      world.chunks.set(world.chunkKey(cx, cz), new Uint8Array(CHUNK_VOLUME));
    }
  }
  return world;
}
