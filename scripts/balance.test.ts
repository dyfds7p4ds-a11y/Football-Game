// Balance probe (not part of the CI suite): BALANCE=balance npx vitest run
import { it } from 'vitest';
import { runPlay } from '../tests/simHarness';
import { DEFENSE_CALLS } from '../src/play/defenseCalls';

const cases: [string, any, any][] = [
  ['slants', 1.0, 'WR1'], ['quick_outs', 1.0, 'WR2'], ['curl_flat', 1.6, 'WR2'], ['levels', 2.0, 'WR1'],
  ['four_verts', 2.4, 'WR3'], ['mesh', 1.5, 'WR3'], ['bubble', 0.5, 'WR3'], ['y_cross', 2.4, 'TE'], ['smash', 2.2, 'WR3'],
  ['hb_dive', null, null], ['hb_stretch', null, null], ['hb_toss', null, null], ['counter', null, null], ['hb_draw', null, null],
];
it('balance', () => {
  for (const [play, at, target] of cases) {
    const tally: Record<string, number> = {};
    let yards = 0;
    let n = 0;
    for (const d of DEFENSE_CALLS) for (let s = 0; s < 12; s++) {
      const r = runPlay(play, d.id, s * 7 + 1, { throwAt: at, target, dropFor: at ? 0.6 : 0 });
      const o = r.result?.outcome ?? 'none';
      tally[o] = (tally[o] ?? 0) + 1;
      yards += r.result?.yards ?? 0;
      n++;
    }
    console.log(play.padEnd(12), (yards / n).toFixed(1).padStart(5), JSON.stringify(tally));
  }
});
