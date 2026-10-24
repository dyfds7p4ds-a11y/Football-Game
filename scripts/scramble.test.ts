// BALANCE=scramble npx vitest run scripts/scramble.test.ts --silent=false
import { describe, it } from 'vitest';
import { DEFENSE_CALLS } from '../src/play/defenseCalls';
import { runPlay } from '../tests/simHarness';
import { scrambleSample, scrambleScripts } from '../tests/scrambleBalance.test';

describe.runIf(process.env.BALANCE === 'scramble')('scramble probe', () => {
  it('prints yards per scramble per strategy and coverage', () => {
    for (const [name, make] of Object.entries(scrambleScripts)) {
      const all: number[] = [];
      const rows: string[] = [];
      for (const d of DEFENSE_CALLS) {
        const ys: number[] = [];
        for (let s = 0; s < 40; s++) {
          const r = runPlay('four_verts', d.id, s * 7 + 3, { throwAt: null, target: null, dropFor: 0.5, script: make(s) });
          if (r.sim.scrambling && r.result && !r.result.passAttempt) ys.push(r.result.yards);
        }
        all.push(...ys);
        rows.push(`${d.id}: ${(ys.reduce((a, b) => a + b, 0) / Math.max(1, ys.length)).toFixed(1)} (n=${ys.length})`);
      }
      const avg = all.reduce((a, b) => a + b, 0) / all.length;
      const tfl = all.filter((y) => y < 0).length / all.length;
      const big = all.filter((y) => y >= 15).length / all.length;
      console.log(`${name}: avg ${avg.toFixed(2)} tfl ${(tfl * 100).toFixed(0)}% 15+ ${(big * 100).toFixed(0)}% n=${all.length} | ${rows.join(' · ')}`);
    }
    for (const group of ['lane', 'flat', 'all'] as const) {
      const ys = scrambleSample(40, group);
      const avg = ys.reduce((a, b) => a + b, 0) / ys.length;
      console.log(`${group} mix: avg ${avg.toFixed(2)} tfl ${((ys.filter((y) => y < 0).length / ys.length) * 100).toFixed(0)}% 15+ ${((ys.filter((y) => y >= 15).length / ys.length) * 100).toFixed(0)}% n=${ys.length}`);
    }
  });
});
