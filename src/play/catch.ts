/**
 * Pure catch / interception resolution when a pass arrives at catch height.
 */
import type { Rng } from '../core/rng';
import { clamp, dist, type Vec2 } from '../core/vec';
import passingJson from '../data/passing.json';

export const PASSING = passingJson;

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
  /** User-timed jump (play/interception.ts): added breakup / interception chance and reach (yd). */
  timing?: { breakup: number; int: number; reach: number };
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
  /** Base pick share of a defender's hands-on plays (default 0.3, Phase 2). */
  intBase?: number;
  /** Extra pick share when no receiver is within reach (default 0.2, Phase 2). */
  noReceiverInt?: number;
  /** Phase 4: released inside the green window, and the pressure at the release. */
  green?: boolean;
  pressure?: number;
  rng: Rng;
}

export type CatchOutcome =
  | { kind: 'catch'; id: number; probability: number }
  | { kind: 'interception'; id: number; probability: number }
  | { kind: 'deflection'; id: number; probability: number }
  | { kind: 'drop'; id: number; probability: number; contested?: boolean }
  | { kind: 'incomplete' };

function nearest(cands: CatchCandidate[], p: Vec2): { c: CatchCandidate; d: number } | null {
  let best: { c: CatchCandidate; d: number } | null = null;
  for (const c of cands) {
    // A well-timed jump extends a defender's reach.
    const d = Math.max(0, dist(c.pos, p) - (c.timing?.reach ?? 0));
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

/** Phase 4: green release, pressure at most `cleanCatch.maxPressure`, no defender within reach + contest of the landing. */
export function isCleanBall(inp: Pick<CatchInput, 'green' | 'pressure' | 'catchFactor'>, nearestDefender: number): boolean {
  return !!inp.green && (inp.pressure ?? 0) <= PASSING.cleanCatch.maxPressure && nearestDefender > CATCH.reach + CATCH.contest &&
    (inp.catchFactor ?? 1) >= 1; // a screen thrown early / late keeps its timing penalty
}

export function resolveCatch(inp: CatchInput): CatchOutcome {
  const off = nearest(inp.offense, inp.landing);
  const def = nearest(inp.defense, inp.landing);
  const offIn = off && off.d <= CATCH.reach;
  const defIn = def && def.d <= CATCH.reach;
  if (!offIn && !defIn) return { kind: 'incomplete' };

  // Phase 4 (Part D): a clean ball (green release, no pressure, nobody within the contest radius)
  // to a receiver within reach is caught. Only pressure, defenders and timing make it incomplete.
  if (isCleanBall(inp, def?.d ?? Infinity) && off && offIn) return { kind: 'catch', id: off.c.id, probability: 1 };

  // Defender gets a hand on the ball first?
  if (def && defIn) {
    const leverage = off ? clamp((off.d - def.d) * 0.25, -0.3, 0.4) : 0.4;
    const phase = def.c.inPhase ? 1 : 0;
    const tm = def.c.timing;
    const p = clamp((0.3 + 0.35 * (1 - def.d / CATCH.reach) + leverage + phase * (inp.inPhaseBreakup ?? 0)) * (def.c.coverage / 85) * inp.ballSkills + (tm?.breakup ?? 0), 0.03, 0.92);
    if (inp.rng.chance(p)) {
      const pInt = clamp((inp.intBase ?? 0.3) * (def.c.catching / 70) * inp.ballSkills + (off && offIn ? 0 : inp.noReceiverInt ?? 0.2) + phase * (inp.inPhaseInt ?? 0) + (inp.intBonus ?? 0) + (tm?.int ?? 0), tm ? 0.02 : 0.05, 0.75);
      if (inp.rng.chance(pInt)) return { kind: 'interception', id: def.c.id, probability: p * pInt };
      return { kind: 'deflection', id: def.c.id, probability: p };
    }
  }

  if (off && offIn) {
    let p = catchProbability(off.c.catching, off.d, inp.quality, inp.speed) * (inp.catchFactor ?? 1);
    const contested = !!def && def.d <= CATCH.reach + CATCH.contest;
    if (contested) p *= 0.8; // contested catch
    if (inp.rng.chance(p)) return { kind: 'catch', id: off.c.id, probability: p };
    return { kind: 'drop', id: off.c.id, probability: p, contested };
  }
  return { kind: 'incomplete' };
}
