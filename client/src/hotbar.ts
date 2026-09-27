/**
 * 9-slot hotbar (DOM, bottom-center): tile icons, digits 1–9 + mouse wheel
 * to select, highlighted selected slot. Styling lives in index.html.
 */

import { BLOCKS } from '@mc/shared';

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
): Hotbar {
  container.replaceChildren();
  const slots: HTMLDivElement[] = [];
  let selected = 0;

  blocks.forEach((id, i) => {
    const slot = document.createElement('div');
    slot.className = 'slot';
    const img = document.createElement('img');
    img.src = iconDataUrl(id);
    img.alt = BLOCKS[id].name;
    img.draggable = false;
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = String(i + 1);
    slot.append(img, num);
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
