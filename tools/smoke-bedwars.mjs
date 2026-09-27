// M4 gate: two-client BedWars 1v1 integration test for the minecraft-mini netcode.
//
// Builds the client, boots the game server on :8080 (edit file isolated under
// tools/smoke-out/), then drives TWO headless chrome pages through a full
// match, all via the same client paths the UI uses (__mc hooks):
//   - startGame via the menu-button path → both clients swap to the arena
//     (grass islands where the sandbox has water; void where it has stone)
//   - countdown → playing phase; iron generators accrue (5 Hz gameState)
//   - shop buy near the island pad deducts currency and grants wool ×16
//   - A attacks B (the exact left-click raycast path) → hp drops → death →
//     respawn at the team spawn while the bed stands
//   - A breaks B's bed (client edit near the bed, server team rule) →
//     bedBroken on both clients
//   - final kill → eliminated → matchEnd (winner A) on both clients
//   - leaveGame → both clients back on the sandbox world and able to build
//
// Usage: node tools/smoke-bedwars.mjs   (SKIP_BUILD=1 to reuse the last build)
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const PORT = Number(process.env.PORT ?? 8080);
const BASE = `http://localhost:${PORT}`;
const EDITS_FILE = path.join(root, 'tools', 'smoke-out', 'smoke-bedwars-edits.json');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function healthz() {
  try {
    const res = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(1000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

let server = null;
let serverLog = '';

async function startServer() {
  serverLog = '';
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  server = spawn(npm, ['start'], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), MC_EDITS_FILE: EDITS_FILE },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  for (const stream of ['stdout', 'stderr']) {
    server[stream].setEncoding('utf8');
    server[stream].on('data', (chunk) => {
      serverLog += chunk;
      if (serverLog.length > 30_000) serverLog = serverLog.slice(-15_000);
    });
  }
  const t0 = Date.now();
  while (Date.now() - t0 < 15_000) {
    const health = await healthz();
    if (health?.ok) return health;
    await sleep(200);
  }
  throw new Error(`server did not become healthy; log:\n${serverLog}`);
}

async function stopServer() {
  if (!server) return;
  const child = server;
  server = null;
  const exited = new Promise((resolve) => child.on('exit', resolve));
  try {
    if (process.platform === 'win32') child.kill('SIGTERM');
    else process.kill(-child.pid, 'SIGTERM');
  } catch {
    // already gone
  }
  const timeout = new Promise((r) => setTimeout(r, 5000));
  await Promise.race([exited, timeout]);
  if (!child.exitCode && process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
  }
  const t0 = Date.now();
  while (Date.now() - t0 < 5000) {
    if ((await healthz()) === null) return;
    await sleep(150);
  }
  throw new Error('server port still serving after SIGTERM');
}

function watchErrors(page, label, errors) {
  const ignore = (text) => /WebSocket connection to .*\/ws.* failed/i.test(text);
  page.on('pageerror', (e) => { if (!ignore(e.message)) errors.push(`${label} pageerror: ${e.message}`); });
  page.on('console', (m) => { if (m.type() === 'error' && !ignore(m.text())) errors.push(`${label} console: ${m.text()}`); });
}

const GRASS = 1; // block ids — Node-side assertion values only
const AIR = 0;

let browser = null;
try {
  // 0. build + boot ------------------------------------------------------------
  if (process.env.SKIP_BUILD !== '1') {
    console.log('[build] vite build…');
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const build = spawnSync(npm, ['run', 'build'], { cwd: root, stdio: 'inherit' });
    if (build.status !== 0) throw new Error('client build failed');
  } else {
    console.log('[build] skipped (SKIP_BUILD=1)');
  }

  rmSync(EDITS_FILE, { force: true });
  if ((await healthz()) !== null) {
    throw new Error(`something is already listening on :${PORT} — stop it first`);
  }
  console.log('[server] booting game server…');
  await startServer();

  browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
  });
  const errors = [];
  const pageA = await browser.newPage({ viewport: { width: 1024, height: 640 } });
  const pageB = await browser.newPage({ viewport: { width: 1024, height: 640 } });
  watchErrors(pageA, 'A', errors);
  watchErrors(pageB, 'B', errors);

  const waitOnline = async (page, label) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => window.__mc !== undefined && window.__mc.net.mode === 'online',
      null,
      { timeout: 60_000 },
    );
  };
  const waitFor = async (page, fn, timeoutMs, label, arg = null) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (await page.evaluate(fn, arg)) return true;
      await sleep(120);
    }
    throw new Error(`${label} not reached within ${timeoutMs} ms`);
  };

  await waitOnline(pageA, 'A');
  await waitOnline(pageB, 'B');
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

  // 6. final kill → eliminated → matchEnd winner=A ---------------------------------
  console.log('[6] final kill + match end');
  const finalKilled = await attackLoop();
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
    'final kill → matchEnd with winner A on both clients',
    finalKilled && matchEndA && matchEndB,
    `killed=${finalKilled} stats=${JSON.stringify(stats)}`,
  );

  // 7. leaveGame → both back on the sandbox world and able to build -----------------
  console.log('[7] leaveGame → sandbox');
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

  // 8. clean pages ----------------------------------------------------------------
  check('no page errors', errors.length === 0, errors.length ? errors.slice(0, 5).join(' | ') : 'none');

  const failed = results.filter((r) => !r.ok);
  console.log(failed.length === 0 ? '\nSMOKE-BEDWARS PASSED' : `\nSMOKE-BEDWARS FAILED: ${failed.length} check(s)`);
  if (failed.length > 0 || errors.length > 0) process.exitCode = 1;
} catch (error) {
  console.error(`SMOKE-BEDWARS FAILED: ${error.message}`);
  if (serverLog) console.error(`--- server log tail ---\n${serverLog.slice(-3000)}`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => undefined);
  await stopServer().catch(() => undefined);
  rmSync(EDITS_FILE, { force: true });
}
