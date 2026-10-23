import { describe, expect, it } from 'vitest';
import { PACE } from '../src/game/clock';
import { estimateRealSeconds } from '../src/game/pace';
import { simulateGameLength } from './gameHarness';

describe('Phase 3c: game length', () => {
  it(`a ${PACE.targetQuarterMinutes}-minute-quarter game fits in ${PACE.targetRealMinutes} real minutes (estimate, 20 games)`, () => {
    const games = Array.from({ length: 20 }, (_, i) => simulateGameLength(PACE.targetQuarterMinutes, i + 1));
    const avg = (f: (g: (typeof games)[0]) => number) => games.reduce((t, g) => t + f(g), 0) / games.length;
    if (process.env.BALANCE_STATS) console.log('game length', { plays: avg((g) => g.plays), sPerPlay: avg((g) => g.secondsPerPlay), stops: avg((g) => g.clockStops), real: avg((g) => g.realMinutes) });
    expect(avg((g) => g.realMinutes)).toBeLessThanOrEqual(PACE.targetRealMinutes);
    // Sane football: NFL-like share of snaps with a running clock, a realistic number of plays.
    expect(avg((g) => g.clockStops / (g.plays + 1))).toBeLessThan(0.65);
    expect(avg((g) => g.plays)).toBeGreaterThan(30);
    for (const g of games) expect(g.secondsPerPlay).toBeGreaterThan(12);
  }, 30000);

  it('longer quarters give longer games; the estimate adds up its parts', () => {
    expect(simulateGameLength(8, 3).realMinutes).toBeGreaterThan(simulateGameLength(3, 3).realMinutes);
    const R = PACE.real;
    expect(estimateRealSeconds({ plays: 2, userPlays: 1, kicks: 1, scores: 1, breaks: 1 }))
      .toBeCloseTo(R.call + R.presnap + R.cpuCall + R.cpuPresnap + 2 * (R.live + R.post) + R.kick + R.score + R.break, 9);
  });
});
