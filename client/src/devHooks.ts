import * as THREE from 'three';
import {
  EYE_HEIGHT,
  type GameMode,
  type HeldItemId,
  type RayHit,
  type ShopItemId,
  type World,
} from '@mc/shared';
import { type Player } from './player';
import { type WorldRenderer } from './world/worldRenderer';
import { type Net, type NetMode } from './net';
import { type RemoteAvatar, type RemotePlayers } from './remotePlayer';
import { type MobAvatar, type MobRenderer } from './mobs';
import { type BwState } from './bwState';
import { type MurderState } from './murderState';
import { type BedwarsUi } from './bedwarsUi';
import { type BwHotbar } from './bwHotbar';
import { type PartyState } from './partyState';
import { type HeldItemView } from './heldItem';

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
      /** Live mob avatars by server mob id (sandbox only; cleared in matches). */
      mobs: Map<number, MobAvatar>;
      /** Recent mobDied events, oldest first (smoke-test visibility). */
      mobDieds: { id: number; kind: string; at: [number, number, number] }[];
      shoves: { by: number; power: number; at: number }[];
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
      /** Murder Mystery state mirror (null outside murder; M7.3). */
      readonly murder: MurderState | null;
      /** Menu-button paths. */
      startBedwars(): void;
      startParty(): void;
      startMurder(): void;
      leaveGame(): void;
      ready(): void;
      buy(item: ShopItemId): void;
      useHeld(): void;
      /** Block Party power-ups: use held slot 0–2 (server validates). */
      useItem(slot: number): void;
      /** Block Party spectate Color Zapper (server validates the cell). */
      sendZapCell(x: number, z: number): void;
      /** Murder Mystery: fire the detective zapper at a guest (server validates). */
      sendZapGuest(id: number): void;
      /** Murder Mystery: read the gravestone at a floored cell (server validates). */
      sendInvestigate(x: number, z: number): void;
      /** Full zapper click path: camera raycast → floor cell → zapCell send. */
      zapUnderCrosshair(): boolean;
      /** Zapper arming state (armed = I fell and may zap once). */
      readonly zapper: { armed: boolean; used: boolean };
      /** BedWars hotbar + held item. */
      selectSlot(index: number): void;
      held(): HeldItemId;
      /** BedWars bow (v10): hold-to-charge path (same functions the mouse uses). */
      startBowCharge(): boolean;
      releaseBowCharge(): boolean;
      readonly bowCharging: boolean;
      /** In-flight arrow render state: live now + total spawned (smoke tests). */
      readonly arrowFx: { live: number; seen: number };
      /** Held-item viewmodel state (M7.5): kind + block + swing arc. */
      readonly heldItem: HeldItemView | null;
      /** Shop panel (B key path). */
      openShop(): boolean;
      closeShop(): void;
      readonly isShopOpen: boolean;
      /** Opens the chat input without requiring pointer lock (tests). */
      openChat(): void;
    };
  }
}

/**
 * What main.ts lends the `__mc` surface. Live singletons come through getters
 * (the active world/renderer pair swaps on modeChanged) — the literal's `!`
 * non-null assertions moved into those getters. Stable functions and
 * append-only arrays pass directly.
 */
export interface DevHost {
  get world(): World;
  get worldRenderer(): WorldRenderer;
  get player(): Player;
  get net(): Net | null;
  get remotePlayers(): RemotePlayers;
  get mobRenderer(): MobRenderer;
  get chatHistory(): { from: string; text: string }[];
  get gameMode(): GameMode;
  get bwState(): BwState | null;
  get partyState(): PartyState | null;
  /** Murder Mystery mirror (M7.3); null outside murder matches. */
  get murderState(): MurderState | null;
  get zapperArmed(): boolean;
  get zapperUsed(): boolean;
  get bwHotbar(): BwHotbar | null;
  get bwUi(): BedwarsUi | null;
  get camera(): THREE.PerspectiveCamera;
  /** Held-item viewmodel snapshot (M7.5); null before boot finishes. */
  get heldItem(): HeldItemView | null;

  raycastFromCamera(): RayHit | null;
  tryPlace(x: number, y: number, z: number): boolean;
  breakBlockAt(x: number, y: number, z: number): boolean;
  /** Aliased to `tryAttack` on the hook surface. */
  attackTarget(): boolean;
  startBedwars(): void;
  startParty(): void;
  startMurder(): void;
  leaveGame(): void;
  zapUnderCrosshair(): boolean;
  bwHeldItem(): HeldItemId;
  startBowCharge(): boolean;
  releaseBowCharge(): boolean;
  get bowCharging(): boolean;
  get arrowFx(): { live: number; seen: number };
  toggleShopUi(): void;
  openChat(): void;
  mobDieds: { id: number; kind: string; at: [number, number, number] }[];
  shoves: { by: number; power: number; at: number }[];
}

/**
 * Installs `window.__mc` once the world finished meshing — the load-bearing
 * test API every tools/smoke-*.mjs suite asserts through. The surface shape is
 * explicitly NOT refactoring (REFACTORING.md); keep it byte-identical.
 */
export function installDevHooks(host: DevHost): void {
  window.__mc = {
    // Getters: the active world/renderer pair swaps on modeChanged.
    get world() {
      return host.world;
    },
    get worldRenderer() {
      return host.worldRenderer;
    },
    raycastFromCamera: host.raycastFromCamera,
    look: (yaw: number, pitch: number) => host.player.look(yaw, pitch),
    lookAt: (x: number, y: number, z: number) => {
      const p = host.player;
      const dx = x - p.pos.x;
      const dy = y - (p.pos.y + EYE_HEIGHT);
      const dz = z - p.pos.z;
      p.look(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
    },
    camera: host.camera,
    player: host.player,
    tryPlace: host.tryPlace,
    breakBlockAt: host.breakBlockAt,
    tryAttack: host.attackTarget,
    net: {
      get mode() {
        return host.net?.mode ?? 'offline';
      },
      get connected() {
        return host.net?.connected ?? false;
      },
      get id() {
        return host.net?.playerId ?? null;
      },
      get players() {
        return host.net?.players ?? [];
      },
    },
    remotePlayers: host.remotePlayers.map,
    mobs: host.mobRenderer.map,
    mobDieds: host.mobDieds,
    shoves: host.shoves,
    chat: (text: string) => host.net?.sendChat(text),
    chatHistory: host.chatHistory,
    get mode() {
      return host.gameMode;
    },
    get bw() {
      return host.bwState;
    },
    get party() {
      return host.partyState;
    },
    get murder() {
      return host.murderState;
    },
    startBedwars: host.startBedwars,
    startParty: host.startParty,
    startMurder: host.startMurder,
    leaveGame: host.leaveGame,
    ready: () => host.net?.sendReady(),
    buy: (item: ShopItemId) => host.net?.sendBuy(item),
    useHeld: () => host.net?.sendUseHeld(),
    useItem: (slot: number) => host.net?.sendUseItem(slot),
    sendZapCell: (x: number, z: number) => host.net?.sendZapCell(x, z),
    sendZapGuest: (id: number) => host.net?.sendZapGuest(id),
    sendInvestigate: (x: number, z: number) => host.net?.sendInvestigateGravestone(x, z),
    zapUnderCrosshair: host.zapUnderCrosshair,
    get zapper() {
      return { armed: host.zapperArmed, used: host.zapperUsed };
    },
    startBowCharge: host.startBowCharge,
    releaseBowCharge: host.releaseBowCharge,
    get bowCharging() {
      return host.bowCharging;
    },
    get arrowFx() {
      return host.arrowFx;
    },
    selectSlot: (index: number) => host.bwHotbar?.select(index),
    held: host.bwHeldItem,
    get heldItem() {
      return host.heldItem;
    },
    openShop: () => {
      if (host.bwUi?.isShopOpen) return true;
      host.toggleShopUi();
      return host.bwUi?.isShopOpen ?? false;
    },
    closeShop: () => {
      if (host.bwUi?.isShopOpen) host.toggleShopUi();
    },
    get isShopOpen() {
      return host.bwUi?.isShopOpen ?? false;
    },
    openChat: host.openChat,
  };
}
