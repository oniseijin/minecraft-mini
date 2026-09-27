// Test-bot smoke (protocol v4): ONE human client + the server-driven test bot
// exercises every 2-player path solo. Builds the client, boots the game server
// on PORT (default 8098 — never the user's :8080 or the :5173 dev server),
// then drives a single headless chrome page through:
//   - #bot-add (REAL menu button) → bot in roster + avatar within 3 s, join
//     chat line, Tab player-list row, hint flips to "Real 1v1 vs bot"
//   - #party-start with the bot → REAL match (2 score entries), played until a
//     roundResult names the bot as faller (or survivor) → leaveGame
//   - #bw-start with the bot → bot on team 1; human buys a wooden sword at the
//     island shop, breaks the bot's bed (normal break path), then kills the
//     bot through the normal attack path → matchEnd winner = human
//   - #bot-remove mid-lobby → roster shrinks, avatar gone, left chat line
//
// Usage: PORT=8098 node tools/smoke-bot.mjs   (SKIP_BUILD=1 reuses the build)
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const PORT = Number(process.env.PORT ?? 8098);
const BASE = `http://localhost:${PORT}`;
const EDITS_FILE = path.join(root, 'tools', 'smoke-out', 'smoke-bot-edits.json');

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

function watchErrors(page, errors) {
  const ignore = (text) => /WebSocket connection to .*\/ws.* failed/i.test(text);
  page.on('pageerror', (e) => { if (!ignore(e.message)) errors.push(`pageerror: ${e.message}`); });
  page.on('console', (m) => { if (m.type() === 'error' && !ignore(m.text())) errors.push(`console: ${m.text()}`); });
}

// The bot's bed (team 1 / blue island, shared/src/arena.ts ARENA.beds[1]).
const BOT_BED = [195, 31, 64];

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

  const waitFor = async (fn, timeoutMs, label, arg = null) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (await page.evaluate(fn, arg)) return true;
      await sleep(120);
    }
    throw new Error(`${label} not reached within ${timeoutMs} ms`);
  };

  // 1. add the test bot via the REAL menu button ---------------------------------
  console.log('[1] add test bot (menu button)');
  const hintBefore = await page.textContent('#match-hint');
  check('solo hint mentions practice + bot option', /solo practice/i.test(hintBefore ?? '') && /test bot/i.test(hintBefore ?? ''), JSON.stringify(hintBefore));
  check('sandbox mode badge shown', (await page.textContent('#mode-badge')) === 'Sandbox', await page.textContent('#mode-badge'));
  await page.locator('#bot-add').click();
  const botShown = await waitFor(
    () => {
      const bot = window.__mc.net.players.find((p) => p.bot === true);
      return !!bot && bot.name.startsWith('Bot ') && window.__mc.remotePlayers.has(bot.id);
    },
    3000,
    'bot in roster + avatar',
  );
  const botId = await page.evaluate(() => window.__mc.net.players.find((p) => p.bot === true)?.id ?? null);
  check('bot appears in net.players + remotePlayers within 3 s', botShown && botId !== null && botId > 1000, `id=${botId}`);
  const addDisabled = await page.locator('#bot-add').isHidden();
  const removeEnabled = await page.locator('#bot-remove').isEnabled();
  check('menu flips to Remove-bot state', addDisabled && removeEnabled, `addHidden=${addDisabled} removeEnabled=${removeEnabled}`);
  const hintBot = await page.textContent('#match-hint');
  check('hint flips to real 1v1 vs bot', /real 1v1 vs bot/i.test(hintBot ?? ''), JSON.stringify(hintBot));
  const joinLine = await page.evaluate(() => window.__mc.chatHistory.some((l) => l.text.includes('Bot Steve joined')));
  check('join line in chat (✦ Bot Steve joined)', joinLine, 'chatHistory contains the system line');
  const health1 = await healthz();
  check('healthz reports humans/bots separately', health1?.humans === 1 && health1?.bots === 1, JSON.stringify({ humans: health1?.humans, bots: health1?.bots }));

  // Tab player list (hold Tab): both players, bot tagged.
  await page.keyboard.down('Tab');
  await waitFor(
    () => {
      const el = document.getElementById('player-list');
      return !el.classList.contains('hidden') && el.textContent.includes('Bot Steve') && el.textContent.includes('(Bot)');
    },
    3000,
    'Tab player list shows the bot row',
  );
  const listRows = await page.evaluate(() => document.querySelectorAll('#player-list .pl-row').length);
  await page.keyboard.up('Tab');
  const listHidden = await waitFor(() => document.getElementById('player-list').classList.contains('hidden'), 3000, 'Tab list hides on release');
  check('hold-Tab player list shows 2 players, bot tagged, hides on release', listRows === 2 && listHidden, `rows=${listRows}`);

  // 2. Block Party WITH the bot → REAL match, bot falls or survives a round ------
  console.log('[2] party vs bot');
  await page.locator('#party-start').click();
  await waitFor(() => window.__mc.mode === 'party' && window.__mc.party !== null, 15_000, 'modeChanged(party)');
  await waitFor(() => window.__mc.worldRenderer.pendingCount === 0, 60_000, 'party world built');
  const partyReal = await page.evaluate(
    (botId) => ({
      myTeam: window.__mc.party.myTeam,
      entries: window.__mc.party.scores.size,
      botEntry: window.__mc.party.scores.has(botId),
      badge: document.getElementById('mode-badge').textContent,
    }),
    botId,
  );
  check(
    'REAL party match (bot dealt in, human slot 0)',
    partyReal.entries === 2 && partyReal.botEntry && partyReal.myTeam === 0,
    `scores=${partyReal.entries} bot=${partyReal.botEntry} myTeam=${partyReal.myTeam}`,
  );
  check('party mode badge', partyReal.badge === 'Block Party 1v1', partyReal.badge);

  /** Plays one round: human on an announced-color cell → waits a fresh roundResult. */
  const playRound = async (round) => {
    await waitFor(
      (r) => window.__mc.party !== null && window.__mc.party.phase === 'announce' && window.__mc.party.round === r,
      20_000,
      `announce of round ${round}`,
      round,
    );
    const seen = await page.evaluate(() => window.__mc.party.events.filter((e) => e.kind === 'roundResult').length);
    const good = await page.evaluate(() => {
      const floor = { minX: 116, maxX: 140, minZ: 52, maxZ: 76 };
      const colorId = window.__mc.party.colorId;
      for (let z = floor.minZ; z <= floor.maxZ; z++) {
        for (let x = floor.minX; x <= floor.maxX; x++) {
          if (window.__mc.world.getBlock(x, 30, z) === colorId) return [x, z];
        }
      }
      return null;
    });
    if (!good) throw new Error(`round ${round}: no announced-color cell found`);
    await page.evaluate((cell) => {
      window.__mc.player.teleport(cell[0] + 0.5, 31, cell[1] + 0.5);
      window.__mc.player.vel.set(0, 0, 0);
    }, good);
    await sleep(450); // movement relay so the server sees the standings
    const scored = await waitFor(
      (n) => window.__mc.party !== null && window.__mc.party.events.filter((e) => e.kind === 'roundResult').length > n,
      20_000,
      `round ${round} result`,
      seen,
    );
    const result = await page.evaluate(
      (botId) => window.__mc.party.events.filter((e) => e.kind === 'roundResult').pop()?.data ?? null,
      botId,
    );
    const botInvolved = !!result && (result.fallers.includes(botId) || result.survivorId === botId);
    // Back to the spawn slot so the next round settles without the grace delay.
    await page.evaluate(() => window.__mc.player.teleport(128.5, 31, 63.5));
    return { scored, result, botInvolved };
  };

  let round1 = null;
  for (let round = 1; round <= 4 && !round1?.botInvolved; round++) {
    round1 = await playRound(round);
  }
  check(
    'roundResult names the bot as faller or survivor',
    round1?.scored && round1?.botInvolved,
    JSON.stringify(round1?.result ?? null),
  );
  await page.evaluate(() => window.__mc.leaveGame());
  await waitFor(() => window.__mc.mode === 'sandbox' && window.__mc.party === null, 10_000, 'back in sandbox');

  // 3. BedWars vs the bot: bed break + final kill → matchEnd ----------------------
  console.log('[3] bedwars vs bot');
  await page.locator('#bw-start').click();
  await waitFor(() => window.__mc.mode === 'bedwars' && window.__mc.bw !== null, 15_000, 'modeChanged(bedwars)');
  await waitFor(() => window.__mc.bw.phase === 'playing', 35_000, 'playing phase');
  const bwReal = await page.evaluate(
    (botId) => ({
      myTeam: window.__mc.bw.myTeam,
      size: window.__mc.bw.players.size,
      botTeam: window.__mc.bw.players.get(botId)?.team ?? null,
      botName: window.__mc.bw.players.get(botId)?.name ?? null,
      badge: document.getElementById('mode-badge').textContent,
    }),
    botId,
  );
  check(
    'REAL bedwars match — bot on team 1, human team 0',
    bwReal.size === 2 && bwReal.botTeam === 1 && bwReal.myTeam === 0 && bwReal.botName?.startsWith('Bot '),
    `players=${bwReal.size} botTeam=${bwReal.botTeam} myTeam=${bwReal.myTeam}`,
  );
  check('bedwars mode badge', bwReal.badge === 'BedWars 1v1', bwReal.badge);

  // Wooden sword (4 dmg) keeps the trade one-sided: wait for 10 iron, then buy.
  await waitFor(() => (window.__mc.bw?.currency.iron ?? 0) >= 10, 40_000, '10 iron for the sword');
  await page.evaluate(() => window.__mc.player.teleport(61.5, 31, 60.5)); // red shop pad
  await sleep(450);
  await page.evaluate(() => window.__mc.openShop());
  await page.evaluate(() => window.__mc.buy('wooden_sword'));
  const sword = await waitFor(() => window.__mc.bw?.inv.sword === 'wooden', 8_000, 'wooden sword bought');
  await page.evaluate(() => window.__mc.closeShop());
  await page.evaluate(() => window.__mc.selectSlot(2));
  const held = await page.evaluate(() => window.__mc.held());
  check('shop purchase through the panel path', sword && held === 'wooden_sword', `sword=${sword} held=${held}`);

  // Break the bot's bed through the normal break path (reach-validated).
  let bedBroken = false;
  for (let attempt = 0; attempt < 4 && !bedBroken; attempt++) {
    await page.evaluate(() => window.__mc.player.teleport(193.5, 31, 64.5));
    await sleep(450); // move relay so the server's reach check sees us
    await page.evaluate((bed) => window.__mc.breakBlockAt(bed[0], bed[1], bed[2]), BOT_BED);
    bedBroken = await waitFor(
      () => !!window.__mc.bw?.events.some((e) => e.kind === 'bedBroken' && e.data.team === 1),
      4000,
      'bedBroken(team 1)',
    ).catch(() => false);
  }
  const botBedGone = await page.evaluate((bed) => window.__mc.world.getBlock(bed[0], bed[1], bed[2]) === 0, BOT_BED);
  check('bot bed broken via the normal break path', bedBroken && botBedGone, `event=${bedBroken} cellAir=${botBedGone}`);

  // Kill the bot through the normal attack path (handle a traded death).
  let killed = false;
  for (let i = 0; i < 60 && !killed; i++) {
    const state = await page.evaluate((botId) => {
      const mc = window.__mc;
      if (!mc.bw) return { done: false, meDead: false, botPos: null };
      const me = mc.bw.me();
      const bp = mc.bw.players.get(botId);
      const bot = mc.net.players.find((p) => p.id === botId);
      return {
        done: bp ? !bp.alive : false,
        meDead: me ? !me.alive : false,
        botPos: bot && bp?.alive ? { x: bot.x, y: bot.y, z: bot.z } : null,
      };
    }, botId);
    if (state.done) { killed = true; break; }
    if (state.meDead) {
      // Our bed stands → respawn, then re-engage.
      await waitFor(() => {
        const me = window.__mc.bw?.me();
        return !!me && me.alive && me.hp === 20;
      }, 15_000, 'human respawn while bed stands');
      await sleep(300);
      continue;
    }
    if (!state.botPos) { await sleep(250); continue; }
    await page.evaluate((bp) => {
      const mc = window.__mc;
      mc.player.teleport(bp.x - 1.6, bp.y, bp.z);
      mc.lookAt(bp.x, bp.y + 1.2, bp.z);
    }, state.botPos);
    await sleep(350); // move relay + 0.5 s attack cooldown spacing
    await page.evaluate(() => window.__mc.tryAttack());
    await sleep(250);
  }
  check('bot killed via the normal attack path', killed, `killed=${killed}`);
  const matchEnd = await waitFor(
    (myId) => window.__mc.bw?.results !== null && window.__mc.bw?.results?.winnerId === myId,
    10_000,
    'matchEnd winner = human',
    await page.evaluate(() => window.__mc.net.id),
  );
  const stats = await page.evaluate(() => window.__mc.bw?.results?.stats ?? []);
  check('matchEnd with the human as winner', matchEnd, `stats=${JSON.stringify(stats)}`);

  // 4. Remove the bot mid-lobby ---------------------------------------------------
  console.log('[4] remove test bot');
  await page.evaluate(() => window.__mc.leaveGame());
  await waitFor(() => window.__mc.mode === 'sandbox' && window.__mc.bw === null, 10_000, 'sandbox lobby');
  const rosterBefore = await page.evaluate((botId) => ({
    count: window.__mc.net.players.length,
    hasBot: window.__mc.net.players.some((p) => p.id === botId),
  }), botId);
  await page.locator('#bot-remove').click();
  const removed = await waitFor(
    (botId) =>
      window.__mc.net.players.length === 1 &&
      !window.__mc.net.players.some((p) => p.id === botId) &&
      !window.__mc.remotePlayers.has(botId),
    5000,
    'roster shrinks + avatar removed',
    botId,
  );
  const leftLine = await page.evaluate(() => window.__mc.chatHistory.some((l) => l.text.includes('Bot Steve left')));
  const hintAfter = await page.textContent('#match-hint');
  check(
    'remove bot → roster shrinks, avatar gone, hint back to practice',
    removed && rosterBefore.count === 2 && rosterBefore.hasBot && /solo practice/i.test(hintAfter ?? ''),
    `removed=${removed} hint=${JSON.stringify(hintAfter)}`,
  );
  check('left line in chat (✦ Bot Steve left)', leftLine, 'chatHistory contains the system line');

  check('no page errors', errors.length === 0, errors.length ? errors.slice(0, 5).join(' | ') : 'none');

  const failed = results.filter((r) => !r.ok);
  console.log(failed.length === 0 ? '\nSMOKE-BOT PASSED' : `\nSMOKE-BOT FAILED: ${failed.length} check(s)`);
  if (failed.length > 0 || errors.length > 0) process.exitCode = 1;
} catch (error) {
  console.error(`SMOKE-BOT FAILED: ${error.message}`);
  if (serverLog) console.error(`--- server log tail ---\n${serverLog.slice(-3000)}`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => undefined);
  await stopServer().catch(() => undefined);
  rmSync(EDITS_FILE, { force: true });
}
