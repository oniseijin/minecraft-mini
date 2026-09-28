/**
 * BedWars gameEvent handlers (REFACTORING.md 2a.4, moved verbatim from
 * main.ts's handleGameEvent switch). main.ts guards entry (bwState exists,
 * recorded the event, matchHud/bwUi live) and dispatches through this table;
 * bodies here are pure reactions: HUD banners/killfeed lines, audio cues,
 * local physics nudges, and the BwState mirror writes.
 */

import { SHOP_ITEMS } from '@mc/shared';
import type { BwState } from '../bwState';
import type { Player } from '../player';
import type { GameAudio } from '../audio';
import type { MatchHud } from '../matchHud';
import type { BedwarsUi } from '../bedwarsUi';
import type { EventTable } from './table';

export interface BwEventCtx {
  /** The live mirror (dispatch guarantees it non-null + already recorded the event). */
  bwState: BwState;
  player: Player | null;
  audio: GameAudio;
  matchHud: MatchHud;
  bwUi: BedwarsUi;
  showToast(text: string): void;
}

export const bwEvents: EventTable<BwEventCtx> = {
  countdown(msg, ctx) {
    if (msg.seconds > 0) {
      ctx.matchHud.banner(String(msg.seconds), { ms: 1000 });
      ctx.audio.beep(880);
    } else {
      ctx.matchHud.banner('FIGHT!', { ms: 1200, tone: 'good' });
      ctx.audio.fight();
    }
  },
  bedBroken(msg, ctx) {
    const mine = msg.team === ctx.bwState.myTeam;
    ctx.matchHud.banner(mine ? 'YOUR BED WAS DESTROYED!' : 'ENEMY BED DESTROYED!', { tone: mine ? 'bad' : 'good', ms: 2400 });
    ctx.matchHud.killfeed(`${msg.by} broke the ${msg.team === 0 ? 'RED' : 'BLUE'} bed!`);
    ctx.bwState.bedsAlive[msg.team] = false;
    ctx.audio.bedBreak();
  },
  death(msg, ctx) {
    const victim = ctx.bwState.player(msg.playerId);
    const killer = ctx.bwState.player(msg.killerId);
    const what = msg.cause === 'void' ? 'fell into the void' : 'was slain';
    ctx.matchHud.killfeed(`${killer ? `${killer.name}: ` : ''}${victim?.name ?? 'Someone'} ${what}`);
    if (msg.playerId === ctx.bwState.myId) {
      ctx.audio.deathSound();
      if (ctx.player) ctx.player.controlsEnabled = false; // freeze until respawn
      if (msg.respawnIn > 0) ctx.bwUi.respawn(msg.respawnIn);
    } else if (msg.killerId !== null && msg.killerId === ctx.bwState.myId) {
      ctx.audio.hit();
    }
  },
  respawn(msg, ctx) {
    if (msg.playerId === ctx.bwState.myId) {
      const spawnPoint = ctx.bwState.spawns[ctx.bwState.myTeam];
      if (spawnPoint && ctx.player) {
        ctx.player.teleport(spawnPoint.x, spawnPoint.y, spawnPoint.z);
        ctx.player.controlsEnabled = true;
      }
      ctx.bwUi.respawn(null);
      ctx.audio.beep(660);
    }
  },
  knockback(msg, ctx) {
    if (msg.playerId === ctx.bwState.myId && ctx.player) {
      ctx.player.vel.x += msg.dir.x * msg.power;
      ctx.player.vel.y += msg.dir.y * msg.power;
      ctx.player.vel.z += msg.dir.z * msg.power;
    }
  },
  purchase(msg, ctx) {
    const item = SHOP_ITEMS.find((entry) => entry.id === msg.item);
    if (msg.playerId === ctx.bwState.myId) {
      ctx.audio.purchase();
      ctx.showToast(`Purchased ${item?.name ?? msg.item}`);
    } else {
      const buyer = ctx.bwState.player(msg.playerId);
      ctx.matchHud.killfeed(`${buyer?.name ?? 'Someone'} bought ${item?.name ?? msg.item}`);
    }
  },
  heal(msg, ctx) {
    if (msg.playerId === ctx.bwState.myId) ctx.audio.eat();
  },
  matchEnd(msg, ctx) {
    ctx.bwState.results = { winnerId: msg.winnerId, winnerName: msg.winnerName, stats: msg.stats };
    const won = msg.winnerId === ctx.bwState.myId;
    ctx.matchHud.banner(won ? 'VICTORY!' : 'DEFEAT', { tone: won ? 'good' : 'bad', ms: 2600 });
    if (won) ctx.audio.win();
    else ctx.audio.lose();
    if (ctx.player) {
      ctx.player.controlsEnabled = false; // park both players behind the results
      document.exitPointerLock();
      ctx.player.overlaySuppressed = true; // results screen replaces the pause menu
    }
    ctx.matchHud.results(ctx.bwState.results, ctx.bwState.myId);
  },
};
