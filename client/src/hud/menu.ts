/**
 * Pause menu + match controls + in-game guide + mode badge + pointer-lock UI:
 * the DOM wiring around the overlay's #menu card (moved from main.ts,
 * REFACTORING.md 2a.2). Owns the #menu / #mode-badge / #help-panel elements —
 * the smoke suites click these exact ids — while main.ts stays the state
 * owner: live singletons arrive through MenuHost getters (same pattern as
 * DevHost in devHooks.ts) and main.ts drives refreshes through the MenuUi
 * return value.
 */

import { type GameMode } from '@mc/shared';
import { type Player } from '../player';
import { type GameAudio } from '../audio';
import { type Net } from '../net';
import { type PartyState } from '../partyState';
import { type ChatUi } from '../chat';

/** Read-only view of main.ts's boot lifecycle (only `state === 'ready'` matters here). */
type BootState = 'connecting' | 'building' | 'ready' | 'switching';

const menuEl = document.querySelector<HTMLDivElement>('#menu')!;
const flyToggle = document.querySelector<HTMLButtonElement>('#fly-toggle')!;
const soundToggle = document.querySelector<HTMLButtonElement>('#sound-toggle')!;
const sensValue = document.querySelector<HTMLSpanElement>('#sens-value')!;
const sensMinus = document.querySelector<HTMLButtonElement>('#sens-minus')!;
const sensPlus = document.querySelector<HTMLButtonElement>('#sens-plus')!;
const bwStart = document.querySelector<HTMLButtonElement>('#bw-start')!;
const partyStart = document.querySelector<HTMLButtonElement>('#party-start')!;
const bwLeave = document.querySelector<HTMLButtonElement>('#bw-leave')!;
const botAdd = document.querySelector<HTMLButtonElement>('#bot-add')!;
const botRemove = document.querySelector<HTMLButtonElement>('#bot-remove')!;
const matchHint = document.querySelector<HTMLParagraphElement>('#match-hint')!;
const modeBadge = document.querySelector<HTMLDivElement>('#mode-badge')!;
const helpPanel = document.querySelector<HTMLDivElement>('#help-panel')!;
const helpBtn = document.querySelector<HTMLButtonElement>('#help-btn')!;
const helpClose = document.querySelector<HTMLButtonElement>('#help-close')!;
// Shared with main.ts, which creates the hotbar/chat from the same nodes.
const hotbarEl = document.querySelector<HTMLDivElement>('#hotbar')!;
const chatInput = document.querySelector<HTMLInputElement>('#chat-input')!;

/**
 * What main.ts lends the menu wiring. Live singletons come through getters
 * (main.ts owns the `let` state — the pointer lock can change and matches can
 * swap modes at any moment); `audio` is a boot-time const and passes directly.
 */
export interface MenuHost {
  get player(): Player | null;
  readonly audio: GameAudio;
  get gameMode(): GameMode;
  get partyState(): PartyState | null;
  get net(): Net | null;
  get state(): BootState;
  get chat(): ChatUi | null;
  showToast(text: string): void;
}

/** The menu/HUD entry points main.ts still drives (mode changes, lock state). */
export interface MenuUi {
  /** Mirrors player/audio state into the pause-menu labels. */
  refreshMenu(): void;
  /**
   * Every match-control button + the hint line — not just BedWars (renamed
   * from the lie `refreshBwButtons`). Call on roster/connect/mode changes.
   */
  refreshMatchControls(): void;
  /** Persistent "where am I" HUD badge — call on every mode change. */
  refreshModeBadge(): void;
  /** Pointer-lock UI state: hotbar clickability, focus, menu refreshes. */
  syncPointerUi(): void;
  /** True when creative fly may be toggled in the current mode: always in the
   * sandbox; in party only while eliminated (free-fly spectating). */
  flyAllowedNow(): boolean;
  /** `[`/`]` keys + the menu buttons: ±10% mouse sensitivity. */
  changeSensitivity(mult: number): void;
  /** Menu-button paths — also wired into the `__mc` DevHost surface. */
  startBedwars(): void;
  startParty(): void;
  leaveGame(): void;
}

export function createMenuUi(host: MenuHost): MenuUi {
  // The boot-time audio singleton (main.ts never reassigns it).
  const audio = host.audio;

  // --- pause menu ---------------------------------------------------------------

  /** Mirrors player/audio state into the pause-menu labels. */
  function refreshMenu(): void {
    const player = host.player;
    if (!player) return;
    flyToggle.textContent = `Flying: ${player.flying ? 'ON' : 'OFF'}`;
    flyToggle.classList.toggle('on', player.flying);
    soundToggle.textContent = `Sound: ${audio.muted ? 'OFF' : 'ON'}`;
    soundToggle.classList.toggle('on', !audio.muted);
    sensValue.textContent = player.sensitivity.toFixed(4);
  }

  function changeSensitivity(mult: number): void {
    const value = host.player?.adjustSensitivity(mult);
    if (value === undefined) return;
    host.showToast(`Mouse sensitivity: ${value.toFixed(4)}`);
    refreshMenu();
  }

  /** True when creative fly may be toggled in the current mode: always in the
   * sandbox; in party only while eliminated (free-fly spectating). */
  function flyAllowedNow(): boolean {
    if (host.gameMode === 'sandbox') return true;
    if (host.gameMode === 'party') return host.partyState !== null && !host.partyState.meAlive();
    return false; // bedwars
  }

  // Clicks inside the menu must never resume the game (only the card area does);
  // the individual actions below handle their own events.
  menuEl.addEventListener('click', (event) => event.stopPropagation());
  flyToggle.addEventListener('click', () => {
    const player = host.player;
    if (!player) return;
    if (!flyAllowedNow()) {
      host.showToast(
        host.gameMode === 'party'
          ? 'Flying unlocks when you are eliminated (spectate)'
          : 'Flying is disabled in BedWars',
      );
      return;
    }
    player.flying = !player.flying; // session-only: never persisted
    refreshMenu();
  });
  soundToggle.addEventListener('click', () => {
    audio.toggleMute();
    refreshMenu();
  });
  sensMinus.addEventListener('click', () => changeSensitivity(1 / 1.1));
  sensPlus.addEventListener('click', () => changeSensitivity(1.1));

  // --- match menu buttons -------------------------------------------------------

  /** True when the server-driven test bot is in the roster (flagged or "Bot "-prefixed). */
  function botOnline(): boolean {
    return (host.net?.players ?? []).some((p) => p.bot === true || p.name.startsWith('Bot '));
  }

  function humansOnline(): number {
    return (host.net?.players ?? []).filter((p) => p.bot !== true && !p.name.startsWith('Bot ')).length;
  }

  /**
   * Every match-control button + the hint line — not just BedWars (the old
   * `refreshBwButtons` name was a lie). The hint encodes the practice-vs-real
   * distinction (1 human = practice; +bot or a second human = real 1v1).
   */
  function refreshMatchControls(): void {
    const online = host.net?.connected === true;
    const count = host.net?.players.length ?? 0;
    const humans = humansOnline();
    const bot = botOnline();
    const idle = host.gameMode === 'sandbox';
    bwStart.disabled = !online || !idle;
    partyStart.disabled = !online || !idle;
    const soloTitle = bot
      ? 'Start a real 1v1 against the test bot'
      : 'Solo practice (a test bot or a second player makes it a real match)';
    bwStart.title = !online ? 'Offline — connect to a server to play matches' : count < 2 ? soloTitle : 'Start a BedWars 1v1 match';
    partyStart.title = !online ? 'Offline — connect to a server to play matches' : count < 2 ? soloTitle : 'Start a Block Party 1v1 match';
    matchHint.textContent = !online
      ? 'Offline — start the server for multiplayer'
      : humans < 2 && bot
        ? 'Real 1v1 vs bot — go!'
        : humans < 2
          ? 'Solo practice — add a test bot (or open a second tab) for a real 1v1'
          : `Real 1v1 — ready! (${count} players online)`;
    bwLeave.classList.toggle('hidden', host.gameMode === 'sandbox');
    botAdd.classList.toggle('hidden', !online || bot);
    botAdd.disabled = !online || bot;
    botRemove.classList.toggle('hidden', !online || !bot);
    botRemove.disabled = !online || !bot;
  }

  function startBedwars(): void {
    if (host.gameMode !== 'sandbox') return;
    // The server rejects (toast-able error event) unless exactly 2 are online.
    host.net?.sendStartGame('bedwars');
  }

  function startParty(): void {
    if (host.gameMode !== 'sandbox') return;
    host.net?.sendStartGame('party');
  }

  function leaveGame(): void {
    host.net?.sendLeaveGame(); // server swaps everyone back with modeChanged sandbox
  }

  bwStart.addEventListener('click', (event) => {
    event.stopPropagation();
    startBedwars();
  });
  partyStart.addEventListener('click', (event) => {
    event.stopPropagation();
    startParty();
  });
  bwLeave.addEventListener('click', (event) => {
    event.stopPropagation();
    leaveGame();
  });
  botAdd.addEventListener('click', (event) => {
    event.stopPropagation();
    host.net?.sendAddBot(); // server spawns "Bot Steve" and broadcasts the roster
  });
  botRemove.addEventListener('click', (event) => {
    event.stopPropagation();
    host.net?.sendRemoveBot(); // mid-match this counts as the bot disconnecting
  });

  // --- in-game player guide -----------------------------------------------------

  helpBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    helpPanel.classList.remove('hidden');
  });
  helpClose.addEventListener('click', (event) => {
    event.stopPropagation();
    helpPanel.classList.add('hidden');
  });
  helpPanel.addEventListener('click', (event) => {
    if (event.target === helpPanel) helpPanel.classList.add('hidden'); // click-outside closes
  });
  window.addEventListener('keydown', (event) => {
    if (event.code === 'Escape' && !helpPanel.classList.contains('hidden')) {
      helpPanel.classList.add('hidden'); // Esc closes the guide (menu stays)
    }
  });

  // --- mode badge + pointer-lock UI ----------------------------------------------

  /** Persistent "where am I" HUD badge — updated on every mode change. */
  function refreshModeBadge(): void {
    modeBadge.textContent =
      host.gameMode === 'bedwars' ? 'BedWars 1v1' : host.gameMode === 'party' ? 'Block Party 1v1' : 'Sandbox';
    modeBadge.classList.toggle('match', host.gameMode !== 'sandbox');
    modeBadge.classList.remove('hidden');
  }

  /** Hotbar slots are clickable whenever the pointer is free (title/pause). */
  function syncPointerUi(): void {
    // Read the real lock state from the DOM: this can run before player's own
    // pointerlockchange handler refreshes player.isLocked.
    const locked = document.pointerLockElement !== null;
    hotbarEl.classList.toggle('clickable', host.state === 'ready' && !locked);
    if (!locked) {
      refreshMenu();
      refreshMatchControls();
    }
    if (locked) {
      // Drop DOM focus (menu buttons/name input) so stray Enter/keys while
      // playing can't re-trigger them.
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== document.body) active.blur();
    } else if (host.chat?.isOpen) {
      // Focus arrived while the lock was still engaged and was dropped on
      // unlock — (re)focus the chat input now that the lock is really gone.
      chatInput.focus();
    }
  }
  document.addEventListener('pointerlockchange', syncPointerUi);

  return {
    refreshMenu,
    refreshMatchControls,
    refreshModeBadge,
    syncPointerUi,
    flyAllowedNow,
    changeSensitivity,
    startBedwars,
    startParty,
    leaveGame,
  };
}
