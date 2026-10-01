/**
 * BedWars-specific HUD (M4): pure DOM, all ids live in index.html.
 *
 * - Top bar: team cards (name, mini hp bar, bed icon that greys out when the
 *   bed is gone) around the match timer.
 * - Own hearts row + iron/gold/emerald currency chips (Kenney item icons).
 * - Held-item icon (bottom-right).
 * - Fullscreen respawn dim ("Respawning in 5…"), red hurt vignette.
 * - Shop panel (B near your island): item grid with prices + buy buttons;
 *   works while the pointer is unlocked, closes with B/Esc/×.
 *
 * The mode-shared HUD pieces both mini-games use — banner, kill feed, results
 * screen, frame visibility, party feed-only mode — live in matchHud.ts
 * (REFACTORING.md 2a.3). This module never mutates match state — it renders
 * the BwState mirror and forwards clicks via the onBuy callback.
 */

import { SHOP_ITEMS, type ShopItemId } from '@mc/shared';
import type { BwState } from './bwState';
import { makeEl } from './dom';

export interface BedwarsUiOptions {
  /** Currency chip icon URLs (Kenney ore items). */
  currencyIcons: { iron: string; gold: string; emerald: string };
  /** Team bed tile icon URLs (atlas data URLs, index = team). */
  bedIcons: [string, string];
  /** Resolves shop icon specs ('tile:snow' / 'item:apple') to URLs. */
  iconResolver(spec: string): string;
  onBuy(item: ShopItemId): void;
}

export interface BedwarsUi {
  /** Full HUD refresh from the state mirror (gameState rate + after events). */
  sync(bw: BwState): void;
  /** null hides the overlay; a number shows the countdown text. */
  respawn(seconds: number | null): void;
  hurt(): void;
  /** Held-item icon (bottom-right); null hides it. */
  setHeld(iconUrl: string | null, count: number | null): void;
  readonly isShopOpen: boolean;
  /** Toggles the shop; returns the new open state. */
  toggleShop(bw: BwState): boolean;
  closeShop(): void;
  dispose(): void;
}

const HEARTS = 10;

const el = makeEl('bedwarsUi');

function fmtTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function createBedwarsUi(options: BedwarsUiOptions): BedwarsUi {
  const timerEl = el<HTMLDivElement>('bw-timer');
  const heartsEl = el<HTMLDivElement>('bw-hearts');
  const ironEl = el<HTMLElement>('bw-iron');
  const goldEl = el<HTMLElement>('bw-gold');
  const emeraldEl = el<HTMLElement>('bw-emerald');
  const heldIcon = el<HTMLImageElement>('bw-held-icon');
  const heldEl = el<HTMLDivElement>('bw-held');
  const respawnEl = el<HTMLDivElement>('bw-respawn');
  const respawnN = el<HTMLElement>('bw-respawn-n');
  const vignetteEl = el<HTMLDivElement>('bw-vignette');
  const shopEl = el<HTMLDivElement>('bw-shop');
  const shopGrid = el<HTMLDivElement>('bw-shop-grid');

  // Build the hearts row once.
  const heartFills: HTMLSpanElement[] = [];
  for (let i = 0; i < HEARTS; i++) {
    const heart = document.createElement('span');
    heart.className = 'heart';
    heart.append('♥');
    const fill = document.createElement('span');
    fill.className = 'hp';
    fill.append('♥');
    heart.appendChild(fill);
    heartsEl.appendChild(heart);
    heartFills.push(fill);
  }

  // Currency chips.
  const chipIcons: Record<'iron' | 'gold' | 'emerald', HTMLImageElement> = {
    iron: el<HTMLImageElement>('bw-iron-icon'),
    gold: el<HTMLImageElement>('bw-gold-icon'),
    emerald: el<HTMLImageElement>('bw-emerald-icon'),
  };
  chipIcons.iron.src = options.currencyIcons.iron;
  chipIcons.gold.src = options.currencyIcons.gold;
  chipIcons.emerald.src = options.currencyIcons.emerald;

  // Bed icons in the team cards.
  const bedIcons = [el<HTMLImageElement>('bw-bed-0'), el<HTMLImageElement>('bw-bed-1')];
  bedIcons[0].src = options.bedIcons[0];
  bedIcons[1].src = options.bedIcons[1];
  const shopChipIcons: Record<'iron' | 'gold' | 'emerald', HTMLImageElement> = {
    iron: el<HTMLImageElement>('bw-shop-iron-icon'),
    gold: el<HTMLImageElement>('bw-shop-gold-icon'),
    emerald: el<HTMLImageElement>('bw-shop-emerald-icon'),
  };
  shopChipIcons.iron.src = options.currencyIcons.iron;
  shopChipIcons.gold.src = options.currencyIcons.gold;
  shopChipIcons.emerald.src = options.currencyIcons.emerald;
  const teamNames = [el<HTMLElement>('bw-name-0'), el<HTMLElement>('bw-name-1')];
  const teamHp = [el<HTMLDivElement>('bw-hpbar-0'), el<HTMLDivElement>('bw-hpbar-1')];

  let vignetteTimer: number | undefined;
  let shopOpen = false;

  // --- hurt vignette -------------------------------------------------------------

  function hurt(): void {
    vignetteEl.classList.add('show');
    if (vignetteTimer !== undefined) clearTimeout(vignetteTimer);
    vignetteTimer = window.setTimeout(() => vignetteEl.classList.remove('show'), 220);
  }

  // --- HUD sync ---------------------------------------------------------------

  function renderHearts(hp: number): void {
    const clamped = Math.max(0, Math.min(20, hp));
    for (let i = 0; i < HEARTS; i++) {
      const value = Math.max(0, Math.min(2, clamped - i * 2));
      heartFills[i].style.width = `${(value / 2) * 100}%`;
    }
  }

  function renderTeamCard(bw: BwState, team: 0 | 1): void {
    const player = [...bw.players.values()].find((p) => p.team === team);
    if (player) {
      teamNames[team].textContent = player.alive ? player.name : `${player.name} ☠`;
      teamHp[team].style.width = `${Math.max(0, Math.min(100, (player.hp / 20) * 100))}%`;
    } else {
      teamNames[team].textContent = '—';
      teamHp[team].style.width = '0%';
    }
    bedIcons[team].classList.toggle('lost', !bw.bedsAlive[team]);
    bedIcons[team].classList.toggle('alive', bw.bedsAlive[team]);
  }

  function sync(bw: BwState): void {
    const me = bw.me();
    renderHearts(me?.hp ?? 20);
    if (bw.phase === 'countdown') timerEl.textContent = `Starting in ${Math.ceil(bw.timeLeft)}s`;
    else if (bw.phase === 'ended') timerEl.textContent = 'Match over';
    else timerEl.textContent = fmtTime(bw.timeLeft);
    ironEl.textContent = String(bw.currency.iron);
    goldEl.textContent = String(bw.currency.gold);
    emeraldEl.textContent = String(bw.currency.emerald);
    renderTeamCard(bw, 0);
    renderTeamCard(bw, 1);
    if (shopOpen) renderShop(bw);
  }

  // --- shop ---------------------------------------------------------------

  function priceChip(item: (typeof SHOP_ITEMS)[number]): HTMLSpanElement {
    const chip = document.createElement('span');
    chip.className = `price ${item.currency}`;
    const icon = document.createElement('img');
    icon.src = options.currencyIcons[item.currency];
    chip.append(icon, ` ${item.price}`);
    return chip;
  }

  function renderShop(bw: BwState): void {
    el<HTMLElement>('bw-shop-iron').textContent = String(bw.currency.iron);
    el<HTMLElement>('bw-shop-gold').textContent = String(bw.currency.gold);
    el<HTMLElement>('bw-shop-emerald').textContent = String(bw.currency.emerald);
    shopGrid.replaceChildren();
    for (const item of SHOP_ITEMS) {
      const row = document.createElement('div');
      row.className = 'shop-item';
      const icon = document.createElement('img');
      icon.src = options.iconResolver(item.icon);
      icon.alt = item.name;
      const info = document.createElement('div');
      info.className = 'shop-info';
      const name = document.createElement('div');
      name.className = 'shop-name';
      name.textContent = item.name;
      const desc = document.createElement('div');
      desc.className = 'shop-desc';
      desc.textContent = item.description;
      info.append(name, desc);
      const buy = document.createElement('button');
      buy.type = 'button';
      buy.className = 'shop-buy';
      buy.append(priceChip(item));
      buy.disabled = bw.currency[item.currency] < item.price;
      buy.addEventListener('click', (event) => {
        event.stopPropagation();
        options.onBuy(item.id);
      });
      row.append(icon, info, buy);
      shopGrid.appendChild(row);
    }
  }

  function toggleShop(bw: BwState): boolean {
    shopOpen = !shopOpen;
    if (shopOpen) renderShop(bw);
    shopEl.classList.toggle('hidden', !shopOpen);
    return shopOpen;
  }

  function closeShop(): void {
    shopOpen = false;
    shopEl.classList.add('hidden');
  }

  el<HTMLButtonElement>('bw-shop-close').addEventListener('click', (event) => {
    event.stopPropagation();
    closeShop();
  });

  return {
    sync,
    respawn(seconds) {
      if (seconds === null) {
        respawnEl.classList.add('hidden');
        return;
      }
      respawnN.textContent = String(Math.max(1, Math.ceil(seconds)));
      respawnEl.classList.remove('hidden');
    },
    hurt,
    setHeld(iconUrl, count) {
      if (iconUrl === null) {
        heldEl.classList.add('hidden');
        return;
      }
      heldEl.classList.remove('hidden');
      heldIcon.src = iconUrl;
      heldIcon.alt = count !== null ? `×${count}` : 'held item';
    },
    get isShopOpen() {
      return shopOpen;
    },
    toggleShop,
    closeShop,
    dispose() {
      if (vignetteTimer !== undefined) clearTimeout(vignetteTimer);
    },
  };
}
