/**
 * Chunk mesh manager: one THREE.Group per chunk (up to 3 meshes: opaque,
 * cutout, water), a dirty-chunk remesh queue processed with a per-frame
 * time budget, and camera-distance visibility (chunks outside the render
 * distance are removed from the scene but keep their meshes).
 */

import * as THREE from 'three';
import { CHUNK, CHUNKS_X, CHUNKS_Z, type World } from '@mc/shared';
import type { Atlas } from '../atlas';
import { buildChunkGeometries } from './mesher';

/** Render distance in chunks (DESIGN.md §1 perf budget). */
export const RENDER_DISTANCE = 4;

/** Chunk-center radii for scene membership; the +8/+16 margin over 64 hides most pop-in in fog. */
const ADD_RADIUS = RENDER_DISTANCE * CHUNK + 8; // 72
const DROP_RADIUS = ADD_RADIUS + 16; // 88, hysteresis so edge chunks don't flicker

interface ChunkEntry {
  group: THREE.Group;
  cx: number;
  cz: number;
  inScene: boolean;
}

export interface WorldRenderer {
  readonly world: World;
  /** Queue every chunk for meshing (initial load). */
  enqueueAllChunks(): void;
  /** Sets a block through World.setBlock and queues affected chunks for remesh. */
  applyEdit(x: number, y: number, z: number, id: number): void;
  /** Remesh dirty chunks within a time budget (ms); always finishes at least one. */
  processQueue(budgetMs: number): void;
  /** Toggles chunk groups in/out of the scene based on camera distance. */
  update(camera: THREE.PerspectiveCamera): void;
  readonly pendingCount: number;
  readonly loadedCount: number;
  readonly visibleCount: number;
  dispose(): void;
}

export function createWorldRenderer(scene: THREE.Scene, world: World, atlas: Atlas): WorldRenderer {
  const groups = new Map<string, ChunkEntry>();
  const dirty = new Set<string>();
  let visibleCount = 0;

  const opaqueMat = new THREE.MeshLambertMaterial({ map: atlas.texture, vertexColors: true });
  const cutoutMat = new THREE.MeshLambertMaterial({
    map: atlas.texture,
    vertexColors: true,
    alphaTest: 0.5,
  });
  const waterMat = new THREE.MeshLambertMaterial({
    map: atlas.texture,
    vertexColors: true,
    transparent: true,
    opacity: 0.8,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  function remesh(cx: number, cz: number): void {
    const key = world.chunkKey(cx, cz);
    let entry = groups.get(key);
    if (!entry) {
      const group = new THREE.Group();
      group.matrixAutoUpdate = false;
      entry = { group, cx, cz, inScene: false };
      groups.set(key, entry);
    }
    for (const child of entry.group.children) {
      (child as THREE.Mesh).geometry.dispose(); // no leaks across remeshes
    }
    entry.group.clear();

    const geos = buildChunkGeometries(world, cx, cz, atlas.uv);
    if (geos.opaque) entry.group.add(new THREE.Mesh(geos.opaque, opaqueMat));
    if (geos.cutout) entry.group.add(new THREE.Mesh(geos.cutout, cutoutMat));
    if (geos.water) entry.group.add(new THREE.Mesh(geos.water, waterMat));
  }

  return {
    world,
    enqueueAllChunks() {
      for (let cz = 0; cz < CHUNKS_Z; cz++) {
        for (let cx = 0; cx < CHUNKS_X; cx++) {
          dirty.add(world.chunkKey(cx, cz));
        }
      }
    },
    applyEdit(x: number, y: number, z: number, id: number) {
      for (const key of world.setBlock(x, y, z, id)) dirty.add(key);
    },
    processQueue(budgetMs: number) {
      const start = performance.now();
      for (const key of dirty) {
        const comma = key.indexOf(',');
        remesh(Number(key.slice(0, comma)), Number(key.slice(comma + 1)));
        dirty.delete(key);
        if (performance.now() - start >= budgetMs) break;
      }
    },
    update(camera) {
      const camX = camera.position.x;
      const camZ = camera.position.z;
      const addR2 = ADD_RADIUS * ADD_RADIUS;
      const dropR2 = DROP_RADIUS * DROP_RADIUS;
      let visible = 0;
      for (const entry of groups.values()) {
        const dx = entry.cx * CHUNK + CHUNK / 2 - camX;
        const dz = entry.cz * CHUNK + CHUNK / 2 - camZ;
        const d2 = dx * dx + dz * dz;
        if (!entry.inScene && d2 <= addR2) {
          scene.add(entry.group);
          entry.inScene = true;
        } else if (entry.inScene && d2 > dropR2) {
          scene.remove(entry.group);
          entry.inScene = false;
        }
        if (entry.inScene) visible++;
      }
      visibleCount = visible;
    },
    get pendingCount() {
      return dirty.size;
    },
    get loadedCount() {
      return groups.size;
    },
    get visibleCount() {
      return visibleCount;
    },
    dispose() {
      for (const entry of groups.values()) {
        for (const child of entry.group.children) {
          (child as THREE.Mesh).geometry.dispose();
        }
        if (entry.inScene) scene.remove(entry.group);
      }
      groups.clear();
      dirty.clear();
      opaqueMat.dispose();
      cutoutMat.dispose();
      waterMat.dispose();
    },
  };
}
