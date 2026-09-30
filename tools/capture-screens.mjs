// README screenshot capture — boots a private server on an isolated 809x port
// (dist-test build, temp edits file — never the live client/dist or :6881),
// drives the REAL UI paths (title card → Esc menu → the actual game buttons,
// exactly like smoke-solo), aims the camera through the __mc test hooks, and
// saves four shots into docs/screenshots/ (PNG first; the caller converts to
// JPEG so the repo stays light).
//
// Usage: node tools/capture-screens.mjs [PORT=8097]  (SKIP_BUILD=1 reuses dist-test)
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { buildClient, openPage, startServer, teardown } from './lib.mjs';

const PORT = Number(process.env.PORT || 8097);
const OUT_DIR = path.resolve('docs/screenshots');
const BASE = `http://localhost:${PORT}`;

const shot = (page, name) => page.screenshot({ path: path.join(OUT_DIR, name) });

/** Click the overlay's backdrop corner → back to the game view. */
const hideMenu = async (page) => {
  if ((await page.locator('#overlay:not(.hidden)').count()) > 0) {
    await page.locator('#overlay').click({ position: { x: 40, y: 40 } });
    await page.waitForTimeout(400);
  }
  if ((await page.locator('#overlay:not(.hidden)').count()) > 0) {
    throw new Error('menu overlay did not dismiss — screenshot would show it');
  }
};

mkdirSync(OUT_DIR, { recursive: true });
buildClient('screens');

const editsFile = path.resolve(`tools/smoke-out/screens-edits-${PORT}.json`);
const server = await startServer({
  port: PORT,
  editsFile,
  extraEnv: { MC_MOB_FORCE_DAY: '1', MC_DAY_T: '0.25' }, // bright midday sky
});

let browser;
const errors = [];
try {
  const { browser: b, page } = await openPage({
    base: BASE,
    errors,
    viewport: { width: 1280, height: 720 },
  });
  browser = b;

  // The F3 debug overlay renders by default and is not wanted in shots.
  await page.evaluate(() => {
    const d = document.querySelector('#debug');
    if (d) d.style.display = 'none';
  });

  // [1] Title card over the freshly meshed island.
  await page.waitForTimeout(1500);
  await shot(page, 'title.png');
  console.log('[screens] title.png');

  // [2] Sandbox — enter the world, give wildlife a moment to wander in.
  // Steep-ish pitch keeps terrain filling the frame instead of fog horizon.
  await hideMenu(page);
  await page.waitForTimeout(4000);
  await page.evaluate(() => window.__mc.look(0.7, -0.55));
  await page.waitForTimeout(700);
  await shot(page, 'sandbox.png');
  console.log('[screens] sandbox.png');

  // [3] BedWars solo practice — via the test hook, facing mid/east.
  // (Escape cannot reopen the menu under headless pointer lock; the hook
  // path is the one smoke-solo verifies end-to-end anyway.)
  await page.evaluate(() => window.__mc.startBedwars());
  await page.waitForFunction(() => window.__mc?.mode === 'bedwars', null, { timeout: 30_000 });
  await page.waitForTimeout(2500); // arena mesh
  await hideMenu(page);
  await page.evaluate(() => window.__mc.look(-Math.PI / 2, -0.22));
  await page.waitForTimeout(700);
  await shot(page, 'bedwars.png');
  console.log('[screens] bedwars.png');

  // [4] Block Party solo — wait for a color announcement so the HUD swatch shows.
  await page.evaluate(() => window.__mc.leaveGame());
  await page.waitForFunction(() => window.__mc?.mode === 'sandbox', null, { timeout: 30_000 });
  await page.waitForTimeout(1500); // island remesh
  await page.evaluate(() => window.__mc.startParty());
  await page.waitForFunction(() => window.__mc?.mode === 'party', null, { timeout: 30_000 });
  await page.waitForFunction(
    () => window.__mc?.party?.phase === 'announce',
    null,
    { timeout: 20_000 },
  );
  await page.waitForTimeout(1200); // swatch + bar fully in view
  await hideMenu(page);
  await page.evaluate(() => window.__mc.look(0.7, -0.5));
  await page.waitForTimeout(500);
  await shot(page, 'blockparty.png');
  console.log('[screens] blockparty.png');

  // [5] Murder Mystery solo — manor + a guest in frame + the Detective HUD.
  await page.evaluate(() => window.__mc.leaveGame());
  await page.waitForFunction(() => window.__mc?.mode === 'sandbox', null, { timeout: 30_000 });
  await page.evaluate(() => window.__mc.startMurder());
  await page.waitForFunction(() => window.__mc?.mode === 'murder', null, { timeout: 30_000 });
  await page.waitForFunction(
    () => [...window.__mc?.mobs?.values() ?? []].some((m) => m.kind === 'guest'),
    null,
    { timeout: 20_000 },
  );
  await page.waitForTimeout(2000); // manor mesh + guests wander in
  await hideMenu(page);
  // Aim point-blank at the nearest guest — a readable nameplate anchors the shot.
  await page.evaluate(() => {
    const me = window.__mc.player.pos;
    let best = null;
    let bestDist = Infinity;
    for (const m of window.__mc.mobs.values()) {
      if (m.kind !== 'guest') continue;
      const d = Math.hypot(m.position.x - me.x, m.position.z - me.z);
      if (d < bestDist) { best = m; bestDist = d; }
    }
    if (best) {
      const g = best.position;
      const len = Math.hypot(g.x - me.x, g.z - me.z) || 1;
      const near = { x: g.x + ((me.x - g.x) / len) * 2.5, z: g.z + ((me.z - g.z) / len) * 2.5 };
      window.__mc.player.teleport(near.x, g.y, near.z);
      window.__mc.lookAt(g.x, g.y + 1.3, g.z);
    } else {
      window.__mc.look(me.x, me.y + 1, me.z - 6);
    }
  });
  await page.waitForTimeout(700);
  await shot(page, 'murder.png');
  console.log('[screens] murder.png');

  if (errors.length > 0) {
    console.error(`[screens] page errors:\n${errors.join('\n')}`);
    process.exitCode = 1;
  }
} finally {
  await teardown({ browser, server, editsFile });
}
