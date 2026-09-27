import * as THREE from 'three';
import {
  AIR,
  BLOCKS,
  CHUNK,
  HOTBAR_BLOCKS,
  PROTOCOL_VERSION,
  WORLD_SIZE_X,
  WORLD_SIZE_Y,
  WORLD_SIZE_Z,
  generateWorld,
  raycast,
  type RayHit,
  type World,
} from '@mc/shared';
import { createRenderer } from './renderer';
import { createPlayer, PLAYER_HALF_WIDTH, PLAYER_HEIGHT, type Player } from './player';
import { createDayNight } from './daynight';
import { blockSoundKind, createGameAudio, type GameAudio } from './audio';
import { createDebugOverlay, type DebugInfo } from './debug';
import { loadAtlas, tileDataUrl } from './atlas';
import { createWorldRenderer, type WorldRenderer } from './world/worldRenderer';
import { createSelection, type Selection } from './selection';
import { createHotbar, type Hotbar } from './hotbar';

console.log(`minecraft-mini client (protocol v${PROTOCOL_VERSION})`);

const SEED = 1337;
const REACH = 5; // blocks
const SPAWN_X = 128;
const SPAWN_Z = 128;
const DIGIT_SLOTS = [
  'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5',
  'Digit6', 'Digit7', 'Digit8', 'Digit9',
];

const MESH_BUDGET_PLAY_MS = 6; // remesh time slice per frame during play
const MESH_BUDGET_LOAD_MS = 50; // bigger slice behind the loading screen
const MAX_DT = 0.1; // clamp tab-switch / stall spikes

const app = document.querySelector<HTMLDivElement>('#app')!;
const overlay = document.querySelector<HTMLDivElement>('#overlay')!;
const statusEl = document.querySelector<HTMLParagraphElement>('#overlay-status')!;
const debug = document.querySelector<HTMLDivElement>('#debug')!;
const hotbarEl = document.querySelector<HTMLDivElement>('#hotbar')!;
const crosshairEl = document.querySelector<HTMLDivElement>('#crosshair')!;
const toastEl = document.querySelector<HTMLDivElement>('#toast')!;

const { renderer, scene, camera, render, dispose, sun, hemisphere, setSkyColor } = createRenderer(app);
const dayNight = createDayNight({ sun, hemisphere, setSkyColor });
const audio = createGameAudio();
const debugOverlay = createDebugOverlay(debug);

/** Automation hook, dev builds only (`import.meta.env.DEV`). */
declare global {
  interface Window {
    __mc?: {
      world: World;
      worldRenderer: WorldRenderer;
      raycastFromCamera(): RayHit | null;
      look(yaw: number, pitch: number): void;
      camera: THREE.PerspectiveCamera;
      player: Player;
      /** Validated placement (bounds + occupancy + player overlap). */
      tryPlace(x: number, y: number, z: number): boolean;
    };
  }
}

type BootState = 'loading' | 'building' | 'ready';
let state: BootState = 'loading';
let world: World | null = null;
let worldRenderer: WorldRenderer | null = null;
let selection: Selection | null = null;
let hotbar: Hotbar | null = null;
let player: Player | null = null;
let spawn = { x: SPAWN_X + 0.5, y: 40, z: SPAWN_Z + 0.5 };
let totalToBuild = 0;
let currentTarget: RayHit | null = null;

function raycastFromCamera(): RayHit | null {
  if (!world) return null;
  const dir = camera.getWorldDirection(new THREE.Vector3());
  return raycast(world, camera.position, dir, REACH);
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

let toastTimer: number | undefined;

/** Small centered-bottom HUD message that fades out after ~1.5 s. */
function showToast(text: string): void {
  toastEl.textContent = text;
  toastEl.classList.add('show');
  if (toastTimer !== undefined) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), 1500);
}

async function boot(): Promise<void> {
  const atlas = await loadAtlas(); // overlay reads "Loading textures…"

  statusEl.textContent = 'Generating world…';
  await nextFrame();
  await nextFrame(); // let the status paint before the synchronous generation

  world = generateWorld(SEED);
  worldRenderer = createWorldRenderer(scene, world, atlas);
  selection = createSelection(scene);
  hotbar = createHotbar(hotbarEl, HOTBAR_BLOCKS, (id) => tileDataUrl(BLOCKS[id].tiles.side));

  worldRenderer.enqueueAllChunks();
  totalToBuild = worldRenderer.pendingCount;
  state = 'building';
}

function finishLoading(): void {
  state = 'ready';
  const topY = Math.max(world!.highestBlock(SPAWN_X, SPAWN_Z), 0);
  spawn = { x: SPAWN_X + 0.5, y: topY + 1, z: SPAWN_Z + 0.5 }; // feet position
  player = createPlayer({
    world: world!,
    camera,
    canvas: renderer.domElement,
    overlay,
    spawn,
    hooks: {
      onStep: (blockId) => audio.footstep(blockSoundKind(blockId)),
      onLand: () => audio.land(),
      onSplash: () => audio.splash(),
    },
  });
  statusEl.textContent = 'Click to play';
  overlay.classList.remove('loading');
  if (import.meta.env.DEV) {
    window.__mc = {
      world: world!,
      worldRenderer: worldRenderer!,
      raycastFromCamera,
      look: (yaw: number, pitch: number) => player!.look(yaw, pitch),
      camera,
      player: player!,
      tryPlace,
    };
  }
  console.log(`[mc] world ready — spawn feet (${spawn.x}, ${spawn.y}, ${spawn.z})`);
}

// --- interaction ------------------------------------------------------------

function breakBlock(hit: RayHit): void {
  const id = world!.getBlock(hit.x, hit.y, hit.z);
  if (id === AIR || BLOCKS[id].unbreakable) return;
  worldRenderer!.applyEdit(hit.x, hit.y, hit.z, AIR);
  audio.blockBreak(blockSoundKind(id));
}

/** True when the block cell (x, y, z) overlaps the player's AABB. */
function blockIntersectsPlayer(x: number, y: number, z: number): boolean {
  if (!player) return false;
  const p = player.pos;
  return (
    x < p.x + PLAYER_HALF_WIDTH &&
    x + 1 > p.x - PLAYER_HALF_WIDTH &&
    y < p.y + PLAYER_HEIGHT &&
    y + 1 > p.y &&
    z < p.z + PLAYER_HALF_WIDTH &&
    z + 1 > p.z - PLAYER_HALF_WIDTH
  );
}

/**
 * Validates and applies a placement into cell (x, y, z): world bounds, target
 * must be air, and the cell must not intersect the player AABB (the M1 gap).
 * Returns whether the edit was applied.
 */
function tryPlace(x: number, y: number, z: number): boolean {
  if (x < 0 || y < 0 || z < 0 || x >= WORLD_SIZE_X || y >= WORLD_SIZE_Y || z >= WORLD_SIZE_Z) {
    return false;
  }
  if (world!.getBlock(x, y, z) !== AIR) return false;
  if (blockIntersectsPlayer(x, y, z)) return false;
  worldRenderer!.applyEdit(x, y, z, HOTBAR_BLOCKS[hotbar!.selected]);
  audio.blockPlace();
  return true;
}

function placeBlock(hit: RayHit): void {
  tryPlace(hit.x + hit.nx, hit.y + hit.ny, hit.z + hit.nz);
}

window.addEventListener('mousedown', (event) => {
  if (state !== 'ready' || !player?.isLocked) return;
  const hit = raycastFromCamera();
  if (!hit) return;
  if (event.button === 0) breakBlock(hit);
  else if (event.button === 2) placeBlock(hit);
});

window.addEventListener('contextmenu', (event) => {
  if (player?.isLocked) event.preventDefault();
});

window.addEventListener('keydown', (event) => {
  const slot = DIGIT_SLOTS.indexOf(event.code);
  if (slot >= 0) hotbar?.select(slot);
  if (event.code === 'KeyM') {
    const muted = audio.toggleMute();
    console.log(`[mc] sound ${muted ? 'muted' : 'on'} (M)`);
  }
  // Mouse sensitivity: `[` coarser, `]` finer (±10% per press, [0.0008, 0.01]).
  if (event.code === 'BracketLeft' || event.code === 'BracketRight') {
    const finer = event.code === 'BracketRight';
    const value = player?.adjustSensitivity(finer ? 1.1 : 1 / 1.1);
    if (value !== undefined) showToast(`Mouse sensitivity: ${value.toFixed(4)}`);
  }
});

// Audio must be unlocked inside a user gesture — same click that locks the pointer.
overlay.addEventListener('click', () => audio.resume());

window.addEventListener(
  'wheel',
  (event) => {
    if (!player?.isLocked || !hotbar) return;
    hotbar.select(hotbar.selected + (event.deltaY > 0 ? 1 : -1));
  },
  { passive: true },
);

// --- frame loop -------------------------------------------------------------

function updateSelection(): void {
  currentTarget = player?.isLocked ? raycastFromCamera() : null;
  crosshairEl.classList.toggle('hidden', !player?.isLocked);
  if (currentTarget && selection) selection.show(currentTarget.x, currentTarget.y, currentTarget.z);
  else selection?.hide();
}

function collectDebugInfo(): DebugInfo {
  const p = player?.pos ?? camera.position;
  const id = currentTarget && world ? world.getBlock(currentTarget.x, currentTarget.y, currentTarget.z) : AIR;
  return {
    x: p.x,
    y: p.y,
    z: p.z,
    chunkX: Math.floor(p.x / CHUNK),
    chunkZ: Math.floor(p.z / CHUNK),
    chunksLoaded: worldRenderer?.loadedCount ?? 0,
    chunksVisible: worldRenderer?.visibleCount ?? 0,
    drawCalls: renderer.info.render.calls,
    target:
      currentTarget && id !== AIR
        ? `${BLOCKS[id].name} (${currentTarget.x}, ${currentTarget.y}, ${currentTarget.z})`
        : '',
  };
}

let last = performance.now();

function frame(now: number): void {
  const dt = Math.min((now - last) / 1000, MAX_DT);
  last = now;

  dayNight.update(dt); // cosmetic sky/light cycle

  if (state === 'building' && worldRenderer) {
    worldRenderer.processQueue(MESH_BUDGET_LOAD_MS);
    const built = totalToBuild - worldRenderer.pendingCount;
    statusEl.textContent = `Building world… ${Math.round((built / Math.max(totalToBuild, 1)) * 100)}%`;
    if (worldRenderer.pendingCount === 0) finishLoading();
  } else if (state === 'ready' && worldRenderer) {
    player?.update(dt);
    worldRenderer.update(camera);
    worldRenderer.processQueue(MESH_BUDGET_PLAY_MS);
    updateSelection();
  }

  render(dt);
  if (state === 'ready') debugOverlay.setInfo(collectDebugInfo());
  debugOverlay.tick(now);
  requestAnimationFrame(frame);
}

function teardown(): void {
  worldRenderer?.dispose();
  selection?.dispose();
  hotbar?.dispose();
  player?.dispose();
  audio.dispose();
  dispose();
}
window.addEventListener('pagehide', teardown, { once: true });

void boot();
requestAnimationFrame(frame);
