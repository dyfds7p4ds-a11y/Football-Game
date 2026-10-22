/**
 * Special-teams rules (pure): where the ball ends up after a kickoff, punt or
 * field goal that was actually played (meter + flight + return). The Phase 1
 * instant formulas in rules.ts stay available as "Quick sim".
 *
 * Frames: kicks are computed in the kicking team's frame (kicking toward
 * +y); returns run in the receiving team's frame. `toReceivingFrame` converts.
 */
import type { Vec2 } from '../core/vec';
import { clamp } from '../core/vec';
import { ST } from '../play/kicking';
import { other, type GameState, type TeamSide } from './state';
import type { RulesResult } from './rules';

export function toReceivingFrame(p: Vec2): Vec2 {
  return { x: -p.x, y: 100 - p.y };
}

function possession(s: GameState, side: TeamSide, ballY: number): GameState {
  const y = clamp(ballY, 1, 99);
  return { ...s, possession: side, ballY: y, ballX: 0, down: 1, toGo: Math.min(10, 100 - y), pendingKickoff: null };
}

function addScore(s: GameState, side: TeamSide, pts: number): GameState {
  return { ...s, score: { ...s.score, [side]: s.score[side] + pts } };
}

export type ReturnOutcome = 'tackle' | 'outOfBounds' | 'touchdown' | 'touchback' | 'downed' | 'safety';

/** Kickoff or punt return finished: give the ball to the receiving team. */
export function applyReturn(s: GameState, kicking: TeamSide, kind: 'kickoff' | 'punt', outcome: ReturnOutcome, endY: number): RulesResult {
  const recv = other(kicking);
  if (outcome === 'touchdown') {
    // Return TD: the returning team scores and will kick off.
    const st = possession(addScore(s, recv, 7), kicking, ST.rules.touchback);
    return { state: { ...st, pendingKickoff: recv }, stop: 'score', possessionChanged: true, scored: { side: recv, points: 7 }, headline: kind === 'kickoff' ? 'KICK RETURN TOUCHDOWN!' : 'PUNT RETURN TOUCHDOWN!' };
  }
  if (outcome === 'safety') {
    // Returner downed in his own end zone after bringing it out: safety, he free-kicks.
    const st = possession(addScore(s, kicking, 2), kicking, ST.rules.touchback);
    return { state: { ...st, pendingKickoff: recv }, stop: 'score', possessionChanged: true, scored: { side: kicking, points: 2 }, headline: 'SAFETY' };
  }
  const y = outcome === 'touchback' ? (kind === 'kickoff' ? ST.rules.touchback : ST.rules.puntTouchback) : endY;
  const headline = outcome === 'touchback' ? 'TOUCHBACK' : outcome === 'downed' ? 'PUNT DOWNED' : '';
  return { state: possession(s, recv, y), stop: 'possession', possessionChanged: true, scored: null, headline };
}

/** Kickoff out of bounds: receiving team at its 40. */
export function kickoffOutOfBounds(s: GameState, kicking: TeamSide): RulesResult {
  return { state: possession(s, other(kicking), ST.rules.kickoffOutOfBounds), stop: 'possession', possessionChanged: true, scored: null, headline: 'KICKOFF OUT OF BOUNDS' };
}

/** A field goal attempt that was played (judged by the flight). */
export function applyFieldGoal(s: GameState, good: boolean, distance: number): RulesResult {
  const off = s.possession;
  const def = other(off);
  if (good) {
    const st = possession(addScore(s, off, 3), def, ST.rules.touchback);
    return { state: { ...st, pendingKickoff: off }, stop: 'score', possessionChanged: true, scored: { side: off, points: 3 }, headline: `${distance}-YD FIELD GOAL IS GOOD` };
  }
  const kickSpot = s.ballY - ST.rules.fieldGoalSnapBack;
  return { state: possession(s, def, Math.max(ST.rules.puntTouchback, 100 - kickSpot)), stop: 'possession', possessionChanged: true, scored: null, headline: `${distance}-YD FIELD GOAL MISSED` };
}
