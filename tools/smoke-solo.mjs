// Solo-practice smoke test: ONE player starts both games by clicking the REAL
// menu buttons (covers the manual click path, not just internal hooks).
// Builds the client to client/dist-test (npm run build:test — the live
// client/dist is never touched) and boots its own server against it.
// Usage: PORT=8099 node tools/smoke-solo.mjs   (SKIP_BUILD=1 reuses the build)
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.PORT ?? 8099);
const BASE = `http://localhost:${PORT}`;
const editsFile = join(mkdtempSync(join(tmpdir(), 'mc-solo-')), 'edits.json');

if (process.env.SKIP_BUILD !== '1') {
  console.log('[build] vite build → client/dist-test (live client/dist untouched)…');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const build = spawnSync(npm, ['run', 'build:test'], { cwd: process.cwd(), stdio: 'inherit' });
  if (build.status !== 0) throw new Error('client test build failed');
} else {
  console.log('[build] skipped (SKIP_BUILD=1)');
}

let server;
const startServer = () =>
  new Promise((resolve, reject) => {
    server = spawn('npm', ['start'], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(PORT), MC_EDITS_FILE: editsFile, MC_CLIENT_DIST: 'client/dist-test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', (d) => process.stdout.write(`[srv] ${d}`));
    server.stderr.on('data', (d) => process.stderr.write(`[srv!] ${d}`));
    const t = setTimeout(() => reject(new Error('server start timeout')), 15000);
    server.stdout.on('data', function wait(d) {
      if (String(d).includes('listening') || String(d).includes(String(PORT))) {
        clearTimeout(t);
        server.stdout.off('data', wait);
        resolve();
      }
    });
  });

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
});

try {
  await startServer();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__mc !== undefined, null, { timeout: 60000 });
  await page.waitForFunction(
    () => window.__mc?.net?.mode === 'online',
    null,
    { timeout: 15000 },
  );
  console.log('[1] solo menu state');
  const bwEnabled = await page.locator('#bw-start').isEnabled();
  const partyEnabled = await page.locator('#party-start').isEnabled();
  const hint = await page.textContent('#match-hint');
  check('BedWars button enabled while solo', bwEnabled);
  check('Block Party button enabled while solo', partyEnabled);
  check('hint mentions solo practice', /solo practice/i.test(hint ?? ''), JSON.stringify(hint));

  console.log('[1b] player guide panel');
  await page.locator('#help-btn').click();
  await page.waitForSelector('#help-panel:not(.hidden)');
  const guide = await page.textContent('#help-panel');
  check('guide opens with mode sections', /How to play/.test(guide ?? '') && /Block Party/.test(guide ?? ''));
  check('guide answers the mystery-box question', /walk into it/i.test(guide ?? '') && /1, 2 or 3/i.test(guide ?? ''));
  check('guide says how to punch', /punch = left-click/i.test(guide ?? ''));
  await page.locator('#help-close').click();
  check('guide closes via its button', await page.locator('#help-panel.hidden').count() === 1);

  console.log('[2] solo BedWars via REAL button click');
  await page.locator('#bw-start').click();
  await page.waitForFunction(() => window.__mc?.mode === 'bedwars', null, { timeout: 30000 });
  check('mode switched to bedwars', true);
  const bedBlock = await page.evaluate(() => {
    const w = window.__mc.world;
    // scan the red island region for its bed block (13)
    for (let y = 25; y < 40; y++) {
      for (let x = 56; x < 74; x++) {
        for (let z = 56; z < 74; z++) {
          const id = w.getBlock(x, y, z);
          if (id === 13) return { id, at: [x, y, z] };
        }
      }
    }
    return { id: 0, at: null };
  });
  check('red island bed block present', bedBlock.id === 13, JSON.stringify(bedBlock));

  console.log('[3] back to sandbox, then solo Block Party via REAL button click');
  await page.locator('#bw-leave').click();
  await page.waitForFunction(() => window.__mc?.mode === 'sandbox', null, { timeout: 30000 });
  await page.locator('#party-start').click();
  await page.waitForFunction(() => window.__mc?.mode === 'party', null, { timeout: 30000 });
  check('mode switched to party', true);
  const floorCell = await page.evaluate(() => {
    const w = window.__mc.world;
    return w.getBlock(128, 30, 64);
  });
  check('party floor block present at (128,30,64)', floorCell >= 20, `id=${floorCell}`);

  await page.locator('#bw-leave').click();
  await page.waitForFunction(() => window.__mc?.mode === 'sandbox', null, { timeout: 30000 });
  const sandboxOk = await page.evaluate(() => window.__mc.world.getBlock(128, 34, 128));
  check('sandbox world restored (terrain at spawn)', sandboxOk !== 0, `id=${sandboxOk}`);

  console.log('[4] held-item viewmodel (sandbox, M7.5)');
  const held0 = await page.evaluate(() => window.__mc.heldItem);
  check(
    'viewmodel shows the selected hotbar block as a cube (slot 1 = grass)',
    held0?.kind === 'cube' && held0?.blockId === 1,
    JSON.stringify(held0),
  );
  await page.keyboard.press('Digit3'); // slot 3 = stone in HOTBAR_BLOCKS
  await page.waitForFunction(() => window.__mc?.heldItem?.blockId === 3, null, { timeout: 5000 });
  const held1 = await page.evaluate(() => window.__mc.heldItem);
  check('selecting slot 3 swaps the viewmodel cube to stone', held1?.kind === 'cube' && held1?.blockId === 3, JSON.stringify(held1));
  const breakTarget = await page.evaluate(() => {
    const w = window.__mc.world;
    const p = window.__mc.player.pos; // stay inside the server's 8-block edit reach
    const px = Math.floor(p.x);
    const py = Math.floor(p.y);
    const pz = Math.floor(p.z);
    for (let y = py - 3; y <= py + 1; y++) {
      for (let x = px - 2; x <= px + 2; x++) {
        for (let z = pz - 2; z <= pz + 2; z++) {
          const id = w.getBlock(x, y, z);
          if (id !== 0 && id !== 12) return { x, y, z }; // non-air, non-bedrock
        }
      }
    }
    return null;
  });
  check('found a breakable block near spawn', breakTarget !== null);
  if (breakTarget) {
    await page.evaluate((t) => window.__mc.breakBlockAt(t.x, t.y, t.z), breakTarget);
    const heldSwing = await page.evaluate(() => window.__mc.heldItem);
    check('break click triggers the swing arc', heldSwing?.swinging === true, JSON.stringify(heldSwing));
    await page.waitForFunction(() => window.__mc?.heldItem?.swinging === false, null, { timeout: 2000 });
    check('swing settles after ~250 ms', true);
  }

  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (err) {
  console.error('SOLO SMOKE CRASHED:', err);
  failures++;
} finally {
  await browser.close().catch(() => {});
  if (server) {
    server.kill('SIGINT');
    await new Promise((r) => setTimeout(r, 800));
    server.kill('SIGKILL');
  }
  try { rmSync(join(editsFile, '..'), { recursive: true, force: true }); } catch {}
}

if (failures) {
  console.error(`SMOKE-SOLO FAILED: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('SMOKE-SOLO PASSED');
