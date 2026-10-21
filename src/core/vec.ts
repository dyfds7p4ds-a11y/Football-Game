/**
 * Minimal 2D vector helpers for the simulation. The sim works in the
 * "offense frame": x = lateral (+x is the offense's right when facing
 * downfield), y = yards from the offense's own goal line (0..100).
 */
export interface Vec2 {
  x: number;
  y: number;
}

export const v2 = (x = 0, y = 0): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});

export function norm(a: Vec2): Vec2 {
  const l = len(a);
  return l > 1e-9 ? { x: a.x / l, y: a.y / l } : { x: 0, y: 0 };
}

export function clampLen(a: Vec2, max: number): Vec2 {
  const l = len(a);
  return l > max ? scale(a, max / l) : a;
}

/** Heading angle: 0 = downfield (+y), positive = toward +x. */
export const heading = (a: Vec2): number => Math.atan2(a.x, a.y);
export const fromHeading = (h: number, l = 1): Vec2 => ({ x: Math.sin(h) * l, y: Math.cos(h) * l });

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export function wrapAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/** Move `cur` toward `target` by at most `maxStep`. */
export function approach(cur: number, target: number, maxStep: number): number {
  const d = target - cur;
  return Math.abs(d) <= maxStep ? target : cur + Math.sign(d) * maxStep;
}
