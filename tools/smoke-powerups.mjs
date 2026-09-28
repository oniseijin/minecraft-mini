// M5.2 gate: mystery boxes + power-ups + spectator Color Zapper, two-client
// integration test for the minecraft-mini netcode (Block Party, protocol v7).
//
// Builds the client, boots the game server on :8096 (edit file isolated under
// tools/smoke-out/, never :8080/:5173), then drives TWO headless chrome pages
// through Block Party matches via the same client paths the UI uses (__mc).
//
// Determinism env knobs exercised here (all documented in README):
//   PARTY_BOMB_RATE=0  — no auto bombs; keeps rounds quiet
//   PARTY_BOX_RATE=1   — every round from round 2 gets mystery boxes
//   PARTY_BOX_COUNT=1|2— forces the exact box count per eligible round
//   PARTY_ITEM=<id>    — forces the item inside every box (leap|speed|jump|
//                        swapper|teleporter)
//
// Parts (fresh server + match each, so item forcing is deterministic):
//   SPEED  — boxes spawn on both clients (events + gameState), walk-over
//            pickup grants the item (state + UI slot + "✦ Got Speed!" toast),
//            unclaimed boxes vanish at the drop, hold-cap 3 refusal leaves
//            the box on the floor, using Speed applies a real ×1.4 movement
//            multiplier to the player controller (measured walk distance),
//            the buff expires after 5 s, and using in the final 2 s is
//            rejected with the "Locked — final 2 seconds!" toast.
//   JUMP   — Jump Boost sets the controller's jump velocity to 13 (measured).
//   LEAP   — using Leap adds a velocity impulse along look (+8 h / +5 v).
//   SWAPPER— swapping teleports BOTH clients to each other's spot (2-client
//            assertion) and toasts both.
//   WARP   — Color Teleporter lands the user on an announced-color cell;
//            a second teleporter pickup is refused (cap 1); use while
//            mid-fall is refused with a toast; final-2s lockout again.
//   ZAPPER — after B falls, B's zapper arms (hint UI), a click raycast
//            removes ONE surviving cell on BOTH clients (cellZapped + edit),
//            the zapper spends itself, and a second zap is rejected.
import {
  buildClient,
  createChecks,
  ensurePortFree,
  launch,
  sleep,
  smokeOut,
  startServer,
  stopServer,
  teardown,
  waitFor,
  watchErrors,
} from './lib.mjs';

const PORT = Number(process.env.PORT ?? 8096); // never the live :8080
const BASE = `http://localhost:${PORT}`;
const EDITS_FILE = smokeOut('smoke-powerups-edits.json');
const AIR = 0;
// Party floor bounds (shared/src/partyArena.ts) — Node-side constants only.
const FLOOR = { minX: 116, maxX: 140, minZ: 52, maxZ: 76, y: 30 };

const { check, finish } = createChecks();

let browser = null;
let server = null;
let pageA = null;
let pageB = null;
const errors = [];

async function waitOnline(page, label) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__mc !== undefined && window.__mc.net.mode === 'online',
    null,
    { timeout: 60_000 },
  );
  console.log(`  [net] ${label} online`);
}

async function toastOf(page) {
  return page.evaluate(() => ({
    text: document.getElementById('toast').textContent,
    shown: document.getElementById('toast').classList.contains('show'),
  }));
}

/** Starts a party match and waits for both clients to finish meshing it. */
async function startPartyMatch() {
  await pageA.evaluate(() => window.__mc.startParty());
  for (const [page, label] of [[pageA, 'A'], [pageB, 'B']]) {
    await waitFor(
      page,
      () => window.__mc.mode === 'party' && window.__mc.party !== null && window.__mc.party.spawns.length === 2,
      15_000,
      `${label} modeChanged(party)`,
    );
    await waitFor(page, () => window.__mc.worldRenderer.pendingCount === 0, 60_000, `${label} party world built`);
  }
}

/** Waits for round `round`'s announce on both clients. */
async function waitAnnounce(round, timeoutMs = 30_000) {
  for (const [page, label] of [[pageA, 'A'], [pageB, 'B']]) {
    await waitFor(
      page,
      (r) => window.__mc.party !== null && window.__mc.party.phase === 'announce' && window.__mc.party.round === r,
      timeoutMs,
      `${label} announce of round ${round}`,
      round,
    );
  }
}

/** A good (announced-color) cell near the floor center + a bad one ≥3 away. */
async function findGoodBad() {
  return pageA.evaluate((floor) => {
    const colorId = window.__mc.party.colorId;
    let good = null;
    let bad = null;
    let bestD = Infinity;
    for (let z = floor.minZ; z <= floor.maxZ; z++) {
      for (let x = floor.minX; x <= floor.maxX; x++) {
        const id = window.__mc.world.getBlock(x, floor.y, z);
        if (id === 0) continue;
        const d = Math.hypot(x - 128, z - 64);
        if (id === colorId && d < bestD) {
          bestD = d;
          good = [x, z];
        } else if (id !== colorId && good && Math.hypot(x - good[0], z - good[1]) >= 3) {
          bad = [x, z];
        }
      }
    }
    return { colorId, good, bad };
  }, FLOOR);
}

/** Parks a fighter dead-center on a floor cell (feet y=31, zero velocity). */
async function parkOn(page, cell) {
  await page.evaluate((c) => {
    window.__mc.player.teleport(c[0] + 0.5, 31, c[1] + 0.5);
    window.__mc.player.vel.set(0, 0, 0);
  }, cell);
  await sleep(300); // movement relay so the server sees the spot
}

/**
 * Holds A's forward input from a fixed floor spot until the controller's
 * approach velocity converges, then returns `vel.z`. The approach converges
 * per PHYSICS TICK (not wall time), so the reading is robust against the
 * headless renderer's frame-rate: base walk converges to 4.3, Speed ×1.4 to
 * ≈6.0 — the absolute threshold separates them cleanly.
 */
async function measureSpeed(page) {
  return page.evaluate(async () => {
    const p = window.__mc.player;
    p.teleport(128.5, 31, 62.5); // floor middle — 13 free cells ahead (+Z)
    for (let i = 0; i < 60 && !p.onGround; i++) await new Promise((r) => requestAnimationFrame(r));
    p.vel.set(0, 0, 0);
    p.look(Math.PI, 0); // face +Z
    p.input.forward = true;
    await new Promise((r) => setTimeout(r, 1200));
    const vz = p.vel.z;
    p.input.forward = false;
    p.vel.set(0, 0, 0);
    return vz;
  });
}

/** Teleports A onto box `index`'s cell; resolves when A holds `heldCount`. */async function pickBox(myId, heldCount, index = 0) {
  // Boxes appear ~0.5 s into the announce — wait for this one to exist.
  await waitFor(pageA, (i) => (window.__mc.party.boxes?.length ?? 0) > i, 6000, `box ${index} appears on the floor`, index);
  const cell = await pageA.evaluate((i) => window.__mc.party.boxes[i] ?? null, index);
  if (!cell) throw new Error(`no box ${index} on the floor`);
  await pageA.evaluate((c) => window.__mc.player.teleport(c[0] + 0.5, 31, c[1] + 0.5), cell);
  await waitFor(
    pageA,
    (n) => (window.__mc.party.items.get(window.__mc.net.id)?.length ?? 0) >= n,
    5000,
    `A picked box ${index} (hold ${heldCount})`,
    heldCount,
  );
  return cell;
}

/** Runs one part: fresh server (env knobs) + fresh match; pages stay open. */
async function runPart(name, extra, fn) {
  console.log(`\n[${name}] server restart + fresh match (${JSON.stringify(extra)})`);
  await stopServer(server);
  server = await startServer({ port: PORT, editsFile: EDITS_FILE, extraEnv: extra, resetEdits: false });
  await waitOnline(pageA, 'A');
  await waitOnline(pageB, 'B');
  await startPartyMatch();
  const idA = await pageA.evaluate(() => window.__mc.net.id);
  const idB = await pageB.evaluate(() => window.__mc.net.id);
  await fn(idA, idB);
  await pageA.evaluate(() => window.__mc.leaveGame());
  for (const [page, label] of [[pageA, 'A'], [pageB, 'B']]) {
    await waitFor(page, () => window.__mc.mode === 'sandbox' && window.__mc.party === null, 10_000, `${label} sandbox after ${name}`);
  }
}

try {
  // 0. build -----------------------------------------------------------------
  buildClient();
  await ensurePortFree(BASE, PORT);

  server = await startServer({ port: PORT, editsFile: EDITS_FILE, extraEnv: { PARTY_BOMB_RATE: '0' } }); // warm boot so pages can connect
  browser = await launch();
  pageA = await browser.newPage({ viewport: { width: 1024, height: 640 } });
  pageB = await browser.newPage({ viewport: { width: 1024, height: 640 } });
  watchErrors(pageA, errors, 'A');
  watchErrors(pageB, errors, 'B');
  await waitOnline(pageA, 'A');
  await waitOnline(pageB, 'B');

  // ========================================================================
  // PART 1 — SPEED: boxes, pickup, UI, hold cap, effect + expiry, lockout
  // ========================================================================
  await runPart('SPEED', { PARTY_BOMB_RATE: '0', PARTY_BOX_RATE: '1', PARTY_BOX_COUNT: '2', PARTY_ITEM: 'speed' }, async (idA, idB) => {
    // Round 1 has no boxes: let it resolve on its own (spawns are random
    // colors — any result advances the match to round 2).
    console.log('  [speed] round 2: boxes + pickups + caps');
    await waitAnnounce(2);

    // Boxes appear ~0.5 s into the announce on BOTH clients (event + state).
    await waitFor(pageA, () => (window.__mc.party.boxes?.length ?? 0) === 2, 6000, 'A sees 2 boxes (gameState)');
    await waitFor(pageB, () => (window.__mc.party.boxes?.length ?? 0) === 2, 4000, 'B sees 2 boxes (gameState)');
    const spawnEvents = await pageB.evaluate(() => window.__mc.party.events.filter((e) => e.kind === 'boxSpawned').length);
    check('round-2 boxes spawn on both clients (2 boxes, boxSpawned events)', spawnEvents >= 2, `boxSpawned on B=${spawnEvents}`);
    const threeSlots = await pageA.evaluate(() => document.querySelectorAll('#party-items .pitem').length);
    check('3 held-item slots rendered above the party HUD', threeSlots === 3, `slots=${threeSlots}`);

    // Walk-over pickups: teleport A onto each box cell.
    await pickBox(idA, 1, 0);
    const pickEvA = await pageA.evaluate((id) => {
      const ev = window.__mc.party.events.filter((e) => e.kind === 'boxPickedUp' && e.data.playerId === id).pop();
      return ev ? ev.data.item : null;
    }, idA);
    const toast = await toastOf(pageA);
    check('walk-over pickup grants the item (event + "✦ Got Speed!" toast)', pickEvA === 'speed' && toast.shown && toast.text.includes('Got Speed!'), `item=${pickEvA} toast="${toast.text}"`);
    await waitFor(pageB, (id) => (window.__mc.party.items.get(id)?.length ?? 0) === 1, 4000, 'B mirror sees A\'s item', idA);
    await pickBox(idA, 2, 0); // box list shifted after the first pickup
    const slotFilled = await pageA.evaluate(() => ({
      filled: document.querySelectorAll('#party-items .pitem.filled').length,
      label: document.querySelector('#party-items .pitem.filled .pitem-label')?.textContent ?? '',
    }));
    check('held items mirrored into the UI slots (icon + label)', slotFilled.filled === 2 && slotFilled.label === 'Speed', `filled=${slotFilled.filled} label="${slotFilled.label}"`);

    // Park both on good cells so round 2 ends predictably (both alive → draw).
    const r2 = await findGoodBad();
    await parkOn(pageA, r2.good);
    await parkOn(pageB, r2.good);

    // Round 3: hold-cap refusal at 3, then Speed use + lockout.
    console.log('  [speed] round 3: hold cap, effect, expiry, lockout');
    await waitAnnounce(3);
    const r3 = await findGoodBad();
    await pickBox(idA, 3, 0);
    const capCell = await pageA.evaluate(() => window.__mc.party.boxes[0] ?? null);
    await pageA.evaluate((c) => window.__mc.player.teleport(c[0] + 0.5, 31, c[1] + 0.5), capCell);
    await waitFor(
      pageA,
      () => document.getElementById('toast').textContent.includes('Satchel full'),
      5000,
      'hold-cap refusal toast',
    );
    const afterCap = await pageA.evaluate(() => ({
      held: window.__mc.party.items.get(window.__mc.net.id)?.length ?? 0,
      boxes: window.__mc.party.boxes.length,
    }));
    check('hold cap 3: 4th pickup refused, box stays on the floor', afterCap.held === 3 && afterCap.boxes === 1, `held=${afterCap.held} boxes=${afterCap.boxes}`);

    // Step OFF the refused box (a freed slot would re-grant it on the spot):
    // park on the good cell — unless the box sits on it, then the bad one.
    const parkCell =
      capCell && Math.hypot(capCell[0] - r3.good[0], capCell[1] - r3.good[1]) < 3 ? r3.bad : r3.good;
    await parkOn(pageA, parkCell);
    await pageA.evaluate(() => window.__mc.useItem(0));
    await waitFor(pageA, () => (window.__mc.player.effects.speedUntil ?? 0) > Date.now(), 4000, 'speed effect applied to the controller');
    const useEv = await pageA.evaluate((id) => window.__mc.party.events.some((e) => e.kind === 'itemUsed' && e.data.playerId === id && e.data.item === 'speed'), idA);
    const heldAfterUse = await pageA.evaluate(() => window.__mc.party.items.get(window.__mc.net.id)?.length ?? 0);
    check('using Speed consumes the item (itemUsed event, slot freed)', useEv && heldAfterUse === 2, `itemUsed=${useEv} held=${heldAfterUse}`);

    // Real movement: the controller's approach velocity converges to the
    // multiplied target (×1.4 × 4.3 ≈ 6.0; base walk is 4.3).
    const boosted = await measureSpeed(pageA);
    check(
      'Speed applies the ×1.4 movement multiplier (approach velocity ≈6.0 vs 4.3 base)',
      boosted > 4.9 && boosted <= 6.1,
      `converged vel.z=${boosted.toFixed(2)} m/s`,
    );

    // Final-2s lockout: use again near the deadline → rejected with a toast.
    await waitFor(pageA, () => window.__mc.party.roundEndsAt - Date.now() <= 1700, 8000, 'final-2s window');
    await pageA.evaluate(() => window.__mc.useItem(0));
    await sleep(350);
    const locked = await toastOf(pageA);
    check('use in the final 2 s rejected ("Locked — final 2 seconds!" toast)', locked.text.includes('Locked'), `toast="${locked.text}"`);

    // Park A again before the drop (the walk drifted it).
    await parkOn(pageA, r3.good);
    await parkOn(pageB, r3.good);

    // Boxes vanish at the drop; the Speed buff expires ~5 s after use.
    await waitFor(pageA, () => window.__mc.party.phase === 'drop' || window.__mc.party.phase === 'scored', 8000, 'round-3 drop');
    const boxesAfterDrop = await pageA.evaluate(() => window.__mc.party.boxes.length);
    await waitFor(pageA, () => window.__mc.player.effects.speedUntil < Date.now(), 8000, 'speed expiry');
    check('unclaimed boxes vanish at the drop; Speed expires after 5 s', boxesAfterDrop === 0, `boxes=${boxesAfterDrop}`);
  });

  // ========================================================================
  // PART 2 — JUMP BOOST: jump velocity 13 on the controller
  // ========================================================================
  await runPart('JUMP', { PARTY_BOMB_RATE: '0', PARTY_BOX_RATE: '1', PARTY_BOX_COUNT: '1', PARTY_ITEM: 'jump' }, async (idA) => {
    await waitAnnounce(2);
    await pickBox(idA, 1, 0);
    const jumpToast = await toastOf(pageA);
    await pageA.evaluate(() => window.__mc.useItem(0));
    await waitFor(pageA, () => window.__mc.player.effects.jumpUntil > Date.now(), 4000, 'jump effect applied');
    // Behavioral check: the boosted jump apex ≈ v²/2g = 13²/60 ≈ 2.8 blocks
    // (base jump 9 → 1.35). Frame-bound sampling shaves a little off the peak.
    const apex = await pageA.evaluate(async () => {
      const p = window.__mc.player;
      for (let i = 0; i < 60 && !p.onGround; i++) await new Promise((r) => requestAnimationFrame(r));
      const y0 = p.pos.y;
      let peak = 0;
      p.input.jump = true;
      const t0 = Date.now();
      while (Date.now() - t0 < 700) {
        peak = Math.max(peak, p.pos.y - y0);
        await new Promise((r) => requestAnimationFrame(r));
      }
      p.input.jump = false;
      return peak;
    });
    check('Jump Boost raises the jump apex to ≈2.8 blocks (base 1.35)', apex > 2.0 && apex <= 3.2, `apex=+${apex.toFixed(2)} blocks`);
    check('pickup toast names the item ("✦ Got Jump Boost!")', jumpToast.shown && jumpToast.text.includes('Jump'), `toast="${jumpToast.text}"`);
  });

  // ========================================================================
  // PART 3 — LEAP: impulse along look direction
  // ========================================================================
  await runPart('LEAP', { PARTY_BOMB_RATE: '0', PARTY_BOX_RATE: '1', PARTY_BOX_COUNT: '1', PARTY_ITEM: 'leap' }, async (idA) => {
    await waitAnnounce(2);
    await pickBox(idA, 1, 0);
    // The `leap` event carries the exact impulse (deterministic); a short
    // velocity poll confirms it physically reaches the player controller.
    const leap = await pageA.evaluate(async (id) => {
      const p = window.__mc.player;
      p.vel.set(0, 0, 0);
      p.look(0, 0); // face −Z (yaw 0)
      window.__mc.useItem(0);
      let maxH = 0;
      const t0 = performance.now();
      while (performance.now() - t0 < 250) {
        maxH = Math.max(maxH, Math.hypot(p.vel.x, p.vel.z));
        await new Promise((r) => requestAnimationFrame(r));
      }
      const ev = window.__mc.party.events.filter((e) => e.kind === 'leap' && e.data.playerId === id).pop();
      return { maxH, dir: ev ? ev.data.dir : null };
    }, idA);
    check(
      'Leap impulse event: +8 m/s along look (−Z), +5 m/s up',
      leap.dir !== null && Math.abs(leap.dir.y - 5) < 0.01 && Math.abs(Math.abs(leap.dir.z) - 8) < 0.01 && Math.abs(leap.dir.x) < 0.5,
      `dir=${JSON.stringify(leap.dir)}`,
    );
    check('Leap physically propels the player (horizontal speed peaks > 2 m/s)', leap.maxH > 2, `peak |vh|=${leap.maxH.toFixed(1)} m/s`);
    // Recover A onto a good cell so the round stays tidy.
    const r2 = await findGoodBad();
    await parkOn(pageA, r2.good);
    await parkOn(pageB, r2.good);
  });

  // ========================================================================
  // PART 4 — SWAPPER: both players trade positions
  // ========================================================================
  await runPart('SWAPPER', { PARTY_BOMB_RATE: '0', PARTY_BOX_RATE: '1', PARTY_BOX_COUNT: '1', PARTY_ITEM: 'swapper' }, async (idA, idB) => {
    await waitAnnounce(2);
    await pickBox(idA, 1, 0);
    await sleep(400); // settle: server roster == both clients' positions
    const before = {
      a: await pageA.evaluate(() => ({ x: window.__mc.player.pos.x, y: window.__mc.player.pos.y, z: window.__mc.player.pos.z })),
      b: await pageB.evaluate(() => ({ x: window.__mc.player.pos.x, y: window.__mc.player.pos.y, z: window.__mc.player.pos.z })),
    };
    await pageA.evaluate(() => window.__mc.useItem(0));
    await waitFor(pageA, (id) => window.__mc.party.events.some((e) => e.kind === 'swapped' && (e.data.aId === id || e.data.bId === id)), 5000, 'swapped event on A', idA);
    await waitFor(pageB, (id) => window.__mc.party.events.some((e) => e.kind === 'swapped' && (e.data.aId === id || e.data.bId === id)), 4000, 'swapped event on B', idB);
    await sleep(250); // both clients process their teleport
    const afterA = await pageA.evaluate(() => ({ x: window.__mc.player.pos.x, y: window.__mc.player.pos.y, z: window.__mc.player.pos.z }));
    const afterB = await pageB.evaluate(() => ({ x: window.__mc.player.pos.x, y: window.__mc.player.pos.y, z: window.__mc.player.pos.z }));
    const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
    const toastB = await toastOf(pageB);
    check(
      'Swapper trades both players\' positions (2-client assertion) + toasts',
      dist(afterA, before.b) < 0.75 && dist(afterB, before.a) < 0.75 && toastB.text.includes('Swapped'),
      `A moved ${dist(afterA, before.b).toFixed(2)} from B's old spot, B ${dist(afterB, before.a).toFixed(2)} from A's, B toast="${toastB.text}"`,
    );
  });

  // ========================================================================
  // PART 5 — COLOR TELEPORTER: safe-cell landing, cap 1, mid-fall + lockout
  // ========================================================================
  await runPart('WARP', { PARTY_BOMB_RATE: '0', PARTY_BOX_RATE: '1', PARTY_BOX_COUNT: '2', PARTY_ITEM: 'teleporter' }, async (idA) => {
    console.log('  [warp] round 2: teleporter cap + successful warp');
    await waitAnnounce(2);
    await pickBox(idA, 1, 0);
    const capCell = await pageA.evaluate(() => window.__mc.party.boxes[0] ?? null);
    await pageA.evaluate((c) => window.__mc.player.teleport(c[0] + 0.5, 31, c[1] + 0.5), capCell);
    await waitFor(pageA, () => document.getElementById('toast').textContent.includes('Only one Color Teleporter'), 5000, 'teleporter-cap refusal toast');
    const capState = await pageA.evaluate(() => ({
      held: [...(window.__mc.party.items.get(window.__mc.net.id) ?? [])],
      boxes: window.__mc.party.boxes.length,
    }));
    check('teleporter cap 1: second box refused, box stays', capState.held.join(',') === 'teleporter' && capState.boxes === 1, `held=[${capState.held}] boxes=${capState.boxes}`);

    await pageA.evaluate(() => window.__mc.useItem(0));
    await waitFor(pageA, (id) => window.__mc.party.events.some((e) => e.kind === 'teleported' && e.data.playerId === id), 5000, 'teleported event', idA);
    await sleep(200);
    const landed = await pageA.evaluate((floor) => {
      const p = window.__mc.player.pos;
      return {
        x: p.x, y: p.y, z: p.z,
        cellColor: window.__mc.world.getBlock(Math.floor(p.x), floor.y, Math.floor(p.z)),
        colorId: window.__mc.party.colorId,
      };
    }, FLOOR);
    check('Color Teleporter lands the user on an announced-color cell', landed.cellColor === landed.colorId && Math.abs(landed.y - 31) < 0.2, `cell=${landed.cellColor} vs ${landed.colorId} y=${landed.y.toFixed(2)}`);

    console.log('  [warp] round 3: mid-fall refusal + lockout');
    await waitAnnounce(3);
    await pickBox(idA, 1, 0); // hold 1 again (round 2's was consumed)
    await pageA.evaluate(() => {
      const p = window.__mc.player;
      p.teleport(100, 20, 64); // off the floor, below floor level — mid-fall
      p.vel.set(0, -5, 0);
    });
    await sleep(400); // relay the falling position
    await pageA.evaluate(() => window.__mc.useItem(0));
    await sleep(350);
    const falling = await toastOf(pageA);
    const noTeleport = await pageA.evaluate((id) => {
      const events = window.__mc.party.events.filter((e) => e.kind === 'teleported' && e.data.playerId === id);
      const last = events[events.length - 1];
      return !last || last.data.y > 30; // no NEW teleport while falling
    }, idA);
    check('use while mid-fall refused ("Can\'t teleport while falling!")', falling.text.includes('falling') && noTeleport, `toast="${falling.text}" moved=${!noTeleport}`);

    // Recover before the drop, then the final-2s lockout (same guard, any item).
    const r3 = await findGoodBad();
    await parkOn(pageA, r3.good);
    await parkOn(pageB, r3.good);
    await waitFor(pageA, () => window.__mc.party.roundEndsAt - Date.now() <= 1700, 8000, 'final-2s window');
    await pageA.evaluate(() => window.__mc.useItem(0));
    await sleep(350);
    const locked = await toastOf(pageA);
    check('teleporter locked in the final 2 s (toast)', locked.text.includes('Locked'), `toast="${locked.text}"`);
  });

  // ========================================================================
  // PART 6 — SPECTATE COLOR ZAPPER: one revenge shot after falling
  // ========================================================================
  await runPart('ZAPPER', { PARTY_BOMB_RATE: '0', PARTY_BOX_RATE: '0' }, async (idA, idB) => {
    console.log('  [zapper] round 1: B falls, then zaps one surviving cell');
    await waitAnnounce(1);
    const r1 = await findGoodBad();
    await parkOn(pageA, r1.good);
    await parkOn(pageB, r1.bad); // B stands wrong → falls at the drop
    await waitFor(pageA, () => window.__mc.party.phase === 'drop', 12_000, 'round-1 drop');
    await waitFor(pageB, (id) => window.__mc.party.events.some((e) => e.kind === 'death' && e.data.playerId === id), 8000, 'B death event', idB);
    await waitFor(pageB, () => window.__mc.zapper.armed === true, 4000, 'B zapper armed');
    const hintShown = await pageB.evaluate(() => !document.getElementById('party-zapper').classList.contains('hidden'));
    check('after falling, the zapper arms + hint shows', hintShown, `hint visible=${hintShown}`);

    // B aims the spectate camera at a surviving cell ≥3 away from A's parked
    // spot (the zap threatens but does not directly doom the survivor) + clicks.
    const aCell = await pageA.evaluate(() => [Math.floor(window.__mc.player.pos.x), Math.floor(window.__mc.player.pos.z)]);
    const target = await pageB.evaluate(({ floor, away }) => {
      const colorId = window.__mc.party.colorId;
      for (let z = floor.minZ; z <= floor.maxZ; z++) {
        for (let x = floor.minX; x <= floor.maxX; x++) {
          if (window.__mc.world.getBlock(x, floor.y, z) !== colorId) continue;
          if (Math.hypot(x - away[0], z - away[1]) < 3) continue;
          window.__zapTarget = [x, z];
          return [x, z];
        }
      }
      return null;
    }, { floor: FLOOR, away: aCell });
    if (!target) throw new Error('no surviving cell ≥3 away from A found');
    // Hover B just above/behind the target so the aim ray hits exactly that
    // cell (from the platform the line of sight grazes nearer blocks first —
    // correct aim behavior, awkward for a fixed assertion).
    await pageB.evaluate((cell) => {
      window.__mc.player.teleport(cell[0] + 0.5, 34.5, cell[1] + 4.5);
      window.__mc.player.vel.set(0, 0, 0);
    }, target);
    await sleep(250); // frames: camera follows the hover position
    const aimed = await pageB.evaluate((cell) => {
      window.__mc.lookAt(cell[0] + 0.5, 30.5, cell[1] + 0.5);
      return window.__mc.zapUnderCrosshair();
    }, target);
    check('B clicks a floor tile → zapCell sent (raycast path)', aimed === true, `target=(${target}) sent=${aimed}`);

    await waitFor(pageA, (cell) => window.__mc.world.getBlock(cell[0], 30, cell[1]) === 0, 5000, 'zapped cell removed on A', target);
    await waitFor(pageB, (cell) => window.__mc.world.getBlock(cell[0], 30, cell[1]) === 0, 4000, 'zapped cell removed on B', target);
    const zappedBoth = {
      a: await pageA.evaluate((id) => window.__mc.party.events.some((e) => e.kind === 'cellZapped' && e.data.by === id), idB),
      b: await pageB.evaluate((id) => window.__mc.party.events.some((e) => e.kind === 'cellZapped' && e.data.by === id), idB),
    };
    const usedNow = await pageB.evaluate(() => window.__mc.zapper.used === true);
    check('cellZapped + cell removed on BOTH clients; zapper spent', zappedBoth.a && zappedBoth.b && usedNow, `A=${zappedBoth.a} B=${zappedBoth.b} used=${usedNow}`);

    // Second zap rejected: pick another surviving cell, send directly.
    const second = await pageB.evaluate((floor) => {
      const colorId = window.__mc.party.colorId;
      for (let z = floor.minZ; z <= floor.maxZ; z++) {
        for (let x = floor.minX; x <= floor.maxX; x++) {
          if (window.__mc.world.getBlock(x, floor.y, z) === colorId && !(window.__zapTarget[0] === x && window.__zapTarget[1] === z)) {
            window.__zapTarget2 = [x, z];
            window.__mc.sendZapCell(x, z);
            return [x, z];
          }
        }
      }
      return null;
    }, FLOOR);
    await sleep(600);
    const secondState = await pageB.evaluate((floor) => ({
      solid: window.__mc.world.getBlock(window.__zapTarget2[0], floor.y, window.__zapTarget2[1]) !== 0,
      zaps: window.__mc.party.events.filter((e) => e.kind === 'cellZapped').length,
      toast: document.getElementById('toast').textContent,
    }), FLOOR);
    check('second zap rejected (cell survives, no second cellZapped)', second !== null && secondState.solid && secondState.zaps === 1 && secondState.toast.includes('No zap'), `cell solid=${secondState.solid} cellZapped=${secondState.zaps} toast="${secondState.toast}"`);

    // The zap must not break scoring: A (parked on a good cell) takes the round.
    await waitFor(pageA, (id) => window.__mc.party.events.some((e) => e.kind === 'roundResult' && e.data.survivorId === id), 9000, 'roundResult survivor=A', idA);
    check('round still scores normally after the zap (survivor A)', true, 'roundResult arrived');
    // The zapper window closes with the round.
    await waitFor(pageB, () => window.__mc.zapper.armed === false || window.__mc.party.phase === 'intermission', 15_000, 'zapper disarmed next round');
  });

  // 9. clean pages ------------------------------------------------------------
  check('no page errors', errors.length === 0, errors.length ? errors.slice(0, 5).join(' | ') : 'none');

  finish('SMOKE-POWERUPS', errors);
} catch (error) {
  console.error(`SMOKE-POWERUPS FAILED: ${error.message}`);
  const tail = server?.logTail?.() ?? '';
  if (tail) console.error(`--- server log tail ---\n${tail}`);
  process.exitCode = 1;
} finally {
  await teardown({ browser, server, editsFile: EDITS_FILE });
}
