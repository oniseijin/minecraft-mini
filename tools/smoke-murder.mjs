// Murder Mystery smoke (M7.4 gate, DESIGN.md §3.6): the full whodunit driven
// solo through the real client paths. Builds the client to the THROWAWAY
// dist-test (never the live client/dist), then boots its own game server on
// :8095 (never :6881 prod, never :5173) FOUR times so the deterministic
// forcing envs (read once per server process) stay honest per scenario:
//
//   BOOT 1  MM_MURDERER_GUEST=1, MM_COIN_TIER=gold
//           1. solo hunt basics: menu button → mode swap, 6 named guests +
//              6 guest avatars, Detective HUD + counting clock, floor coins
//           2. coins earn charges: teleport onto coins until 10 → charge #2
//           3. correct zap wins: zapGuest(1001) → zapped{correct} + reveal
//              + matchEnd + results naming the detective
//          10. Rematch (real results-screen button) → fresh mingle state
//           4. wrong-zap guardrails: zapGuest(1002) → jam 10 s, charge lost,
//              the guest is proven innocent and stays alive
//          10. Leave-match → sandbox with wildlife back
//   BOOT 2  MM_MURDERER_GUEST=1, MM_ESCALATE_AT_MS=4000
//           5. ghost on death: the hunt reaches the idle detective, 2 melee
//              hits → death event, alive=false, fly unlocked, murderer wins
//           6. Detector pulse (hunt phase): near the murderer → detectorNear,
//              far corner → quiet (the detective teleports away BEFORE the
//              second melee swing — the near window is deliberately brief)
//   BOOT 3  MM_MURDERER_GUEST=1 (default 90 s mingle)
//           7. gravestone read: patient poll (≤75 s) for a mingle strike —
//              kills need a fully isolated victim (≥12 from every human,
//              ≥8 from every other guest), so the first decision (8–15 s in)
//              plus the strike walk is the honest floor; then stand on the
//              stone + sendInvestigate → victimName + ageSeconds
//           9. the test bot joins via the REAL menu button as a fellow
//              Detective: spawns in the manor, wanders (≥2 blocks within
//              30 s — only the wander window right after start is asserted;
//              the murderer may got it later in long matches, that's engine
//              behavior), and never appears in any zapped event
//   BOOT 4  MM_MURDERER_GUEST=1, MM_ROUND_MS=8000
//           8. timer expiry = the Detectives win (the murderer ran out of
//              time) + murdererRevealed
//
// Matches after a server RESTART start via __mc.startMurder() (the
// smoke-powerups restart pattern — the page just reconnected and the menu
// overlay state is not guaranteed); boot 1 + the bot boot click the REAL
// menu buttons, as does the results-screen Rematch.
//
// Usage: PORT=8095 node tools/smoke-murder.mjs   (SKIP_BUILD=1 reuses the build)
import {
  MOVE_RELAY_MS,
  buildClient,
  createChecks,
  ensurePortFree,
  launch,
  openPage,
  sleep,
  smokeOut,
  startServer,
  stopServer,
  teardown,
  waitFor,
  watchErrors,
} from './lib.mjs';

const PORT = Number(process.env.PORT ?? 8095);
const BASE = `http://localhost:${PORT}`;
const EDITS_FILE = smokeOut('smoke-murder-edits.json');
// Forced murderer = guest slot 1 → mob id 1000 + slot (GUEST_ID_BASE 1001).
const KILLER_ID = 1001;
const INNOCENT_ID = 1002;
const MANOR = { minX: 8, maxX: 55, minZ: 8, maxZ: 55, floorY: 30 }; // shared/src/manor.ts

const { check, finish } = createChecks();

let browser = null;
let server = null;
let page = null;
const errors = [];

async function waitOnline(label) {
  await page.waitForFunction(
    () => window.__mc !== undefined && window.__mc.net.mode === 'online',
    null,
    { timeout: 60_000 },
  );
  console.log(`  [net] ${label} online`);
}

/** Stops the current server and boots a fresh one with `extraEnv` (the page
 * reconnects — envs are read once per server process, so per-scenario forcing
 * needs a fresh boot; smoke-powerups' multi-boot pattern). */
async function restartServer(extraEnv) {
  if (server) await stopServer(server);
  server = await startServer({ port: PORT, editsFile: EDITS_FILE, extraEnv, resetEdits: false });
  await waitOnline('solo');
}

/** Waits for the murder mode swap + the manor to finish meshing. */
async function awaitManor(label) {
  await waitFor(page, () => window.__mc.mode === 'murder' && window.__mc.murder !== null, 15_000, `${label} modeChanged(murder)`);
  await waitFor(page, () => window.__mc.worldRenderer.pendingCount === 0, 60_000, `${label} manor built`);
  await sleep(700); // the post-build spawn drop settles before any teleport
}

/** Starts a murder match after a server restart (hook — see header note). */
async function startMurderAfterRestart(label) {
  await page.evaluate(() => window.__mc.startMurder());
  await awaitManor(label);
}

/** A standable manor-floor spot `dist` from (x, z), trying axis offsets first.
 * Teleports the player there (feet on the floor slab) and returns the spot. */
async function teleportNear(x, z, dist) {
  const spot = await page.evaluate(({ x, z, dist, manor }) => {
    const mc = window.__mc;
    const cands = [[dist, 0], [-dist, 0], [0, dist], [0, -dist], [dist * 0.71, dist * 0.71], [-dist * 0.71, -dist * 0.71]];
    for (const [dx, dz] of cands) {
      const cx = Math.max(manor.minX + 2.5, Math.min(manor.maxX - 2.5, x + dx));
      const cz = Math.max(manor.minZ + 2.5, Math.min(manor.maxZ - 2.5, z + dz));
      if (mc.world.highestBlock(Math.floor(cx), Math.floor(cz)) !== manor.floorY) continue; // a wall column
      mc.player.teleport(cx, manor.floorY + 1, cz);
      mc.player.vel.set(0, 0, 0);
      return { x: cx, z: cz };
    }
    return null;
  }, { x, z, dist, manor: MANOR });
  await sleep(MOVE_RELAY_MS); // the server's range/proximity checks read the relayed spot
  return spot;
}

try {
  // 0. build + boot 1 (MM_MURDERER_GUEST=1, MM_COIN_TIER=gold) ------------------
  buildClient();
  await ensurePortFree(BASE, PORT, ' (or pass PORT=…)');
  console.log('[boot 1] MM_MURDERER_GUEST=1 MM_COIN_TIER=gold — basics, coins, correct zap, rematch, guardrails');
  server = await startServer({ port: PORT, editsFile: EDITS_FILE, extraEnv: { MM_MURDERER_GUEST: '1', MM_COIN_TIER: 'gold' } });
  ({ browser, page } = await openPage({ base: BASE, errors }));
  const myId = await page.evaluate(() => window.__mc.net.id);
  const myName = await page.evaluate(() => window.__mc.net.players.find((p) => p.id === window.__mc.net.id)?.name ?? null);

  // ======================================================================
  // SCENARIO 1 — solo hunt basics (the REAL menu button)
  // ======================================================================
  console.log('  [1] solo hunt basics');
  await page.locator('#murder-start').click();
  await awaitManor('hunt');
  const modeInfo = await page.evaluate(() => ({
    mode: window.__mc.mode,
    badge: document.getElementById('mode-badge').textContent,
  }));
  check('menu button swaps the game into Murder Mystery', modeInfo.mode === 'murder' && modeInfo.badge === 'Murder Mystery', JSON.stringify(modeInfo));

  const cast = await page.evaluate(() => {
    const m = window.__mc.murder;
    return {
      guests: [...m.guests.values()].map((g) => ({ id: g.id, name: g.name, alive: g.alive })),
      rosterRows: document.querySelectorAll('#murder-roster .m-guest').length,
    };
  });
  check(
    '__mc.murder lists 6 alive color-named guests (HUD roster too)',
    cast.guests.length === 6
      && cast.guests.every((g) => g.alive && /^\w+ Guest$/.test(g.name))
      && cast.rosterRows === 6,
    `${cast.guests.map((g) => g.name).join(', ')} · roster rows=${cast.rosterRows}`,
  );

  const avatarIds = await page.evaluate(() =>
    [...window.__mc.mobs.values()].filter((m) => m.kind === 'guest').map((m) => m.id).sort((a, b) => a - b),
  );
  check(
    '6 guest avatars render from the mobs stream (ids 1001–1006)',
    avatarIds.length === 6 && avatarIds[0] === 1001 && avatarIds[5] === 1006,
    `ids=${avatarIds.join(',')}`,
  );

  const hud = await page.evaluate(() => ({
    shown: !document.getElementById('murder-hud').classList.contains('hidden'),
    role: document.getElementById('murder-role').textContent,
    timer: document.getElementById('murder-timer').textContent,
  }));
  await sleep(2200);
  const timerLater = await page.evaluate(() => document.getElementById('murder-timer').textContent);
  check(
    'Detective HUD visible: role card + a clock that counts down',
    hud.shown && /Detective — find the murderer!/.test(hud.role) && /^\d+:\d\d$/.test(hud.timer) && timerLater !== hud.timer,
    `role="${hud.role}" ${hud.timer} → ${timerLater}`,
  );

  const coinsShown = await waitFor(page, () => (window.__mc.murder?.coinItems.size ?? 0) >= 2, 16_000, 'floor coins appear').catch(() => false);
  const coinCount = await page.evaluate(() => window.__mc.murder.coinItems.size);
  check('coins appear on the manor floor (~1 per 4 s)', coinsShown && coinCount >= 2, `coinItems=${coinCount}`);

  // ======================================================================
  // SCENARIO 2 — coins earn charges (teleport onto exact coin spots)
  // ======================================================================
  console.log('  [2] coins earn charges (gold = 1 each)');
  const coinDeadline = Date.now() + 75_000;
  let pickups = 0;
  let coins = 0;
  while (Date.now() < coinDeadline) {
    coins = await page.evaluate(() => window.__mc.murder?.coins ?? 0);
    if (coins >= 10) break;
    // The nearest coin that is NOT within 4 of the wandering murderer — the
    // pickup loop must never stroll into the melee.
    const spot = await page.evaluate((killerId) => {
      const mc = window.__mc;
      const m = mc.murder;
      if (!m || m.coinItems.size === 0) return null;
      const killer = mc.mobs.get(killerId);
      const kx = killer ? killer.position.x : -1e9;
      const kz = killer ? killer.position.z : -1e9;
      let best = null;
      let bestD = Infinity;
      for (const c of m.coinItems.values()) {
        if (Math.hypot(c.x - kx, c.z - kz) < 4) continue;
        const d = Math.hypot(c.x - mc.player.pos.x, c.z - mc.player.pos.z);
        if (d < bestD) {
          bestD = d;
          best = { x: c.x, y: c.y, z: c.z };
        }
      }
      return best;
    }, KILLER_ID);
    if (!spot) {
      await sleep(500); // floor is empty — the next coin spawns within 4 s
      continue;
    }
    await page.evaluate((c) => {
      window.__mc.player.teleport(c.x, c.y, c.z); // pickup radius is 0.8 — exact spot
      window.__mc.player.vel.set(0, 0, 0);
    }, spot);
    pickups++;
    await sleep(600);
  }
  const wallet = await page.evaluate(() => ({ coins: window.__mc.murder.coins, charges: window.__mc.murder.charges }));
  check('walking onto coins collects them (10+ gold picked up)', wallet.coins >= 10, `coins=${wallet.coins} after ${pickups} teleport-pickups`);
  check('10 coins earned the 2nd zapper charge (start 1, +1 per 10)', wallet.charges === 2, `charges=${wallet.charges}`);

  // ======================================================================
  // SCENARIO 3 — the correct zap wins
  // ======================================================================
  console.log('  [3] correct zap wins');
  const killerAvatar = await page.evaluate((killerId) => {
    const killer = window.__mc.mobs.get(killerId);
    return killer ? { x: killer.position.x, z: killer.position.z } : null;
  }, KILLER_ID);
  if (!killerAvatar) throw new Error('the murderer avatar is not rendered');
  const zapSpot = await teleportNear(killerAvatar.x, killerAvatar.z, 4.5); // outside the 1.8 melee, inside the 20 zap
  if (!zapSpot) throw new Error('no standable zap spot near the murderer');
  await page.evaluate((id) => window.__mc.sendZapGuest(id), KILLER_ID);
  await waitFor(page, () => window.__mc.murder?.events.some((e) => e.kind === 'matchEnd') === true, 6_000, 'matchEnd after the correct zap');
  // The phase itself rides the next 5 Hz snapshot — poll it, don't read once.
  await waitFor(page, () => window.__mc.murder?.phase === 'ended', 4_000, 'phase ended after the zap');
  const zapEnd = await page.evaluate((id) => {
    const m = window.__mc.murder;
    const zap = m.events.find((e) => e.kind === 'zapped');
    return {
      zapCorrect: zap ? zap.data.correct : null,
      zapTarget: zap ? zap.data.targetId : null,
      revealed: m.events.some((e) => e.kind === 'murdererRevealed' && e.data.id === id),
      phase: m.phase,
      results: m.results,
      screenShown: !document.getElementById('bw-results').classList.contains('hidden'),
    };
  }, KILLER_ID);
  check(
    'zapping the murderer: zapped{correct:true} + murdererRevealed + matchEnd',
    zapEnd.zapCorrect === true && zapEnd.zapTarget === KILLER_ID && zapEnd.revealed && zapEnd.phase === 'ended',
    `zapped=${zapEnd.zapCorrect} target=${zapEnd.zapTarget} revealed=${zapEnd.revealed} phase=${zapEnd.phase}`,
  );
  check(
    'results screen names the detective the winner',
    zapEnd.screenShown && zapEnd.results !== null && zapEnd.results.winnerId === myId && zapEnd.results.winnerName === myName,
    `winner="${zapEnd.results?.winnerName}" screen=${zapEnd.screenShown}`,
  );

  // ======================================================================
  // SCENARIO 10a — Rematch via the REAL results-screen button
  // ======================================================================
  console.log('  [10a] rematch');
  await page.locator('#bw-rematch').click();
  await waitFor(
    page,
    () => window.__mc.murder !== null && window.__mc.murder.phase === 'mingle' && window.__mc.murder.results === null,
    15_000,
    'rematch reaches mingle',
  );
  await awaitManor('rematch');
  const fresh = await page.evaluate(() => {
    const m = window.__mc.murder;
    return { phase: m.phase, coins: m.coins, charges: m.charges, coinItems: m.coinItems.size, alive: m.alive };
  });
  check(
    'Rematch deals a fresh hunt (mingle · 0 coins · 1 charge · alive)',
    fresh.phase === 'mingle' && fresh.coins === 0 && fresh.charges === 1 && fresh.alive === true,
    JSON.stringify(fresh),
  );

  // ======================================================================
  // SCENARIO 4 — wrong-zap guardrails (the fresh rematch match)
  // ======================================================================
  console.log('  [4] wrong zap guardrails');
  const innocentAvatar = await page.evaluate((innocentId) => {
    const victim = window.__mc.mobs.get(innocentId);
    return victim ? { x: victim.position.x, z: victim.position.z } : null;
  }, INNOCENT_ID);
  if (!innocentAvatar) throw new Error('the innocent guest avatar is not rendered');
  await teleportNear(innocentAvatar.x, innocentAvatar.z, 4.5); // point-blank for the 20-block zapper
  await page.evaluate((id) => window.__mc.sendZapGuest(id), INNOCENT_ID);
  await waitFor(page, () => window.__mc.murder?.events.some((e) => e.kind === 'zapped' && e.data.correct === false) === true, 6_000, 'zapped{correct:false}');
  await sleep(400); // the next 5 Hz snapshot carries charges/jam
  const jam = await page.evaluate((innocentId) => {
    const m = window.__mc.murder;
    const guest = m.guests.get(innocentId);
    return {
      charges: m.charges,
      jammedUntil: m.jammedUntil,
      jamChipShown: !document.getElementById('murder-jam').classList.contains('hidden'),
      jamChipText: document.getElementById('murder-jam').textContent,
      guestAlive: guest ? guest.alive : null,
    };
  }, INNOCENT_ID);
  check(
    'wrong zap: the zapper jams 10 s (charge lost, JAMMED chip shows)',
    jam.charges === 0 && jam.jammedUntil > Date.now() && jam.jamChipShown && /JAMMED/.test(jam.jamChipText ?? ''),
    `charges=${jam.charges} jamIn=${Math.round((jam.jammedUntil - Date.now()) / 1000)}s chip="${jam.jamChipText}"`,
  );
  check('the wrongly zapped guest is proven innocent and stays alive', jam.guestAlive === true, `guest ${INNOCENT_ID} alive=${jam.guestAlive}`);

  // ======================================================================
  // SCENARIO 10b — Leave-match → back to the sandbox
  // ======================================================================
  console.log('  [10b] leave-match');
  await page.evaluate(() => window.__mc.leaveGame());
  await waitFor(page, () => window.__mc.mode === 'sandbox' && window.__mc.murder === null, 10_000, 'sandbox after leave');
  const wildlife = await waitFor(page, () => window.__mc.mobs.size > 0, 12_000, 'wildlife re-broadcast').catch(() => false);
  const mobCount = await page.evaluate(() => window.__mc.mobs.size);
  check('Leave-match returns to the sandbox with wildlife back', wildlife && mobCount > 0, `mode=sandbox mobs=${mobCount}`);

  // ======================================================================
  // BOOT 2 — MM_ESCALATE_AT_MS=4000: ghost on death + Detector pulse
  // ======================================================================
  console.log('\n[boot 2] MM_ESCALATE_AT_MS=4000 — ghost on death, detector pulse');
  await restartServer({ MM_MURDERER_GUEST: '1', MM_ESCALATE_AT_MS: '4000' });

  // ======================================================================
  // SCENARIO 5 — ghost on death (the hunt reaches the idle detective)
  // ======================================================================
  console.log('  [5] ghost on death');
  await startMurderAfterRestart('ghost');
  await waitFor(page, () => window.__mc.murder?.phase === 'hunt', 15_000, 'the hunt begins at 4 s');
  // Stand still at the manor entrance: the murderer chases the nearest living
  // human (me) and swings twice (1.2 s apart) — give the chase ~35 s.
  const deathSeen = await waitFor(
    page,
    (id) => window.__mc.murder?.events.some((e) => e.kind === 'death' && e.data.playerId === id) === true,
    35_000,
    'the murderer got me (two melee hits)',
    myId,
  ).catch(() => false);
  const ghost = await page.evaluate((id) => ({
    deathEvent: window.__mc.murder.events.some((e) => e.kind === 'death' && e.data.playerId === id),
    alive: window.__mc.murder.alive,
    flyAllowed: window.__mc.player.flyAllowed,
    role: document.getElementById('murder-role').textContent,
    results: window.__mc.murder.results,
    screenShown: !document.getElementById('bw-results').classList.contains('hidden'),
  }), myId);
  check(
    'the murderer got me — ghost: death event, alive=false, fly unlocked',
    deathSeen && ghost.deathEvent && ghost.alive === false && ghost.flyAllowed === true && /Ghost/.test(ghost.role ?? ''),
    `alive=${ghost.alive} fly=${ghost.flyAllowed} role="${ghost.role}"`,
  );
  check(
    'both detectives got → the murderer wins (results screen)',
    ghost.screenShown && ghost.results !== null && ghost.results.winnerId === KILLER_ID && ghost.results.winnerName === 'Red Guest',
    `winner="${ghost.results?.winnerName}" screen=${ghost.screenShown}`,
  );

  // ======================================================================
  // SCENARIO 6 — Detector pulse (hunt phase, on the rematch)
  // ======================================================================
  console.log('  [6] detector pulse');
  await page.locator('#bw-rematch').click();
  await waitFor(page, () => window.__mc.murder !== null && window.__mc.murder.phase === 'mingle' && window.__mc.murder.results === null, 15_000, 'rematch #2 reaches mingle');
  await awaitManor('detector');
  await waitFor(page, () => window.__mc.murder.phase === 'hunt', 15_000, 'hunt for the detector');
  const killerNow = await page.evaluate((killerId) => {
    const killer = window.__mc.mobs.get(killerId);
    return killer ? { x: killer.position.x, z: killer.position.z } : null;
  }, KILLER_ID);
  if (!killerNow) throw new Error('the murderer avatar vanished during the hunt');
  const nearSpot = await teleportNear(killerNow.x, killerNow.z, 6); // inside the 12-block Detector range
  if (!nearSpot) throw new Error('no standable Detector spot near the murderer');
  const near = await waitFor(page, () => window.__mc.murder?.detectorNear === true, 4_000, 'detector pulses near the murderer').catch(() => false);
  // Leave immediately — the murderer is mid-chase and swings every 1.2 s.
  await page.evaluate(() => {
    const mc = window.__mc;
    const fx = mc.player.pos.x < 32 ? 53.5 : 10.5; // the opposite side of the manor
    const fz = mc.player.pos.z < 32 ? 53.5 : 10.5;
    mc.player.teleport(fx, 31, fz);
    mc.player.vel.set(0, 0, 0);
  });
  await sleep(1_600); // several 5 Hz snapshots from ~20+ blocks away
  const quiet1 = await page.evaluate(() => window.__mc.murder.detectorNear);
  await sleep(600);
  const quiet2 = await page.evaluate(() => window.__mc.murder.detectorNear);
  const stillAlive = await page.evaluate(() => window.__mc.murder.alive);
  check('Detector pulses while the murderer is near (hunt phase, still standing)', near === true && stillAlive === true, `near spot ${JSON.stringify(nearSpot)} alive=${stillAlive}`);
  check('Detector goes quiet from the far corner', quiet1 === false && quiet2 === false, `reads=${quiet1},${quiet2}`);
  await page.evaluate(() => window.__mc.leaveGame());
  await waitFor(page, () => window.__mc.mode === 'sandbox', 10_000, 'sandbox after the detector match');

  // ======================================================================
  // BOOT 3 — default timeline: gravestone read + the test-bot fellow Detective
  // ======================================================================
  console.log('\n[boot 3] default escalation — gravestone read, test bot');
  await restartServer({ MM_MURDERER_GUEST: '1' });

  // ======================================================================
  // SCENARIO 7 — gravestone read (a patient, honest mingle poll)
  // ======================================================================
  console.log('  [7] gravestone read (waiting for an isolated-victim strike…)');
  await startMurderAfterRestart('gravestone');
  // Mingle strikes need a FULLY isolated victim (≥12 from every human, ≥8
  // from every other guest): decisions run every 8–15 s and the strike walk
  // takes a few more seconds, so the honest floor for the first gravestone
  // is ~10–40 s. Poll up to 75 s — flaky beats forced-wrong (we do NOT shrink
  // the isolation rules or force kills; the forced murderer is the far-seeded
  // guest 0, which makes an early isolated victim likely).
  const killed = await waitFor(page, () => window.__mc.murder?.events.some((e) => e.kind === 'guestKilled') === true, 75_000, 'a guestKilled event').catch(() => false);
  const stone = await page.evaluate(() => {
    const ev = window.__mc.murder.events.find((e) => e.kind === 'guestKilled');
    return ev ? { x: Math.floor(ev.data.x), y: ev.data.y, z: Math.floor(ev.data.z), victimId: ev.data.victimId } : null;
  });
  check(
    'a mingle strike leaves a guestKilled event (the gravestone spot)',
    killed && stone !== null,
    stone ? `victim id ${stone.victimId} at (${stone.x}, ${stone.z})` : 'no strike within 75 s',
  );
  if (stone) {
    await page.evaluate((s) => {
      window.__mc.player.teleport(s.x + 0.5, 31, s.z + 0.5); // stand on the stone
      window.__mc.player.vel.set(0, 0, 0);
    }, stone);
    await sleep(MOVE_RELAY_MS);
    await page.evaluate((s) => window.__mc.sendInvestigate(s.x, s.z), stone);
    const read = await waitFor(page, () => window.__mc.murder?.events.some((e) => e.kind === 'gravestoneRead') === true, 6_000, 'gravestoneRead').catch(() => false);
    const readData = await page.evaluate(() => {
      const ev = window.__mc.murder.events.find((e) => e.kind === 'gravestoneRead');
      return ev ? { victimName: ev.data.victimName, ageSeconds: ev.data.ageSeconds } : null;
    });
    check(
      'investigating the stone answers victim + age (press E)',
      read === true && readData !== null && /^\w+ Guest$/.test(readData.victimName ?? '') && (readData.ageSeconds ?? -1) >= 0,
      readData ? `${readData.victimName} — ${readData.ageSeconds}s ago` : 'no gravestoneRead',
    );
  }

  // ======================================================================
  // SCENARIO 9 — the test bot joins as a fellow Detective (REAL buttons)
  // ======================================================================
  console.log('  [9] test bot fellow Detective');
  await page.evaluate(() => window.__mc.leaveGame());
  await waitFor(page, () => window.__mc.mode === 'sandbox' && window.__mc.murder === null, 10_000, 'sandbox lobby for the bot');
  await page.locator('#bot-add').click();
  await waitFor(page, () => window.__mc.net.players.some((p) => p.bot === true), 5_000, 'bot in roster');
  const botId = await page.evaluate(() => window.__mc.net.players.find((p) => p.bot === true)?.id ?? null);
  if (botId === null) throw new Error('bot id missing after add');
  await page.locator('#murder-start').click(); // 2 participants: real hunt vs the bot
  await awaitManor('bot');
  const botStart = await page.evaluate((id) => {
    const b = window.__mc.net.players.find((p) => p.id === id);
    return { x: b?.x ?? null, z: b?.z ?? null, hasAvatar: window.__mc.remotePlayers.has(id) };
  }, botId);
  check(
    'the bot spawns into the manor as a fellow Detective',
    botStart.hasAvatar && botStart.x > MANOR.minX && botStart.x < MANOR.maxX && botStart.z > MANOR.minZ && botStart.z < MANOR.maxZ,
    `pos=(${botStart.x?.toFixed(1)}, ${botStart.z?.toFixed(1)}) avatar=${botStart.hasAvatar}`,
  );
  // Wander window ONLY (the murderer may got the bot later — engine behavior).
  // Patient 30 s: the bot shares the guests' honest wander — a target behind
  // the nearest interior wall just stalls until the next 3–7 s re-decision,
  // so a short window under-reports a perfectly healthy stroll.
  const wanderDeadline = Date.now() + 30_000;
  let moved = 0;
  while (Date.now() < wanderDeadline) {
    await sleep(1_000);
    const pos = await page.evaluate((id) => {
      const b = window.__mc.net.players.find((p) => p.id === id);
      return b ? { x: b.x, z: b.z } : null;
    }, botId);
    if (!pos || botStart.x === null) continue;
    moved = Math.max(moved, Math.hypot(pos.x - botStart.x, pos.z - botStart.z));
    if (moved >= 2) break;
  }
  check('the bot wanders the manor (≥2 blocks within 30 s)', moved >= 2, `moved ${moved.toFixed(1)} blocks`);
  const botZaps = await page.evaluate((id) => window.__mc.murder.events.filter((e) => e.kind === 'zapped' && e.data.by === id).length, botId);
  const anyZaps = await page.evaluate(() => window.__mc.murder.events.filter((e) => e.kind === 'zapped').length);
  check('the bot never zaps (no zapped events at all)', botZaps === 0 && anyZaps === 0, `by-bot=${botZaps} total=${anyZaps}`);
  await page.evaluate(() => window.__mc.leaveGame());
  await waitFor(page, () => window.__mc.mode === 'sandbox', 10_000, 'sandbox after the bot match');

  // ======================================================================
  // BOOT 4 — MM_ROUND_MS=8000: timer expiry
  // ======================================================================
  console.log('\n[boot 4] MM_ROUND_MS=8000 — timer expiry');
  await restartServer({ MM_MURDERER_GUEST: '1', MM_ROUND_MS: '8000' });

  // ======================================================================
  // SCENARIO 8 — timer expiry = the Detectives win
  // ======================================================================
  console.log('  [8] timer expiry');
  await startMurderAfterRestart('expiry');
  // Do nothing at the manor entrance; the 8 s clock runs out.
  const expired = await waitFor(
    page,
    (id) => window.__mc.murder?.events.some((e) => e.kind === 'matchEnd' && e.data.winnerId === id) === true,
    25_000,
    'matchEnd at the 8 s mark',
    myId,
  ).catch(() => false);
  await waitFor(page, () => window.__mc.murder?.phase === 'ended', 4_000, 'phase ended at expiry').catch(() => false);
  const expiry = await page.evaluate((id) => ({
    matchEnd: window.__mc.murder.events.some((e) => e.kind === 'matchEnd'),
    revealed: window.__mc.murder.events.some((e) => e.kind === 'murdererRevealed'),
    winnerId: window.__mc.murder.results?.winnerId ?? null,
    winnerName: window.__mc.murder.results?.winnerName ?? null,
    phase: window.__mc.murder.phase,
    myName: window.__mc.net.players.find((p) => p.id === id)?.name ?? null,
  }), myId);
  check(
    'timer expiry: the Detectives win + the murderer is revealed',
    expired && expiry.matchEnd && expiry.revealed && expiry.winnerId === myId && expiry.phase === 'ended',
    `winner="${expiry.winnerName}" (me: ${expiry.myName}) revealed=${expiry.revealed} phase=${expiry.phase}`,
  );

  check('no page errors', errors.length === 0, errors.length ? errors.slice(0, 5).join(' | ') : 'none');
  finish('SMOKE-MURDER', errors);
} catch (error) {
  console.error(`SMOKE-MURDER FAILED: ${error.message}`);
  const tail = server?.logTail?.() ?? '';
  if (tail) console.error(`--- server log tail ---\n${tail}`);
  process.exitCode = 1;
} finally {
  await teardown({ browser, server, editsFile: EDITS_FILE });
}
