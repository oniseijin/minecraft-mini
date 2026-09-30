/**
 * Deterministic Murder Mystery manor (DESIGN.md §3.6, M7.2) — a code-generated
 * 48×48 stone manor on a void world, floor at y=30, centered near the origin
 * (footprint x/z 8–55). Same shape as the party arena: the match world starts
 * as pure air and the whole manor travels as the initial `modeChanged` edit
 * batch — the map is static for the whole match (no per-round re-deals) and
 * the client needs zero manor code: an empty world plus these edits is the
 * whole manor.
 *
 * Layout: an enclosed 1-thick stone perimeter (6 high) with a 2-wide south
 * entrance gate + a small porch outside it; inside, a 10×10 open central
 * courtyard ringed by a 3-high wall (one 2-wide door per side), and the four
 * strips between the courtyard ring and the perimeter split by seeded rng
 * into 6–8 rooms (north/south always split, west/east split 50/50), every
 * wall carrying a 2-wide door gap — each room always reaches the courtyard,
 * so the whole manor is one connected walkable space. Sparse 1×1 glass
 * windows (two per side) sit at eye height in the perimeter. Everything
 * stands on one flat y=30 slab, so the map is fully walkable with stepWalker
 * (1-block max steps: there are none — only walls, which block).
 *
 * Door gaps are FULL-HEIGHT openings (no lintel block above): the server's
 * stepWalker reads a column's walkable ground as highestBlock+1, so a lintel
 * would turn every doorway into a 3-high wall for the guest AI. The 2-wide
 * gaps stay narrow enough to read as doors.
 *
 * Determinism rules: mulberry32, integer ops only (same discipline as
 * worldgen/partyArena) — for a given seed the server and every client generate
 * the exact same manor.
 *
 * Manor rotation (§3.6, added 2026-10-01): each match deals a fresh layout —
 * only the layout rng's seed varies per match (server/src/murder.ts derives it
 * from Date.now(); MM_MANOR_SEED pins it for tests). MANOR's fixed anchors are
 * seed-independent and valid for EVERY seed, by construction:
 *   - the south entrance gate (x 31/32 at z 55) and the spawns just inside it
 *     are layout-independent: the room-split walls are confined to SPLIT_XS
 *     (28/29/34/35), so the gate corridor (x 31/32, z 38..54) is never walled;
 *   - the four super-coin corner cells (x/z 10/53) sit deep in room interiors
 *     — every split wall (x ∈ SPLIT_XS or z 30..33) and the courtyard band
 *     (26..37) is ≥5 cells away, so they are always plain standable floor;
 *   - every room always reaches the courtyard through a full-height 2-wide
 *     door and every strip carries a ring door, so the manor is one connected
 *     walkable space for any seed.
 *
 * The server's dealt world is `generateManorMatchWorld(seed)`: the canonical
 * MURDER_SEED manor — exactly what the client regenerates locally (main.ts) —
 * with the seeded layout applied on top, so `serializeEdits()` stays a
 * self-contained deal: every footprint/porch cell is re-asserted at the dealt
 * layout's value, including explicit AIR tuples wherever the canonical base
 * has a block the dealt layout does not.
 */

import { AIR, COBBLE, GLASS, PLANKS, STONE } from './blocks';
import { CHUNKS_X, CHUNKS_Z, CHUNK_VOLUME, World, type EditTuple } from './world';
import type { ArenaPoint, ArenaSpawn } from './arena';

export const MURDER_SEED = 424242;

export const MANOR = {
  /** Inclusive footprint bounds (48×48); `floorY` is the block layer stood on. */
  minX: 8,
  maxX: 55,
  minZ: 8,
  maxZ: 55,
  floorY: 30,
  /** Perimeter walls rise 6 blocks above the floor (y 31..36). */
  wallTopY: 36,
  /**
   * Interior walls (courtyard ring + room splits) are 3 high — impassable for
   * stepWalker (>1 rise) and players alike, but low enough that the open sky
   * keeps the manor readable while kids watch the guests for tells.
   */
  interiorWallTopY: 33,
  /** The two detective spawns, just inside the south entrance, facing in (yaw 0 = −Z). */
  spawns: [
    { x: 31.5, y: 31, z: 53.5, yaw: 0 },
    { x: 32.5, y: 31, z: 51.5, yaw: 0 },
  ] as ArenaSpawn[],
  /**
   * The four secluded interior corners — the only cells super coins may spawn
   * at (§3.6 "Super coins in the far corners"). Cell centers, stand height.
   */
  superCoinSpots: [
    { x: 10.5, y: 31, z: 10.5 },
    { x: 53.5, y: 31, z: 10.5 },
    { x: 10.5, y: 31, z: 53.5 },
    { x: 53.5, y: 31, z: 53.5 },
  ] as ArenaPoint[],
  /** Where non-participants (late joiners, the idle test bot) are dropped. */
  spectatorSpot: { x: 31.5, y: 31, z: 31.5 } as ArenaPoint,
} as const;

/** Deterministic mulberry32 — the manor layout rng (mobs.ts precedent). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The seeded layout decisions: room split walls, door gaps, windows. */
interface ManorLayout {
  northSplitX: number;
  northDoorZ: number;
  southSplitX: number;
  southDoorZ: number;
  westSplit: boolean;
  westSplitZ: number;
  westDoorX: number;
  eastSplit: boolean;
  eastSplitZ: number;
  eastDoorX: number;
  ringNorthDoorX: number;
  ringSouthDoorX: number;
  ringWestDoorZ: number;
  ringEastDoorZ: number;
  /** Perimeter window cells (1×1 glass at eye height, two per side). */
  windows: { x: number; z: number }[];
}

function manorLayout(seed: number = MURDER_SEED): ManorLayout {
  const rng = mulberry32(seed);
  const int = (lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));
  const pick = <T>(values: readonly T[]): T => values[Math.floor(rng() * values.length)];

  // North/south split walls stay clear of the x 31/32 entrance corridor.
  const SPLIT_XS = [28, 29, 34, 35] as const;
  const layout: ManorLayout = {
    northSplitX: pick(SPLIT_XS),
    northDoorZ: int(12, 22), // gap cells z..z+1 within the strip (z 9..25)
    southSplitX: pick(SPLIT_XS),
    southDoorZ: int(41, 51), // within the strip (z 38..54)
    westSplit: rng() < 0.5,
    westSplitZ: int(30, 33), // rooms z 26..ws−1 / ws+1..37, both ≥4 deep
    westDoorX: int(12, 22), // within the strip (x 9..25)
    eastSplit: rng() < 0.5,
    eastSplitZ: int(30, 33),
    eastDoorX: int(41, 51), // within the strip (x 38..54)
    // Ring doors: 2-wide, clear of the band corners (26/37).
    ringNorthDoorX: int(28, 34),
    ringSouthDoorX: int(28, 34),
    ringWestDoorZ: int(29, 34),
    ringEastDoorZ: int(29, 34),
    windows: [],
  };
  // Two windows per perimeter side at eye height (y=33), away from corners.
  for (const side of [0, 1, 2, 3] as const) {
    const a = int(13, 25);
    const b = int(38, 50);
    for (const t of [a, b]) {
      if (side === 0) layout.windows.push({ x: t, z: MANOR.minZ });
      else if (side === 1) layout.windows.push({ x: t, z: MANOR.maxZ });
      else if (side === 2) layout.windows.push({ x: MANOR.minX, z: t });
      else layout.windows.push({ x: MANOR.maxX, z: t });
    }
  }
  return layout;
}

/** The open central courtyard (10×10, x/z 27..36). */
function inCourtyard(x: number, z: number): boolean {
  return x >= 27 && x <= 36 && z >= 27 && z <= 36;
}

/** Full-height door gaps: the wall column is simply not emitted (see header). */
function isDoorGap(layout: ManorLayout, x: number, z: number): boolean {
  if (z === MANOR.maxZ && (x === 31 || x === 32)) return true; // south entrance gate
  if (x === layout.northSplitX && (z === layout.northDoorZ || z === layout.northDoorZ + 1)) return true;
  if (x === layout.southSplitX && (z === layout.southDoorZ || z === layout.southDoorZ + 1)) return true;
  if (layout.westSplit && z === layout.westSplitZ && (x === layout.westDoorX || x === layout.westDoorX + 1)) {
    return true;
  }
  if (layout.eastSplit && z === layout.eastSplitZ && (x === layout.eastDoorX || x === layout.eastDoorX + 1)) {
    return true;
  }
  if (z === 26 && (x === layout.ringNorthDoorX || x === layout.ringNorthDoorX + 1)) return true;
  if (z === 37 && (x === layout.ringSouthDoorX || x === layout.ringSouthDoorX + 1)) return true;
  if (x === 26 && (z === layout.ringWestDoorZ || z === layout.ringWestDoorZ + 1)) return true;
  if (x === 37 && (z === layout.ringEastDoorZ || z === layout.ringEastDoorZ + 1)) return true;
  return false;
}

/** Interior wall columns: the courtyard ring band + the room split walls. */
function isInteriorWall(layout: ManorLayout, x: number, z: number): boolean {
  if (inCourtyard(x, z)) return false;
  if (x >= 26 && x <= 37 && z >= 26 && z <= 37) return true; // courtyard ring band
  if (x === layout.northSplitX && z >= 9 && z <= 25) return true;
  if (x === layout.southSplitX && z >= 38 && z <= 54) return true;
  if (layout.westSplit && z === layout.westSplitZ && x >= 9 && x <= 25) return true;
  if (layout.eastSplit && z === layout.eastSplitZ && x >= 38 && x <= 54) return true;
  return false;
}

/**
 * The whole manor as an edit list (~3.7k tuples): one flat floor slab, the
 * perimeter walls (6 high, sparse windows), the interior walls (3 high) with
 * full-height 2-wide door gaps, and the porch outside the south gate.
 */
export function generateManorEdits(seed: number = MURDER_SEED): EditTuple[] {
  const layout = manorLayout(seed);
  const edits: EditTuple[] = [];
  const { minX, maxX, minZ, maxZ, floorY } = MANOR;
  const windowAt = (x: number, z: number): boolean =>
    layout.windows.some((w) => w.x === x && w.z === z);

  for (let x = minX; x <= maxX; x++) {
    for (let z = minZ; z <= maxZ; z++) {
      // Floor: cobble courtyard (and wall bases), plank room floors.
      const floorId = inCourtyard(x, z)
        ? COBBLE
        : isInteriorWall(layout, x, z)
          ? STONE
          : PLANKS;
      edits.push([x, floorY, z, floorId]);

      const perimeter = x === minX || x === maxX || z === minZ || z === maxZ;
      if (perimeter) {
        if (isDoorGap(layout, x, z)) continue; // full-height entrance gate
        for (let y = floorY + 1; y <= MANOR.wallTopY; y++) {
          edits.push([x, y, z, y === 33 && windowAt(x, z) ? GLASS : STONE]);
        }
      } else if (isInteriorWall(layout, x, z)) {
        if (isDoorGap(layout, x, z)) continue; // full-height doorway
        for (let y = floorY + 1; y <= MANOR.interiorWallTopY; y++) {
          edits.push([x, y, z, STONE]);
        }
      }
    }
  }

  // Porch outside the south gate (a step out the front door is not a ledge).
  for (let x = 30; x <= 33; x++) {
    for (let z = maxZ + 1; z <= maxZ + 3; z++) {
      edits.push([x, floorY, z, COBBLE]);
    }
  }
  return edits;
}

/**
 * The manor world for `seed`: every chunk exists but is pure air (void below,
 * no bedrock, no terrain — the party worldgen), with the manor applied as
 * edits. No-arg (the client's call in main.ts) is the canonical MURDER_SEED
 * manor — the fixed base every murder modeChanged overlay is built on.
 */
export function generateManorWorld(seed: number = MURDER_SEED): World {
  const world = new World();
  for (let cz = 0; cz < CHUNKS_Z; cz++) {
    for (let cx = 0; cx < CHUNKS_X; cx++) {
      world.chunks.set(world.chunkKey(cx, cz), new Uint8Array(CHUNK_VOLUME));
    }
  }
  world.applyEdits(generateManorEdits(seed));
  return world;
}

/**
 * The server's dealt match world for `seed` (the manor rotation, §3.6): the
 * canonical MURDER_SEED manor — the client's exact local base — with the
 * seeded layout applied on top. Building on the canonical base (rather than
 * an empty world) is what makes `serializeEdits()` a self-contained deal: the
 * base pass records every footprint/porch cell, the dealt pass overwrites the
 * differing ones, and the AIR pass clears the canonical blocks the dealt
 * layout does not have (setBlock skips no-op writes, so AIR records only
 * because the canonical base is solid there). The client's base + the
 * serialized overlay is exactly this world, whose content equals
 * `generateManorWorld(seed)`.
 */
export function generateManorMatchWorld(seed: number): World {
  const world = generateManorWorld(MURDER_SEED);
  const dealt = generateManorEdits(seed);
  const dealtCells = new Set<string>();
  for (const [x, y, z] of dealt) dealtCells.add(`${x},${y},${z}`);
  const clear: EditTuple[] = generateManorEdits(MURDER_SEED)
    .filter(([x, y, z]) => !dealtCells.has(`${x},${y},${z}`))
    .map(([x, y, z]): EditTuple => [x, y, z, AIR]);
  world.applyEdits(dealt); // same-value cells no-op (base already matches)
  world.applyEdits(clear); // disjoint cells — AIR lands on solid base blocks
  return world;
}
