/**
 * Pure down/distance/scoring/possession rules. Every function returns a new
 * GameState; nothing here touches the clock except to record why it stopped.
 *
 * Simplifications (Phase 1, documented in README "Known gaps"):
 * - Phase 3b: touchdowns are worth 6, then the scoring team has a try
 *   (`pendingConversion`): a kick for 1 or a play from the 3 for 2
 *   (game/conversion.ts). In overtime every possession end goes through
 *   game/overtime.ts.
 * - Kickoffs are skipped: the receiving team starts at its own 25.
 * - Safeties: 2 points, the scored-on team "free kicks" -> opponent at its 25.
 * - Punts and field goals are resolved instantly from a formula.
 */
import type { Rng } from '../core/rng';
import { clamp } from '../core/vec';
import { hashX } from '../play/field';
import type { PlayOutcome } from '../play/sim';
import type { StopReason } from './clock';
import { other, type GameState, type TeamSide } from './state';
import { endOvertimePossession, overtimeTryNeeded } from './overtime';
import rulesJson from '../data/rules.json';

export const TOUCHBACK = 25;
export const PUNT_TOUCHBACK = 20;

/** The subset of a play result the rules care about. */
export interface RulesPlay {
  outcome: PlayOutcome;
  endY: number;
  endX: number;
}

export interface RulesResult {
  state: GameState;
  stop: StopReason;
  possessionChanged: boolean;
  scored: { side: TeamSide; points: number } | null;
  /** Short headline for the HUD banner, e.g. "FIRST DOWN". */
  headline: string;
}

/**
 * New possession at `ballY`; `kicker` (after scores, safeties and at half time) must kick off first.
 * Overtime: every possession change goes to the next overtime possession instead (`defenseScored`
 * ends the game).
 */
export function startPossession(s: GameState, side: TeamSide, ballY: number, kicker: TeamSide | null = null, defenseScored = false): GameState {
  if (s.overtime) return endOvertimePossession(s, defenseScored);
  const y = clamp(ballY, 1, 99);
  return { ...s, possession: side, ballY: y, ballX: 0, down: 1, toGo: Math.min(10, 100 - y), pendingKickoff: kicker };
}

function addScore(s: GameState, side: TeamSide, pts: number): GameState {
  return { ...s, score: { ...s.score, [side]: s.score[side] + pts } };
}

/**
 * Touchdown by `side` (offense, pick six or return): 6 points, then the try. In overtime a
 * defensive touchdown ends the game, and a touchdown that already wins needs no try.
 */
export function scoreTouchdown(s: GameState, side: TeamSide, headline: string): RulesResult {
  const st = addScore({ ...s, conversionTry: null }, side, 6);
  const scored = { side, points: 6 };
  if (s.overtime && side !== s.possession) return { state: endOvertimePossession(st, true), stop: 'score', possessionChanged: true, scored, headline };
  if (s.overtime && !overtimeTryNeeded(st, side)) return { state: endOvertimePossession(st), stop: 'score', possessionChanged: true, scored, headline };
  return { state: { ...st, possession: side, pendingConversion: side, pendingKickoff: null }, stop: 'score', possessionChanged: true, scored, headline };
}

export type TryKind = 'kick' | 'two';

/**
 * The try is over (a kick or a two-point play, also an overtime shootout play): add 1 / 2
 * points on success, then the kickoff by the scoring team, or the next overtime possession.
 */
export function finishTry(s: GameState, kind: TryKind, success: boolean): RulesResult {
  const side = s.pendingConversion ?? s.possession;
  const pts = success ? (kind === 'kick' ? 1 : 2) : 0;
  const st = addScore({ ...s, pendingConversion: null, conversionTry: null }, side, pts);
  const headline = kind === 'kick' ? (success ? 'EXTRA POINT IS GOOD' : 'EXTRA POINT MISSED') : success ? 'TWO-POINT TRY IS GOOD' : 'TWO-POINT TRY FAILS';
  const next = st.overtime ? endOvertimePossession(st) : startPossession(st, other(side), TOUCHBACK, side);
  return { state: next, stop: 'score', possessionChanged: true, scored: pts ? { side, points: pts } : null, headline };
}

export function applyPlay(s: GameState, p: RulesPlay): RulesResult {
  const off = s.possession;
  const def = other(off);
  if (s.conversionTry) {
    // Two-point try: one play, good only as a touchdown (a false start just replays it).
    if (p.outcome === 'noPlay') return { state: s, stop: 'penalty', possessionChanged: false, scored: null, headline: 'NO PLAY' };
    return finishTry(s, 'two', p.outcome === 'touchdown');
  }
  switch (p.outcome) {
    case 'touchdown':
      return scoreTouchdown(s, off, 'TOUCHDOWN!');
    case 'safety': {
      const st = startPossession(addScore(s, def, 2), def, TOUCHBACK, off, true);
      return { state: st, stop: 'score', possessionChanged: true, scored: { side: def, points: 2 }, headline: 'SAFETY' };
    }
    case 'interception': {
      const theirY = 100 - p.endY;
      if (theirY >= 100) return scoreTouchdown(s, def, 'PICK SIX!');
      const st = startPossession(s, def, theirY <= 0 ? TOUCHBACK : theirY);
      return { state: st, stop: 'turnover', possessionChanged: true, scored: null, headline: 'INTERCEPTED' };
    }
    case 'incomplete':
      return advanceDown(s, s.ballY, s.ballX, 'incomplete', 'INCOMPLETE');
    case 'noPlay':
      return { state: s, stop: 'penalty', possessionChanged: false, scored: null, headline: 'NO PLAY' };
    case 'outOfBounds':
      return advanceDown(s, p.endY, hashX(p.endX), 'outOfBounds', '');
    case 'tackle':
    case 'sack':
      return advanceDown(s, p.endY, hashX(p.endX), 'inbounds', p.outcome === 'sack' ? 'SACK' : '');
  }
}

function advanceDown(s: GameState, newY: number, newX: number, stop: StopReason, headline: string): RulesResult {
  const firstDownLine = s.ballY + s.toGo;
  const y = clamp(newY, 0.5, 99.5);
  if (y >= firstDownLine) {
    return {
      state: { ...s, ballY: y, ballX: newX, down: 1, toGo: Math.min(10, 100 - y) },
      stop, possessionChanged: false, scored: null, headline: 'FIRST DOWN',
    };
  }
  if (s.down >= 4) {
    const st = startPossession(s, other(s.possession), 100 - y);
    return { state: st, stop: 'possession', possessionChanged: true, scored: null, headline: 'TURNOVER ON DOWNS' };
  }
  return {
    state: { ...s, ballY: y, ballX: newX, down: s.down + 1, toGo: firstDownLine - y },
    stop, possessionChanged: false, scored: null, headline,
  };
}

/** Delay of game: 5 yards (half the distance near the goal), replay the down. */
export function delayOfGame(s: GameState): RulesResult {
  const loss = Math.min(5, s.ballY / 2);
  const st = { ...s, ballY: s.ballY - loss, toGo: s.toGo + loss };
  return { state: st, stop: 'penalty', possessionChanged: false, scored: null, headline: 'DELAY OF GAME' };
}

export function fieldGoalDistance(ballY: number): number {
  return Math.round(100 - ballY + 17);
}

export function fieldGoalProbability(distance: number, kickerSkill = 1): number {
  return clamp((0.99 - Math.max(0, distance - 22) * 0.021) * kickerSkill, 0.03, 0.99);
}

export function attemptFieldGoal(s: GameState, rng: Rng): RulesResult & { distance: number; good: boolean } {
  const distance = fieldGoalDistance(s.ballY);
  const good = rng.chance(fieldGoalProbability(distance));
  const off = s.possession;
  const def = other(off);
  if (good) {
    const st = startPossession(addScore(s, off, 3), def, TOUCHBACK, off);
    return { state: st, stop: 'score', possessionChanged: true, scored: { side: off, points: 3 }, headline: `${distance}-YD FIELD GOAL IS GOOD`, distance, good };
  }
  const kickSpot = s.ballY - 7;
  const st = startPossession(s, def, Math.max(PUNT_TOUCHBACK, 100 - kickSpot));
  return { state: st, stop: 'possession', possessionChanged: true, scored: null, headline: `${distance}-YD FIELD GOAL MISSED`, distance, good };
}

export function punt(s: GameState, rng: Rng): RulesResult & { net: number } {
  const gross = rng.int(36, 50);
  const landing = s.ballY + gross;
  let theirY: number;
  let net: number;
  if (landing >= 100) {
    theirY = PUNT_TOUCHBACK;
    net = 100 - s.ballY - PUNT_TOUCHBACK;
  } else {
    const ret = rng.int(0, 12);
    theirY = 100 - landing + ret;
    net = gross - ret;
  }
  const st = startPossession(s, other(s.possession), theirY);
  return { state: st, stop: 'possession', possessionChanged: true, scored: null, headline: `PUNT, NET ${net} YARDS`, net };
}

/** Half time: the team that did not receive the opening kick gets the ball. */
export function startSecondHalf(s: GameState): GameState {
  // The opening receiver kicks off to start the second half.
  const n = rulesJson.timeouts.perHalf;
  return startPossession({ ...s, timeouts: { home: n, away: n } }, other(s.openingReceiver), TOUCHBACK, s.openingReceiver);
}
