import * as THREE from 'three';

/**
 * Sim field coords (x lateral, y downfield) -> world (x, height, -y).
 *
 * The world is laid out in the user team's frame. A sim that runs in the
 * other team's frame (e.g. the CPU returning a kick the user kicked) is drawn
 * by flipping the frame: (x, y) -> (-x, 100 - y).
 */
let flipped = false;

export function setFrameFlip(flip: boolean) {
  flipped = flip;
}

export function isFrameFlipped(): boolean {
  return flipped;
}

export function toWorld(x: number, y: number, h = 0, out = new THREE.Vector3()): THREE.Vector3 {
  return flipped ? out.set(-x, h, -(100 - y)) : out.set(x, h, -y);
}

/** Sim heading (0 = downfield, + = right) -> Object3D rotation.y (models face local -z). */
export const headingToRotY = (h: number): number => (flipped ? -h + Math.PI : -h);
