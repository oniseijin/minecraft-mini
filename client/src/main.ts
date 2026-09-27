import { PROTOCOL_VERSION } from '@mc/shared';
import { createRenderer } from './renderer';
import { createFlyControls } from './flyControls';
import { createFpsCounter } from './fps';

console.log(`minecraft-mini client (protocol v${PROTOCOL_VERSION})`);

const app = document.querySelector<HTMLDivElement>('#app')!;
const overlay = document.querySelector<HTMLDivElement>('#overlay')!;
const debug = document.querySelector<HTMLDivElement>('#debug')!;

const { renderer, camera, render, dispose } = createRenderer(app);
const controls = createFlyControls(camera, renderer.domElement, overlay);
const fps = createFpsCounter(debug);

const MAX_DT = 0.1; // clamp tab-switch / stall spikes

let last = performance.now();
function frame(now: number) {
  const dt = Math.min((now - last) / 1000, MAX_DT);
  last = now;
  controls.update(dt);
  render(dt);
  fps.tick(now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.addEventListener('pagehide', dispose, { once: true });
