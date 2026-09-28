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
import {
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
} from './lib.mjs';

const PORT = Number(process.env.PORT ?? 8091); // never the live :8080
const BASE = `http://localhost:${PORT}`;
const EDITS_FILE = smokeOut('smoke-net-edits.json');

const { check, finish } = createChecks();

let browser = null;
let server = null;
const errors = [];
try {
  // 0. build + boot ------------------------------------------------------------
  buildClient();
  await ensurePortFree(BASE, PORT);
  console.log('[server] booting game server…');
  server = await startServer({ port: PORT, editsFile: EDITS_FILE, logCap: 20_000 });

  browser = await launch();
  const { page: pageA } = await openPage({ base: BASE, browser, errors, label: 'A', wait: 'combined', describeFailure: true });
  const { page: pageB } = await openPage({ base: BASE, browser, errors, label: 'B', wait: 'combined', describeFailure: true });

  // 1. join + identity ---------------------------------------------------------
  console.log('[1] join + roster');
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
  // 5 s window: the sync path is immediate (edits apply on ws receipt), but
  // parallel headless-Chrome test runs can starve the CPU enough to blow 2 s.
  while (Date.now() - t0 < 5000) {
    const id = await pageB.evaluate(([x, y, z]) => window.__mc.world.getBlock(x, y, z), edit.cell);
    if (id === placed.id) { bGotIt = true; break; }
    await sleep(100);
  }
  check(`B's world has the block within 5 s`, bGotIt, `cell=${edit.cell} id=${placed.id}`);

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
  await stopServer(server);
  console.log('[server] restarting…');
  server = await startServer({ port: PORT, editsFile: EDITS_FILE, logCap: 20_000, resetEdits: false });
  const { page: pageC } = await openPage({ base: BASE, browser, errors, label: 'C', wait: 'combined', describeFailure: true });
  const persisted = await pageC.evaluate(([x, y, z]) => window.__mc.world.getBlock(x, y, z), edit.cell);
  check(
    'fresh page sees the edit after restart (welcome.edits)',
    persisted === placed.id,
    `cell=${edit.cell} id=${persisted} (server edits=${server.health.edits})`,
  );

  // 6. clean pages ----------------------------------------------------------------
  check('no page errors', errors.length === 0, errors.length ? errors.slice(0, 5).join(' | ') : 'none');

  finish('SMOKE-NET', errors);
} catch (error) {
  console.error(`SMOKE-NET FAILED: ${error.message}`);
  const tail = server?.logTail?.(2000) ?? '';
  if (tail) console.error(`--- server log tail ---\n${tail}`);
  process.exitCode = 1;
} finally {
  await teardown({ browser, server, editsFile: EDITS_FILE });
}
