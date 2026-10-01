/**
 * BedWars scene FX (M6.1+M6.2, DESIGN.md §3.3) — the pooled 3D props that ride
 * alongside the match, following the murderFx / partyPowerups patterns (one
 * shared geometry + material pool; the server owns every rule — this module
 * only renders):
 *
 * - In-flight arrows: one stretched box per `arrowLaunched` event, flying the
 *   EXACT ballistic path the server hit-tests — the shared parabola
 *   arrowPosition(from, dir, power, t) with the shared GRAVITY — so client and
 *   server agree by construction. Each frame the local block raycast along the
 *   flown segment removes the arrow on terrain impact (worlds are in sync);
 *   a matching `hit` event (removeArrow), the void plane or a timeout also
 *   remove it. Pooled, one shared BoxGeometry + material.
 * - Damage numbers: one canvas-texture sprite per `hit` event above the
 *   victim (red when it's ME, white otherwise), rising + fading ~700 ms.
 *   Pooled canvas sprites, redrawn per use.
 */

import * as THREE from 'three';
import { GRAVITY, VOID_KILL_Y, arrowPosition, raycast, type World } from '@mc/shared';

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** The `arrowLaunched` payload shape (structural — keeps bw.ts imports light). */
export interface ArrowShotView {
  by: number;
  from: Vec3Like;
  dir: Vec3Like;
  power: number;
}

export interface BwFx {
  /** Spawns a pooled arrow on the shared ballistic parabola. */
  spawnArrow(shot: ArrowShotView): void;
  /** Spends the oldest in-flight arrow owned by `ownerId` (a `hit` landed). */
  removeArrow(ownerId: number): void;
  /** Floating damage number above `at` (mine = it's ME hurting → red). */
  damageNumber(at: Vec3Like, value: number, mine: boolean): void;
  /** Per-frame: arrow flight + number rise/fade. */
  update(nowMs: number, dt: number): void;
  /** Hides everything (mode swap / fresh match) without disposing. */
  clear(): void;
  dispose(): void;
  /** Telemetry for the __mc test surface. */
  readonly liveArrows: number;
  readonly arrowsSeen: number;
}

const ARROW_POOL = 8;
const ARROW_LIFETIME_S = 6;
const ARROW_LENGTH = 0.55;
const NUMBER_POOL = 12;
const NUMBER_LIFETIME_MS = 700;
const NUMBER_RISE = 0.9; // world units over the lifetime
const NUMBER_ABOVE = 2.3; // above the victim's feet

/** Canvas sprite text: white for dealt damage, red for taken (§3.3 M6.2). */
const NUMBER_MINE_COLOR = '#ff5a5a';
const NUMBER_COLOR = '#ffffff';

interface Flight {
  mesh: THREE.Mesh;
  ownerId: number;
  from: Vec3Like;
  dir: Vec3Like;
  power: number;
  startMs: number;
  /** Last rendered sample (the per-frame block raycast runs prev → current). */
  prev: THREE.Vector3;
}

interface DamageNumber {
  sprite: THREE.Sprite;
  canvas: HTMLCanvasElement;
  ctx2d: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  active: boolean;
  startMs: number;
  base: THREE.Vector3;
}

export function createBwFx(scene: THREE.Scene, opts: { getWorld(): World | null }): BwFx {
  // --- arrows (pooled stretched boxes, one shared geometry + material) --------
  const arrowGeometry = new THREE.BoxGeometry(0.05, 0.05, ARROW_LENGTH);
  const arrowMaterial = new THREE.MeshLambertMaterial({ color: 0x9a7040 });
  const arrowMeshes: THREE.Mesh[] = [];
  for (let i = 0; i < ARROW_POOL; i++) {
    const mesh = new THREE.Mesh(arrowGeometry, arrowMaterial);
    mesh.visible = false;
    scene.add(mesh);
    arrowMeshes.push(mesh);
  }
  const flights: Flight[] = []; // oldest first
  let arrowsSeen = 0;

  function despawn(flight: Flight): void {
    flight.mesh.visible = false;
    const i = flights.indexOf(flight);
    if (i >= 0) flights.splice(i, 1);
  }

  function spawnArrow(shot: ArrowShotView): void {
    arrowsSeen++;
    // Pool exhausted → recycle the oldest (arrows are short-lived).
    if (flights.length >= ARROW_POOL) despawn(flights[0]);
    const mesh = arrowMeshes.find((m) => !m.visible);
    if (!mesh) return; // unreachable with the despawn above; keeps TS honest
    mesh.visible = true;
    const dirVec = new THREE.Vector3(shot.dir.x, shot.dir.y, shot.dir.z).normalize();
    // BoxGeometry stretched along Z + quaternion from +Z onto the flight dir.
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dirVec);
    const start = arrowPosition(shot.from, shot.dir, shot.power, 0);
    mesh.position.set(start.x, start.y, start.z);
    flights.push({
      mesh,
      ownerId: shot.by,
      from: { ...shot.from },
      dir: { ...shot.dir },
      power: shot.power,
      startMs: performance.now(),
      prev: new THREE.Vector3(start.x, start.y, start.z),
    });
  }

  function removeArrow(ownerId: number): void {
    const flight = flights.find((f) => f.ownerId === ownerId);
    if (flight) despawn(flight);
  }

  // --- damage numbers (pooled canvas sprites) ----------------------------------
  const numbers: DamageNumber[] = [];
  for (let i = 0; i < NUMBER_POOL; i++) {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 64;
    const ctx2d = canvas.getContext('2d');
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      }),
    );
    sprite.scale.set(1.5, 0.75, 1);
    sprite.renderOrder = 950; // over the world, under the nameplates (999)
    sprite.visible = false;
    scene.add(sprite);
    numbers.push({
      sprite,
      canvas,
      ctx2d: ctx2d as CanvasRenderingContext2D,
      texture,
      active: false,
      startMs: 0,
      base: new THREE.Vector3(),
    });
  }

  function damageNumber(at: Vec3Like, value: number, mine: boolean): void {
    const entry = numbers.find((n) => !n.active) ?? numbers[0]; // steal the oldest
    const ctx2d = entry.ctx2d;
    if (!ctx2d) return;
    ctx2d.clearRect(0, 0, entry.canvas.width, entry.canvas.height);
    ctx2d.font = 'bold 46px system-ui, sans-serif';
    ctx2d.textAlign = 'center';
    ctx2d.textBaseline = 'middle';
    ctx2d.lineWidth = 8;
    ctx2d.strokeStyle = 'rgba(0, 0, 0, 0.85)';
    ctx2d.strokeText(String(value), 64, 34);
    ctx2d.fillStyle = mine ? NUMBER_MINE_COLOR : NUMBER_COLOR;
    ctx2d.fillText(String(value), 64, 34);
    entry.texture.needsUpdate = true;
    entry.base.set(
      at.x + (Math.random() - 0.5) * 0.4,
      at.y + NUMBER_ABOVE,
      at.z + (Math.random() - 0.5) * 0.4,
    );
    entry.sprite.position.copy(entry.base);
    entry.sprite.visible = true;
    entry.active = true;
    entry.startMs = performance.now();
  }

  // --- per-frame ----------------------------------------------------------------

  function update(nowMs: number, _dt: number): void {
    const world = opts.getWorld();
    for (const flight of [...flights]) {
      const t = (nowMs - flight.startMs) / 1000;
      if (t > ARROW_LIFETIME_S) {
        despawn(flight);
        continue;
      }
      const pos = arrowPosition(flight.from, flight.dir, flight.power, t);
      const next = new THREE.Vector3(pos.x, pos.y, pos.z);
      // Terrain impact along the flown segment (the server runs the same
      // raycast on its own tick — worlds are in sync).
      const delta = next.clone().sub(flight.prev);
      if (world && delta.lengthSq() > 1e-9 && raycast(world, flight.prev, delta, 1) !== null) {
        despawn(flight);
        continue;
      }
      if (next.y < VOID_KILL_Y) {
        despawn(flight);
        continue;
      }
      // Orient along the instantaneous velocity (dir·power − GRAVITY·t·ŷ).
      const vel = new THREE.Vector3(
        flight.dir.x * flight.power,
        flight.dir.y * flight.power - GRAVITY * t,
        flight.dir.z * flight.power,
      );
      if (vel.lengthSq() > 1e-9) {
        flight.mesh.quaternion.setFromUnitVectors(
          new THREE.Vector3(0, 0, 1),
          vel.normalize(),
        );
      }
      flight.mesh.position.copy(next);
      flight.prev.copy(next);
    }

    for (const entry of numbers) {
      if (!entry.active) continue;
      const age = nowMs - entry.startMs;
      if (age >= NUMBER_LIFETIME_MS) {
        entry.active = false;
        entry.sprite.visible = false;
        continue;
      }
      const k = age / NUMBER_LIFETIME_MS;
      entry.sprite.position.set(entry.base.x, entry.base.y + NUMBER_RISE * k, entry.base.z);
      (entry.sprite.material as THREE.SpriteMaterial).opacity = 1 - k;
    }
  }

  return {
    spawnArrow,
    removeArrow,
    damageNumber,
    update,
    clear() {
      for (const flight of [...flights]) despawn(flight);
      for (const entry of numbers) {
        entry.active = false;
        entry.sprite.visible = false;
      }
    },
    dispose() {
      this.clear();
      for (const mesh of arrowMeshes) scene.remove(mesh);
      for (const entry of numbers) {
        scene.remove(entry.sprite);
        (entry.sprite.material as THREE.SpriteMaterial).dispose();
        entry.texture.dispose();
      }
      arrowGeometry.dispose();
      arrowMaterial.dispose();
    },
    get liveArrows() {
      return flights.length;
    },
    get arrowsSeen() {
      return arrowsSeen;
    },
  };
}
