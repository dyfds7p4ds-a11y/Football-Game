/**
 * Phase 3c: game length (pure). `estimateRealSeconds()` turns a game's counts
 * (snaps, kicks, scores, breaks) into an estimated real-time length with the
 * per-step costs in data/pace.json `real`. Used by the game-length balance
 * test and probe; the clock rules themselves live in clock.ts.
 */
import { PACE } from './clock';

export interface GameCounts {
  /** Scrimmage snaps (both teams). */
  plays: number;
  /** Snaps where the user's team had the ball (the rest are CPU snaps, played as defense). */
  userPlays: number;
  /** Kickoffs, punts and field goal attempts. */
  kicks: number;
  scores: number;
  /** Quarter and half breaks. */
  breaks: number;
}

export function estimateRealSeconds(c: GameCounts): number {
  const R = PACE.real;
  const cpuPlays = c.plays - c.userPlays;
  return c.userPlays * (R.call + R.presnap + R.live + R.post) + cpuPlays * (R.cpuCall + R.cpuPresnap + R.live + R.post) +
    c.kicks * R.kick + c.scores * R.score + c.breaks * R.break;
}
