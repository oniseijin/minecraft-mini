/**
 * BedWars hotbar (DOM, bottom-center, reuses the sandbox #hotbar styles): four
 * bought-item slots — wool, planks, sword, golden apple. Slots 1–4 (digits) +
 * mouse wheel to select; each slot shows a count badge (blocks/apples) or a
 * ghost style when the item is not owned (sword slot empty). Selected slot =
 * the "held" item reported with attacks. While the pointer is NOT locked the
 * slots are clickable, like the sandbox hotbar.
 */

export interface BwItemView {
  /** Stable item key ('wool' | 'planks' | 'sword' | 'apple'). */
  key: string;
  /** Icon image URL; null renders an empty slot (no sword owned). */
  iconUrl: string | null;
  label: string;
  /** Stack count badge; null = no badge (unique items like the sword). */
  count: number | null;
  /** Ghosted (unowned sword) styling. */
  muted?: boolean;
}

export interface BwHotbarOptions {
  /** Slot clicks only select when this returns true (default: always). */
  canSelect?: () => boolean;
  /** Selection changed (main.ts keeps the held-item icon in sync). */
  onSelect?: (index: number) => void;
}

export interface BwHotbar {
  readonly selected: number;
  readonly items: readonly BwItemView[];
  setItems(items: readonly BwItemView[]): void;
  /** Clamps to the item count (digits 5–9 are ignored in bedwars). */
  select(index: number): void;
  dispose(): void;
}

export function createBwHotbar(
  container: HTMLElement,
  initialItems: readonly BwItemView[],
  options: BwHotbarOptions = {},
): BwHotbar {
  let items = [...initialItems];
  let selected = 0;
  const slots: HTMLDivElement[] = [];

  const renderSlot = (item: BwItemView, index: number): HTMLDivElement => {
    const slot = document.createElement('div');
    slot.className = 'slot';
    if (item.iconUrl !== null) {
      const img = document.createElement('img');
      img.src = item.iconUrl;
      img.alt = item.label;
      img.draggable = false;
      slot.appendChild(img);
    }
    if (item.count !== null) {
      const badge = document.createElement('span');
      badge.className = 'count';
      badge.textContent = String(item.count);
      slot.appendChild(badge);
    }
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = String(index + 1);
    slot.appendChild(num);
    if (item.muted) slot.classList.add('muted');
    slot.addEventListener('click', (event) => {
      event.stopPropagation(); // never triggers the overlay's pointer-lock request
      if (options.canSelect && !options.canSelect()) return;
      select(index);
    });
    return slot;
  };

  const render = (): void => {
    container.replaceChildren();
    slots.length = 0;
    items.forEach((item, index) => {
      const slot = renderSlot(item, index);
      slot.classList.toggle('selected', index === selected);
      container.appendChild(slot);
      slots.push(slot);
    });
  };

  function select(index: number): void {
    const next = Math.max(0, Math.min(items.length - 1, index));
    if (next === selected && slots.length === items.length) return;
    selected = next;
    slots.forEach((slot, i) => slot.classList.toggle('selected', i === selected));
    options.onSelect?.(selected);
  }

  render();

  return {
    get selected() {
      return selected;
    },
    get items() {
      return items;
    },
    setItems(next) {
      items = [...next];
      render();
    },
    select,
    dispose() {
      container.replaceChildren();
    },
  };
}
