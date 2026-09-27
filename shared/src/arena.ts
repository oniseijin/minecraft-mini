/**
 * Deterministic BedWars 1v1 arena (DESIGN.md §3.3): three floating islands
 * over the void — two team islands (11×11, grass top at y=30) centered on
 * (64,64) and (192,64), each with a bed, a spawn facing mid and a planks shop
 * pad — plus a mid island (13×13, top at y=28) at (128,64) with the emerald
 * generator. Two-block-wide plank bridges run at mid height most of the way
 * toward mid, each stopping ~6 blocks short so players must bridge the last
 * gap with shop-bought blocks. There is NO bedrock: every other cell is void,
 * and falling below VOID_KILL_Y is death (server-enforced via reported
 * positions).
 *
 * Determinism rules: pure integer geometry, no randomness at all — every
 * client and the server generate the exact same arena from any seed.
 */

import { BED_BLUE, BED_RED, DIRT, EMERALD_GEN, GLASS, GRASS, PLANKS, STONE } from './blocks';
import { CHUNKS_X, CHUNKS_Z, CHUNK_VOLUME, WORLD_SIZE_X, WORLD_SIZE_Y, WORLD_SIZE_Z, World, blockIndex } from './world';

export const ARENA_SEED = 90125;
/** Death plane: reported feet y below this during a match is a void kill. */
export const VOID_KILL_Y = 8;

export interface ArenaPoint {
  x: number;
  y: number;
  z: number;
}

export interface ArenaSpawn extends ArenaPoint {
  /** Radians, player-style (0 faces −Z; ∓π/2 faces ∓X). */
  yaw: number;
}

export const ARENA = {
  /** Feet spawns, team-indexed (0 = red/west island, 1 = blue/east island). */
  spawns: [
    { x: 67.5, y: 31, z: 64.5, yaw: -Math.PI / 2 },
    { x: 189.5, y: 31, z: 64.5, yaw: Math.PI / 2 },
  ] as ArenaSpawn[],
  /** The bed block cell per team (a single solid bed block on the island). */
  beds: [
    { x: 61, y: 31, z: 64 },
    { x: 195, y: 31, z: 64 },
  ] as ArenaPoint[],
  /** Stand within `shopRadius` (3D) of your team's point to open/buy. */
  shopPoints: [
    { x: 61.5, y: 31, z: 60.5 },
    { x: 195.5, y: 31, z: 60.5 },
  ] as ArenaPoint[],
  shopRadius: 6,
  /** Mid-island emerald generator pickup point. */
  midGenerator: { x: 128.5, y: 29, z: 64.5 } as ArenaPoint,
  midGeneratorRadius: 3,
  /** Late joiners during a match spectate from the mid island. */
  spectatorSpawn: { x: 128.5, y: 29, z: 58.5 } as ArenaPoint,
  /** Bed block id per team (also used to map a bed cell back to its team). */
  bedBlocks: [BED_RED, BED_BLUE],
} as const;

/** Team owning a bed block id, or −1 when the id is not a bed. */
export function bedTeamOf(id: number): number {
  return id === BED_RED ? 0 : id === BED_BLUE ? 1 : -1;
}

/** Island cross-section: distance² cap per layer, top layer first. */
const TEAM_LAYERS: [number, number][] = [
  [28, GRASS],
  [19, DIRT],
  [12, STONE],
  [6, STONE],
  [2, STONE],
];
const MID_LAYERS: [number, number][] = [
  [38, GRASS],
  [28, DIRT],
  [20, STONE],
  [12, STONE],
  [6, STONE],
  [2, STONE],
];

/**
 * Generates the arena world: all 16×16 chunks exist (air-filled), the three
 * islands + bridges + beds + shop pads + generator marker are carved in.
 */
export function generateBedwarsArena(seed: number): World {
  void seed; // fixed layout — kept for signature symmetry with generateWorld
  const world = new World();
  for (let cz = 0; cz < CHUNKS_Z; cz++) {
    for (let cx = 0; cx < CHUNKS_X; cx++) {
      world.chunks.set(world.chunkKey(cx, cz), new Uint8Array(CHUNK_VOLUME));
    }
  }

  const set = (x: number, y: number, z: number, id: number): void => {
    if (x < 0 || y < 0 || z < 0 || x >= WORLD_SIZE_X || y >= WORLD_SIZE_Y || z >= WORLD_SIZE_Z) {
      return;
    }
    const chunk = world.chunks.get(world.chunkKey(x >> 4, z >> 4));
    if (chunk) chunk[blockIndex(x & 15, y, z & 15)] = id;
  };

  // Floating islands: rounded discs, tapering stone underneath.
  const island = (cx: number, cz: number, topY: number, radius: number, mid: boolean): void => {
    const layers = mid ? MID_LAYERS : TEAM_LAYERS;
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const d2 = dx * dx + dz * dz;
        layers.forEach(([maxD2, id], i) => {
          if (d2 <= maxD2) set(cx + dx, topY - i, cz + dz, id);
        });
      }
    }
  };
  island(64, 64, 30, 5, false); // red island
  island(192, 64, 30, 5, false); // blue island
  island(128, 64, 28, 6, true); // mid island

  // Side bridges at mid height (y=28), stopping 6 blocks short of mid island.
  for (let x = 70; x <= 115; x++) {
    set(x, 28, 64, PLANKS);
    set(x, 28, 65, PLANKS);
  }
  for (let x = 141; x <= 186; x++) {
    set(x, 28, 64, PLANKS);
    set(x, 28, 65, PLANKS);
  }

  // Beds + shop pads (3×3 planks inlaid into the island top, glass marker on top).
  set(61, 31, 64, BED_RED);
  set(195, 31, 64, BED_BLUE);
  for (let x = 60; x <= 62; x++) {
    for (let z = 59; z <= 61; z++) {
      set(x, 30, z, PLANKS);
      set(x + 134, 30, z, PLANKS);
    }
  }
  set(61, 31, 60, GLASS);
  set(195, 31, 60, GLASS);

  // Mid emerald generator marker.
  set(128, 29, 64, EMERALD_GEN);

  return world;
}
