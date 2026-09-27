import * as THREE from 'three';

const SKY_COLOR = 0x87ceeb;
const MAX_PIXEL_RATIO = 2;

export interface Renderer3D {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Render one frame. `dt` is the elapsed time in seconds. */
  render(dt: number): void;
  dispose(): void;
}

/**
 * Creates the WebGL renderer, scene, camera, lights and a temporary flat
 * ground plane (replaced by voxel terrain in M1). Handles window resize.
 */
export function createRenderer(container: HTMLElement): Renderer3D {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SKY_COLOR);
  scene.fog = new THREE.Fog(SKY_COLOR, 60, 220);

  const camera = new THREE.PerspectiveCamera(
    75,
    container.clientWidth / container.clientHeight,
    0.1,
    1000,
  );
  camera.position.set(0, 6, 20);

  // Lighting: soft sky/ground bounce plus one sun. No shadow maps (perf budget).
  const hemisphere = new THREE.HemisphereLight(0xeaf6ff, 0x6b7d54, 1.1);
  const sun = new THREE.DirectionalLight(0xffffff, 1.8);
  sun.position.set(0.6, 1.0, 0.4);
  scene.add(hemisphere, sun);

  // Temporary flat ground; replaced by chunked voxel terrain in M1.
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(256, 256),
    new THREE.MeshLambertMaterial({ color: 0x5d9e3a }),
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

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
    render(dt: number) {
      void dt; // unused for now; animation (day-night, etc.) arrives later
      renderer.render(scene, camera);
    },
    dispose() {
      window.removeEventListener('resize', resize);
      ground.geometry.dispose();
      (ground.material as THREE.MeshLambertMaterial).dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
