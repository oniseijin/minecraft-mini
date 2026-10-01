/**
 * Block Party HUD (M5): pure DOM, ids live in index.html.
 *
 * - Top-center card: round #, big color swatch (the cotton tile tinted via
 *   CSS background-blend multiply — same look as the tinted mesher output),
 *   the color NAME (colorblind-friendly), the live score line and a shrinking
 *   countdown bar.
 * - Intermission shows "Round N starting…"; drop flashes "GO!".
 * - A dedicated HUD slot (bottom-right) mirrors the announced color block.
 * - Round banners / kill feed / results screen are reused from bedwarsUi —
 *   this module only renders the state mirror; main.ts drives events.
 *
 * The countdown bar + accelerating tick sounds run locally between the 5 Hz
 * snapshots, interpolating the server's absolute `roundEndsAt` deadline.
 */

import { PARTY_COLORS, type PartyColor } from '@mc/shared';
import type { PartyState } from './partyState';
import { makeEl } from './dom';

export interface PartyUiOptions {
  /** The neutral cotton tile data URL, tinted by CSS for swatches. */
  tileUrl: string;
  /** Countdown tick (urgency 0..1 rises as the drop approaches). */
  onCountdownTick(urgency: number): void;
}

export interface PartyUi {
  show(visible: boolean): void;
  /** Full HUD refresh from the state mirror (5 Hz + after events). */
  sync(p: PartyState): void;
  /** Per-frame: countdown bar width + local tick sounds (announce only). */
  tick(nowMs: number): void;
  dispose(): void;
}

const el = makeEl('partyUi');

/** tint [0..1]³ → css rgb(). */
export function tintCss(tint: [number, number, number]): string {
  const byte = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)));
  return `rgb(${byte(tint[0])}, ${byte(tint[1])}, ${byte(tint[2])})`;
}

/** Party color metadata for a party wool block id, else null. */
function partyColor(colorId: number): PartyColor | null {
  return PARTY_COLORS.find((color) => color.id === colorId) ?? null;
}

/** Tints an element like the mesher tints the cotton tile (multiply blend). */
function applySwatch(node: HTMLElement, color: PartyColor | null, tileUrl: string): void {
  if (color === null) {
    node.style.backgroundColor = 'rgba(255,255,255,0.15)';
    node.style.backgroundImage = '';
    return;
  }
  node.style.backgroundColor = tintCss(color.tint);
  node.style.backgroundImage = `url("${tileUrl}")`;
  node.style.backgroundBlendMode = 'multiply';
  node.style.backgroundSize = 'cover';
}

/** Seconds between countdown ticks: 0.5 s early, accelerating to 0.2 s. */
function tickInterval(remainingMs: number): number {
  return remainingMs > 1000 ? 500 : 200;
}

export function createPartyUi(options: PartyUiOptions): PartyUi {
  const hud = el<HTMLDivElement>('party-hud');
  const roundEl = el<HTMLElement>('party-round');
  const announceEl = el<HTMLDivElement>('party-announce');
  const swatchEl = el<HTMLDivElement>('party-swatch');
  const colorEl = el<HTMLElement>('party-color');
  const statusEl = el<HTMLElement>('party-status');
  const scoresEl = el<HTMLElement>('party-scores');
  const timerEl = el<HTMLDivElement>('party-timer');
  const timerFill = el<HTMLDivElement>('party-timer-fill');
  const slotBlock = el<HTMLDivElement>('party-slot-block');
  const slotLabel = el<HTMLElement>('party-slot-label');

  let phase: PartyState['phase'] = null;
  let lastTickAt = 0;

  function renderScores(p: PartyState): void {
    const entries = [...p.scores.values()];
    const me = p.me();
    if (me) {
      const foe = entries.find((entry) => entry.playerId !== me.playerId);
      scoresEl.textContent = `You ${me.score} — ${foe ? `${foe.score} ${foe.name}` : '—'}`;
    } else {
      // Spectator view: plain names.
      scoresEl.textContent = entries.map((entry) => `${entry.name} ${entry.score}`).join(' — ');
    }
  }

  return {
    show(visible) {
      hud.classList.toggle('hidden', !visible);
      if (!visible) {
        phase = null;
        timerFill.style.width = '0%';
      }
    },
    sync(p) {
      phase = p.phase;
      const color = partyColor(p.colorId);

      roundEl.textContent = `Round ${p.round}`;
      renderScores(p);

      const showAnnounce = p.phase === 'announce' || p.phase === 'drop' || p.phase === 'scored';
      announceEl.classList.toggle('hidden', !showAnnounce);
      if (showAnnounce && color) {
        applySwatch(swatchEl, color, options.tileUrl);
        applySwatch(slotBlock, color, options.tileUrl);
        colorEl.textContent = p.colorName.toUpperCase();
      }
      if (p.phase === 'announce') {
        statusEl.textContent = `Stand on ${p.colorName}!`;
        slotLabel.textContent = `Stand on ${p.colorName}`;
      } else if (p.phase === 'drop') {
        statusEl.textContent = 'GO! Hold your ground!';
        slotLabel.textContent = p.colorName;
      } else if (p.phase === 'scored') {
        statusEl.textContent = 'Round over';
        slotLabel.textContent = p.colorName;
      } else if (p.phase === 'intermission') {
        statusEl.textContent = `Round ${p.round} starting…`;
        slotLabel.textContent = 'Get ready…';
        applySwatch(slotBlock, null, options.tileUrl);
        timerFill.style.width = '0%';
      }
      timerEl.classList.toggle('hidden', p.phase !== 'announce' && p.phase !== 'drop');
      hud.classList.toggle('spectate', !p.meAlive() && p.phase !== null);
    },
    tick() {
      if (phase !== 'announce') {
        lastTickAt = 0;
        return;
      }
      const remaining = partyDeadlineMs();
      if (remaining === null) return;
      // Bar: remaining fraction of this round's announce duration.
      const total = Math.max(1, totalTimerMs());
      timerFill.style.width = `${Math.max(0, Math.min(100, (remaining / total) * 100))}%`;

      // Accelerating countdown ticks, evaluated locally at frame rate.
      const now = performance.now();
      if (lastTickAt === 0 || now - lastTickAt >= tickInterval(remaining)) {
        if (lastTickAt !== 0) options.onCountdownTick(1 - Math.max(0, remaining) / total);
        lastTickAt = now;
      }
    },
    dispose() {
      hud.classList.add('hidden');
    },
  };
}

/** Module-local deadline bridge — main.ts publishes the active mirror here. */
let activeState: PartyState | null = null;

/** main.ts keeps the live party mirror registered for the per-frame tick. */
export function setPartyTickState(state: PartyState | null): void {
  activeState = state;
}

function partyDeadlineMs(): number | null {
  if (!activeState) return null;
  return activeState.roundEndsAt - Date.now();
}

function totalTimerMs(): number {
  return activeState?.roundTimerMs ?? 4500;
}
