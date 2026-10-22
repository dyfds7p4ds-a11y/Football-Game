/**
 * Blitzes (pure). Phase 3b: a blitz is no longer an automatic free rusher.
 * Whether it gets home depends on
 *
 * - its path (`blitzPath`): an edge blitz is long but hard to reach for a
 *   lineman, an A/B-gap blitz is short but runs into the line, a delayed
 *   blitz waits for the line to commit;
 * - the block it faces: `assignProtection()` (blocking.ts) lets a lineman
 *   slide only `protection.olReach` yards, so wide blitzers must be picked up by a back,
 *   and that block is graded like any other (`blockQuality`);
 * - the timing of the throw (`arrivalTime` vs. the release).
 *
 * `classifyBlitz()` turns what happened into one outcome per blitzer: sack,
 * hurry, blocked or late. Tunables: `data/blitz.json`.
 */
import type { Vec2 } from '../core/vec';
import type { DefSlot } from '../data/types';
import blitzJson from '../data/blitz.json';

export type BlitzPath = 'edge' | 'aGap' | 'bGap' | 'delayed';
export type BlitzOutcome = 'sack' | 'hurry' | 'blocked' | 'late';

export interface BlitzDesign {
  path: BlitzPath;
  delay: number;
}

export const BLITZ = blitzJson as unknown as {
  calls: Record<string, Partial<Record<DefSlot, BlitzDesign>>>;
  paths: { edge: { width: number; depth: number }; aGap: { x: number }; bGap: { x: number }; delayed: { x: number } };
  recognize: Record<BlitzPath, number>;
  recognizeAwareness: number;
  hurryRadius: number;
  hurryPressure: number;
  waypointRadius: number;
};

/** Blitz design for a non-lineman rusher: from the call, else by alignment (wide = edge). */
export function blitzDesign(callId: string, slot: DefSlot, startX: number, ballX: number): BlitzDesign {
  const d = BLITZ.calls[callId]?.[slot];
  if (d) return d;
  return { path: Math.abs(startX - ballX) > 3.5 ? 'edge' : 'aGap', delay: 0 };
}

/**
 * Waypoints from the blitzer's start to the QB's launch point (the last
 * point). Gap paths aim at the gap on the blitzer's side of the ball.
 */
export function blitzPath(path: BlitzPath, start: Vec2, ballX: number, los: number, qb: Vec2): Vec2[] {
  const side = Math.sign(start.x - ballX) || 1;
  const p = BLITZ.paths;
  switch (path) {
    case 'edge':
      return [
        { x: ballX + side * p.edge.width, y: los + 0.2 },
        { x: qb.x + side * 2.2, y: qb.y - p.edge.depth },
        { ...qb },
      ];
    case 'aGap':
    case 'delayed':
      return [{ x: ballX + side * p[path].x, y: los + 0.4 }, { ...qb }];
    case 'bGap':
      return [{ x: ballX + side * p.bGap.x, y: los + 0.4 }, { ...qb }];
  }
}

/** Seconds from the snap until an unblocked blitzer reaches the QB (straight runs between waypoints). */
export function arrivalTime(start: Vec2, points: Vec2[], speed: number, delay: number, accelTime = 0.35): number {
  let d = 0;
  let from = start;
  for (const p of points) {
    d += Math.hypot(p.x - from.x, p.y - from.y);
    from = p;
  }
  return delay + accelTime + d / Math.max(1, speed);
}

/**
 * Chance the protection identifies this blitz at the snap: depends on the
 * path (delayed blitzes are the hardest to see) and the line's awareness.
 */
export function recognizeChance(path: BlitzPath, lineAwareness: number): number {
  const w = BLITZ.recognizeAwareness;
  return Math.max(0.05, Math.min(0.97, BLITZ.recognize[path] * (1 - w + w * (lineAwareness / 75))));
}

export interface BlitzFacts {
  /** This blitzer made the sack. */
  sacked: boolean;
  /** Closest he got to the QB while the QB still had the ball (yd). */
  closest: number;
  /** Distance to the QB at the release (Infinity: no pass). */
  atRelease: number;
  /** He was engaged by a blocker at some point. */
  engaged: boolean;
}

/** One outcome per blitzer. */
export function classifyBlitz(f: BlitzFacts): BlitzOutcome {
  if (f.sacked) return 'sack';
  if (f.atRelease <= BLITZ.hurryRadius || f.closest <= BLITZ.hurryRadius * 0.6) return 'hurry';
  if (f.engaged) return 'blocked';
  return 'late';
}
