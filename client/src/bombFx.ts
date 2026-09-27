/**
 * Block Party auto color bomb FX (protocol v5) — the client half of the
 * server-driven bomb (DESIGN.md §3.4.1). While the fuse runs, one small
 * unlit dark sphere pulses at the bomb cell and a single THREE.Points cloud
 * of sparks rises/orbits around it in the announced color; beeps accelerate
 * as the fuse runs down. At detonation the sphere pops into one short-lived
 * burst cloud (the paint itself arrives as normal blockEdits).
 *
 * iGPU budget: everything is hidden while no bomb is fused; during a fuse the
 * whole effect is 3 draw calls (sphere + sparks + any burst) and ~50 points,
 * all short-lived — no textures, no lights, no shadows.
 */

import * as THREE from 'three';
import { PARTY_FLOOR } from '@mc/shared';

export interface BombFxOptions {
  /** Fuse tick; urgency 0..1 rises as detonation approaches. */
  onFuseTick(urgency: number): void;
}

export interface BombFx {
  /** Shows the pulsing bomb + fuse sparks at a floor cell. */
  showBomb(cell: [number, number], tint: [number, number, number], detonatesAt: number): void;
  /** Hides the fused bomb (fizzle / state went away). */
  hideBomb(): void;
  /** Detonation: hide the sphere, fire the burst at the cell. */
  detonate(cell: [number, number], tint: [number, number, number]): void;
  /** True while a fused bomb is on display (used for gameState re-syncs). */
  readonly showing: boolean;
  /** Per-frame animation; `nowMs` = rAF timestamp, `dt` seconds. */
  update(nowMs: number, dt: number): void;
  /** Hides everything (mode swap / fresh match) without disposing. */
  reset(): void;
  dispose(): void;
}

/** Fuse geometry: the sphere sits on top of the floor's block layer. */
const BOMB_RADIUS = 0.3;
const SPARK_COUNT = 10;
const BURST_COUNT = 36;
const BURST_MS = 700;
/** Fuse beep cadence: relaxed early, urgent late. */
const TICK_MS_LATE = 140;
const TICK_MS_EARLY = 300;

/** World center of a bomb cell, slightly above the floor surface. */
function bombCenter(cell: [number, number]): THREE.Vector3 {
  return new THREE.Vector3(cell[0] + 0.5, PARTY_FLOOR.y + 1 + BOMB_RADIUS + 0.04, cell[1] + 0.5);
}

const toColor = (tint: [number, number, number]): THREE.Color => new THREE.Color(tint[0], tint[1], tint[2]);

export function createBombFx(scene: THREE.Scene, options: BombFxOptions): BombFx {
  // --- fused bomb: sphere + spark cloud -------------------------------------
  const bombGroup = new THREE.Group();
  bombGroup.visible = false;
  scene.add(bombGroup);

  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(BOMB_RADIUS, 12, 10),
    new THREE.MeshBasicMaterial({ color: 0x1d1626 }), // dark, reads on any wool
  );
  bombGroup.add(sphere);

  const sparkGeometry = new THREE.BufferGeometry();
  sparkGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SPARK_COUNT * 3), 3));
  const sparkMaterial = new THREE.PointsMaterial({
    size: 0.13,
    color: 0xffffff,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
  });
  const sparks = new THREE.Points(sparkGeometry, sparkMaterial);
  bombGroup.add(sparks);

  // --- detonation burst: one pooled points cloud ------------------------------
  const burstGeometry = new THREE.BufferGeometry();
  const burstPositions = new Float32Array(BURST_COUNT * 3);
  burstGeometry.setAttribute('position', new THREE.BufferAttribute(burstPositions, 3));
  const burstMaterial = new THREE.PointsMaterial({
    size: 0.16,
    color: 0xffffff,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  const burst = new THREE.Points(burstGeometry, burstMaterial);
  burst.visible = false;
  scene.add(burst);

  const burstVelocities: THREE.Vector3[] = [];
  let burstStartedAt = 0;

  let center = new THREE.Vector3();
  let detonatesAt = 0;
  let fuseTotalMs = 1;
  let lastTickAt = 0;
  let showing = false;

  function armBurst(at: THREE.Vector3, tint: [number, number, number]): void {
    for (let i = 0; i < BURST_COUNT; i++) {
      burstPositions[i * 3] = at.x;
      burstPositions[i * 3 + 1] = at.y;
      burstPositions[i * 3 + 2] = at.z;
      // Spherical-ish spray, biased upward (a paint pop, not a grenade).
      const theta = Math.random() * Math.PI * 2;
      const speed = 2.2 + Math.random() * 2.4;
      burstVelocities[i] = new THREE.Vector3(
        Math.cos(theta) * speed * 0.8,
        2.5 + Math.random() * 3.2,
        Math.sin(theta) * speed * 0.8,
      );
    }
    burstGeometry.attributes.position.needsUpdate = true;
    burstMaterial.color.copy(toColor(tint));
    burstMaterial.opacity = 1;
    burst.visible = true;
    burstStartedAt = performance.now();
  }

  return {
    get showing() {
      return showing;
    },
    showBomb(cell, tint, detonatesAtNext) {
      center = bombCenter(cell);
      detonatesAt = detonatesAtNext;
      fuseTotalMs = Math.max(1, detonatesAt - Date.now());
      bombGroup.position.copy(center);
      sparkMaterial.color.copy(toColor(tint));
      bombGroup.visible = true;
      showing = true;
      lastTickAt = 0;
    },
    hideBomb() {
      bombGroup.visible = false;
      showing = false;
    },
    detonate(cell, tint) {
      bombGroup.visible = false;
      showing = false;
      armBurst(bombCenter(cell), tint);
    },
    update(nowMs) {
      // Burst: simple ballistic spray with a fade, then gone.
      if (burst.visible) {
        const age = performance.now() - burstStartedAt;
        if (age >= BURST_MS) {
          burst.visible = false;
        } else {
          const t = age / 1000;
          for (let i = 0; i < BURST_COUNT; i++) {
            const v = burstVelocities[i];
            burstPositions[i * 3] += v.x * t * (1 / 60);
            burstPositions[i * 3 + 1] += v.y * t * (1 / 60) - 4.5 * t * t * (1 / 60);
            burstPositions[i * 3 + 2] += v.z * t * (1 / 60);
          }
          burstGeometry.attributes.position.needsUpdate = true;
          burstMaterial.opacity = 1 - age / BURST_MS;
        }
      }

      if (!showing) return;

      // Pulse: quick breathing on the dark sphere.
      const pulse = 1 + 0.18 * Math.sin(nowMs / 95);
      sphere.scale.setScalar(pulse);

      // Sparks: rise and wrap around the sphere in the announced color.
      const attr = sparkGeometry.attributes.position as THREE.BufferAttribute;
      const arr = attr.array as Float32Array;
      const now = nowMs / 1000;
      for (let i = 0; i < SPARK_COUNT; i++) {
        const phase = (i / SPARK_COUNT) * Math.PI * 2;
        const rise = ((now * 0.9 + i / SPARK_COUNT) % 1) * 1.1; // 0..1.1 up
        const wobble = Math.sin(now * 3 + phase) * 0.08;
        arr[i * 3] = Math.cos(phase + now * 1.6) * (0.34 + wobble);
        arr[i * 3 + 1] = BOMB_RADIUS + 0.05 + rise;
        arr[i * 3 + 2] = Math.sin(phase + now * 1.6) * (0.34 + wobble);
      }
      attr.needsUpdate = true;

      // Accelerating fuse ticks (local clock interpolation of detonatesAt).
      const remaining = detonatesAt - Date.now();
      const urgency = Math.max(0, Math.min(1, 1 - remaining / fuseTotalMs));
      const interval = urgency > 0.5 ? TICK_MS_LATE : TICK_MS_EARLY;
      if (lastTickAt !== 0 && nowMs - lastTickAt >= interval && remaining > 0) {
        options.onFuseTick(urgency);
        lastTickAt = nowMs;
      } else if (lastTickAt === 0) {
        lastTickAt = nowMs;
      }
    },
    reset() {
      bombGroup.visible = false;
      burst.visible = false;
      showing = false;
    },
    dispose() {
      this.reset();
      scene.remove(bombGroup);
      scene.remove(burst);
      sphere.geometry.dispose();
      (sphere.material as THREE.Material).dispose();
      sparkGeometry.dispose();
      sparkMaterial.dispose();
      burstGeometry.dispose();
      burstMaterial.dispose();
    },
  };
}
