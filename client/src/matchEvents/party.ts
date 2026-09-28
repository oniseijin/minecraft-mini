/**
 * Block Party gameEvent handlers (REFACTORING.md 2a.4, moved verbatim from
 * main.ts's handlePartyEvent switch): round events, re-centering, spectate
 * fly, sounds, banners, results. main.ts guards entry (partyState/partyUi
 * live, event recorded) and dispatches through this table.
 */

import { PARTY } from '@mc/shared';
import type { PartyState } from '../partyState';
import { PARTY_ITEMS } from '../partyPowerups';
import type { Player } from '../player';
import type { GameAudio } from '../audio';
import type { MatchHud } from '../matchHud';
import type { BombFx } from '../bombFx';
import type { PartyPowerups } from '../partyPowerups';
import type { EventTable } from './table';

export interface PartyEventCtx {
  /** The live mirror (dispatch guarantees it non-null + already recorded the event). */
  partyState: PartyState;
  player: Player | null;
  audio: GameAudio;
  matchHud: MatchHud | null;
  bombFx: BombFx | null;
  powerups: PartyPowerups | null;
  showToast(text: string): void;
  partyTint(colorId: number): [number, number, number];
  partySpawnPoint(): { x: number; y: number; z: number };
  resetZapper(): void;
  syncPowerups(): void;
  /** The faller's zapper arms (armed=true, used=false). */
  armZapper(): void;
  /** The one shot is spent — the server rejects any second. */
  markZapperUsed(): void;
}

export const partyEvents: EventTable<PartyEventCtx> = {
  roundStart(msg, ctx) {
    // Both fighters reset: alive, grounded, re-centered (server teleports
    // its own roster copy; movement is client-authoritative).
    if (ctx.player && ctx.partyState.myTeam >= 0) {
      const spawnPoint = ctx.partySpawnPoint();
      ctx.player.teleport(spawnPoint.x, spawnPoint.y, spawnPoint.z);
      ctx.player.setSpawn(spawnPoint);
      ctx.player.flyAllowed = false;
      ctx.player.flying = false;
      ctx.player.controlsEnabled = true;
    }
    ctx.resetZapper(); // a fresh round re-arms nothing — falling re-arms it
    ctx.matchHud?.banner(`Round ${msg.round}`, { ms: 1300 });
    ctx.matchHud?.killfeed(`Round ${msg.round} — first to 3 wins the match`);
    ctx.audio.beep(660);
  },
  drop(_msg, ctx) {
    ctx.audio.whoosh();
    ctx.syncPowerups(); // unclaimed boxes vanish at the drop
  },
  bombSpawned(_msg, ctx) {
    // The fused bomb's mesh is driven by the gameState mirror (syncBombFx);
    // the event only announces it and confirms the timing to both players.
    ctx.matchHud?.killfeed('✦ A color bomb appeared — its patch will turn safe!');
    ctx.audio.beep(240);
  },
  bombDetonated(msg, ctx) {
    ctx.bombFx?.detonate(msg.cell, ctx.partyTint(msg.colorId)); // instant visual pop
    ctx.audio.boom();
  },
  boxSpawned(_msg, ctx) {
    // Box meshes follow the gameState mirror (syncPowerups); the event
    // announces it for the kill feed + a little chime.
    ctx.matchHud?.killfeed('✦ A mystery box appeared!');
    ctx.audio.beep(392);
  },
  boxPickedUp(msg, ctx) {
    const meta = PARTY_ITEMS[msg.item];
    if (msg.playerId === ctx.partyState.myId) {
      ctx.showToast(`✦ Got ${meta.name}!`);
      ctx.audio.pickup();
    } else {
      const who = ctx.partyState.player(msg.playerId);
      ctx.matchHud?.killfeed(`${who?.name ?? 'Someone'} got ${meta.name}`);
    }
  },
  itemUsed(msg, ctx) {
    const meta = PARTY_ITEMS[msg.item];
    const who = ctx.partyState.player(msg.playerId);
    ctx.matchHud?.killfeed(`${msg.playerId === ctx.partyState.myId ? 'You' : who?.name ?? 'Someone'} used ${meta.name}!`);
    if (msg.playerId === ctx.partyState.myId) ctx.audio.itemUse();
  },
  leap(msg, ctx) {
    // Same client math as the knockback event — dir IS the velocity delta.
    if (msg.playerId === ctx.partyState.myId && ctx.player) {
      ctx.player.vel.x += msg.dir.x;
      ctx.player.vel.y += msg.dir.y;
      ctx.player.vel.z += msg.dir.z;
      ctx.audio.itemUse();
    }
  },
  teleported(msg, ctx) {
    // The server moved me (Color Teleporter): re-anchor my physics body.
    if (msg.playerId === ctx.partyState.myId && ctx.player) {
      ctx.player.teleport(msg.x, msg.y, msg.z);
      ctx.audio.beep(760);
    }
  },
  swapped(msg, ctx) {
    const whoA = ctx.partyState.player(msg.aId)?.name ?? 'Someone';
    const whoB = ctx.partyState.player(msg.bId)?.name ?? 'Someone';
    ctx.matchHud?.killfeed(`${whoA} and ${whoB} swapped places!`);
    if (ctx.player && (msg.aId === ctx.partyState.myId || msg.bId === ctx.partyState.myId)) {
      const mine = msg.aId === ctx.partyState.myId ? msg.a : msg.b;
      ctx.player.teleport(mine.x, mine.y, mine.z);
      ctx.showToast('Swapped!');
      ctx.audio.itemUse();
    }
  },
  cellZapped(msg, ctx) {
    const by = ctx.partyState.player(msg.by);
    ctx.matchHud?.killfeed(`⚡ ${by?.name ?? 'Someone'} zapped a floor tile!`);
    ctx.powerups?.zapFx(msg.cell); // beam flash; the burst sells the crumble
    ctx.bombFx?.detonate(msg.cell, [1, 1, 1]);
    ctx.audio.zap();
    if (msg.by === ctx.partyState.myId) {
      ctx.markZapperUsed(); // one per fall — the server rejects any second
      ctx.syncPowerups();
    }
  },
  death(msg, ctx) {
    const victim = ctx.partyState.player(msg.playerId);
    ctx.matchHud?.killfeed(`${victim?.name ?? 'Someone'} fell into the void!`);
    if (msg.playerId === ctx.partyState.myId && ctx.player) {
      ctx.audio.deathSound();
      // Spectate for the rest of the round: free-fly from the platform.
      const point = { ...PARTY.spectatorSpawn };
      ctx.player.teleport(point.x, point.y, point.z);
      ctx.player.setSpawn(point);
      ctx.player.flyAllowed = true;
      ctx.player.flying = true;
      // The fallen player earns their one Color Zapper shot (until scored).
      ctx.armZapper();
      ctx.syncPowerups();
      ctx.showToast('You fell! Zapper ready — click a floor tile');
    }
  },
  roundResult(msg, ctx) {
    const me = ctx.partyState.myId;
    const fellMine = msg.fallers.includes(me ?? -1);
    if (msg.draw) {
      ctx.matchHud?.banner('Draw — replay!', { tone: 'neutral', ms: 2000 });
      ctx.audio.beep(440);
    } else if (msg.survivorId === me) {
      ctx.matchHud?.banner('You won the round!', { tone: 'good', ms: 2000 });
      ctx.audio.roundWin();
    } else {
      ctx.matchHud?.banner(fellMine ? 'You fell!' : 'Round lost', { tone: 'bad', ms: 2000 });
    }
  },
  matchEnd(msg, ctx) {
    const me = ctx.partyState.myId;
    ctx.partyState.results = { winnerId: msg.winnerId, winnerName: msg.winnerName, stats: msg.stats };
    const won = msg.winnerId === me;
    ctx.matchHud?.banner(won ? 'VICTORY!' : 'DEFEAT', { tone: won ? 'good' : 'bad', ms: 2600 });
    if (won) ctx.audio.win();
    else ctx.audio.lose();
    ctx.resetZapper();
    ctx.powerups?.reset(); // held items are cleared at match end — hide the slots
    if (ctx.player) {
      ctx.player.clearEffects(); // speed/jump never outlive the match
      ctx.player.controlsEnabled = false; // park both players behind the results
      ctx.player.flying = false;
      document.exitPointerLock();
      ctx.player.overlaySuppressed = true; // results screen replaces the pause menu
    }
    ctx.matchHud?.results(ctx.partyState.results, me);
  },
};
