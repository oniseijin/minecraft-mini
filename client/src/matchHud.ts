/**
 * Mode-shared match HUD (REFACTORING.md 2a.3, moved out of bedwarsUi.ts):
 * every mini-game's HUD chrome — the big center banner (countdowns, FIGHT!,
 * round results), the kill feed (bed breaks, round falls, purchases), and the
 * results screen (victory/defeat + stats + Rematch / Back to sandbox) — plus
 * the #bw-hud frame visibility and Block Party's feed-only mode.
 *
 * BedWars keeps its mode-specific pieces (top bar, hearts, currency, respawn
 * overlay, vignette, held icon, shop) in bedwarsUi.ts; both modes call THIS
 * module through the `matchHud` handle, never through `bwUi`.
 *
 * DOM ids stay `bw-*` (legacy — the smoke suites and CSS assert them); this
 * module never mutates match state, it renders and forwards clicks via the
 * onRematch/onLeave callbacks.
 */

import type { BwResults } from './bwState';

export interface MatchHudOptions {
  onRematch(): void;
  onLeave(): void;
  /**
   * Called when the HUD frame hides so mode-specific panels can close
   * (BedWars wires its shop + respawn overlay here). Runs inside showHud(false).
   */
  onHide?(): void;
}

export interface MatchHud {
  /** Frame visibility; hiding also resets banner/results/feed and calls onHide. */
  showHud(visible: boolean): void;
  /**
   * Party mode: shows the frame with ONLY the kill feed visible (round falls
   * reuse the feed). Call after showHud(true); false restores.
   */
  setFeedOnly(feedOnly: boolean): void;
  banner(text: string, opts?: { ms?: number; tone?: 'neutral' | 'good' | 'bad' }): void;
  killfeed(text: string): void;
  results(payload: BwResults | null, myId: number | null): void;
  dispose(): void;
}

const BANNER_MS = 1600;
const KILLFEED_MS = 6000;
const KILLFEED_MAX = 5;

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`[matchHud] missing #${id}`);
  return node as T;
}

export function createMatchHud(options: MatchHudOptions): MatchHud {
  const hud = el<HTMLDivElement>('bw-hud');
  const killfeedEl = el<HTMLDivElement>('bw-killfeed');
  const bannerEl = el<HTMLDivElement>('bw-banner');
  const resultsEl = el<HTMLDivElement>('bw-results');
  const resultTitle = el<HTMLElement>('bw-result-title');
  const resultSub = el<HTMLElement>('bw-result-sub');
  const resultStats = el<HTMLDivElement>('bw-result-stats');
  const rematchWait = el<HTMLParagraphElement>('bw-rematch-wait');

  let bannerTimer: number | undefined;

  // --- banner / killfeed --------------------------------------------------------

  function banner(text: string, opts?: { ms?: number; tone?: 'neutral' | 'good' | 'bad' }): void {
    bannerEl.textContent = text;
    bannerEl.classList.remove('hidden', 'good', 'bad');
    if (opts?.tone === 'good') bannerEl.classList.add('good');
    if (opts?.tone === 'bad') bannerEl.classList.add('bad');
    void bannerEl.offsetWidth; // restart the pop animation on rapid re-shows
    bannerEl.classList.add('pop');
    if (bannerTimer !== undefined) clearTimeout(bannerTimer);
    bannerTimer = window.setTimeout(() => {
      bannerEl.classList.add('hidden');
      bannerEl.classList.remove('pop');
    }, opts?.ms ?? BANNER_MS);
  }

  function killfeed(text: string): void {
    const line = document.createElement('div');
    line.className = 'kf';
    line.textContent = text;
    killfeedEl.appendChild(line);
    while (killfeedEl.children.length > KILLFEED_MAX) killfeedEl.firstElementChild?.remove();
    window.setTimeout(() => {
      line.classList.add('faded');
      window.setTimeout(() => line.remove(), 600);
    }, KILLFEED_MS);
  }

  // --- results ------------------------------------------------------------------

  el<HTMLButtonElement>('bw-rematch').addEventListener('click', (event) => {
    event.stopPropagation();
    options.onRematch();
    rematchWait.classList.remove('hidden');
  });
  el<HTMLButtonElement>('bw-leave-game').addEventListener('click', (event) => {
    event.stopPropagation();
    options.onLeave();
  });

  function results(payload: BwResults | null, myId: number | null): void {
    rematchWait.classList.add('hidden');
    if (!payload) {
      resultsEl.classList.add('hidden');
      resultStats.replaceChildren();
      return;
    }
    const won = myId !== null && payload.winnerId === myId;
    resultTitle.textContent = won ? 'Victory!' : 'Defeat';
    resultTitle.classList.toggle('good', won);
    resultTitle.classList.toggle('bad', !won);
    resultSub.textContent = `${payload.winnerName} won the match`;
    resultStats.replaceChildren();
    for (const stat of payload.stats) {
      const row = document.createElement('div');
      row.className = 'stat-row';
      const name = document.createElement('span');
      name.textContent = stat.name;
      const line = document.createElement('span');
      // Party stats carry rounds/falls; bedwars keeps the kill/death lines.
      if (stat.rounds !== undefined || stat.falls !== undefined) {
        line.textContent = `${stat.rounds ?? 0} rounds · ${stat.falls ?? 0} falls`;
      } else {
        line.textContent = `${stat.kills} kills · ${stat.deaths} deaths`;
      }
      row.append(name, line);
      resultStats.appendChild(row);
    }
    resultsEl.classList.remove('hidden');
  }

  return {
    showHud(visible) {
      hud.classList.toggle('hidden', !visible);
      if (!visible) {
        bannerEl.classList.add('hidden');
        resultsEl.classList.add('hidden');
        killfeedEl.replaceChildren();
        options.onHide?.();
      }
    },
    setFeedOnly(feedOnly) {
      hud.classList.toggle('party', feedOnly);
    },
    banner,
    killfeed,
    results,
    dispose() {
      if (bannerTimer !== undefined) clearTimeout(bannerTimer);
    },
  };
}
