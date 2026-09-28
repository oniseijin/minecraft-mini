/**
 * Block Party mystery boxes + power-ups client (protocol v7, DESIGN.md
 * §3.4.3). Three cheap pieces, following the bombFx / bwHotbar patterns:
 *
 * - 3D mystery boxes: one pooled spinning cube per live box cell (≤2), a
   *  little bob so they read as "walk into me". Hidden whenever the snapshot
 *   carries no boxes; 2 draw calls max.
 * - Held-item slots (DOM): three fixed slots above-left of the party HUD with
 *   the item name + key number; speed/jump buffs show a shrinking timer bar
 *   driven by the server's absolute expiry. The Kenney item pack has no
 *   feather/potion/keypad sprites, so icons are tinted cotton tiles (the same
 *   CSS multiply-blend trick as the party swatch) + a text label —
 *   colorblind-safe by construction.
 * - Spectate Color Zapper FX: a white beam flash + fade above the zapped cell
 *   (the block break itself arrives as a normal blockEdit; main.ts pairs this
 *   with a bombFx burst) plus the hint element shown while MY zap is armed.
 *
 * This module renders only; the server owns every rule (spawn, pickup, caps,
 * use validation, zap validation). Item `use` goes through options.onUseSlot
 * (keys 1/2/3 in main.ts) so the DOM stays input-free.
 */

import * as THREE from 'three';
import { EFFECT_DURATION_MS, PARTY_FLOOR, type PartyItemId } from '@mc/shared';
import type { PartyEffectsView } from './partyState';

export interface PartyItemMeta {
  id: PartyItemId;
  /** Full name (toasts, kill feed). */
  name: string;
  /** Short slot label. */
  label: string;
  /** Icon tint (multiplied over the cotton tile, like the mesher). */
  tint: [number, number, number];
}

/** The five items + their UI metadata (weights live server-side). */
export const PARTY_ITEMS: Record<PartyItemId, PartyItemMeta> = {
  leap: { id: 'leap', name: 'Leap', label: 'Leap', tint: [0.98, 0.9, 0.45] },
  speed: { id: 'speed', name: 'Speed', label: 'Speed', tint: [0.3, 0.6, 0.98] },
  jump: { id: 'jump', name: 'Jump Boost', label: 'Jump', tint: [0.35, 0.88, 0.35] },
  swapper: { id: 'swapper', name: 'Swapper', label: 'Swap', tint: [0.78, 0.42, 0.95] },
  teleporter: { id: 'teleporter', name: 'Color Teleporter', label: 'Warp', tint: [0.16, 0.88, 0.85] },
};

export const PARTY_ITEM_SLOTS = 3;

export interface PartyPowerupsOptions {
  /** The neutral cotton tile data URL, tinted for item icons. */
  tileUrl: string;
  /** Item tint [0..1]³ → css rgb() (partyUi's tintCss). */
  tintCss(tint: [number, number, number]): string;
  /** Slot key pressed (main.ts sends useItem; server validates). */
  onUseSlot(slot: number): void;
}

export interface PartyPowerups {
  /** Mirrors the snapshot's live box cells (≤2; extras hidden). */
  syncBoxes(boxes: readonly [number, number][]): void;
  /** Mirrors my held slots + buff expiries into the DOM. */
  syncSlots(items: readonly PartyItemId[], effects: PartyEffectsView | null): void;
  /** Shows/hides the zapper hint ("click a floor tile"). */
  showZapper(show: boolean): void;
  /** Beam flash above a zapped cell (block break arrives via blockEdits). */
  zapFx(cell: [number, number]): void;
  /** Per-frame: box spin/bob, buff timer bars, beam fade. */
  update(nowMs: number, dt: number): void;
  /** Hides everything (mode swap / fresh match) without disposing. */
  reset(): void;
  dispose(): void;
}

const BOX_SIZE = 0.38;
const BOX_SPIN = 1.6; // rad/s
const BOB_HEIGHT = 0.09;
const BOB_RATE = 2.4; // rad/s
const BEAM_MS = 320;
// EFFECT_DURATION_MS (buff timer bar length) comes from @mc/shared — the same
// constant the server's party.ts tracks expiry with (was a local "must match
// EFFECT_MS" copy).

/** World position of a box hovering over its floor cell. */
function boxPosition(cell: [number, number]): THREE.Vector3 {
  return new THREE.Vector3(cell[0] + 0.5, PARTY_FLOOR.y + 1 + 0.55, cell[1] + 0.5);
}

export function createPartyPowerups(scene: THREE.Scene, options: PartyPowerupsOptions): PartyPowerups {
  // --- mystery box meshes (pooled: 2 covers the max) --------------------------
  const boxGeometry = new THREE.BoxGeometry(BOX_SIZE, BOX_SIZE, BOX_SIZE);
  const boxMaterial = new THREE.MeshBasicMaterial({ color: 0x5b3fa8 }); // "mystery" violet, reads on any wool
  const boxMeshes: THREE.Mesh[] = [];
  for (let i = 0; i < 2; i++) {
    const mesh = new THREE.Mesh(boxGeometry, boxMaterial);
    mesh.visible = false;
    scene.add(mesh);
    boxMeshes.push(mesh);
  }
  let boxes: readonly [number, number][] = [];

  // --- zapper beam (one pooled flash) ------------------------------------------
  const beam = new THREE.Mesh(
    new THREE.BoxGeometry(0.22, 7, 0.22),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }),
  );
  beam.visible = false;
  scene.add(beam);
  let beamStartedAt = 0;

  // --- DOM: held-item slots + zapper hint ---------------------------------------
  const container = document.getElementById('party-items');
  const hint = document.getElementById('party-zapper');
  if (!container || !hint) throw new Error('[partyPowerups] missing #party-items / #party-zapper');

  interface SlotDom {
    root: HTMLDivElement;
    icon: HTMLDivElement;
    label: HTMLElement;
    timer: HTMLDivElement;
    item: PartyItemId | null;
    /** Active buff expiry (epoch ms) for speed/jump slots, else 0. */
    buffUntil: number;
  }
  const slots: SlotDom[] = [];

  for (let i = 0; i < PARTY_ITEM_SLOTS; i++) {
    const root = document.createElement('div');
    root.className = 'pitem';

    const key = document.createElement('span');
    key.className = 'pitem-key';
    key.textContent = String(i + 1);

    const icon = document.createElement('div');
    icon.className = 'pitem-icon';

    const label = document.createElement('span');
    label.className = 'pitem-label';

    const timer = document.createElement('div');
    timer.className = 'pitem-timer';
    const timerFill = document.createElement('div');
    timerFill.className = 'pitem-timer-fill';
    timer.appendChild(timerFill);

    root.append(key, icon, label, timer);
    root.addEventListener('click', (event) => {
      event.stopPropagation(); // never steals the overlay's pointer-lock click
      if (slots[i].item !== null) options.onUseSlot(i);
    });
    container.appendChild(root);
    slots.push({ root, icon, label, timer: timerFill, item: null, buffUntil: 0 });
  }

  return {
    syncBoxes(next) {
      boxes = next;
      for (let i = 0; i < boxMeshes.length; i++) {
        const mesh = boxMeshes[i];
        const cell = boxes[i];
        if (cell) {
          mesh.position.copy(boxPosition(cell));
          mesh.visible = true;
        } else {
          mesh.visible = false;
        }
      }
    },
    syncSlots(items, effects) {
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i];
        const item = items[i] ?? null;
        slot.item = item;
        slot.buffUntil = effects
          ? item === 'speed'
            ? effects.speedUntil
            : item === 'jump'
              ? effects.jumpUntil
              : 0
          : 0;
        if (item === null) {
          slot.root.classList.remove('filled', 'buffed');
          slot.icon.style.backgroundColor = 'rgba(255,255,255,0.08)';
          slot.icon.style.backgroundImage = '';
          slot.label.textContent = '';
          slot.timer.style.width = '0%';
          continue;
        }
        const meta = PARTY_ITEMS[item];
        slot.root.classList.add('filled');
        slot.icon.style.backgroundColor = options.tintCss(meta.tint);
        slot.icon.style.backgroundImage = `url("${options.tileUrl}")`;
        slot.icon.style.backgroundBlendMode = 'multiply';
        slot.icon.style.backgroundSize = 'cover';
        slot.label.textContent = meta.label;
        slot.root.classList.toggle('buffed', slot.buffUntil > Date.now());
      }
    },
    showZapper(show) {
      hint.classList.toggle('hidden', !show);
    },
    zapFx(cell) {
      beam.position.set(cell[0] + 0.5, PARTY_FLOOR.y + 1 + 3.5, cell[1] + 0.5);
      (beam.material as THREE.MeshBasicMaterial).opacity = 1;
      beam.visible = true;
      beamStartedAt = performance.now();
    },
    update(nowMs) {
      // Boxes: spin + bob.
      for (let i = 0; i < boxMeshes.length; i++) {
        const mesh = boxMeshes[i];
        if (!mesh.visible) continue;
        mesh.rotation.y = (nowMs / 1000) * BOX_SPIN + i * 1.3;
        const base = boxes[i] ? boxPosition(boxes[i]) : null;
        if (base) {
          mesh.position.y = base.y + Math.sin((nowMs / 1000) * BOB_RATE + i * 2.1) * BOB_HEIGHT;
        }
      }

      // Beam flash: quick fade then hide.
      if (beam.visible) {
        const age = performance.now() - beamStartedAt;
        if (age >= BEAM_MS) {
          beam.visible = false;
        } else {
          (beam.material as THREE.MeshBasicMaterial).opacity = 1 - age / BEAM_MS;
        }
      }

      // Buff timer bars: shrink to empty as the expiry approaches.
      for (const slot of slots) {
        if (slot.item === null || (slot.item !== 'speed' && slot.item !== 'jump')) continue;
        const active = slot.buffUntil > Date.now();
        slot.root.classList.toggle('buffed', active);
        slot.timer.style.width = active
          ? `${Math.max(0, Math.min(100, ((slot.buffUntil - Date.now()) / EFFECT_DURATION_MS) * 100))}%`
          : '0%';
      }
    },
    reset() {
      boxes = [];
      for (const mesh of boxMeshes) mesh.visible = false;
      beam.visible = false;
      hint.classList.add('hidden');
      this.syncSlots([], null);
    },
    dispose() {
      this.reset();
      for (const mesh of boxMeshes) scene.remove(mesh);
      scene.remove(beam);
      boxGeometry.dispose();
      boxMaterial.dispose();
      beam.geometry.dispose();
      (beam.material as THREE.Material).dispose();
      container.replaceChildren();
    },
  };
}
