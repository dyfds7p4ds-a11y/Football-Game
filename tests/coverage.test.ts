import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import { v2 } from '../src/core/vec';
import type { EligibleSlot } from '../src/data/types';
import balance from '../src/data/balance.json';
import { COVERAGE, CoverageReader, ZoneMatcher, isVertical, readDelay, type ReadTarget, type ZoneArea } from '../src/play/coverage';
import { getPlay } from '../src/data';
import { inPhase, throwingWindow } from '../src/play/windows';
import { openRates, runPlay, zoneOpenRate } from './simHarness';

const B = balance as {
  verticalConcepts: Record<string, EligibleSlot[]>;
  difficulty: 'easy' | 'normal' | 'hard';
  sampleTime: number;
  dropFor: number;
  seedsPerDefense: number;
  openMargin: number;
  maxOpenRate: number;
  maxOpenRateRoute1: number;
};

describe('vertical-concept balance (Normal)', () => {
  for (const [play, slots] of Object.entries(B.verticalConcepts)) {
    it(`${play}: no receiver is open more often than ${B.maxOpenRate * 100}% (1-route: ${B.maxOpenRateRoute1 * 100}%)`, () => {
      const r = openRates(play, slots, {
        sampleTime: B.sampleTime, dropFor: B.dropFor, seeds: B.seedsPerDefense, openMargin: B.openMargin,
        inPhaseDist: COVERAGE.inPhaseDist, difficulty: B.difficulty,
      });
      expect(r.samples).toBeGreaterThan(0);
      for (const s of slots) expect(r.rates[s], `${play} ${s}`).toBeLessThanOrEqual(B.maxOpenRate);
      if (slots.includes('WR1')) expect(r.rates.WR1, `${play} WR1`).toBeLessThanOrEqual(B.maxOpenRateRoute1);
    }, 60_000);
  }

  it('the read matters: Easy coverage leaves the 1-route open more often than Hard', () => {
    const opts = { sampleTime: B.sampleTime, dropFor: B.dropFor, seeds: 6, openMargin: B.openMargin, inPhaseDist: COVERAGE.inPhaseDist };
    const easy = openRates('four_verts', ['WR1', 'WR2', 'WR3', 'TE'], { ...opts, difficulty: 'easy' });
    const hard = openRates('four_verts', ['WR1', 'WR2', 'WR3', 'TE'], { ...opts, difficulty: 'hard' });
    expect(easy.any).toBeGreaterThan(hard.any);
  }, 60_000);
});

describe('coverage reader', () => {
  const rec = (id: number, x: number, y: number, vy: number, blocks = false): ReadTarget =>
    ({ id, pos: v2(x, y), vel: v2(0, vy), maxSpeed: 9.5, blocks });

  it('identifies vertical stems only past the stem depth and at speed', () => {
    expect(isVertical(rec(1, -20, 40, 9), 30)).toBe(true);
    expect(isVertical(rec(1, -20, 32, 9), 30)).toBe(false); // still at the line
    expect(isVertical(rec(1, -20, 40, 3), 30)).toBe(false); // settling (curl/hitch)
    expect(isVertical(rec(1, -20, 40, 9, true), 30)).toBe(false); // blocker
  });

  it('reads later with poor read quality', () => {
    expect(readDelay(0.35)).toBeGreaterThan(readDelay(0.95));
  });

  it('gives over-the-top help to the most dangerous vertical and rolls the shell toward it', () => {
    const cr = new CoverageReader(1, new Rng(1));
    const recs = [rec(1, -20, 45, 9), rec(2, -13, 44, 9), rec(3, 20, 38, 2)];
    const danger = (id: number) => (id === 1 ? 1 : 0);
    cr.update(2, 30, 0, recs, [{ id: 10, homeX: 0 }], danger);
    expect(cr.verticals.has(1) && cr.verticals.has(2) && !cr.verticals.has(3)).toBe(true);
    expect(cr.help.get(10)).toBe(1);
    for (let i = 0; i < 60; i++) cr.update(2 + i / 60, 30, 0, recs, [{ id: 10, homeX: 0 }], danger);
    expect(cr.roll).toBeLessThan(0); // both verticals on the left
  });

  it('does not flip help between two routes that are about equally open', () => {
    const cr = new CoverageReader(1, new Rng(1));
    const recs = [rec(1, -20, 45, 9), rec(2, 20, 45, 9)];
    cr.update(2, 30, 0, recs, [{ id: 10, homeX: 0 }], (id) => (id === 1 ? 0.5 : 0.4));
    expect(cr.help.get(10)).toBe(1);
    cr.update(3, 30, 0, recs, [{ id: 10, homeX: 0 }], (id) => (id === 1 ? 0.4 : 0.5));
    expect(cr.help.get(10)).toBe(1);
  });
});

describe('throwing windows', () => {
  const qb = v2(0, 25);
  it('an uncovered receiver is open; a defender sitting on the catch point closes it', () => {
    const r = { pos: v2(-10, 45), vel: v2(0, 9), maxSpeed: 9.5, reaction: 0 };
    const far = { pos: v2(20, 30), vel: v2(), maxSpeed: 9, reaction: 0.3 };
    expect(throwingWindow(qb, r, [far]).margin).toBeGreaterThan(0);
    const w = throwingWindow(qb, r, [far]);
    const sitting = { pos: { ...w.aim }, vel: v2(), maxSpeed: 9, reaction: 0.3 };
    expect(throwingWindow(qb, r, [sitting]).margin).toBeLessThan(0);
  });

  it('in phase means close, same direction and similar speed', () => {
    const r = { pos: v2(0, 40), vel: v2(0, 9) };
    expect(inPhase(r, { pos: v2(0.6, 39.5), vel: v2(0, 8.8) }, 1.8)).toBe(true);
    expect(inPhase(r, { pos: v2(0.6, 39.5), vel: v2(8, 0) }, 1.8)).toBe(false);
    expect(inPhase(r, { pos: v2(4, 39.5), vel: v2(0, 9) }, 1.8)).toBe(false);
  });
});

describe('Phase 3c: Cover 3 pattern-match zones', () => {
  const Z = balance.zoneCoverage;
  const rt = (id: number, x: number, y: number): ReadTarget => ({ id, pos: v2(x, y), vel: v2(0, 0), maxSpeed: 8, blocks: false });
  const hookL: ZoneArea = { id: 1, land: v2(-5, 38), w: 6, minY: 29, maxY: 45 };
  const hookR: ZoneArea = { id: 2, land: v2(5, 38), w: 6, minY: 29, maxY: 45 };

  it('a receiver entering a zone is picked up, released when he leaves, and handed to the next zone', () => {
    const m = new ZoneMatcher();
    expect(m.update([hookL, hookR], [rt(10, -6, 36)])).toEqual([]);
    expect(m.matches.get(1)).toBe(10);
    // Crossing: still inside hookL (+ release margin) -> hookL keeps him, hookR does not double him.
    m.update([hookL, hookR], [rt(10, 0.5, 36)]);
    expect(m.matches.get(1)).toBe(10);
    expect(m.matches.has(2)).toBe(false);
    // Past hookL's edge + margin: released, and hookR takes him (handoff).
    const h = m.update([hookL, hookR], [rt(10, 3, 36)]);
    expect(m.matches.get(1)).toBeUndefined();
    expect(m.matches.get(2)).toBe(10);
    expect(h).toEqual([{ from: 1, to: 2, receiver: 10 }]);
  });

  it('nobody chases a receiver out of his area; blockers are ignored', () => {
    const m = new ZoneMatcher();
    m.update([hookL], [rt(10, -6, 36), { ...rt(11, -4, 31), blocks: true }]);
    expect(m.matches.get(1)).toBe(10);
    m.update([hookL], [rt(10, 9, 36)]);
    expect(m.matches.size).toBe(0);
  });

  it(`balance: the Cover 3 ${Z.slot} leaves receivers in his zone open less than ${Z.maxOpenRate * 100}% (Normal) and stays in his zone`, () => {
    const r = zoneOpenRate(Z.defense, Z.slot, {
      sampleTimes: Z.sampleTimes, seeds: Z.seeds, dropFor: B.dropFor, openMargin: B.openMargin, inPhaseDist: COVERAGE.inPhaseDist,
      depth: Z.depth as [number, number], difficulty: Z.difficulty as 'normal',
    });
    if (process.env.BALANCE_STATS) console.log('zone', JSON.stringify(r));
    expect(r.samples).toBeGreaterThan(30);
    expect(r.rate).toBeLessThan(Z.maxOpenRate);
    expect(r.stray).toBeLessThan(Z.maxStray);
  }, 60000);

  it('crossers are handed off between zone defenders', () => {
    let handoffs = 0;
    for (let s = 0; s < 4; s++) handoffs += runPlay('mesh', 'cover3', s * 7 + 1, { throwAt: null, target: null, dropFor: 0.8 }).sim.handoffs.length;
    expect(handoffs).toBeGreaterThan(3);
  });

  it('a throw into a zone gap is contested, not automatically complete', () => {
    let n = 0, comp = 0, contested = 0;
    for (const play of ['levels', 'curl_flat', 'smash', 'y_cross', 'mesh']) {
      for (let s = 0; s < 10; s++) {
        const r = runPlay(play, 'cover3', s * 11 + 5, { throwAt: 1.7, target: getPlay(play).primary!, dropFor: 0.8 });
        if (!r.events.some((e) => e.type === 'throw')) continue;
        n++;
        if (r.events.some((e) => e.type === 'catch')) comp++;
        if (r.events.some((e) => e.type === 'deflection' || e.type === 'interception')) contested++;
      }
    }
    expect(n).toBeGreaterThan(30);
    expect(comp / n).toBeLessThan(0.8);
    expect(contested / n).toBeGreaterThan(0.12);
  }, 60000);
});
