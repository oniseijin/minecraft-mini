/**
 * Player controller: pointer-lock mouse look + fixed-timestep (60 Hz) voxel
 * AABB physics — gravity, jump, walk/sprint, creative fly and simple water.
 * Replaces the M0 fly camera (fly mode survives as creative fly, double-tap
 * Space to toggle).
 *
 * Render is decoupled from the simulation: update(dt) accumulates real time,
 * runs whole 60 Hz ticks (axis-separated collision X → Z → Y, epsilon-snap
 * against solid voxels — moves are substepped so nothing can tunnel), and the
 * camera follows the interpolated eye position.
 *
 * Movement inputs live in a plain mutable `input` object the keyboard writes
 * while the pointer is locked; dev tools and tests may also set the flags
 * directly (no lock required) to drive the player programmatically.
 * Mouse look sensitivity starts at 0.0045 rad/px and is adjustable with
 * `[` / `]` (handled in main.ts via adjustSensitivity); it persists in
 * localStorage.
 */

import * as THREE from 'three';
import { WATER, isSolidId, type World } from '@mc/shared';

// --- simulation constants (DESIGN.md §3.1) ---

export const TICK_RATE = 60;
export const TICK = 1 / TICK_RATE;
/** Stall guard: at most this many ticks per frame, drop any older backlog. */
const MAX_TICKS_PER_FRAME = 8;

export const PLAYER_HALF_WIDTH = 0.3;
export const PLAYER_HEIGHT = 1.8;
export const EYE_HEIGHT = 1.62;

const GRAVITY = 30;
const JUMP_SPEED = 9; // ≈ 1.35-block jump apex
const WALK_SPEED = 4.3;
const SPRINT_SPEED = 5.6;
const FLY_SPEED = 10;
const FLY_SPRINT_SPEED = 16;
/** Falling speed cap (< 1 block/tick, so the axis sweep cannot tunnel). */
const MAX_FALL_SPEED = 50;
/** Air acceleration as a fraction of ground acceleration. */
const AIR_CONTROL = 0.3;

// Velocity approach rates (1/s): v += (target − v) · min(1, rate·dt)
const GROUND_APPROACH = 20; // snappy start/stop on land — no drift
const AIR_APPROACH = GROUND_APPROACH * AIR_CONTROL;
const WATER_APPROACH = 6;
const FLY_APPROACH = 8;
const FLY_VERTICAL_APPROACH = 8; // damped vertical fly — no bounce
const FOV_APPROACH = 10;

const WATER_GRAVITY = GRAVITY * 0.3;
/** Per-tick vertical drag in water → terminal sink ≈ 1 m/s. */
const WATER_VERTICAL_DRAG = 0.85;
const WATER_MAX_SINK = 3;
const SWIM_UP_SPEED = 3;
/** Head already above water: extra push so shores stay climbable. */
const SWIM_SURFACE_SPEED = 4.5;

const SKIN = 1e-4; // snap-back gap: a resting AABB no longer overlaps the voxel
const CELL_EPS = 1e-7; // boundary tolerance when enumerating overlapped cells
const MAX_STEP_DELTA = 0.9; // substep longer moves — never cross a whole cell

const BASE_FOV = 75;
const SPRINT_FOV = 82; // sprint FOV kick

const DOUBLE_TAP_MS = 300;
const FALL_SOUND_DISTANCE = 1.5; // blocks — louder landing thud above this
const STEP_DISTANCE = 2.0; // metres of ground travel per footstep
const VOID_Y = -10; // below this → respawn at spawn point

/** Default look sensitivity: radians per pixel of mouse movement. */
export const DEFAULT_SENSITIVITY = 0.0045;
const MIN_SENSITIVITY = 0.0008;
const MAX_SENSITIVITY = 0.01;
const SENSITIVITY_STORAGE_KEY = 'mc-sensitivity';
const MAX_PITCH = (89 * Math.PI) / 180;

export interface InputState {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  sneak: boolean;
  /** Held Ctrl or double-tapped W (latched until forward is released). */
  sprint: boolean;
}

export interface PlayerHooks {
  /** Every ~STEP_DISTANCE of ground travel, with the block walked on. */
  onStep?(groundBlockId: number): void;
  /** Landing after a fall longer than FALL_SOUND_DISTANCE. */
  onLand?(fallDistance: number): void;
  /** Entered a water block. */
  onSplash?(): void;
}

export interface PlayerOptions {
  world: World;
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
  overlay: HTMLElement;
  /** Feet position used at creation and for void respawn. */
  spawn: { x: number; y: number; z: number };
  hooks?: PlayerHooks;
}

export interface Player {
  /** Feet-center position (AABB base). */
  readonly pos: THREE.Vector3;
  readonly vel: THREE.Vector3;
  readonly yaw: number;
  readonly pitch: number;
  readonly onGround: boolean;
  readonly inWater: boolean;
  /** Creative fly — writable so dev tools/tests can toggle it. */
  flying: boolean;
  /** Mutable input flags; keyboard writes them while locked, tests any time. */
  readonly input: InputState;
  /** Accumulate real time and run whole physics ticks, then place the camera. */
  update(dt: number): void;
  teleport(x: number, y: number, z: number): void;
  /** Queue a jump for the next tick (dev/test hook). */
  jump(): void;
  /** Aim the view (radians); test/automation hook. */
  look(yaw: number, pitch: number): void;
  /** Current mouse look sensitivity (radians per pixel). */
  readonly sensitivity: number;
  /**
   * Multiplies the look sensitivity by `mult` (e.g. 1.1 for `]`, 1/1.1 for
   * `[`), clamped to [0.0008, 0.01], persists it and returns the new value.
   */
  adjustSensitivity(mult: number): number;
  readonly isLocked: boolean;
  dispose(): void;
}

const KEY_FLAGS: Record<string, keyof InputState> = {
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'back',
  ArrowDown: 'back',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  Space: 'jump',
  ShiftLeft: 'sneak',
  ShiftRight: 'sneak',
  ControlLeft: 'sprint',
  ControlRight: 'sprint',
};

function clampSensitivity(value: number): number {
  return Math.max(MIN_SENSITIVITY, Math.min(MAX_SENSITIVITY, value));
}

/** Restores the persisted look sensitivity, falling back to the default. */
function loadSensitivity(): number {
  const parsed = Number(localStorage.getItem(SENSITIVITY_STORAGE_KEY));
  return Number.isFinite(parsed) && parsed > 0 ? clampSensitivity(parsed) : DEFAULT_SENSITIVITY;
}

export function createPlayer(options: PlayerOptions): Player {
  const { world, camera, canvas, overlay, spawn, hooks = {} } = options;

  // --- state ---
  const pos = new THREE.Vector3(spawn.x, spawn.y, spawn.z);
  const prevPos = pos.clone(); // previous tick, for render interpolation
  const vel = new THREE.Vector3();
  let yaw = 0;
  let pitch = 0;
  let onGround = false;
  let flying = false;
  let inWater = false;
  let eyeInWater = false;
  let sprintLatched = false; // double-tap W (until forward is released)
  let sprinting = false; // effective, drives speed + FOV
  let jumpQueued = false;
  let peakY = pos.y; // highest point since last grounded (fall distance)
  let stepAccum = 0;
  let acc = 0;

  const input: InputState = {
    forward: false,
    back: false,
    left: false,
    right: false,
    jump: false,
    sneak: false,
    sprint: false,
  };

  let isLocked = false;
  let lastWPress = 0;
  let lastSpacePress = 0;
  let sensitivity = loadSensitivity();

  // --- input plumbing (same pattern as the old fly controls) ---

  function clearInput(): void {
    (Object.keys(input) as (keyof InputState)[]).forEach((k) => {
      input[k] = false;
    });
    sprintLatched = false;
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (!isLocked) return;
    if (event.code === 'Space') event.preventDefault(); // no page scroll
    if (event.repeat) return; // auto-repeat must not retrigger double-taps
    const flag = KEY_FLAGS[event.code];
    if (flag) input[flag] = true;

    const now = performance.now();
    if (event.code === 'KeyW') {
      if (now - lastWPress <= DOUBLE_TAP_MS) sprintLatched = true;
      lastWPress = now;
    } else if (event.code === 'Space') {
      if (now - lastSpacePress <= DOUBLE_TAP_MS) {
        flying = !flying; // creative fly toggle
        vel.y = 0;
      }
      lastSpacePress = now;
    }
  }

  function onKeyUp(event: KeyboardEvent): void {
    const flag = KEY_FLAGS[event.code];
    if (flag) input[flag] = false;
  }

  function onMouseMove(event: MouseEvent): void {
    if (!isLocked) return;
    yaw -= event.movementX * sensitivity;
    pitch -= event.movementY * sensitivity;
    pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch));
  }

  function requestLock(): void {
    // Chrome ≥111 returns a Promise that rejects when the lock is denied
    // (e.g. re-locking too soon after Esc) — swallow it, the overlay stays up.
    const result = canvas.requestPointerLock() as unknown as Promise<void> | undefined;
    if (result instanceof Promise) result.catch(() => undefined);
  }

  function onPointerLockChange(): void {
    isLocked = document.pointerLockElement === canvas;
    overlay.classList.toggle('hidden', isLocked);
    if (!isLocked) clearInput();
  }

  overlay.addEventListener('click', requestLock);
  document.addEventListener('pointerlockchange', onPointerLockChange);
  document.addEventListener('mousemove', onMouseMove);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  // --- physics ---

  function updateWaterState(): void {
    const bx = Math.floor(pos.x);
    const bz = Math.floor(pos.z);
    const feet = world.getBlock(bx, Math.floor(pos.y + 0.2), bz);
    const head = world.getBlock(bx, Math.floor(pos.y + EYE_HEIGHT), bz);
    inWater = feet === WATER || head === WATER;
    eyeInWater = head === WATER;
  }

  /** Ease `cur` toward `target` at `rate` (1/s) for one tick. */
  function approach(cur: number, target: number, rate: number): number {
    return cur + (target - cur) * Math.min(1, rate * TICK);
  }

  /**
   * Moves along one axis by `delta` (≤ 1 block; longer moves are substepped)
   * and epsilon-snaps against the leading layer of solid voxels. Returns true
   * when the move was obstructed (the caller zeroes that axis' velocity).
   */
  function moveAxis(axis: 'x' | 'y' | 'z', delta: number): boolean {
    if (delta === 0) return false;
    if (Math.abs(delta) > MAX_STEP_DELTA) {
      const steps = Math.ceil(Math.abs(delta) / MAX_STEP_DELTA);
      const step = delta / steps;
      for (let i = 0; i < steps; i++) {
        if (moveAxis(axis, step)) return true;
      }
      return false;
    }
    pos[axis] += delta;

    const minX = pos.x - PLAYER_HALF_WIDTH;
    const maxX = pos.x + PLAYER_HALF_WIDTH;
    const minY = pos.y;
    const maxY = pos.y + PLAYER_HEIGHT;
    const minZ = pos.z - PLAYER_HALF_WIDTH;
    const maxZ = pos.z + PLAYER_HALF_WIDTH;

    const x0 = Math.floor(minX + CELL_EPS);
    const x1 = Math.floor(maxX - CELL_EPS);
    const y0 = Math.floor(minY + CELL_EPS);
    const y1 = Math.floor(maxY - CELL_EPS);
    const z0 = Math.floor(minZ + CELL_EPS);
    const z1 = Math.floor(maxZ - CELL_EPS);

    // Only the leading layer (in the movement direction) can contain new
    // overlaps — the previous position was collision-free and per-tick moves
    // never cross a whole cell. The other two axes keep their full span.
    let x0b = x0;
    let x1b = x1;
    let y0b = y0;
    let y1b = y1;
    let z0b = z0;
    let z1b = z1;
    if (axis === 'x') {
      x0b = x1b = delta > 0 ? x1 : x0;
    } else if (axis === 'y') {
      y0b = y1b = delta > 0 ? y1 : y0;
    } else {
      z0b = z1b = delta > 0 ? z1 : z0;
    }

    for (let y = y0b; y <= y1b; y++) {
      for (let z = z0b; z <= z1b; z++) {
        for (let x = x0b; x <= x1b; x++) {
          if (!isSolidId(world.getBlock(x, y, z))) continue;
          if (axis === 'y') {
            pos.y = delta < 0 ? y + 1 + SKIN : y - PLAYER_HEIGHT - SKIN;
          } else if (axis === 'x') {
            pos.x = delta < 0 ? x + 1 + PLAYER_HALF_WIDTH + SKIN : x - PLAYER_HALF_WIDTH - SKIN;
          } else {
            pos.z = delta < 0 ? z + 1 + PLAYER_HALF_WIDTH + SKIN : z - PLAYER_HALF_WIDTH - SKIN;
          }
          return true;
        }
      }
    }
    return false;
  }

  function tick(): void {
    prevPos.copy(pos);

    const wasOnGround = onGround;
    const wasInWater = inWater;
    updateWaterState();

    // Sprint: held Ctrl or double-tapped W; needs forward, drops on release.
    if (!input.forward) sprintLatched = false;
    sprinting = (input.sprint || sprintLatched) && input.forward;

    // Desired horizontal direction in yaw space (yaw 0 faces −Z).
    const iz = (input.forward ? 1 : 0) - (input.back ? 1 : 0);
    const ix = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    let wx = -sin * iz + cos * ix;
    let wz = -cos * iz - sin * ix;
    const wlen = Math.hypot(wx, wz);
    if (wlen > 1) {
      wx /= wlen;
      wz /= wlen;
    }
    const hasInput = ix !== 0 || iz !== 0;

    if (flying) {
      // Creative fly: no gravity, damped vertical, sprint boosts speed.
      const speed = sprinting ? FLY_SPRINT_SPEED : FLY_SPEED;
      vel.x = approach(vel.x, wx * speed, FLY_APPROACH);
      vel.z = approach(vel.z, wz * speed, FLY_APPROACH);
      const upDown = (input.jump ? 1 : 0) - (input.sneak ? 1 : 0);
      vel.y = approach(vel.y, upDown * FLY_SPEED, FLY_VERTICAL_APPROACH);
    } else {
      const speed = (sprinting ? SPRINT_SPEED : WALK_SPEED) * (inWater ? 0.5 : 1);
      const rate = wasOnGround ? GROUND_APPROACH : inWater ? WATER_APPROACH : AIR_APPROACH;
      // In mid-air with no input, keep momentum (no air drag).
      if (wasOnGround || inWater || hasInput) {
        vel.x = approach(vel.x, wx * speed, rate);
        vel.z = approach(vel.z, wz * speed, rate);
      }

      // Jump (ground jump is suppressed in water — Space swims instead).
      if ((jumpQueued || (input.jump && !inWater)) && wasOnGround) {
        vel.y = JUMP_SPEED;
      }
      jumpQueued = false;

      if (inWater) {
        vel.y *= WATER_VERTICAL_DRAG;
        vel.y -= WATER_GRAVITY * TICK;
        if (input.jump) {
          const target = eyeInWater ? SWIM_UP_SPEED : SWIM_SURFACE_SPEED;
          vel.y += (target - vel.y) * Math.min(1, 8 * TICK);
        }
        if (vel.y < -WATER_MAX_SINK) vel.y = -WATER_MAX_SINK;
      } else {
        vel.y -= GRAVITY * TICK;
        if (vel.y < -MAX_FALL_SPEED) vel.y = -MAX_FALL_SPEED;
      }
    }

    // Axis-separated integrate + collide: X, Z, then Y.
    onGround = false;
    if (moveAxis('x', vel.x * TICK)) vel.x = 0;
    if (moveAxis('z', vel.z * TICK)) vel.z = 0;
    const vyBefore = vel.y;
    if (moveAxis('y', vel.y * TICK)) {
      if (vyBefore < 0) onGround = true;
      vel.y = 0;
    }

    updateWaterState(); // refresh for hooks + next tick
    if (!wasInWater && inWater) hooks.onSplash?.();

    // Descending into the ground while flying lands you (Minecraft behavior).
    if (flying && input.sneak && onGround) flying = false;

    // Landing / fall tracking + footsteps.
    if (onGround) {
      if (!wasOnGround && !flying) {
        const fall = peakY - pos.y;
        if (fall > FALL_SOUND_DISTANCE && !inWater) hooks.onLand?.(fall);
      }
      peakY = pos.y;

      const hSpeed = Math.hypot(vel.x, vel.z);
      if (hSpeed > 0.5 && !flying) {
        stepAccum += hSpeed * TICK;
        if (stepAccum >= STEP_DISTANCE) {
          stepAccum = 0;
          hooks.onStep?.(world.getBlock(Math.floor(pos.x), Math.floor(pos.y - 0.05), Math.floor(pos.z)));
        }
      } else {
        stepAccum = 0;
      }
    } else {
      peakY = Math.max(peakY, pos.y);
    }

    // Fell out of the world → back to spawn.
    if (pos.y < VOID_Y) {
      teleport(spawn.x, spawn.y, spawn.z);
    }
  }

  const euler = new THREE.Euler(0, 0, 0, 'YXZ');

  function teleport(x: number, y: number, z: number): void {
    pos.set(x, y, z);
    prevPos.copy(pos); // no interpolation streak across the jump
    vel.set(0, 0, 0);
    onGround = false; // contact state is stale the instant the player moves
    peakY = y;
    stepAccum = 0;
    jumpQueued = false;
    updateWaterState();
  }

  return {
    get pos() {
      return pos;
    },
    get vel() {
      return vel;
    },
    get yaw() {
      return yaw;
    },
    get pitch() {
      return pitch;
    },
    get onGround() {
      return onGround;
    },
    get inWater() {
      return inWater;
    },
    get flying() {
      return flying;
    },
    set flying(value: boolean) {
      flying = value;
    },
    input,
    update(dt: number) {
      acc += Math.min(dt, 0.1); // clamp tab-switch / stall spikes
      let ticks = 0;
      while (acc >= TICK && ticks < MAX_TICKS_PER_FRAME) {
        tick();
        acc -= TICK;
        ticks++;
      }
      if (ticks === MAX_TICKS_PER_FRAME) acc = 0; // drop the backlog

      // Camera follows the interpolated eye position (smooth on any refresh rate).
      const alpha = acc / TICK;
      camera.position.set(
        prevPos.x + (pos.x - prevPos.x) * alpha,
        prevPos.y + (pos.y - prevPos.y) * alpha + EYE_HEIGHT,
        prevPos.z + (pos.z - prevPos.z) * alpha,
      );
      camera.quaternion.setFromEuler(euler.set(pitch, yaw, 0));

      // Sprint FOV kick.
      const targetFov = sprinting ? SPRINT_FOV : BASE_FOV;
      if (Math.abs(camera.fov - targetFov) > 0.01) {
        camera.fov += (targetFov - camera.fov) * Math.min(1, FOV_APPROACH * dt);
        camera.updateProjectionMatrix();
      }
    },
    teleport,
    jump() {
      jumpQueued = true;
    },
    look(nextYaw: number, nextPitch: number) {
      yaw = nextYaw;
      pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, nextPitch));
    },
    get sensitivity() {
      return sensitivity;
    },
    adjustSensitivity(mult: number) {
      // Round away float dust so the persisted value stays clean (0.00352, …).
      sensitivity = clampSensitivity(Number((sensitivity * mult).toPrecision(6)));
      localStorage.setItem(SENSITIVITY_STORAGE_KEY, String(sensitivity));
      return sensitivity;
    },
    get isLocked() {
      return isLocked;
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
