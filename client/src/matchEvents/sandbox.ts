/**
 * Sandbox event + mob-message handlers (REFACTORING.md 2a.4, moved verbatim
 * from main.ts): the zombie shove (`shoved` — pure knockback, no damage, the
 * sandbox stays deathless §3.5) and the mobs/mobDied message arms. Matches
 * never receive these (server mob logic pauses during matches).
 */

import type { ServerMessage } from '@mc/shared';
import type { Player } from '../player';
import type { Net } from '../net';
import type { GameAudio } from '../audio';
import type { MobRenderer } from '../mobs';
import type { DayNight } from '../daynight';
import type { EventTable } from './table';

/** One zombie shove, for the __mc.shoves test surface. */
export interface ShoveRecord {
  by: number;
  power: number;
  at: number;
}

/** One mob death, for the __mc.mobDieds test surface. */
export interface MobDiedRecord {
  id: number;
  kind: string;
  at: [number, number, number];
}

export interface SandboxEventCtx {
  player: Player | null;
  net: Net | null;
  audio: GameAudio;
  mobRenderer: MobRenderer | null;
  dayNight: DayNight;
  /** Shared ring buffers exposed through __mc (bounded at 20). */
  shoves: ShoveRecord[];
  mobDieds: MobDiedRecord[];
}

export const sandboxEvents: EventTable<SandboxEventCtx> = {
  shoved(msg, ctx) {
    // Sandbox zombie contact shove: pure knockback, no damage (§3.5 — the
    // sandbox stays deathless). Red flash + thud sells the scare.
    if (msg.playerId === ctx.net?.playerId && ctx.player) {
      ctx.player.vel.x += msg.dir.x * msg.power;
      ctx.player.vel.y += msg.dir.y * msg.power;
      ctx.player.vel.z += msg.dir.z * msg.power;
      const vignette = document.querySelector('#bw-vignette');
      if (vignette instanceof HTMLElement) {
        vignette.classList.add('show');
        window.setTimeout(() => vignette.classList.remove('show'), 220);
      }
    }
    ctx.audio.zombieShove();
    ctx.shoves.push({ by: msg.mobId, power: msg.power, at: Date.now() });
    if (ctx.shoves.length > 20) ctx.shoves.shift();
  },
};

/** `mobs` snapshot message: renderer swap + the shared sky/zombie clock. */
export function onMobsSnapshot(msg: Extract<ServerMessage, { type: 'mobs' }>, ctx: SandboxEventCtx): void {
  ctx.mobRenderer?.applySnapshot(msg.mobs);
  if (msg.dayT !== undefined) ctx.dayNight.setPhase(msg.dayT);
}

/** `mobDied` message: poof at the reported death spot (+ dawn burn whoosh). */
export function onMobDied(msg: Extract<ServerMessage, { type: 'mobDied' }>, ctx: SandboxEventCtx): void {
  ctx.mobRenderer?.kill(msg.id, msg.at);
  ctx.mobDieds.push({ id: msg.id, kind: msg.kind, at: msg.at });
  if (ctx.mobDieds.length > 20) ctx.mobDieds.shift();
  ctx.audio.mobPoof();
  if (msg.kind === 'zombie') ctx.audio.whoosh(); // dawn burn-away
}
