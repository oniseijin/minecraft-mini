/**
 * Block highlight: a slightly inflated white wireframe box placed on the
 * voxel currently targeted by the DDA raycast. Hidden when there is no target.
 */

import * as THREE from 'three';

export interface Selection {
  show(x: number, y: number, z: number): void;
  hide(): void;
  dispose(): void;
}

const INFLATE = 1.002; // keep the edges just off the block faces (no z-fighting)

export function createSelection(scene: THREE.Scene): Selection {
  const box = new THREE.BoxGeometry(INFLATE, INFLATE, INFLATE);
  const edges = new THREE.EdgesGeometry(box);
  box.dispose();
  const material = new THREE.LineBasicMaterial({ color: 0xffffff });
  const lines = new THREE.LineSegments(edges, material);
  lines.visible = false;
  lines.renderOrder = 1;
  scene.add(lines);

  return {
    show(x: number, y: number, z: number) {
      lines.position.set(x + 0.5, y + 0.5, z + 0.5);
      lines.visible = true;
    },
    hide() {
      lines.visible = false;
    },
    dispose() {
      scene.remove(lines);
      edges.dispose();
      material.dispose();
    },
  };
}
