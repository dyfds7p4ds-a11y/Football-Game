import * as THREE from 'three';

/** Sim field coords (x lateral, y downfield) -> world (x, height, -y). */
export function toWorld(x: number, y: number, h = 0, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(x, h, -y);
}

/** Sim heading (0 = downfield, + = right) -> Object3D rotation.y (models face local -z). */
export const headingToRotY = (h: number): number => -h;
