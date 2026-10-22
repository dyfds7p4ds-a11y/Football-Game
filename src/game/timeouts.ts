/**
 * Timeouts (pure). Three per team per half (`rules.json` timeouts.perHalf,
 * reset at half time by rules.startSecondHalf), one per team per overtime
 * period (game/overtime.ts). A timeout stops the game clock and resets the
 * play clock. The CPU calls one on offense late in a half when it trails and
 * the clock is running.
 */
import rulesJson from '../data/rules.json';
import { callTimeoutClock } from './clock';
import { other, type GameState, type TeamSide } from './state';

export const TIMEOUTS = rulesJson.timeouts;

export function canCallTimeout(s: GameState, side: TeamSide): boolean {
  return !s.over && s.timeouts[side] > 0;
}

/** `side` calls a timeout; null when it has none left. */
export function callTimeout(s: GameState, side: TeamSide): GameState | null {
  if (!canCallTimeout(s, side)) return null;
  return { ...s, timeouts: { ...s.timeouts, [side]: s.timeouts[side] - 1 }, clock: callTimeoutClock(s.clock) };
}

/** The CPU offense saves time: late in either half, trailing (or tied in the 4th), clock running. */
export function cpuWantsTimeout(s: GameState, cpu: TeamSide): boolean {
  if (s.overtime || !s.clock.running || s.possession !== cpu || s.timeouts[cpu] <= 0) return false;
  const q = s.clock.quarter;
  if (q !== 2 && q !== 4) return false;
  if (s.clock.remaining > TIMEOUTS.cpuLateSeconds) return false;
  const diff = s.score[cpu] - s.score[other(cpu)];
  return diff < 0 || (q === 4 && diff === 0) || q === 2;
}
