/**
 * Match-mode lifecycle plumbing (REFACTORING.md 2a.5): the world-swap and
 * park-and-build skeleton shared by every modeChanged→match enter, extracted
 * from main.ts's enterBedwars/enterParty (which were ~15 lines identical ×2).
 *
 * Mode-specific orchestration — state mirrors, HUD mode, hotbars, spawn
 * choice — stays in main.ts next to the singletons it wires; a new mini-game
 * brings its own enter function plus one entry in the modeChanged dispatch
 * table, and reuses this skeleton as-is.
 *
 * The host getters/setters exist because main.ts owns the live singletons
 * (`let` bindings that swap on modeChanged); assignments flow through the
 * setters so this module stays state-free.
 */

import * as THREE from 'three';
import type { EditTuple, World } from '@mc/shared';
import type { Atlas } from './atlas';
import type { Player } from './player';
import type { Selection } from './selection';
import type { WorldRenderer } from './world/worldRenderer';
import { createWorldRenderer } from './world/worldRenderer';
import type { MenuUi } from './hud/menu';

export interface ModeHost {
  readonly scene: THREE.Scene;
  readonly overlay: HTMLElement;
  readonly statusEl: HTMLElement;
  get atlas(): Atlas | null;
  get player(): Player | null;
  get sandboxRenderer(): WorldRenderer | null;
  get worldRenderer(): WorldRenderer | null;
  get selection(): Selection | null;
  get menuUi(): MenuUi;
  /** Disposes the previous match renderer (arenaRenderer?.dispose()). */
  disposeArenaRenderer(): void;
  /** Installs the fresh pair as the active world/renderer (+ arena slots). */
  setArenaWorld(world: World, renderer: WorldRenderer): void;
  setPendingSpawn(spawn: { x: number; y: number; z: number } | null): void;
  /** state = 'switching' + totalToBuild = pendingChunks. */
  beginSwitch(pendingChunks: number): void;
  clearTarget(): void;
}

/**
 * Shared world swap (callers have guarded atlas/player/sandboxRenderer
 * non-null, exactly like the original inline code): apply the modeChanged
 * edits to the freshly generated world, build its renderer, park the sandbox
 * meshes (hidden, intact), and move the player's physics body over.
 */
export function swapToMatchWorld(host: ModeHost, generated: World, edits: readonly EditTuple[]): void {
  generated.applyEdits(edits);
  host.disposeArenaRenderer();
  const renderer = createWorldRenderer(host.scene, generated, host.atlas!);
  host.setArenaWorld(generated, renderer);
  host.sandboxRenderer!.setVisible(false);
  const player = host.player!;
  player.setWorld(generated);
  player.flyAllowed = false; // every match disables flight (party re-unlocks on elimination)
}

/**
 * Shared enter tail: park the player at their spawn-to-be (controls off,
 * lock released, overlay suppressed) and kick the chunk rebuild that ends in
 * finishSwitch() dropping them there.
 */
export function parkForBuild(host: ModeHost, spawn: { x: number; y: number; z: number }, statusText: string): void {
  host.setPendingSpawn(spawn);
  const player = host.player!;
  player.controlsEnabled = false;
  document.exitPointerLock();
  player.overlaySuppressed = false;

  const renderer = host.worldRenderer!;
  renderer.enqueueAllChunks();
  host.beginSwitch(renderer.pendingCount);
  host.overlay.classList.add('loading');
  host.statusEl.textContent = statusText;
  host.selection?.hide();
  host.clearTarget();
  const menu = host.menuUi;
  menu.refreshMatchControls();
  menu.refreshModeBadge();
  menu.refreshMenu();
}
