import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import { DIFFICULTY, PLAYS, getPlay, getTeam } from '../src/data';
import type { Difficulty } from '../src/data/types';
import { createClock } from '../src/game/clock';
import { AUDIBLES, AudibleSession, audibleCost, audibleOptions, isBlitz } from '../src/play/audible';
import { getDefenseCall } from '../src/play/defenseCalls';
import { CpuQB } from '../src/play/qbAI';
import { PlaySim, SIM_DT } from '../src/play/sim';

describe('Phase 3c: audibles', () => {
  it('every play offers 2-3 alternatives, from the same formation (pistol: same personnel)', () => {
    for (const p of PLAYS) {
      const opts = audibleOptions(p);
      expect(opts.length).toBeGreaterThanOrEqual(2);
      expect(opts.length).toBeLessThanOrEqual(3);
      for (const o of opts) {
        expect(o.id).not.toBe(p.id);
        if (p.formation !== 'pistol') expect(o.formation).toBe(p.formation);
      }
    }
    // A pass can check to a run where the formation has one.
    expect(audibleOptions(getPlay('slants')).some((o) => o.run)).toBe(true);
    expect(audibleOptions(getPlay('hb_dive')).some((o) => !o.run)).toBe(true);
  });

  it('play-clock costs are deducted, repeated switching costs more, at most three audibles', () => {
    const s = new AudibleSession(getPlay('slants'), getDefenseCall('cover3'), DIFFICULTY.normal, new Rng(1));
    let clock = createClock(300);
    const start = clock.playClock;
    const plays = ['hb_draw', 'quick_outs', 'mesh', 'slants'].map(getPlay);
    const costs: number[] = [];
    for (const p of plays.slice(0, 3)) {
      const r = s.call(p, clock)!;
      costs.push(r.cost);
      clock = r.clock;
    }
    expect(costs).toEqual([audibleCost(1), audibleCost(2), audibleCost(3)]);
    expect(costs[1]).toBeGreaterThan(costs[0]);
    expect(costs[2]).toBeGreaterThan(costs[1]);
    expect(clock.playClock).toBeCloseTo(start - costs.reduce((a, b) => a + b, 0), 9);
    expect(s.canAudible).toBe(false);
    expect(s.call(plays[3], clock)).toBeNull();
    expect(AUDIBLES.maxPerPlay).toBe(3);
    // Never below zero.
    const s2 = new AudibleSession(getPlay('slants'), getDefenseCall('cover3'), DIFFICULTY.normal, new Rng(1));
    expect(s2.call(getPlay('hb_draw'), { ...clock, playClock: 1 })!.clock.playClock).toBe(0);
  });

  const reaction = (difficulty: Difficulty, seeds = 200) => {
    const diff = DIFFICULTY[difficulty];
    let changedInTime = 0;
    let counters = 0;
    let early = 0;
    for (let s = 0; s < seeds; s++) {
      const sess = new AudibleSession(getPlay('four_verts'), getDefenseCall('cover3'), diff, new Rng(s + 1));
      sess.call(getPlay('hb_draw'), createClock(300));
      let at = -1;
      for (let t = 0; t < 3; t += SIM_DT) {
        const nd = sess.update(SIM_DT);
        if (nd && at < 0) at = sess.t;
        if (sess.t < diff.audibleReact - 1e-6 && nd) early++;
      }
      if (at >= 0) {
        changedInTime++;
        expect(at).toBeGreaterThanOrEqual(diff.audibleReact - 1e-9);
        expect(at).toBeLessThanOrEqual(diff.audibleReact + SIM_DT + 1e-9);
        if (AUDIBLES.counters.run.includes(sess.defense.id)) counters++;
      }
    }
    return { changed: changedInTime / seeds, counters: counters / seeds, early };
  };

  it('the defense reads an audible: it changes its call exactly at its reaction time, never before', () => {
    const n = reaction('normal');
    expect(n.early).toBe(0);
    expect(n.changed).toBeGreaterThan(0.4);
    expect(n.counters).toBeCloseTo(n.changed, 9); // the new call is always a counter to the run
  });

  it('Hard reacts faster and better than Easy', () => {
    expect(DIFFICULTY.hard.audibleReact).toBeLessThan(DIFFICULTY.normal.audibleReact);
    expect(DIFFICULTY.normal.audibleReact).toBeLessThan(DIFFICULTY.easy.audibleReact);
    expect(reaction('hard').counters).toBeGreaterThan(reaction('easy').counters + 0.2);
  });

  it('a snap before the re-read catches the defense: a run audible against a blitz look earns the edge', () => {
    const sess = new AudibleSession(getPlay('slants'), getDefenseCall('cover1blitz'), DIFFICULTY.normal, new Rng(3));
    expect(isBlitz(getDefenseCall('cover1blitz'))).toBe(true);
    expect(isBlitz(getDefenseCall('cover3'))).toBe(false);
    sess.call(getPlay('hb_draw'), createClock(300));
    sess.update(DIFFICULTY.normal.audibleReact * 0.5);
    expect(sess.edge).toBe(true);
    sess.update(DIFFICULTY.normal.audibleReact);
    expect(sess.edge).toBe(false); // too late: the defense has answered
  });

  it('the edge is worth yards: a run audible into an unadjusted blitz gains more than the same run into a blitz that saw it coming', () => {
    const ypp = (edge: boolean) => {
      let y = 0, n = 0;
      for (const playId of ['hb_dive', 'hb_draw', 'counter', 'hb_toss']) for (const def of ['cover1blitz', 'cover0', 'firezone']) for (let s = 0; s < 12; s++) {
        const play = getPlay(playId);
        const sim = new PlaySim({ play, defense: getDefenseCall(def), offenseTeam: getTeam('rheinstadt'), defenseTeam: getTeam('elbtal'),
          ballX: 0, los: 30, difficulty: { ...DIFFICULTY.normal, penaltyRate: 0 }, seed: 300 + s });
        sim.audibleEdge = edge;
        const qb = new CpuQB(play, DIFFICULTY.normal, new Rng(5 + s));
        for (let i = 0; i < 60 * 15 && !sim.result; i++) sim.step(qb.input(sim));
        y += sim.result!.yards;
        n++;
      }
      return y / n;
    };
    expect(ypp(true)).toBeGreaterThan(ypp(false) + 1.5);
  }, 60000);
});
