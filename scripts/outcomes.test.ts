import { it } from 'vitest';
import { runPlay } from '../tests/simHarness';
import { DEFENSE_CALLS } from '../src/play/defenseCalls';
it('outcomes', () => {
  const cases: [string, number, string][] = (process.env.C ?? 'four_verts,2.2,WR1;four_verts,2.2,WR3;four_verts,2.2,WR2;four_verts,2.2,TE;pa_shot,2.6,WR2;deep_post,2.6,WR1;slants,1.0,WR1;quick_outs,1.0,WR2;curl_flat,1.6,WR2;levels,2.0,WR1;smash,2.2,WR3;y_cross,2.4,TE;mesh,1.5,WR3;bubble,0.5,WR3;rb_screen,1.6,RB').split(';').map((c) => { const [a, b, d] = c.split(','); return [a, +b, d]; });
  for (const [play, at, target] of cases) {
    const tally: Record<string, number> = {}; let yards = 0; let n = 0;
    for (const d of DEFENSE_CALLS) for (let s = 0; s < 12; s++) {
      const r = runPlay(play, d.id, s * 7 + 1, { throwAt: at, target: target as any, dropFor: 0.6 });
      const o = r.result!.completion ? 'comp' : r.result!.outcome; tally[o] = (tally[o] ?? 0) + 1; yards += r.result!.yards; n++;
    }
    console.log(`${play}/${target}`.padEnd(18), (yards / n).toFixed(1).padStart(5), JSON.stringify(tally));
  }
});
