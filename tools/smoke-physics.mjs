// Headless physics smoke test for the minecraft-mini client (M2).
// Usage: node tools/smoke-physics.mjs [url]   (default http://localhost:5173)
// Requires the dev server (npm run dev) on the URL.
//
// Drives the player controller through its __mc.player test hooks (input
// override, teleport, tryPlace) and asserts gravity/collision, jumping, walk
// speed, placement rejection, creative fly and the mouse-sensitivity controls.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:5173';
const outDir = 'tools/smoke-out';
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
  return ok;
}

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__mc !== undefined, null, { timeout: 60_000 });

  /** Teleports the player and resolves once it rests on the ground. */
  const settle = (x, y, z) =>
    page.evaluate(async ({ x, y, z }) => {
      const p = window.__mc.player;
      p.teleport(x, y, z);
      const t0 = performance.now();
      while (!p.onGround && performance.now() - t0 < 5000) {
        await new Promise((r) => setTimeout(r, 25));
      }
      await new Promise((r) => setTimeout(r, 100)); // one extra tick of rest
      return { y: p.pos.y, onGround: p.onGround };
    }, { x, y, z });

  // --- 1. gravity + collision: falls onto the terrain and rests on it -------
  console.log('[1] gravity & collision');
  const groundY = await page.evaluate(() => window.__mc.world.highestBlock(140, 140) + 1);
  const rest = await settle(140.5, 60, 140.5);
  check('teleport falls and lands onGround', rest.onGround, `onGround=${rest.onGround} y=${rest.y.toFixed(4)}`);
  check(
    'rests at highestBlock+1 (±0.01)',
    Math.abs(rest.y - groundY) <= 0.01,
    `y=${rest.y.toFixed(4)} expected ${groundY}`,
  );
  await page.waitForTimeout(1000);
  const still = await page.evaluate(() => window.__mc.player.pos.y);
  check('no sinking after +1s', Math.abs(still - rest.y) <= 0.01, `y=${still.toFixed(4)}`);

  // --- 2. jump: rises ≥ 1 block, lands back ---------------------------------
  console.log('[2] jump');
  const jump = await page.evaluate(async () => {
    const p = window.__mc.player;
    const y0 = p.pos.y;
    p.jump();
    let maxY = y0;
    let airborne = false;
    const t0 = performance.now();
    while (performance.now() - t0 < 2000) {
      await new Promise((r) => setTimeout(r, 16));
      maxY = Math.max(maxY, p.pos.y);
      if (!p.onGround) airborne = true;
      else if (airborne) break;
    }
    return { y0, maxY, yFinal: p.pos.y, onGround: p.onGround };
  });
  check(
    'jump apex ≥ 1.0 block',
    jump.maxY - jump.y0 >= 1.0,
    `apex ${(jump.maxY - jump.y0).toFixed(3)} blocks`,
  );
  check(
    'lands back on the ground',
    jump.onGround && Math.abs(jump.yFinal - jump.y0) <= 0.01,
    `y ${jump.y0.toFixed(3)} → ${jump.yFinal.toFixed(3)}`,
  );

  // --- 3. walk speed ≈ 4.3 m/s on a flattened runway ------------------------
  console.log('[3] walk');
  const walk = await page.evaluate(async () => {
    const mc = window.__mc;
    const p = mc.player;
    // Stone runway along +X at z=140, walking surface at y=32 (physics only —
    // the world renderer is not remeshed, which does not affect collision).
    for (let x = 132; x <= 168; x++) {
      mc.world.setBlock(x, 31, 140, 3);
      for (let y = 32; y <= 42; y++) mc.world.setBlock(x, y, 140, 0);
    }
    p.teleport(136.5, 32, 140.5);
    p.look(-Math.PI / 2, 0); // yaw -90° faces +X
    const t0 = performance.now();
    while (!p.onGround && performance.now() - t0 < 3000) {
      await new Promise((r) => setTimeout(r, 25));
    }
    await new Promise((r) => setTimeout(r, 200)); // fully settle
    const sx = p.pos.x;
    const sz = p.pos.z;
    p.input.forward = true; // input override works without pointer lock
    const start = performance.now();
    await new Promise((r) => setTimeout(r, 1000));
    p.input.forward = false;
    const dt = (performance.now() - start) / 1000;
    const dist = Math.hypot(p.pos.x - sx, p.pos.z - sz);
    return { dist, dt, speed: dist / dt };
  });
  check(
    'walk displacement ≈ 4.3 m ±20% over 1s',
    Math.abs(walk.speed - 4.3) <= 4.3 * 0.2,
    `${walk.speed.toFixed(2)} m/s (${walk.dist.toFixed(2)} m in ${walk.dt.toFixed(2)} s)`,
  );

  // --- 4. creative fly + gravity off ----------------------------------------
  console.log('[4] fly');
  const fly = await page.evaluate(async () => {
    const p = window.__mc.player;
    await new Promise((r) => setTimeout(r, 300)); // let walk momentum die
    p.teleport(140.5, 32, 140.5);
    const t0 = performance.now();
    while (!p.onGround && performance.now() - t0 < 3000) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const y0 = p.pos.y;
    p.flying = true;
    p.input.jump = true; // Space = ascend while flying
    await new Promise((r) => setTimeout(r, 800));
    const yUp = p.pos.y;
    const vy = p.vel.y;
    p.input.jump = false;
    p.flying = false;
    const t1 = performance.now();
    while (!p.onGround && performance.now() - t1 < 5000) {
      await new Promise((r) => setTimeout(r, 25));
    }
    return { y0, yUp, vy, yBack: p.pos.y, grounded: p.onGround };
  });
  check(
    'fly ascends, no gravity (vy > 0 while rising)',
    fly.yUp - fly.y0 > 3 && fly.vy > 5,
    `Δy=${(fly.yUp - fly.y0).toFixed(2)} vy=${fly.vy.toFixed(2)}`,
  );
  check('falls back to ground after fly off', fly.grounded, `y=${fly.yBack.toFixed(3)}`);

  // --- 5. placement rejected inside the player AABB -------------------------
  console.log('[5] placement validation');
  const place = await page.evaluate(async () => {
    const mc = window.__mc;
    const p = mc.player;
    p.teleport(140.5, 32, 140.5);
    const t0 = performance.now();
    while (!p.onGround && performance.now() - t0 < 3000) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const cx = Math.floor(p.pos.x);
    const cy = Math.floor(p.pos.y);
    const cz = Math.floor(p.pos.z);
    const feetRejected = mc.tryPlace(cx, cy, cz) === false;
    const bodyRejected = mc.tryPlace(cx, cy + 1, cz) === false;
    const clearCell = [cx + 3, cy + 2, cz]; // outside the AABB
    const clearOk = mc.tryPlace(...clearCell);
    const becameSolid = mc.world.getBlock(...clearCell) !== 0;
    mc.world.setBlock(...clearCell, 0); // clean up
    return { cell: [cx, cy, cz], feetRejected, bodyRejected, clearOk, becameSolid };
  });
  check(
    'placement into feet cell rejected',
    place.feetRejected,
    `cell ${place.cell.join(',')}`,
  );
  check(
    'placement into body cell rejected',
    place.bodyRejected,
    `cell ${place.cell[0]},${place.cell[1] + 1},${place.cell[2]}`,
  );
  check(
    'placement into a free cell still works',
    place.clearOk && place.becameSolid,
    `cell ${place.cell[0] + 3},${place.cell[1] + 2},${place.cell[2]}`,
  );

  // --- 6. mouse sensitivity keys, toast, persistence ------------------------
  console.log('[6] mouse sensitivity');
  const sens0 = await page.evaluate(() => ({
    sensitivity: window.__mc.player.sensitivity,
    stored: localStorage.getItem('mc-sensitivity'),
  }));
  check(
    'default sensitivity 0.0032',
    sens0.sensitivity === 0.0032 && sens0.stored === null,
    `sensitivity=${sens0.sensitivity} stored=${sens0.stored}`,
  );

  await page.keyboard.press('BracketRight');
  const sens1 = await page.evaluate(() => ({
    sensitivity: window.__mc.player.sensitivity,
    stored: Number(localStorage.getItem('mc-sensitivity')),
    toast: document.querySelector('#toast')?.textContent ?? '',
    shown: document.querySelector('#toast')?.classList.contains('show') ?? false,
  }));
  check(
    "']' raises sensitivity ×1.1 + toast + persisted",
    Math.abs(sens1.sensitivity - 0.00352) < 1e-9 &&
      Math.abs(sens1.stored - 0.00352) < 1e-9 &&
      sens1.shown &&
      /Mouse sensitivity: 0\.0035/.test(sens1.toast),
    JSON.stringify(sens1),
  );

  await page.keyboard.press('BracketLeft');
  const sens2 = await page.evaluate(() => window.__mc.player.sensitivity);
  check("'[' lowers sensitivity back to 0.0032", Math.abs(sens2 - 0.0032) < 1e-9, `${sens2}`);

  for (let i = 0; i < 30; i++) await page.keyboard.press('BracketRight');
  const sensMax = await page.evaluate(() => window.__mc.player.sensitivity);
  check("']' clamps at 0.01", sensMax === 0.01, `${sensMax}`);
  for (let i = 0; i < 60; i++) await page.keyboard.press('BracketLeft');
  const sensMin = await page.evaluate(() => window.__mc.player.sensitivity);
  check("'[' clamps at 0.0008", sensMin === 0.0008, `${sensMin}`);

  await page.waitForTimeout(1900);
  const toastFaded = await page.evaluate(
    () => !document.querySelector('#toast').classList.contains('show'),
  );
  check('toast fades out', toastFaded, `shown=${!toastFaded}`);

  await page.screenshot({ path: `${outDir}/physics.png` });

  // reload → persisted sensitivity is restored on start
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__mc !== undefined, null, { timeout: 60_000 });
  const sensAfter = await page.evaluate(() => window.__mc.player.sensitivity);
  check('sensitivity persists across reload', sensAfter === 0.0008, `${sensAfter}`);

  const failed = results.filter((r) => !r.ok);
  console.log(
    errors.length ? `\nerrors:\n${errors.join('\n')}` : '\npage errors: none',
  );
  writeFileSync(
    `${outDir}/physics-report.json`,
    JSON.stringify({ results, errors }, null, 2),
  );
  if (failed.length > 0 || errors.length > 0) {
    console.error(`\nSMOKE-PHYSICS FAILED: ${failed.length} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log(`\nSMOKE-PHYSICS PASSED (${results.length} checks)`);
  }
} finally {
  await browser.close();
}
