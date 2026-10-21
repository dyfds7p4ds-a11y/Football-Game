/** Field dimensions in yards (NCAA/GFL hash marks). */
export const FIELD = {
  length: 100,
  endzone: 10,
  halfWidth: 160 / 6, // 53 1/3 yards wide
  hash: 20 / 3, // hashes 40 ft apart
} as const;

export function isOutOfBounds(x: number, y: number): boolean {
  return Math.abs(x) > FIELD.halfWidth || y > FIELD.length + FIELD.endzone || y < -FIELD.endzone;
}

/** Spot the ball between the hashes. */
export function hashX(x: number): number {
  return Math.max(-FIELD.hash, Math.min(FIELD.hash, x));
}
