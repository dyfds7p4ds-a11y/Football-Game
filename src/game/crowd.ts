/**
 * Crowd pulse: stadium energy from 0 to 100, from the home crowd's point of
 * view. It rises after big plays, takeaways and scores by the home team and
 * drops after penalties, turnovers and failed fourth downs. At high values
 * the home team gets a small, bounded edge (defensive pressure and penalty
 * chance), which can be turned off in the settings. Pure; tunables in
 * data/crowd.json.
 */
import { clamp } from '../core/vec';
import crowdJson from '../data/crowd.json';

export const CROWD = crowdJson as {
  start: number;
  baseline: number;
  decayPerPlay: number;
  bigPlayYards: number;
  deltas: Record<CrowdEvent, number>;
  edge: { threshold: number; maxPressure: number; maxPenalty: number };
};

export type CrowdEvent =
  | 'bigPlay' | 'firstDown' | 'touchdown' | 'fieldGoal' | 'takeaway' | 'sack' | 'defensiveStop'
  | 'opponentScore' | 'penaltyAgainst' | 'turnover' | 'failedFourthDown' | 'bigPlayAllowed';

/** What happened on a play, from the home team's perspective. */
export interface PlayForCrowd {
  /** Home team had the ball. */
  homeOffense: boolean;
  yards: number;
  firstDown: boolean;
  /** Points scored on the play and by whom. */
  score: { home: boolean; points: number } | null;
  /** Ball changed hands on a turnover (INT, fumble). */
  turnover: boolean;
  sack: boolean;
  /** An accepted penalty, and whether it was on the home team. */
  penaltyOnHome: boolean | null;
  /** Turnover on downs. */
  failedFourthDown: boolean;
  /** Opponent punted or failed: a defensive stop for the home team. */
  defensiveStop?: boolean;
}

export const crowdStart = (): number => CROWD.start;

/** Which crowd events a play triggers (positive or negative for the home crowd). */
export function crowdEvents(p: PlayForCrowd): CrowdEvent[] {
  const ev: CrowdEvent[] = [];
  const big = p.yards >= CROWD.bigPlayYards;
  if (p.homeOffense) {
    if (big) ev.push('bigPlay');
    else if (p.firstDown) ev.push('firstDown');
    if (p.turnover) ev.push('turnover');
    if (p.failedFourthDown) ev.push('failedFourthDown');
  } else {
    if (big) ev.push('bigPlayAllowed');
    if (p.turnover) ev.push('takeaway');
    if (p.sack) ev.push('sack');
    if (p.failedFourthDown || p.defensiveStop) ev.push('defensiveStop');
  }
  if (p.score) {
    if (p.score.home) ev.push(p.score.points >= 6 ? 'touchdown' : 'fieldGoal');
    else ev.push('opponentScore');
  }
  if (p.penaltyOnHome === true) ev.push('penaltyAgainst');
  return ev;
}

/** New meter value after a play: drift toward the baseline, then apply the events. */
export function updateCrowd(value: number, p: PlayForCrowd): number {
  let v = value + (CROWD.baseline - value) * CROWD.decayPerPlay;
  for (const e of crowdEvents(p)) v += CROWD.deltas[e];
  return clamp(v, 0, 100);
}

/** 0..1 how far the meter is into the "rocking" range. */
export function crowdIntensity(value: number): number {
  return clamp((value - CROWD.edge.threshold) / (100 - CROWD.edge.threshold), 0, 1);
}

export interface CrowdEdge {
  /** Multiplier on the home defense's pass rush. */
  homePressure: number;
  /** Multipliers on penalty chances. */
  homePenalty: number;
  awayPenalty: number;
}

/** Bounded home-field edge from the meter. `enabled = false` (setting) gives no edge. */
export function crowdEdge(value: number, enabled: boolean): CrowdEdge {
  if (!enabled) return { homePressure: 1, homePenalty: 1, awayPenalty: 1 };
  const k = crowdIntensity(value);
  return {
    homePressure: 1 + CROWD.edge.maxPressure * k,
    homePenalty: 1 - CROWD.edge.maxPenalty * 0.5 * k,
    awayPenalty: 1 + CROWD.edge.maxPenalty * k,
  };
}
