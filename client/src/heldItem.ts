/**
 * First-person held-item viewmodel (M7.5, DESIGN.md §3.7): Minecraft renders
 * what you hold; we showed only HUD icons. A camera-anchored group draws the
 * held thing in the bottom-right of the view, OVER the world (high
 * renderOrder + depthTest off — the hand is never occluded, the Minecraft
 * behavior) in ≤3 draw calls:
 *
 *   - setCube    — the selected hotbar block as a small textured cube with
 *                  per-face UVs from the SAME atlas the chunk mesher uses;
 *   - setSprite  — an angled quad for items (BedWars sword tiers / golden
 *                  apple — the Kenney item PNGs stand in for Minecraft's
 *                  extruded item sprites);
 *   - setWand    — the Murder Mystery zapper wand, two plain-material boxes;
 *   - clear      — empty hands (Block Party, dry zapper, fists).
 *
 * Feel: a gentle walk bob at the footstep cadence (player.ts steps every
 * STEP_DISTANCE = 2 m at WALK_SPEED 4.3 m/s ≈ 2.15 steps/s — a dt-integrated
 * phase, since the real onStep hook only drives audio) and a ~250 ms
 * down-forward swing arc on every click that acts, safe to retrigger.
 * No idle sway in v1.
 *
 * The group hangs off the camera (main.ts puts the camera in the scene graph
 * first — three.js only renders camera children when the camera is a scene
 * node). update() keeps animating while hidden so the swing/bob state stays
 * deterministic for the __mc test surface.
 */

import * as THREE from 'three';
import { AIR, BLOCKS } from '@mc/shared';
import type { Atlas } from './atlas';

export interface HeldItemOptions {
  atlas: Atlas;
  /**
   * Icon resolver (main.ts's itemIcon): 'item:<kenney basename>' /
   * 'tile:<atlas tile>' → PNG URL. setSprite accepts either a spec (delegated
   * to this resolver) or an already-resolved URL.
   */
  itemIcon?: (spec: string) => string;
}

export type HeldKind = 'cube' | 'sprite' | 'wand' | 'none';

/** Plain-object snapshot for the __mc.heldItem test surface. */
export interface HeldItemView {
  kind: HeldKind;
  blockId: number | null;
  swinging: boolean;
}

export interface HeldItem {
  setCube(blockId: number | null): void;
  setSprite(source: string | null): void;
  setWand(): void;
  clear(): void;
  /** The ~250 ms down-forward arc; retriggers (restarts) freely. */
  swing(): void;
  /** Advances the swing + walk bob. Safe (and expected) while hidden. */
  update(nowMs: number, dt: number, walking: boolean): void;
  setVisible(visible: boolean): void;
  readonly kind: HeldKind;
  /** Held block id while kind === 'cube', else null. */
  readonly blockId: number | null;
  readonly swinging: boolean;
  dispose(): void;
}

const SWING_MS = 250;
/** Footstep cadence: STEP_DISTANCE (2 m) / WALK_SPEED (4.3 m/s), player.ts. */
const STEP_CADENCE_HZ = 4.3 / 2.0;

/** Bottom-right anchor, camera space (near plane is 0.1 — ~0.8 is safe). */
const BASE_POSITION = new THREE.Vector3(0.46, -0.42, -0.72);
const BASE_ROTATION = new THREE.Euler(0, -Math.PI / 6, 0);
/** Over the world, under the nameplates' 999 (remotePlayer.ts). */
const RENDER_ORDER = 900;
const deg = THREE.MathUtils.degToRad;

/** BoxGeometry face order: +X, -X, +Y, -Y, +Z, -Z → mesher tile kinds. */
const BOX_FACE_TILES = ['side', 'side', 'top', 'bottom', 'side', 'side'] as const;

export function createHeldItem(camera: THREE.PerspectiveCamera, opts: HeldItemOptions): HeldItem {
  const group = new THREE.Group();
  group.position.copy(BASE_POSITION);
  group.rotation.copy(BASE_ROTATION);
  camera.add(group);

  // --- the three held shapes (one visible at a time) -------------------------

  // Cube: one box, per-face atlas UVs rewritten by setCube.
  const cubeGeometry = new THREE.BoxGeometry(1, 1, 1);
  // alphaTest gives leaves/glass their cutout look; opaque tiles are unaffected.
  const cubeMaterial = new THREE.MeshLambertMaterial({
    map: opts.atlas.texture,
    alphaTest: 0.5,
    depthTest: false,
  });
  const cube = new THREE.Mesh(cubeGeometry, cubeMaterial);
  cube.scale.setScalar(0.3);
  cube.renderOrder = RENDER_ORDER;
  cube.visible = false;
  group.add(cube);

  // Sprite: an angled quad, Minecraft-ish item pose (yaw −25° / pitch +10°).
  const spriteGeometry = new THREE.PlaneGeometry(0.5, 0.5);
  const spriteMaterial = new THREE.MeshBasicMaterial({ transparent: true, depthTest: false });
  const sprite = new THREE.Mesh(spriteGeometry, spriteMaterial);
  sprite.rotation.set(deg(10), deg(-25), 0);
  sprite.renderOrder = RENDER_ORDER;
  sprite.visible = false;
  group.add(sprite);

  // Wand: two-tone zapper (dark shaft + glowing tip), plain materials, no assets.
  const shaftMaterial = new THREE.MeshLambertMaterial({ color: 0x3a4048, depthTest: false });
  const tipMaterial = new THREE.MeshLambertMaterial({ color: 0x8fe0ff, depthTest: false });
  const shaft = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.34, 0.05), shaftMaterial);
  const tip = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.1, 0.085), tipMaterial);
  tip.position.y = 0.19;
  const wand = new THREE.Group();
  wand.add(shaft, tip);
  for (const mesh of [shaft, tip]) mesh.renderOrder = RENDER_ORDER;
  wand.rotation.set(deg(14), deg(-28), 0);
  wand.visible = false;
  group.add(wand);

  // --- state -------------------------------------------------------------------

  let kind: HeldKind = 'none';
  let heldBlockId: number | null = null;
  let heldSpriteSource: string | null = null;
  let swingT = -1; // < 0 idle; else progress 0..1
  let bobPhase = 0;
  let bobAmp = 0; // eased 0..1 so the bob fades in/out with walking

  function hideAll(): void {
    cube.visible = false;
    sprite.visible = false;
    wand.visible = false;
  }

  function setCube(blockId: number | null): void {
    if (blockId === null || blockId === AIR || !BLOCKS[blockId]) {
      clear();
      return;
    }
    if (kind === 'cube' && heldBlockId === blockId) return; // idempotent per-frame calls
    kind = 'cube';
    heldBlockId = blockId;
    heldSpriteSource = null;
    const def = BLOCKS[blockId];
    const uv = cubeGeometry.attributes.uv as THREE.BufferAttribute;
    for (let face = 0; face < 6; face++) {
      const rect = opts.atlas.uv(def.tiles[BOX_FACE_TILES[face]]);
      const base = face * 4;
      // BoxGeometry per-face corner UVs are (0,1) (1,1) (0,0) (1,0).
      uv.setXY(base + 0, rect.u0, rect.v1);
      uv.setXY(base + 1, rect.u1, rect.v1);
      uv.setXY(base + 2, rect.u0, rect.v0);
      uv.setXY(base + 3, rect.u1, rect.v0);
    }
    uv.needsUpdate = true;
    hideAll();
    cube.visible = true;
  }

  function setSprite(source: string | null): void {
    if (source === null) {
      clear();
      return;
    }
    if (kind === 'sprite' && heldSpriteSource === source) return;
    kind = 'sprite';
    heldBlockId = null;
    heldSpriteSource = source;
    hideAll();
    sprite.visible = true;
    spriteMaterial.map = null; // arrives with the texture (usually instantly)
    spriteMaterial.needsUpdate = true;
    const token = ++spriteToken;
    loadTexture(resolveUrl(source), (texture) => {
      if (token !== spriteToken) return; // a newer setSprite/clear superseded this load
      spriteMaterial.map = texture;
      spriteMaterial.needsUpdate = true;
    });
  }

  function setWand(): void {
    if (kind === 'wand') return;
    kind = 'wand';
    heldBlockId = null;
    heldSpriteSource = null;
    hideAll();
    wand.visible = true;
  }

  function clear(): void {
    if (kind === 'none') return;
    spriteToken++; // invalidate any in-flight sprite texture load
    kind = 'none';
    heldBlockId = null;
    heldSpriteSource = null;
    hideAll();
    spriteMaterial.map = null;
    spriteMaterial.needsUpdate = true;
  }

  // --- sprite textures (cached per URL; icon misses just stay blank) -----------

  const textures = new Map<string, THREE.Texture>();
  const pending = new Map<string, ((texture: THREE.Texture) => void)[]>();
  const loader = new THREE.TextureLoader();
  let spriteToken = 0;

  /** 'item:basename' specs go through the resolver; plain URLs pass through. */
  function resolveUrl(source: string): string {
    if (!source.includes(':')) return source;
    return opts.itemIcon?.(source) || source;
  }

  function loadTexture(url: string, onLoad: (texture: THREE.Texture) => void): void {
    const cached = textures.get(url);
    if (cached) {
      if (cached.image) onLoad(cached);
      else pending.get(url)?.push(onLoad); // a previous load is still in flight
      return;
    }
    const texture = loader.load(
      url,
      (loaded) => {
        loaded.colorSpace = THREE.SRGBColorSpace;
        const callbacks = pending.get(url);
        pending.delete(url);
        for (const callback of callbacks ?? []) callback(loaded);
      },
      undefined,
      () => pending.delete(url), // broken icon URL → blank sprite, never fatal
    );
    texture.magFilter = THREE.NearestFilter; // pixel-art icons stay crisp
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    textures.set(url, texture);
    pending.set(url, [onLoad]);
  }

  // --- feel ----------------------------------------------------------------------

  function swing(): void {
    swingT = 0; // retrigger = restart the arc
  }

  function update(_nowMs: number, dt: number, walking: boolean): void {
    // Walk bob: a small figure-8 (x sway + double-frequency y) at the
    // footstep cadence; the amplitude eases so start/stop is not a pop.
    if (walking) {
      bobPhase = (bobPhase + dt * STEP_CADENCE_HZ * Math.PI * 2) % (Math.PI * 2);
      bobAmp = Math.min(1, bobAmp + dt * 6);
    } else {
      bobAmp = Math.max(0, bobAmp - dt * 6);
    }
    const bobX = Math.sin(bobPhase) * 0.016 * bobAmp;
    const bobY = Math.sin(bobPhase * 2) * 0.01 * bobAmp;
    const bobRoll = Math.sin(bobPhase) * 0.03 * bobAmp;

    // Swing arc: down + forward dip over SWING_MS, symmetric ease back.
    let swingPitch = 0;
    let swingY = 0;
    let swingZ = 0;
    if (swingT >= 0) {
      swingT += (dt * 1000) / SWING_MS;
      if (swingT >= 1) {
        swingT = -1;
      } else {
        const k = Math.sin(swingT * Math.PI);
        swingPitch = -k * 0.9;
        swingY = -k * 0.1;
        swingZ = -k * 0.14;
      }
    }

    group.position.set(BASE_POSITION.x + bobX, BASE_POSITION.y + bobY + swingY, BASE_POSITION.z + swingZ);
    group.rotation.set(BASE_ROTATION.x + swingPitch, BASE_ROTATION.y, BASE_ROTATION.z + bobRoll);
  }

  return {
    setCube,
    setSprite,
    setWand,
    clear,
    swing,
    update,
    setVisible(visible: boolean) {
      group.visible = visible;
    },
    get kind() {
      return kind;
    },
    get blockId() {
      return heldBlockId;
    },
    get swinging() {
      return swingT >= 0;
    },
    dispose() {
      camera.remove(group);
      hideAll();
      cubeGeometry.dispose();
      spriteGeometry.dispose();
      shaft.geometry.dispose();
      tip.geometry.dispose();
      cubeMaterial.dispose();
      spriteMaterial.dispose();
      shaftMaterial.dispose();
      tipMaterial.dispose();
      for (const texture of textures.values()) texture.dispose();
      textures.clear();
      pending.clear();
    },
  };
}
