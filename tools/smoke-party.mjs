// M5 gate + M5.1 bomb extension: two-client Block Party 1v1 integration test
// for the minecraft-mini netcode.
//
// Builds the client, boots the game server on :8093 (edit file isolated under
// tools/smoke-out/), then drives TWO headless chrome pages through a full
// match via the same client paths the UI uses (__mc hooks). It never touches
// the :5173 dev server.
//   - startParty via the menu-button path → both clients swap to the party
//     void world; the 25×25 floor mosaic is visible (cells at y=30 over void)
//     and the spectator platform exists at (128, 30, 84)
//   - announce phase exposes colorId (party wool 20–27) + colorName via the
//     gameState mirror (__mc.party)
//   - client block edits are rejected during party (tryPlace/breakBlockAt
//     return false, no edit applied)
//   - a played-out round: A is teleported onto an announced-color cell, B onto
//     a wrong-color cell → at drop B's cell vanishes, B falls below y=8 →
//     roundResult survivor=A, A's score +1; the floor is re-placed next round
//   - the match is played OUT to first-to-3 (no test shortcuts): matchEnd with
//     winner A on both clients, results stats carry rounds/falls
//   - leaveGame → both clients back on the sandbox world, still able to build
//     (B places a block; A receives the edit)
//
// PART B (auto color bombs, protocol v5): restarts the server with
// PARTY_BOMB_RATE=1, replays a short match and asserts — NO bomb in round 1;
// in round 2 a bombSpawned event + gameState.party.bomb appear on BOTH clients
// within ~1.5 s of the announce, on a NON-announced cell; ~2 s later the fuse
// ends (bombDetonated on both, payload back to null) and the 3×3 patch around
// the cell equals the announced color; after the drop the painted cells
// SURVIVE (they are the announced color — no special-casing).
//
// Usage: node tools/smoke-party.mjs   (SKIP_BUILD=1 to reuse the last build)
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
} from './lib.mjs';

const PORT = Number(process.env.PORT ?? 8093); // never the live :8080
const BASE = `http://localhost:${PORT}`;
const EDITS_FILE = smokeOut('smoke-party-edits.json');

const { check, finish } = createChecks();

const AIR = 0;
// Party floor bounds (shared/src/partyArena.ts) — Node-side constants only.
const FLOOR = { minX: 116, maxX: 140, minZ: 52, maxZ: 76, y: 30 };

let browser = null;
let server = null;
const errors = [];
try {
  // 0. build + boot ------------------------------------------------------------
  buildClient();
  await ensurePortFree(BASE, PORT);
  console.log('[server] booting game server…');
  server = await startServer({ port: PORT, editsFile: EDITS_FILE, extraEnv: { PARTY_BOMB_RATE: '0' } }); // bombs off for the deterministic classic flow

  browser = await launch();
  const { page: pageA } = await openPage({ base: BASE, browser, errors, label: 'A', wait: 'combined' });
  const { page: pageB } = await openPage({ base: BASE, browser, errors, label: 'B', wait: 'combined' });

  const idA = await pageA.evaluate(() => window.__mc.net.id);
  const idB = await pageB.evaluate(() => window.__mc.net.id);
  check('two distinct players online', Number.isInteger(idA) && Number.isInteger(idB) && idA !== idB, `A=${idA} B=${idB}`);

  // 1. start the party via the menu-button path -----------------------------------
  console.log('[1] startParty → modeChanged + dance floor');
  await pageA.evaluate(() => window.__mc.startParty());
  for (const [page, label] of [[pageA, 'A'], [pageB, 'B']]) {
    await waitFor(
      page,
      () => window.__mc.mode === 'party' && window.__mc.party !== null && window.__mc.party.spawns.length === 2,
      15_000,
      `${label} modeChanged(party)`,
    );
    // World build done: the whole 256-chunk queue was enqueued synchronously on
    // the mode swap, so pendingCount === 0 means the arena finished meshing
    // (until then the client freezes physics and does not relay moves).
    await waitFor(page, () => window.__mc.worldRenderer.pendingCount === 0, 60_000, `${label} party world built`);
  }

  // Floor visible (a floor cell ≠ air over void) + spectator platform + void below.
  const floorA = await pageA.evaluate((floor) => {
    let solid = 0;
    let colors = new Set();
    for (let z = floor.minZ; z <= floor.maxZ; z++) {
      for (let x = floor.minX; x <= floor.maxX; x++) {
        const id = window.__mc.world.getBlock(x, floor.y, z);
        if (id !== 0) {
          solid++;
          colors.add(id);
        }
      }
    }
    const platform = [];
    for (let z = 83; z <= 85; z++) {
      for (let x = 127; x <= 129; x++) platform.push(window.__mc.world.getBlock(x, 30, z));
    }
    return {
      solid,
      colors: [...colors].sort(),
      voidBelow: window.__mc.world.getBlock(128, 25, 64),
      offFloor: window.__mc.world.getBlock(100, 30, 64),
      platformAllCobble: platform.every((id) => id === 9), // COBBLE
    };
  }, FLOOR);
  check(
    '25×25 colored floor over void (both clients see it below)',
    floorA.solid === 625 && floorA.colors.length === 8 &&
      floorA.colors.every((c) => c >= 20 && c <= 27) && floorA.voidBelow === AIR && floorA.offFloor === AIR,
    `solid=${floorA.solid}/625 colors=[${floorA.colors}] void=${floorA.voidBelow} offFloor=${floorA.offFloor}`,
  );
  check('spectator platform of cobble at (128, 30, 84)', floorA.platformAllCobble, '3×3 cobble cells');
  const floorB = await pageB.evaluate(
    (floor) => window.__mc.world.getBlock(floor.minX, floor.y, floor.minZ) !== 0,
    FLOOR,
  );
  check('floor visible on client B too', floorB, 'corner cell solid on B');

  // 2. announce: colorId + colorName in the gameState mirror -----------------------
  console.log('[2] announce color');
  await waitFor(
    pageA,
    () => window.__mc.party !== null && window.__mc.party.phase === 'announce' && window.__mc.party.colorId >= 20,
    10_000,
    'A announce phase',
  );
  await waitFor(
    pageB,
    () => window.__mc.party !== null && window.__mc.party.phase === 'announce' && window.__mc.party.colorId >= 20,
    5_000,
    'B announce phase',
  );
  const announce = await pageA.evaluate(() => ({
    colorId: window.__mc.party.colorId,
    colorName: window.__mc.party.colorName,
    round: window.__mc.party.round,
    timer: window.__mc.party.roundTimerMs,
  }));
  check(
    'announce exposes colorId/colorName/round/timer',
    announce.colorId >= 20 && announce.colorId <= 27 && announce.colorName.length > 0 &&
      announce.round === 1 && announce.timer >= 4000,
    `round=${announce.round} color=${announce.colorId} (${announce.colorName}) timer=${announce.timer}ms`,
  );
  const hudShown = await pageA.evaluate(() => ({
    hud: !document.getElementById('party-hud').classList.contains('hidden'),
    color: document.getElementById('party-color').textContent,
    slot: !document.getElementById('party-slot-block').style.backgroundColor.includes('0.15'),
  }));
  check('party HUD shows the announced color name + slot swatch', hudShown.hud && hudShown.color.length > 0 && hudShown.slot, `hud=${hudShown.hud} color="${hudShown.color}" slotTinted=${hudShown.slot}`);

  // 3. client block edits are rejected during party --------------------------------
  console.log('[3] edits rejected during party');
  const editRejected = await pageA.evaluate((floor) => {
    const mc = window.__mc;
    const cell = [floor.minX + 2, floor.y + 3, floor.minZ + 2]; // air cell above the floor
    if (mc.world.getBlock(cell[0], cell[1], cell[2]) !== 0) return { place: null, floorCell: null };
    const place = mc.tryPlace(cell[0], cell[1], cell[2]);
    const floorCell = mc.breakBlockAt(floor.minX + 1, floor.y, floor.minZ + 1);
    return { place, floorCell, stayedAir: mc.world.getBlock(cell[0], cell[1], cell[2]) === 0 };
  }, FLOOR);
  check(
    'tryPlace + breakBlockAt rejected during party, no edit applied',
    editRejected.place === false && editRejected.floorCell === false && editRejected.stayedAir === true,
    `place=${editRejected.place} break=${editRejected.floorCell} airAfter=${editRejected.stayedAir}`,
  );

  // 4. play the round: A on the announced color, B on a wrong color -----------------
  console.log('[4] round 1: A stands right, B stands wrong → B falls');

  /** Positions both fighters for the open announce: A on a good cell, B on a bad one. */
  const playRound = async (round) => {
    for (const [page, label] of [[pageA, 'A'], [pageB, 'B']]) {
      await waitFor(
        page,
        (r) => window.__mc.party !== null && window.__mc.party.phase === 'announce' && window.__mc.party.round === r,
        15_000,
        `${label} announce of round ${round}`,
        round,
      );
    }
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
      return { colorId, good, bad };
    }, FLOOR);
    if (!pick.good || !pick.bad) throw new Error(`round ${round}: no cells found (color ${pick.colorId})`);
    await pageA.evaluate((cell) => window.__mc.player.teleport(cell[0] + 0.5, 31, cell[1] + 0.5), pick.good);
    await pageB.evaluate((cell) => window.__mc.player.teleport(cell[0] + 0.5, 31, cell[1] + 0.5), pick.bad);
    await sleep(MOVE_RELAY_MS); // movement relay so the server sees the final standings
    // A must stay ALIVE for the score to be attributable — park it dead-center on its cell.
    await pageA.evaluate((cell) => {
      window.__mc.player.teleport(cell[0] + 0.5, 31, cell[1] + 0.5);
      window.__mc.player.vel.set(0, 0, 0);
    }, pick.good);
    return pick;
  };

  const round1 = await playRound(1);
  // Wait for the drop: B's wrong-color cell must vanish, A's good cell must stay.
  await waitFor(
    pageA,
    (cell) => window.__mc.world.getBlock(cell[0], 30, cell[1]) === 0,
    10_000,
    'drop removes the wrong-color cell',
    round1.bad,
  );
  const goodCellSurvived = await pageA.evaluate(
    (cell) => window.__mc.world.getBlock(cell[0], 30, cell[1]) === window.__mc.party.colorId,
    round1.good,
  );
  check(
    'drop removes non-announced cells, keeps the announced color',
    goodCellSurvived,
    `good=(${round1.good}) kept=${goodCellSurvived} color=${round1.colorId}`,
  );

  await waitFor(
    pageA,
    (id) => window.__mc.party.events.some((e) => e.kind === 'roundResult' && e.data.survivorId === id),
    15_000,
    'roundResult survivor=A on A',
    idA,
  );
  await waitFor(
    pageB,
    (id) => window.__mc.party.events.some((e) => e.kind === 'roundResult' && e.data.survivorId === id),
    5_000,
    'roundResult survivor=A on B',
    idA,
  );
  // The death event is the server's proof of the fall (void kill / backstop);
  // wait for B's mirrored alive=false too (arrives with the next 5 Hz gameState).
  const bDeath = await waitFor(
    pageB,
    (id) =>
      window.__mc.party.events.some((e) => e.kind === 'death' && e.data.playerId === id && e.data.cause === 'void') &&
      window.__mc.party.scores.get(id)?.alive === false,
    6_000,
    'B death (void) + alive=false',
    idB,
  );
  const bFellEventA = await pageA.evaluate(
    (id) => window.__mc.party.events.some((e) => e.kind === 'death' && e.data.playerId === id && e.data.cause === 'void'),
    idB,
  );
  const scoreA = await pageA.evaluate((id) => window.__mc.party.scores.get(id)?.score ?? -1, idA);
  check(
    'B fell (void death on both) → roundResult survivor=A, A score 1',
    bDeath && bFellEventA && scoreA === 1,
    `B death B=${bDeath} A=${bFellEventA} scoreA=${scoreA}`,
  );

  // 5. floor re-placed for round 2 ---------------------------------------------------
  console.log('[5] next round floor restore');
  await waitFor(
    pageA,
    () => window.__mc.party.phase === 'intermission' && window.__mc.party.round === 2,
    12_000,
    'round 2 intermission',
  );
  await waitFor(
    pageA,
    (cell) => window.__mc.world.getBlock(cell[0], 30, cell[1]) !== 0,
    8_000,
    'dropped cell re-placed with the fresh mosaic',
    round1.bad,
  );
  check('floor restored for round 2 (fresh mosaic re-placed the void cells)', true, 'intermission round=2, cell solid again');

  // 6. play the match OUT to first-to-3 (no test shortcuts) ---------------------------
  console.log('[6] playing out to 3 round wins…');
  let matchEnd = null;
  for (let round = 2; round <= 8 && !matchEnd; round++) {
    // Count round results BEFORE the round so stale events can't false-pass.
    const seenResults = await pageA.evaluate(
      () => window.__mc.party.events.filter((e) => e.kind === 'roundResult').length,
    );
    await playRound(round);
    await waitFor(
      pageA,
      (n) => window.__mc.party.events.filter((e) => e.kind === 'roundResult').length > n,
      15_000,
      `round ${round} result`,
      seenResults,
    );
    matchEnd = await pageA.evaluate(() => window.__mc.party.results);
    await sleep(400);
  }
  const scoresMid = await pageA.evaluate((id) => window.__mc.party.scores.get(id)?.score ?? -1, idA);
  check('A reached 3 round wins and the match ended', matchEnd !== null && matchEnd.winnerId === idA, `scoreA=${scoresMid} winner=${matchEnd?.winnerName ?? 'none'}`);
  await waitFor(
    pageB,
    (id) => window.__mc.party.results !== null && window.__mc.party.results.winnerId === id,
    5_000,
    'matchEnd on B',
    idA,
  );
  const stats = await pageA.evaluate(() => window.__mc.party.results?.stats ?? []);
  check(
    'matchEnd stats carry rounds + falls (party shape)',
    stats.length === 2 && stats.every((s) => typeof s.rounds === 'number' && typeof s.falls === 'number'),
    JSON.stringify(stats),
  );
  const resultsVisibleA = await pageA.evaluate(() => !document.getElementById('bw-results').classList.contains('hidden'));
  const resultsTextB = await pageB.evaluate(() => document.getElementById('bw-result-sub').textContent);
  check('results screen (reused from BedWars) shown on both clients', resultsVisibleA && resultsTextB.includes('won the match'), `A visible=${resultsVisibleA} B sub="${resultsTextB}"`);

  // 7. leaveGame → both back on the sandbox world and able to build --------------------
  console.log('[7] leaveGame → sandbox');
  await pageA.evaluate(() => window.__mc.leaveGame());
  for (const [page, label] of [[pageA, 'A'], [pageB, 'B']]) {
    await waitFor(
      page,
      () => window.__mc.mode === 'sandbox' && window.__mc.party === null,
      10_000,
      `${label} back in sandbox`,
    );
  }
  // B places a block; the edit must reach A (sandbox sync intact after two modes).
  await pageB.evaluate(() => {
    const mc = window.__mc;
    for (let x = 96; x < 140; x++) {
      const gy = mc.world.highestBlock(x, 128);
      if (gy > 0 && gy + 4 < 60) {
        mc.player.teleport(x + 0.5, gy + 1, 128.5);
        window.__placeCell = [x, gy + 3, 128];
        return;
      }
    }
    window.__placeCell = null;
  });
  await sleep(300);
  const placed = await pageB.evaluate(() => {
    const cell = window.__placeCell;
    if (!cell) return false;
    return window.__mc.tryPlace(cell[0], cell[1], cell[2]) && window.__mc.world.getBlock(cell[0], cell[1], cell[2]) !== 0;
  });
  check('sandbox building still works after the match (B placed a block)', placed, `placed=${placed}`);

  // The placed block must have been broadcast: read the same cell from A.
  const cellOnB = await pageB.evaluate(() => window.__placeCell);
  const synced = await waitFor(
    pageA,
    (cell) => window.__mc.world.getBlock(cell[0], cell[1], cell[2]) !== 0,
    6_000,
    'A received the sandbox edit',
    cellOnB,
  );
  check('edit synced to the other client', synced, `cell=${JSON.stringify(cellOnB)} synced=${synced}`);

  // 8. PART B — auto color bombs (protocol v5) --------------------------------------
  console.log('[8] restart server with PARTY_BOMB_RATE=1 → bomb round');
  await stopServer(server);
  server = await startServer({ port: PORT, editsFile: EDITS_FILE, extraEnv: { PARTY_BOMB_RATE: '1' }, resetEdits: false });
  // Same two pages ride the restart on their own reconnect — re-goto + wait.
  const waitOnline = async (page) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => window.__mc !== undefined && window.__mc?.net?.mode === 'online',
      null,
      { timeout: 60_000 },
    );
  };
  await waitOnline(pageA);
  await waitOnline(pageB);
  await pageA.evaluate(() => window.__mc.startParty());
  for (const [page, label] of [[pageA, 'A'], [pageB, 'B']]) {
    await waitFor(
      page,
      () => window.__mc.mode === 'party' && window.__mc.party !== null,
      15_000,
      `${label} modeChanged(party) #2`,
    );
    await waitFor(page, () => window.__mc.worldRenderer.pendingCount === 0, 60_000, `${label} party world rebuilt`);
  }

  // Round 1: bombs start at round 2 — the +1 s spawn moment must stay bomb-free.
  await waitFor(
    pageA,
    () => window.__mc.party !== null && window.__mc.party.phase === 'announce' && window.__mc.party.round === 1,
    20_000,
    'round-1 announce (bomb match)',
  );
  await sleep(1700); // well past the +1 s spawn moment
  const r1 = await pageA.evaluate(() => ({
    bomb: window.__mc.party.bomb,
    spawnedEvent: window.__mc.party.events.some((e) => e.kind === 'bombSpawned'),
  }));
  check('round 1 has no auto bomb (bombs start at round 2)', r1.bomb === null && !r1.spawnedEvent, JSON.stringify(r1));
  // Let round 1 resolve on its own (both fighters sit at the re-center spawns;
  // any result — draw included — advances the match to round 2).
  await waitFor(pageA, () => window.__mc.party.round === 2, 30_000, 'round 2 reached');

  // Round 2: the bomb must appear ~1 s into the announce, on a NON-announced cell.
  await waitFor(
    pageA,
    () => window.__mc.party.phase === 'announce' && window.__mc.party.round === 2,
    20_000,
    'round-2 announce',
  );
  await waitFor(pageA, () => window.__mc.party.bomb !== null, 4_000, 'gameState.party.bomb appears');
  const bombInfo = await pageA.evaluate(() => {
    const bomb = window.__mc.party.bomb;
    return {
      cell: bomb ? bomb.cell : null,
      colorId: bomb ? bomb.colorId : 0,
      detonatesAt: bomb ? bomb.detonatesAt : 0,
      announced: window.__mc.party.colorId,
      cellBlock: bomb ? window.__mc.world.getBlock(bomb.cell[0], 30, bomb.cell[1]) : -1,
      spawnEvent: window.__mc.party.events.some((e) => e.kind === 'bombSpawned'),
    };
  });
  check(
    'round-2 bomb on a NON-announced cell (bombSpawned + payload)',
    bombInfo.cell !== null && bombInfo.spawnEvent && bombInfo.colorId === bombInfo.announced &&
      bombInfo.cellBlock !== bombInfo.announced && bombInfo.cellBlock !== AIR,
    JSON.stringify(bombInfo),
  );
  const bombOnB = await waitFor(
    pageB,
    () => window.__mc.party.events.some((e) => e.kind === 'bombSpawned') && window.__mc.party.bomb !== null,
    4_000,
    'B bombSpawned + payload',
  );
  check('bombSpawned + payload also on client B', bombOnB, 'B sees the same fused bomb');

  // Fuse runs out ~2 s after spawn: detonation events + the 3×3 patch painted.
  await waitFor(pageA, () => window.__mc.party.events.some((e) => e.kind === 'bombDetonated'), 8_000, 'bombDetonated on A');
  const painted = await pageA.evaluate((floor) => {
    const bomb = window.__mc.party.events.filter((e) => e.kind === 'bombDetonated').pop();
    const announced = window.__mc.party.colorId;
    const cells = [];
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = bomb.data.cell[0] + dx;
        const z = bomb.data.cell[1] + dz;
        if (x < floor.minX || x > floor.maxX || z < floor.minZ || z > floor.maxZ) continue;
        cells.push([x, z, window.__mc.world.getBlock(x, floor.y, z)]);
      }
    }
    return { announced, cells, bombNull: window.__mc.party.bomb === null };
  }, FLOOR);
  check(
    'detonation paints the 3×3 patch into the announced color',
    painted.cells.length === 9 && painted.cells.every((entry) => entry[2] === painted.announced) && painted.bombNull,
    `announced=${painted.announced} cells=${JSON.stringify(painted.cells)} bombNull=${painted.bombNull}`,
  );
  const detonatedB = await waitFor(
    pageB,
    () => window.__mc.party.events.some((e) => e.kind === 'bombDetonated'),
    4_000,
    'bombDetonated on B',
  );
  check('bombDetonated also on client B', detonatedB, 'B saw the blast event');

  // The drop: painted cells survive (they ARE the announced color now).
  await waitFor(pageA, () => window.__mc.party.phase === 'drop', 8_000, 'drop after the bomb round');
  const survived = await pageA.evaluate((floor) => {
    const bomb = window.__mc.party.events.filter((e) => e.kind === 'bombDetonated').pop();
    const announced = window.__mc.party.colorId;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = bomb.data.cell[0] + dx;
        const z = bomb.data.cell[1] + dz;
        if (x < floor.minX || x > floor.maxX || z < floor.minZ || z > floor.maxZ) continue;
        if (window.__mc.world.getBlock(x, floor.y, z) !== announced) return false;
      }
    }
    return true;
  }, FLOOR);
  check('painted 3×3 patch survives the drop', survived, 'patch still the announced color after the drop edits');

  // Clean finish: leave the bomb match.
  await pageA.evaluate(() => window.__mc.leaveGame());
  for (const [page, label] of [[pageA, 'A'], [pageB, 'B']]) {
    await waitFor(
      page,
      () => window.__mc.mode === 'sandbox' && window.__mc.party === null,
      10_000,
      `${label} sandbox after bomb match`,
    );
  }

  // 9. clean pages ----------------------------------------------------------------
  check('no page errors', errors.length === 0, errors.length ? errors.slice(0, 5).join(' | ') : 'none');

  finish('SMOKE-PARTY', errors);
} catch (error) {
  console.error(`SMOKE-PARTY FAILED: ${error.message}`);
  const tail = server?.logTail?.() ?? '';
  if (tail) console.error(`--- server log tail ---\n${tail}`);
  process.exitCode = 1;
} finally {
  await teardown({ browser, server, editsFile: EDITS_FILE });
}
