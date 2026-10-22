import { describe, expect, it } from 'vitest';
import { getPlay } from '../src/data';
import { SCREEN, screenTiming } from '../src/play/screen';
import { runPlay } from './simHarness';

describe('screen timing window', () => {
  const rb = getPlay('rb_screen').screen!;
  it('classifies early, on-time and late throws', () => {
    expect(screenTiming(rb.window[0] - 0.3, rb).phase).toBe('early');
    expect(screenTiming((rb.window[0] + rb.window[1]) / 2, rb).phase).toBe('ok');
    expect(screenTiming(rb.window[1] + 0.3, rb).phase).toBe('late');
  });
  it('early throws are hard to catch, late throws invite interceptions', () => {
    expect(screenTiming(0, rb).catchFactor).toBe(SCREEN.earlyCatchFactor);
    const late = screenTiming(rb.window[1] + 1, rb);
    expect(late.catchFactor).toBeLessThan(1);
    expect(late.intBonus).toBeCloseTo(SCREEN.lateIntBonus);
    expect(screenTiming(rb.window[1] + 0.05, rb).intBonus).toBeLessThan(late.intBonus);
  });
});

describe('screen plays', () => {
  const tally = (throwAt: number) => {
    let comp = 0;
    let int = 0;
    // 80 snaps: picks are rare events, 40 left the late-vs-on-time comparison at the noise level.
    for (let s = 0; s < 80; s++) {
      const r = runPlay('rb_screen', ['cover3', 'cover2', 'cover1', 'firezone'][s % 4], s, { throwAt, target: 'RB', dropFor: 0.6 });
      if (r.result!.completion) comp++;
      if (r.result!.outcome === 'interception') int++;
    }
    return { comp, int };
  };

  // The harness starts charging at throwAt and releases ~0.3 s later.
  it('an on-time screen completes more often than one thrown too early', () => {
    expect(tally(1.3).comp).toBeGreaterThan(tally(0.6).comp);
  });

  it('a screen thrown too late gets picked more often than one on time', () => {
    expect(tally(1.75).int).toBeGreaterThan(tally(1.3).int);
  });

  it('the screen linemen release to the outside after the delay', () => {
    const scr = getPlay('rb_screen').screen!;
    let before = 0;
    let after = 0;
    runPlay('rb_screen', 'cover3', 2, {
      throwAt: null, target: null,
      onStep: (sim) => {
        const lt = sim.get('LT');
        if (Math.abs(sim.t - (scr.release - 0.05)) < 0.009) before = lt.pos.x;
        if (Math.abs(sim.t - (scr.release + 0.9)) < 0.009) after = lt.pos.x;
      },
    });
    // The RB screen goes left (-x): the tackle leads it out there.
    expect(after).toBeLessThan(before - 1);
  });

  it('the defense reads the screen and rallies to the back', () => {
    let atRead = 0;
    let later = 0;
    runPlay('rb_screen', 'cover3', 4, {
      throwAt: null, target: null,
      script: (sim, inp) => {
        inp.move = { x: 0, y: sim.t < 2.4 ? -0.6 : 0 }; // drift back away from the released rushers
      },
      onStep: (sim) => {
        const rbPos = sim.get('RB').pos;
        // Second level: linebackers and the nickel back come downhill once they read it.
        const d = Math.min(...(['LB1', 'LB2', 'NB'] as const).map((s) => {
          const a = sim.getDef(s);
          return Math.hypot(a.pos.x - rbPos.x, a.pos.y - rbPos.y);
        }));
        if (Math.abs(sim.t - 2.0) < 0.009) atRead = d;
        if (Math.abs(sim.t - 3.4) < 0.009) later = d;
      },
    });
    expect(later).toBeLessThan(atRead - 4);
  });
});
