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
  type EditTuple,
  type RayHit,
  type ServerMessage,
  type WelcomeMsg,
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
import { createNet, wsUrl, type Net, type NetMode } from './net';
import { createRemotePlayers, type RemoteAvatar, type RemotePlayers } from './remotePlayer';
import { createChatUi, type ChatUi } from './chat';

console.log(`minecraft-mini client (protocol v${PROTOCOL_VERSION})`);

const OFFLINE_SEED = 1337; // also the server's seed — worlds match either way
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

const MOVE_SEND_INTERVAL_MS = 50; // 20 Hz movement relay (DESIGN.md §3.2)
const MOVE_EPS = 1e-4; // movement send only when pos/angles actually changed
const NAME_STORAGE_KEY = 'mc-name';
const NAME_DEBOUNCE_MS = 800; // batch name edits before re-joining online

const app = document.querySelector<HTMLDivElement>('#app')!;
const overlay = document.querySelector<HTMLDivElement>('#overlay')!;
const statusEl = document.querySelector<HTMLParagraphElement>('#overlay-status')!;
const debug = document.querySelector<HTMLDivElement>('#debug')!;
const hotbarEl = document.querySelector<HTMLDivElement>('#hotbar')!;
const crosshairEl = document.querySelector<HTMLDivElement>('#crosshair')!;
const toastEl = document.querySelector<HTMLDivElement>('#toast')!;
const menuEl = document.querySelector<HTMLDivElement>('#menu')!;
const nameInput = document.querySelector<HTMLInputElement>('#name-input')!;
const flyToggle = document.querySelector<HTMLButtonElement>('#fly-toggle')!;
const soundToggle = document.querySelector<HTMLButtonElement>('#sound-toggle')!;
const sensValue = document.querySelector<HTMLSpanElement>('#sens-value')!;
const sensMinus = document.querySelector<HTMLButtonElement>('#sens-minus')!;
const sensPlus = document.querySelector<HTMLButtonElement>('#sens-plus')!;
const chatLogEl = document.querySelector<HTMLDivElement>('#chat-log')!;
const chatBoxEl = document.querySelector<HTMLDivElement>('#chat-box')!;
const chatInput = document.querySelector<HTMLInputElement>('#chat-input')!;

const { renderer, scene, camera, render, dispose, sun, hemisphere, setSkyColor } = createRenderer(app);
const dayNight = createDayNight({ sun, hemisphere, setSkyColor });
const audio = createGameAudio();
const debugOverlay = createDebugOverlay(debug);

/** Test/automation hooks (also available in the LAN build for smoke tests). */
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
      /** Connection state: mode 'online' | 'offline' | 'connecting'. */
      net: {
        readonly mode: NetMode;
        readonly connected: boolean;
        readonly id: number | null;
        readonly players: readonly import('@mc/shared').PlayerSnapshot[];
      };
      /** Remote avatars by server player id (rendered feet position). */
      remotePlayers: Map<number, RemoteAvatar>;
      /** Sends a chat message through the protocol (no-op when offline). */
      chat(text: string): void;
      /** Recent chat, oldest first. */
      chatHistory: { from: string; text: string }[];
    };
  }
}

type BootState = 'connecting' | 'building' | 'ready';
let state: BootState = 'connecting';
let seed = OFFLINE_SEED;
let world: World | null = null;
let worldRenderer: WorldRenderer | null = null;
let selection: Selection | null = null;
let hotbar: Hotbar | null = null;
let player: Player | null = null;
let net: Net | null = null;
let remotePlayers: RemotePlayers | null = null;
let chat: ChatUi | null = null;
let chatOpen = false;
const chatHistory: { from: string; text: string }[] = [];
let spawn = { x: SPAWN_X + 0.5, y: 40, z: SPAWN_Z + 0.5 };
let totalToBuild = 0;
let currentTarget: RayHit | null = null;

/** Resolves the very first handshake attempt (welcome) or null (offline). */
let firstWelcomeResolve: ((welcome: WelcomeMsg | null) => void) | null = null;

// --- small utils ------------------------------------------------------------

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

// --- player name ------------------------------------------------------------

const NAME_ADJECTIVES = ['Turbo', 'Sneaky', 'Chunky', 'Pixel', 'Dizzy', 'Zesty', 'Wobbly', 'Bouncy', 'Grumpy', 'Muddy'];
const NAME_NOUNS = ['Pickle', 'Waffle', 'Noodle', 'Goblin', 'Badger', 'Nugget', 'Cactus', 'Penguin', 'Muffin', 'Yeti'];

function randomName(): string {
  const pick = (list: string[]): string => list[Math.floor(Math.random() * list.length)];
  return `${pick(NAME_ADJECTIVES)}${pick(NAME_NOUNS)}${Math.floor(Math.random() * 100)}`;
}

function loadName(): string {
  const saved = localStorage.getItem(NAME_STORAGE_KEY);
  if (saved !== null && saved.trim().length > 0) return saved;
  const name = randomName();
  localStorage.setItem(NAME_STORAGE_KEY, name);
  return name;
}

nameInput.value = loadName();

let nameSendTimer: number | undefined;

nameInput.addEventListener('input', () => {
  localStorage.setItem(NAME_STORAGE_KEY, nameInput.value);
  // Batch edits before re-joining under the new name while online.
  if (nameSendTimer !== undefined) clearTimeout(nameSendTimer);
  nameSendTimer = window.setTimeout(() => {
    nameSendTimer = undefined;
    net?.setName(nameInput.value);
  }, NAME_DEBOUNCE_MS);
});

// --- pause menu ---------------------------------------------------------------

/** Mirrors player/audio state into the pause-menu labels. */
function refreshMenu(): void {
  if (!player) return;
  flyToggle.textContent = `Flying: ${player.flying ? 'ON' : 'OFF'}`;
  flyToggle.classList.toggle('on', player.flying);
  soundToggle.textContent = `Sound: ${audio.muted ? 'OFF' : 'ON'}`;
  soundToggle.classList.toggle('on', !audio.muted);
  sensValue.textContent = player.sensitivity.toFixed(4);
}

function changeSensitivity(mult: number): void {
  const value = player?.adjustSensitivity(mult);
  if (value === undefined) return;
  showToast(`Mouse sensitivity: ${value.toFixed(4)}`);
  refreshMenu();
}

// Clicks inside the menu must never resume the game (only the card area does);
// the individual actions below handle their own events.
menuEl.addEventListener('click', (event) => event.stopPropagation());
flyToggle.addEventListener('click', () => {
  if (!player) return;
  player.flying = !player.flying; // session-only: never persisted
  refreshMenu();
});
soundToggle.addEventListener('click', () => {
  audio.toggleMute();
  refreshMenu();
});
sensMinus.addEventListener('click', () => changeSensitivity(1 / 1.1));
sensPlus.addEventListener('click', () => changeSensitivity(1.1));

/** Hotbar slots are clickable whenever the pointer is free (title/pause). */
function syncPointerUi(): void {
  // Read the real lock state from the DOM: this can run before player's own
  // pointerlockchange handler refreshes player.isLocked.
  const locked = document.pointerLockElement !== null;
  hotbarEl.classList.toggle('clickable', state === 'ready' && !locked);
  if (!locked) refreshMenu();
  if (locked) {
    // Drop DOM focus (menu buttons/name input) so stray Enter/keys while
    // playing can't re-trigger them.
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) active.blur();
  } else if (chatOpen) {
    // Focus arrived while the lock was still engaged and was dropped on
    // unlock — (re)focus the chat input now that the lock is really gone.
    chatInput.focus();
  }
}
document.addEventListener('pointerlockchange', syncPointerUi);

// --- networking -------------------------------------------------------------

function applyServerEdits(edits: readonly EditTuple[]): void {
  if (!world || !worldRenderer) return;
  for (const [x, y, z, id] of edits) {
    if (world.getBlock(x, y, z) === id) continue; // no-op (or already applied optimistically)
    worldRenderer.applyEdit(x, y, z, id); // server corrections overwrite
  }
}

function pushChat(from: string, text: string): void {
  chatHistory.push({ from, text });
  if (chatHistory.length > 40) chatHistory.shift();
  chat?.addMessage(from, text);
}

function handleServerMessage(msg: ServerMessage): void {
  switch (msg.type) {
    case 'welcome': {
      const first = world === null;
      if (first) {
        seed = msg.seed;
        firstWelcomeResolve?.(msg);
        firstWelcomeResolve = null;
      } else {
        // (Re)connected mid-session: heal edits missed while offline and
        // rebuild the roster (the server assigned a fresh id).
        applyServerEdits(msg.edits);
        remotePlayers?.applySnapshot(msg.players, msg.playerId);
        showToast('Connected');
      }
      if (document.activeElement !== nameInput) nameInput.value = msg.name;
      break;
    }
    case 'players':
      remotePlayers?.applySnapshot(msg.players, net?.playerId ?? null);
      break;
    case 'blockEdits':
      applyServerEdits(msg.edits);
      break;
    case 'chat':
      pushChat(msg.from, msg.text); // server echoes our own messages back
      break;
    case 'left':
      remotePlayers?.remove(msg.id);
      break;
  }
}

function handleNetMode(mode: NetMode): void {
  if (mode === 'offline') {
    if (firstWelcomeResolve) {
      firstWelcomeResolve(null); // first connect failed → boot into offline mode
      firstWelcomeResolve = null;
    } else if (world !== null) {
      showToast('Offline mode'); // connection lost mid-session
    }
  }
}

function connectFirst(): Promise<WelcomeMsg | null> {
  return new Promise((resolve) => {
    firstWelcomeResolve = resolve;
    net = createNet({
      url: wsUrl(),
      name: loadName(),
      onMessage: handleServerMessage,
      onMode: handleNetMode,
      acceptWelcome: (msg) => !world || msg.seed === seed,
    });
  });
}

// --- interaction ------------------------------------------------------------

function raycastFromCamera(): RayHit | null {
  if (!world) return null;
  const dir = camera.getWorldDirection(new THREE.Vector3());
  return raycast(world, camera.position, dir, REACH);
}

function breakBlock(hit: RayHit): void {
  const id = world!.getBlock(hit.x, hit.y, hit.z);
  if (id === AIR || BLOCKS[id].unbreakable) return;
  worldRenderer!.applyEdit(hit.x, hit.y, hit.z, AIR); // optimistic
  net?.sendBlockEdit(hit.x, hit.y, hit.z, AIR); // server validates + relays
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
 * Applied optimistically, then sent to the server (its correction overwrites).
 * Returns whether the edit was applied.
 */
function tryPlace(x: number, y: number, z: number): boolean {
  if (x < 0 || y < 0 || z < 0 || x >= WORLD_SIZE_X || y >= WORLD_SIZE_Y || z >= WORLD_SIZE_Z) {
    return false;
  }
  if (world!.getBlock(x, y, z) !== AIR) return false;
  if (blockIntersectsPlayer(x, y, z)) return false;
  const id = HOTBAR_BLOCKS[hotbar!.selected];
  worldRenderer!.applyEdit(x, y, z, id);
  net?.sendBlockEdit(x, y, z, id);
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

// --- chat -------------------------------------------------------------------

function openChat(): void {
  if (chatOpen || !player) return;
  chatOpen = true;
  player.overlaySuppressed = true; // keep the pause overlay hidden while typing
  document.exitPointerLock();
  chat?.open();
}

function closeChat(): void {
  if (!chatOpen || !player) return;
  chatOpen = false;
  player.overlaySuppressed = false;
  overlay.classList.toggle('hidden', player.isLocked || player.overlaySuppressed);
  // Re-lock inside the Enter/Esc key gesture; on failure the overlay shows.
  const result = renderer.domElement.requestPointerLock() as unknown as Promise<void> | undefined;
  if (result instanceof Promise) result.catch(() => undefined);
}

chat = createChatUi({
  log: chatLogEl,
  box: chatBoxEl,
  input: chatInput,
  send: (text) => net?.sendChat(text),
  onClose: closeChat,
});

// --- keyboard ---------------------------------------------------------------

window.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement) return; // typing (chat/name)
  if (chatOpen) return;
  const slot = DIGIT_SLOTS.indexOf(event.code);
  if (slot >= 0) hotbar?.select(slot);
  if (event.code === 'KeyM') {
    const muted = audio.toggleMute();
    refreshMenu();
    console.log(`[mc] sound ${muted ? 'muted' : 'on'} (M)`);
  }
  // Mouse sensitivity: `[` coarser, `]` finer (±10% per press, [0.0008, 0.01]).
  if (event.code === 'BracketLeft') changeSensitivity(1 / 1.1);
  if (event.code === 'BracketRight') changeSensitivity(1.1);
  if (event.code === 'KeyF' && player?.isLocked) {
    player.flying = !player.flying; // discoverable fly toggle (session-only)
    showToast(`Flying ${player.flying ? 'ON' : 'OFF'}`);
    refreshMenu();
  }
  if ((event.code === 'Enter' || event.code === 'KeyT') && player?.isLocked) {
    event.preventDefault(); // a bare T must not leak into the freshly focused input
    openChat();
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

// --- movement relay -----------------------------------------------------------

const lastSentMove = { x: NaN, y: NaN, z: NaN, yaw: NaN, pitch: NaN };
let lastMoveSendAt = 0;

function maybeSendMove(now: number): void {
  if (!net?.connected || !player) return;
  if (now - lastMoveSendAt < MOVE_SEND_INTERVAL_MS) return;
  const p = player.pos;
  if (
    Math.abs(p.x - lastSentMove.x) < MOVE_EPS &&
    Math.abs(p.y - lastSentMove.y) < MOVE_EPS &&
    Math.abs(p.z - lastSentMove.z) < MOVE_EPS &&
    Math.abs(player.yaw - lastSentMove.yaw) < MOVE_EPS &&
    Math.abs(player.pitch - lastSentMove.pitch) < MOVE_EPS
  ) {
    return;
  }
  lastMoveSendAt = now;
  lastSentMove.x = p.x;
  lastSentMove.y = p.y;
  lastSentMove.z = p.z;
  lastSentMove.yaw = player.yaw;
  lastSentMove.pitch = player.pitch;
  net.sendMove(p.x, p.y, p.z, player.yaw, player.pitch);
}

// --- boot / world -----------------------------------------------------------

async function boot(): Promise<void> {
  const atlas = await loadAtlas(); // overlay reads "Loading textures…"

  statusEl.textContent = 'Connecting…';
  await nextFrame();
  await nextFrame(); // let the status paint before the synchronous generation

  const welcome = await connectFirst();
  if (welcome) {
    seed = welcome.seed; // server is authoritative for worldgen
  } else {
    showToast('Offline mode');
    console.warn('[mc] no server reachable — offline mode (retrying every 15 s)');
  }

  statusEl.textContent = 'Generating world…';
  await nextFrame();
  await nextFrame(); // let the status paint before the synchronous generation

  world = generateWorld(seed);
  if (welcome) world.applyEdits(welcome.edits); // persistent overlay from the server
  worldRenderer = createWorldRenderer(scene, world, atlas);
  selection = createSelection(scene);
  hotbar = createHotbar(
    hotbarEl,
    HOTBAR_BLOCKS,
    (id) => tileDataUrl(BLOCKS[id].tiles.side),
    { canSelect: () => state === 'ready' && !player?.isLocked },
  );
  remotePlayers = createRemotePlayers(scene);

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
  syncPointerUi();
  refreshMenu();
  window.__mc = {
    world: world!,
    worldRenderer: worldRenderer!,
    raycastFromCamera,
    look: (yaw: number, pitch: number) => player!.look(yaw, pitch),
    camera,
    player: player!,
    tryPlace,
    net: {
      get mode() {
        return net?.mode ?? 'offline';
      },
      get connected() {
        return net?.connected ?? false;
      },
      get id() {
        return net?.playerId ?? null;
      },
      get players() {
        return net?.players ?? [];
      },
    },
    remotePlayers: remotePlayers!.map,
    chat: (text: string) => net?.sendChat(text),
    chatHistory,
  };
  console.log(`[mc] world ready — spawn feet (${spawn.x}, ${spawn.y}, ${spawn.z})`);
}

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
    remotePlayers?.update(now, dt);
    maybeSendMove(now);
    updateSelection();
  }

  render(dt);
  if (state === 'ready') debugOverlay.setInfo(collectDebugInfo());
  debugOverlay.tick(now);
  requestAnimationFrame(frame);
}

function teardown(): void {
  net?.dispose();
  remotePlayers?.dispose();
  chat?.dispose();
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
