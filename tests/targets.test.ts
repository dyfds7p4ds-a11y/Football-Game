import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import { DIFFICULTY, PLAYS, getTeam } from '../src/data';
import balance from '../src/data/balance.json';
import type { Difficulty } from '../src/data/types';
import { DEFENSE_CALLS } from '../src/play/defenseCalls';
import { CpuQB } from '../src/play/qbAI';
import { PlaySim } from '../src/play/sim';

const B = balance.targets;

/** CPU QB vs. eleven CPU defenders: who is covering the receiver each pass goes to, and the picks. */
function measure() {
  const diff = DIFFICULTY[B.difficulty as Difficulty];
  let att = 0, cb = 0, outside = 0, ints = 0;
  // A distinct seed per (play, call, sample): one seed for every play would replay the same catch rolls.
  PLAYS.forEach((play, pi) => {
    if (play.run) return;
    DEFENSE_CALLS.forEach((def, di) => { for (let s = 0; s < B.seeds; s++) {
      const seed = 3000 + pi * 997 + di * 131 + s * 17;
      const sim = new PlaySim({
        play, defense: def, offenseTeam: getTeam('elbtal'), defenseTeam: getTeam('rheinstadt'), ballX: 0, los: 30,
        difficulty: { ...diff, penaltyRate: 0 }, seed,
      });
      const qb = new CpuQB(play, diff, new Rng(seed * 7 + 1));
      for (let i = 0; i < 60 * 15 && !sim.result; i++) {
        sim.step(qb.input(sim));
        for (const e of sim.drainEvents()) {
          if (e.type === 'interception') ints++;
          if (e.type !== 'throw' || e.actor === undefined) continue;
          att++;
          const r = sim.actors[e.actor];
          const d = sim.actors.filter((a) => a.side === 'def')
            .reduce((m, a) => (Math.hypot(a.pos.x - r.pos.x, a.pos.y - r.pos.y) < Math.hypot(m.pos.x - r.pos.x, m.pos.y - r.pos.y) ? a : m));
          if (d.slot === 'CB1' || d.slot === 'CB2' || d.slot === 'NB') cb++;
          if (d.slot === 'CB1' || d.slot === 'CB2') outside++;
        }
      }
    } });
  });
  return { att, cbShare: cb / att, outsideShare: outside / att, intPerGame: (ints / att) * B.attemptsPerGame };
}

describe('targets and interceptions (balance, Normal)', () => {
  it('cornerbacks see realistic target volume and picks stay in range', () => {
    const m = measure();
    if (process.env.BALANCE_STATS) console.log('targets', m);
    expect(m.att).toBeGreaterThan(150);
    expect(m.cbShare).toBeGreaterThanOrEqual(B.cbTargetShare[0]);
    expect(m.cbShare).toBeLessThanOrEqual(B.cbTargetShare[1]);
    expect(m.outsideShare).toBeGreaterThanOrEqual(B.outsideCbTargetShare[0]);
    expect(m.outsideShare).toBeLessThanOrEqual(B.outsideCbTargetShare[1]);
    expect(m.intPerGame).toBeGreaterThanOrEqual(B.intPerGame[0]);
    expect(m.intPerGame).toBeLessThanOrEqual(B.intPerGame[1]);
  }, 120000);
});
