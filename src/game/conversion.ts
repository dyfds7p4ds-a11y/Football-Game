/**
 * Tries after a touchdown (pure). The scoring team chooses: a kick for one
 * point (a field goal of `conversion.patDistance` yards) or one play from the
 * opponent's 3 for two. The user picks on a choice screen; the CPU uses the
 * classic chart from the fourth quarter on (kick otherwise). From the second
 * overtime period the two-point try is mandatory. Tunables: data/rules.json.
 */
import type { Rng } from '../core/rng';
import rulesJson from '../data/rules.json';
import { finishTry, type RulesResult, type TryKind } from './rules';
import { mustGoForTwo } from './overtime';
import { other, type GameState, type TeamSide } from './state';

export const CONVERSION = rulesJson.conversion;
export type { TryKind } from './rules';

/** What the scoring team may choose. */
export function conversionOptions(s: GameState): TryKind[] {
  return mustGoForTwo(s) ? ['two'] : ['kick', 'two'];
}

/** CPU choice, after the touchdown points are on the board. */
export function chooseConversion(s: GameState, side: TeamSide): TryKind {
  const opts = conversionOptions(s);
  if (opts.length === 1) return opts[0];
  const c = CONVERSION.chart;
  // Overtime period 1: kick to match, go for two only to win when the other team already had the ball.
  if (s.overtime) {
    const diff = s.score[side] - s.score[other(side)];
    return s.overtime.done === 1 && diff === -1 ? 'two' : 'kick';
  }
  if (s.clock.quarter < c.fromQuarter) return 'kick';
  const diff = s.score[side] - s.score[other(side)];
  if (diff < 0 && c.goForTwoTrailing.includes(-diff)) return 'two';
  if (diff > 0 && c.goForTwoLeading.includes(diff)) return 'two';
  return 'kick';
}

/** Set up the two-point play: the scoring team's ball at the opponent's 3, one play. */
export function startTwoPointTry(s: GameState): GameState {
  const side = s.pendingConversion ?? s.possession;
  const spot = CONVERSION.spot;
  return { ...s, possession: side, ballY: 100 - spot, ballX: 0, down: 1, toGo: spot, conversionTry: 'two', pendingKickoff: null };
}

/** Field-goal distance of the extra-point kick. */
export const patDistance = () => CONVERSION.patDistance;

/** A try resolved without playing it (quick sim, simulated drives, CPU kicks). */
export function quickConversion(s: GameState, kind: TryKind, rng: Rng, skill = 1): RulesResult {
  const p = kind === 'kick' ? CONVERSION.quickKick : Math.min(0.9, CONVERSION.quickTwo * skill);
  return finishTry(s, kind, rng.chance(p));
}
