/**
 * Murder Mystery HUD (M7.3): pure DOM, ids live in index.html — party-HUD
 * style. Renders ONLY the state mirror (murderState); main.ts drives events:
 *
 * - Role card (top-center): "Detective — find the murderer!", the round clock
 *   (m:ss, red in the final minute), coins held with progress to the next
 *   zapper charge (7/10), the zapper charges (⚡ ×N) and the JAMMED countdown
 *   after a wrong zap.
 * - The final-minute Detector: a pulsing "The murderer is NEAR" chip while the
 *   server's per-player detector flag is true (§3.6 tell #5).
 * - The guest roster: six color-dot names, struck through once a guest "was
 *   got" (the deduction cast — watching who remains is the game).
 * - A one-line controls hint. Kid-legible language throughout: "was got",
 *   "fell" — never "eliminated" (§3.6 guardrails).
 *
 * The banner / kill feed / results screen are shared matchHud pieces; this
 * module never mutates match state. The jam countdown + round clock tick
 * locally between the 5 Hz snapshots (jam rides the server's absolute
 * jammedUntil; the clock interpolates endsAt = now + timeLeft·1000).
 */

import type { MurderState } from './murderState';
import { COINS_PER_CHARGE, GUEST_CSS } from './murderState';
import { makeEl } from './dom';

export interface MurderHud {
  show(visible: boolean): void;
  /** Full HUD refresh from the state mirror (5 Hz + after events). */
  sync(state: MurderState): void;
  /** Per-frame: jam countdown + interpolated round clock (server-epoch time). */
  tick(): void;
  dispose(): void;
}

const el = makeEl('murderHud');

function fmtClock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function createMurderHud(): MurderHud {
  const hud = el<HTMLDivElement>('murder-hud');
  const roleEl = el<HTMLElement>('murder-role');
  const timerEl = el<HTMLElement>('murder-timer');
  const coinsEl = el<HTMLElement>('murder-coins');
  const chargesEl = el<HTMLElement>('murder-charges');
  const jamEl = el<HTMLDivElement>('murder-jam');
  const detectorEl = el<HTMLDivElement>('murder-detector');
  const rosterEl = el<HTMLDivElement>('murder-roster');
  const hintEl = el<HTMLElement>('murder-hint');

  let state: MurderState | null = null;
  let lastTimerText = '';

  /** Ghosts cannot zap/investigate — hide the actionable counters + hint. */
  function syncGhost(): void {
    const ghost = state !== null && !state.alive;
    roleEl.textContent = ghost ? 'Ghost — fly and watch the match!' : 'Detective — find the murderer!';
    coinsEl.classList.toggle('hidden', ghost);
    chargesEl.classList.toggle('hidden', ghost);
    hintEl.classList.toggle('hidden', ghost);
    if (ghost) jamEl.classList.add('hidden');
  }

  function renderRoster(): void {
    if (!state) return;
    const entries = [...state.guests.values()].sort((a, b) => a.id - b.id);
    const rows: HTMLDivElement[] = [];
    for (const guest of entries) {
      const row = document.createElement('div');
      row.className = 'm-guest';
      if (!guest.alive) row.classList.add('dead');
      const dot = document.createElement('span');
      dot.className = 'm-dot';
      dot.style.backgroundColor = GUEST_CSS[guest.color];
      const name = document.createElement('span');
      name.className = 'm-name';
      name.textContent = guest.name;
      row.append(dot, name);
      rows.push(row);
    }
    rosterEl.replaceChildren(...rows);
  }

  return {
    show(visible) {
      hud.classList.toggle('hidden', !visible);
      if (!visible) {
        state = null;
        lastTimerText = '';
        jamEl.classList.add('hidden');
        detectorEl.classList.add('hidden');
      }
    },
    sync(next) {
      state = next;
      syncGhost();
      renderRoster();
      detectorEl.classList.toggle('hidden', !state.detectorNear);
      chargesEl.textContent = `Zapper ⚡ ×${state.charges}`;
      coinsEl.textContent = `Coins ${state.coins}/${COINS_PER_CHARGE}`;
      // The clock text itself interpolates in tick(); sync only primes it.
      timerEl.classList.remove('hidden');
    },
    tick() {
      if (!state) return;
      // Both deadlines are SERVER-epoch (Date.now()) values; the frame clock
      // passed in is performance.now() — never mix the two domains.
      const nowMs = Date.now();
      // Round clock: interpolated between snapshots from the absolute deadline.
      const remaining = state.endsAt > 0 ? (state.endsAt - nowMs) / 1000 : state.timeLeft;
      const text = fmtClock(remaining);
      if (text !== lastTimerText) {
        lastTimerText = text;
        timerEl.textContent = text;
      }
      timerEl.classList.toggle('urgent', remaining <= 60); // the final minute = hunt
      // JAMMED countdown from the server's absolute jam expiry.
      const jamLeft = Math.ceil((state.jammedUntil - nowMs) / 1000);
      const jammed = state.alive && jamLeft > 0;
      jamEl.classList.toggle('hidden', !jammed);
      if (jammed) jamEl.textContent = `JAMMED ${jamLeft}s`;
    },
    dispose() {
      hud.classList.add('hidden');
    },
  };
}
