import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import { DIFFICULTY, PLAYS, getTeam } from '../src/data';
import type { Difficulty } from '../src/data/types';
import { DEFENSE_CALLS } from '../src/play/defenseCalls';
import { CpuQB, chooseCpuPlay, fourthDownCall } from '../src/play/qbAI';
import { PlaySim } from '../src/play/sim';

function cpuGame(difficulty: Difficulty, seeds: number) {
  const stats = { plays: 0, passPlays: 0, att: 0, comp: 0, int: 0, sack: 0, unfinished: 0, yards: 0 };
  for (const play of PLAYS) for (const def of DEFENSE_CALLS) for (let s = 0; s < seeds; s++) {
    const diff = DIFFICULTY[difficulty];
    const sim = new PlaySim({
      play, defense: def, offenseTeam: getTeam('elbtal'), defenseTeam: getTeam('rheinstadt'), ballX: 0, los: 30,
      // No user defender here: all eleven defenders are CPU, so the numbers measure the CPU QB alone.
      difficulty: { ...DIFFICULTY.normal, penaltyRate: 0 }, seed: 1000 + s,
    });
    const qb = new CpuQB(play, diff, new Rng(77 + s));
    for (let i = 0; i < 60 * 15 && !sim.result; i++) sim.step(qb.input(sim));
    stats.plays++;
    if (!sim.result) { stats.unfinished++; continue; }
    const r = sim.result;
    stats.yards += r.yards;
    if (!play.run) stats.passPlays++;
    if (r.passAttempt) stats.att++;
    if (r.completion) stats.comp++;
    if (r.outcome === 'interception') stats.int++;
    if (r.outcome === 'sack') stats.sack++;
  }
  return stats;
}

describe('CPU quarterback', () => {
  it('plays every play to a whistle with sane pass numbers (Normal)', () => {
    const s = cpuGame('normal', 3);
    if (process.env.QB_STATS) console.log('cpu qb normal', s, { comp: s.comp / s.att, int: s.int / s.att, sack: s.sack / s.passPlays, ypp: s.yards / s.plays });
    expect(s.unfinished).toBe(0);
    expect(s.att / s.passPlays).toBeGreaterThan(0.7);
    expect(s.comp / s.att).toBeGreaterThan(0.4);
    expect(s.comp / s.att).toBeLessThan(0.85);
    expect(s.int / s.att).toBeLessThan(0.1);
    expect(s.sack / s.passPlays).toBeLessThan(0.2);
  }, 120000);

  it('Hard CPU offense moves the ball better than Easy', () => {
    const e = cpuGame('easy', Number(process.env.QB_SEEDS ?? 2));
    const h = cpuGame('hard', Number(process.env.QB_SEEDS ?? 2));
    if (process.env.QB_STATS) console.log('easy vs hard', e, h);
    // Passer efficiency: completions minus three per interception, per attempt.
    const eff = (x: typeof e) => (x.comp - 3 * x.int) / x.att;
    expect(eff(h)).toBeGreaterThan(eff(e));
    expect(h.int / h.att).toBeLessThanOrEqual(e.int / e.att + 0.01);
  }, 120000);

  it('play calls follow down and distance', () => {
    const rng = new Rng(3);
    const runs = (toGo: number) => {
      let n = 0;
      for (let i = 0; i < 400; i++) if (chooseCpuPlay({ down: 3, toGo, yardline: 40 }, rng).category === 'run') n++;
      return n / 400;
    };
    expect(runs(1)).toBeGreaterThan(runs(12) + 0.2);
    expect(fourthDownCall({ down: 4, toGo: 7, yardline: 30 }, false)).toBe('punt');
    expect(fourthDownCall({ down: 4, toGo: 5, yardline: 75 }, false)).toBe('fieldGoal');
    expect(fourthDownCall({ down: 4, toGo: 1, yardline: 55 }, false)).toBe('go');
    expect(fourthDownCall({ down: 4, toGo: 9, yardline: 40 }, true)).toBe('go');
  });
});
