import * as THREE from 'three';

const SKY_COLOR = 0x87ceeb;
/** Fog band matched to the render distance (4 chunks = 64 blocks). */
const FOG_NEAR = 48;
const FOG_FAR = 88;
const MAX_PIXEL_RATIO = 2;

export interface Renderer3D {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** The sun light (also moonlight at night — see daynight.ts). */
  sun: THREE.DirectionalLight;
  hemisphere: THREE.HemisphereLight;
  /** Sets the sky clear color and fog color together (day-night cycle). */
  setSkyColor(hex: number): void;
  /** Render one frame. `dt` is the elapsed time in seconds. */
  render(dt: number): void;
  dispose(): void;
}

/**
 * Creates the WebGL renderer, scene, camera and lights. The voxel terrain is
 * added to the scene by the world renderer; sky-colored fog hides the
 * render-distance edge. Handles window resize.
 */
export function createRenderer(container: HTMLElement): Renderer3D {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  // One shared Color instance behind background + fog so day-night only has
  // to set it once to recolor both.
  const skyColor = new THREE.Color(SKY_COLOR);
  scene.background = skyColor;
  const fog = new THREE.Fog(SKY_COLOR, FOG_NEAR, FOG_FAR);
  fog.color = skyColor;
  scene.fog = fog;

  const camera = new THREE.PerspectiveCamera(
    75,
    container.clientWidth / container.clientHeight,
    0.1,
    1000,
  );
  // Over the island; main.ts moves this to the spawn point once the world is built.
  camera.position.set(128, 40, 128);

  // Lighting: soft sky/ground bounce plus one sun. No shadow maps (perf budget).
  const hemisphere = new THREE.HemisphereLight(0xeaf6ff, 0x6b7d54, 1.1);
  const sun = new THREE.DirectionalLight(0xffffff, 1.8);
  sun.position.set(0.6, 1.0, 0.4);
  scene.add(hemisphere, sun);

  function resize() {
    const width = container.clientWidth;
    const height = container.clientHeight;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
  }
  window.addEventListener('resize', resize);

  return {
    renderer,
    scene,
    camera,
    sun,
    hemisphere,
    setSkyColor(hex: number) {
      skyColor.setHex(hex);
    },
    render(dt: number) {
      void dt; // unused for now; day-night animates in daynight.ts
      renderer.render(scene, camera);
    },
    dispose() {
      window.removeEventListener('resize', resize);
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
