// M5.1 regression test for the real-playtest REMATCH bug (DESIGN.md §3.4.2):
// "after a match ends, both players pressed Rematch and the new match did not
// start properly". Plays a FULL Block Party 1v1 to matchEnd (A takes 3 rounds;
// B falls every round so it is spectating at matchEnd — the realistic shape),
// then BOTH clients click the REAL results-screen #bw-rematch button. Asserts
// the rematch actually starts: results screen hides, a fresh round 1 runs
// (fresh 625-cell floor, scores reset 0–0), both fighters are re-centered at
// their spawn slots and the HUD is back to round 1. Then the same for BedWars:
// full match (bed break + final kill → matchEnd), both press Rematch, assert a
// fresh countdown, hp/kills/deaths reset, BOTH beds alive again and both
// players parked at their team spawns.
//
// ROOT CAUSE the smoke exposed (server match.ts): a bed broken while its
// owner was dead awaiting respawn soft-locked the match — kill() had already
// made its elimination check, so nobody could respawn, no final kill could
// land and matchEnd never fired (no results screen, no rematch, "the next
// match never started"). Part [5] reproduces that exact sequence and asserts
// the match now ends; [6] rematches a second time.
//
// Builds the client to client/dist-test (the live client/dist is NEVER
// touched) and boots its own server on :8094 (never the live :8080).
//
// Usage: node tools/smoke-rematch.mjs   (SKIP_BUILD=1 to reuse the last build)
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
  teardown,
  waitFor,
} from './lib.mjs';

const PORT = Number(process.env.PORT ?? 8094); // never the live :8080
const BASE = `http://localhost:${PORT}`;
const EDITS_FILE = smokeOut('smoke-rematch-edits.json');

const { check, finish } = createChecks();

const AIR = 0;
const BED_BLUE = 14;
// Party floor bounds (shared/src/partyArena.ts) — Node-side constants only.
const FLOOR = { minX: 116, maxX: 140, minZ: 52, maxZ: 76, y: 30 };
// BedWars constants (shared/src/arena.ts): blue team bed + spawn area.
const BLUE_BED = [195, 31, 64];
const BLUE_SPAWN = { x: 189.5, y: 31, z: 64.5 };

let browser = null;
let server = null;
const errors = [];
try {
  // 0. build + boot ------------------------------------------------------------
  buildClient();
  await ensurePortFree(BASE, PORT);
  console.log('[server] booting game server…');
  server = await startServer({ port: PORT, editsFile: EDITS_FILE });

  browser = await launch();
  const { page: pageA } = await openPage({ base: BASE, browser, errors, label: 'A', wait: 'combined' });
  const { page: pageB } = await openPage({ base: BASE, browser, errors, label: 'B', wait: 'combined' });

  // NOTE: runs INSIDE the browser — no Node closures allowed in the body.
  const resultsHiddenInPage = () => document.getElementById('bw-results').classList.contains('hidden');

  const idA = await pageA.evaluate(() => window.__mc.net.id);
  const idB = await pageB.evaluate(() => window.__mc.net.id);

  // ===========================================================================
  // PART 1 — Block Party rematch
  // ===========================================================================
  console.log('[1] party: play to matchEnd (A wins 3 rounds, B falls each time)');
  await pageA.evaluate(() => window.__mc.startParty());
  for (const [page, label] of [[pageA, 'A'], [pageB, 'B']]) {
    await waitFor(
      page,
      () => window.__mc.mode === 'party' && window.__mc.party !== null && window.__mc.party.spawns.length === 2,
      15_000,
      `${label} modeChanged(party)`,
    );
    await waitFor(page, () => window.__mc.worldRenderer.pendingCount === 0, 60_000, `${label} party world built`);
  }

  /** Plays one round: A parks on an announced-color cell, B on a wrong one. */
  const playRound = async (round) => {
    for (const [page, label] of [[pageA, 'A'], [pageB, 'B']]) {
      await waitFor(
        page,
        (r) => window.__mc.party !== null && window.__mc.party.phase === 'announce' && window.__mc.party.round === r,
        20_000,
        `${label} announce of round ${round}`,
        round,
      );
    }
    const seenResults = await pageA.evaluate(
      () => window.__mc.party.events.filter((e) => e.kind === 'roundResult').length,
    );
    const pick = await pageA.evaluate((floor) => {
      const colorId = window.__mc.party.colorId;
      const cx = 128;
      const cz = 64;
      let good = null;
      let bad = null;
      let bestD = Infinity;
      for (let z = floor.minZ; z <= floor.maxZ; z++) {
        for (let x = floor.minX; x <= floor.maxX; x++) {
          const id = window.__mc.world.getBlock(x, floor.y, z);
          if (id === 0) continue;
          const d = Math.hypot(x - cx, z - cz);
          if (id === colorId && d < bestD) {
            bestD = d;
            good = [x, z];
          } else if (id !== colorId && Math.hypot(x - (good ? good[0] : cx), z - (good ? good[1] : cz)) >= 3) {
            bad = [x, z];
          }
        }
      }
      return { good, bad };
    }, FLOOR);
    if (!pick.good || !pick.bad) throw new Error(`round ${round}: no cells found`);
    await pageA.evaluate((cell) => {
      window.__mc.player.teleport(cell[0] + 0.5, 31, cell[1] + 0.5);
      window.__mc.player.vel.set(0, 0, 0);
    }, pick.good);
    await pageB.evaluate((cell) => window.__mc.player.teleport(cell[0] + 0.5, 31, cell[1] + 0.5), pick.bad);
    await sleep(MOVE_RELAY_MS); // movement relay so the server sees the standings
    const scored = await waitFor(
      pageA,
      (n) => window.__mc.party.events.filter((e) => e.kind === 'roundResult').length > n,
      15_000,
      `round ${round} result`,
      seenResults,
    );
    return { scored, pick };
  };

  let matchEnd = null;
  for (let round = 1; round <= 6 && !matchEnd; round++) {
    await playRound(round);
    matchEnd = await pageA.evaluate(() => window.__mc.party.results);
    await sleep(300);
  }
  check('A reached 3 round wins → matchEnd', matchEnd !== null && matchEnd.winnerId === idA, `winner=${matchEnd?.winnerName ?? 'none'}`);
  await waitFor(pageB, (id) => window.__mc.party.results !== null && window.__mc.party.results.winnerId === id, 5_000, 'matchEnd on B', idA);
  for (const [page, label] of [[pageA, 'A'], [pageB, 'B']]) {
    const shown = await page.evaluate(() => !document.getElementById('bw-results').classList.contains('hidden'));
    check(`results screen shown on ${label} before rematch`, shown, `visible=${shown}`);
  }

  // The results-screen button state the playtesters used: enabled, one ready
  // send per click (never stuck disabled).
  const buttonState = await pageA.evaluate(() => {
    const b = document.getElementById('bw-rematch');
    return { disabled: b.disabled, visible: !b.closest('#bw-results').classList.contains('hidden') };
  });
  check('Rematch button enabled on the results screen', buttonState.visible && !buttonState.disabled, JSON.stringify(buttonState));

  console.log('[2] party: BOTH players press the real Rematch button');
  await pageA.locator('#bw-rematch').click();
  await pageB.locator('#bw-rematch').click();

  // Both clients must leave the results screen behind (either immediately on a
  // successful rematch, or the server restart arrives within seconds).
  const aHid = await waitFor(pageA, resultsHiddenInPage, 12_000, 'A results screen hid').then(() => true).catch(() => false);
  const bHid = await waitFor(pageB, resultsHiddenInPage, 12_000, 'B results screen hid').then(() => true).catch(() => false);
  check('results screen hid on BOTH clients after both Rematch clicks', aHid && bHid, `A=${aHid} B=${bHid}`);

  // Fresh match: round resets to 1, scores 0–0, both clients rebuilt + parked
  // at their spawn slots, HUD back to "Round 1".
  for (const [page, label] of [[pageA, 'A'], [pageB, 'B']]) {
    await waitFor(
      page,
      () =>
        window.__mc.mode === 'party' && window.__mc.party !== null &&
        window.__mc.party.round === 1 && window.__mc.party.results === null,
      15_000,
      `${label} fresh party match (round 1, no results)`,
    );
    await waitFor(page, () => window.__mc.worldRenderer.pendingCount === 0, 60_000, `${label} rebuilt party world`);
  }
  await sleep(500); // let a gameState snapshot + finishSwitch teleport land
  const rematchParty = await Promise.all([
    pageA.evaluate((id) => ({
      myTeam: window.__mc.party.myTeam,
      pos: { x: window.__mc.player.pos.x, y: window.__mc.player.pos.y, z: window.__mc.player.pos.z },
      score: window.__mc.party.scores.get(id)?.score ?? -1,
      roundText: document.getElementById('party-round').textContent,
      resultsHidden: document.getElementById('bw-results').classList.contains('hidden'),
    }), idA),
    pageB.evaluate((id) => ({
      myTeam: window.__mc.party.myTeam,
      pos: { x: window.__mc.player.pos.x, y: window.__mc.player.pos.y, z: window.__mc.player.pos.z },
      score: window.__mc.party.scores.get(id)?.score ?? -1,
      roundText: document.getElementById('party-round').textContent,
      resultsHidden: document.getElementById('bw-results').classList.contains('hidden'),
    }), idB),
  ]);
  const spawnFor = (slot) => ({ x: 128.5, y: 31, z: slot === 0 ? 63.5 : 65.5 });
  const atSpawn = (view) => {
    const want = spawnFor(view.myTeam);
    return Math.hypot(view.pos.x - want.x, view.pos.z - want.z) < 1.5 && Math.abs(view.pos.y - want.y) < 2;
  };
  check(
    'party rematch: scores reset to 0 on both',
    rematchParty[0].score === 0 && rematchParty[1].score === 0,
    `A=${rematchParty[0].score} B=${rematchParty[1].score}`,
  );
  check(
    'party rematch: both fighters re-centered at their spawn slots',
    atSpawn(rematchParty[0]) && atSpawn(rematchParty[1]),
    `A=(${rematchParty[0].pos.x.toFixed(1)}, ${rematchParty[0].pos.y.toFixed(1)}, ${rematchParty[0].pos.z.toFixed(1)}) ` +
      `B=(${rematchParty[1].pos.x.toFixed(1)}, ${rematchParty[1].pos.y.toFixed(1)}, ${rematchParty[1].pos.z.toFixed(1)})`,
  );
  check(
    'party rematch: HUD reset to round 1, results gone on both',
    rematchParty[0].roundText === 'Round 1' && rematchParty[1].roundText === 'Round 1' &&
      rematchParty[0].resultsHidden && rematchParty[1].resultsHidden,
    `round="${rematchParty[0].roundText}"/"${rematchParty[1].roundText}"`,
  );
  // The floor must be whole again (625 solid cells) for the fresh match.
  await waitFor(
    pageA,
    () => window.__mc.party.phase === 'announce' && window.__mc.party.round === 1,
    20_000,
    'fresh match reaches round-1 announce',
  );
  const floorSolid = await pageA.evaluate((floor) => {
    let solid = 0;
    for (let z = floor.minZ; z <= floor.maxZ; z++) {
      for (let x = floor.minX; x <= floor.maxX; x++) {
        if (window.__mc.world.getBlock(x, floor.y, z) !== 0) solid++;
      }
    }
    return solid;
  }, FLOOR);
  check('party rematch: fresh 25×25 floor dealt (625 solid cells)', floorSolid === 625, `solid=${floorSolid}/625`);

  // Leave the rematch so BedWars can start from the sandbox.
  await pageA.evaluate(() => window.__mc.leaveGame());
  for (const [page, label] of [[pageA, 'A'], [pageB, 'B']]) {
    await waitFor(page, () => window.__mc.mode === 'sandbox' && window.__mc.party === null, 10_000, `${label} back in sandbox`);
  }

  // ===========================================================================
  // PART 2 — BedWars rematch
  // ===========================================================================
  console.log('[3] bedwars: play to matchEnd (A breaks B bed + final kill)');
  await pageA.evaluate(() => window.__mc.startBedwars());
  for (const [page, label] of [[pageA, 'A'], [pageB, 'B']]) {
    await waitFor(
      page,
      () => window.__mc.mode === 'bedwars' && window.__mc.bw !== null && window.__mc.bw.spawns.length === 2,
      15_000,
      `${label} modeChanged(bedwars)`,
    );
  }
  await waitFor(pageA, () => window.__mc.bw.phase === 'playing', 25_000, 'playing phase');

  /** Attacks B until it dies (A keeps adjacent, aims at the torso). */
  const attackUntilDead = async () => {
    for (let i = 0; i < 40; i++) {
      const target = await pageA.evaluate((id) => {
        const rp = window.__mc.remotePlayers.get(id);
        if (!rp) return null;
        const mc = window.__mc;
        if (Math.hypot(rp.position.x - mc.player.pos.x, rp.position.z - mc.player.pos.z) > 2.6) {
          mc.player.teleport(rp.position.x - 1.6, rp.position.y, rp.position.z);
        }
        mc.lookAt(rp.position.x, rp.position.y + 1.2, rp.position.z);
        return true;
      }, idB);
      if (!target) { await sleep(250); continue; }
      await sleep(320); // movement relay + 0.5 s attack cooldown spacing
      await pageA.evaluate(() => window.__mc.tryAttack());
      const dead = await pageB.evaluate((id) => {
        const p = window.__mc.bw.players.get(id);
        return p ? !p.alive : false;
      }, idB);
      if (dead) return true;
      await sleep(280);
    }
    return false;
  };

  /** Breaks B's bed from the normal break path (reach-validated, with retries). */
  const breakBlueBed = async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      await pageA.evaluate((bed) => window.__mc.player.teleport(193.5, 31, 64.5), BLUE_BED);
      await sleep(400); // move relay so the server's reach check sees A near the bed
      await pageA.evaluate((bed) => window.__mc.breakBlockAt(bed[0], bed[1], bed[2]), BLUE_BED);
      const broken = await waitFor(
        pageA,
        () => window.__mc.bw.events.some((e) => e.kind === 'bedBroken' && e.data.team === 1),
        4_000,
        'bedBroken event',
      ).catch(() => false);
      if (broken) return true;
    }
    return false;
  };

  // Match 1, canonical order: bed FIRST (while B is alive), then the final kill.
  const bedBroken = await breakBlueBed();
  check('B bed broken first (canonical order)', bedBroken, `sent=${bedBroken}`);
  await pageA.evaluate((spawnB) => window.__mc.player.teleport(spawnB.x - 1.6, spawnB.y, spawnB.z), BLUE_SPAWN);
  await sleep(400);
  const finalKilled = await attackUntilDead();
  await waitFor(
    pageA,
    (id) => window.__mc.bw.results !== null && window.__mc.bw.results.winnerId === id,
    10_000,
    'matchEnd on A',
    idA,
  );
  await waitFor(
    pageB,
    (id) => window.__mc.bw.results !== null && window.__mc.bw.results.winnerId === id,
    5_000,
    'matchEnd on B',
    idA,
  );
  const bwResultsShown = await Promise.all([
    pageA.evaluate(resultsHiddenInPage),
    pageB.evaluate(resultsHiddenInPage),
  ]);
  check('bedwars matchEnd + results visible on both', finalKilled && bwResultsShown[0] === false && bwResultsShown[1] === false, `killed=${finalKilled}`);

  // Snapshot pre-rematch state for reset assertions. NOTE: bw.events is
  // cleared by applyModeChanged on the fresh match, so a plain before/after
  // count can't prove "new" countdowns — stamp a marker onto both pages and
  // require countdown events stamped after it.
  const bwRematchClickedAt = Date.now();
  await pageA.evaluate((t) => {
    window.__rematchMarker = t;
  }, bwRematchClickedAt);

  console.log('[4] bedwars: BOTH players press the real Rematch button');
  await pageA.locator('#bw-rematch').click();
  await pageB.locator('#bw-rematch').click();

  for (const [page, label] of [[pageA, 'A'], [pageB, 'B']]) {
    await waitFor(page, resultsHiddenInPage, 12_000, `${label} results screen hid`).catch(() => {
      throw new Error(`${label}: results screen did not hide after both Rematch clicks — rematch never started`);
    });
    await waitFor(
      page,
      () => window.__mc.mode === 'bedwars' && window.__mc.bw !== null && window.__mc.bw.phase === 'countdown' && window.__mc.bw.results === null,
      15_000,
      `${label} fresh bedwars countdown`,
    );
  }
  await waitFor(pageA, () => window.__mc.bw.phase === 'playing', 25_000, 'fresh match reaches playing');
  const bwAfter = await Promise.all([
    pageA.evaluate((bed) => ({
      freshCountdown: window.__mc.bw.events.some((e) => e.kind === 'countdown' && e.at > window.__rematchMarker),
      me: window.__mc.bw.me(),
      beds: [...window.__mc.bw.bedsAlive],
      pos: { x: window.__mc.player.pos.x, y: window.__mc.player.pos.y, z: window.__mc.player.pos.z },
      myTeam: window.__mc.bw.myTeam,
      spawn: window.__mc.bw.spawns[window.__mc.bw.myTeam] ?? null,
      bedBlock: window.__mc.world.getBlock(bed[0], bed[1], bed[2]),
    }), BLUE_BED),
    pageB.evaluate((id) => ({
      me: window.__mc.bw.me(),
      beds: [...window.__mc.bw.bedsAlive],
      pos: { x: window.__mc.player.pos.x, y: window.__mc.player.pos.y, z: window.__mc.player.pos.z },
      myTeam: window.__mc.bw.myTeam,
      spawn: window.__mc.bw.spawns[window.__mc.bw.myTeam] ?? null,
    }), idB),
  ]);
  check(
    'bedwars rematch: fresh countdown ran (new countdown events on A)',
    bwAfter[0].freshCountdown,
    `freshCountdown=${bwAfter[0].freshCountdown} (events buffer resets on the new match)`,
  );
  check(
    'bedwars rematch: BOTH beds alive again + blue bed block restored',
    bwAfter[0].beds[0] === true && bwAfter[0].beds[1] === true && bwAfter[0].bedBlock === BED_BLUE,
    `beds=${JSON.stringify(bwAfter[0].beds)} block=${bwAfter[0].bedBlock}`,
  );
  const atTeamSpawn = (view) => {
    const want = view.spawn ?? BLUE_SPAWN;
    return Math.hypot(view.pos.x - want.x, view.pos.z - want.z) < 2.5 && Math.abs(view.pos.y - want.y) < 3;
  };
  check(
    'bedwars rematch: hp reset to 20, kills zeroed (fresh match state)',
    bwAfter.every((v) => v.me !== null && v.me.hp === 20 && v.me.kills === 0),
    `A=hp${bwAfter[0].me?.hp}/k${bwAfter[0].me?.kills} B=hp${bwAfter[1].me?.hp}/k${bwAfter[1].me?.kills}`,
  );
  check(
    'bedwars rematch: both players parked at their team spawns',
    atTeamSpawn(bwAfter[0]) && atTeamSpawn(bwAfter[1]),
    `A=(${bwAfter[0].pos.x.toFixed(1)}, ${bwAfter[0].pos.y.toFixed(1)}, ${bwAfter[0].pos.z.toFixed(1)}) ` +
      `B=(${bwAfter[1].pos.x.toFixed(1)}, ${bwAfter[1].pos.y.toFixed(1)}, ${bwAfter[1].pos.z.toFixed(1)})`,
  );

  // Match 2 IS the rematch. Regression for the playtest deadlock: kill B while
  // its bed STANDS (B starts the 5 s respawn wait), then break the bed DURING
  // that window. Pre-fix the match soft-locked here (no respawn, no final
  // kill, matchEnd never fired → no next match could ever start). Now B is
  // eliminated on the spot and the match must end cleanly.
  console.log('[5] rematch match: bed broken mid-respawn-window still ends the match');
  await pageA.evaluate((spawnB) => window.__mc.player.teleport(spawnB.x - 1.6, spawnB.y, spawnB.z), BLUE_SPAWN);
  await sleep(400);
  const firstKill = await attackUntilDead(); // bed stands → B starts waiting
  check('B killed while its bed stands (respawn window open)', firstKill, `killed=${firstKill}`);
  const bedBroken2 = await breakBlueBed(); // lands DURING the 5 s window
  check('bed broken during the respawn window', bedBroken2, `sent=${bedBroken2}`);
  await waitFor(
    pageA,
    (id) => window.__mc.bw.results !== null && window.__mc.bw.results.winnerId === id,
    10_000,
    'matchEnd after mid-window bed break (no soft-lock)',
    idA,
  );
  const winner2 = await pageA.evaluate(() => window.__mc.bw.results?.winnerId ?? null);
  check('rematch match ended cleanly (the mid-window break decided it)', winner2 === idA, `winner=${winner2}`);

  // And rematch AGAIN — rematch-of-rematch must work the same way.
  console.log('[6] second rematch');
  await pageA.locator('#bw-rematch').click();
  await pageB.locator('#bw-rematch').click();
  for (const [page, label] of [[pageA, 'A'], [pageB, 'B']]) {
    await waitFor(
      page,
      () => window.__mc.mode === 'bedwars' && window.__mc.bw !== null && window.__mc.bw.phase === 'countdown' && window.__mc.bw.results === null,
      15_000,
      `${label} second rematch countdown`,
    );
  }
  check('second rematch starts a fresh countdown on both clients', true, 'both clients back in countdown with no results');

  await pageA.evaluate(() => window.__mc.leaveGame());
  for (const [page, label] of [[pageA, 'A'], [pageB, 'B']]) {
    await waitFor(page, () => window.__mc.mode === 'sandbox' && window.__mc.bw === null, 10_000, `${label} back in sandbox`);
  }

  check('no page errors', errors.length === 0, errors.length ? errors.slice(0, 5).join(' | ') : 'none');

  finish('SMOKE-REMATCH', errors);
} catch (error) {
  console.error(`SMOKE-REMATCH FAILED: ${error.message}`);
  const tail = server?.logTail?.() ?? '';
  if (tail) console.error(`--- server log tail ---\n${tail}`);
  process.exitCode = 1;
} finally {
  await teardown({ browser, server, editsFile: EDITS_FILE });
}
