/**
 * Shared DOM helpers (REFACTORING.md Phase 3): the strict module-tagged
 * getElementById helper (was copy-pasted in each HUD module) and the hotbar
 * slot renderer shared by the sandbox hotbar and the BedWars item hotbar.
 */

/**
 * The strict `el<T>(id)` lookup bound to a module tag: throws with
 * `[<tag>] missing #<id>` when the static DOM is missing an expected node.
 * (A missing id is a programming error, never a runtime condition.)
 */
export function makeEl(tag: string) {
  return function el<T extends HTMLElement>(id: string): T {
    const node = document.getElementById(id);
    if (!node) throw new Error(`[${tag}] missing #${id}`);
    return node as T;
  };
}

export interface SlotSpec {
  /** Icon image URL; null renders an empty slot (an unowned sword/bow). */
  iconUrl: string | null;
  alt: string;
  /** Count badge text; null = no badge (unique items, plain block slots). */
  count: string | null;
  /** The slot's digit label ("1"–"9"). */
  num: string;
  /** Ghosted (unowned) styling. */
  muted?: boolean;
  onClick(event: MouseEvent): void;
}

/**
 * One hotbar slot (`.slot`, styling in index.html): optional icon, optional
 * count badge, then the digit — the exact structure both hotbars rendered
 * inline before the extraction.
 */
export function createSlot(spec: SlotSpec): HTMLDivElement {
  const slot = document.createElement('div');
  slot.className = 'slot';
  if (spec.iconUrl !== null) {
    const img = document.createElement('img');
    img.src = spec.iconUrl;
    img.alt = spec.alt;
    img.draggable = false;
    slot.appendChild(img);
  }
  if (spec.count !== null) {
    const badge = document.createElement('span');
    badge.className = 'count';
    badge.textContent = spec.count;
    slot.appendChild(badge);
  }
  const num = document.createElement('span');
  num.className = 'num';
  num.textContent = spec.num;
  slot.appendChild(num);
  if (spec.muted) slot.classList.add('muted');
  slot.addEventListener('click', spec.onClick);
  return slot;
}
