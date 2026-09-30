/**
 * Murder Mystery scene FX (M7.3, DESIGN.md §3.6) — the small 3D props that
 * ride alongside the guest avatars, following the partyPowerups / bombFx
 * patterns (pooled meshes, one shared geometry + material pool, the server
 * owns every rule — this module only renders):
 *
 * - Floor coins: the gameState mirror's `coinItems` rendered as small spinning
 *   cubes (the party mystery-box precedent), tinted by tier — gold #ffd24a,
 *   epic #4aa3ff, super #b76aff. They appear/disappear purely from snapshots
 *   (pickup stays server-side proximity; no event drives them). Cap 14 = the
 *   server's COIN_CAP, one shared BoxGeometry + one material per tier.
 * - Gravestones: a small dark cross spawned per guestKilled event (1 merged
 *   mesh each, shared geometry/material — cheap), deduped by "x,z".
 * - Zapper beam: one pooled white flash column (the party zap-beam precedent)
 *   flashed at the zapped guest's last known spot.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { MurderCoinTier } from '@mc/shared';
import type { MurderCoinView } from './murderState';

/** The server caps live floor coins at 14 (murder.ts COIN_CAP) — pool size. */
const COIN_POOL = 14;
const COIN_SIZE = 0.3;
const COIN_HOVER = 0.4; // above the reported stand height
const COIN_SPIN = 1.9; // rad/s
const COIN_BOB = 0.06;
const COIN_BOB_RATE = 2.6; // rad/s
const BEAM_MS = 320;

/** Coin tier tints (§3.6): gold 1 / epic blue 3 / super purple 6. */
const TIER_HEX: Record<MurderCoinTier, number> = {
  gold: 0xffd24a,
  epic: 0x4aa3ff,
  super: 0xb76aff,
};

export interface MurderFx {
  /** Mirrors the snapshot's live coin list (appears/disappears from it). */
  syncCoins(coins: readonly MurderCoinView[]): void;
  /** Adds a gravestone marker (deduped per "x,z"); (x, z) are floored cells. */
  addGravestone(x: number, y: number, z: number): void;
  /** Beam flash at a zapped guest's last known position. */
  zapFx(at: { x: number; y: number; z: number }): void;
  /** Per-frame: coin spin/bob + beam fade. */
  update(nowMs: number, dt: number): void;
  /** Hides everything (mode swap / fresh match) without disposing. */
  clear(): void;
  dispose(): void;
}

/** Merges the two slabs of a little cross (1 draw call per gravestone). */
function gravestoneGeometry(): THREE.BufferGeometry {
  const slab = (w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry => {
    const geometry = new THREE.BoxGeometry(w, h, d);
    geometry.translate(x, y, z);
    return geometry;
  };
  // Vertical headstone + a low plinth, origin at the floor.
  return mergeGeometries([
    slab(0.5, 0.85, 0.16, 0, 0.42, 0),
    slab(0.62, 0.14, 0.26, 0, 0.07, 0),
  ])!;
}

export function createMurderFx(scene: THREE.Scene): MurderFx {
  // --- floor coins (pooled spinning cubes, party mystery-box precedent) ---------
  const coinGeometry = new THREE.BoxGeometry(COIN_SIZE, COIN_SIZE, COIN_SIZE);
  const tierMaterials = new Map<MurderCoinTier, THREE.MeshBasicMaterial>();
  for (const tier of Object.keys(TIER_HEX) as MurderCoinTier[]) {
    tierMaterials.set(tier, new THREE.MeshBasicMaterial({ color: TIER_HEX[tier] }));
  }
  const coinMeshes: THREE.Mesh[] = [];
  /** Resting hover height per pooled coin (the bob swings around it). */
  const coinBaseY: number[] = [];
  for (let i = 0; i < COIN_POOL; i++) {
    const mesh = new THREE.Mesh(coinGeometry, tierMaterials.get('gold')!);
    mesh.visible = false;
    scene.add(mesh);
    coinMeshes.push(mesh);
    coinBaseY.push(0);
  }

  // --- gravestones (one merged cross each; shared geometry + material) ----------
  const stoneGeometry = gravestoneGeometry();
  const stoneMaterial = new THREE.MeshLambertMaterial({ color: 0x4a4a52 });
  const stones = new Map<string, THREE.Mesh>();

  // --- zapper beam (one pooled flash, partyPowerups precedent) -------------------
  const beam = new THREE.Mesh(
    new THREE.BoxGeometry(0.22, 7, 0.22),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }),
  );
  beam.visible = false;
  scene.add(beam);
  let beamStartedAt = 0;

  return {
    syncCoins(coins) {
      for (const mesh of coinMeshes) mesh.visible = false;
      coins.slice(0, COIN_POOL).forEach((coin, i) => {
        const mesh = coinMeshes[i];
        coinBaseY[i] = coin.y + COIN_HOVER;
        mesh.position.set(coin.x, coinBaseY[i], coin.z);
        mesh.material = tierMaterials.get(coin.tier) ?? tierMaterials.get('gold')!;
        mesh.visible = true;
      });
    },
    addGravestone(x, y, z) {
      const key = `${x},${z}`;
      if (stones.has(key)) return;
      const mesh = new THREE.Mesh(stoneGeometry, stoneMaterial);
      mesh.position.set(x + 0.5, y, z + 0.5); // cell center, base on the floor
      scene.add(mesh);
      stones.set(key, mesh);
    },
    zapFx(at) {
      beam.position.set(at.x, at.y + 3.5, at.z); // 7-tall column covers the body
      (beam.material as THREE.MeshBasicMaterial).opacity = 1;
      beam.visible = true;
      beamStartedAt = performance.now();
    },
    update(nowMs) {
      // Coins: spin + a little bob so they read as "walk into me".
      for (let i = 0; i < coinMeshes.length; i++) {
        const mesh = coinMeshes[i];
        if (!mesh.visible) continue;
        mesh.rotation.y = (nowMs / 1000) * COIN_SPIN + i * 1.1;
        mesh.position.y = coinBaseY[i] + Math.sin((nowMs / 1000) * COIN_BOB_RATE + i * 2.1) * COIN_BOB;
      }
      // Beam flash: quick fade then hide.
      if (beam.visible) {
        const age = performance.now() - beamStartedAt;
        if (age >= BEAM_MS) {
          beam.visible = false;
        } else {
          (beam.material as THREE.MeshBasicMaterial).opacity = 1 - age / BEAM_MS;
        }
      }
    },
    clear() {
      for (const mesh of coinMeshes) mesh.visible = false;
      for (const mesh of stones.values()) scene.remove(mesh);
      stones.clear();
      beam.visible = false;
    },
    dispose() {
      this.clear();
      for (const mesh of coinMeshes) scene.remove(mesh);
      for (const material of tierMaterials.values()) material.dispose();
      coinGeometry.dispose();
      stoneGeometry.dispose();
      stoneMaterial.dispose();
      scene.remove(beam);
      beam.geometry.dispose();
      (beam.material as THREE.Material).dispose();
    },
  };
}
