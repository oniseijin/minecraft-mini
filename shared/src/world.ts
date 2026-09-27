/**
 * Finite voxel world: 256×64×256 blocks stored as a 16×16 grid of chunks,
 * each a flat Uint8Array(16×64×16). Also hosts the deterministic worldgen
 * (island heightmap + trees) so client and (later) server generate the exact
 * same terrain from a seed — only an edit overlay ever needs syncing (M3).
 *
 * Determinism rules: integer-hash value noise only. No Math.random, no Date,
 * no platform-dependent floats (32-bit int ops via Math.imul).
 */

import { AIR, BEDROCK, BLOCKS, DIRT, GRASS, LEAVES, LOG, SAND, SNOW, STONE, WATER } from './blocks';

export const WORLD_SIZE_X = 256;
export const WORLD_SIZE_Y = 64;
export const WORLD_SIZE_Z = 256;
export const CHUNK = 16;
export const CHUNKS_X = WORLD_SIZE_X / CHUNK;
export const CHUNKS_Z = WORLD_SIZE_Z / CHUNK;
export const CHUNK_VOLUME = CHUNK * WORLD_SIZE_Y * CHUNK;
export const SEA_LEVEL = 28;

/** [x, y, z, blockId] — wire format for the M3 edit overlay. */
export type EditTuple = [number, number, number, number];

/** Flat index of a block inside a chunk's Uint8Array (y-major). */
export function blockIndex(lx: number, y: number, lz: number): number {
  return (y * CHUNK + lz) * CHUNK + lx;
}

export class World {
  /** Chunk columns keyed by `"cx,cz"`. */
  readonly chunks = new Map<string, Uint8Array>();
  /** Deviations from the generated terrain, keyed by `"x,y,z"`. */
  readonly edits = new Map<string, number>();

  chunkKey(cx: number, cz: number): string {
    return `${cx},${cz}`;
  }

  /** Block id at world coordinates; 0 (air) outside the world or ungenerated chunks. */
  getBlock(x: number, y: number, z: number): number {
    if (x < 0 || y < 0 || z < 0 || x >= WORLD_SIZE_X || y >= WORLD_SIZE_Y || z >= WORLD_SIZE_Z) {
      return AIR;
    }
    const chunk = this.chunks.get(this.chunkKey(x >> 4, z >> 4));
    if (!chunk) return AIR;
    return chunk[blockIndex(x & 15, y, z & 15)];
  }

  /**
   * Sets a block and records the edit. Returns the chunk keys that need
   * remeshing: the own chunk plus border (and corner, for AO) neighbours
   * when the block sits on a chunk border. Empty when nothing changed.
   */
  setBlock(x: number, y: number, z: number, id: number): string[] {
    if (x < 0 || y < 0 || z < 0 || x >= WORLD_SIZE_X || y >= WORLD_SIZE_Y || z >= WORLD_SIZE_Z) {
      return [];
    }
    const cx = x >> 4;
    const cz = z >> 4;
    const key = this.chunkKey(cx, cz);
    const chunk = this.chunks.get(key);
    if (!chunk) return [];
    const index = blockIndex(x & 15, y, z & 15);
    if (chunk[index] === id) return [];
    chunk[index] = id;
    this.edits.set(`${x},${y},${z}`, id);

    const lx = x & 15;
    const lz = z & 15;
    const west = lx === 0 && cx > 0;
    const east = lx === 15 && cx < CHUNKS_X - 1;
    const north = lz === 0 && cz > 0;
    const south = lz === 15 && cz < CHUNKS_Z - 1;
    const keys = [key];
    if (west) keys.push(this.chunkKey(cx - 1, cz));
    if (east) keys.push(this.chunkKey(cx + 1, cz));
    if (north) keys.push(this.chunkKey(cx, cz - 1));
    if (south) keys.push(this.chunkKey(cx, cz + 1));
    if (west && north) keys.push(this.chunkKey(cx - 1, cz - 1));
    if (east && north) keys.push(this.chunkKey(cx + 1, cz - 1));
    if (west && south) keys.push(this.chunkKey(cx - 1, cz + 1));
    if (east && south) keys.push(this.chunkKey(cx + 1, cz + 1));
    return keys;
  }

  /** Y of the highest non-air, non-liquid block in a column; -1 if the column is empty. */
  highestBlock(x: number, z: number): number {
    if (x < 0 || z < 0 || x >= WORLD_SIZE_X || z >= WORLD_SIZE_Z) return -1;
    for (let y = WORLD_SIZE_Y - 1; y >= 0; y--) {
      const id = this.getBlock(x, y, z);
      if (id !== AIR && !BLOCKS[id].liquid) return y;
    }
    return -1;
  }

  serializeEdits(): EditTuple[] {
    const out: EditTuple[] = [];
    for (const [key, id] of this.edits) {
      const [x, y, z] = key.split(',').map(Number) as [number, number, number];
      out.push([x, y, z, id]);
    }
    return out;
  }

  /** Applies a serialized edit overlay (e.g. from the M3 server); returns dirty chunk keys. */
  applyEdits(edits: readonly EditTuple[]): string[] {
    const dirty = new Set<string>();
    for (const [x, y, z, id] of edits) {
      for (const key of this.setBlock(x, y, z, id)) dirty.add(key);
    }
    return [...dirty];
  }
}

// ---------------------------------------------------------------------------
// Deterministic worldgen
// ---------------------------------------------------------------------------

/** 32-bit integer hash of (ix, iz, seed) → [0, 1). Stable across platforms. */
function hash2(ix: number, iz: number, seed: number): number {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iz, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 2D value noise: hashed lattice corners, smoothstep interpolation. */
function valueNoise2(x: number, z: number, seed: number): number {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const tx = smoothstep(x - x0);
  const tz = smoothstep(z - z0);
  const v00 = hash2(x0, z0, seed);
  const v10 = hash2(x0 + 1, z0, seed);
  const v01 = hash2(x0, z0 + 1, seed);
  const v11 = hash2(x0 + 1, z0 + 1, seed);
  return lerp(lerp(v00, v10, tx), lerp(v01, v11, tx), tz);
}

const NOISE_OCTAVES = 4;
const NOISE_BASE_FREQUENCY = 1 / 64;

/** 4-octave fractal value noise, roughly in [0, 1] with mean ≈ 0.5. */
function fbm2(x: number, z: number, seed: number): number {
  let sum = 0;
  let amplitude = 1;
  let frequency = NOISE_BASE_FREQUENCY;
  let norm = 0;
  for (let o = 0; o < NOISE_OCTAVES; o++) {
    sum += valueNoise2(x * frequency, z * frequency, seed + o * 1013) * amplitude;
    norm += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return sum / norm;
}

const ISLAND_CENTER = WORLD_SIZE_X / 2; // 128, 128
const ISLAND_RADIUS = 128;
const SNOW_LINE = 44;

/**
 * Terrain height (topmost solid block y) for one column: island falloff times
 * stretched fbm noise. fbm rarely reaches its extremes, so it is stretched to
 * use the full [0, 1] range and let peaks actually cross the snow line.
 */
function columnHeight(seed: number, x: number, z: number): number {
  const dx = x - ISLAND_CENTER;
  const dz = z - ISLAND_CENTER;
  const falloff = 1 - Math.min(Math.sqrt(dx * dx + dz * dz) / ISLAND_RADIUS, 1);
  const n = Math.min(Math.max((fbm2(x, z, seed) - 0.2) / 0.6, 0), 1);
  const height = Math.round(18 + falloff * (10 + n * 18));
  return Math.max(1, Math.min(60, height));
}

function topBlockFor(height: number): number {
  if (height > SNOW_LINE) return SNOW;
  if (Math.abs(height - SEA_LEVEL) <= 1) return SAND;
  return GRASS;
}

const TREE_CHANCE = 0.02;
const TREE_MARGIN = 2; // keep canopies away from the world edge

/**
 * Generates the whole world in one pass: bedrock floor, stone/dirt column
 * stack, grass/sand/snow tops, ocean water up to sea level, then scattered
 * deterministic trees (4–5 log trunk + 3×3×2 leaf blob + cap leaf).
 */
export function generateWorld(seed: number): World {
  const world = new World();
  for (let cz = 0; cz < CHUNKS_Z; cz++) {
    for (let cx = 0; cx < CHUNKS_X; cx++) {
      world.chunks.set(world.chunkKey(cx, cz), new Uint8Array(CHUNK_VOLUME));
    }
  }

  // Pass 1: terrain columns.
  const heights = new Uint8Array(WORLD_SIZE_X * WORLD_SIZE_Z);
  const tops = new Uint8Array(WORLD_SIZE_X * WORLD_SIZE_Z);
  for (let z = 0; z < WORLD_SIZE_Z; z++) {
    for (let x = 0; x < WORLD_SIZE_X; x++) {
      const h = columnHeight(seed, x, z);
      const top = topBlockFor(h);
      heights[z * WORLD_SIZE_X + x] = h;
      tops[z * WORLD_SIZE_X + x] = top;
      const chunk = world.chunks.get(world.chunkKey(x >> 4, z >> 4));
      if (!chunk) continue;
      const lx = x & 15;
      const lz = z & 15;
      const set = (y: number, id: number) => {
        chunk[blockIndex(lx, y, lz)] = id;
      };
      for (let y = 0; y <= h; y++) {
        if (y === 0) set(y, BEDROCK);
        else if (y === h) set(y, top);
        else if (y >= h - 3) set(y, DIRT);
        else set(y, STONE);
      }
      for (let y = h + 1; y <= SEA_LEVEL; y++) set(y, WATER); // ocean where terrain is lower
    }
  }

  // Pass 2: trees (canopies may span chunks, so writes go through world coords).
  const setGen = (x: number, y: number, z: number, id: number): void => {
    if (x < 0 || y < 0 || z < 0 || x >= WORLD_SIZE_X || y >= WORLD_SIZE_Y || z >= WORLD_SIZE_Z) {
      return;
    }
    const chunk = world.chunks.get(world.chunkKey(x >> 4, z >> 4));
    if (chunk) chunk[blockIndex(x & 15, y, z & 15)] = id;
  };
  const setIfAir = (x: number, y: number, z: number, id: number): void => {
    if (world.getBlock(x, y, z) === AIR) setGen(x, y, z, id);
  };

  for (let z = TREE_MARGIN; z < WORLD_SIZE_Z - TREE_MARGIN; z++) {
    for (let x = TREE_MARGIN; x < WORLD_SIZE_X - TREE_MARGIN; x++) {
      const column = z * WORLD_SIZE_X + x;
      if (tops[column] !== GRASS || heights[column] <= SEA_LEVEL) continue;
      if (hash2(x, z, seed ^ 0x51ab3c9f) >= TREE_CHANCE) continue;

      const h = heights[column];
      const trunkHeight = 4 + (hash2(x, z, seed ^ 0x1b873593) < 0.5 ? 0 : 1);
      for (let y = h + 1; y <= h + trunkHeight; y++) setGen(x, y, z, LOG);

      for (let dy = trunkHeight; dy <= trunkHeight + 1; dy++) {
        for (let dxx = -1; dxx <= 1; dxx++) {
          for (let dzz = -1; dzz <= 1; dzz++) {
            if (dxx === 0 && dzz === 0 && dy === trunkHeight) continue; // trunk tip
            if (dxx !== 0 && dzz !== 0 && hash2(x * 3 + dxx + dy * 17, z * 3 + dzz, seed ^ 0xcc9e2d51) < 0.5) {
              continue; // ragged canopy: skip corners randomly (deterministic)
            }
            setIfAir(x + dxx, h + dy, z + dzz, LEAVES);
          }
        }
      }
      setIfAir(x, h + trunkHeight + 2, z, LEAVES);
    }
  }

  return world;
}
