/**
 * Penalty enforcement after the whistle (pure). The flag stays on the field
 * during the play; once the play is dead the offended team takes the better
 * of the play result or the penalty (accept/decline), then yardage is walked
 * off. Simplified enforcement (documented in ARCHITECTURE.md):
 *  - all fouls are enforced from the previous spot, except spot fouls (DPI),
 *  - half the distance to the goal when the yardage would cross it,
 *  - offsetting fouls replay the down,
 *  - defensive fouls with autoFirst give a first down; other accepted fouls
 *    replay the down with the new distance.
 */
import { clamp } from '../core/vec';
import type { Foul } from '../play/penalties';
import { applyPlay, type RulesPlay, type RulesResult } from './rules';
import type { GameState } from './state';

export interface Enforcement {
  result: RulesResult;
  /** The foul that was enforced (null: declined or offsetting). */
  enforced: Foul | null;
  declined: Foul | null;
  offsetting: boolean;
  /** Text for the post-play banner, e.g. "HOLDING, OFFENSE: 10 yards, replay 2nd down". */
  text: string;
}

const halfDistance = (ballY: number, yards: number, towardOwnGoal: boolean) =>
  towardOwnGoal ? Math.min(yards, ballY / 2) : Math.min(yards, (100 - ballY) / 2);

/** State after accepting `f` (no play result). */
export function penaltyState(s: GameState, f: Foul): GameState {
  const los = s.ballY;
  const toGain = s.ballY + s.toGo;
  if (f.side === 'off') {
    const loss = halfDistance(los, f.yards, true);
    const y = los - loss;
    return { ...s, ballY: y, toGo: toGain - y };
  }
  let y = f.spotFoul ? clamp(Math.max(f.spot.y, los + 1), 1, 99) : los + halfDistance(los, f.yards, false);
  y = Math.min(y, 99);
  if (f.autoFirst || y >= toGain) return { ...s, ballY: y, down: 1, toGo: Math.min(10, 100 - y) };
  return { ...s, ballY: y, toGo: toGain - y };
}

/** Rough value of a state for the offense (bigger = better). */
function offenseValue(r: RulesResult, offense: GameState['possession']): number {
  if (r.scored) return r.scored.side === offense ? 1000 + r.scored.points : -1000;
  if (r.possessionChanged) return -500;
  const st = r.state;
  return st.ballY + (st.down === 1 ? 30 : 0) - st.down * 4 - st.toGo * 0.5;
}

export function enforcePenalties(s: GameState, play: RulesPlay, fouls: readonly Foul[]): Enforcement {
  const playResult = applyPlay(s, play);
  if (fouls.length === 0) return { result: playResult, enforced: null, declined: null, offsetting: false, text: '' };
  const off = s.possession;
  const offFoul = fouls.find((f) => f.side === 'off');
  const defFoul = fouls.find((f) => f.side === 'def');
  const replay: RulesResult = { state: s, stop: 'penalty', possessionChanged: false, scored: null, headline: 'PENALTY' };

  if (offFoul && defFoul) {
    return { result: { ...replay, headline: 'OFFSETTING PENALTIES' }, enforced: null, declined: null, offsetting: true, text: 'Offsetting fouls, replay the down' };
  }
  const f = (offFoul ?? defFoul)!;
  const accepted: RulesResult = { ...replay, state: penaltyState(s, f), headline: f.label.toUpperCase() };
  if (f.dead) return { result: accepted, enforced: f, declined: null, offsetting: false, text: `${f.label}: ${f.yards} yards, replay the down` };

  const vPlay = offenseValue(playResult, off);
  const vPen = offenseValue(accepted, off);
  // The offended team picks: offense wants the higher value, defense the lower.
  const accept = f.side === 'def' ? vPen > vPlay : vPen < vPlay;
  if (!accept) {
    return { result: playResult, enforced: null, declined: f, offsetting: false, text: `${f.label}: declined` };
  }
  const yards = f.spotFoul ? 'spot foul' : `${f.yards} yards`;
  const how = accepted.state.down === 1 && f.side === 'def' ? 'first down' : 'replay the down';
  return { result: accepted, enforced: f, declined: null, offsetting: false, text: `${f.label}: ${yards}, ${how}` };
}
