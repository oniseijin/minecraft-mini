// M4+M6.1 gate: two-client BedWars 1v1 integration test for the minecraft-mini netcode.
//
// Builds the client, boots the game server on :8092 (edit file isolated under
// tools/smoke-out/), then drives TWO headless chrome pages through a full
// match, all via the same client paths the UI uses (__mc hooks):
//   - startGame via the menu-button path → both clients swap to the arena
//     (grass islands where the sandbox has water; void where it has stone)
//   - countdown → playing phase; iron/gold generators accrue (5 Hz gameState)
//   - shop buy near the island pad deducts currency and grants wool ×16
//   - A attacks B (the exact left-click raycast path) → hp drops → death →
//     respawn at the team spawn while the bed stands
//   - A breaks B's bed (client edit near the bed, server team rule) →
//     bedBroken on both clients
//   - M6.1 bow: A buys the bow (12 gold) + arrows (8 iron, ×6) — currency
//     deducted, ammo counted, slot 5 selects the bow — then fires a charged
//     shot at B: `hit` event with cause 'arrow' on BOTH clients, hp drop,
//     and (B's bed already broken) the arrow kill is FINAL → matchEnd
//   - leaveGame → both clients back on the sandbox world and able to build
//
// Usage: node tools/smoke-bedwars.mjs   (SKIP_BUILD=1 to reuse the last build)
import {
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

const PORT = Number(process.env.PORT ?? 8092); // never the live :8080
const BASE = `http://localhost:${PORT}`;
const EDITS_FILE = smokeOut('smoke-bedwars-edits.json');

const { check, finish } = createChecks();

const GRASS = 1; // block ids — Node-side assertion values only
const AIR = 0;

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

  const idA = await pageA.evaluate(() => window.__mc.net.id);
  const idB = await pageB.evaluate(() => window.__mc.net.id);
  check('two distinct players online', Number.isInteger(idA) && Number.isInteger(idB) && idA !== idB, `A=${idA} B=${idB}`);

  // Capture sandbox canaries BEFORE the match: the arena overwrites (64,30,64)
  // with grass and (128,20,64) is void in the arena but solid/water in the
  // sandbox — so both prove the world actually swapped.
  const canary = await pageB.evaluate(() => ({
    island: window.__mc.world.getBlock(64, 30, 64),
    midVoid: window.__mc.world.getBlock(128, 20, 64),
  }));

  // 1. start the match via the menu-button path ---------------------------------
  console.log('[1] startGame → modeChanged + arena world');
  await pageA.evaluate(() => window.__mc.startBedwars());
  for (const [page, label] of [[pageA, 'A'], [pageB, 'B']]) {
    await waitFor(
      page,
      () => window.__mc.mode === 'bedwars' && window.__mc.bw !== null && window.__mc.bw.spawns.length === 2,
      15_000,
      `${label} modeChanged(bedwars)`,
    );
    await waitFor(page, () => window.__mc.player !== null && window.__mc.mode === 'bedwars', 60_000, `${label} arena built`);
  }
  const arenaA = await pageA.evaluate(() => ({
    island: window.__mc.world.getBlock(64, 30, 64),
    midVoid: window.__mc.world.getBlock(128, 20, 64),
    bedRed: window.__mc.world.getBlock(61, 31, 64),
    bedBlue: window.__mc.world.getBlock(195, 31, 64),
  }));
  check(
    'arena world differs from sandbox (grass island + void at mid)',
    arenaA.island === GRASS && arenaA.midVoid === AIR &&
      !(canary.island === GRASS && canary.midVoid === AIR),
    `island=${arenaA.island} (sandbox ${canary.island}) void=${arenaA.midVoid} (sandbox ${canary.midVoid})`,
  );
  check('both team beds exist in the arena', arenaA.bedRed === 13 && arenaA.bedBlue === 14, `red=${arenaA.bedRed} blue=${arenaA.bedBlue}`);
  const teams = await Promise.all([
    pageA.evaluate(() => window.__mc.bw.myTeam),
    pageB.evaluate(() => window.__mc.bw.myTeam),
  ]);
  check('teams assigned 0/1 to the two clients', teams[0] === 0 && teams[1] === 1, `A=team${teams[0]} B=team${teams[1]}`);

  // 2. countdown → playing, generators accrue ------------------------------------
  console.log('[2] countdown → playing + iron generator');
  await waitFor(pageA, () => window.__mc.bw.phase === 'countdown', 5_000, 'countdown phase');
  const sawCountdownEvent = await waitFor(
    pageA,
    () => window.__mc.bw.events.some((e) => e.kind === 'countdown'),
    15_000,
    'countdown events',
  );
  check('countdown ticks seen (gameEvent)', sawCountdownEvent, 'events contain countdown');
  await waitFor(pageA, () => window.__mc.bw.phase === 'playing', 20_000, 'playing phase');
  await waitFor(pageB, () => window.__mc.bw.phase === 'playing', 5_000, 'B playing phase');
  // Iron: +1 / 1.5 s to each island player.
  await waitFor(pageA, () => window.__mc.bw.currency.iron >= 4, 20_000, 'A iron ≥ 4');
  const ironB = await pageB.evaluate(() => window.__mc.bw.currency.iron);
  check('iron generators accrue on both islands', ironB > 0, `B iron=${ironB}`);

  // 3. shop buy deducts currency -------------------------------------------------
  console.log('[3] shop purchase');
  // Stand on the red shop pad, then buy wool ×16 (4 iron) through the panel.
  await pageA.evaluate(() => {
    const mc = window.__mc;
    const shop = mc.bw.spawns.length ? null : null; // shop point from shared ARENA
    mc.player.teleport(61.5, 31, 62.5);
    mc.lookAt(61.5, 31, 60.5);
    return shop;
  });
  await sleep(400); // move relay so the server knows A's position
  const beforeBuy = await pageA.evaluate(() => ({ iron: window.__mc.bw.currency.iron, wool: window.__mc.bw.inv.wool }));
  const shopOpened = await pageA.evaluate(() => window.__mc.openShop());
  await pageA.evaluate(() => window.__mc.buy('wool'));
  let bought = null;
  const tBuy = Date.now();
  while (Date.now() - tBuy < 6_000) {
    bought = await pageA.evaluate(() => ({
      iron: window.__mc.bw.currency.iron,
      wool: window.__mc.bw.inv.wool,
      open: window.__mc.isShopOpen,
    }));
    if (bought.wool === 16) break;
    await sleep(120);
  }
  check('shop panel opened via B-key path', shopOpened, `open=${shopOpened}`);
  check(
    'buying wool ×16 deducted 4 iron (server-validated)',
    bought && bought.wool === 16 && bought.iron < beforeBuy.iron,
    `iron ${beforeBuy.iron}→${bought?.iron} wool=${bought?.wool}`,
  );
  await pageA.evaluate(() => window.__mc.closeShop());

  // 4. melee: A attacks B → hp drops → death → respawn (bed alive) ----------------
  console.log('[4] combat + respawn');
  const attackLoop = async () => {
    for (let i = 0; i < 40; i++) {
      const target = await pageA.evaluate((id) => {
        const rp = window.__mc.remotePlayers.get(id);
        if (!rp) return null;
        const mc = window.__mc;
        // Keep A adjacent (knockback slides B around) and aim at its torso.
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
  // Bring the fight to B's island: A hops next to B's spawn (blue team = 1).
  await pageA.evaluate((spawnB) => window.__mc.player.teleport(spawnB.x - 1.6, spawnB.y, spawnB.z), {
    x: 189.5, y: 31, z: 64.5,
  });
  await sleep(400);
  const hpBefore = await pageB.evaluate((id) => window.__mc.bw.players.get(id)?.hp ?? null, idB);
  await attackLoop();
  const deathA = await pageA.evaluate(
    (id) => window.__mc.bw.events.some((e) => e.kind === 'death' && e.data.playerId === id),
    idB,
  );
  const deathB = await pageB.evaluate(
    (id) => window.__mc.bw.events.some((e) => e.kind === 'death' && e.data.playerId === id),
    idB,
  );
  check('B died from repeated attacks (death events on both)', deathA && deathB, `A=${deathA} B=${deathB}`);
  await waitFor(
    pageB,
    (id) => {
      const p = window.__mc.bw.players.get(id);
      return !!p && p.alive && p.hp === 20;
    },
    12_000,
    'B respawn',
    idB,
  );
  const respawnedAt = await pageB.evaluate(() => ({ x: window.__mc.player.pos.x, z: window.__mc.player.pos.z }));
  check(
    'B respawned at its spawn while the bed stands',
    Math.hypot(respawnedAt.x - 189.5, respawnedAt.z - 64.5) < 2,
    `pos=(${respawnedAt.x.toFixed(1)}, ${respawnedAt.z.toFixed(1)}) hpBefore=${hpBefore}`,
  );

  // 5. A breaks B's bed → bedBroken on both ---------------------------------------
  console.log('[5] bed destruction');
  await pageA.evaluate(() => window.__mc.player.teleport(193.5, 31, 64.5));
  await sleep(400); // move relay so the server's reach check sees A near the bed
  const bedBrokenOk = await pageA.evaluate(() => window.__mc.breakBlockAt(195, 31, 64));
  const bedBrokenA = await waitFor(
    pageA,
    () => window.__mc.bw.events.some((e) => e.kind === 'bedBroken' && e.data.team === 1),
    5_000,
    'bedBroken event on A',
  );
  const bedBrokenB = await waitFor(
    pageB,
    () => window.__mc.bw.events.some((e) => e.kind === 'bedBroken' && e.data.team === 1),
    5_000,
    'bedBroken event on B',
  );
  const bedGoneOnB = await pageB.evaluate(() => window.__mc.world.getBlock(195, 31, 64) === 0);
  check(
    'A breaks the blue bed → bedBroken on both clients',
    bedBrokenOk && bedBrokenA && bedBrokenB && bedGoneOnB,
    `sent=${bedBrokenOk} A=${bedBrokenA} B=${bedBrokenB} goneOnB=${bedGoneOnB}`,
  );

  // 6. bow + arrows purchase (M6.1) — currency deducted, ammo counted ----------
  console.log('[6] bow + arrows purchase');
  // Back to A's shop pad; wait out the generators for the 12-gold bow + 8 iron.
  await pageA.evaluate(() => window.__mc.player.teleport(61.5, 31, 62.5));
  await sleep(400);
  await waitFor(
    pageA,
    () => window.__mc.bw.currency.gold >= 12 && window.__mc.bw.currency.iron >= 8,
    90_000,
    'A gold ≥ 12 + iron ≥ 8',
  );
  const beforeBow = await pageA.evaluate(() => ({
    gold: window.__mc.bw.currency.gold,
    iron: window.__mc.bw.currency.iron,
    bow: window.__mc.bw.inv.bow,
    arrows: window.__mc.bw.inv.arrows,
  }));
  check('bow slot ghosted before purchase (muted, no count)', beforeBow.bow === false && beforeBow.arrows === 0, `bow=${beforeBow.bow} arrows=${beforeBow.arrows}`);
  await pageA.evaluate(() => window.__mc.openShop());
  await pageA.evaluate(() => window.__mc.buy('bow'));
  await pageA.evaluate(() => window.__mc.buy('arrows'));
  const bowBought = await waitFor(
    pageA,
    () => window.__mc.bw.inv.bow === true && window.__mc.bw.inv.arrows === 6,
    6_000,
    'bow + 6 arrows in inventory',
  );
  await pageA.evaluate(() => window.__mc.closeShop());
  const afterBow = await pageA.evaluate(() => ({
    gold: window.__mc.bw.currency.gold,
    iron: window.__mc.bw.currency.iron,
  }));
  check(
    'buying bow (12 gold) + arrows ×6 (8 iron) deducted currency (server-validated)',
    bowBought && afterBow.gold < beforeBow.gold && afterBow.iron < beforeBow.iron,
    `gold ${beforeBow.gold}→${afterBow.gold} iron ${beforeBow.iron}→${afterBow.iron}`,
  );
  await pageA.evaluate(() => window.__mc.selectSlot(4));
  await sleep(200);
  const bowHeld = await pageA.evaluate(() => ({ held: window.__mc.held(), count: window.__mc.bw.inv.arrows }));
  check('slot 5 selects the bow (held reports bow while ammo lasts)', bowHeld.held === 'bow', `held=${bowHeld.held} arrows=${bowHeld.count}`);

  // 7. charged shot → hit (arrow) → hp drop → FINAL kill ends the match ---------
  console.log('[7] charged shot + final kill by arrow');
  // A takes position on the bridge end with a clear line to B's spawn (B is
  // alive there since phase 4's respawn; its bed broke in phase 5, so a bow
  // kill here is the FINAL kill).
  const hpBeforeArrow = await pageB.evaluate((id) => window.__mc.bw.players.get(id)?.hp ?? null, idB);
  // Ammo-per-shot is proven by a deliberate SKY shot first: the killing shot
  // spends its arrow in the same server tick as the final kill, and the match
  // end freezes the 5 Hz snapshots before that spend can propagate — its ammo
  // is not assertable (documented weakening, M7.4 precedent).
  await pageA.evaluate(() => {
    window.__mc.player.teleport(185.5, 29, 64.5);
    window.__mc.look(0, 1.2); // straight up — no hit, no kill
  });
  await sleep(350);
  await pageA.evaluate(() => window.__mc.startBowCharge());
  await sleep(1100);
  await pageA.evaluate(() => window.__mc.releaseBowCharge());
  const ammoAfterSky = await waitFor(pageA, () => window.__mc.bw.inv.arrows === 5, 4_000, 'sky shot spent an arrow (ammo 5)');
  let shotsSent = 1; // the sky shot
  const bowKill = await (async () => {
    for (let i = 0; i < 6; i++) {
      const aimed = await pageA.evaluate((id) => {
        const rp = window.__mc.remotePlayers.get(id);
        if (!rp) return false;
        const mc = window.__mc;
        mc.player.teleport(185.5, 29, 64.5);
        mc.lookAt(rp.position.x, rp.position.y + 1.2, rp.position.z);
        return true;
      }, idB);
      if (!aimed) { await sleep(300); continue; }
      await sleep(350); // movement relay so the server aims the arrow from A's eye
      const started = await pageA.evaluate(() => window.__mc.startBowCharge());
      if (!started) { await sleep(400); continue; }
      await sleep(1100); // hold-to-charge 0.2–1 s → full charge (24 dmg)
      const sent = await pageA.evaluate(() => window.__mc.releaseBowCharge());
      if (sent) shotsSent++;
      const dead = await pageB.evaluate((id) => {
        const p = window.__mc.bw.players.get(id);
        return p ? !p.alive : false;
      }, idB);
      if (dead) return true;
      await sleep(700); // attack cooldown + arrow flight + snapshot settle
    }
    return false;
  })();
  const hitArrowA = await pageA.evaluate(
    (id) => window.__mc.bw.events.some((e) => e.kind === 'hit' && e.data.cause === 'arrow' && e.data.targetId === id),
    idB,
  );
  const hitArrowB = await pageB.evaluate(
    (id) => window.__mc.bw.events.some((e) => e.kind === 'hit' && e.data.cause === 'arrow' && e.data.targetId === id),
    idB,
  );
  const arrowsSeenA = await pageA.evaluate(() => window.__mc.arrowFx.seen);
  const arrowsSeenB = await pageB.evaluate(() => window.__mc.arrowFx.seen);
  check(
    'charged shot hit B (hit event, cause arrow, on both clients)',
    bowKill && hitArrowA && hitArrowB,
    `killed=${bowKill} hitA=${hitArrowA} hitB=${hitArrowB} hpBefore=${hpBeforeArrow}`,
  );
  check(
    'arrow launch rendered on both clients + ammo spent per shot',
    arrowsSeenA >= 1 && arrowsSeenB >= 1 && ammoAfterSky,
    `seenA=${arrowsSeenA} seenB=${arrowsSeenB} shots=${shotsSent} skyShotAmmo=${ammoAfterSky ? 5 : 'stuck'}`,
  );
  const matchEndA = await waitFor(
    pageA,
    (id) => window.__mc.bw.results !== null && window.__mc.bw.results.winnerId === id,
    10_000,
    'matchEnd on A',
    idA,
  );
  const matchEndB = await waitFor(
    pageB,
    (id) => window.__mc.bw.results !== null && window.__mc.bw.results.winnerId === id,
    5_000,
    'matchEnd on B',
    idA,
  );
  const stats = await pageA.evaluate(() => window.__mc.bw.results?.stats ?? []);
  check(
    'final kill by arrow → matchEnd with winner A on both clients',
    matchEndA && matchEndB,
    `stats=${JSON.stringify(stats)}`,
  );

  // 8. leaveGame → both back on the sandbox world and able to build -----------------
  console.log('[8] leaveGame → sandbox');
  await pageA.evaluate(() => window.__mc.leaveGame());
  for (const [page, label] of [[pageA, 'A'], [pageB, 'B']]) {
    await waitFor(
      page,
      () => window.__mc.mode === 'sandbox' && window.__mc.bw === null,
      10_000,
      `${label} back in sandbox`,
    );
  }
  const sandboxRestored = await pageB.evaluate(() => ({
    island: window.__mc.world.getBlock(64, 30, 64),
    midVoid: window.__mc.world.getBlock(128, 20, 64),
  }));
  check(
    'sandbox world restored on both clients',
    sandboxRestored.island === canary.island && sandboxRestored.midVoid === canary.midVoid,
    `island=${sandboxRestored.island} (want ${canary.island}) void=${sandboxRestored.midVoid} (want ${canary.midVoid})`,
  );
  // B can still place blocks in the sandbox (the server took its edit again).
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
  check('sandbox building still works after the match', placed, `placed=${placed}`);

  // 9. clean pages ----------------------------------------------------------------
  check('no page errors', errors.length === 0, errors.length ? errors.slice(0, 5).join(' | ') : 'none');

  finish('SMOKE-BEDWARS', errors);
} catch (error) {
  console.error(`SMOKE-BEDWARS FAILED: ${error.message}`);
  const tail = server?.logTail?.() ?? '';
  if (tail) console.error(`--- server log tail ---\n${tail}`);
  process.exitCode = 1;
} finally {
  await teardown({ browser, server, editsFile: EDITS_FILE });
}
