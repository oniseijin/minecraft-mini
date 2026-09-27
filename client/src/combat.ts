/**
 * BedWars melee targeting: segment-vs-AABB slab test against remote player
 * bounding boxes. The attack path (same one the left-click uses) picks the
 * NEAREST avatar along the view ray within reach and before any block the
 * voxel raycast hit — mirroring Minecraft's "entity hit only when visible".
 */

import type { Vec3 } from '@mc/shared';

export interface Aabb {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

/** Player AABB dimensions (must cover the avatar rig: 1.8 tall, 0.6 wide). */
export const TARGET_HALF_WIDTH = 0.35;
export const TARGET_HEIGHT = 1.85;

/**
 * Entry distance of the ray `origin + t·dir` into `box`, or null when the ray
 * misses (or the box starts beyond `maxDist`). dir need not be normalized —
 * `maxDist` is in world units and the returned t matches it.
 */
export function rayVsAabb(origin: Vec3, dir: Vec3, box: Aabb, maxDist: number): number | null {
  let tMin = 0;
  let tMax = maxDist;
  const test = (o: number, d: number, lo: number, hi: number): boolean => {
    if (Math.abs(d) < 1e-9) return o >= lo && o <= hi;
    const inv = 1 / d;
    let t1 = (lo - o) * inv;
    let t2 = (hi - o) * inv;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    return tMin <= tMax;
  };
  if (!test(origin.x, dir.x, box.minX, box.maxX)) return null;
  if (!test(origin.y, dir.y, box.minY, box.maxY)) return null;
  if (!test(origin.z, dir.z, box.minZ, box.maxZ)) return null;
  return tMin;
}
