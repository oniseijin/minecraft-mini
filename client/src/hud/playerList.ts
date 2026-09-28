/**
 * Hold-Tab player list (Minecraft-style peek): the roster with identity
 * colors, bot/you tags and a mode-context column (bedwars team/hp, party
 * rounds/fell). Moved from main.ts (REFACTORING.md 2a.2) — main.ts keeps the
 * Tab keydown side (its keyboard section) and drives the frame-loop tick, so
 * show/hide/tick are exported. The shown/rendered-at state lives in the
 * created closure; live singletons arrive through PlayerListHost getters.
 */

import { type GameMode } from '@mc/shared';
import { type Net } from '../net';
import { type BwState } from '../bwState';
import { type PartyState } from '../partyState';
import { playerColor } from '../identity';

const playerListEl = document.querySelector<HTMLDivElement>('#player-list')!;

/** What main.ts lends the player list (live singletons via getters). */
export interface PlayerListHost {
  get gameMode(): GameMode;
  get net(): Net | null;
  get bwState(): BwState | null;
  get partyState(): PartyState | null;
}

/** The player-list entry points main.ts drives (Tab keydown + frame loop). */
export interface PlayerListUi {
  showPlayerList(): void;
  /** Hold Tab to peek; also the window-blur path. */
  hidePlayerList(): void;
  /** Stays live while shown (scores, hp, AFK) — re-rendered ≥250 ms apart. */
  tickPlayerList(now: number): void;
}

export function createPlayerListUi(host: PlayerListHost): PlayerListUi {
  let tabListShown = false;
  let tabListRenderedAt = 0;

  /** Mode-context column: bedwars team/hp/eliminated, party rounds/fell. */
  function playerListInfo(id: number): string {
    if (host.gameMode === 'bedwars' && host.bwState) {
      const p = host.bwState.player(id);
      if (!p) return '';
      return !p.alive ? 'eliminated' : `${p.team === 0 ? 'red' : 'blue'} · ${p.hp} hp`;
    }
    if (host.gameMode === 'party' && host.partyState) {
      const p = host.partyState.player(id);
      if (!p) return '';
      const rounds = `${p.score} round${p.score === 1 ? '' : 's'}`;
      return p.alive ? rounds : `fell · ${rounds}`;
    }
    return '';
  }

  function renderPlayerList(): void {
    const roster = [...(host.net?.players ?? [])].sort((a, b) => a.id - b.id);
    const myId = host.net?.playerId ?? null;
    playerListEl.replaceChildren();
    const title = document.createElement('h3');
    title.textContent = `Online — ${roster.length}`;
    playerListEl.appendChild(title);
    for (const p of roster) {
      const row = document.createElement('div');
      row.className = 'pl-row';
      const name = document.createElement('span');
      name.className = 'pl-name';
      name.style.color = playerColor(p.id); // same identity color as the nameplate
      name.textContent = p.name;
      const tag = document.createElement('span');
      tag.className = 'pl-tag';
      tag.textContent = p.bot ? ' (Bot)' : p.id === myId ? ' (you)' : '';
      if (tag.textContent) name.appendChild(tag);
      const info = document.createElement('span');
      info.className = 'pl-info';
      info.textContent = playerListInfo(p.id);
      row.append(name, info);
      playerListEl.appendChild(row);
    }
  }

  function showPlayerList(): void {
    tabListShown = true;
    renderPlayerList();
    playerListEl.classList.remove('hidden');
  }

  function hidePlayerList(): void {
    tabListShown = false;
    playerListEl.classList.add('hidden');
  }

  window.addEventListener('keyup', (event) => {
    if (event.code === 'Tab') hidePlayerList(); // hold Tab to peek (Minecraft-style)
  });
  window.addEventListener('blur', hidePlayerList);

  /** Frame-loop hook: keeps the shown list live without re-rendering every frame. */
  function tickPlayerList(now: number): void {
    if (tabListShown && now - tabListRenderedAt > 250) {
      tabListRenderedAt = now;
      renderPlayerList();
    }
  }

  return { showPlayerList, hidePlayerList, tickPlayerList };
}
