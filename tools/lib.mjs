// Shared harness for the tools/smoke-*.mjs suites (refactoring plan Phase 1b).
//
// Every suite follows the same contract, implemented here once:
//   - build the client to client/dist-test via `npm run build:test` (the live
//     client/dist a family LAN session serves is NEVER rebuilt; SKIP_BUILD=1
//     reuses the last build),
//   - precheck the port, then boot its own game server (isolated 809x port —
//     never :6881 prod, never :5173) with MC_EDITS_FILE + MC_CLIENT_DIST env,
//     detached process group, ring-buffered stdout/stderr, healthz poll ≤15 s,
//   - drive headless chrome (swiftshader flags) through the real UI paths via
//     the __mc hooks, collecting pageerror/console errors with the expected
//     ws-reconnect noise filtered out,
//   - tear everything down in a finally (browser.close → server stop → edits
//     file removed — see teardown()) and print `SMOKE-<NAME> PASSED/FAILED:
//     n check(s)` with process.exitCode = 1 on any failure.
//
// Ports/edits paths/env overrides/scenario steps stay in each script; the
// machinery above lives here so the suites are just scenario + assertions.
//
// The flaky window: after a client-side teleport/move the server only learns
// the new position via the 20 Hz movement relay, so a server-side check that
// runs immediately can see stale standings/reach/proximity and flake. Those
// sleeps are named constants below — one knob per concept, bump here when CI
// contends for CPU.
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MOVE_RELAY_MS = 450; // teleport/move → server-side position check (standings, reach, shop pad)
export const RESPAWN_RELAY_MS = 300; // respawn → new position relayed before re-engaging
export const ATTACK_SPACING_MS = 350; // move relay + 0.5 s attack cooldown spacing between attack attempts

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Path under tools/smoke-out/ — the isolated edits/log area for smoke runs. */
export const smokeOut = (name) => path.join(ROOT, 'tools', 'smoke-out', name);

export const npmCmd = () => (process.platform === 'win32' ? 'npm.cmd' : 'npm');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function healthz(base) {
  try {
    const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** Result collector + the `  PASS/FAIL  name — detail` printer + summary. */
export function createChecks() {
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
    return ok;
  };
  /** Prints `SMOKE-<NAME> PASSED|FAILED: n check(s)`; exit 1 on failed checks or page errors. */
  const finish = (label, errors = []) => {
    const failed = results.filter((r) => !r.ok);
    console.log(failed.length === 0 ? `\n${label} PASSED` : `\n${label} FAILED: ${failed.length} check(s)`);
    if (failed.length > 0 || errors.length > 0) process.exitCode = 1;
    return failed.length === 0 && errors.length === 0;
  };
  return { results, check, finish };
}

/**
 * Builds the client to client/dist-test (never the live client/dist).
 * `suite` optionally tags the log lines (`[build:solo] …`). SKIP_BUILD=1
 * reuses the last build; a failed build throws 'client build failed'.
 */
export function buildClient(suite = '') {
  const tag = suite ? `:${suite}` : '';
  if (process.env.SKIP_BUILD === '1') {
    console.log(`[build${tag}] skipped (SKIP_BUILD=1)`);
    return;
  }
  console.log(`[build${tag}] vite build → client/dist-test (live client/dist untouched)…`);
  const build = spawnSync(npmCmd(), ['run', 'build:test'], { cwd: ROOT, stdio: 'inherit' });
  if (build.status !== 0) throw new Error('client build failed');
}

const BROWSER_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'];

/** Headless chrome with the swiftshader flags every smoke suite runs under. */
export async function launch() {
  return chromium.launch({ channel: 'chrome', headless: true, args: BROWSER_ARGS });
}

/**
 * Collects pageerror/console-error text into `errors`, ignoring the expected
 * "WebSocket … /ws … failed" noise (offline-fallback probes; also expected
 * while the server is down mid-suite). `label` prefixes entries ("A pageerror: …")
 * so multi-client suites can attribute them.
 */
export function watchErrors(page, errors, label = '') {
  const ignore = (text) => /WebSocket connection to .*\/ws.* failed/i.test(text);
  const tag = label ? `${label} ` : '';
  page.on('pageerror', (e) => { if (!ignore(e.message)) errors.push(`${tag}pageerror: ${e.message}`); });
  page.on('console', (m) => { if (m.type() === 'error' && !ignore(m.text())) errors.push(`${tag}console: ${m.text()}`); });
}

/** Polls `fn` (page.evaluate) every 120 ms until truthy, else throws. */
export async function waitFor(page, fn, timeoutMs, label, arg = null) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await page.evaluate(fn, arg)) return true;
    await sleep(120);
  }
  throw new Error(`${label} not reached within ${timeoutMs} ms`);
}

/**
 * New page on `browser` (launches one when omitted) with the standard smoke
 * viewport, error watching, and boot wait: goto `base`, `__mc` defined (60 s),
 * then `net.mode === 'online'` (15 s) unless `wait: 'boot'`. Returns
 * { browser, page, errors } — pass a shared `errors` array when driving
 * several pages.
 */
export async function openPage({ base, browser = null, errors = [], label = '', viewport = { width: 1024, height: 640 }, wait = 'online' } = {}) {
  if (!browser) browser = await launch();
  const page = await browser.newPage({ viewport });
  watchErrors(page, errors, label);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__mc !== undefined, null, { timeout: 60_000 });
  if (wait === 'online') {
    await page.waitForFunction(() => window.__mc?.net?.mode === 'online', null, { timeout: 15_000 });
  }
  return { browser, page, errors };
}

/** Precheck: refuse to boot if something already listens on the port. */
export async function ensurePortFree(base, port, hint = '') {
  if ((await healthz(base)) !== null) {
    throw new Error(`something is already listening on :${port} — stop it first${hint}`);
  }
}

/**
 * Spawns `npm start` at the repo root with the isolated-dist env (PORT,
 * MC_CLIENT_DIST=client/dist-test, MC_EDITS_FILE) and waits ≤15 s for
 * /healthz to report ok. Stages the edits file first (stale one removed,
 * parent dir created). `extraEnv` layers per-suite server env
 * (MC_MOB_FORCE_NIGHT, PARTY_BOMB_RATE, …); `logCap` bounds the stdout/stderr
 * ring buffer (default 30k chars, keeping the newest half).
 *
 * Returns a handle: { child, port, base, health, logTail(n = 3000), stop() }.
 * `health` is the boot-time /healthz payload (e.g. smoke-net reads .edits).
 * On boot failure the child is stopped before throwing (log embedded in the
 * error), so no orphan survives a failed boot.
 */
export async function startServer({ port, editsFile, extraEnv = {}, logCap = 30_000 } = {}) {
  const base = `http://localhost:${port}`;
  const handle = { child: null, port, base, health: null, logTail: () => '', stop: () => stopServer(handle) };
  if (editsFile) {
    rmSync(editsFile, { force: true });
    mkdirSync(path.dirname(editsFile), { recursive: true });
  }
  const env = { ...process.env, PORT: String(port), MC_CLIENT_DIST: 'client/dist-test', ...extraEnv };
  if (editsFile) env.MC_EDITS_FILE = editsFile;
  let serverLog = '';
  handle.logTail = (n = 3000) => serverLog.slice(-n);
  const child = spawn(npmCmd(), ['start'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  handle.child = child;
  for (const stream of ['stdout', 'stderr']) {
    child[stream].setEncoding('utf8');
    child[stream].on('data', (chunk) => {
      serverLog += chunk;
      if (serverLog.length > logCap) serverLog = serverLog.slice(-Math.floor(logCap / 2));
    });
  }
  const t0 = Date.now();
  while (Date.now() - t0 < 15_000) {
    const health = await healthz(base);
    if (health?.ok) {
      handle.health = health;
      return handle;
    }
    await sleep(200);
  }
  await stopServer(handle).catch(() => undefined);
  throw new Error(`server did not become healthy; log:\n${serverLog}`);
}

/**
 * SIGTERM to the detached process group, escalate to SIGKILL after 5 s, then
 * confirm the port actually freed (≤5 s) — throws 'server port still serving
 * after SIGTERM' if it didn't. Safe to call twice. withServer/teardown
 * swallow its error; mid-suite restarts (smoke-net) let it throw so a stuck
 * port fails loudly.
 */
export async function stopServer(handle) {
  const child = handle?.child;
  if (!child) return;
  handle.child = null;
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
    if ((await healthz(handle.base)) === null) return;
    await sleep(150);
  }
  throw new Error('server port still serving after SIGTERM');
}

/** Boot → fn(handle) → guaranteed stop in finally, for single-cycle suites. */
export async function withServer(options, fn) {
  const server = await startServer(options);
  try {
    return await fn(server);
  } finally {
    await stopServer(server).catch(() => undefined);
  }
}

/** The standard finally: browser → server → edits file, all errors swallowed. */
export async function teardown({ browser, server, editsFile } = {}) {
  if (browser) await browser.close().catch(() => undefined);
  if (server) await stopServer(server).catch(() => undefined);
  if (editsFile) rmSync(editsFile, { force: true });
}
