/**
 * Murder Mystery gameEvent handlers (M7.3, DESIGN.md §3.6, REFACTORING.md
 * 2a.4 pattern): gravestones, the reveal banner, zapper outcomes, coin
 * pickups, ghost spectating and the results screen. main.ts guards entry
 * (murderState live, event recorded) and dispatches through this table.
 *
 * Kid-legible language throughout: guests "were got", players "fall" —
 * never "eliminated"/"killed you" (§3.6 guardrails).
 */

import type { MurderState } from '../murderState';
import type { MurderHud } from '../murderHud';
import type { MurderFx } from '../murderFx';
import type { Player } from '../player';
import type { GameAudio } from '../audio';
import type { MatchHud } from '../matchHud';
import type { EventTable } from './table';

export interface MurderEventCtx {
  /** The live mirror (dispatch guarantees it non-null + already recorded the event). */
  murderState: MurderState;
  murderHud: MurderHud | null;
  murderFx: MurderFx | null;
  player: Player | null;
  audio: GameAudio;
  matchHud: MatchHud | null;
  showToast(text: string): void;
  /** The guest's RENDERED position (mob renderer lookup) for the beam flash. */
  guestSpot(id: number): { x: number; y: number; z: number } | null;
}

export const murderEvents: EventTable<MurderEventCtx> = {
  guestKilled(msg, ctx) {
    const stone = ctx.murderState.addGravestone(msg.x, msg.y, msg.z, msg.victimId);
    if (stone) ctx.murderFx?.addGravestone(stone.x, stone.y, stone.z);
    const name = ctx.murderState.guest(msg.victimId)?.name ?? 'A guest';
    ctx.matchHud?.killfeed(`${name} was got…`);
    ctx.murderHud?.sync(ctx.murderState); // roster strike-through right away
    ctx.audio.beep(170); // low sting — a body was found
  },

  murdererRevealed(msg, ctx) {
    const guest = ctx.murderState.guest(msg.id);
    const name = guest ? guest.name : 'one of the guests';
    ctx.matchHud?.banner(`The murderer was ${name}!`, { tone: 'bad', ms: 4000 });
    ctx.matchHud?.killfeed(`The murderer was ${name}.`);
  },

  zapped(msg, ctx) {
    const guest = ctx.murderState.guest(msg.targetId);
    const shooter = msg.by === ctx.murderState.myId ? 'You' : 'Your partner';
    const spot = ctx.guestSpot(msg.targetId);
    if (spot) ctx.murderFx?.zapFx(spot);
    ctx.audio.hit();
    if (msg.correct) {
      ctx.matchHud?.banner(`${shooter} zapped the murderer!`, { tone: 'good', ms: 2600 });
    } else if (guest) {
      ctx.matchHud?.killfeed(`${guest.name} was innocent — zapper jammed!`);
    }
  },

  coinPickedUp(msg, ctx) {
    if (msg.playerId !== ctx.murderState.myId) return;
    ctx.showToast(`+${msg.value} coin${msg.value > 1 ? 's' : ''}`);
    ctx.audio.beep(880);
  },

  gravestoneRead(msg, ctx) {
    ctx.matchHud?.killfeed(`${msg.victimName} — ${msg.ageSeconds}s ago`);
  },

  death(msg, ctx) {
    if (msg.playerId !== ctx.murderState.myId) return;
    // I was got: ghost free-fly (§3.6 — ghosts stay in the manor and watch).
    ctx.murderState.alive = false;
    ctx.murderHud?.sync(ctx.murderState);
    ctx.matchHud?.banner('You were got! Fly and watch…', { tone: 'bad', ms: 3000 });
    ctx.audio.lose();
    if (ctx.player) {
      ctx.player.flyAllowed = true; // spectate free-fly (party eliminated rule)
      ctx.player.flying = true;
    }
  },

  matchEnd(msg, ctx) {
    const me = ctx.murderState.myId;
    ctx.murderState.results = { winnerId: msg.winnerId, winnerName: msg.winnerName, stats: msg.stats };
    // Co-op semantics (§3.6): a humans win (a correct zap, timer expiry, win
    // by default) belongs to BOTH detectives — winnerId is one human's id or,
    // on a murderer win, the murderer's GUEST id (never in the human stats).
    const humansWon = msg.stats.some((s) => s.id === msg.winnerId);
    const won = humansWon && me !== null;
    ctx.matchHud?.banner(won ? 'THE MURDERER WAS CAUGHT!' : 'THE MURDERER GOT AWAY…', {
      tone: won ? 'good' : 'bad',
      ms: 2600,
    });
    if (won) ctx.audio.win();
    else ctx.audio.lose();
    if (ctx.player) {
      ctx.player.clearEffects();
      ctx.player.controlsEnabled = false; // park everyone behind the results
      ctx.player.flying = false;
      document.exitPointerLock();
      ctx.player.overlaySuppressed = true; // results screen replaces the pause menu
    }
    ctx.matchHud?.results(ctx.murderState.results, me);
  },
};
