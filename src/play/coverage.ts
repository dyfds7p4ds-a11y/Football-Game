/**
 * Route-concept reads for the CPU defense. After a short read delay the
 * defense identifies vertical stems and reacts the way a real secondary
 * would:
 *  - deep defenders bail at the snap and keep a cushion over the top,
 *  - underneath zone defenders carry vertical receivers through their zone,
 *  - man defenders on a vertical stem play "in phase" on the receiver's hip,
 *  - free safeties give over-the-top help (bracket) on the most dangerous
 *    vertical route,
 *  - the deep shell rolls toward the side with more vertical threats.
 *
 * Pure bookkeeping: PlaySim feeds perceived receiver states each step and
 * asks for goals. Tunables live in data/coverage.json.
 */
import type { Rng } from '../core/rng';
import { add, clamp, v2, type Vec2 } from '../core/vec';
import coverageJson from '../data/coverage.json';

export interface CoverageTuning {
  /** Seconds after the snap before stems are read (at coverageRead = 1; slower reads take longer). */
  readTime: number;
  /** A receiver this far past the LOS and still running upfield is a vertical threat. */
  verticalDepth: number;
  /** Fraction of his speed that must point downfield. */
  verticalSpeedFrac: number;
  /** Yards a deep zone defender keeps over the top of his threat. */
  deepCushion: number;
  /** Seconds of the receiver's velocity added to the deep defender's target. */
  deepLead: number;
  /** Underneath defenders carry verticals to this depth past the LOS. */
  carryDepth: number;
  /** Carry is released early once a deep defender is this far over the top. */
  carryHandoffCushion: number;
  /** Fraction of the reaction lag a man defender keeps once in phase. */
  phaseLag: number;
  phaseLead: number;
  /** Inside leverage and trail distance (yards) of an in-phase man defender. */
  phaseInside: number;
  phaseTrail: number;
  /** Extra seconds a man defender with his back to the QB needs to find the ball. */
  manBallReadDelay: number;
  /** Over-the-top cushion and lead for a helping safety. */
  helpCushion: number;
  helpLead: number;
  /** Max lateral distance (yards) a safety will travel to help. */
  helpReach: number;
  /** A safety only switches help to a route this much (s) more open than his current one. */
  helpSwitchMargin: number;
  /** 0..1: how far a splitting safety leans toward the route he helps on. */
  helpLean: number;
  /** Seconds between re-reads of the most dangerous route. */
  rereadInterval: number;
  /** Yards the deep shell shifts per extra vertical on one side, and the cap. */
  rollShift: number;
  rollMax: number;
  /** Max distance (yards) for a defender to count as in phase with a receiver. */
  inPhaseDist: number;
  /** Extra breakup / interception chance when the defender is in phase at the catch point. */
  inPhaseBreakup: number;
  inPhaseInt: number;
}

export const COVERAGE = coverageJson as CoverageTuning;

export interface ReadTarget {
  id: number;
  /** Perceived position / velocity (with the defense's reaction lag). */
  pos: Vec2;
  vel: Vec2;
  maxSpeed: number;
  blocks: boolean;
}

export interface Helper {
  id: number;
  /** Lateral center of the helper's zone. */
  homeX: number;
}

/** Read delay for a given read quality (0..1). */
export function readDelay(quality: number, t = COVERAGE): number {
  return t.readTime * (1 + 1.5 * (1 - clamp(quality, 0, 1)));
}

export function isVertical(r: ReadTarget, los: number, t = COVERAGE): boolean {
  if (r.blocks) return false;
  return r.pos.y > los + t.verticalDepth && r.vel.y > r.maxSpeed * t.verticalSpeedFrac;
}

export class CoverageReader {
  readonly readAt: number;
  /** Receivers identified as vertical threats (sticky once read). */
  readonly verticals = new Set<number>();
  /** Safety id -> receiver id he helps over the top. */
  readonly help = new Map<number, number>();
  /** Lateral shift (yards) of the deep shell toward the vertical-heavy side. */
  roll = 0;
  private nextReread = 0;

  constructor(private quality: number, private rng: Rng, private tuning = COVERAGE) {
    this.readAt = readDelay(quality, tuning);
  }

  get active(): boolean {
    return this.nextReread > 0;
  }

  /**
   * @param danger how open each receiver is (bigger = more dangerous), from
   *   the sim's throwing-window metric.
   */
  update(t: number, los: number, ballX: number, receivers: ReadTarget[], helpers: Helper[], danger: (id: number) => number) {
    if (t < this.readAt) return;
    const T = this.tuning;
    for (const r of receivers) if (isVertical(r, los, T)) this.verticals.add(r.id);
    let side = 0;
    for (const r of receivers) if (this.verticals.has(r.id)) side += Math.sign(r.pos.x - ballX);
    const want = clamp(side * T.rollShift, -T.rollMax, T.rollMax) * this.quality;
    this.roll += (want - this.roll) * 0.1;

    if (t < this.nextReread || this.verticals.size === 0) return;
    this.nextReread = t + T.rereadInterval;
    const taken = new Set<number>();
    for (const hlp of helpers) {
      const options = receivers
        .filter((r) => this.verticals.has(r.id) && !taken.has(r.id) && Math.abs(r.pos.x - hlp.homeX) < T.helpReach)
        .map((r) => ({ r, score: danger(r.id) - Math.abs(r.pos.x - hlp.homeX) * 0.03 }))
        .sort((a, b) => b.score - a.score);
      if (options.length === 0) {
        this.help.delete(hlp.id);
        continue;
      }
      // Stick with the current man unless another route is clearly more open.
      const cur = options.find((o) => o.r.id === this.help.get(hlp.id));
      let pick = options[0];
      if (cur && pick !== cur && pick.score - cur.score < T.helpSwitchMargin) pick = cur;
      // A poor read sometimes takes the wrong man.
      else if (!cur && options.length > 1 && !this.rng.chance(0.35 + 0.65 * this.quality)) pick = options[1];
      this.help.set(hlp.id, pick.r.id);
      taken.add(pick.r.id);
    }
  }
}

/** Over-the-top target for a deep defender on `r` (inside leverage toward the ball). */
export function overTop(r: { pos: Vec2; vel: Vec2 }, ballX: number, cushion: number, lead: number): Vec2 {
  const inward = Math.sign(ballX - r.pos.x) || 1;
  return v2(r.pos.x + inward * 1.2 + r.vel.x * lead, r.pos.y + cushion + Math.max(0, r.vel.y) * lead);
}

/** In-phase trail position: on the receiver's inside hip, matching his speed. */
export function inPhaseSpot(r: { pos: Vec2; vel: Vec2 }, ballX: number, t = COVERAGE): Vec2 {
  const inward = Math.sign(ballX - r.pos.x) || 1;
  return add(add(r.pos, v2(r.vel.x * t.phaseLead, r.vel.y * t.phaseLead)), v2(inward * t.phaseInside, -t.phaseTrail));
}

/** Underneath carry: trail a vertical receiver on his inside, slightly under him. */
export function carrySpot(r: { pos: Vec2; vel: Vec2 }, ballX: number): Vec2 {
  const inward = Math.sign(ballX - r.pos.x) || 1;
  return v2(r.pos.x + inward * 0.9 + r.vel.x * 0.3, r.pos.y - 0.6 + r.vel.y * 0.3);
}
