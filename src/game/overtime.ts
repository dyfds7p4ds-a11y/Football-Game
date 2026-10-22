/**
 * Overtime (pure), college rules as in the NCAA 2021 book:
 *
 * - A tie after four quarters goes to overtime. The coin toss winner defers:
 *   the other team has the first possession of period 1.
 * - Each period, both teams get one possession, first-and-10 from the
 *   opponent's 25 (`rules.json` overtime.startYard). No kickoffs, no punts,
 *   no game clock (the play clock still runs).
 * - A possession ends on a score, a turnover or a turnover on downs. A score
 *   by the defense (pick six) ends the game.
 * - After both possessions: different scores end the game; a tie starts the
 *   next period with the other team going first.
 * - From period 2 a touchdown must be followed by a two-point try.
 * - From period 3 there are no possessions from the 25: each team runs one
 *   two-point play per period, alternating, until one scores and the other
 *   does not.
 * - Each team has one timeout per period.
 *
 * Simplifications: the coin toss is the game seed's parity; the winner always
 * defers. When the team with the second possession scores a touchdown that
 * already wins (lead > 2), the game ends without the try.
 */
import rulesJson from '../data/rules.json';
import { other, type GameState, type TeamSide } from './state';

export const OT = rulesJson.overtime;

export function isTiedAfterRegulation(s: GameState): boolean {
  return !s.overtime && s.score.home === s.score.away;
}

/** Period-1 setup: the coin-toss winner defers, the other team has the ball first. */
export function startOvertime(s: GameState, coinWinner: TeamSide = s.seed % 2 === 0 ? 'home' : 'away'): GameState {
  const first = other(coinWinner);
  const st: GameState = {
    ...s,
    overtime: { period: 1, first, done: 0 },
    timeouts: { home: OT.timeoutsPerPeriod, away: OT.timeoutsPerPeriod },
    pendingKickoff: null,
    pendingConversion: null,
    clock: { ...s.clock, remaining: 0, running: false },
  };
  return possessionStart(st, first);
}

export const isShootout = (s: GameState) => !!s.overtime && s.overtime.period >= OT.shootoutFrom;
export const mustGoForTwo = (s: GameState) => !!s.overtime && s.overtime.period >= OT.twoPointRequiredFrom;

/** Ball for `side`: from the opponent's 25, or a single two-point play in shootout periods. */
export function possessionStart(s: GameState, side: TeamSide): GameState {
  if (isShootout(s)) {
    const spot = rulesJson.conversion.spot;
    return { ...s, possession: side, ballY: 100 - spot, ballX: 0, down: 1, toGo: spot, pendingKickoff: null, conversionTry: 'two' };
  }
  const y = 100 - OT.startYard;
  return { ...s, possession: side, ballY: y, ballX: 0, down: 1, toGo: 10, pendingKickoff: null, conversionTry: null };
}

/**
 * The current overtime possession is over (`defenseScored`: the defense scored
 * on it). Next possession, next period, or the end of the game.
 */
export function endOvertimePossession(s: GameState, defenseScored = false): GameState {
  const ot = s.overtime!;
  const base = { ...s, pendingConversion: null, conversionTry: null };
  if (defenseScored) return { ...base, over: true };
  const done = ot.done + 1;
  if (done === 1) return possessionStart({ ...base, overtime: { ...ot, done } }, other(ot.first));
  if (s.score.home !== s.score.away) return { ...base, overtime: { ...ot, done }, over: true };
  // Still tied: next period, the team that went second goes first.
  const next = { period: ot.period + 1, first: other(ot.first), done: 0 };
  return possessionStart({ ...base, overtime: next, timeouts: { home: OT.timeoutsPerPeriod, away: OT.timeoutsPerPeriod } }, next.first);
}

/**
 * After an overtime touchdown: is the try still needed? Not when the team with
 * the second possession already leads by more than two (the game is won).
 */
export function overtimeTryNeeded(s: GameState, scorer: TeamSide): boolean {
  const ot = s.overtime;
  if (!ot || ot.done === 0) return true;
  return s.score[scorer] - s.score[other(scorer)] <= 2;
}

/** "OT", "2OT", ... for the HUD. */
export function overtimeLabel(s: GameState): string {
  const p = s.overtime?.period ?? 0;
  return p <= 1 ? 'OT' : `${p}OT`;
}
