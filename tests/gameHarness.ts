import { Rng } from '../src/core/rng';
import { DIFFICULTY } from '../src/data';
import { simulateCpuDrive } from '../src/game/cpuDrive';
import { afterPlay } from '../src/game/flow';
import { estimateRealSeconds, type GameCounts } from '../src/game/pace';
import { applyReturn } from '../src/game/specialTeams';
import { newGame, other, type GameState } from '../src/game/state';
import { tickClock } from '../src/game/clock';

export interface GameLength extends GameCounts {
  /** Game-clock seconds per snap, punts and field goals included (huddle runoff included). */
  secondsPerPlay: number;
  /** Snaps after which the game clock was stopped. */
  clockStops: number;
  realMinutes: number;
}

/**
 * Phase 3c: a whole game with both teams on the quick-sim drive model (same
 * rules, clock and snap timing as played snaps); kickoffs are returned to
 * about the 25. The user is home.
 */
export function simulateGameLength(quarterMinutes: number, seed: number): GameLength {
  const rng = new Rng(seed);
  let s: GameState = newGame({ home: 'rheinstadt', away: 'elbtal', userSide: 'home', difficulty: 'normal', quarterLength: quarterMinutes * 60, seed });
  const c = { plays: 0, userPlays: 0, kicks: 0, snapKicks: 0, scores: 0, breaks: 0, seconds: 0, clockStops: 0 };
  for (let guard = 0; guard < 400 && !s.over; guard++) {
    if (s.pendingKickoff) {
      const kicking = s.pendingKickoff;
      const r = applyReturn({ ...s, clock: tickClock({ ...s.clock, running: true }, rng.range(4, 7)).clock }, kicking, 'kickoff', 'tackle', 18 + rng.range(0, 14));
      c.kicks++;
      s = afterPlay(r.state, 'inbounds').state;
      continue;
    }
    const side = s.possession;
    const scoreBefore = s.score.home + s.score.away;
    const d = simulateCpuDrive(s, DIFFICULTY.normal, rng, {
      onPlay: (p) => {
        c.seconds += p.seconds;
        if (p.clockStopped) c.clockStops++;
        if (p.kick) {
          c.kicks++;
          c.snapKicks++;
          return;
        }
        c.plays++;
        if (side === s.userSide) c.userPlays++;
      },
    });
    if (d.state.score.home + d.state.score.away > scoreBefore) c.scores++;
    if (d.brk === 'halftime' || d.state.clock.quarter !== s.clock.quarter) c.breaks++;
    s = d.state;
    if (s.possession === side && !s.pendingKickoff && !s.over && d.brk === 'none') s = { ...s, possession: other(side) };
  }
  const counts: GameCounts = { plays: c.plays, userPlays: c.userPlays, kicks: c.kicks, scores: c.scores, breaks: Math.max(c.breaks, 3) };
  return { ...counts, secondsPerPlay: c.seconds / Math.max(1, c.plays + c.snapKicks), clockStops: c.clockStops, realMinutes: estimateRealSeconds(counts) / 60 };
}
