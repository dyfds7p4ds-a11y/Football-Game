/**
 * Tackle resolution (pure). The outcome depends on the angle and speed of the
 * tackler relative to the ball carrier, and decides which contact animation
 * plays: a head-on shoulder hit, an arm wrap from the side, a stumble when
 * dragged down from behind, or a hip turn when the carrier spins out of it.
 * Shared by scrimmage plays and kick returns. Tunables in data/tackling.json.
 */
import type { Rng } from '../core/rng';
import { clamp, dot, len, norm, sub, type Vec2 } from '../core/vec';
import tacklingJson from '../data/tackling.json';

export type ContactKind = 'shoulder' | 'wrap' | 'stumble' | 'hipTurn' | 'slide';

export const TACKLE = tacklingJson as {
  range: number;
  engagedRange: number;
  base: number;
  tacklerWeight: number;
  elusiveWeight: number;
  armTackle: number;
  jukeFactor: number;
  pocketSackFactor: number;
  angle: { headOn: number; side: number; behind: number };
  speedEdge: number;
  min: number;
  max: number;
  shoulderClosingSpeed: number;
  contactTime: Record<ContactKind, number>;
  fallForward: Record<ContactKind, number>;
  brokenSlow: { hipTurn: number; stumble: number };
  brokenCooldown: number;
};

export type Approach = 'headOn' | 'side' | 'behind';

export interface TackleInput {
  tacklerPos: Vec2;
  tacklerVel: Vec2;
  carrierPos: Vec2;
  carrierVel: Vec2;
  /** 0..100 ratings. */
  tackling: number;
  carrierStrength: number;
  carrierSpeed: number;
  /** Tackler is still engaged with a blocker (arm tackle only). */
  engaged: boolean;
  juking: boolean;
  /** Extra multiplier (QB in the pocket, scrambling QB, difficulty...). */
  factor: number;
  rng: Rng;
}

export interface TackleOutcome {
  success: boolean;
  kind: ContactKind;
  approach: Approach;
  probability: number;
  /** Seconds from contact to the whistle (success) or to recovery (broken). */
  contactTime: number;
  /** Yards the carrier keeps falling forward along his path. */
  fallForward: number;
  /** Carrier speed multiplier after a broken tackle. */
  slow: number;
}

/** Where the tackler comes from, seen from the ball carrier's running direction. */
export function approachOf(tacklerPos: Vec2, carrierPos: Vec2, carrierVel: Vec2): Approach {
  if (len(carrierVel) < 1) return 'headOn';
  const toTackler = norm(sub(tacklerPos, carrierPos));
  const c = dot(norm(carrierVel), toTackler);
  if (c > 0.5) return 'headOn';
  if (c < -0.4) return 'behind';
  return 'side';
}

export function tackleProbability(inp: Omit<TackleInput, 'rng'>): { p: number; approach: Approach; closing: number } {
  const approach = approachOf(inp.tacklerPos, inp.carrierPos, inp.carrierVel);
  // Closing speed: how fast the tackler runs into the carrier.
  const rel = sub(inp.tacklerVel, inp.carrierVel);
  const closing = Math.max(0, dot(rel, norm(sub(inp.carrierPos, inp.tacklerPos))));
  const T = TACKLE;
  const elusive = (inp.carrierStrength + inp.carrierSpeed) / 200;
  let p = T.base + T.tacklerWeight * (inp.tackling / 100) - T.elusiveWeight * elusive;
  p *= T.angle[approach];
  // A fast-moving carrier is hard to bring down from the side or behind; a fast tackler helps.
  const carrierSpeed = len(inp.carrierVel);
  p += T.speedEdge * (closing - (approach === 'headOn' ? 0 : carrierSpeed)) / 3;
  if (inp.engaged) p *= T.armTackle;
  if (inp.juking) p *= T.jukeFactor;
  p *= inp.factor;
  return { p: clamp(p, T.min, T.max), approach, closing };
}

export function resolveTackle(inp: TackleInput): TackleOutcome {
  const { p, approach, closing } = tackleProbability(inp);
  const success = inp.rng.chance(p);
  const T = TACKLE;
  let kind: ContactKind;
  if (success) {
    kind = approach === 'headOn' ? (closing >= T.shoulderClosingSpeed * 0.5 ? 'shoulder' : 'wrap') : approach === 'side' ? 'wrap' : 'stumble';
  } else {
    kind = approach === 'behind' ? 'stumble' : 'hipTurn';
  }
  return {
    success,
    kind,
    approach,
    probability: p,
    contactTime: T.contactTime[kind],
    fallForward: success ? T.fallForward[kind] : 0,
    slow: success ? 0 : kind === 'stumble' ? T.brokenSlow.stumble : T.brokenSlow.hipTurn,
  };
}
