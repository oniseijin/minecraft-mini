/**
 * Remote player avatars (M3): blocky Minecraft-style characters built from
 * BoxGeometry parts (head 0.5³, body 0.5×0.75×0.25, arms/legs 0.25×0.75×0.25;
 * the whole rig is scaled ×0.9 so it matches the 1.8-block player height),
 * skinned with the Kenney "Player male"/"Player female" textures — picked by
 * hashing the server player id — with plain-color placeholders until the
 * textures stream in.
 *
 * Origin = feet-center (server snapshots carry feet positions; the local
 * camera eye sits +1.62 above its own feet). Snapshots feed a small buffer and
 * are rendered ~100 ms in the past with position lerp / shortest-arc yaw
 * interpolation, plus an arm/leg walk swing proportional to horizontal speed.
 * A canvas-texture sprite nameplate floats above the head.
 */

import * as THREE from 'three';
import type { PlayerSnapshot } from '@mc/shared';

import maleHeadUrl from '../assets/kenney/characters/Player male/male_head.png';
import maleBodyUrl from '../assets/kenney/characters/Player male/male_body.png';
import maleArmUrl from '../assets/kenney/characters/Player male/male_arm.png';
import maleLegUrl from '../assets/kenney/characters/Player male/male_leg.png';
import femaleHeadUrl from '../assets/kenney/characters/Player female/female_head.png';
import femaleBodyUrl from '../assets/kenney/characters/Player female/female_body.png';
import femaleArmUrl from '../assets/kenney/characters/Player female/female_arm.png';
import femaleLegUrl from '../assets/kenney/characters/Player female/female_leg.png';

/** Rendered this far behind the newest snapshot — smooths 20 Hz jitter. */
const INTERP_DELAY_MS = 100;
/** Lifetime of buffered samples (roster is 20 Hz, so 20 frames is plenty). */
const SAMPLE_KEEP_MS = 1000;
/** Avatar rig is modeled 2.0 blocks tall; scaled to the 1.8-block player. */
const RIG_SCALE = 0.9;
const SWING_MAX = 0.8; // radians at full speed
const WALK_SPEED_REF = 4.3; // m/s — full swing amplitude

interface Sample {
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

interface PartUrls {
  head: string;
  body: string;
  arm: string;
  leg: string;
}

const SKINS: { placeholder: { head: number; body: number; arm: number; leg: number }; urls: PartUrls }[] = [
  {
    placeholder: { head: 0xc98d63, body: 0x3f7ac9, arm: 0x35507a, leg: 0x35415e },
    urls: { head: maleHeadUrl, body: maleBodyUrl, arm: maleArmUrl, leg: maleLegUrl },
  },
  {
    placeholder: { head: 0xd8a06b, body: 0xc9568f, arm: 0x8f3f66, leg: 0x4a3560 },
    urls: { head: femaleHeadUrl, body: femaleBodyUrl, arm: femaleArmUrl, leg: femaleLegUrl },
  },
];

interface SkinSet {
  materials: { head: THREE.MeshLambertMaterial; body: THREE.MeshLambertMaterial; arm: THREE.MeshLambertMaterial; leg: THREE.MeshLambertMaterial };
  geometries: { head: THREE.BoxGeometry; body: THREE.BoxGeometry; limb: THREE.BoxGeometry };
}

/** Textures/materials are shared per skin across all avatars; meshes are not. */
const skinCache = new Map<number, SkinSet>();

function skinFor(id: number): SkinSet {
  const index = Math.abs(id) % SKINS.length;
  const cached = skinCache.get(index);
  if (cached) return cached;

  const loader = new THREE.TextureLoader();
  const makeMaterial = (url: string, color: number): THREE.MeshLambertMaterial => {
    const material = new THREE.MeshLambertMaterial({ color });
    loader.load(
      url,
      (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.magFilter = THREE.NearestFilter;
        texture.generateMipmaps = false;
        material.map = texture;
        material.color.set(0xffffff);
        material.needsUpdate = true;
      },
      undefined,
      () => undefined, // keep the plain-color placeholder on load failure
    );
    return material;
  };

  const skin = SKINS[index];
  const set: SkinSet = {
    materials: {
      head: makeMaterial(skin.urls.head, skin.placeholder.head),
      body: makeMaterial(skin.urls.body, skin.placeholder.body),
      arm: makeMaterial(skin.urls.arm, skin.placeholder.arm),
      leg: makeMaterial(skin.urls.leg, skin.placeholder.leg),
    },
    geometries: {
      head: new THREE.BoxGeometry(0.5, 0.5, 0.5),
      body: new THREE.BoxGeometry(0.5, 0.75, 0.25),
      limb: new THREE.BoxGeometry(0.25, 0.75, 0.25),
    },
  };
  skinCache.set(index, set);
  return set;
}

function shortestArc(from: number, to: number): number {
  return ((((to - from) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
}

function makeNameplate(name: string): { sprite: THREE.Sprite; texture: THREE.CanvasTexture; draw(name: string): void } {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(1.6, 0.4, 1);
  sprite.renderOrder = 999; // nameplates stay readable through terrain
  const draw = (next: string): void => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = 'bold 30px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.strokeText(next, 128, 34);
    ctx.fillStyle = '#fff';
    ctx.fillText(next, 128, 34);
    texture.needsUpdate = true;
  };
  draw(name);
  return { sprite, texture, draw };
}

export interface RemoteAvatar {
  readonly id: number;
  name: string;
  /** Rendered feet-center position (interpolated). */
  readonly position: THREE.Vector3;
  /** Rendered yaw (interpolated, radians). */
  readonly yaw: number;
  pushSample(snapshot: PlayerSnapshot): void;
  /** `now` in ms (performance.now clock), `dt` in seconds. */
  update(now: number, dt: number): void;
  dispose(): void;
}

export function createRemoteAvatar(scene: THREE.Scene, snapshot: PlayerSnapshot): RemoteAvatar {
  const skin = skinFor(snapshot.id);

  const root = new THREE.Group();
  root.scale.setScalar(RIG_SCALE);

  const body = new THREE.Mesh(skin.geometries.body, skin.materials.body);
  body.position.y = 1.125;
  const head = new THREE.Mesh(skin.geometries.head, skin.materials.head);
  head.position.y = 1.75;

  // Limbs hang from top pivots so the swing rotates them like joints.
  const makeLimb = (material: THREE.MeshLambertMaterial, x: number, y: number): { pivot: THREE.Group; mesh: THREE.Mesh } => {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, 0);
    const mesh = new THREE.Mesh(skin.geometries.limb, material);
    mesh.position.y = -0.375;
    pivot.add(mesh);
    return { pivot, mesh };
  };
  const armL = makeLimb(skin.materials.arm, -0.375, 1.5);
  const armR = makeLimb(skin.materials.arm, 0.375, 1.5);
  const legL = makeLimb(skin.materials.leg, -0.125, 0.75);
  const legR = makeLimb(skin.materials.leg, 0.125, 0.75);

  const plate = makeNameplate(snapshot.name);
  plate.sprite.position.y = 2.15;

  root.add(body, head, armL.pivot, armR.pivot, legL.pivot, legR.pivot, plate.sprite);
  scene.add(root);

  const samples: Sample[] = [];
  const position = new THREE.Vector3(snapshot.x, snapshot.y, snapshot.z);
  let yaw = snapshot.yaw;
  let currentName = snapshot.name;
  root.position.copy(position);
  root.rotation.y = yaw;

  let lastX = snapshot.x;
  let lastZ = snapshot.z;
  let swingPhase = 0;
  let swingAmp = 0;

  return {
    id: snapshot.id,
    get name() {
      return currentName;
    },
    position,
    get yaw() {
      return yaw;
    },
    pushSample(snapshot: PlayerSnapshot) {
      samples.push({ t: performance.now(), x: snapshot.x, y: snapshot.y, z: snapshot.z, yaw: snapshot.yaw });
      if (samples.length > 24) samples.splice(0, samples.length - 24);
      if (snapshot.name !== currentName) {
        currentName = snapshot.name;
        plate.draw(currentName);
      }
    },
    update(now, dt) {
      const renderT = now - INTERP_DELAY_MS;
      while (samples.length > 2 && samples[1].t < renderT - SAMPLE_KEEP_MS) samples.shift();

      if (samples.length === 0) {
        // No sample yet (created from a roster entry) — hold the spawn pose.
      } else {
        // Find the pair surrounding renderT (or clamp at both ends).
        let i = samples.length - 1;
        while (i > 0 && samples[i].t > renderT) i--;
        const a = samples[i];
        const b = samples[Math.min(i + 1, samples.length - 1)];
        const span = b.t - a.t;
        const alpha = span > 0 ? Math.max(0, Math.min(1, (renderT - a.t) / span)) : 1;
        position.set(a.x + (b.x - a.x) * alpha, a.y + (b.y - a.y) * alpha, a.z + (b.z - a.z) * alpha);
        yaw = a.yaw + shortestArc(a.yaw, b.yaw) * alpha;
      }

      root.position.copy(position);
      root.rotation.y = yaw;

      // Walk swing ∝ horizontal speed (measured from the rendered motion).
      const speed = dt > 0 ? Math.hypot(position.x - lastX, position.z - lastZ) / dt : 0;
      lastX = position.x;
      lastZ = position.z;
      const targetAmp = Math.min(speed / WALK_SPEED_REF, 1) * SWING_MAX;
      swingAmp += (targetAmp - swingAmp) * Math.min(1, 10 * dt);
      swingPhase += speed * dt * 2.2 * Math.PI;
      const swing = Math.sin(swingPhase) * swingAmp;
      armL.pivot.rotation.x = -swing;
      armR.pivot.rotation.x = swing;
      legL.pivot.rotation.x = swing;
      legR.pivot.rotation.x = -swing;
    },
    dispose() {
      scene.remove(root);
      plate.texture.dispose();
      plate.sprite.material.dispose();
    },
  };
}

export interface RemotePlayers {
  /** Live avatars by server player id. */
  readonly map: Map<number, RemoteAvatar>;
  /** Syncs the roster: creates/pushes/removes (selfId is never rendered). */
  applySnapshot(players: readonly PlayerSnapshot[], selfId: number | null): void;
  remove(id: number): void;
  update(now: number, dt: number): void;
  dispose(): void;
}

export function createRemotePlayers(scene: THREE.Scene): RemotePlayers {
  const map = new Map<number, RemoteAvatar>();

  function applySnapshot(players: readonly PlayerSnapshot[], selfId: number | null): void {
    const seen = new Set<number>();
    for (const snapshot of players) {
      if (snapshot.id === selfId) continue;
      seen.add(snapshot.id);
      const existing = map.get(snapshot.id);
      if (existing) existing.pushSample(snapshot);
      else map.set(snapshot.id, createRemoteAvatar(scene, snapshot));
    }
    for (const id of [...map.keys()]) {
      if (!seen.has(id)) remove(id);
    }
  }

  function remove(id: number): void {
    const avatar = map.get(id);
    if (!avatar) return;
    avatar.dispose();
    map.delete(id);
  }

  return {
    map,
    applySnapshot,
    remove,
    update(now, dt) {
      for (const avatar of map.values()) avatar.update(now, dt);
    },
    dispose() {
      for (const avatar of map.values()) avatar.dispose();
      map.clear();
    },
  };
}
