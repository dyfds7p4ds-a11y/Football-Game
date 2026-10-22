/**
 * Game-level sequencing between plays: clock stoppage, quarter breaks,
 * half time and the end of the game. Pure; used by both the interactive
 * app and simulated CPU drives.
 */
import { endPlayClock, isQuarterOver, nextQuarter, type StopReason } from './clock';
import { startSecondHalf } from './rules';
import { isTiedAfterRegulation, startOvertime } from './overtime';
import type { GameState } from './state';

export type Break = 'none' | 'quarter' | 'halftime' | 'overtime' | 'gameover';

export function afterPlay(s: GameState, stop: StopReason): { state: GameState; brk: Break } {
  return checkQuarter({ ...s, clock: endPlayClock(s.clock, stop) });
}

/** Call whenever the game clock may have hit 0 (after plays, or between plays). */
export function checkQuarter(s: GameState): { state: GameState; brk: Break } {
  if (s.over) return { state: { ...s, clock: { ...s.clock, running: false, playClockRunning: false } }, brk: 'gameover' };
  // Untimed: overtime, and a try after a touchdown at 0:00 is still played.
  if (s.overtime || s.pendingConversion || s.conversionTry || !isQuarterOver(s.clock)) return { state: s, brk: 'none' };
  const q = s.clock.quarter;
  if (q >= 4 && isTiedAfterRegulation(s)) return { state: startOvertime(s), brk: 'overtime' };
  if (q >= 4) return { state: { ...s, over: true, clock: { ...s.clock, running: false, playClockRunning: false } }, brk: 'gameover' };
  const advanced = { ...s, clock: nextQuarter(s.clock) };
  if (q === 2) return { state: startSecondHalf(advanced), brk: 'halftime' };
  return { state: advanced, brk: 'quarter' };
}
