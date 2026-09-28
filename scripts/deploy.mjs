#!/usr/bin/env node
/**
 * Production deployment for minecraft-mini (macOS, launchd).
 *
 * Layout (per ~/.local/opt convention):
 *   ~/.local/opt/minecraft-mini/releases/<tag>/   one pristine dir per git tag
 *   ~/.local/opt/minecraft-mini/current           symlink → the live release
 *   ~/.local/share/minecraft-mini/                PERSISTENT data (survives upgrades)
 *     world-edits.json                            the family's world (SaveFile v1)
 *     backups/world-edits-<timestamp>.json        pre-deploy snapshots (keep 10)
 *   ~/Library/LaunchAgents/local.minecraft-mini.plist
 *   ~/Library/Logs/minecraft-mini/server.log / server.err.log
 *
 * Continuity:
 *   - Data lives in the share dir, never inside a release; the plist pins
 *     MC_EDITS_FILE there.
 *   - Every deploy backs up the world, then validates its shape (SaveFile
 *     version + integer edit quads). Unknown future versions ABORT the deploy
 *     rather than risk silent corruption — this is the migration hook point.
 *   - First deploy ADOPTS the dev repo's server/data/world-edits.json if the
 *     share dir has no world yet (the family keeps playing where they left off).
 *   - Releases are pruned to the newest 3 → rollback is instant.
 *
 * Usage:
 *   node scripts/deploy.mjs <tag>        deploy a git tag and (re)start the service
 *   node scripts/deploy.mjs --status     live release, service state, health
 *   node scripts/deploy.mjs --stop       boot out the service (data untouched)
 *   node scripts/deploy.mjs --start      bootstrap the service
 *   node scripts/deploy.mjs --restart    kickstart
 *   node scripts/deploy.mjs --rollback <tag>  flip `current` to a kept release
 *   node scripts/deploy.mjs --uninstall  remove the service + plist (data + releases kept)
 */
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, statSync, rmSync, symlinkSync, unlinkSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = os.homedir();
const OPT = path.join(HOME, '.local/opt/minecraft-mini');
const RELEASES = path.join(OPT, 'releases');
const CURRENT = path.join(OPT, 'current');
const DATA = path.join(HOME, '.local/share/minecraft-mini');
const BACKUPS = path.join(DATA, 'backups');
const LOGDIR = path.join(HOME, 'Library/Logs/minecraft-mini');
const PLIST = path.join(HOME, 'Library/LaunchAgents/local.minecraft-mini.plist');
const LABEL = 'local.minecraft-mini';
const PORT = process.env.PORT ?? '6881';
const KEEP_RELEASES = 3;
const KEEP_BACKUPS = 10;
const SUPPORTED_SAVE_VERSION = 1;
const NODE_BIN = process.execPath; // absolute — launchd has no PATH

const run = (cmd, args, opts = {}) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts });
  } catch (err) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${err.stdout ?? ''}${err.stderr ?? err.message}`);
  }
};
const sh = (cmd, opts = {}) => {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts });
  } catch (err) {
    throw new Error(`shell failed: ${cmd}\n${err.stdout ?? ''}${err.stderr ?? err.message}`);
  }
};
const log = (s) => console.log(`[deploy] ${s}`);
const uid = process.getuid();

// --- data continuity ----------------------------------------------------------

function validateWorld(file) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`world file is not valid JSON (${file}): ${err.message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.edits)) {
    throw new Error(`world file has unexpected shape (${file}) — aborting rather than risk data loss`);
  }
  if (parsed.version !== SUPPORTED_SAVE_VERSION) {
    throw new Error(
      `world file version is ${parsed.version}, this deploy supports ${SUPPORTED_SAVE_VERSION} — ` +
      `a migration is required before deploying (see scripts/deploy.mjs, continuity section)`,
    );
  }
  let valid = 0;
  for (const entry of parsed.edits) {
    if (!Array.isArray(entry) || entry.length !== 4 || !entry.every((v) => Number.isInteger(v))) {
      throw new Error(`world file has a malformed edit entry (${file}): ${JSON.stringify(entry)}`);
    }
    valid++;
  }
  return valid;
}

function ensureData() {
  mkdirSync(DATA, { recursive: true });
  mkdirSync(BACKUPS, { recursive: true });
  const world = path.join(DATA, 'world-edits.json');
  if (!existsSync(world)) {
    const devWorld = path.join(ROOT, 'server/data/world-edits.json');
    if (existsSync(devWorld)) {
      const count = validateWorld(devWorld);
      copyFileSync(devWorld, world);
      log(`ADOPTED the dev repo's world (${count} edits) → ${world}`);
    } else {
      log('no existing world — the service will create a fresh one on first save');
      return;
    }
  }
  const count = validateWorld(world); // backup + validate on EVERY deploy
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  copyFileSync(world, path.join(BACKUPS, `world-edits-${stamp}.json`));
  const backups = readdirSync(BACKUPS).filter((f) => f.startsWith('world-edits-')).sort();
  for (const old of backups.slice(0, Math.max(0, backups.length - KEEP_BACKUPS))) {
    rmSync(path.join(BACKUPS, old), { force: true });
  }
  log(`world OK (version ${SUPPORTED_SAVE_VERSION}, ${count} edits) — backup saved`);
}

// --- plist --------------------------------------------------------------------

function plistXml(releaseDir) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const node = esc(NODE_BIN);
  const tsx = esc(path.join(releaseDir, 'node_modules/tsx/dist/cli.mjs'));
  const workdir = esc(path.join(releaseDir, 'server'));
  const edits = esc(path.join(DATA, 'world-edits.json'));
  const out = esc(path.join(LOGDIR, 'server.log'));
  const err = esc(path.join(LOGDIR, 'server.err.log'));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${tsx}</string>
    <string>src/index.ts</string>
  </array>
  <key>WorkingDirectory</key><string>${workdir}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MC_EDITS_FILE</key><string>${edits}</string>
    <key>PORT</key><string>${PORT}</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${out}</string>
  <key>StandardErrorPath</key><string>${err}</string>
</dict>
</plist>
`;
}

function writePlist(releaseDir) {
  mkdirSync(path.dirname(PLIST), { recursive: true });
  const tmp = `${PLIST}.tmp`;
  writeFileSync(tmp, plistXml(releaseDir));
  run('/bin/mv', ['-f', tmp, PLIST]);
  log(`launchd agent installed → ${PLIST}`);
}

// --- service control ----------------------------------------------------------

function bootOut() {
  try {
    execFileSync('launchctl', ['bootout', `gui/${uid}`, PLIST], { stdio: 'ignore' });
    return true;
  } catch {
    return false; // not loaded — fine (also the "5: Input/output error" first-run case)
  }
}

function bootStrap() {
  run('launchctl', ['bootstrap', `gui/${uid}`, PLIST]);
}

function serviceState() {
  try {
    const out = run('launchctl', ['print', `gui/${uid}/${LABEL}`], { stdio: ['ignore', 'pipe', 'ignore'] });
    const state = /state = (\S+)/.exec(out)?.[1] ?? 'unknown';
    const pid = /pid = (\d+)/.exec(out)?.[1] ?? null;
    return { loaded: true, state, pid };
  } catch {
    return { loaded: false, state: 'not-loaded', pid: null };
  }
}

async function healthz() {
  try {
    const res = await fetch(`http://localhost:${PORT}/healthz`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function waitForHealth(seconds) {
  for (let i = 0; i < seconds * 2; i++) {
    const h = await healthz();
    if (h?.ok) return h;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

function lanUrls() {
  const urls = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const info of interfaces ?? []) {
      if (info.family === 'IPv4' && !info.internal) urls.push(`http://${info.address}:${PORT}`);
    }
  }
  return urls;
}

async function portFree() {
  const probe = await fetch(`http://localhost:${PORT}/healthz`, { signal: AbortSignal.timeout(800) }).then(
    (r) => r.status,
    () => null,
  );
  return probe === null; // nothing answering (even a non-game server would answer SOMETHING)
}

// --- deploy -------------------------------------------------------------------

function pruneReleases() {
  const currentName = path.basename(realpathSync(CURRENT));
  const entries = readdirSync(RELEASES)
    .filter((d) => statSync(path.join(RELEASES, d)).isDirectory())
    .map((d) => ({ d, m: statSync(path.join(RELEASES, d)).mtimeMs }))
    .sort((a, b) => b.m - a.m); // newest first
  // Keep the live release + the newest KEEP_RELEASES by deploy time.
  const doomed = entries.filter((e, i) => e.d !== currentName && i >= KEEP_RELEASES);
  for (const { d } of doomed) {
    rmSync(path.join(RELEASES, d), { recursive: true, force: true });
    log(`pruned old release ${d}`);
  }
}

async function deploy(tag) {
  if (!/^[A-Za-z0-9._-]+$/.test(tag)) throw new Error(`invalid tag name: ${tag}`);
  const tags = run('git', ['tag', '-l'], { cwd: ROOT }).trim().split('\n');
  if (!tags.includes(tag)) {
    throw new Error(`tag "${tag}" not found. Available: ${tags.join(', ') || '(none)'}`);
  }

  const releaseDir = path.join(RELEASES, tag);
  if (existsSync(releaseDir)) throw new Error(`${releaseDir} already exists (rollback to it, or rm it to redeploy)`);
  mkdirSync(releaseDir, { recursive: true });
  log(`exporting ${tag} (git archive — pristine tree, no dev cruft)…`);
  sh(`git -C ${JSON.stringify(ROOT)} archive ${tag} | tar -x -C ${JSON.stringify(releaseDir)}`);

  log('npm ci (full — the server runs via tsx)…');
  run('npm', ['ci', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: releaseDir });

  log('building client → client/dist…');
  run('npm', ['run', 'build', '-w', 'client', '--silent'], { cwd: releaseDir });

  ensureData();

  // Atomic-ish flip. NOTE: `mv -f tmp current` does NOT work here — `current`
  // is a symlink to a directory, so mv resolves it and lands the temp INSIDE
  // the old release. `ln -sfn` replaces the symlink itself (macOS-safe).
  run('/bin/ln', ['-sfn', path.join('releases', tag), CURRENT]);
  writePlist(releaseDir);

  bootOut(); // stop the PREVIOUS release first — it legitimately holds :PORT during upgrades
  if (!(await portFree())) {
    console.error(
      `\n[deploy] WARNING: something OTHER than the old service is serving :${PORT} (a dev \`npm run lan\`?).\n` +
      `           Everything is deployed; stop the other server, then start the service:\n` +
      `             launchctl kickstart -k gui/${uid}/${LABEL}\n`,
    );
    return;
  }
  bootStrap();
  log(`service bootstrapped (${LABEL})…`);
  const health = await waitForHealth(25);
  if (!health) {
    const state = serviceState();
    console.error(`[deploy] service did not become healthy (state: ${state.state}) — tail of the error log:`);
    try {
      console.error(run('tail', ['-15', path.join(LOGDIR, 'server.err.log')]));
    } catch { /* no log yet */ }
    process.exitCode = 1;
    return;
  }
  pruneReleases();
  console.log(`\n[deploy] ✅ minecraft-mini ${tag} is LIVE`);
  console.log(`[deploy]    local  http://localhost:${PORT}`);
  for (const url of lanUrls()) console.log(`[deploy]    LAN    ${url}`);
  console.log(`[deploy]    logs   tail -f ~/Library/Logs/minecraft-mini/server.log`);
  console.log(`[deploy]    world  ${path.join(DATA, 'world-edits.json')} (${health.edits} edits, mode ${health.mode})`);
}

// --- commands -----------------------------------------------------------------

async function status() {
  const current = existsSync(CURRENT) ? path.basename(realpathSync(CURRENT)) : '(none)';
  const state = serviceState();
  const health = await healthz();
  console.log(`current release : ${current}`);
  console.log(`service         : ${state.loaded ? `${state.state}${state.pid ? ` (pid ${state.pid})` : ''}` : 'not loaded'}`);
  console.log(`health          : ${health ? `ok — ${health.players} player(s), ${health.edits} edits, mode ${health.mode}` : 'NOT ANSWERING'}`);
  const releases = existsSync(RELEASES) ? readdirSync(RELEASES).sort() : [];
  console.log(`releases kept   : ${releases.join(', ') || '(none)'}`);
  if (!health && state.loaded) {
    try { console.log(run('tail', ['-5', path.join(LOGDIR, 'server.err.log')])); } catch { /* no log */ }
  }
}

async function rollback(tag) {
  const releaseDir = path.join(RELEASES, tag);
  if (!existsSync(releaseDir)) throw new Error(`release ${tag} is not kept under ${RELEASES} (was it pruned?)`);
  run('/bin/ln', ['-sfn', path.join('releases', tag), CURRENT]); // replaces, never descends
  writePlist(releaseDir);
  run('launchctl', ['kickstart', '-k', `gui/${uid}/${LABEL}`]);
  const health = await waitForHealth(20);
  console.log(`[deploy] ${health ? '✅ rolled back to ' + tag : `⚠️ flipped to ${tag} but health check failed — check logs`}`);
}

const command = process.argv[2] ?? '--status';
try {
  if (command === '--status') await status();
  else if (command === '--stop') { bootOut() ? log('service stopped (data untouched)') : log('service was not loaded'); }
  else if (command === '--start') { bootStrap(); log(await waitForHealth(20) ? '✅ service started' : '⚠️ no health yet — check logs'); }
  else if (command === '--restart') { run('launchctl', ['kickstart', '-k', `gui/${uid}/${LABEL}`]); log(await waitForHealth(20) ? '✅ restarted' : '⚠️ no health yet — check logs'); }
  else if (command === '--rollback') await rollback(process.argv[3] ?? (() => { throw new Error('usage: --rollback <tag>'); })());
  else if (command === '--uninstall') {
    bootOut();
    rmSync(PLIST, { force: true });
    console.log(`[deploy] service removed. Kept for safety:\n  releases: ${RELEASES}\n  world   : ${DATA}`);
  } else if (!command.startsWith('-')) await deploy(command);
  else throw new Error(`unknown option ${command} — see the header of scripts/deploy.mjs`);
} catch (err) {
  console.error(`[deploy] ✗ ${err.message}`);
  process.exitCode = 1;
}
