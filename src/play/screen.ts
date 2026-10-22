/**
 * Screen passes: timing window and helpers (pure). A screen is thrown into a
 * window after the blockers have released: too early and the back is not
 * turned around yet (mostly incomplete), too late and the defense has read it
 * (contested, interceptions). Tunables in data/screens.json; the per-play
 * window lives on the play in plays.json.
 */
import screensJson from '../data/screens.json';
import type { ScreenDesign } from '../data/types';

export const SCREEN = screensJson as {
  earlyCatchFactor: number;
  lateCatchFactor: number;
  lateIntBonus: number;
  lateGrace: number;
  readDelay: number;
  reactRadius: number;
  convoySpacing: number;
  convoyDepth: number;
};

export type ScreenPhase = 'early' | 'ok' | 'late';

export interface ScreenTiming {
  phase: ScreenPhase;
  /** Multiplier on the receiver's catch chance. */
  catchFactor: number;
  /** Extra interception chance for a defender at the catch point. */
  intBonus: number;
}

/** Judge a screen throw released `t` seconds after the snap. */
export function screenTiming(t: number, s: ScreenDesign, tuning = SCREEN): ScreenTiming {
  const [open, close] = s.window;
  if (t < open) return { phase: 'early', catchFactor: tuning.earlyCatchFactor, intBonus: 0 };
  if (t <= close) return { phase: 'ok', catchFactor: 1, intBonus: 0 };
  // Late: the longer you wait, the more the defense has rallied to it.
  const k = Math.min(1, (t - close) / Math.max(0.05, tuning.lateGrace));
  return { phase: 'late', catchFactor: 1 - (1 - tuning.lateCatchFactor) * k, intBonus: tuning.lateIntBonus * k };
}
