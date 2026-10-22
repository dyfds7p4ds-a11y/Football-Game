/**
 * Pure catch / interception resolution when a pass arrives at catch height.
 */
import type { Rng } from '../core/rng';
import { clamp, dist, type Vec2 } from '../core/vec';

export const CATCH = {
  /** How far (yards) a player can reach for a ball. */
  reach: 1.6,
  /** Extra radius in which a defender still contests the catch. */
  contest: 1.2,
} as const;

export interface CatchCandidate {
  id: number;
  pos: Vec2;
  /** catching rating 0..100 */
  catching: number;
  /** coverage rating 0..100 (defenders) */
  coverage: number;
  /** Defender was in phase with the targeted receiver when the ball arrived. */
  inPhase?: boolean;
}

export interface CatchInput {
  landing: Vec2;
  /** 0..1 release quality of the throw. */
  quality: number;
  /** Ball speed in yd/s at arrival. */
  speed: number;
  offense: CatchCandidate[];
  defense: CatchCandidate[];
  /** Difficulty multiplier on defender ball skills. */
  ballSkills: number;
  /** Extra breakup / interception chance for an in-phase defender. */
  inPhaseBreakup?: number;
  inPhaseInt?: number;
  /** Timing multiplier on the catch chance (screens thrown early/late). */
  catchFactor?: number;
  /** Extra interception chance (screens thrown late). */
  intBonus?: number;
  rng: Rng;
}

export type CatchOutcome =
  | { kind: 'catch'; id: number; probability: number }
  | { kind: 'interception'; id: number; probability: number }
  | { kind: 'deflection'; id: number; probability: number }
  | { kind: 'drop'; id: number; probability: number }
  | { kind: 'incomplete' };

function nearest(cands: CatchCandidate[], p: Vec2): { c: CatchCandidate; d: number } | null {
  let best: { c: CatchCandidate; d: number } | null = null;
  for (const c of cands) {
    const d = dist(c.pos, p);
    if (!best || d < best.d) best = { c, d };
  }
  return best;
}

/** Probability that the nearest receiver catches it, ignoring defenders. */
export function catchProbability(catching: number, distance: number, quality: number, speed: number): number {
  const reachFactor = 1 - 0.4 * clamp(distance / CATCH.reach, 0, 1);
  const hotBall = speed > 24 ? (speed - 24) * 0.02 : 0; // fastballs are harder to haul in
  return clamp((0.55 + 0.42 * (catching / 100)) * reachFactor * (0.8 + 0.2 * quality) - hotBall, 0.03, 0.98);
}

export function resolveCatch(inp: CatchInput): CatchOutcome {
  const off = nearest(inp.offense, inp.landing);
  const def = nearest(inp.defense, inp.landing);
  const offIn = off && off.d <= CATCH.reach;
  const defIn = def && def.d <= CATCH.reach;
  if (!offIn && !defIn) return { kind: 'incomplete' };

  // Defender gets a hand on the ball first?
  if (def && defIn) {
    const leverage = off ? clamp((off.d - def.d) * 0.25, -0.3, 0.4) : 0.4;
    const phase = def.c.inPhase ? 1 : 0;
    const p = clamp((0.3 + 0.35 * (1 - def.d / CATCH.reach) + leverage + phase * (inp.inPhaseBreakup ?? 0)) * (def.c.coverage / 85) * inp.ballSkills, 0.03, 0.92);
    if (inp.rng.chance(p)) {
      const pInt = clamp(0.3 * (def.c.catching / 70) * inp.ballSkills + (off && offIn ? 0 : 0.2) + phase * (inp.inPhaseInt ?? 0) + (inp.intBonus ?? 0), 0.05, 0.75);
      if (inp.rng.chance(pInt)) return { kind: 'interception', id: def.c.id, probability: p * pInt };
      return { kind: 'deflection', id: def.c.id, probability: p };
    }
  }

  if (off && offIn) {
    let p = catchProbability(off.c.catching, off.d, inp.quality, inp.speed) * (inp.catchFactor ?? 1);
    if (def && def.d <= CATCH.reach + CATCH.contest) p *= 0.8; // contested catch
    if (inp.rng.chance(p)) return { kind: 'catch', id: off.c.id, probability: p };
    return { kind: 'drop', id: off.c.id, probability: p };
  }
  return { kind: 'incomplete' };
}
