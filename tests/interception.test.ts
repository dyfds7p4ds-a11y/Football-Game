import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import { v2 } from '../src/core/vec';
import { resolveCatch, type CatchCandidate } from '../src/play/catch';
import { COVERAGE } from '../src/play/coverage';
import {
  DEF_CONTROL, combinedEffect, jumpHeight, jumpTiming, readGrade, timingEffect, type JumpGrade, type ReadGrade,
} from '../src/play/interception';

describe('interception timing window', () => {
  const arrive = 3.0;
  const pressFor = (offset: number) => arrive - DEF_CONTROL.jump.peakAt + offset;

  it('grades the jump by how close its peak is to the ball arriving', () => {
    expect(jumpTiming(pressFor(0), arrive).grade).toBe('perfect');
    expect(jumpTiming(pressFor(DEF_CONTROL.window.perfect * 0.9), arrive).grade).toBe('perfect');
    expect(jumpTiming(pressFor(-DEF_CONTROL.window.perfect * 1.2), arrive).grade).toBe('good');
    expect(jumpTiming(pressFor(DEF_CONTROL.window.good * 1.2), arrive).grade).toBe('mistimed');
    expect(jumpTiming(pressFor(-DEF_CONTROL.window.mistimed * 1.5), arrive).grade).toBe('none');
    expect(jumpTiming(null, arrive).grade).toBe('none');
    expect(jumpTiming(pressFor(-0.05), arrive).offset).toBeCloseTo(-0.05, 9);
  });

  it('windows are nested and the jump arcs up and back down', () => {
    const w = DEF_CONTROL.window;
    expect(w.perfect).toBeLessThan(w.good);
    expect(w.good).toBeLessThan(w.mistimed);
    expect(jumpHeight(DEF_CONTROL.jump.duration / 2)).toBeCloseTo(DEF_CONTROL.jump.height, 6);
    expect(jumpHeight(-0.1)).toBe(0);
    expect(jumpHeight(DEF_CONTROL.jump.duration + 0.1)).toBe(0);
  });

  const rates = (grade: JumpGrade, defDist = 0.7, n = 6000) => {
    const rng = new Rng(42);
    let ints = 0, breakups = 0, catches = 0;
    for (let i = 0; i < n; i++) {
      const off: CatchCandidate[] = [{ id: 1, pos: v2(0.5, 30), catching: 80, coverage: 30 }];
      const def: CatchCandidate[] = [{ id: 2, pos: v2(-defDist, 30), catching: 60, coverage: 80, timing: timingEffect(grade) }];
      const out = resolveCatch({ landing: v2(0, 30), quality: 0.9, speed: 20, offense: off, defense: def, ballSkills: 1, rng });
      if (out.kind === 'interception') ints++;
      else if (out.kind === 'deflection') breakups++;
      else if (out.kind === 'catch') catches++;
    }
    return { int: ints / n, breakup: breakups / n, catch: catches / n };
  };

  it('timing is rewarded, but a pick is never automatic', () => {
    const perfect = rates('perfect');
    const good = rates('good');
    const none = rates('none');
    const mistimed = rates('mistimed');
    expect(perfect.int).toBeGreaterThan(good.int);
    expect(good.int).toBeGreaterThanOrEqual(none.int - 0.01);
    expect(none.int).toBeGreaterThan(mistimed.int);
    expect(perfect.int).toBeLessThan(0.55);
    expect(perfect.int + perfect.breakup).toBeGreaterThan(none.int + none.breakup + 0.15);
    // A mistimed jump lets the receiver make the catch more often than staying grounded.
    expect(mistimed.catch).toBeGreaterThan(none.catch);
  });

  it('a perfectly timed jump extends reach, a late one does not', () => {
    // Defender 1.9 yd away: out of reach on the ground, in reach with a perfect jump.
    expect(rates('none', 1.9, 2000).int + rates('none', 1.9, 2000).breakup).toBe(0);
    expect(rates('perfect', 1.9, 2000).breakup).toBeGreaterThan(0);
    expect(rates('mistimed', 1.9, 2000).int).toBe(0);
  });
});

describe('reading the throw (Phase 3b)', () => {
  it('grades the read by who gets to the catch point first', () => {
    const r = DEF_CONTROL.read;
    expect(readGrade(r.undercut + 0.1)).toBe('undercut');
    expect(readGrade(r.even + 0.01)).toBe('even');
    expect(readGrade(r.trail + 0.01)).toBe('trail');
    expect(readGrade(r.trail - 0.5)).toBe('beaten');
  });

  const pickRate = (jump: JumpGrade, read: ReadGrade, n = 6000) => {
    const rng = new Rng(7);
    let ints = 0;
    for (let i = 0; i < n; i++) {
      const out = resolveCatch({
        landing: v2(0, 30), quality: 0.9, speed: 20, ballSkills: 1, intBase: COVERAGE.intBase, rng,
        offense: [{ id: 1, pos: v2(0.6, 30), catching: 80, coverage: 30 }],
        defense: [{ id: 2, pos: v2(-0.6, 30), catching: 65, coverage: 80, timing: combinedEffect(jump, read) }],
      });
      if (out.kind === 'interception') ints++;
    }
    return ints / n;
  };

  it('the pick is reachable through timing: read + perfect jump beats either alone, and stays an event', () => {
    const both = pickRate('perfect', 'undercut');
    const jumpOnly = pickRate('perfect', 'trail');
    const readOnly = pickRate('none', 'undercut');
    const nothing = pickRate('none', 'trail');
    expect(both).toBeGreaterThan(jumpOnly + 0.05);
    expect(both).toBeGreaterThan(readOnly + 0.04);
    expect(jumpOnly).toBeGreaterThan(nothing);
    expect(both).toBeGreaterThan(0.2); // reachable
    expect(both).toBeLessThan(0.5); // never routine, even on the spot
    expect(nothing).toBeLessThan(0.1);
    expect(pickRate('mistimed', 'undercut')).toBeLessThan(jumpOnly + 0.02);
  });
});
