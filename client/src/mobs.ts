/**
 * Mob avatars (M5.3 Phase 1, §3.5) — box-part quadruped rigs cloned from the
 * remotePlayer.ts patterns: feet-center origin, a small sample buffer rendered
 * ~100 ms in the past with position lerp / shortest-arc yaw interpolation, and
 * a walk swing proportional to horizontal speed. NO nameplates — a hit tints
 * the materials red for 200 ms instead, and a death plays a white-sprite poof.
 *
 * Textures are the Kenney part PNGs (client/assets/kenney/characters/Fox and
 * /Boar). Draw-call discipline (target ≤5 per mob, §3.5): each rig is THREE
 * meshes — one merged torso (body + head + ears/tail as 3 texture groups) and
 * two merged diagonal leg pairs — so 3 + 2 = 5 calls per mob. Geometries are
 * cached per kind; textures are loaded once per part and shared, while
 * materials are per-mob so the damage flash never lights up the herd.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { MobKind, MobSnapshot } from '@mc/shared';
import foxBodyUrl from '../assets/kenney/characters/Fox/fox_body.png';
import foxEarUrl from '../assets/kenney/characters/Fox/fox_ear.png';
import foxLegUrl from '../assets/kenney/characters/Fox/fox_leg.png';
import foxTailUrl from '../assets/kenney/characters/Fox/fox_tail.png';
import boarBodyUrl from '../assets/kenney/characters/Boar/boar_body.png';
import boarHeadUrl from '../assets/kenney/characters/Boar/boar_head.png';
import boarLegUrl from '../assets/kenney/characters/Boar/boar_leg.png';
import boarTailUrl from '../assets/kenney/characters/Boar/boar_tail.png';
import zombieArmUrl from '../assets/kenney/characters/Zombie/zombie_arm.png';
import zombieBodyUrl from '../assets/kenney/characters/Zombie/zombie_body.png';
import zombieHeadUrl from '../assets/kenney/characters/Zombie/zombie_head.png';
import zombieLegUrl from '../assets/kenney/characters/Zombie/zombie_leg.png';

/** Rendered this far behind the newest snapshot (same as remote avatars). */
const INTERP_DELAY_MS = 100;
/** Lifetime of buffered samples (mobs relay at ~5 Hz, 8 frames is plenty). */
const SAMPLE_KEEP_MS = 1500;
const SAMPLE_KEEP_COUNT = 16;
const SWING_MAX = 0.7; // radians at full speed
const FLASH_MS = 200; // damage tint duration
const POOF_MS = 600; // death poof lifetime
const POOF_SPRITES = 7;

interface PartUrls {
  body: string;
  head: string;
  leg: string;
  tail: string;
  /** Foxes have separate ear PNGs; boars reuse the head texture for ears. */
  ear: string | null;
  /** Zombies have arm PNGs (held forward in the rig); null = no arms. */
  arm: string | null;
}

interface KindUrls extends PartUrls {
  placeholder: { body: number; head: number; leg: number; tail: number; ear: number; arm: number };
  /**
   * Plain-color rigs (giraffe): every url is '' — no textures are ever loaded
   * and the placeholder colors ARE the look.
   */
  plain?: boolean;
}

const FOX_URLS: KindUrls = {
  body: foxBodyUrl,
  head: foxBodyUrl, // no fox_head.png — the head wears the body coat
  ear: foxEarUrl,
  leg: foxLegUrl,
  tail: foxTailUrl,
  arm: null,
  placeholder: { body: 0xc96f3b, head: 0xb8622f, leg: 0x6b3f22, tail: 0xd98a52, ear: 0x8a4a26, arm: 0x8a4a26 },
};

const BOAR_URLS: KindUrls = {
  body: boarBodyUrl,
  head: boarHeadUrl,
  ear: null, // boar rig has no ears
  leg: boarLegUrl,
  tail: boarTailUrl,
  arm: null,
  placeholder: { body: 0x8a6f52, head: 0x7a5f42, leg: 0x5f4a38, tail: 0x6b5240, ear: 0x7a5f42, arm: 0x7a5f42 },
};

const ZOMBIE_URLS: KindUrls = {
  body: zombieBodyUrl,
  head: zombieHeadUrl,
  ear: null,
  leg: zombieLegUrl,
  tail: zombieArmUrl, // the rig's "tail" group is the zombie's forward arms
  arm: zombieArmUrl,
  placeholder: { body: 0x3f7a44, head: 0x4e8a52, leg: 0x35538a, tail: 0x3f7a44, ear: 0x4e8a52, arm: 0x3f7a44 },
};

/** No Kenney giraffe exists — a plain-color rig, tan with brown accents. */
const GIRAFFE_URLS: KindUrls = {
  body: '',
  head: '',
  ear: null,
  leg: '',
  tail: '',
  arm: null,
  plain: true,
  placeholder: { body: 0xd8a25a, head: 0xcf9850, leg: 0xc9984e, tail: 0x8a5a2b, ear: 0x8a5a2b, arm: 0x8a5a2b },
};

/** Attack-target box (combat.ts rayVsAabb): generous, covers the whole rig. */
export const MOB_TARGET_HALF_WIDTH = 0.45;
// v9 guest heights are person-sized placeholders — guests never spawn in the
// sandbox mob system (they ride the same snapshot stream during murder
// matches, M7.2), and M7.3 gives them real avatars + target boxes.
const KIND_HEIGHT: Record<MobKind, number> = { fox: 0.7, boar: 0.85, giraffe: 3.5, zombie: 1.95, guest: 1.95 };
/** Giraffes are long as well as tall — a wider punch target. */
const KIND_HALF_WIDTH: Record<MobKind, number> = { fox: 0.45, boar: 0.45, giraffe: 0.7, zombie: 0.45, guest: 0.45 };

/** Shared white puff texture for death poofs (lazy canvas, one upload). */
let poofTexture: THREE.CanvasTexture | null = null;
function getPoofTexture(): THREE.CanvasTexture {
  if (poofTexture) return poofTexture;
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(16, 16, 1, 16, 16, 16);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 32, 32);
  poofTexture = new THREE.CanvasTexture(canvas);
  poofTexture.colorSpace = THREE.SRGBColorSpace;
  return poofTexture;
}

// --- shared textures (loaded once per part PNG) --------------------------------

interface SharedTexture {
  texture: THREE.Texture;
  users: Set<THREE.MeshLambertMaterial>;
}

const textureCache = new Map<string, SharedTexture>();

/**
 * A MeshLambertMaterial wearing the shared texture for `url`. Until the PNG
 * streams in the material shows a plain placeholder color (remotePlayer
 * pattern); when it arrives every user flips to the texture at once.
 */
function texturedMaterial(url: string, placeholder: number): THREE.MeshLambertMaterial {
  if (url === '') {
    // Plain-color rigs (giraffe): the placeholder IS the look — no loader.
    return new THREE.MeshLambertMaterial({ color: placeholder });
  }
  const material = new THREE.MeshLambertMaterial({ color: placeholder });
  let entry = textureCache.get(url);
  if (!entry) {
    const texture = new THREE.Texture();
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    entry = { texture, users: new Set() };
    textureCache.set(url, entry);
    new THREE.TextureLoader().load(
      url,
      (loaded) => {
        texture.image = loaded.image;
        texture.needsUpdate = true;
        for (const user of entry!.users) {
          user.map = texture;
          user.color.set(0xffffff);
          user.needsUpdate = true;
        }
      },
      undefined,
      () => undefined, // keep the plain-color placeholder on load failure
    );
  }
  entry.users.add(material);
  return material;
}

// --- rig geometry (cached per kind) ---------------------------------------------

interface BoxSpec {
  size: [number, number, number];
  /** Center offset from the rig root (feet center). */
  at: [number, number, number];
  rotateX?: number;
}

interface KindRig {
  /** Torso mesh geometry: parts merged with 1 group per texture (≤3 calls). */
  torso: THREE.BufferGeometry;
  /** Merged diagonal leg pairs (1 call each); pivot at the hips, origin y=0. */
  legPairA: THREE.BufferGeometry;
  legPairB: THREE.BufferGeometry;
  /** Hip height the leg pairs hang from. */
  hipY: number;
  /** Torso draw groups in material order: [body/head, ear|head, tail]. */
  torsoMaterials: (urls: KindUrls) => THREE.MeshLambertMaterial[];
  legMaterial: (urls: KindUrls) => THREE.MeshLambertMaterial;
  /**
   * Optional extra part above the torso (giraffe neck+head), built to pivot at
   * `neckPivotY` — sways gently at idle in the avatar update. ≤2 more calls.
   */
  neck?: {
    geometry: THREE.BufferGeometry;
    materials: (urls: KindUrls) => THREE.MeshLambertMaterial[];
    pivotY: number;
  };
}

function box(spec: BoxSpec): THREE.BoxGeometry {
  const geometry = new THREE.BoxGeometry(...spec.size);
  if (spec.rotateX !== undefined) geometry.rotateX(spec.rotateX);
  geometry.translate(...spec.at);
  return geometry;
}

interface LegSpec {
  hipY: number;
  length: number;
  thickness: number;
  frontZ: number;
  backZ: number;
  halfX: number;
  /** Biped (zombie): each "pair" is a single left/right leg at z = frontZ. */
  biped?: boolean;
}

/** Merges a torso (grouped by texture) + two diagonal leg pairs for a kind. */
function buildRig(
  torsoParts: { texture: 'body' | 'head' | 'ear' | 'tail'; boxes: BoxSpec[] }[],
  legs: LegSpec,
  neckParts?: { texture: 'body' | 'head' | 'ear' | 'tail'; boxes: BoxSpec[] }[],
): KindRig {
  const torsoGroups: THREE.BufferGeometry[] = [];
  for (const part of torsoParts) {
    const merged = mergeGeometries(part.boxes.map(box), false)!;
    torsoGroups.push(merged);
  }
  const torso = mergeGeometries(torsoGroups, true)!;

  const legBox = (x: number, z: number): THREE.BoxGeometry =>
    box({ size: [legs.thickness, legs.length, legs.thickness], at: [x, -legs.length / 2, z] });
  const legPairA = legs.biped
    ? mergeGeometries([legBox(-legs.halfX, legs.frontZ)], false)!
    : mergeGeometries([legBox(-legs.halfX, legs.frontZ), legBox(legs.halfX, legs.backZ)], false)!;
  const legPairB = legs.biped
    ? mergeGeometries([legBox(legs.halfX, legs.frontZ)], false)!
    : mergeGeometries([legBox(legs.halfX, legs.frontZ), legBox(-legs.halfX, legs.backZ)], false)!;

  const materialsFor =
    (groups: { texture: 'body' | 'head' | 'ear' | 'tail' }[]) =>
    (urls: KindUrls): THREE.MeshLambertMaterial[] =>
      groups.map((part) => {
        if (part.texture === 'ear') {
          // Fox ears carry their own PNG; (boars never emit an 'ear' group).
          return texturedMaterial(urls.ear ?? urls.head, urls.placeholder.ear);
        }
        return texturedMaterial(urls[part.texture], urls.placeholder[part.texture]);
      });

  const rig: KindRig = {
    torso,
    legPairA: legPairA!,
    legPairB,
    hipY: legs.hipY,
    torsoMaterials: materialsFor(torsoParts),
    legMaterial: (urls) => texturedMaterial(urls.leg, urls.placeholder.leg),
  };

  if (neckParts && neckParts.length > 0) {
    const neckGroups: THREE.BufferGeometry[] = [];
    for (const part of neckParts) {
      neckGroups.push(mergeGeometries(part.boxes.map(box), false)!);
    }
    rig.neck = {
      geometry: mergeGeometries(neckGroups, true)!,
      materials: materialsFor(neckParts),
      pivotY: 0, // caller sets after build via the returned object
    };
  }
  return rig;
}

const RIGS: Partial<Record<MobKind, KindRig>> = {};

function rigFor(kind: MobKind): KindRig {
  const cached = RIGS[kind];
  if (cached) return cached;
  let rig: KindRig;
  if (kind === 'fox') {
    rig = buildRig(
      [
        { texture: 'body', boxes: [
          { size: [0.26, 0.26, 0.46], at: [0, 0.37, 0] }, // torso
          { size: [0.24, 0.22, 0.24], at: [0, 0.5, -0.32] }, // head
        ] },
        { texture: 'ear', boxes: [
          { size: [0.07, 0.1, 0.05], at: [-0.07, 0.65, -0.34] },
          { size: [0.07, 0.1, 0.05], at: [0.07, 0.65, -0.34] },
        ] },
        { texture: 'tail', boxes: [
          { size: [0.14, 0.14, 0.34], at: [0, 0.42, 0.34], rotateX: -0.6 },
        ] },
      ],
      { hipY: 0.28, length: 0.28, thickness: 0.08, frontZ: -0.16, backZ: 0.14, halfX: 0.09 },
    );
  } else if (kind === 'zombie') {
    // Humanoid: upright torso + head, arms cast permanently forward in the
    // classic zombie pose, and two single (biped) legs.
    rig = buildRig(
      [
        { texture: 'body', boxes: [
          { size: [0.5, 0.7, 0.28], at: [0, 1.05, 0] }, // torso
        ] },
        { texture: 'head', boxes: [
          { size: [0.5, 0.5, 0.5], at: [0, 1.66, 0] },
        ] },
        { texture: 'tail', boxes: [ // the "tail" group wears the ARM texture
          // Arms rotated ~-72° (forward-up) then translated to the shoulders.
          { size: [0.16, 0.58, 0.16], at: [-0.34, 1.32, -0.28], rotateX: -1.25 },
          { size: [0.16, 0.58, 0.16], at: [0.34, 1.32, -0.28], rotateX: -1.25 },
        ] },
      ],
      { hipY: 0.7, length: 0.7, thickness: 0.2, frontZ: 0, backZ: 0, halfX: 0.13, biped: true },
    );
  } else if (kind === 'giraffe') {
    // Hand-built (no Kenney giraffe): tall plain-color rig, the neck+head as a
    // separate swaying part. Body group carries the coat; the "tail" group is
    // the brown mane + ossicones accents.
    rig = buildRig(
      [
        { texture: 'body', boxes: [
          { size: [0.7, 0.9, 1.3], at: [0, 1.85, 0] }, // torso
          { size: [0.1, 0.55, 0.12], at: [0, 1.95, 0.68], rotateX: -0.5 }, // tail
        ] },
        { texture: 'tail', boxes: [
          { size: [0.1, 0.95, 0.16], at: [0, 2.5, -0.5] }, // mane down the neck's back
        ] },
      ],
      { hipY: 1.45, length: 1.45, thickness: 0.16, frontZ: -0.42, backZ: 0.4, halfX: 0.2 },
      [
        { texture: 'body', boxes: [
          { size: [0.28, 1.15, 0.3], at: [0, 2.6, -0.5], rotateX: 0.12 }, // neck
          { size: [0.34, 0.26, 0.52], at: [0, 3.22, -0.72] }, // head + snout
        ] },
        { texture: 'tail', boxes: [
          { size: [0.05, 0.14, 0.05], at: [-0.09, 3.44, -0.68] }, // ossicones
          { size: [0.05, 0.14, 0.05], at: [0.09, 3.44, -0.68] },
        ] },
      ],
    );
    if (rig.neck) rig.neck.pivotY = 2.05; // sway pivot at the neck's base
  } else {
    rig = buildRig(
      [
        { texture: 'body', boxes: [
          { size: [0.42, 0.4, 0.58], at: [0, 0.52, 0.02] }, // torso
        ] },
        { texture: 'head', boxes: [
          { size: [0.34, 0.32, 0.3], at: [0, 0.58, -0.42] }, // head + snout
        ] },
        { texture: 'tail', boxes: [
          { size: [0.07, 0.22, 0.07], at: [0, 0.62, 0.32], rotateX: -0.4 },
        ] },
      ],
      { hipY: 0.36, length: 0.36, thickness: 0.12, frontZ: -0.2, backZ: 0.18, halfX: 0.13 },
    );
  }
  RIGS[kind] = rig;
  return rig;
}

function urlsFor(kind: MobKind): KindUrls {
  if (kind === 'fox') return FOX_URLS;
  if (kind === 'zombie') return ZOMBIE_URLS;
  if (kind === 'giraffe') return GIRAFFE_URLS;
  return BOAR_URLS;
}

function shortestArc(from: number, to: number): number {
  return ((((to - from) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
}

// --- avatar ---------------------------------------------------------------------

interface Sample {
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

interface Poof {
  sprites: THREE.Sprite[];
  velocities: THREE.Vector3[];
  material: THREE.SpriteMaterial;
  bornAt: number;
}

export interface MobAvatar {
  readonly id: number;
  readonly kind: MobKind;
  /** Rendered feet-center position (interpolated). */
  readonly position: THREE.Vector3;
  /** Rendered yaw (interpolated, radians). */
  readonly yaw: number;
  hp: number;
  pushSample(snapshot: MobSnapshot): void;
  /** `now` in ms (performance.now clock), `dt` in seconds. */
  update(now: number, dt: number): void;
  dispose(): void;
}

function createMobAvatar(scene: THREE.Scene, snapshot: MobSnapshot): MobAvatar {
  const rig = rigFor(snapshot.kind);
  const urls = urlsFor(snapshot.kind);
  const torsoMaterials = rig.torsoMaterials(urls);
  const legMaterial = rig.legMaterial(urls);

  const root = new THREE.Group();
  const torso = new THREE.Mesh(rig.torso, torsoMaterials);
  const legsA = new THREE.Mesh(rig.legPairA, legMaterial);
  const legsB = new THREE.Mesh(rig.legPairB, legMaterial);
  legsA.position.y = rig.hipY;
  legsB.position.y = rig.hipY;
  root.add(torso, legsA, legsB);
  let neck: THREE.Mesh | null = null;
  let neckMaterials: THREE.MeshLambertMaterial[] = [];
  if (rig.neck) {
    neckMaterials = rig.neck.materials(urls);
    neck = new THREE.Mesh(rig.neck.geometry, neckMaterials);
    neck.position.y = rig.neck.pivotY;
    root.add(neck);
  }
  scene.add(root);

  const samples: Sample[] = [];
  const position = new THREE.Vector3(snapshot.x, snapshot.y, snapshot.z);
  let yaw = snapshot.yaw;
  root.position.copy(position);
  root.rotation.y = yaw;

  let hp = snapshot.hp;
  let lastX = snapshot.x;
  let lastZ = snapshot.z;
  let swingPhase = 0;
  let swingAmp = 0;
  let flashUntil = 0;
  let flashing = false;

  const setFlash = (on: boolean): void => {
    flashing = on;
    const color = on ? 0xff4040 : 0xffffff;
    for (const material of torsoMaterials) material.color.set(color);
    legMaterial.color.set(color);
    for (const material of neckMaterials) material.color.set(color);
  };

  return {
    id: snapshot.id,
    kind: snapshot.kind,
    position,
    get yaw() {
      return yaw;
    },
    get hp() {
      return hp;
    },
    pushSample(next: MobSnapshot) {
      if (next.hp < hp) flashUntil = performance.now() + FLASH_MS; // damage flash
      hp = next.hp;
      samples.push({ t: performance.now(), x: next.x, y: next.y, z: next.z, yaw: next.yaw });
      if (samples.length > SAMPLE_KEEP_COUNT) samples.splice(0, samples.length - SAMPLE_KEEP_COUNT);
    },
    update(now, dt) {
      const renderT = now - INTERP_DELAY_MS;
      while (samples.length > 2 && samples[1].t < renderT - SAMPLE_KEEP_MS) samples.shift();

      if (samples.length > 0) {
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

      // Damage flash expiry.
      const wantFlash = now < flashUntil;
      if (flashing !== wantFlash) setFlash(wantFlash);

      // Leg swing ∝ horizontal speed (measured from the rendered motion).
      const speed = dt > 0 ? Math.hypot(position.x - lastX, position.z - lastZ) / dt : 0;
      lastX = position.x;
      lastZ = position.z;
      const targetAmp = Math.min(speed / 3.5, 1) * SWING_MAX;
      swingAmp += (targetAmp - swingAmp) * Math.min(1, 10 * dt);
      swingPhase += speed * dt * 2.2 * Math.PI;
      const swing = Math.sin(swingPhase) * swingAmp;
      legsA.rotation.x = swing;
      legsB.rotation.x = -swing;

      // Giraffe neck: gentle sway while idle (fades out while walking).
      if (neck) {
        const idle = 1 - Math.min(1, speed / 1.2);
        neck.rotation.z = Math.sin(now / 1400 + snapshot.id) * 0.07 * idle;
        neck.rotation.x = Math.sin(now / 2600 + snapshot.id) * 0.05 * idle;
      }
    },
    dispose() {
      scene.remove(root);
      for (const material of torsoMaterials) material.dispose();
      legMaterial.dispose();
      for (const material of neckMaterials) material.dispose();
    },
  };
}

// --- renderer -------------------------------------------------------------------

export interface MobRenderer {
  /** Live avatars by server mob id. */
  readonly map: Map<number, MobAvatar>;
  /** Syncs a `mobs` snapshot: creates/pushes/removes. */
  applySnapshot(mobs: readonly MobSnapshot[]): void;
  remove(id: number): void;
  /** Death: white-sprite poof at `at` (or the avatar's position) + removal. */
  kill(id: number, at?: readonly [number, number, number]): void;
  /** Mode change: remove everything without poofs (the match owns the screen). */
  clear(): void;
  update(now: number, dt: number): void;
  dispose(): void;
}

export function createMobRenderer(scene: THREE.Scene): MobRenderer {
  const map = new Map<number, MobAvatar>();
  const poofs: Poof[] = [];

  function spawnPoof(at: THREE.Vector3): void {
    const material = new THREE.SpriteMaterial({
      map: getPoofTexture(),
      transparent: true,
      depthWrite: false,
    });
    const sprites: THREE.Sprite[] = [];
    const velocities: THREE.Vector3[] = [];
    for (let i = 0; i < POOF_SPRITES; i++) {
      const sprite = new THREE.Sprite(material);
      sprite.position.set(at.x + (Math.random() - 0.5) * 0.4, at.y + 0.3 + Math.random() * 0.4, at.z + (Math.random() - 0.5) * 0.4);
      const scale = 0.22 + Math.random() * 0.18;
      sprite.scale.setScalar(scale);
      velocities.push(
        new THREE.Vector3((Math.random() - 0.5) * 2.2, 1.2 + Math.random() * 1.6, (Math.random() - 0.5) * 2.2),
      );
      sprites.push(sprite);
      scene.add(sprite);
    }
    poofs.push({ sprites, velocities, material, bornAt: performance.now() });
  }

  function stepPoofs(now: number, dt: number): void {
    for (let i = poofs.length - 1; i >= 0; i--) {
      const poof = poofs[i];
      const age = (now - poof.bornAt) / POOF_MS;
      if (age >= 1) {
        for (const sprite of poof.sprites) {
          scene.remove(sprite);
          sprite.material.dispose();
        }
        poof.material.dispose();
        poofs.splice(i, 1);
        continue;
      }
      poof.material.opacity = 1 - age;
      for (let s = 0; s < poof.sprites.length; s++) {
        const sprite = poof.sprites[s];
        const velocity = poof.velocities[s];
        velocity.y -= 4 * dt;
        sprite.position.addScaledVector(velocity, dt);
      }
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
    applySnapshot(mobs) {
      const seen = new Set<number>();
      for (const snapshot of mobs) {
        seen.add(snapshot.id);
        const existing = map.get(snapshot.id);
        if (existing) existing.pushSample(snapshot);
        else map.set(snapshot.id, createMobAvatar(scene, snapshot));
      }
      for (const id of [...map.keys()]) {
        if (!seen.has(id)) remove(id);
      }
    },
    remove,
    kill(id, at) {
      const avatar = map.get(id);
      if (avatar) {
        spawnPoof(
          at
            ? new THREE.Vector3(at[0], at[1], at[2])
            : avatar.position,
        );
      }
      remove(id);
    },
    clear() {
      for (const avatar of map.values()) avatar.dispose();
      map.clear();
    },
    update(now, dt) {
      for (const avatar of map.values()) avatar.update(now, dt);
      stepPoofs(now, dt);
    },
    dispose() {
      this.clear();
      for (const poof of poofs) {
        for (const sprite of poof.sprites) sprite.material.dispose();
        poof.material.dispose();
      }
      poofs.length = 0;
      for (const entry of textureCache.values()) entry.texture.dispose();
      textureCache.clear();
      poofTexture?.dispose();
      poofTexture = null;
    },
  };
}

/** Attack-target AABB for a mob (combat.ts rayVsAabb shape). */
export function mobTargetBox(
  position: THREE.Vector3,
  kind: MobKind,
): {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
} {
  return {
    minX: position.x - KIND_HALF_WIDTH[kind],
    minY: position.y,
    minZ: position.z - KIND_HALF_WIDTH[kind],
    maxX: position.x + KIND_HALF_WIDTH[kind],
    maxY: position.y + KIND_HEIGHT[kind],
    maxZ: position.z + KIND_HALF_WIDTH[kind],
  };
}
