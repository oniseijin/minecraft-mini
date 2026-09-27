/**
 * Face-culled chunk mesher with per-vertex ambient occlusion (0fps-style:
 * two side neighbours + corner neighbour per vertex, 4-level AO curve, and
 * the quad-diagonal flip that avoids interpolation artifacts).
 *
 * One chunk meshes into up to three BufferGeometries:
 *   opaque — terrain (grass/dirt/stone/sand/log/planks/cobble/snow/bedrock)
 *   cutout — alpha-tested foliage/glass (leaves, glass)
 *   water  — transparent liquid
 * Positions are in world coordinates; faces are emitted only when the
 * neighbour cell does not fully occlude them.
 */

import * as THREE from 'three';
import {
  AIR,
  BLOCKS,
  CHUNK,
  WORLD_SIZE_X,
  WORLD_SIZE_Y,
  WORLD_SIZE_Z,
  type World,
} from '@mc/shared';
import type { UVRect } from '../atlas';

export type TileUV = (tile: string) => UVRect;

export interface ChunkGeometries {
  opaque: THREE.BufferGeometry | null;
  cutout: THREE.BufferGeometry | null;
  water: THREE.BufferGeometry | null;
}

interface FaceDef {
  /** Neighbour offset. */
  dir: [number, number, number];
  /** 4 corner offsets, CCW seen from outside; triangles (0,1,2)+(0,2,3). */
  corners: [number, number, number][];
  tile: 'top' | 'side' | 'bottom';
  /** The two axes perpendicular to the face normal (for AO sampling). */
  axes: [number, number];
}

const FACES: FaceDef[] = [
  // +X
  { dir: [1, 0, 0], corners: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]], tile: 'side', axes: [1, 2] },
  // -X
  { dir: [-1, 0, 0], corners: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], tile: 'side', axes: [1, 2] },
  // +Y
  { dir: [0, 1, 0], corners: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]], tile: 'top', axes: [0, 2] },
  // -Y
  { dir: [0, -1, 0], corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], tile: 'bottom', axes: [0, 2] },
  // +Z
  { dir: [0, 0, 1], corners: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], tile: 'side', axes: [0, 1] },
  // -Z
  { dir: [0, 0, -1], corners: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]], tile: 'side', axes: [0, 1] },
];

/** Per-vertex (fu, fv) in tile space; matches the corner order above. */
const FACE_UVS: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];

/** AO level (0 = darkest corner) → brightness multiplier baked into vertex color. */
const AO_CURVE = [0.5, 0.7, 0.85, 1.0];

/** Water surface sits this much below the full block height. */
const WATER_DROP = 0.12;

class MeshBuilder {
  private positions: number[] = [];
  private normals: number[] = [];
  private uvs: number[] = [];
  private colors: number[] = [];
  private indices: number[] = [];
  private vertices = 0;

  addFace(
    x: number,
    y: number,
    z: number,
    face: FaceDef,
    rect: UVRect,
    ao: [number, number, number, number] | null,
    lowerTop: boolean,
  ): void {
    const base = this.vertices;
    for (let i = 0; i < 4; i++) {
      const c = face.corners[i];
      const drop = lowerTop && c[1] === 1 ? WATER_DROP : 0;
      this.positions.push(x + c[0], y + c[1] - drop, z + c[2]);
      this.normals.push(face.dir[0], face.dir[1], face.dir[2]);
      const [fu, fv] = FACE_UVS[i];
      this.uvs.push(rect.u0 + (rect.u1 - rect.u0) * fu, rect.v0 + (rect.v1 - rect.v0) * fv);
      const light = ao ? AO_CURVE[ao[i]] : 1;
      this.colors.push(light, light, light);
    }
    if (ao && ao[0] + ao[2] < ao[1] + ao[3]) {
      // Flip the quad diagonal toward the brighter pair so AO corners stay local.
      this.indices.push(base, base + 1, base + 3, base + 1, base + 2, base + 3);
    } else {
      this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    this.vertices += 4;
  }

  build(): THREE.BufferGeometry | null {
    if (this.indices.length === 0) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    geometry.setIndex(this.indices);
    return geometry;
  }
}

/** Meshes one 16×64×16 chunk of `world` into up to three geometries. */
export function buildChunkGeometries(
  world: World,
  cx: number,
  cz: number,
  uv: TileUV,
): ChunkGeometries {
  // 3×3 chunk neighbourhood so border faces + AO can read one block across.
  const nb: (Uint8Array | undefined)[] = [];
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      nb.push(world.chunks.get(world.chunkKey(cx + dx, cz + dz)));
    }
  }

  const at = (lx: number, y: number, lz: number): number => {
    if (y < 0 || y >= WORLD_SIZE_Y) return AIR;
    const cdx = lx < 0 ? 0 : lx > 15 ? 2 : 1;
    const cdz = lz < 0 ? 0 : lz > 15 ? 2 : 1;
    const chunk = nb[cdz * 3 + cdx];
    if (!chunk) return AIR;
    return chunk[(y * CHUNK + (lz & 15)) * CHUNK + (lx & 15)];
  };

  const bx = cx * CHUNK;
  const bz = cz * CHUNK;

  // AO occluder: opaque blocks only; the void outside the world never occludes.
  const occludes = (lx: number, y: number, lz: number): boolean => {
    if (y < 0 || y >= WORLD_SIZE_Y) return false;
    if (bx + lx < 0 || bx + lx >= WORLD_SIZE_X || bz + lz < 0 || bz + lz >= WORLD_SIZE_Z) {
      return false;
    }
    return BLOCKS[at(lx, y, lz)].opaque;
  };

  const aoForFace = (
    lx: number,
    y: number,
    lz: number,
    face: FaceDef,
  ): [number, number, number, number] => {
    const px = lx + face.dir[0];
    const py = y + face.dir[1];
    const pz = lz + face.dir[2];
    const [a1, a2] = face.axes;
    const result: [number, number, number, number] = [3, 3, 3, 3];
    for (let i = 0; i < 4; i++) {
      const c = face.corners[i];
      const o1 = c[a1] === 1 ? 1 : -1;
      const o2 = c[a2] === 1 ? 1 : -1;
      const d1x = a1 === 0 ? o1 : 0;
      const d1y = a1 === 1 ? o1 : 0;
      const d1z = a1 === 2 ? o1 : 0;
      const d2x = a2 === 0 ? o2 : 0;
      const d2y = a2 === 1 ? o2 : 0;
      const d2z = a2 === 2 ? o2 : 0;
      const s1 = occludes(px + d1x, py + d1y, pz + d1z);
      const s2 = occludes(px + d2x, py + d2y, pz + d2z);
      const corner = occludes(px + d1x + d2x, py + d1y + d2y, pz + d1z + d2z);
      result[i] = s1 && s2 ? 0 : 3 - (s1 ? 1 : 0) - (s2 ? 1 : 0) - (corner ? 1 : 0);
    }
    return result;
  };

  const opaque = new MeshBuilder();
  const cutout = new MeshBuilder();
  const water = new MeshBuilder();

  const uvCache = new Map<string, UVRect>();
  const uvFor = (tile: string): UVRect => {
    let rect = uvCache.get(tile);
    if (!rect) {
      rect = uv(tile);
      uvCache.set(tile, rect);
    }
    return rect;
  };

  for (let y = 0; y < WORLD_SIZE_Y; y++) {
    for (let lz = 0; lz < CHUNK; lz++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        const id = at(lx, y, lz);
        if (id === AIR) continue;
        const def = BLOCKS[id];
        const isWater = def.liquid === true;
        const builder = isWater ? water : def.opaque ? opaque : cutout;
        const wx = bx + lx;
        const wz = bz + lz;
        const lowerTop = isWater && at(lx, y + 1, lz) !== id;

        for (const face of FACES) {
          const ny = y + face.dir[1];
          const nwx = wx + face.dir[0];
          const nwz = wz + face.dir[2];
          // Never emit faces against the void outside the world.
          if (
            ny < 0 ||
            ny >= WORLD_SIZE_Y ||
            nwx < 0 ||
            nwx >= WORLD_SIZE_X ||
            nwz < 0 ||
            nwz >= WORLD_SIZE_Z
          ) {
            continue;
          }
          const nId = at(lx + face.dir[0], ny, lz + face.dir[2]);
          let show: boolean;
          if (isWater) show = nId === AIR; // water renders only against air
          else if (def.opaque) show = !BLOCKS[nId].opaque;
          else show = nId !== id; // cutout: against everything except same-block
          if (!show) continue;

          const rect = uvFor(def.tiles[face.tile]);
          const ao = isWater ? null : aoForFace(lx, y, lz, face);
          builder.addFace(wx, y, wz, face, rect, ao, lowerTop);
        }
      }
    }
  }

  return { opaque: opaque.build(), cutout: cutout.build(), water: water.build() };
}
