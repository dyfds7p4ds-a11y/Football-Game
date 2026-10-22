import { describe, expect, it } from 'vitest';
import { BLITZ, arrivalTime, blitzDesign, blitzPath, classifyBlitz, recognizeChance } from '../src/play/blitz';
import { assignProtection, type Unit } from '../src/play/blocking';
import { runPlay } from './simHarness';

describe('blitz paths and timing', () => {
  const qb = { x: 0, y: 23 };
  it('an edge blitz takes longer to get home than an A-gap blitz from the same spot', () => {
    const start = { x: -6, y: 34 };
    const edge = blitzPath('edge', start, 0, 30, qb);
    const gap = blitzPath('aGap', start, 0, 30, qb);
    expect(Math.abs(edge[0].x)).toBeGreaterThan(Math.abs(gap[0].x));
    expect(arrivalTime(start, edge, 8, 0)).toBeGreaterThan(arrivalTime(start, gap, 8, 0));
    // A delayed blitz arrives later by its delay.
    expect(arrivalTime(start, gap, 8, 0.5)).toBeCloseTo(arrivalTime(start, gap, 8, 0) + 0.5, 5);
  });

  it('blitz designs come from the call, or from the alignment', () => {
    expect(blitzDesign('firezone', 'NB', -8, 0).path).toBe('edge');
    expect(blitzDesign('cover0', 'FS', 0, 0).path).toBe('delayed');
    expect(blitzDesign('custom', 'LB1', 1, 0).path).toBe('aGap');
    expect(blitzDesign('custom', 'SS', 9, 0).path).toBe('edge');
  });

  it('delayed blitzes are the hardest to see; an aware line sees more', () => {
    expect(recognizeChance('delayed', 75)).toBeLessThan(recognizeChance('edge', 75));
    expect(recognizeChance('edge', 90)).toBeGreaterThan(recognizeChance('edge', 60));
  });
});

describe('blitz outcomes', () => {
  const base = { sacked: false, closest: 6, atRelease: Infinity, engaged: false };
  it('classifies sack, hurry, blocked and late', () => {
    expect(classifyBlitz({ ...base, sacked: true })).toBe('sack');
    expect(classifyBlitz({ ...base, atRelease: BLITZ.hurryRadius - 0.2 })).toBe('hurry');
    expect(classifyBlitz({ ...base, engaged: true })).toBe('blocked');
    expect(classifyBlitz(base)).toBe('late');
  });

  it('protection slides to a recognized wide blitzer, and leaves an unseen one free', () => {
    const line: Unit[] = [0, 1, 2, 3, 4].map((i) => ({ id: i, x: (i - 2) * 1.3, y: 29, kind: 'ol' }));
    const rushers: Unit[] = [
      { id: 10, x: -3.8, y: 31, kind: 'def' }, { id: 11, x: -1, y: 31, kind: 'def' }, { id: 12, x: 1, y: 31, kind: 'def' },
      { id: 13, x: 3.8, y: 31, kind: 'def' }, { id: 14, x: -8.5, y: 35, kind: 'def' },
    ];
    const seen = assignProtection(line, rushers, { x: 0, y: 24 }, 0);
    expect(seen.find((a) => a.target === 14)?.blocker).toBe(0); // the left tackle slides out to the nickel
    expect(new Set(seen.map((a) => a.target)).size).toBe(5);
    const unseen = assignProtection(line, rushers, { x: 0, y: 24 }, 0, (r) => r.id !== 14);
    expect(unseen.some((a) => a.target === 14 && a.role === 'passSet')).toBe(false);
  });
});

describe('nickel blitz in the sim', () => {
  const tally = (throwAt: number, play = 'four_verts', seeds = 40) => {
    const out: Record<string, number> = { sack: 0, hurry: 0, blocked: 0, late: 0 };
    for (let s = 0; s < seeds; s++) {
      const r = runPlay(play, 'firezone', s, { throwAt, target: 'WR1', dropFor: 0.6 });
      for (const b of r.sim.blitzReport()) if (b.slot === 'NB') out[b.outcome]++;
    }
    return out;
  };

  it('does not succeed automatically: held ball, still mostly blocked', () => {
    const o = tally(3.2);
    expect(o.blocked).toBeGreaterThan(o.sack);
    expect(o.sack).toBeGreaterThan(0);
  });

  it('a quick throw beats the blitz', () => {
    const o = tally(0.9);
    expect(o.sack).toBe(0);
  });

  it('outcomes vary with the timing of the throw: sacks, hurries, blocked blitzers', () => {
    const all: Record<string, number> = { sack: 0, hurry: 0, blocked: 0, late: 0 };
    for (const t of [1.2, 1.4, 1.6, 2.0]) for (const play of ['four_verts', 'curl_flat']) {
      const o = tally(t, play, 16);
      for (const k of Object.keys(all)) all[k] += o[k];
    }
    let cover0Hurries = 0;
    for (let s = 0; s < 16; s++) {
      const r = runPlay('four_verts', 'cover0', s, { throwAt: 1.6, target: 'WR1', dropFor: 0.6 });
      cover0Hurries += r.sim.blitzReport().filter((b) => b.outcome === 'hurry').length;
    }
    expect(all.sack).toBeGreaterThan(0);
    expect(all.blocked).toBeGreaterThan(0);
    expect(all.late + cover0Hurries).toBeGreaterThan(0);
    expect(cover0Hurries).toBeGreaterThan(0);
  });
});
