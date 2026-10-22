// Prints the open-receiver rates the balance tests assert on: BALANCE=openrates npx vitest run --silent=false
import { it } from 'vitest';
import balance from '../src/data/balance.json';
import { COVERAGE } from '../src/play/coverage';
import type { EligibleSlot } from '../src/data/types';
import { openRates } from '../tests/simHarness';

it('openrates', () => {
  for (const diff of ['easy', 'normal', 'hard'] as const) {
    for (const [play, slots] of Object.entries(balance.verticalConcepts)) {
      const r = openRates(play, slots as EligibleSlot[], {
        sampleTime: balance.sampleTime, dropFor: balance.dropFor, seeds: balance.seedsPerDefense, openMargin: balance.openMargin,
        inPhaseDist: COVERAGE.inPhaseDist, difficulty: diff,
      });
      console.log(diff.padEnd(7), play.padEnd(11), Object.entries(r.rates).map(([s, v]) => `${s}:${Math.round(v * 100)}%`).join(' '), `any:${Math.round(r.any * 100)}%`, `n=${r.samples}`);
    }
  }
});
