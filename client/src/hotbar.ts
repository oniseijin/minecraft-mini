/**
 * 9-slot hotbar (DOM, bottom-center): tile icons, digits 1–9 + mouse wheel to
 * select, highlighted selected slot. While the pointer is NOT locked (title /
 * pause screen) the slots are also clickable; while locked they stay inert so
 * clicks keep meaning break/place. Styling lives in index.html.
 */

import { BLOCKS } from '@mc/shared';
import { createSlot } from './dom';

export interface HotbarOptions {
  /** Slot clicks only select when this returns true (default: always). */
  canSelect?: () => boolean;
}

export interface Hotbar {
  /** Index (0–8) of the currently selected slot. */
  readonly selected: number;
  select(index: number): void;
  dispose(): void;
}

export function createHotbar(
  container: HTMLElement,
  blocks: readonly number[],
  iconDataUrl: (blockId: number) => string,
  options: HotbarOptions = {},
): Hotbar {
  container.replaceChildren();
  const slots: HTMLDivElement[] = [];
  let selected = 0;

  const onSlotClick = (index: number) => (event: MouseEvent) => {
    event.stopPropagation(); // never triggers the overlay's pointer-lock request
    if (options.canSelect && !options.canSelect()) return;
    select(index);
  };

  blocks.forEach((id, i) => {
    const slot = createSlot({
      iconUrl: iconDataUrl(id),
      alt: BLOCKS[id].name,
      count: null,
      num: String(i + 1),
      onClick: onSlotClick(i),
    });
    container.appendChild(slot);
    slots.push(slot);
  });

  function select(index: number): void {
    const count = blocks.length;
    selected = ((index % count) + count) % count;
    slots.forEach((slot, i) => slot.classList.toggle('selected', i === selected));
  }

  select(0);

  return {
    get selected() {
      return selected;
    },
    select,
    dispose() {
      container.replaceChildren();
    },
  };
}
