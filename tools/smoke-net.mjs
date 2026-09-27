// M3 gate: two-client LAN integration test for the minecraft-mini netcode.
//
// Builds the client, boots the game server on :8080 (edit file isolated under
// tools/smoke-out/), then drives TWO headless chrome pages against the served
// build and asserts the whole protocol loop:
//   - both come up in online mode with distinct player ids
//   - each sees the other's avatar
//   - A places a block → B's world has it within 2 s
//   - B teleports → A's avatar for B moves within ~1 s (roster relay)
//   - chat A → B is delivered
//   - server restart → the edit persisted (a fresh page sees it via welcome)
//
// Usage: node tools/smoke-net.mjs   (SKIP_BUILD=1 to reuse the last build)
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const PORT = Number(process.env.PORT ?? 8080);
const BASE = `http://localhost:${PORT}`;
const EDITS_FILE = path.join(root, 'tools', 'smoke-out', 'smoke-net-edits.json');

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
      if (serverLog.length > 20_000) serverLog = serverLog.slice(-10_000);
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
  // wait for the port to actually free up
  const t0 = Date.now();
  while (Date.now() - t0 < 5000) {
    if ((await healthz()) === null) return;
    await sleep(150);
  }
  throw new Error('server port still serving after SIGTERM');
}

function watchErrors(page, label, errors) {
  // Failed ws dials are expected while the server is down for the restart.
  const ignore = (text) => /WebSocket connection to .*\/ws.* failed/i.test(text);
  page.on('pageerror', (e) => { if (!ignore(e.message)) errors.push(`${label} pageerror: ${e.message}`); });
  page.on('console', (m) => { if (m.type() === 'error' && !ignore(m.text())) errors.push(`${label} console: ${m.text()}`); });
}

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
    try {
      await page.waitForFunction(
        () => window.__mc !== undefined && window.__mc.net.mode === 'online',
        null,
        { timeout: 60_000 },
      );
      return true;
    } catch {
      const status = await page.textContent('#overlay-status').catch(() => '?');
      throw new Error(`${label} never came online (status: ${status})`);
    }
  };

  // 1. join + identity ---------------------------------------------------------
  console.log('[1] join + roster');
  await waitOnline(pageA, 'A');
  await waitOnline(pageB, 'B');
  const idA = await pageA.evaluate(() => window.__mc.net.id);
  const idB = await pageB.evaluate(() => window.__mc.net.id);
  check('distinct player ids', Number.isInteger(idA) && Number.isInteger(idB) && idA !== idB, `A=${idA} B=${idB}`);
  let aSeesB = false;
  let bSeesA = false;
  const tRoster = Date.now();
  while (Date.now() - tRoster < 2000 && !(aSeesB && bSeesA)) {
    if (!aSeesB) aSeesB = await pageA.evaluate((id) => window.__mc.remotePlayers.has(id), idB);
    if (!bSeesA) bSeesA = await pageB.evaluate((id) => window.__mc.remotePlayers.has(id), idA);
    if (!aSeesB || !bSeesA) await sleep(100);
  }
  check('A sees B in remotePlayers', aSeesB, `remotePlayers(A)=${aSeesB}`);
  check('B sees A in remotePlayers', bSeesA, `remotePlayers(B)=${bSeesA}`);

  // 2. block edit A → B --------------------------------------------------------
  console.log('[2] block edit sync');
  const edit = await pageA.evaluate(() => {
    const mc = window.__mc;
    for (let x = 96; x < 140; x++) {
      const gy = mc.world.highestBlock(x, 128);
      if (gy > 0 && gy + 4 < 60) return { cell: [x, gy + 3, 128], feet: [x + 0.5, gy + 1, 128.5] };
    }
    return null;
  });
  if (!edit) throw new Error('no placeable cell found');
  await pageA.evaluate(({ feet }) => window.__mc.player.teleport(...feet), edit);
  await sleep(300); // one move tick so the server knows A's position
  const placed = await pageA.evaluate(({ cell }) => {
    const mc = window.__mc;
    return { ok: mc.tryPlace(...cell), id: mc.world.getBlock(...cell) };
  }, edit);
  check('A places a block (optimistic apply)', placed.ok && placed.id !== 0, `cell=${edit.cell} id=${placed.id}`);

  let bGotIt = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 2000) {
    const id = await pageB.evaluate(([x, y, z]) => window.__mc.world.getBlock(x, y, z), edit.cell);
    if (id === placed.id) { bGotIt = true; break; }
    await sleep(100);
  }
  check(`B's world has the block within 2 s`, bGotIt, `cell=${edit.cell} id=${placed.id}`);

  // 3. movement relay B → A ----------------------------------------------------
  console.log('[3] movement relay');
  const target = await pageB.evaluate(() => {
    const mc = window.__mc;
    const gy = mc.world.highestBlock(160, 140);
    return { feet: [160.5, gy + 1, 140.5], y: gy + 1 };
  });
  await pageB.evaluate(({ feet }) => window.__mc.player.teleport(...feet), target);
  let moved = null;
  const t1 = Date.now();
  while (Date.now() - t1 < 1500) {
    moved = await pageA.evaluate((id) => {
      const rp = window.__mc.remotePlayers.get(id);
      return rp ? { x: rp.position.x, y: rp.position.y, z: rp.position.z } : null;
    }, idB);
    if (moved && Math.hypot(moved.x - 160.5, moved.z - 140.5) < 2 && Math.abs(moved.y - target.y) < 2) break;
    await sleep(100);
  }
  check(
    "A's avatar for B tracks the teleport within ~1 s",
    !!moved && Math.hypot(moved.x - 160.5, moved.z - 140.5) < 2 && Math.abs(moved.y - target.y) < 2,
    `pos=${moved ? [moved.x.toFixed(2), moved.y.toFixed(2), moved.z.toFixed(2)].join(',') : 'none'}`,
  );

  // 4. chat A → B + keep-open input ------------------------------------------------
  console.log('[4] chat');
  const nameA = await pageB.evaluate((id) => window.__mc.remotePlayers.get(id)?.name ?? null, idA);
  await pageA.evaluate(() => window.__mc.openChat()); // chat input opens (test hook)
  await sleep(150);
  await pageA.keyboard.type('greetings from A');
  await pageA.keyboard.press('Enter'); // sends AND keeps the chat open
  let gotChat = false;
  const t2 = Date.now();
  while (Date.now() - t2 < 2000) {
    const found = await pageB.evaluate(
      ([from]) => window.__mc.chatHistory.some((m) => m.from === from && m.text === 'greetings from A'),
      [nameA],
    );
    if (found) { gotChat = true; break; }
    await sleep(100);
  }
  check(`chat A→B delivered`, gotChat, `from=${nameA}`);
  await sleep(150); // let A's own echo come back and render
  const chatState = await pageA.evaluate(() => ({
    open: !document.querySelector('#chat-box').classList.contains('hidden'),
    focused: document.activeElement === document.querySelector('#chat-input'),
    cleared: document.querySelector('#chat-input').value === '',
    history: [...document.querySelectorAll('#chat-log .msg')].map((n) => n.textContent ?? ''),
  }));
  check(
    'Enter keeps the chat open, focused and cleared',
    chatState.open && chatState.focused && chatState.cleared,
    `open=${chatState.open} focused=${chatState.focused} cleared=${chatState.cleared}`,
  );
  check(
    'open chat shows the history (own message rendered as "You:")',
    chatState.history.some((t) => t.includes('You:') && t.includes('greetings from A')),
    chatState.history.join(' | ') || 'empty',
  );
  await pageA.keyboard.press('Escape'); // closes the chat
  await sleep(150);
  const chatClosed = await pageA.evaluate(() => ({
    open: !document.querySelector('#chat-box').classList.contains('hidden'),
  }));
  check('Esc closes the chat', !chatClosed.open, `open=${chatClosed.open}`);
  await pageA.evaluate(() => window.__mc.openChat()); // reopening reveals the history
  await sleep(100);
  const chatReopened = await pageA.evaluate(() => ({
    open: !document.querySelector('#chat-box').classList.contains('hidden'),
    history: [...document.querySelectorAll('#chat-log .msg')].map((n) => n.textContent ?? ''),
  }));
  check(
    'reopening the chat reveals the history again',
    chatReopened.open && chatReopened.history.some((t) => t.includes('greetings from A')),
    `open=${chatReopened.open} lines=${chatReopened.history.length}`,
  );
  await pageA.keyboard.press('Escape'); // leave the test with chat closed

  // 5. persistence across a server restart --------------------------------------
  console.log('[5] persistence across restart');
  await stopServer();
  console.log('[server] restarting…');
  const health = await startServer();
  const pageC = await browser.newPage({ viewport: { width: 1024, height: 640 } });
  watchErrors(pageC, 'C', errors);
  await waitOnline(pageC, 'C');
  const persisted = await pageC.evaluate(([x, y, z]) => window.__mc.world.getBlock(x, y, z), edit.cell);
  check(
    'fresh page sees the edit after restart (welcome.edits)',
    persisted === placed.id,
    `cell=${edit.cell} id=${persisted} (server edits=${health.edits})`,
  );

  // 6. clean pages ----------------------------------------------------------------
  check('no page errors', errors.length === 0, errors.length ? errors.slice(0, 5).join(' | ') : 'none');

  const failed = results.filter((r) => !r.ok);
  console.log(failed.length === 0 ? '\nSMOKE-NET PASSED' : `\nSMOKE-NET FAILED: ${failed.length} check(s)`);
  if (failed.length > 0 || errors.length > 0) process.exitCode = 1;
} catch (error) {
  console.error(`SMOKE-NET FAILED: ${error.message}`);
  if (serverLog) console.error(`--- server log tail ---\n${serverLog.slice(-2000)}`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => undefined);
  await stopServer().catch(() => undefined);
  rmSync(EDITS_FILE, { force: true });
}
