// Headless smoke test for the minecraft-mini client.
// Usage: node tools/smoke.mjs [url]   (default http://localhost:5173)
// Requires the dev server (npm run dev) or a built client on :8080.
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

await page.goto(url, { waitUntil: 'domcontentloaded' });

// wait for boot to finish (dev hook appears when the world is ready)
try {
  await page.waitForFunction(() => window.__mc !== undefined, null, { timeout: 60_000 });
} catch {
  const status = await page.textContent('#overlay-status').catch(() => '?');
  console.error(`FAIL: boot did not finish (status: ${status})`);
  console.error(errors.join('\n'));
  await page.screenshot({ path: `${outDir}/fail.png` });
  process.exit(1);
}

const report = await page.evaluate(async () => {
  const mc = window.__mc;
  const placed = mc.world.setBlock(126, 37, 128, 8);
  const broke = mc.world.setBlock(128, 34, 126, 0);
  await new Promise((r) => setTimeout(r, 800)); // remesh + a few frames
  const ray = mc.raycastFromCamera();
  return {
    edits: mc.world.edits.size,
    placedOk: mc.world.getBlock(126, 37, 128) === 8,
    placedDirty: placed.length,
    brokeDirty: broke.length,
    ray: ray ? [ray.x, ray.y, ray.z] : null,
    debug: document.querySelector('#debug')?.textContent ?? '',
  };
});

// let ~3s of frames accumulate for a meaningful FPS read, angled view for the screenshot
await page.evaluate(() => { window.__mc.look(0.6, -0.45); });
await page.waitForTimeout(3000);
const fps = await page.evaluate(() => document.querySelector('#debug')?.textContent?.split('\n')[0] ?? '');
await page.screenshot({ path: `${outDir}/smoke.png` });

console.log('boot: OK');
console.log('interaction:', JSON.stringify(report));
console.log('fps line:', fps);
console.log(errors.length ? `errors:\n${errors.join('\n')}` : 'page errors: none');
writeFileSync(`${outDir}/report.json`, JSON.stringify({ report, fps, errors }, null, 2));
await browser.close();
