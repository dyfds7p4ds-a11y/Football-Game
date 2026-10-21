import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import { v2 } from '../src/core/vec';
import { resolveCatch, catchProbability } from '../src/play/catch';
import { buildRoute } from '../src/play/routes';
import { DEFENSE_CALLS, chooseDefense, emptyTendencies, recordTendency } from '../src/play/defenseCalls';
import { DIFFICULTY, PLAYS } from '../src/data';
import { runPlay } from './simHarness';

describe('play simulation', () => {
  it('is deterministic for the same seed and inputs', () => {
    const a = runPlay('slants', 'cover3', 77, { throwAt: 1.0, target: 'WR1', dropFor: 0.6 });
    const b = runPlay('slants', 'cover3', 77, { throwAt: 1.0, target: 'WR1', dropFor: 0.6 });
    expect(a.result).toEqual(b.result);
    expect(a.events).toEqual(b.events);
  });

  it('every play in the playbook resolves against every defense', () => {
    for (const p of PLAYS) {
      for (const d of DEFENSE_CALLS) {
        const target = p.run ? null : (p.primary ?? 'WR1');
        const r = runPlay(p.id, d.id, 5, { throwAt: p.run ? null : 1.2, target, dropFor: p.run ? 0 : 0.5 });
        expect(r.result, `${p.id} vs ${d.id}`).not.toBeNull();
        expect(Number.isFinite(r.result!.endY)).toBe(true);
      }
    }
  });

  it('run plays hand the ball to the running back', () => {
    const r = runPlay('hb_dive', 'cover3', 3, { throwAt: null, target: null });
    expect(r.events.some((e) => e.type === 'handoff')).toBe(true);
    expect(r.result!.rush).toBe(true);
    expect(r.result!.carrier).toBe('RB');
  });

  it('toss plays pitch the ball', () => {
    const r = runPlay('hb_toss', 'cover2', 3, { throwAt: null, target: null });
    expect(r.events.some((e) => e.type === 'pitch')).toBe(true);
    expect(r.result!.carrier).toBe('RB');
  });

  it('holding the ball forever eventually gets the QB sacked (pressure builds)', () => {
    let sacks = 0;
    for (let s = 0; s < 10; s++) {
      const r = runPlay('four_verts', 'cover3', s, { throwAt: null, target: null, dropFor: 0.8 });
      if (r.result!.outcome === 'sack') sacks++;
    }
    expect(sacks).toBeGreaterThanOrEqual(8);
  });

  it('a well-timed quick throw completes most of the time', () => {
    let comp = 0;
    for (let s = 0; s < 30; s++) {
      const r = runPlay('quick_outs', 'cover3', s, { throwAt: 1.0, target: 'WR2', dropFor: 0.6 });
      if (r.result!.completion) comp++;
    }
    expect(comp).toBeGreaterThan(15);
  });

  it('a badly mistimed throw completes less often than a good one', () => {
    let good = 0;
    let bad = 0;
    for (let s = 0; s < 40; s++) {
      if (runPlay('curl_flat', 'cover3', s, { throwAt: 1.6, target: 'WR2', dropFor: 0.6 }).result!.completion) good++;
      if (runPlay('curl_flat', 'cover3', s, { throwAt: 1.6, target: 'WR2', dropFor: 0.6, chargeError: -0.35 }).result!.completion) bad++;
    }
    expect(good).toBeGreaterThan(bad);
  });

  it('harder difficulty sacks more often', () => {
    let easy = 0;
    let hard = 0;
    for (let s = 0; s < 20; s++) {
      const opts = { throwAt: null, target: null, dropFor: 0.8 } as const;
      easy += runPlay('four_verts', 'cover2', s, opts, 'easy').result!.duration;
      hard += runPlay('four_verts', 'cover2', s, opts, 'hard').result!.duration;
    }
    expect(hard).toBeLessThan(easy); // QB survives longer on Easy
  });
});

describe('routes', () => {
  it('breaks slants inside and outs toward the sideline', () => {
    const left = buildRoute({ route: 'slant' }, v2(-20, 29), 0);
    expect(left.points[1].x).toBeGreaterThan(-20);
    const out = buildRoute({ route: 'out', depth: 5 }, v2(20, 29), 0);
    expect(out.points[1].x).toBeGreaterThan(20);
    expect(out.points[1].x).toBeLessThan(26.7);
  });
});

describe('catch resolution', () => {
  const rec = { id: 1, pos: v2(0, 10), catching: 85, coverage: 30 };
  const cb = { id: 2, pos: v2(0.3, 10.3), catching: 60, coverage: 85 };

  it('uncontested on-target balls are usually caught', () => {
    let c = 0;
    for (let i = 0; i < 100; i++) {
      const o = resolveCatch({ landing: v2(0, 10), quality: 1, speed: 20, offense: [rec], defense: [], ballSkills: 1, rng: new Rng(i) });
      if (o.kind === 'catch') c++;
    }
    expect(c).toBeGreaterThan(80);
  });

  it('balls far from everyone fall incomplete', () => {
    const o = resolveCatch({ landing: v2(10, 30), quality: 1, speed: 20, offense: [rec], defense: [cb], ballSkills: 1, rng: new Rng(1) });
    expect(o.kind).toBe('incomplete');
  });

  it('tight coverage produces breakups and interceptions', () => {
    const kinds = new Set<string>();
    for (let i = 0; i < 200; i++) {
      kinds.add(resolveCatch({ landing: v2(0.3, 10.3), quality: 0.8, speed: 20, offense: [rec], defense: [cb], ballSkills: 1, rng: new Rng(i) }).kind);
    }
    expect(kinds.has('interception')).toBe(true);
    expect(kinds.has('deflection')).toBe(true);
    expect(kinds.has('catch')).toBe(true);
  });

  it('catch probability falls with distance', () => {
    expect(catchProbability(80, 0, 1, 20)).toBeGreaterThan(catchProbability(80, 1.5, 1, 20));
  });
});

describe('cpu defense play-calling', () => {
  it('leans on man/blitz looks against a run-heavy offense when smart', () => {
    let t = emptyTendencies();
    for (let i = 0; i < 10; i++) t = recordTendency(t, 'run');
    const count = (tend: typeof t) => {
      let n = 0;
      const rng = new Rng(9);
      for (let i = 0; i < 300; i++) {
        const c = chooseDefense({ down: 1, toGo: 10, yardline: 40, halfSecondsLeft: 600, scoreDiff: 0 }, tend, DIFFICULTY.hard, rng);
        if (c.shell === 'cover1' || c.shell === 'cover0') n++;
      }
      return n;
    };
    expect(count(t)).toBeGreaterThan(count(emptyTendencies()));
  });
});
