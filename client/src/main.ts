import * as THREE from 'three';
import {
  AIR,
  ARENA,
  ARROW_CHARGE_SECONDS,
  ARROW_MAX_CHARGE,
  ARROW_MIN_CHARGE,
  BLOCKS,
  CHUNK,
  HOTBAR_BLOCKS,
  MANOR,
  PARTY,
  PARTY_COLORS,
  PARTY_FLOOR,
  PLANKS,
  PROTOCOL_VERSION,
  WORLD_SIZE_X,
  WORLD_SIZE_Y,
  WORLD_SIZE_Z,
  WOOL_WHITE,
  bedTeamOf,
  EDIT_REACH_CLIENT,
  ATTACK_REACH_CLIENT,
  generateBedwarsArena,
  generateManorWorld,
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
import { createRemotePlayers, type RemotePlayers } from './remotePlayer';
import { createChatUi, type ChatUi } from './chat';
import { createBwHotbar, type BwHotbar, type BwItemView } from './bwHotbar';
import { createBedwarsUi, type BedwarsUi } from './bedwarsUi';
import { createMatchHud, type MatchHud } from './matchHud';
import { createBwState, type BwState } from './bwState';
import { createBwFx, type BwFx } from './bwFx';
import { createPartyState, type PartyState } from './partyState';
import { createMurderState, GUEST_CSS, GUEST_SHIRT_HEX, type MurderGravestoneView, type MurderState } from './murderState';
import { createMurderHud, type MurderHud } from './murderHud';
import { createMurderFx, type MurderFx } from './murderFx';
import { murderEvents } from './matchEvents/murder';
import { createPartyUi, setPartyTickState, tintCss, type PartyUi } from './partyUi';
import { createBombFx, type BombFx } from './bombFx';
import { createPartyPowerups, PARTY_ITEM_SLOTS, type PartyPowerups } from './partyPowerups';
import { createMobRenderer, mobTargetBox, type MobRenderer } from './mobs';
import { createHeldItem, type HeldItem } from './heldItem';
import { nameColor, playerColor } from './identity';
import { TARGET_HALF_WIDTH, TARGET_HEIGHT, rayVsAabb } from './combat';
import { installDevHooks } from './devHooks';
import { lockPointer } from './uiLock';
import { createMenuUi } from './hud/menu';
import { createPlayerListUi } from './hud/playerList';
import { dispatchEvent } from './matchEvents/table';
import { bwEvents } from './matchEvents/bw';
import { partyEvents } from './matchEvents/party';
import { sandboxEvents, onMobDied, onMobsSnapshot, type SandboxEventCtx } from './matchEvents/sandbox';
import { parkForBuild, swapToMatchWorld, type ModeHost } from './modes';
import swordBronzeUrl from '../assets/kenney/items/sword_bronze.png';
import swordSilverUrl from '../assets/kenney/items/sword_silver.png';
import swordIronUrl from '../assets/kenney/items/sword_iron.png';
import appleUrl from '../assets/kenney/items/apple.png';
import bowUrl from '../assets/kenney/items/bow.png';
import arrowUrl from '../assets/kenney/items/arrow.png';
import oreIronUrl from '../assets/kenney/items/ore_iron.png';
import oreGoldUrl from '../assets/kenney/items/ore_gold.png';
import oreEmeraldUrl from '../assets/kenney/items/ore_emerald.png';

console.log(`minecraft-mini client (protocol v${PROTOCOL_VERSION})`);

const OFFLINE_SEED = 1337; // also the server's seed — worlds match either way
// EDIT_REACH_CLIENT (blocks) + ATTACK_REACH_CLIENT live in @mc/shared —
// deliberate pairs with the server's EDIT_REACH_SERVER (8) and
// ATTACK_RANGE_SERVER (4.5); see shared/src/simulation.ts.
/** Spectate Color Zapper ray length (platform → far floor edge is ~35 blocks). */
const ZAP_REACH = 96;
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
// Bow charge bar (M6.1): a small ramp under the crosshair, visible only while
// the right-click hold is charging the shot.
const chargeEl = document.querySelector<HTMLDivElement>('#bw-charge')!;
const chargeFillEl = document.querySelector<HTMLDivElement>('#bw-charge-fill')!;
// The pause-menu / match-control / guide / player-list elements are owned by
// hud/menu.ts and hud/playerList.ts (they query the same static ids).
const nameInput = document.querySelector<HTMLInputElement>('#name-input')!;
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
  bow: bowUrl,
  arrow: arrowUrl,
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
let matchHud: MatchHud | null = null;
let bwHotbar: BwHotbar | null = null;
/** Pooled arrows + damage numbers (M6.1+M6.2) — boot-time, lives across matches. */
let bwFx: BwFx | null = null;
/** Bow charge input: true between right-click down and up (bow selected). */
let bowCharging = false;
let bowChargeStartAt = 0;

// --- Block Party (M5) ---
let partyState: PartyState | null = null;
let partyUi: PartyUi | null = null;
/** Auto color bomb FX (protocol v5) — created at boot, lives across matches. */
let bombFx: BombFx | null = null;
/** Mystery boxes + power-up slots + zapper FX (protocol v7), same lifecycle. */
let powerups: PartyPowerups | null = null;

// --- Murder Mystery (M7) ---
let murderState: MurderState | null = null;
/** Detective HUD (role card, clock, coins/charges, roster, detector chip). */
let murderHud: MurderHud | null = null;
/** Coins/gravestones/zap-beam scene props — boot-time, lives across matches. */
let murderFx: MurderFx | null = null;
/** Spectate Color Zapper: armed when I fall, spent by MY cellZapped event. */
let zapperArmed = false;
let zapperUsed = false;

/** First-person held-item viewmodel (M7.5) — boot-time, lives across matches. */
let heldItem: HeldItem | null = null;

// --- Sandbox mobs (M5.3, §3.5) ---
let mobRenderer: MobRenderer | null = null;
/** Recent mobDied events (smoke tests); capped, oldest dropped. */
const mobDieds: { id: number; kind: string; at: [number, number, number] }[] = [];
const shoves: { by: number; power: number; at: number }[] = [];

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

// --- menu / HUD wiring (hud/menu.ts) ------------------------------------------

/**
 * Pause menu, match controls, guide panel, mode badge + pointer-lock UI — the
 * DOM wiring extracted from main.ts (REFACTORING.md 2a.2). main.ts stays the
 * state owner: the menu reads the live singletons through the getters below.
 */
const menuUi = createMenuUi({
  get player() {
    return player;
  },
  audio,
  get gameMode() {
    return gameMode;
  },
  get partyState() {
    return partyState;
  },
  get murderState() {
    return murderState;
  },
  get net() {
    return net;
  },
  get state() {
    return state;
  },
  get chat() {
    return chat;
  },
  showToast,
});

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

// --- Tab player list (hud/playerList.ts) --------------------------------------

/**
 * Hold-Tab roster peek — extracted from main.ts (REFACTORING.md 2a.2). The
 * keydown side stays in the keyboard section below; keyup/blur live in the
 * module along with the shown/rendered-at state.
 */
const playerListUi = createPlayerListUi({
  get gameMode() {
    return gameMode;
  },
  get net() {
    return net;
  },
  get bwState() {
    return bwState;
  },
  get partyState() {
    return partyState;
  },
});

// --- BedWars client state / UI ------------------------------------------------

function bwHotbarItems(): BwItemView[] {
  const inv = bwState?.inv ?? { wool: 0, planks: 0, apples: 0, sword: null, bow: false, arrows: 0 };
  const swordSpec =
    inv.sword === 'wooden' ? 'item:sword_bronze' : inv.sword === 'stone' ? 'item:sword_silver' : inv.sword === 'iron' ? 'item:sword_iron' : null;
  return [
    { key: 'wool', iconUrl: itemIcon('tile:snow'), label: 'Wool', count: inv.wool },
    { key: 'planks', iconUrl: itemIcon('tile:wood'), label: 'Planks', count: inv.planks },
    { key: 'sword', iconUrl: swordSpec !== null ? itemIcon(swordSpec) : null, label: 'Sword', count: null, muted: !inv.sword },
    { key: 'apple', iconUrl: itemIcon('item:apple'), label: 'Golden Apple', count: inv.apples },
    // Slot 5: the bow, ghosted until owned (the sword slot's mute pattern);
    // owned it shows the arrow stock as its count badge.
    { key: 'bow', iconUrl: inv.bow ? itemIcon('item:bow') : null, label: 'Bow', count: inv.bow ? inv.arrows : null, muted: !inv.bow },
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
    case 4:
      // The server re-validates ownership + ammo; a dry bow hits like a fist.
      return inv.bow && inv.arrows > 0 ? 'bow' : 'fist';
    default:
      return 'fist';
  }
}

/**
 * Per-mode held-item mapping (DESIGN.md §3.7): sandbox = the selected hotbar
 * block as a cube; BedWars = wool/planks as cubes, sword tiers + golden apple
 * as item sprites, fist = empty hands; Murder = the zapper wand while I hold
 * charges and live; Party = deliberately empty hands. Idempotent — the frame
 * loop calls it every tick, and every setter no-ops on an unchanged item.
 */
function updateHeldItem(): void {
  if (!heldItem) return;
  if (gameMode === 'sandbox') {
    heldItem.setCube(hotbar ? HOTBAR_BLOCKS[hotbar.selected] : null);
    return;
  }
  if (gameMode === 'bedwars') {
    switch (bwHeldItem()) {
      case 'wool':
        heldItem.setCube(WOOL_WHITE);
        break;
      case 'planks':
        heldItem.setCube(PLANKS);
        break;
      // The bwHotbarItems icon mapping: wooden→bronze, stone→silver, iron→iron.
      case 'wooden_sword':
        heldItem.setSprite('item:sword_bronze');
        break;
      case 'stone_sword':
        heldItem.setSprite('item:sword_silver');
        break;
      case 'iron_sword':
        heldItem.setSprite('item:sword_iron');
        break;
      case 'golden_apple':
        heldItem.setSprite('item:apple');
        break;
      case 'bow':
        heldItem.setSprite('item:bow');
        break;
      default:
        heldItem.clear(); // fist (empty slot / out of stock)
    }
    return;
  }
  if (gameMode === 'murder') {
    if (murderState && murderState.charges > 0 && murderState.alive) heldItem.setWand();
    else heldItem.clear(); // dry/jammed zapper is an empty hand
    return;
  }
  heldItem.clear(); // Block Party: the floor game holds nothing
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
    lockPointer(renderer.domElement);
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

// --- bow charge input (M6.1, §3.3) ---------------------------------------------

/** Seconds the right-click hold has been charging (drives the bar + viewmodel). */
function bowChargeSeconds(now: number): number {
  return (now - bowChargeStartAt) / 1000;
}

/**
 * Begins the hold-to-charge: only with the bow truly held (selected + owned +
 * ammo) and while alive. The mirrored server gate means an accepted hold
 * nearly always fires.
 */
function startBowCharge(): boolean {
  if (gameMode !== 'bedwars' || !bwState || !player) return false;
  if (!bwState.me()?.alive) return false;
  if (bwHeldItem() !== 'bow') return false;
  bowCharging = true;
  bowChargeStartAt = performance.now();
  return true;
}

/** Cancels the hold without firing (mode swap / slot change / unlock). */
function cancelBowCharge(): void {
  if (!bowCharging) return;
  bowCharging = false;
  heldItem?.setCharge(null);
}

/**
 * Releases the shot: charge = hold seconds clamped to [0.2, 1] (the same
 * range the server re-clamps) → `bowShot`. The server re-validates
 * ownership/ammo/cooldown; a desynced release just does nothing.
 */
function releaseBowCharge(): boolean {
  if (!bowCharging) return false;
  bowCharging = false;
  heldItem?.setCharge(null);
  if (gameMode !== 'bedwars' || !bwState || bwHeldItem() !== 'bow' || !bwState.me()?.alive) {
    return false;
  }
  const charge = Math.max(ARROW_MIN_CHARGE, Math.min(ARROW_MAX_CHARGE, bowChargeSeconds(performance.now())));
  net?.sendBowShot(charge);
  return true;
}

/** Per-frame charge UI: ramp bar under the crosshair + viewmodel draw tilt. */
function tickBowCharge(): void {
  if (!bowCharging) {
    chargeEl.classList.add('hidden');
    return;
  }
  const progress = Math.min(1, bowChargeSeconds(performance.now()) / ARROW_CHARGE_SECONDS);
  chargeFillEl.style.width = `${Math.round(progress * 100)}%`;
  chargeEl.classList.remove('hidden');
  heldItem?.setCharge(progress);
}

function handleGameEvent(msg: GameEventMsg): void {
  // Toast-able rejections (startGame with ≠2 players, poor buys) arrive even
  // outside matches — handle before any mode table.
  if (msg.kind === 'error') {
    showToast(msg.message);
    return;
  }
  if (gameMode === 'party') {
    if (!partyState || !partyUi) return;
    partyState.recordEvent(msg);
    dispatchEvent(partyEvents, msg, {
      partyState,
      player,
      audio,
      matchHud,
      bombFx,
      powerups,
      showToast,
      partyTint,
      partySpawnPoint,
      resetZapper,
      syncPowerups,
      armZapper,
      markZapperUsed,
    });
    return;
  }
  if (gameMode === 'murder') {
    if (!murderState) return;
    murderState.recordEvent(msg);
    dispatchEvent(murderEvents, msg, {
      murderState,
      murderHud,
      murderFx,
      player,
      audio,
      matchHud,
      showToast,
      guestSpot: (id) => {
        const avatar = mobRenderer?.map.get(id);
        return avatar ? { x: avatar.position.x, y: avatar.position.y, z: avatar.position.z } : null;
      },
    });
    return;
  }
  if (gameMode === 'sandbox') {
    dispatchEvent(sandboxEvents, msg, sandboxCtx());
    return;
  }
  // BedWars: the mirror records every event; the HUD pair must be live.
  if (!bwState) return;
  bwState.recordEvent(msg);
  if (!matchHud || !bwUi) return;
  dispatchEvent(bwEvents, msg, {
    bwState,
    player,
    audio,
    matchHud,
    bwUi,
    bwFx,
    camera,
    avatarPos: (id) => {
      const avatar = remotePlayers?.map.get(id);
      return avatar ? { x: avatar.position.x, y: avatar.position.y, z: avatar.position.z } : null;
    },
    showToast,
  });
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
      menuUi.refreshMatchControls();
      break;
    }
    case 'players':
      remotePlayers?.applySnapshot(msg.players, net?.playerId ?? null);
      syncRosterChat();
      menuUi.refreshMatchControls();
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
    case 'mobs':
      onMobsSnapshot(msg, sandboxCtx());
      break;
    case 'mobDied':
      onMobDied(msg, sandboxCtx());
      break;
    case 'modeChanged':
      modeEnters[msg.mode](msg);
      break;
    case 'gameState': {
      if (gameMode === 'party' && partyState) {
        if (msg.party) {
          partyState.applyGameState(msg);
          partyUi?.sync(partyState);
          syncBombFx(); // bomb mesh follows the authoritative mirror
          syncPowerups(); // boxes / item slots / zapper hint ditto
        }
        break;
      }
      if (gameMode === 'murder' && murderState) {
        murderState.applyGameState(msg);
        murderHud?.sync(murderState);
        murderFx?.syncCoins([...murderState.coinItems.values()]);
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

/** Mode-swap plumbing for modes.ts: reads via getters, writes via setters. */
const modeHost: ModeHost = {
  scene,
  overlay,
  statusEl,
  get atlas() {
    return atlas;
  },
  get player() {
    return player;
  },
  get sandboxRenderer() {
    return sandboxRenderer;
  },
  get worldRenderer() {
    return worldRenderer;
  },
  get selection() {
    return selection;
  },
  menuUi,
  disposeArenaRenderer: () => arenaRenderer?.dispose(),
  setArenaWorld: (nextWorld, nextRenderer) => {
    arenaWorld = nextWorld;
    arenaRenderer = nextRenderer;
    world = nextWorld;
    worldRenderer = nextRenderer;
  },
  setPendingSpawn: (spawn) => {
    pendingSpawn = spawn;
  },
  beginSwitch: (pendingChunks) => {
    totalToBuild = pendingChunks;
    state = 'switching';
  },
  clearTarget: () => {
    currentTarget = null;
  },
};

/** Swaps every client into a fresh BedWars arena (modeChanged bedwars). */
function enterBedwars(msg: ModeChangedMsg): void {
  if (!sandboxWorld || !sandboxRenderer || !atlas || !player) return;
  if (state !== 'ready' && state !== 'switching') return; // still booting

  gameMode = 'bedwars';
  bwState = createBwState();
  bwState.applyModeChanged(msg, net?.playerId ?? null);
  matchHud?.results(null, null);
  cancelBowCharge(); // a fresh match never inherits a mid-hold charge
  // Clear any party/murder leftovers (modes never overlap, but be tidy).
  partyState = null;
  setPartyTickState(null);
  partyUi?.show(false);
  bombFx?.reset();
  bwFx?.clear(); // a fresh arena never inherits the old match's arrows/numbers
  murderState = null;
  murderHud?.show(false);
  murderFx?.clear();
  mobRenderer?.setGuestInfo(null);
  mobRenderer?.clear(); // matches never render sandbox mobs
  matchHud?.setFeedOnly(false);

  swapToMatchWorld(modeHost, generateBedwarsArena(msg.seed), msg.edits);

  // UI: hotbar swap + HUD.
  hotbar?.dispose();
  hotbar = null;
  bwHotbar = createBwHotbar(hotbarEl, bwHotbarItems(), {
    canSelect: () => state === 'ready' && !player?.isLocked,
    onSelect: () => {
      updateHeldIcon();
      // Switching away from the bow mid-hold cancels the draw (no blind fire).
      if (bowCharging && bwHeldItem() !== 'bow') cancelBowCharge();
    },
  });
  matchHud?.showHud(true);
  if (bwState && bwUi) bwUi.sync(bwState);
  updateHeldIcon();

  // Park the player during the build, then drop them on their spawn.
  const team = bwState.myTeam;
  const spawnPoint = team >= 0 && bwState.spawns[team] ? bwState.spawns[team] : ARENA.spectatorSpawn;
  parkForBuild(modeHost, { x: spawnPoint.x, y: spawnPoint.y, z: spawnPoint.z }, 'Building arena…');
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

/** Party wool block id → mesher-style tint for bomb FX. */
function partyTint(colorId: number): [number, number, number] {
  return PARTY_COLORS.find((color) => color.id === colorId)?.tint ?? [1, 1, 1];
}

/**
 * Keeps the bomb visuals on the authoritative mirror (5 Hz + after events):
 * shows the fused bomb when the state gains one (covers late joiners who
 * missed the bombSpawned event), hides it when the state drops it. The
 * detonation burst itself is event-driven for an instant pop.
 */
function syncBombFx(): void {
  if (!partyState || !bombFx) return;
  const bomb = partyState.bomb;
  if (bomb && !bombFx.showing) bombFx.showBomb(bomb.cell, partyTint(bomb.colorId), bomb.detonatesAt);
  else if (!bomb && bombFx.showing) bombFx.hideBomb();
}

/** True while MY zapper shot may still be clicked away this round. */
function zapperActive(): boolean {
  return (
    zapperArmed &&
    !zapperUsed &&
    (partyState?.phase === 'drop' || partyState?.phase === 'scored')
  );
}

/** Mirror the party snapshot into the power-up UI (boxes, slots, zapper hint). */
function syncPowerups(): void {
  if (!partyState || !powerups) return;
  powerups.syncBoxes(partyState.boxes);
  const myId = partyState.myId;
  const myItems = myId !== null ? partyState.items.get(myId) ?? [] : [];
  const myEffects = myId !== null ? partyState.effects.get(myId) ?? null : null;
  powerups.syncSlots(myItems, myEffects);
  // Speed / Jump Boost move the local physics body: apply the server's
  // absolute expiry to the controller (idempotent; expired timestamps are
  // inert because the controller compares against Date.now()).
  if (player && myEffects) {
    if (myEffects.speedUntil > 0) player.applyEffect('speed', myEffects.speedUntil);
    if (myEffects.jumpUntil > 0) player.applyEffect('jump', myEffects.jumpUntil);
  }
  powerups.showZapper(zapperActive());
}

/** Resets the zapper window (round start / match end / mode swap). */
function resetZapper(): void {
  zapperArmed = false;
  zapperUsed = false;
  powerups?.showZapper(false);
}

/** The faller's zapper arms (matchEvents/party death handler). */
function armZapper(): void {
  zapperArmed = true;
  zapperUsed = false;
}

/** The one zapper shot is spent (matchEvents/party cellZapped handler). */
function markZapperUsed(): void {
  zapperUsed = true;
}

/** Sandbox event context for matchEvents/sandbox (shove + mob messages). */
function sandboxCtx(): SandboxEventCtx {
  return { player, net, audio, mobRenderer, dayNight, shoves, mobDieds };
}

/**
 * Full Color Zapper click path: raycast the aim through the floor, require a
 * dance-floor cell (the server re-validates it survived the drop), send
 * zapCell. Returns false (with a hint toast) when the aim misses the floor.
 * The ray direction comes from the player's yaw/pitch (the camera aim) rather
 * than the camera quaternion, which only catches up on the next frame — this
 * keeps a look-then-zap pair exact.
 */
function zapUnderCrosshair(): boolean {
  if (!world || !player) return false;
  if (!zapperActive()) return false;
  const cosPitch = Math.cos(player.pitch);
  const dir = new THREE.Vector3(
    -Math.sin(player.yaw) * cosPitch,
    Math.sin(player.pitch),
    -Math.cos(player.yaw) * cosPitch,
  );
  const hit = raycast(world, camera.position, dir, ZAP_REACH);
  if (!hit || hit.y !== PARTY_FLOOR.y) {
    showToast('Aim at a surviving floor tile!');
    return false;
  }
  net?.sendZapCell(hit.x, hit.z);
  heldItem?.swing();
  return true;
}

/** Detective zapper reach (§3.6: the party zap-beam precedent, guest-sized). */
const ZAP_GUEST_RANGE = 20;

/**
 * Murder Mystery zapper click path: ray the aim (yaw/pitch, never the lagging
 * camera quaternion — the zapUnderCrosshair reasoning) against GUEST AABBs
 * only, within 20 blocks. The server owns every rule (charges, jam, correct
 * target); a miss just hints. Ghosts never fire.
 */
function zapGuestUnderCrosshair(): boolean {
  if (!player || !murderState) return false;
  if (!murderState.alive) return false; // ghosts cannot zap (§3.6)
  const origin = camera.position.clone();
  const cosPitch = Math.cos(player.pitch);
  const dir = new THREE.Vector3(
    -Math.sin(player.yaw) * cosPitch,
    Math.sin(player.pitch),
    -Math.cos(player.yaw) * cosPitch,
  );
  let targetId: number | null = null;
  let dist = ZAP_GUEST_RANGE;
  for (const mob of mobRenderer?.map.values() ?? []) {
    if (mob.kind !== 'guest') continue;
    const hit = rayVsAabb(origin, dir, mobTargetBox(mob.position, mob.kind), dist);
    if (hit !== null) {
      targetId = mob.id;
      dist = hit; // keep only closer candidates from here on
    }
  }
  if (targetId === null) {
    showToast('Aim at a guest!');
    return false;
  }
  net?.sendZapGuest(targetId);
  heldItem?.swing();
  return true;
}

/**
 * E-key gravestone investigation: the stone nearest MY feet within reach
 * ("walk up + press E", §3.6). Sends the floored cell; the server re-validates
 * the 30 s cooldown and answers with a gravestoneRead event.
 */
function investigateNearestGravestone(): void {
  if (!player || !murderState) return;
  if (!murderState.alive) return; // ghosts cannot investigate
  let best: MurderGravestoneView | null = null;
  let bestDist = 3.5;
  for (const stone of murderState.gravestones.values()) {
    const d = Math.hypot(player.pos.x - (stone.x + 0.5), player.pos.z - (stone.z + 0.5));
    if (d < bestDist) {
      best = stone;
      bestDist = d;
    }
  }
  if (!best) {
    showToast('No gravestone nearby');
    return;
  }
  net?.sendInvestigateGravestone(best.x, best.z);
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
  bombFx?.reset(); // a fresh match never inherits the old round's FX
  bwFx?.clear(); // arrows/numbers are BedWars-only props
  cancelBowCharge();
  resetZapper();
  powerups?.reset();
  syncPowerups(); // fresh match: empty boxes/slots, hint hidden
  murderState = null;
  murderHud?.show(false);
  murderFx?.clear();
  mobRenderer?.setGuestInfo(null);
  mobRenderer?.clear(); // matches never render sandbox mobs
  matchHud?.results(null, null); // clear any previous match's screen
  matchHud?.showHud(true); // reuse the frame for the shared kill feed…
  matchHud?.setFeedOnly(true); // …but show only the feed

  swapToMatchWorld(modeHost, generatePartyWorld(), msg.edits); // spectator platform + the round-1 floor

  // No hotbars in party — the announced color lives in the dedicated HUD slot.
  hotbar?.dispose();
  hotbar = null;
  bwHotbar?.dispose();
  bwHotbar = null;

  // Park the player during the build, then drop them on their spawn slot.
  parkForBuild(modeHost, partySpawnPoint(), 'Building the dance floor…');
}

/** Swaps every client into the Murder Mystery manor (modeChanged murder). */
function enterMurder(msg: ModeChangedMsg): void {
  if (!sandboxWorld || !sandboxRenderer || !atlas || !player) return;
  if (state !== 'ready' && state !== 'switching') return; // still booting

  gameMode = 'murder';
  murderState = createMurderState();
  murderState.applyModeChanged(msg, net?.playerId ?? null);
  murderHud?.show(true);
  murderFx?.clear(); // a fresh match never inherits the old match's stones
  bwFx?.clear(); // arrows/numbers are BedWars-only props
  cancelBowCharge();
  mobRenderer?.clear(); // matches never render sandbox mobs
  // Dress guest avatars from the roster (guests ride the mobs stream; ids are
  // stable for the whole match, so a set-at-create tint is enough).
  mobRenderer?.setGuestInfo((id) => {
    const guest = murderState?.guest(id);
    return guest
      ? { name: guest.name, shirt: GUEST_SHIRT_HEX[guest.color], css: GUEST_CSS[guest.color] }
      : null;
  });
  matchHud?.results(null, null); // clear any previous match's screen
  matchHud?.showHud(true); // reuse the frame for the shared kill feed…
  matchHud?.setFeedOnly(true); // …but show only the feed (murderHud owns the chrome)

  swapToMatchWorld(modeHost, generateManorWorld(), msg.edits);

  // No hotbars in the manor — the zapper is aim + click (§3.6).
  hotbar?.dispose();
  hotbar = null;
  bwHotbar?.dispose();
  bwHotbar = null;

  // Park the player during the build, then drop them at the manor entrance.
  const slot = murderState.myTeam;
  const spawnPoint = slot === 0 || slot === 1 ? MANOR.spawns[slot] : MANOR.spectatorSpot;
  parkForBuild(modeHost, { x: spawnPoint.x, y: spawnPoint.y, z: spawnPoint.z }, 'Building the manor…');
  matchHud?.banner('You are the Detective — find the murderer!', { ms: 2500 });
}

/** Back to the sandbox (modeChanged sandbox): instant — the parked meshes return. */
function exitToSandbox(msg: ModeChangedMsg): void {
  if (!sandboxWorld || !sandboxRenderer || !player) return;

  gameMode = 'sandbox';
  arenaRenderer?.dispose();
  arenaRenderer = null;
  arenaWorld = null;
  bwState = null;
  cancelBowCharge();
  bwFx?.clear();
  partyState = null;
  setPartyTickState(null);
  partyUi?.show(false);
  bombFx?.reset();
  resetZapper();
  powerups?.reset();
  murderState = null;
  murderHud?.show(false);
  murderFx?.clear();
  mobRenderer?.setGuestInfo(null); // guest dressing never leaks to animals
  mobRenderer?.clear(); // the server re-broadcasts a fresh snapshot on return
  pendingSpawn = null;

  world = sandboxWorld;
  worldRenderer = sandboxRenderer;
  sandboxRenderer.setVisible(true);
  for (const [x, y, z, id] of msg.edits) sandboxRenderer.applyEdit(x, y, z, id); // heals no-ops

  player.setWorld(sandboxWorld);
  player.flyAllowed = true;
  player.flying = false;
  player.clearEffects(); // power-up buffs never leak into the sandbox
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
  matchHud?.setFeedOnly(false);
  matchHud?.showHud(false);
  matchHud?.results(null, null);
  if (!hotbar) hotbar = makeSandboxHotbar();

  document.exitPointerLock();
  state = 'ready';
  statusEl.textContent = 'Click to play';
  overlay.classList.remove('loading');
  menuUi.syncPointerUi();
  menuUi.refreshMatchControls();
  menuUi.refreshModeBadge();
  menuUi.refreshMenu();
}

/** modeChanged dispatch (REFACTORING.md 2a.5): one arm per mode; a new mini-game adds one entry. */
const modeEnters: Record<GameMode, (msg: ModeChangedMsg) => void> = {
  bedwars: enterBedwars,
  party: enterParty,
  murder: enterMurder,
  sandbox: exitToSandbox,
};

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
  menuUi.syncPointerUi();
  menuUi.refreshMenu();
  menuUi.refreshMatchControls();
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
  return raycast(world, camera.position, dir, EDIT_REACH_CLIENT);
}

/**
 * Break path (left-click). Returns whether the break actually acted — the
 * held-item viewmodel swings on true (own bed / unbreakable blocks don't).
 */
function breakBlock(hit: RayHit): boolean {
  const id = world!.getBlock(hit.x, hit.y, hit.z);
  if (id === AIR) return false;
  if (gameMode === 'bedwars') {
    const bedTeam = bedTeamOf(id);
    if (bedTeam >= 0) {
      if (bedTeam === bwState?.myTeam) {
        showToast("You can't break your own bed!");
        return false;
      }
      // Enemy bed: optimistic remove; the server confirms to everyone (and
      // the bedBroken event drives the banner + sound).
      worldRenderer!.applyEdit(hit.x, hit.y, hit.z, AIR);
      net?.sendBlockEdit(hit.x, hit.y, hit.z, AIR);
      heldItem?.swing();
      return true;
    }
  } else if (BLOCKS[id].unbreakable) {
    return false;
  }
  worldRenderer!.applyEdit(hit.x, hit.y, hit.z, AIR); // optimistic
  net?.sendBlockEdit(hit.x, hit.y, hit.z, AIR); // server validates + relays
  audio.blockBreak(blockSoundKind(id));
  heldItem?.swing();
  return true;
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
  heldItem?.swing();
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
  heldItem?.swing();
  return true;
}

function placeBlock(hit: RayHit): void {
  tryPlace(hit.x + hit.nx, hit.y + hit.ny, hit.z + hit.nz);
}

/**
 * Full left-click melee path: segment-vs-AABB against the mode's targets —
 * remote avatars in BedWars, sandbox mobs in the sandbox (§3.5) — nearest
 * within ATTACK_REACH_CLIENT and before any block hit → attack send + swing
 * feedback. A mob AABB hit nearer than the targeted block attacks instead of
 * breaking. Client predicts cosmetics only; the server re-validates.
 */
function attackTarget(): boolean {
  if (!player || !world) return false;
  const origin = camera.position.clone();
  // Ray direction from the player's authoritative yaw/pitch, not the camera
  // quaternion, which only catches up on the next frame — same reasoning as
  // zapUnderCrosshair: keeps a look-then-swing pair exact (a fast flick
  // otherwise swings along the pre-flick aim).
  const cosPitch = Math.cos(player.pitch);
  const dir = new THREE.Vector3(
    -Math.sin(player.yaw) * cosPitch,
    Math.sin(player.pitch),
    -Math.cos(player.yaw) * cosPitch,
  );
  const blockHit = raycast(world, origin, dir, EDIT_REACH_CLIENT);
  const maxDist = Math.min(
    ATTACK_REACH_CLIENT,
    blockHit !== null ? blockHit.dist : ATTACK_REACH_CLIENT,
  );

  if (gameMode === 'bedwars') {
    if (!remotePlayers) return false;
    let targetId: number | null = null;
    let dist = maxDist;
    for (const avatar of remotePlayers.map.values()) {
      const p = avatar.position;
      const hit = rayVsAabb(
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
        dist,
      );
      if (hit !== null) {
        targetId = avatar.id;
        dist = hit; // keep only closer candidates from here on
      }
    }
    if (targetId === null) return false;
    net?.sendAttack(targetId, bwHeldItem());
    audio.hit();
    pulseCrosshair();
    heldItem?.swing();
    return true;
  }

  if (gameMode === 'sandbox' && mobRenderer) {
    let mobId: number | null = null;
    let dist = maxDist;
    for (const mob of mobRenderer.map.values()) {
      const hit = rayVsAabb(origin, dir, mobTargetBox(mob.position, mob.kind), dist);
      if (hit !== null) {
        mobId = mob.id;
        dist = hit;
      }
    }
    if (mobId === null) return false;
    net?.sendAttackMob(mobId);
    audio.mobHit();
    pulseCrosshair();
    heldItem?.swing();
    return true;
  }

  return false;
}

window.addEventListener('mousedown', (event) => {
  if (state !== 'ready' || !player?.isLocked) return;
  if (gameMode === 'party') {
    // Left click while my zapper is armed = the spectate Color Zapper shot;
    // otherwise no break/place/attack on the dance floor.
    if (event.button === 0) zapUnderCrosshair();
    return;
  }
  if (gameMode === 'murder') {
    // Left click = the detective zapper (server validates charges/jam/range);
    // no break/place/attack in the manor.
    if (event.button === 0) zapGuestUnderCrosshair();
    return;
  }
  if (event.button === 0) {
    if (attackTarget()) return; // bedwars players / sandbox mobs — beats block breaking
    const hit = raycastFromCamera();
    if (hit) breakBlock(hit);
  } else if (event.button === 2) {
    if (gameMode === 'bedwars' && bwHeldItem() === 'golden_apple') {
      net?.sendUseHeld();
      audio.eat();
      heldItem?.swing(); // the eat gesture (DESIGN.md §3.7 swing triggers)
      return;
    }
    // BedWars bow (M6.1): HOLD right-click to charge, RELEASE fires (§3.3).
    if (gameMode === 'bedwars' && bwHeldItem() === 'bow') {
      startBowCharge();
      return;
    }
    const hit = raycastFromCamera();
    if (hit) placeBlock(hit);
  }
});

window.addEventListener('mouseup', (event) => {
  // Bow release (§3.3): only while the pointer is still locked — losing the
  // lock mid-hold (Esc) cancels the shot instead of firing blind.
  if (event.button === 2 && bowCharging) {
    if (player?.isLocked) releaseBowCharge();
    else cancelBowCharge();
  }
});

window.addEventListener('contextmenu', (event) => {
  if (player?.isLocked) event.preventDefault();
});

// --- chat -------------------------------------------------------------------

function openChat(): void {
  if (chat?.isOpen || !player) return;
  player.overlaySuppressed = true; // keep the pause overlay hidden while typing
  document.exitPointerLock();
  chat?.open();
}

function closeChat(): void {
  // Only invoked as the chat module's onClose callback — isOpen is already
  // false by the time this runs, so the guard is on player only.
  if (!player) return;
  player.overlaySuppressed = false;
  overlay.classList.toggle('hidden', player.isLocked || player.overlaySuppressed);
  // Re-lock inside the Enter/Esc key gesture; on failure the overlay shows.
  lockPointer(renderer.domElement);
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
  if (chat?.isOpen) return;
  if (event.code === 'Escape' && bwUi?.isShopOpen) {
    toggleShopUi(); // shop closes; Esc while locked natively exits the lock
    return;
  }
  const slot = DIGIT_SLOTS.indexOf(event.code);
  if (slot >= 0) {
    if (gameMode === 'party') {
      // Mystery-box item slots 1–3 (the party has no block hotbar). The
      // server validates phase/lockout and toasts rejections.
      if (state === 'ready' && slot < PARTY_ITEM_SLOTS) net?.sendUseItem(slot);
    } else if (gameMode === 'bedwars') bwHotbar?.select(slot); // slots 5–9 clamp no-op
    else hotbar?.select(slot);
  }
  if (event.code === 'Tab') {
    event.preventDefault(); // hold Tab = player list, never focus cycling
    playerListUi.showPlayerList();
  }
  if (event.code === 'KeyB' && gameMode === 'bedwars' && state === 'ready') {
    toggleShopUi();
  }
  if (event.code === 'KeyE' && gameMode === 'murder' && state === 'ready' && player?.isLocked) {
    investigateNearestGravestone();
  }
  if (event.code === 'KeyM') {
    const muted = audio.toggleMute();
    menuUi.refreshMenu();
    console.log(`[mc] sound ${muted ? 'muted' : 'on'} (M)`);
  }
  // Mouse sensitivity: `[` coarser, `]` finer (±10% per press, [0.0008, 0.01]).
  if (event.code === 'BracketLeft') menuUi.changeSensitivity(1 / 1.1);
  if (event.code === 'BracketRight') menuUi.changeSensitivity(1.1);
  if (event.code === 'KeyF' && player?.isLocked && menuUi.flyAllowedNow()) {
    player.flying = !player.flying; // discoverable fly toggle (session-only)
    showToast(`Flying ${player.flying ? 'ON' : 'OFF'}`);
    menuUi.refreshMenu();
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

  // The viewmodel hangs off the camera; three.js only renders camera children
  // when the camera itself sits in the scene graph.
  scene.add(camera);
  heldItem = createHeldItem(camera, { atlas, itemIcon });

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
  matchHud = createMatchHud({
    onRematch: () => net?.sendReady(),
    onLeave: () => menuUi.leaveGame(),
    onHide: () => {
      // What showHud(false) used to close from inside bedwarsUi: the mode-
      // specific overlays that hang off the shared frame.
      bwUi?.respawn(null);
      bwUi?.closeShop();
    },
  });
  bwUi = createBedwarsUi({
    currencyIcons: { iron: oreIronUrl, gold: oreGoldUrl, emerald: oreEmeraldUrl },
    bedIcons: [tileDataUrl('brick_red'), tileDataUrl('cotton_blue')],
    iconResolver: itemIcon,
    onBuy: (item) => net?.sendBuy(item),
  });
  partyUi = createPartyUi({
    tileUrl: tileDataUrl('cotton_tan'),
    onCountdownTick: (urgency) => audio.beep(520 + urgency * 680),
  });
  remotePlayers = createRemotePlayers(scene);
  // The welcome roster arrived before remotePlayers existed (and the server
  // only broadcasts the roster when it CHANGES) — apply it now, or a fresh
  // client would show nobody until some other player moves.
  if (welcome) remotePlayers.applySnapshot(welcome.players, net?.playerId ?? null);
  bombFx = createBombFx(scene, { onFuseTick: (urgency) => audio.bombTick(urgency) });
  powerups = createPartyPowerups(scene, {
    tileUrl: tileDataUrl('cotton_tan'),
    tintCss,
    onUseSlot: (slot) => net?.sendUseItem(slot),
  });
  murderHud = createMurderHud();
  murderFx = createMurderFx(scene);
  mobRenderer = createMobRenderer(scene); // populated by `mobs` snapshots
  // BedWars pooled arrows + damage numbers; `world` follows the active match.
  bwFx = createBwFx(scene, {
    getWorld: () => (gameMode === 'bedwars' ? world : null),
  });

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
  menuUi.syncPointerUi();
  menuUi.refreshMenu();
  menuUi.refreshModeBadge();
  menuUi.refreshMatchControls();
  // window.__mc test/automation hooks (see devHooks.ts) — getters close over
  // the `let` singletons above, same pattern the hook literal used.
  installDevHooks({
    get world() {
      return world!;
    },
    get worldRenderer() {
      return worldRenderer!;
    },
    get player() {
      return player!;
    },
    get net() {
      return net;
    },
    get remotePlayers() {
      return remotePlayers!;
    },
    get mobRenderer() {
      return mobRenderer!;
    },
    get chatHistory() {
      return chatHistory;
    },
    get gameMode() {
      return gameMode;
    },
    get bwState() {
      return bwState;
    },
    get partyState() {
      return partyState;
    },
    get murderState() {
      return murderState;
    },
    get zapperArmed() {
      return zapperArmed;
    },
    get zapperUsed() {
      return zapperUsed;
    },
    get bwHotbar() {
      return bwHotbar;
    },
    get bwUi() {
      return bwUi;
    },
    get camera() {
      return camera;
    },
    get heldItem() {
      return heldItem
        ? { kind: heldItem.kind, blockId: heldItem.blockId, swinging: heldItem.swinging }
        : null;
    },
    raycastFromCamera,
    tryPlace,
    breakBlockAt,
    attackTarget,
    startBedwars: menuUi.startBedwars,
    startParty: menuUi.startParty,
    startMurder: menuUi.startMurder,
    leaveGame: menuUi.leaveGame,
    zapUnderCrosshair,
    bwHeldItem,
    startBowCharge,
    releaseBowCharge,
    get bowCharging() {
      return bowCharging;
    },
    get arrowFx() {
      return bwFx ? { live: bwFx.liveArrows, seen: bwFx.arrowsSeen } : { live: 0, seen: 0 };
    },
    toggleShopUi,
    openChat,
    mobDieds,
    shoves,
  });
  console.log(`[mc] world ready — spawn feet (${spawn.x}, ${spawn.y}, ${spawn.z})`);
}

// --- frame loop -------------------------------------------------------------

function updateSelection(): void {
  currentTarget = player?.isLocked ? raycastFromCamera() : null;
  crosshairEl.classList.toggle('hidden', !player?.isLocked);
  if (currentTarget && selection) selection.show(currentTarget.x, currentTarget.y, currentTarget.z);
  else selection?.hide();
}

/**
 * Held-item viewmodel tick (M7.5): the content mapping runs every frame even
 * while hidden (idempotent setters — and tests read __mc.heldItem without a
 * pointer lock), while visibility mirrors the crosshair's locked-means-playing
 * rule minus the dead/ghost states: BedWars respawn wait, murder ghost, and
 * the party spectate-zapper window all hide it.
 */
function tickHeldItem(now: number, dt: number): void {
  if (!heldItem) return;
  updateHeldItem();
  const playing =
    state === 'ready' &&
    (player?.isLocked ?? false) &&
    (gameMode !== 'murder' || (murderState?.alive ?? true)) &&
    (gameMode !== 'bedwars' || (bwState?.me()?.alive ?? true)) &&
    !(gameMode === 'party' && zapperArmed);
  heldItem.setVisible(playing);
  // Walk bob gates: same thresholds as player.ts's own footstep accumulation.
  const walking =
    !!player && player.onGround && !player.flying && Math.hypot(player.vel.x, player.vel.z) > 0.5;
  heldItem.update(now, dt, walking); // keeps the swing arc advancing even while hidden
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
let groanTimer = 2; // zombie-groan countdown (see frame loop)

function frame(now: number): void {
  const dt = Math.min((now - last) / 1000, MAX_DT);
  last = now;

  dayNight.update(dt); // cosmetic sky/light cycle

  // Zombie groans: occasional, only when one is actually near the camera.
  groanTimer -= dt;
  if (groanTimer <= 0) {
    groanTimer = 1.2 + Math.random() * 1.5;
    if (gameMode === 'sandbox' && player && mobRenderer) {
      let nearest = Infinity;
      for (const mob of mobRenderer.map.values()) {
        if (mob.kind !== 'zombie') continue;
        const d = mob.position.distanceTo(player.pos);
        if (d < nearest) nearest = d;
      }
      if (nearest < 20) audio.zombieGroan();
    }
  }

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
    bombFx?.update(now, dt); // color bomb pulse/sparks/beeps + detonation burst
    powerups?.update(now, dt); // mystery box spin/bob + buff bars + beam fade
    murderHud?.tick(); // murder clock interpolation + JAMMED countdown (server-epoch time)
    murderFx?.update(now, dt); // floor coins spin/bob + gravestone settle + beam fade
    bwFx?.update(now, dt); // bow arrows' ballistic flight + damage-number rise/fade
    tickBowCharge(); // bow charge bar + viewmodel draw tilt (no-op when idle)
    remotePlayers?.update(now, dt);
    mobRenderer?.update(now, dt); // mob interp + leg swing + damage flash
    maybeSendMove(now);
    updateSelection();
    // Hold-Tab player list stays live (scores, hp, AFK) while shown.
    playerListUi.tickPlayerList(now);
  }

  tickHeldItem(now, dt); // viewmodel bob/swing/visibility (runs in every state)
  render(dt);
  if (state === 'ready') debugOverlay.setInfo(collectDebugInfo());
  debugOverlay.tick(now);
  requestAnimationFrame(frame);
}

function teardown(): void {
  net?.dispose();
  remotePlayers?.dispose();
  mobRenderer?.dispose();
  chat?.dispose();
  bwUi?.dispose();
  matchHud?.dispose();
  partyUi?.dispose();
  bombFx?.dispose();
  powerups?.dispose();
  bwFx?.dispose();
  heldItem?.dispose();
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
