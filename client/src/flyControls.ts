import * as THREE from 'three';

const SENSITIVITY = 0.002; // radians per pixel of mouse movement
const MAX_PITCH = (89 * Math.PI) / 180;
const SPEED = 12; // m/s

export interface FlyControls {
  /** True while the pointer is locked to the game canvas. */
  readonly isLocked: boolean;
  /** Advance movement + camera orientation. `dt` in seconds. */
  update(dt: number): void;
  /** Aim the camera (radians); test/automation hook. */
  look(yaw: number, pitch: number): void;
  dispose(): void;
}

/**
 * Pointer-lock fly camera: click the overlay to play, Esc to release.
 * WASD moves horizontally relative to yaw, Space/Shift move up/down;
 * mouse controls yaw/pitch (no roll).
 */
export function createFlyControls(
  camera: THREE.PerspectiveCamera,
  canvas: HTMLCanvasElement,
  overlay: HTMLElement,
): FlyControls {
  let isLocked = false;
  let yaw = 0;
  let pitch = 0;

  const held = new Set<string>();

  function onKeyDown(event: KeyboardEvent) {
    if (!isLocked) return;
    held.add(event.code);
    if (event.code === 'Space') event.preventDefault(); // no page scroll
  }

  function onKeyUp(event: KeyboardEvent) {
    held.delete(event.code);
  }

  function onMouseMove(event: MouseEvent) {
    if (!isLocked) return;
    yaw -= event.movementX * SENSITIVITY;
    pitch -= event.movementY * SENSITIVITY;
    pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch));
  }

  function requestLock() {
    canvas.requestPointerLock();
  }

  function onPointerLockChange() {
    isLocked = document.pointerLockElement === canvas;
    overlay.classList.toggle('hidden', isLocked);
    if (!isLocked) held.clear();
  }

  overlay.addEventListener('click', requestLock);
  document.addEventListener('pointerlockchange', onPointerLockChange);
  document.addEventListener('mousemove', onMouseMove);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const move = new THREE.Vector3();

  return {
    get isLocked() {
      return isLocked;
    },
    look(nextYaw: number, nextPitch: number) {
      yaw = nextYaw;
      pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, nextPitch));
    },
    update(dt: number) {
      move.set(0, 0, 0);
      if (isLocked) {
        const sin = Math.sin(yaw);
        const cos = Math.cos(yaw);
        // Yaw-relative horizontal basis (yaw 0 faces -Z).
        if (held.has('KeyW')) move.add(new THREE.Vector3(-sin, 0, -cos));
        if (held.has('KeyS')) move.add(new THREE.Vector3(sin, 0, cos));
        if (held.has('KeyD')) move.add(new THREE.Vector3(cos, 0, -sin));
        if (held.has('KeyA')) move.add(new THREE.Vector3(-cos, 0, sin));
        if (held.has('Space')) move.y += 1;
        if (held.has('ShiftLeft') || held.has('ShiftRight')) move.y -= 1;
      }
      if (move.lengthSq() > 0) {
        move.normalize().multiplyScalar(SPEED * dt);
        camera.position.add(move);
      }
      camera.quaternion.setFromEuler(euler.set(pitch, yaw, 0));
    },
    dispose() {
      overlay.removeEventListener('click', requestLock);
      document.removeEventListener('pointerlockchange', onPointerLockChange);
      document.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    },
  };
}
