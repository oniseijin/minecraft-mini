// Mobs smoke (M5.3 Phase 1 + M5.4 Phase 2): passive foxes/boars/giraffes in
// sandbox, night zombies (chase/shove/burn). Builds the client to a THROWAWAY
// dist (npm run build:test → client/dist-test, served via MC_CLIENT_DIST — the
// live client/dist a family LAN session serves is never rebuilt), boots the
// game server on PORT (default 8097 — never the user's :6881 or :5173):
//   DAY SERVER (default phase): join → mobs snapshot with 7–8 entities
//   (3 fox + 3 boar + 1–2 giraffe); spawn rules (dry land, ≤80, ≥16 apart);
//   punch a fox to death + respawn; giraffe punch (hp 14 → 12 + panic);
//   party clears mobs / sandbox returns them.
//   NIGHT SERVER (MC_MOB_FORCE_NIGHT): zombies spawn (≤2, 16–32 out), close
//   distance toward an idle player, shove on contact (__mc.shoves + velocity
//   kick), a punched zombie dies without respawning.
//   DAY SERVER again (MC_MOB_FORCE_DAY): zombies burned away, passives remain.
//   DEFAULT PORT: `npm start` with no PORT env serves :6881 (skipped politely
//   if something — likely the family's real server — already holds it).
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

async function startServer(extraEnv = {}) {
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
      ...extraEnv,
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

const npmCmd = () => (process.platform === 'win32' ? 'npm.cmd' : 'npm');

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

  // 1. population arrives and CONVERGES (spawns stream in over ~1–2 s) ---------
  console.log('[1] mob population');
  const kinds = await (async () => {
    const t0 = Date.now();
    let lastTotal = -1;
    while (Date.now() - t0 < 15_000) {
      const counts = await page.evaluate(() => {
        const counts = { fox: 0, boar: 0, giraffe: 0, zombie: 0 };
        for (const mob of window.__mc.mobs.values()) counts[mob.kind] = (counts[mob.kind] ?? 0) + 1;
        counts.total = window.__mc.mobs.size;
        return counts;
      });
      const settled = counts.fox === 3 && counts.boar === 3
        && (counts.giraffe === 1 || counts.giraffe === 2) && counts.zombie === 0;
      if (settled && lastTotal === counts.total) return counts; // stable across two reads
      lastTotal = counts.total;
      await sleep(700);
    }
    return null;
  })();
  check(
    'mobs converge to 3 fox + 3 boar + 1–2 giraffe',
    kinds !== null,
    kinds ? JSON.stringify(kinds) : 'population never settled',
  );
  if (!kinds) throw new Error('population did not converge');
  const expectedTotal = kinds.total; // 7 or 8 depending on this boot's giraffe roll

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
    spawnRules.count === expectedTotal && spawnRules.problems.length === 0,
    spawnRules.problems.length ? spawnRules.problems.slice(0, 3).join(' | ') : `all ${spawnRules.count} clean`,
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
  const punchOnce = async (targetPage, id) => {
    const teleported = await targetPage.evaluate((mobId) => {
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
    const result = await targetPage.evaluate((mobId) => {
      const mc = window.__mc;
      const mob = mc.mobs.get(mobId);
      if (!mob) return { gone: true, hit: false };
      // Aim up the body — foxes are low, giraffes are 3.5 blocks tall; retry
      // several heights so intervening terrain can't eat the ray.
      let hit = false;
      for (const dy of [0.35, 1.2, 2.2, 0.1]) {
        mc.lookAt(mob.position.x, mob.position.y + dy, mob.position.z);
        if (mc.tryAttack()) { hit = true; break; }
      }
      return { gone: false, hit };
    }, id);
    if (result.gone) return { gone: true };
    await sleep(650); // 0.5 s server cooldown + the next ~5 Hz snapshot
    const after = await targetPage.evaluate((mobId) => {
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
    const r = await punchOnce(page, foxId);
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
    (total) => window.__mc.mobs.size === total,
    RESPAWN_MS + 8_000, // fixed 2.5 s timer + spawn search + snapshot slack
    'population restored',
    expectedTotal,
  ).catch(() => false);
  const kindsAfter = await page.evaluate(() => {
    const counts = { fox: 0, boar: 0, giraffe: 0 };
    for (const mob of window.__mc.mobs.values()) counts[mob.kind] = (counts[mob.kind] ?? 0) + 1;
    return counts;
  });
  check(`respawn within ${RESPAWN_MS} ms (+slack)`, respawned && kindsAfter.fox === 3, JSON.stringify(kindsAfter));

  // 4b. giraffe: one punch, hp 14 → 12, and it panics (moves off) ----------------
  console.log('[4b] giraffe punch');
  const giraffeId = await page.evaluate(() => [...window.__mc.mobs.values()].find((m) => m.kind === 'giraffe')?.id ?? null);
  check('found a giraffe', giraffeId !== null, `id=${giraffeId}`);
  if (giraffeId !== null) {
    const giraffePos = await page.evaluate((id) => {
      const m = window.__mc.mobs.get(id);
      return m ? [m.position.x, m.position.z] : null;
    }, giraffeId);
    const gPunch = await punchOnce(page, giraffeId);
    await sleep(3_500); // panic window
    const giraffeAfter = await page.evaluate((id) => {
      const m = window.__mc.mobs.get(id);
      return m ? { hp: m.hp, x: m.position.x, z: m.position.z } : null;
    }, giraffeId);
    const fled = giraffeAfter && giraffePos
      ? Math.hypot(giraffeAfter.x - giraffePos[0], giraffeAfter.z - giraffePos[1]) > 2
      : false;
    check('giraffe hp 14 → 12 + panic-flee on punch', gPunch.hit && giraffeAfter?.hp === 12 && fled,
      `hit=${gPunch.hit} hp=${giraffeAfter?.hp} fled=${fled}`);
  }

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
    (total) => window.__mc.mobs.size === total,
    8_000,
    'mobs return after sandbox',
    expectedTotal,
  ).catch(() => false);
  check('back to sandbox: mobs simulated + broadcast again', returned, `size=${await page.evaluate(() => window.__mc.mobs.size)}`);

  check('no page errors (day phase)', errors.length === 0, errors.length ? errors.slice(0, 5).join(' | ') : 'none');

  // 6. NIGHT: zombies spawn, chase, shove ----------------------------------------
  console.log('[6] night zombies');
  await stopServer();
  await page.close();
  const nightPage = await browser.newPage({ viewport: { width: 1024, height: 640 } });
  const nightErrors = [];
  watchErrors(nightPage, nightErrors);
  await startServer({ MC_MOB_FORCE_NIGHT: '1' });
  await nightPage.goto(BASE, { waitUntil: 'domcontentloaded' });
  await nightPage.waitForFunction(() => window.__mc !== undefined && window.__mc.net.mode === 'online', null, { timeout: 60_000 });
  const zombies = await (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 12_000) {
      const found = await nightPage.evaluate(
        () => [...window.__mc.mobs.values()].filter((m) => m.kind === 'zombie')
          .map((m) => ({ id: m.id, x: m.position.x, y: m.position.y, z: m.position.z })),
      );
      if (found.length >= 1) return found;
      await sleep(200);
    }
    return [];
  })();
  check(`zombies spawned at night (${zombies.length} ≤ 2)`, zombies.length >= 1 && zombies.length <= 2, JSON.stringify(zombies.map((z) => z.id)));

  if (zombies.length >= 1) {
    const z = zombies[0];
    // Chase: idle player — the zombie must close horizontal distance within ~6 s.
    const meBefore = await nightPage.evaluate(() => {
      const p = window.__mc.player.pos;
      return { x: p.x, z: p.z };
    });
    const distBefore = Math.hypot(z.x - meBefore.x, z.z - meBefore.z);
    await sleep(6_000);
    const chase = await nightPage.evaluate((zid) => {
      const m = window.__mc.mobs.get(zid);
      const p = window.__mc.player.pos;
      return m ? { d: Math.hypot(m.position.x - p.x, m.position.z - p.z), gone: false } : { d: -1, gone: true };
    }, z.id);
    check('zombie chases (distance decreased)', !chase.gone && chase.d < distBefore, `before=${distBefore.toFixed(1)} after=${chase.d.toFixed(1)}`);

    // Shove: stand still next to the zombie; expect __mc.shoves + a velocity kick.
    const shovesBefore = await nightPage.evaluate(() => window.__mc.shoves.length);
    await nightPage.evaluate((zid) => {
      const m = window.__mc.mobs.get(zid);
      if (m) {
        window.__mc.player.teleport(m.position.x + 0.8, m.position.y + 0.5, m.position.z);
        window.__mc.player.vel.set(0, 0, 0);
      }
    }, z.id);
    const shoveSeen = await (async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 8_000) {
        const n = await nightPage.evaluate(() => window.__mc.shoves.length);
        if (n > shovesBefore) return true;
        await sleep(150);
      }
      return false;
    })();
    check('zombie shoved the player (knockback event)', shoveSeen, `shoves=${await nightPage.evaluate(() => window.__mc.shoves.length)}`);

    // Punch the zombie down (hp 10 = 5 hits) → dead, and NO respawn that night.
    let zDied = false;
    let zHits = 0;
    for (let attempt = 0; attempt < 16 && !zDied; attempt++) {
      const r = await punchOnce(nightPage, z.id);
      if (r.gone) { zDied = true; break; }
      if (r.hit) zHits++;
      if (r.hp === null || r.hp <= 0) zDied = true;
    }
    await sleep(4_000); // long enough that a bogus respawn would have shown
    const zAfter = await nightPage.evaluate((zid) => ({
      dead: window.__mc.mobDieds.some((d) => d.id === zid),
      stillThere: [...window.__mc.mobs.values()].some((m) => m.id === zid),
    }), z.id);
    check('zombie punched down (hp 10) with no night respawn', zDied && zAfter.dead && !zAfter.stillThere,
      `hits=${zHits} dead=${zAfter.dead} stillThere=${zAfter.stillThere}`);
  }
  check('no page errors (night phase)', nightErrors.length === 0, nightErrors.length ? nightErrors.slice(0, 5).join(' | ') : 'none');

  // 7. DAY again: zombies burn away, passives remain ------------------------------
  console.log('[7] dawn burn');
  await stopServer();
  await nightPage.close();
  await startServer({ MC_MOB_FORCE_DAY: '1' });
  const dayPage = await browser.newPage({ viewport: { width: 1024, height: 640 } });
  const dayErrors = [];
  watchErrors(dayPage, dayErrors);
  await dayPage.goto(BASE, { waitUntil: 'domcontentloaded' });
  await dayPage.waitForFunction(() => window.__mc !== undefined && window.__mc.net.mode === 'online', null, { timeout: 60_000 });
  await sleep(6_000); // dawn burn (≤5 s) + snapshot
  const dayKinds = await dayPage.evaluate(() => {
    const counts = { fox: 0, boar: 0, giraffe: 0, zombie: 0 };
    for (const mob of window.__mc.mobs.values()) counts[mob.kind] = (counts[mob.kind] ?? 0) + 1;
    return counts;
  });
  check('day: zombies burned away, passives remain',
    dayKinds.zombie === 0 && dayKinds.fox === 3 && dayKinds.boar === 3, JSON.stringify(dayKinds));
  check('no page errors (dawn phase)', dayErrors.length === 0, dayErrors.length ? dayErrors.slice(0, 5).join(' | ') : 'none');
  await dayPage.close();

  // 8. Default port 6881 -----------------------------------------------------------
  console.log('[8] default port');
  await stopServer();
  const port6881Free = await fetch('http://localhost:6881/healthz', { signal: AbortSignal.timeout(800) }).then(() => false, () => true);
  if (port6881Free) {
    const defaultPort = spawn(npmCmd(), ['start'], {
      cwd: root,
      env: { ...process.env, MC_EDITS_FILE: EDITS_FILE, MC_CLIENT_DIST: 'client/dist-test' }, // NO PORT
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    defaultPort.stdout.resume();
    defaultPort.stderr.resume();
    let on6881 = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 12_000 && !on6881) {
      try {
        const res = await fetch('http://localhost:6881/healthz', { signal: AbortSignal.timeout(800) });
        on6881 = res.ok;
      } catch { /* not up yet */ }
      await sleep(200);
    }
    check('`npm start` without PORT serves :6881 by default', on6881, on6881 ? 'healthz ok on 6881' : 'no answer on 6881');
    try { process.kill(-defaultPort.pid, 'SIGTERM'); } catch { /* gone */ }
    await sleep(800);
    try { process.kill(-defaultPort.pid, 'SIGKILL'); } catch { /* gone */ }
  } else {
    console.log('  SKIP  `npm start` default-port check — :6881 is already in use (the live family server?)');
  }

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
