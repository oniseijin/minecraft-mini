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
import {
  ATTACK_SPACING_MS,
  MOVE_RELAY_MS,
  RESPAWN_RELAY_MS,
  buildClient,
  createChecks,
  ensurePortFree,
  healthz,
  openPage,
  sleep,
  smokeOut,
  startServer,
  teardown,
  waitFor,
} from './lib.mjs';

const PORT = Number(process.env.PORT ?? 8098);
const BASE = `http://localhost:${PORT}`;
const EDITS_FILE = smokeOut('smoke-bot-edits.json');

const { check, finish } = createChecks();

// The bot's bed (team 1 / blue island, shared/src/arena.ts ARENA.beds[1]).
const BOT_BED = [195, 31, 64];

let browser = null;
let server = null;
let page = null;
const errors = [];
try {
  // 0. build + boot ------------------------------------------------------------
  buildClient();
  await ensurePortFree(BASE, PORT, ' (or pass PORT=…)');
  console.log('[server] booting game server…');
  server = await startServer({ port: PORT, editsFile: EDITS_FILE });

  ({ browser, page } = await openPage({ base: BASE, errors }));

  // 1. add the test bot via the REAL menu button ---------------------------------
  console.log('[1] add test bot (menu button)');
  const hintBefore = await page.textContent('#match-hint');
  check('solo hint mentions practice + bot option', /solo practice/i.test(hintBefore ?? '') && /test bot/i.test(hintBefore ?? ''), JSON.stringify(hintBefore));
  check('sandbox mode badge shown', (await page.textContent('#mode-badge')) === 'Sandbox', await page.textContent('#mode-badge'));
  await page.locator('#bot-add').click();
  const botShown = await waitFor(
    page,
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
  const health1 = await healthz(BASE);
  check('healthz reports humans/bots separately', health1?.humans === 1 && health1?.bots === 1, JSON.stringify({ humans: health1?.humans, bots: health1?.bots }));

  // Tab player list (hold Tab): both players, bot tagged.
  await page.keyboard.down('Tab');
  await waitFor(
    page,
    () => {
      const el = document.getElementById('player-list');
      return !el.classList.contains('hidden') && el.textContent.includes('Bot Steve') && el.textContent.includes('(Bot)');
    },
    3000,
    'Tab player list shows the bot row',
  );
  const listRows = await page.evaluate(() => document.querySelectorAll('#player-list .pl-row').length);
  await page.keyboard.up('Tab');
  const listHidden = await waitFor(page, () => document.getElementById('player-list').classList.contains('hidden'), 3000, 'Tab list hides on release');
  check('hold-Tab player list shows 2 players, bot tagged, hides on release', listRows === 2 && listHidden, `rows=${listRows}`);

  // 2. Block Party WITH the bot → REAL match, bot falls or survives a round ------
  console.log('[2] party vs bot');
  await page.locator('#party-start').click();
  await waitFor(page, () => window.__mc.mode === 'party' && window.__mc.party !== null, 15_000, 'modeChanged(party)');
  await waitFor(page, () => window.__mc.worldRenderer.pendingCount === 0, 60_000, 'party world built');
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
      page,
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
    await sleep(MOVE_RELAY_MS); // movement relay so the server sees the standings
    const scored = await waitFor(
      page,
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
  await waitFor(page, () => window.__mc.mode === 'sandbox' && window.__mc.party === null, 10_000, 'back in sandbox');

  // 3. BedWars vs the bot: bed break + final kill → matchEnd ----------------------
  console.log('[3] bedwars vs bot');
  await page.locator('#bw-start').click();
  await waitFor(page, () => window.__mc.mode === 'bedwars' && window.__mc.bw !== null, 15_000, 'modeChanged(bedwars)');
  await waitFor(page, () => window.__mc.bw.phase === 'playing', 35_000, 'playing phase');
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
  await waitFor(page, () => (window.__mc.bw?.currency.iron ?? 0) >= 10, 40_000, '10 iron for the sword');
  await page.evaluate(() => window.__mc.player.teleport(61.5, 31, 60.5)); // red shop pad
  await sleep(MOVE_RELAY_MS); // server must see us on the pad before the shop validates proximity
  await page.evaluate(() => window.__mc.openShop());
  await page.evaluate(() => window.__mc.buy('wooden_sword'));
  const sword = await waitFor(page, () => window.__mc.bw?.inv.sword === 'wooden', 8_000, 'wooden sword bought');
  await page.evaluate(() => window.__mc.closeShop());
  await page.evaluate(() => window.__mc.selectSlot(2));
  const held = await page.evaluate(() => window.__mc.held());
  check('shop purchase through the panel path', sword && held === 'wooden_sword', `sword=${sword} held=${held}`);

  // Break the bot's bed through the normal break path (reach-validated).
  let bedBroken = false;
  for (let attempt = 0; attempt < 4 && !bedBroken; attempt++) {
    await page.evaluate(() => window.__mc.player.teleport(193.5, 31, 64.5));
    await sleep(MOVE_RELAY_MS); // move relay so the server's reach check sees us
    await page.evaluate((bed) => window.__mc.breakBlockAt(bed[0], bed[1], bed[2]), BOT_BED);
    bedBroken = await waitFor(
      page,
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
      await waitFor(
        page,
        () => {
          const me = window.__mc.bw?.me();
          return !!me && me.alive && me.hp === 20;
        },
        15_000,
        'human respawn while bed stands',
      );
      await sleep(RESPAWN_RELAY_MS); // respawned position relayed before re-engaging
      continue;
    }
    if (!state.botPos) { await sleep(250); continue; }
    await page.evaluate((bp) => {
      const mc = window.__mc;
      mc.player.teleport(bp.x - 1.6, bp.y, bp.z);
      mc.lookAt(bp.x, bp.y + 1.2, bp.z);
    }, state.botPos);
    await sleep(ATTACK_SPACING_MS); // move relay + 0.5 s attack cooldown spacing
    await page.evaluate(() => window.__mc.tryAttack());
    await sleep(250);
  }
  check('bot killed via the normal attack path', killed, `killed=${killed}`);
  const matchEnd = await waitFor(
    page,
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
  await waitFor(page, () => window.__mc.mode === 'sandbox' && window.__mc.bw === null, 10_000, 'sandbox lobby');
  const rosterBefore = await page.evaluate((botId) => ({
    count: window.__mc.net.players.length,
    hasBot: window.__mc.net.players.some((p) => p.id === botId),
  }), botId);
  await page.locator('#bot-remove').click();
  const removed = await waitFor(
    page,
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

  finish('SMOKE-BOT', errors);
} catch (error) {
  console.error(`SMOKE-BOT FAILED: ${error.message}`);
  const tail = server?.logTail?.() ?? '';
  if (tail) console.error(`--- server log tail ---\n${tail}`);
  process.exitCode = 1;
} finally {
  await teardown({ browser, server, editsFile: EDITS_FILE });
}
