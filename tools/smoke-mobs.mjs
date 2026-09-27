// Mobs smoke (protocol v6, M5.3 Phase 1): passive foxes + boars in sandbox.
// Builds the client to a THROWAWAY dist (npm run build:test → client/dist-test,
// served via MC_CLIENT_DIST — the live client/dist a family LAN session serves
// is never rebuilt), boots the game server on PORT (default 8097 — never the
// user's :8080 or the :5173 dev server) with MC_MOB_RESPAWN_MS=2500 for a fast
// respawn check, then drives ONE headless chrome page through:
//   - join → within 5 s a `mobs` snapshot with 6 entities (3 fox + 3 boar)
//   - spawn rules: on dry land (top block grass/dirt/sand, y within 2 of
//     highestBlock+1), within 80 of the player, ≥16 apart at spawn
//   - __mc.mobs shows the renderer entities; walk swing / interp come free
//   - teleport next to a fox + fire the SAME left-click attack path
//     (__mc.tryAttack) → hp drops in the next snapshot (6 → 4 → …)
//   - kill it (3 fist hits) → mobDied {id,kind,at} + entity removed →
//     respawn within MC_MOB_RESPAWN_MS (+ slack) → 6 entities again
//   - solo-start Block Party → mobs cleared client-side; back to sandbox →
//     mobs return (server paused sim + forced a fresh snapshot)
//   - no page errors
//
// Usage: PORT=8097 node tools/smoke-mobs.mjs   (SKIP_BUILD=1 reuses the build)
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const PORT = Number(process.env.PORT ?? 8097);
const BASE = `http://localhost:${PORT}`;
const EDITS_FILE = path.join(root, 'tools', 'smoke-out', 'smoke-mobs-edits.json');
const RESPAWN_MS = 2500; // matches the MC_MOB_RESPAWN_MS passed to the server

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
    env: {
      ...process.env,
      PORT: String(PORT),
      MC_EDITS_FILE: EDITS_FILE,
      MC_CLIENT_DIST: 'client/dist-test',
      MC_MOB_RESPAWN_MS: String(RESPAWN_MS),
    },
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

function watchErrors(page, errors) {
  const ignore = (text) => /WebSocket connection to .*\/ws.* failed/i.test(text);
  page.on('pageerror', (e) => { if (!ignore(e.message)) errors.push(`pageerror: ${e.message}`); });
  page.on('console', (m) => { if (m.type() === 'error' && !ignore(m.text())) errors.push(`console: ${m.text()}`); });
}

const waitFor = async (page, fn, timeoutMs, label, arg = null) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await page.evaluate(fn, arg)) return true;
    await sleep(120);
  }
  throw new Error(`${label} not reached within ${timeoutMs} ms`);
};

let browser = null;
try {
  // 0. build + boot ------------------------------------------------------------
  if (process.env.SKIP_BUILD !== '1') {
    console.log('[build] vite build → client/dist-test (live client/dist untouched)…');
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const build = spawnSync(npm, ['run', 'build:test'], { cwd: root, stdio: 'inherit' });
    if (build.status !== 0) throw new Error('client build failed');
  } else {
    console.log('[build] skipped (SKIP_BUILD=1)');
  }

  rmSync(EDITS_FILE, { force: true });
  if ((await healthz()) !== null) {
    throw new Error(`something is already listening on :${PORT} — stop it first (or pass PORT=…)`);
  }
  mkdirSync(path.dirname(EDITS_FILE), { recursive: true });
  console.log('[server] booting game server…');
  await startServer();

  browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
  });
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
  watchErrors(page, errors);

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__mc !== undefined, null, { timeout: 60_000 });
  await page.waitForFunction(() => window.__mc.net.mode === 'online', null, { timeout: 15_000 });

  // 1. population arrives within 5 s of joining ---------------------------------
  console.log('[1] mob population');
  await waitFor(page, () => window.__mc.mobs !== undefined && window.__mc.mobs.size === 6, 5_000, '6 renderer entities');
  const kinds = await page.evaluate(() => {
    const counts = { fox: 0, boar: 0 };
    for (const mob of window.__mc.mobs.values()) counts[mob.kind]++;
    return counts;
  });
  check('6 mobs within 5 s (3 fox + 3 boar)', kinds.fox === 3 && kinds.boar === 3, JSON.stringify(kinds));

  // 2. spawn rules: dry land, near the player, spread out -------------------------
  console.log('[2] spawn rules');
  const spawnRules = await page.evaluate(() => {
    const mc = window.__mc;
    const me = mc.net.players.find((p) => p.id === mc.net.id) ?? { x: 128.5, y: 40, z: 128.5 };
    const problems = [];
    const mobs = [...mc.mobs.values()].map((m) => ({
      id: m.id, kind: m.kind, x: m.position.x, y: m.position.y, z: m.position.z,
    }));
    for (const mob of mobs) {
      const bx = Math.floor(mob.x);
      const bz = Math.floor(mob.z);
      const top = mc.world.highestBlock(bx, bz);
      const topBlock = mc.world.getBlock(bx, top, bz);
      if (![1, 2, 4].includes(topBlock)) problems.push(`mob ${mob.id} stands on block ${topBlock}`);
      if (Math.abs(mob.y - (top + 1)) > 2) problems.push(`mob ${mob.id} y ${mob.y} vs ground ${top + 1}`);
      const d = Math.hypot(mob.x - me.x, mob.z - me.z);
      if (d > 80.5) problems.push(`mob ${mob.id} is ${d.toFixed(0)} from the player (>80)`);
    }
    for (let i = 0; i < mobs.length; i++) {
      for (let j = i + 1; j < mobs.length; j++) {
        const d = Math.hypot(mobs[i].x - mobs[j].x, mobs[i].z - mobs[j].z);
        if (d < 15) problems.push(`mobs ${mobs[i].id}/${mobs[j].id} only ${d.toFixed(1)} apart at spawn`);
      }
    }
    return { count: mobs.length, problems };
  });
  check(
    'mobs on dry land, y within 2 of highestBlock+1, ≤80 from player, ≥16 apart',
    spawnRules.count === 6 && spawnRules.problems.length === 0,
    spawnRules.problems.length ? spawnRules.problems.slice(0, 3).join(' | ') : 'all 6 clean',
  );

  // 3. punch a fox through the normal left-click attack path ---------------------
  console.log('[3] punch + kill a fox');
  const foxId = await page.evaluate(() => [...window.__mc.mobs.values()].find((m) => m.kind === 'fox')?.id ?? null);
  check('found a fox to punch', foxId !== null, `id=${foxId}`);

  /**
   * One attack attempt: stand next to the mob (on a spot at its own ground
   * level, so the camera never ends up buried in a slope), aim at its body,
   * fire tryAttack; retry at feet level once before giving up.
   */
  const punchOnce = async (id) => {
    const teleported = await page.evaluate((mobId) => {
      const mc = window.__mc;
      const mob = mc.mobs.get(mobId);
      if (!mob) return { gone: true };
      const offsets = [[1.2, 0], [-1.2, 0], [0, 1.2], [0, -1.2], [1.2, 1.2], [-1.2, -1.2], [1.2, -1.2], [-1.2, 1.2]];
      const groundY = Math.floor(mob.position.y);
      let spot = null;
      for (const [dx, dz] of offsets) {
        const x = mob.position.x + dx;
        const z = mob.position.z + dz;
        const g = mc.world.highestBlock(Math.floor(x), Math.floor(z)) + 1;
        if (Math.abs(g - groundY) <= 1) { spot = { x, y: g + 0.02, z }; break; }
      }
      if (!spot) spot = { x: mob.position.x + 1.2, y: mob.position.y + 1.5, z: mob.position.z };
      mc.player.teleport(spot.x, spot.y, spot.z);
      mc.player.vel.set(0, 0, 0);
      return { gone: false };
    }, id);
    if (teleported.gone) return { gone: true };
    await sleep(300); // movement relay (20 Hz) so the server's range check sees us
    const result = await page.evaluate((mobId) => {
      const mc = window.__mc;
      const mob = mc.mobs.get(mobId);
      if (!mob) return { gone: true, hit: false };
      // Aim at the rendered body center — the same box the ray tests.
      mc.lookAt(mob.position.x, mob.position.y + 0.35, mob.position.z);
      let hit = mc.tryAttack();
      if (!hit) {
        mc.lookAt(mob.position.x, mob.position.y + 0.1, mob.position.z); // feet-level retry
        hit = mc.tryAttack();
      }
      return { gone: false, hit };
    }, id);
    if (result.gone) return { gone: true };
    await sleep(650); // 0.5 s server cooldown + the next ~5 Hz snapshot
    const after = await page.evaluate((mobId) => {
      const mc = window.__mc;
      const mob = mc.mobs.get(mobId);
      return { hp: mob ? mob.hp : null, deaths: mc.mobDieds.length };
    }, id);
    return { gone: after.hp === null, hit: result.hit, hp: after.hp };
  };

  let hpSeen = null;
  let died = false;
  let hits = 0;
  for (let attempt = 0; attempt < 14 && !died; attempt++) {
    const r = await punchOnce(foxId);
    if (r.gone) { died = true; break; }
    if (r.hit) hits++;
    hpSeen = r.hp;
    if (r.hp === null || r.hp <= 0) died = true;
  }
  const death = await page.evaluate(
    (id) => window.__mc.mobDieds.find((d) => d.id === id) ?? null,
    foxId,
  );
  check(
    'fox hp dropped per punch through tryAttack (6 → 4 → 2 → dead)',
    hpSeen !== null && hits >= 2 && (death !== null || died),
    `hits=${hits} lastHp=${JSON.stringify(hpSeen)} death=${JSON.stringify(death)}`,
  );
  const foxGone = await waitFor(
    page,
    (id) => !window.__mc.mobs.has(id),
    3_000,
    'dead fox removed from renderer',
    foxId,
  ).catch(() => false);
  check('mobDied broadcast + entity removed', foxGone && death !== null, `gone=${foxGone} at=${JSON.stringify(death?.at ?? null)}`);

  // 4. respawn within MC_MOB_RESPAWN_MS ------------------------------------------
  console.log('[4] respawn');
  const respawned = await waitFor(
    page,
    () => window.__mc.mobs.size === 6,
    RESPAWN_MS + 6_000, // fixed 2.5 s timer + spawn search + snapshot slack
    'population back to 6',
  ).catch(() => false);
  const kindsAfter = await page.evaluate(() => {
    const counts = { fox: 0, boar: 0 };
    for (const mob of window.__mc.mobs.values()) counts[mob.kind]++;
    return counts;
  });
  check(`respawn within ${RESPAWN_MS} ms (+slack)`, respawned && kindsAfter.fox === 3, JSON.stringify(kindsAfter));

  // 5. mode pause: party clears mobs; sandbox brings them back --------------------
  console.log('[5] mode pause');
  await page.evaluate(() => window.__mc.startParty()); // solo start (1 player online)
  await waitFor(page, () => window.__mc.mode === 'party', 15_000, 'modeChanged(party)');
  await waitFor(page, () => window.__mc.worldRenderer.pendingCount === 0, 60_000, 'party world built');
  await sleep(1_000); // any late in-flight mobs snapshot must not repopulate
  const cleared = await page.evaluate(() => ({ size: window.__mc.mobs.size, mode: window.__mc.mode }));
  check('party mode: mobs cleared client-side', cleared.size === 0, JSON.stringify(cleared));

  await page.evaluate(() => window.__mc.leaveGame());
  await waitFor(page, () => window.__mc.mode === 'sandbox', 10_000, 'back in sandbox');
  const returned = await waitFor(
    page,
    () => window.__mc.mobs.size === 6,
    6_000,
    'mobs return after sandbox',
  ).catch(() => false);
  check('back to sandbox: mobs simulated + broadcast again', returned, `size=${await page.evaluate(() => window.__mc.mobs.size)}`);

  check('no page errors', errors.length === 0, errors.length ? errors.slice(0, 5).join(' | ') : 'none');

  const failed = results.filter((r) => !r.ok);
  console.log(failed.length === 0 ? '\nSMOKE-MOBS PASSED' : `\nSMOKE-MOBS FAILED: ${failed.length} check(s)`);
  if (failed.length > 0 || errors.length > 0) process.exitCode = 1;
} catch (error) {
  console.error(`SMOKE-MOBS FAILED: ${error.message}`);
  if (serverLog) console.error(`--- server log tail ---\n${serverLog.slice(-3000)}`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => undefined);
  await stopServer().catch(() => undefined);
  rmSync(EDITS_FILE, { force: true });
}
