import * as THREE from 'three';
import {
  AIR,
  BLOCKS,
  CHUNK,
  HOTBAR_BLOCKS,
  PROTOCOL_VERSION,
  SEA_LEVEL,
  WORLD_SIZE_X,
  WORLD_SIZE_Y,
  WORLD_SIZE_Z,
  generateWorld,
  raycast,
  type RayHit,
  type World,
} from '@mc/shared';
import { createRenderer } from './renderer';
import { createFlyControls } from './flyControls';
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

const { renderer, scene, camera, render, dispose } = createRenderer(app);
const controls = createFlyControls(camera, renderer.domElement, overlay);
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
    };
  }
}

type BootState = 'loading' | 'building' | 'ready';
let state: BootState = 'loading';
let world: World | null = null;
let worldRenderer: WorldRenderer | null = null;
let selection: Selection | null = null;
let hotbar: Hotbar | null = null;
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
  const groundY = Math.max(world!.highestBlock(SPAWN_X, SPAWN_Z), SEA_LEVEL);
  camera.position.set(SPAWN_X + 0.5, groundY + 3, SPAWN_Z + 0.5);
  statusEl.textContent = 'Click to play';
  overlay.classList.remove('loading');
  if (import.meta.env.DEV) {
    window.__mc = {
      world: world!,
      worldRenderer: worldRenderer!,
      raycastFromCamera,
      look: (yaw: number, pitch: number) => controls.look(yaw, pitch),
      camera,
    };
  }
  console.log(`[mc] world ready — spawn (${SPAWN_X + 0.5}, ${camera.position.y}, ${SPAWN_Z + 0.5})`);
}

// --- interaction ------------------------------------------------------------

function breakBlock(hit: RayHit): void {
  const id = world!.getBlock(hit.x, hit.y, hit.z);
  if (id === AIR || BLOCKS[id].unbreakable) return;
  worldRenderer!.applyEdit(hit.x, hit.y, hit.z, AIR);
}

function placeBlock(hit: RayHit): void {
  const x = hit.x + hit.nx;
  const y = hit.y + hit.ny;
  const z = hit.z + hit.nz;
  if (x < 0 || y < 0 || z < 0 || x >= WORLD_SIZE_X || y >= WORLD_SIZE_Y || z >= WORLD_SIZE_Z) {
    return;
  }
  if (world!.getBlock(x, y, z) !== AIR) return;
  worldRenderer!.applyEdit(x, y, z, HOTBAR_BLOCKS[hotbar!.selected]);
}

window.addEventListener('mousedown', (event) => {
  if (state !== 'ready' || !controls.isLocked) return;
  const hit = raycastFromCamera();
  if (!hit) return;
  if (event.button === 0) breakBlock(hit);
  else if (event.button === 2) placeBlock(hit);
});

window.addEventListener('contextmenu', (event) => {
  if (controls.isLocked) event.preventDefault();
});

window.addEventListener('keydown', (event) => {
  const slot = DIGIT_SLOTS.indexOf(event.code);
  if (slot >= 0) hotbar?.select(slot);
});

window.addEventListener(
  'wheel',
  (event) => {
    if (!controls.isLocked || !hotbar) return;
    hotbar.select(hotbar.selected + (event.deltaY > 0 ? 1 : -1));
  },
  { passive: true },
);

// --- frame loop -------------------------------------------------------------

function updateSelection(): void {
  currentTarget = controls.isLocked ? raycastFromCamera() : null;
  if (currentTarget && selection) selection.show(currentTarget.x, currentTarget.y, currentTarget.z);
  else selection?.hide();
}

function collectDebugInfo(): DebugInfo {
  const p = camera.position;
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

  if (state === 'building' && worldRenderer) {
    worldRenderer.processQueue(MESH_BUDGET_LOAD_MS);
    const built = totalToBuild - worldRenderer.pendingCount;
    statusEl.textContent = `Building world… ${Math.round((built / Math.max(totalToBuild, 1)) * 100)}%`;
    if (worldRenderer.pendingCount === 0) finishLoading();
  } else if (state === 'ready' && worldRenderer) {
    worldRenderer.update(camera);
    worldRenderer.processQueue(MESH_BUDGET_PLAY_MS);
    updateSelection();
  }

  controls.update(dt);
  render(dt);
  if (state === 'ready') debugOverlay.setInfo(collectDebugInfo());
  debugOverlay.tick(now);
  requestAnimationFrame(frame);
}

function teardown(): void {
  worldRenderer?.dispose();
  selection?.dispose();
  hotbar?.dispose();
  dispose();
}
window.addEventListener('pagehide', teardown, { once: true });

void boot();
requestAnimationFrame(frame);
