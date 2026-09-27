import * as THREE from 'three';
import {
  AIR,
  ARENA,
  BED_BLUE,
  BED_RED,
  BLOCKS,
  CHUNK,
  HOTBAR_BLOCKS,
  PARTY,
  PLANKS,
  PROTOCOL_VERSION,
  SHOP_ITEMS,
  WORLD_SIZE_X,
  WORLD_SIZE_Y,
  WORLD_SIZE_Z,
  WOOL_WHITE,
  bedTeamOf,
  generateBedwarsArena,
  generatePartyWorld,
  generateWorld,
  raycast,
  type EditTuple,
  type GameEventMsg,
  type GameMode,
  type HeldItemId,
  type ModeChangedMsg,
  type RayHit,
  type ServerMessage,
  type ShopItemId,
  type WelcomeMsg,
  type World,
} from '@mc/shared';
import { createRenderer } from './renderer';
import { createPlayer, PLAYER_HALF_WIDTH, PLAYER_HEIGHT, type Player } from './player';
import { createDayNight } from './daynight';
import { blockSoundKind, createGameAudio, type GameAudio } from './audio';
import { createDebugOverlay, type DebugInfo } from './debug';
import { loadAtlas, tileDataUrl, type Atlas } from './atlas';
import { createWorldRenderer, type WorldRenderer } from './world/worldRenderer';
import { createSelection, type Selection } from './selection';
import { createHotbar, type Hotbar } from './hotbar';
import { createNet, wsUrl, type Net, type NetMode } from './net';
import { createRemotePlayers, type RemoteAvatar, type RemotePlayers } from './remotePlayer';
import { createChatUi, type ChatUi } from './chat';
import { createBwHotbar, type BwHotbar, type BwItemView } from './bwHotbar';
import { createBedwarsUi, type BedwarsUi } from './bedwarsUi';
import { createBwState, type BwState } from './bwState';
import { createPartyState, type PartyState } from './partyState';
import { createPartyUi, setPartyTickState, type PartyUi } from './partyUi';
import { nameColor, playerColor } from './identity';
import { TARGET_HALF_WIDTH, TARGET_HEIGHT, rayVsAabb } from './combat';
import swordBronzeUrl from '../assets/kenney/items/sword_bronze.png';
import swordSilverUrl from '../assets/kenney/items/sword_silver.png';
import swordIronUrl from '../assets/kenney/items/sword_iron.png';
import appleUrl from '../assets/kenney/items/apple.png';
import oreIronUrl from '../assets/kenney/items/ore_iron.png';
import oreGoldUrl from '../assets/kenney/items/ore_gold.png';
import oreEmeraldUrl from '../assets/kenney/items/ore_emerald.png';

console.log(`minecraft-mini client (protocol v${PROTOCOL_VERSION})`);

const OFFLINE_SEED = 1337; // also the server's seed — worlds match either way
const REACH = 5; // blocks
const ATTACK_REACH = 3.5; // melee: nearest remote-player AABB within this, before any block
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
const bwStart = document.querySelector<HTMLButtonElement>('#bw-start')!;
const partyStart = document.querySelector<HTMLButtonElement>('#party-start')!;
const bwLeave = document.querySelector<HTMLButtonElement>('#bw-leave')!;
const botAdd = document.querySelector<HTMLButtonElement>('#bot-add')!;
const botRemove = document.querySelector<HTMLButtonElement>('#bot-remove')!;
const matchHint = document.querySelector<HTMLParagraphElement>('#match-hint')!;
const modeBadge = document.querySelector<HTMLDivElement>('#mode-badge')!;
const playerListEl = document.querySelector<HTMLDivElement>('#player-list')!;
const chatLogEl = document.querySelector<HTMLDivElement>('#chat-log')!;
const chatBoxEl = document.querySelector<HTMLDivElement>('#chat-box')!;
const chatInput = document.querySelector<HTMLInputElement>('#chat-input')!;

const { renderer, scene, camera, render, dispose, sun, hemisphere, setSkyColor } = createRenderer(app);
const dayNight = createDayNight({ sun, hemisphere, setSkyColor });
const audio = createGameAudio();
const debugOverlay = createDebugOverlay(debug);

/** Kenney item icons (client/assets/kenney/items/) used by the BedWars HUD. */
const ITEM_ICONS: Record<string, string> = {
  sword_bronze: swordBronzeUrl,
  sword_silver: swordSilverUrl,
  sword_iron: swordIronUrl,
  apple: appleUrl,
  ore_iron: oreIronUrl,
  ore_gold: oreGoldUrl,
  ore_emerald: oreEmeraldUrl,
};

/** Resolves shop icon specs: 'tile:<atlas tile>' or 'item:<kenney items basename>'. */
function itemIcon(spec: string): string {
  const colon = spec.indexOf(':');
  if (colon < 0) return '';
  const [kind, name] = [spec.slice(0, colon), spec.slice(colon + 1)];
  if (kind === 'tile') return tileDataUrl(name);
  return ITEM_ICONS[name] ?? '';
}

/** Test/automation hooks (also available in the LAN build for smoke tests). */
declare global {
  interface Window {
    __mc?: {
      world: World;
      worldRenderer: WorldRenderer;
      raycastFromCamera(): RayHit | null;
      look(yaw: number, pitch: number): void;
      /** Aim the camera at a world point (test helper for melee attacks). */
      lookAt(x: number, y: number, z: number): void;
      camera: THREE.PerspectiveCamera;
      player: Player;
      /** Validated placement (bounds + occupancy + player overlap). */
      tryPlace(x: number, y: number, z: number): boolean;
      /** Sends a break edit (bed-team rules in bedwars; server validates). */
      breakBlockAt(x: number, y: number, z: number): boolean;
      /** Full left-click melee path: raycast → attack send. True when a target was hit. */
      tryAttack(): boolean;
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
      /** Current game mode ('sandbox' | 'bedwars' | 'party'). */
      readonly mode: GameMode;
      /** BedWars state mirror (null outside bedwars). */
      readonly bw: BwState | null;
      /** Block Party state mirror (null outside party). */
      readonly party: PartyState | null;
      /** Menu-button paths. */
      startBedwars(): void;
      startParty(): void;
      leaveGame(): void;
      ready(): void;
      buy(item: ShopItemId): void;
      useHeld(): void;
      /** BedWars hotbar + held item. */
      selectSlot(index: number): void;
      held(): HeldItemId;
      /** Shop panel (B key path). */
      openShop(): boolean;
      closeShop(): void;
      readonly isShopOpen: boolean;
      /** Opens the chat input without requiring pointer lock (tests). */
      openChat(): void;
    };
  }
}

type BootState = 'connecting' | 'building' | 'ready' | 'switching';
let state: BootState = 'connecting';
let gameMode: GameMode = 'sandbox';
let seed = OFFLINE_SEED;
let atlas: Atlas | null = null;
/** Sandbox world + renderer — kept alive across matches (hidden, meshes intact). */
let sandboxWorld: World | null = null;
let sandboxRenderer: WorldRenderer | null = null;
/** BedWars arena world + renderer — disposed when the match ends. */
let arenaWorld: World | null = null;
let arenaRenderer: WorldRenderer | null = null;
let world: World | null = null;
let worldRenderer: WorldRenderer | null = null;let selection: Selection | null = null;
let hotbar: Hotbar | null = null;
let player: Player | null = null;
let net: Net | null = null;
let remotePlayers: RemotePlayers | null = null;
let chat: ChatUi | null = null;
let chatOpen = false;
const chatHistory: { from: string; text: string }[] = [];
/** Previous roster — the diff drives the "✦ joined/left" chat lines. */
let prevRosterIds = new Set<number>();
let prevRosterNames = new Map<number, string>();
let spawn = { x: SPAWN_X + 0.5, y: 40, z: SPAWN_Z + 0.5 };
let totalToBuild = 0;
let currentTarget: RayHit | null = null;

// --- BedWars (M4) ---
let bwState: BwState | null = null;
let bwUi: BedwarsUi | null = null;
let bwHotbar: BwHotbar | null = null;

// --- Block Party (M5) ---
let partyState: PartyState | null = null;
let partyUi: PartyUi | null = null;

/** Teleport target for the player once a switched-to world finished meshing. */
let pendingSpawn: { x: number; y: number; z: number } | null = null;

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

function pulseCrosshair(): void {
  crosshairEl.classList.remove('pulse');
  void crosshairEl.offsetWidth; // restart the animation
  crosshairEl.classList.add('pulse');
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
/** True when creative fly may be toggled in the current mode: always in the
 * sandbox; in party only while eliminated (free-fly spectating). */
function flyAllowedNow(): boolean {
  if (gameMode === 'sandbox') return true;
  if (gameMode === 'party') return partyState !== null && !partyState.meAlive();
  return false; // bedwars
}

menuEl.addEventListener('click', (event) => event.stopPropagation());
flyToggle.addEventListener('click', () => {
  if (!player) return;
  if (!flyAllowedNow()) {
    showToast(
      gameMode === 'party'
        ? 'Flying unlocks when you are eliminated (spectate)'
        : 'Flying is disabled in BedWars',
    );
    return;
  }
  player.flying = !player.flying; // session-only: never persisted
  refreshMenu();
});
soundToggle.addEventListener('click', () => {
  audio.toggleMute();
  refreshMenu();
});
sensMinus.addEventListener('click', () => changeSensitivity(1 / 1.1));
sensPlus.addEventListener('click', () => changeSensitivity(1.1));

// --- match menu buttons -------------------------------------------------------

/** True when the server-driven test bot is in the roster (flagged or "Bot "-prefixed). */
function botOnline(): boolean {
  return (net?.players ?? []).some((p) => p.bot === true || p.name.startsWith('Bot '));
}

function humansOnline(): number {
  return (net?.players ?? []).filter((p) => p.bot !== true && !p.name.startsWith('Bot ')).length;
}

/**
 * 'Play BedWars 1v1' / 'Play Block Party 1v1' + the test-bot row. The hint
 * encodes the practice-vs-real distinction (1 human = practice; +bot or a
 * second human = real 1v1).
 */
function refreshBwButtons(): void {
  const online = net?.connected === true;
  const count = net?.players.length ?? 0;
  const humans = humansOnline();
  const bot = botOnline();
  const idle = gameMode === 'sandbox';
  bwStart.disabled = !online || !idle;
  partyStart.disabled = !online || !idle;
  const soloTitle = bot
    ? 'Start a real 1v1 against the test bot'
    : 'Solo practice (a test bot or a second player makes it a real match)';
  bwStart.title = !online ? 'Offline — connect to a server to play matches' : count < 2 ? soloTitle : 'Start a BedWars 1v1 match';
  partyStart.title = !online ? 'Offline — connect to a server to play matches' : count < 2 ? soloTitle : 'Start a Block Party 1v1 match';
  matchHint.textContent = !online
    ? 'Offline — start the server for multiplayer'
    : humans < 2 && bot
      ? 'Real 1v1 vs bot — go!'
      : humans < 2
        ? 'Solo practice — add a test bot (or open a second tab) for a real 1v1'
        : `Real 1v1 — ready! (${count} players online)`;
  bwLeave.classList.toggle('hidden', gameMode === 'sandbox');
  botAdd.classList.toggle('hidden', !online || bot);
  botAdd.disabled = !online || bot;
  botRemove.classList.toggle('hidden', !online || !bot);
  botRemove.disabled = !online || !bot;
}

function startBedwars(): void {
  if (gameMode !== 'sandbox') return;
  // The server rejects (toast-able error event) unless exactly 2 are online.
  net?.sendStartGame('bedwars');
}

function startParty(): void {
  if (gameMode !== 'sandbox') return;
  net?.sendStartGame('party');
}

function leaveGame(): void {
  net?.sendLeaveGame(); // server swaps everyone back with modeChanged sandbox
}

bwStart.addEventListener('click', (event) => {
  event.stopPropagation();
  startBedwars();
});
partyStart.addEventListener('click', (event) => {
  event.stopPropagation();
  startParty();
});
bwLeave.addEventListener('click', (event) => {
  event.stopPropagation();
  leaveGame();
});
botAdd.addEventListener('click', (event) => {
  event.stopPropagation();
  net?.sendAddBot(); // server spawns "Bot Steve" and broadcasts the roster
});
botRemove.addEventListener('click', (event) => {
  event.stopPropagation();
  net?.sendRemoveBot(); // mid-match this counts as the bot disconnecting
});

/** Persistent "where am I" HUD badge — updated on every mode change. */
function refreshModeBadge(): void {
  modeBadge.textContent =
    gameMode === 'bedwars' ? 'BedWars 1v1' : gameMode === 'party' ? 'Block Party 1v1' : 'Sandbox';
  modeBadge.classList.toggle('match', gameMode !== 'sandbox');
  modeBadge.classList.remove('hidden');
}

/** Hotbar slots are clickable whenever the pointer is free (title/pause). */
function syncPointerUi(): void {
  // Read the real lock state from the DOM: this can run before player's own
  // pointerlockchange handler refreshes player.isLocked.
  const locked = document.pointerLockElement !== null;
  hotbarEl.classList.toggle('clickable', state === 'ready' && !locked);
  if (!locked) {
    refreshMenu();
    refreshBwButtons();
  }
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

/** Identity color for a chat sender: roster id when known, else name hash. */
function chatSenderColor(from: string): string {
  const known = (net?.players ?? []).find((p) => p.name === from);
  return known ? playerColor(known.id) : nameColor(from);
}

function pushChat(from: string, text: string): void {
  chatHistory.push({ from, text });
  if (chatHistory.length > 50) chatHistory.shift();
  chat?.addMessage(from, text, { color: chatSenderColor(from) });
}

/** Dimmed system line ("✦ Steve joined") — never from a player. */
function pushSystemLine(text: string): void {
  chatHistory.push({ from: '', text });
  if (chatHistory.length > 50) chatHistory.shift();
  chat?.addMessage('', text, { system: true });
}

/** Roster diff → join/leave chat lines, so connecting tabs are visible. */
function syncRosterChat(): void {
  const roster = net?.players ?? [];
  const ids = new Set(roster.map((p) => p.id));
  for (const p of roster) {
    if (!prevRosterIds.has(p.id)) pushSystemLine(`✦ ${p.name} joined`);
  }
  for (const id of prevRosterIds) {
    if (!ids.has(id)) pushSystemLine(`✦ ${prevRosterNames.get(id) ?? 'Someone'} left`);
  }
  prevRosterIds = ids;
  prevRosterNames = new Map(roster.map((p) => [p.id, p.name]));
}

// --- Tab player list ---------------------------------------------------------

let tabListShown = false;
let tabListRenderedAt = 0;

/** Mode-context column: bedwars team/hp/eliminated, party rounds/fell. */
function playerListInfo(id: number): string {
  if (gameMode === 'bedwars' && bwState) {
    const p = bwState.player(id);
    if (!p) return '';
    return !p.alive ? 'eliminated' : `${p.team === 0 ? 'red' : 'blue'} · ${p.hp} hp`;
  }
  if (gameMode === 'party' && partyState) {
    const p = partyState.player(id);
    if (!p) return '';
    const rounds = `${p.score} round${p.score === 1 ? '' : 's'}`;
    return p.alive ? rounds : `fell · ${rounds}`;
  }
  return '';
}

function renderPlayerList(): void {
  const roster = [...(net?.players ?? [])].sort((a, b) => a.id - b.id);
  const myId = net?.playerId ?? null;
  playerListEl.replaceChildren();
  const title = document.createElement('h3');
  title.textContent = `Online — ${roster.length}`;
  playerListEl.appendChild(title);
  for (const p of roster) {
    const row = document.createElement('div');
    row.className = 'pl-row';
    const name = document.createElement('span');
    name.className = 'pl-name';
    name.style.color = playerColor(p.id); // same identity color as the nameplate
    name.textContent = p.name;
    const tag = document.createElement('span');
    tag.className = 'pl-tag';
    tag.textContent = p.bot ? ' (Bot)' : p.id === myId ? ' (you)' : '';
    if (tag.textContent) name.appendChild(tag);
    const info = document.createElement('span');
    info.className = 'pl-info';
    info.textContent = playerListInfo(p.id);
    row.append(name, info);
    playerListEl.appendChild(row);
  }
}

function showPlayerList(): void {
  tabListShown = true;
  renderPlayerList();
  playerListEl.classList.remove('hidden');
}

function hidePlayerList(): void {
  tabListShown = false;
  playerListEl.classList.add('hidden');
}

window.addEventListener('keyup', (event) => {
  if (event.code === 'Tab') hidePlayerList(); // hold Tab to peek (Minecraft-style)
});
window.addEventListener('blur', hidePlayerList);

// --- BedWars client state / UI ------------------------------------------------

function bwHotbarItems(): BwItemView[] {
  const inv = bwState?.inv ?? { wool: 0, planks: 0, apples: 0, sword: null };
  const swordSpec =
    inv.sword === 'wooden' ? 'item:sword_bronze' : inv.sword === 'stone' ? 'item:sword_silver' : inv.sword === 'iron' ? 'item:sword_iron' : null;
  return [
    { key: 'wool', iconUrl: itemIcon('tile:snow'), label: 'Wool', count: inv.wool },
    { key: 'planks', iconUrl: itemIcon('tile:wood'), label: 'Planks', count: inv.planks },
    { key: 'sword', iconUrl: swordSpec !== null ? itemIcon(swordSpec) : null, label: 'Sword', count: null, muted: !inv.sword },
    { key: 'apple', iconUrl: itemIcon('item:apple'), label: 'Golden Apple', count: inv.apples },
  ];
}

function updateHeldIcon(): void {
  if (gameMode !== 'bedwars' || !bwHotbar || !bwUi) return;
  const item = bwHotbar.items[bwHotbar.selected];
  if (!item || item.iconUrl === null || item.muted) {
    bwUi.setHeld(null, null);
    return;
  }
  bwUi.setHeld(item.iconUrl, item.count);
}

/** The item id reported with attacks (server validates ownership + damage). */
function bwHeldItem(): HeldItemId {
  if (!bwState || !bwHotbar) return 'fist';
  const inv = bwState.inv;
  switch (bwHotbar.selected) {
    case 0:
      return inv.wool > 0 ? 'wool' : 'fist';
    case 1:
      return inv.planks > 0 ? 'planks' : 'fist';
    case 2:
      return inv.sword !== null ? `${inv.sword}_sword` : 'fist';
    case 3:
      return inv.apples > 0 ? 'golden_apple' : 'fist';
    default:
      return 'fist';
  }
}

/** Local optimistic consumption of one placed block (server corrects anyway). */
function bwConsumeBlock(id: number): void {
  const me = bwState?.me();
  if (!me) return;
  if (id === WOOL_WHITE && me.inventory.wool > 0) me.inventory.wool--;
  else if (id === PLANKS && me.inventory.planks > 0) me.inventory.planks--;
  bwHotbar?.setItems(bwHotbarItems());
}

function makeSandboxHotbar(): Hotbar {
  return createHotbar(
    hotbarEl,
    HOTBAR_BLOCKS,
    (id) => tileDataUrl(BLOCKS[id].tiles.side),
    { canSelect: () => state === 'ready' && !player?.isLocked },
  );
}

/** Shop panel open/close (B key). Exits pointer lock while open, like chat. */
function toggleShopUi(): void {
  if (!bwState || !bwUi || !player) return;
  if (bwUi.isShopOpen) {
    bwUi.closeShop();
    player.overlaySuppressed = false;
    overlay.classList.toggle('hidden', player.isLocked);
    const result = renderer.domElement.requestPointerLock() as unknown as Promise<void> | undefined;
    if (result instanceof Promise) result.catch(() => undefined);
    return;
  }
  const shop = ARENA.shopPoints[bwState.myTeam];
  if (!shop || bwState.myTeam < 0) return;
  const dist = Math.hypot(player.pos.x - shop.x, player.pos.y - shop.y, player.pos.z - shop.z);
  if (dist > ARENA.shopRadius + 1) {
    showToast('Walk to the planks pad on your island to trade');
    return;
  }
  document.exitPointerLock();
  player.overlaySuppressed = true; // keep the pause overlay hidden behind the shop
  bwUi.toggleShop(bwState);
}

function handleGameEvent(msg: GameEventMsg): void {
  // Toast-able rejections (startGame with ≠2 players, poor buys) arrive even
  // outside matches — handle before the bwState guard.
  if (msg.kind === 'error') {
    showToast(msg.message);
    return;
  }
  if (gameMode === 'party') {
    handlePartyEvent(msg);
    return;
  }
  if (!bwState) return;
  bwState.recordEvent(msg);
  if (!bwUi) return;
  switch (msg.kind) {
    case 'countdown': {
      if (msg.seconds > 0) {
        bwUi.banner(String(msg.seconds), { ms: 1000 });
        audio.beep(880);
      } else {
        bwUi.banner('FIGHT!', { ms: 1200, tone: 'good' });
        audio.fight();
      }
      break;
    }
    case 'bedBroken': {
      const mine = msg.team === bwState.myTeam;
      bwUi.banner(mine ? 'YOUR BED WAS DESTROYED!' : 'ENEMY BED DESTROYED!', { tone: mine ? 'bad' : 'good', ms: 2400 });
      bwUi.killfeed(`${msg.by} broke the ${msg.team === 0 ? 'RED' : 'BLUE'} bed!`);
      bwState.bedsAlive[msg.team] = false;
      audio.bedBreak();
      break;
    }
    case 'death': {
      const victim = bwState.player(msg.playerId);
      const killer = bwState.player(msg.killerId);
      const what = msg.cause === 'void' ? 'fell into the void' : 'was slain';
      bwUi.killfeed(`${killer ? `${killer.name}: ` : ''}${victim?.name ?? 'Someone'} ${what}`);
      if (msg.playerId === bwState.myId) {
        audio.deathSound();
        if (player) player.controlsEnabled = false; // freeze until respawn
        if (msg.respawnIn > 0) bwUi.respawn(msg.respawnIn);
      } else if (msg.killerId !== null && msg.killerId === bwState.myId) {
        audio.hit();
      }
      break;
    }
    case 'respawn': {
      if (msg.playerId === bwState.myId) {
        const spawnPoint = bwState.spawns[bwState.myTeam];
        if (spawnPoint && player) {
          player.teleport(spawnPoint.x, spawnPoint.y, spawnPoint.z);
          player.controlsEnabled = true;
        }
        bwUi.respawn(null);
        audio.beep(660);
      }
      break;
    }
    case 'knockback': {
      if (msg.playerId === bwState.myId && player) {
        player.vel.x += msg.dir.x * msg.power;
        player.vel.y += msg.dir.y * msg.power;
        player.vel.z += msg.dir.z * msg.power;
      }
      break;
    }
    case 'purchase': {
      const item = SHOP_ITEMS.find((entry) => entry.id === msg.item);
      if (msg.playerId === bwState.myId) {
        audio.purchase();
        showToast(`Purchased ${item?.name ?? msg.item}`);
      } else {
        const buyer = bwState.player(msg.playerId);
        bwUi.killfeed(`${buyer?.name ?? 'Someone'} bought ${item?.name ?? msg.item}`);
      }
      break;
    }
    case 'heal': {
      if (msg.playerId === bwState.myId) audio.eat();
      break;
    }
    case 'matchEnd': {
      bwState.results = { winnerId: msg.winnerId, winnerName: msg.winnerName, stats: msg.stats };
      const won = msg.winnerId === bwState.myId;
      bwUi.banner(won ? 'VICTORY!' : 'DEFEAT', { tone: won ? 'good' : 'bad', ms: 2600 });
      if (won) audio.win();
      else audio.lose();
      if (player) {
        player.controlsEnabled = false; // park both players behind the results
        document.exitPointerLock();
        player.overlaySuppressed = true; // results screen replaces the pause menu
      }
      bwUi.results(bwState.results, bwState.myId);
      break;
    }
  }
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
        if (gameMode !== 'sandbox' && sandboxRenderer) {
          // Sandbox heal-ups apply to the parked sandbox world (they will
          // remesh when it becomes visible again); match worlds stream their own.
          for (const [x, y, z, id] of msg.edits) sandboxRenderer.applyEdit(x, y, z, id);
        } else {
          applyServerEdits(msg.edits);
        }
        remotePlayers?.applySnapshot(msg.players, msg.playerId);
        showToast('Connected');
      }
      if (document.activeElement !== nameInput) nameInput.value = msg.name;
      syncRosterChat();
      refreshBwButtons();
      break;
    }
    case 'players':
      remotePlayers?.applySnapshot(msg.players, net?.playerId ?? null);
      syncRosterChat();
      refreshBwButtons();
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
    case 'modeChanged':
      if (msg.mode === 'bedwars') enterBedwars(msg);
      else if (msg.mode === 'party') enterParty(msg);
      else exitToSandbox(msg);
      break;
    case 'gameState': {
      if (gameMode === 'party' && partyState) {
        if (msg.party) {
          partyState.applyGameState(msg);
          partyUi?.sync(partyState);
        }
        break;
      }
      if (!bwState) break;
      const prevHp = bwState.me()?.hp;
      const wasAlive = bwState.me()?.alive ?? true;
      bwState.applyGameState(msg);
      bwUi?.sync(bwState);
      bwHotbar?.setItems(bwHotbarItems());
      updateHeldIcon();
      const me = bwState.me();
      if (me && prevHp !== undefined && me.hp < prevHp && me.alive) {
        bwUi?.hurt();
        audio.hurt();
      }
      if (me && !me.alive) bwUi?.respawn(me.respawnIn > 0 ? me.respawnIn : null);
      else if (me && me.alive && wasAlive) bwUi?.respawn(null);
      break;
    }
    case 'gameEvent':
      handleGameEvent(msg);
      break;
  }
}

// --- world switching (sandbox ⇄ BedWars arena) ---------------------------------

/** Swaps every client into a fresh BedWars arena (modeChanged bedwars). */
function enterBedwars(msg: ModeChangedMsg): void {
  if (!sandboxWorld || !sandboxRenderer || !atlas || !player) return;
  if (state !== 'ready' && state !== 'switching') return; // still booting

  gameMode = 'bedwars';
  bwState = createBwState();
  bwState.applyModeChanged(msg, net?.playerId ?? null);
  bwUi?.results(null, null);
  // Clear any party leftovers (modes never overlap, but be tidy).
  partyState = null;
  setPartyTickState(null);
  partyUi?.show(false);
  bwUi?.setPartyFeed(false);

  arenaWorld = generateBedwarsArena(msg.seed);
  arenaWorld.applyEdits(msg.edits);
  arenaRenderer?.dispose();
  arenaRenderer = createWorldRenderer(scene, arenaWorld, atlas);

  // Swap the active pair; the sandbox meshes stay parked (hidden, intact).
  world = arenaWorld;
  sandboxRenderer.setVisible(false);
  worldRenderer = arenaRenderer;
  player.setWorld(arenaWorld);
  player.flyAllowed = false; // also forces flying off

  // UI: hotbar swap + HUD.
  hotbar?.dispose();
  hotbar = null;
  bwHotbar = createBwHotbar(hotbarEl, bwHotbarItems(), {
    canSelect: () => state === 'ready' && !player?.isLocked,
    onSelect: () => updateHeldIcon(),
  });
  bwUi?.showHud(true);
  if (bwState && bwUi) bwUi.sync(bwState);
  updateHeldIcon();

  // Park the player during the build, then drop them on their spawn.
  const team = bwState.myTeam;
  const spawnPoint = team >= 0 && bwState.spawns[team] ? bwState.spawns[team] : ARENA.spectatorSpawn;
  pendingSpawn = { x: spawnPoint.x, y: spawnPoint.y, z: spawnPoint.z };
  player.controlsEnabled = false;
  document.exitPointerLock();
  player.overlaySuppressed = false;

  worldRenderer.enqueueAllChunks();
  totalToBuild = worldRenderer.pendingCount;
  state = 'switching';
  overlay.classList.add('loading');
  statusEl.textContent = 'Building arena…';
  selection?.hide();
  currentTarget = null;
  refreshBwButtons();
  refreshModeBadge();
  refreshMenu();
}

// --- Block Party (M5) client state ---------------------------------------------

/** My party spawn (slot 0/1) or the spectator platform. */
function partySpawnPoint(): { x: number; y: number; z: number } {
  if (!partyState) return ARENA.spectatorSpawn;
  const slot = partyState.myTeam;
  if ((slot === 0 || slot === 1) && partyState.spawns[slot]) {
    const spawnPoint = partyState.spawns[slot];
    return { x: spawnPoint.x, y: spawnPoint.y, z: spawnPoint.z };
  }
  return { ...PARTY.spectatorSpawn };
}

/** Round events: re-centering, spectate fly, sounds, banners, results. */
function handlePartyEvent(msg: GameEventMsg): void {
  if (!partyState || !partyUi) return;
  partyState.recordEvent(msg);
  const me = partyState.myId;
  switch (msg.kind) {
    case 'roundStart': {
      // Both fighters reset: alive, grounded, re-centered (server teleports
      // its own roster copy; movement is client-authoritative).
      if (player && partyState.myTeam >= 0) {
        const spawnPoint = partySpawnPoint();
        player.teleport(spawnPoint.x, spawnPoint.y, spawnPoint.z);
        player.setSpawn(spawnPoint);
        player.flyAllowed = false;
        player.flying = false;
        player.controlsEnabled = true;
      }
      bwUi?.banner(`Round ${msg.round}`, { ms: 1300 });
      bwUi?.killfeed(`Round ${msg.round} — first to 3 wins the match`);
      audio.beep(660);
      break;
    }
    case 'drop': {
      audio.whoosh();
      break;
    }
    case 'death': {
      const victim = partyState.player(msg.playerId);
      bwUi?.killfeed(`${victim?.name ?? 'Someone'} fell into the void!`);
      if (msg.playerId === me && player) {
        audio.deathSound();
        // Spectate for the rest of the round: free-fly from the platform.
        const point = { ...PARTY.spectatorSpawn };
        player.teleport(point.x, point.y, point.z);
        player.setSpawn(point);
        player.flyAllowed = true;
        player.flying = true;
        showToast('You fell! Fly around and watch the round');
      }
      break;
    }
    case 'roundResult': {
      const fellMine = msg.fallers.includes(me ?? -1);
      if (msg.draw) {
        bwUi?.banner('Draw — replay!', { tone: 'neutral', ms: 2000 });
        audio.beep(440);
      } else if (msg.survivorId === me) {
        bwUi?.banner('You won the round!', { tone: 'good', ms: 2000 });
        audio.roundWin();
      } else {
        bwUi?.banner(fellMine ? 'You fell!' : 'Round lost', { tone: 'bad', ms: 2000 });
      }
      break;
    }
    case 'matchEnd': {
      partyState.results = { winnerId: msg.winnerId, winnerName: msg.winnerName, stats: msg.stats };
      const won = msg.winnerId === me;
      bwUi?.banner(won ? 'VICTORY!' : 'DEFEAT', { tone: won ? 'good' : 'bad', ms: 2600 });
      if (won) audio.win();
      else audio.lose();
      if (player) {
        player.controlsEnabled = false; // park both players behind the results
        player.flying = false;
        document.exitPointerLock();
        player.overlaySuppressed = true; // results screen replaces the pause menu
      }
      bwUi?.results(partyState.results, me);
      break;
    }
    default:
      break;
  }
}

/** Swaps every client into the Block Party void world (modeChanged party). */
function enterParty(msg: ModeChangedMsg): void {
  if (!sandboxWorld || !sandboxRenderer || !atlas || !player) return;
  if (state !== 'ready' && state !== 'switching') return; // still booting

  gameMode = 'party';
  partyState = createPartyState();
  partyState.applyModeChanged(msg, net?.playerId ?? null);
  partyUi?.show(true);
  setPartyTickState(partyState);
  bwUi?.results(null, null); // clear any previous match's screen
  bwUi?.showHud(true); // reuse the frame for the shared kill feed…
  bwUi?.setPartyFeed(true); // …but show only the feed

  arenaWorld = generatePartyWorld();
  arenaWorld.applyEdits(msg.edits); // spectator platform + the round-1 floor
  arenaRenderer?.dispose();
  arenaRenderer = createWorldRenderer(scene, arenaWorld, atlas);

  // Swap the active pair; the sandbox meshes stay parked (hidden, intact).
  world = arenaWorld;
  sandboxRenderer.setVisible(false);
  worldRenderer = arenaRenderer;
  player.setWorld(arenaWorld);
  player.flyAllowed = false; // spectate-fly unlocks on elimination

  // No hotbars in party — the announced color lives in the dedicated HUD slot.
  hotbar?.dispose();
  hotbar = null;
  bwHotbar?.dispose();
  bwHotbar = null;

  // Park the player during the build, then drop them on their spawn slot.
  const spawnPoint = partySpawnPoint();
  pendingSpawn = spawnPoint;
  player.controlsEnabled = false;
  document.exitPointerLock();
  player.overlaySuppressed = false;

  worldRenderer.enqueueAllChunks();
  totalToBuild = worldRenderer.pendingCount;
  state = 'switching';
  overlay.classList.add('loading');
  statusEl.textContent = 'Building the dance floor…';
  selection?.hide();
  currentTarget = null;
  refreshBwButtons();
  refreshModeBadge();
  refreshMenu();
}

/** Back to the sandbox (modeChanged sandbox): instant — the parked meshes return. */
function exitToSandbox(msg: ModeChangedMsg): void {
  if (!sandboxWorld || !sandboxRenderer || !player) return;

  gameMode = 'sandbox';
  arenaRenderer?.dispose();
  arenaRenderer = null;
  arenaWorld = null;
  bwState = null;
  partyState = null;
  setPartyTickState(null);
  partyUi?.show(false);
  pendingSpawn = null;

  world = sandboxWorld;
  worldRenderer = sandboxRenderer;
  sandboxRenderer.setVisible(true);
  for (const [x, y, z, id] of msg.edits) sandboxRenderer.applyEdit(x, y, z, id); // heals no-ops

  player.setWorld(sandboxWorld);
  player.flyAllowed = true;
  player.flying = false;
  player.controlsEnabled = true;
  player.overlaySuppressed = false;
  // Sync overlay visibility NOW: the pointerlockchange listener only runs on
  // lock changes, so leaving a match while unlocked-but-suppressed (e.g. the
  // results screen after a shop pointer lock) would otherwise hide the
  // click-to-play card for good.
  overlay.classList.toggle('hidden', player.isLocked || player.overlaySuppressed);
  player.setSpawn(spawn);
  player.teleport(spawn.x, spawn.y, spawn.z);

  bwHotbar?.dispose();
  bwHotbar = null;
  bwUi?.setPartyFeed(false);
  bwUi?.showHud(false);
  bwUi?.results(null, null);
  if (!hotbar) hotbar = makeSandboxHotbar();

  document.exitPointerLock();
  state = 'ready';
  statusEl.textContent = 'Click to play';
  overlay.classList.remove('loading');
  syncPointerUi();
  refreshBwButtons();
  refreshModeBadge();
  refreshMenu();
}

/** A switched-to world finished meshing — drop the player at their spawn. */
function finishSwitch(): void {
  state = 'ready';
  if (pendingSpawn && player) {
    player.teleport(pendingSpawn.x, pendingSpawn.y, pendingSpawn.z);
    player.setSpawn(pendingSpawn); // void-fallback warp lands somewhere sane
    player.controlsEnabled = true;
    pendingSpawn = null;
  }
  statusEl.textContent = 'Click to play';
  overlay.classList.remove('loading');
  syncPointerUi();
  refreshMenu();
  refreshBwButtons();
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
  if (id === AIR) return;
  if (gameMode === 'bedwars') {
    const bedTeam = bedTeamOf(id);
    if (bedTeam >= 0) {
      if (bedTeam === bwState?.myTeam) {
        showToast("You can't break your own bed!");
        return;
      }
      // Enemy bed: optimistic remove; the server confirms to everyone (and
      // the bedBroken event drives the banner + sound).
      worldRenderer!.applyEdit(hit.x, hit.y, hit.z, AIR);
      net?.sendBlockEdit(hit.x, hit.y, hit.z, AIR);
      return;
    }
  } else if (BLOCKS[id].unbreakable) {
    return;
  }
  worldRenderer!.applyEdit(hit.x, hit.y, hit.z, AIR); // optimistic
  net?.sendBlockEdit(hit.x, hit.y, hit.z, AIR); // server validates + relays
  audio.blockBreak(blockSoundKind(id));
}

/** Break helper for tests/tools: bed-team rules in bedwars, unbreakable in sandbox. */
function breakBlockAt(x: number, y: number, z: number): boolean {
  if (!world || !worldRenderer) return false;
  if (gameMode === 'party') return false; // the dance floor is server-owned
  const id = world.getBlock(x, y, z);
  if (id === AIR) return false;
  if (gameMode === 'bedwars' && bedTeamOf(id) === bwState?.myTeam) return false;
  if (gameMode !== 'bedwars' && BLOCKS[id].unbreakable) return false;
  worldRenderer.applyEdit(x, y, z, AIR);
  net?.sendBlockEdit(x, y, z, AIR);
  return true;
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

/** Placement block for the bedwars hotbar (wool/planks while in stock). */
function bwPlaceId(): number | null {
  if (!bwHotbar || !bwState) return null;
  const inv = bwState.inv;
  if (bwHotbar.selected === 0 && inv.wool > 0) return WOOL_WHITE;
  if (bwHotbar.selected === 1 && inv.planks > 0) return PLANKS;
  return null;
}

/**
 * Validates and applies a placement into cell (x, y, z): world bounds, target
 * must be air, and the cell must not intersect the player AABB (the M1 gap).
 * Applied optimistically, then sent to the server (its correction overwrites).
 * Returns whether the edit was applied.
 */
function tryPlace(x: number, y: number, z: number): boolean {
  if (gameMode === 'party') return false; // no building during Block Party
  if (x < 0 || y < 0 || z < 0 || x >= WORLD_SIZE_X || y >= WORLD_SIZE_Y || z >= WORLD_SIZE_Z) {
    return false;
  }
  if (world!.getBlock(x, y, z) !== AIR) return false;
  if (blockIntersectsPlayer(x, y, z)) return false;
  let id: number;
  if (gameMode === 'bedwars') {
    const bwId = bwPlaceId();
    if (bwId === null) return false; // wrong slot selected or out of stock
    id = bwId;
  } else {
    id = HOTBAR_BLOCKS[hotbar!.selected];
  }
  worldRenderer!.applyEdit(x, y, z, id);
  net?.sendBlockEdit(x, y, z, id);
  if (gameMode === 'bedwars') bwConsumeBlock(id);
  audio.blockPlace();
  return true;
}

function placeBlock(hit: RayHit): void {
  tryPlace(hit.x + hit.nx, hit.y + hit.ny, hit.z + hit.nz);
}

/**
 * Full left-click melee path (bedwars): segment-vs-AABB against every remote
 * avatar, nearest within ATTACK_REACH and before any block hit → attack send
 * + swing feedback. Client predicts cosmetics only; the server re-validates.
 */
function attackTarget(): boolean {
  if (gameMode !== 'bedwars' || !player || !remotePlayers || !world) return false;
  const origin = camera.position.clone();
  const dir = camera.getWorldDirection(new THREE.Vector3());
  const blockHit = raycast(world, origin, dir, REACH);
  let maxDist = Math.min(ATTACK_REACH, blockHit !== null ? blockHit.dist : ATTACK_REACH);
  let targetId: number | null = null;
  for (const avatar of remotePlayers.map.values()) {
    const p = avatar.position;
    const dist = rayVsAabb(
      origin,
      dir,
      {
        minX: p.x - TARGET_HALF_WIDTH,
        minY: p.y,
        minZ: p.z - TARGET_HALF_WIDTH,
        maxX: p.x + TARGET_HALF_WIDTH,
        maxY: p.y + TARGET_HEIGHT,
        maxZ: p.z + TARGET_HALF_WIDTH,
      },
      maxDist,
    );
    if (dist !== null) {
      targetId = avatar.id;
      maxDist = dist; // keep only closer candidates from here on
    }
  }
  if (targetId === null) return false;
  net?.sendAttack(targetId, bwHeldItem());
  audio.hit();
  pulseCrosshair();
  return true;
}

window.addEventListener('mousedown', (event) => {
  if (state !== 'ready' || !player?.isLocked) return;
  if (gameMode === 'party') return; // no break/place/attack on the dance floor
  if (event.button === 0) {
    if (gameMode === 'bedwars' && attackTarget()) return;
    const hit = raycastFromCamera();
    if (hit) breakBlock(hit);
  } else if (event.button === 2) {
    if (gameMode === 'bedwars' && bwHeldItem() === 'golden_apple') {
      net?.sendUseHeld();
      audio.eat();
      return;
    }
    const hit = raycastFromCamera();
    if (hit) placeBlock(hit);
  }
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
  selfName: () => net?.name ?? loadName(),
});

// --- keyboard ---------------------------------------------------------------

window.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement) return; // typing (chat/name)
  if (chatOpen) return;
  if (event.code === 'Escape' && bwUi?.isShopOpen) {
    toggleShopUi(); // shop closes; Esc while locked natively exits the lock
    return;
  }
  const slot = DIGIT_SLOTS.indexOf(event.code);
  if (slot >= 0) {
    if (gameMode === 'bedwars') bwHotbar?.select(slot); // slots 5–9 clamp no-op
    else hotbar?.select(slot);
  }
  if (event.code === 'Tab') {
    event.preventDefault(); // hold Tab = player list, never focus cycling
    showPlayerList();
  }
  if (event.code === 'KeyB' && gameMode === 'bedwars' && state === 'ready') {
    toggleShopUi();
  }
  if (event.code === 'KeyM') {
    const muted = audio.toggleMute();
    refreshMenu();
    console.log(`[mc] sound ${muted ? 'muted' : 'on'} (M)`);
  }
  // Mouse sensitivity: `[` coarser, `]` finer (±10% per press, [0.0008, 0.01]).
  if (event.code === 'BracketLeft') changeSensitivity(1 / 1.1);
  if (event.code === 'BracketRight') changeSensitivity(1.1);
  if (event.code === 'KeyF' && player?.isLocked && flyAllowedNow()) {
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
    const bar = gameMode === 'bedwars' ? bwHotbar : hotbar;
    if (!bar) return;
    bar.select(bar.selected + (event.deltaY > 0 ? 1 : -1));
    updateHeldIcon();
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
  atlas = await loadAtlas(); // overlay reads "Loading textures…"

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
  sandboxWorld = world;
  worldRenderer = createWorldRenderer(scene, world, atlas);
  sandboxRenderer = worldRenderer;
  selection = createSelection(scene);
  hotbar = makeSandboxHotbar();
  bwUi = createBedwarsUi({
    currencyIcons: { iron: oreIronUrl, gold: oreGoldUrl, emerald: oreEmeraldUrl },
    bedIcons: [tileDataUrl('brick_red'), tileDataUrl('cotton_blue')],
    iconResolver: itemIcon,
    onBuy: (item) => net?.sendBuy(item),
    onRematch: () => net?.sendReady(),
    onLeave: () => leaveGame(),
  });
  partyUi = createPartyUi({
    tileUrl: tileDataUrl('cotton_tan'),
    onCountdownTick: (urgency) => audio.beep(520 + urgency * 680),
  });
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
  refreshModeBadge();
  refreshBwButtons();
  window.__mc = {
    // Getters: the active world/renderer pair swaps on modeChanged.
    get world() {
      return world!;
    },
    get worldRenderer() {
      return worldRenderer!;
    },
    raycastFromCamera,
    look: (yaw: number, pitch: number) => player!.look(yaw, pitch),
    lookAt: (x: number, y: number, z: number) => {
      const p = player!;
      const dx = x - p.pos.x;
      const dy = y - (p.pos.y + 1.62);
      const dz = z - p.pos.z;
      p.look(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
    },
    camera,
    player: player!,
    tryPlace,
    breakBlockAt,
    tryAttack: attackTarget,
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
    get mode() {
      return gameMode;
    },
    get bw() {
      return bwState;
    },
    get party() {
      return partyState;
    },
    startBedwars,
    startParty,
    leaveGame,
    ready: () => net?.sendReady(),
    buy: (item: ShopItemId) => net?.sendBuy(item),
    useHeld: () => net?.sendUseHeld(),
    selectSlot: (index: number) => bwHotbar?.select(index),
    held: bwHeldItem,
    openShop: () => {
      if (bwUi?.isShopOpen) return true;
      toggleShopUi();
      return bwUi?.isShopOpen ?? false;
    },
    closeShop: () => {
      if (bwUi?.isShopOpen) toggleShopUi();
    },
    get isShopOpen() {
      return bwUi?.isShopOpen ?? false;
    },
    openChat,
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

  if ((state === 'building' || state === 'switching') && worldRenderer) {
    worldRenderer.processQueue(MESH_BUDGET_LOAD_MS);
    const built = totalToBuild - worldRenderer.pendingCount;
    const label = state === 'switching' ? 'Building arena' : 'Building world';
    statusEl.textContent = `${label}… ${Math.round((built / Math.max(totalToBuild, 1)) * 100)}%`;
    if (worldRenderer.pendingCount === 0) {
      if (state === 'switching') finishSwitch();
      else finishLoading();
    }
  } else if (state === 'ready' && worldRenderer) {
    player?.update(dt);
    worldRenderer.update(camera);
    worldRenderer.processQueue(MESH_BUDGET_PLAY_MS);
    partyUi?.tick(now); // party countdown bar + accelerating ticks between snapshots
    remotePlayers?.update(now, dt);
    maybeSendMove(now);
    updateSelection();
    // Hold-Tab player list stays live (scores, hp, AFK) while shown.
    if (tabListShown && now - tabListRenderedAt > 250) {
      tabListRenderedAt = now;
      renderPlayerList();
    }
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
  bwUi?.dispose();
  partyUi?.dispose();
  worldRenderer?.dispose();
  selection?.dispose();
  hotbar?.dispose();
  bwHotbar?.dispose();
  player?.dispose();
  audio.dispose();
  dispose();
}
window.addEventListener('pagehide', teardown, { once: true });

void boot();
requestAnimationFrame(frame);
