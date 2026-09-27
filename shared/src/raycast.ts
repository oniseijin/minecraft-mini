/**
 * Amanatides–Woo voxel DDA raycast — walks the grid cell by cell and returns
 * the first solid cell hit together with the entry face normal.
 * Skips non-solid cells (air + liquids); leaves and glass are hit.
 */

import { AIR, BLOCKS } from './blocks';
import type { World } from './world';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface RayHit {
  /** Voxel that was hit. */
  x: number;
  y: number;
  z: number;
  /** Face normal, pointing out of the hit block (toward the ray origin). */
  nx: number;
  ny: number;
  nz: number;
  /** Distance from the ray origin to the entry face, in world units. */
  dist: number;
}

export function isSolidId(id: number): boolean {
  return id !== AIR && !BLOCKS[id].liquid;
}

/**
 * Traces `origin` along `dir` (need not be normalized; `maxDist` is in world
 * units) through the voxel grid. Returns `null` if nothing solid is within
 * `maxDist`. If the origin itself is inside a solid cell, returns it with a
 * zero normal and dist 0.
 */
export function raycast(world: World, origin: Vec3, dir: Vec3, maxDist: number): RayHit | null {
  if (dir.x === 0 && dir.y === 0 && dir.z === 0) return null;

  let x = Math.floor(origin.x);
  let y = Math.floor(origin.y);
  let z = Math.floor(origin.z);
  if (isSolidId(world.getBlock(x, y, z))) {
    return { x, y, z, nx: 0, ny: 0, nz: 0, dist: 0 };
  }

  const stepX = Math.sign(dir.x);
  const stepY = Math.sign(dir.y);
  const stepZ = Math.sign(dir.z);
  const tDeltaX = stepX !== 0 ? Math.abs(1 / dir.x) : Infinity;
  const tDeltaY = stepY !== 0 ? Math.abs(1 / dir.y) : Infinity;
  const tDeltaZ = stepZ !== 0 ? Math.abs(1 / dir.z) : Infinity;
  let tMaxX = stepX !== 0 ? (stepX > 0 ? x + 1 - origin.x : origin.x - x) * tDeltaX : Infinity;
  let tMaxY = stepY !== 0 ? (stepY > 0 ? y + 1 - origin.y : origin.y - y) * tDeltaY : Infinity;
  let tMaxZ = stepZ !== 0 ? (stepZ > 0 ? z + 1 - origin.z : origin.z - z) * tDeltaZ : Infinity;

  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < 256; i++) {
    let t: number;
    if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
      x += stepX;
      t = tMaxX;
      tMaxX += tDeltaX;
      nx = -stepX;
      ny = 0;
      nz = 0;
    } else if (tMaxY <= tMaxZ) {
      y += stepY;
      t = tMaxY;
      tMaxY += tDeltaY;
      nx = 0;
      ny = -stepY;
      nz = 0;
    } else {
      z += stepZ;
      t = tMaxZ;
      tMaxZ += tDeltaZ;
      nx = 0;
      ny = 0;
      nz = -stepZ;
    }
    if (t > maxDist) return null;
    if (isSolidId(world.getBlock(x, y, z))) {
      return { x, y, z, nx, ny, nz, dist: t };
    }
  }
  return null;
}
