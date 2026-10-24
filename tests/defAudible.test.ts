import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import { DIFFICULTY, getPlay, getTeam } from '../src/data';
import type { Difficulty } from '../src/data/types';
import { createClock } from '../src/game/clock';
import { getDefenseCall } from '../src/play/defenseCalls';
import { DEF_AUDIBLES, DefAudibleSession, defAudibleCost, defensiveOptions, lookClass, offenseCounter } from '../src/play/defAudible';
import { PlaySim, SIM_DT } from '../src/play/sim';

const sim = (play: string, defense: string) => new PlaySim({
  play: getPlay(play), defense: getDefenseCall(defense), offenseTeam: getTeam('elbtal'), defenseTeam: getTeam('rheinstadt'),
  ballX: 0, los: 35, difficulty: DIFFICULTY.normal, seed: 7, userDefense: true,
});

describe('Phase 4: defensive audibles', () => {
  it('offers 2-3 shell changes and 2-3 blitz looks, never the current call', () => {
    for (const id of [...DEF_AUDIBLES.shells, ...DEF_AUDIBLES.blitzLooks]) {
      const o = defensiveOptions(getDefenseCall(id));
      for (const list of [o.shell, o.blitz]) {
        expect(list.length).toBeGreaterThanOrEqual(2);
        expect(list.length).toBeLessThanOrEqual(3);
        expect(list.some((c) => c.id === id)).toBe(false);
      }
    }
    expect(defensiveOptions(getDefenseCall('cover1')).shell.map((c) => c.id)).toContain('cover3');
  });

  it('a defensive audible changes the coverage assignment (Cover 1 -> Cover 3) in the sim', () => {
    const s = new DefAudibleSession(getDefenseCall('cover1'), getPlay('slants'), 'normal', new Rng(1));
    const before = sim('slants', s.defense.id);
    expect(before.getDef('CB1').assignment).toEqual({ kind: 'man', target: 'WR1' });
    const r = s.call(getDefenseCall('cover3'), createClock(300));
    expect(r).not.toBeNull();
    const after = sim('slants', s.defense.id);
    expect(after.getDef('CB1').assignment).toEqual({ kind: 'zone', zone: 'deep3L' });
    expect(after.getDef('FS').assignment).toEqual({ kind: 'zone', zone: 'deepM' });
    expect(after.getDef('LB1').assignment).toEqual({ kind: 'zone', zone: 'hookL' });
  });

  it('costs play clock, the second change costs more, at most maxPerPlay, never below minPlayClock', () => {
    const s = new DefAudibleSession(getDefenseCall('cover3'), getPlay('slants'), 'normal', new Rng(1));
    let clock = createClock(300);
    const start = clock.playClock;
    const a = s.call(getDefenseCall('cover1'), clock)!;
    const b = s.call(getDefenseCall('cover0'), a.clock)!;
    expect([a.cost, b.cost]).toEqual([defAudibleCost(1), defAudibleCost(2)]);
    expect(b.cost).toBeGreaterThan(a.cost);
    clock = b.clock;
    expect(clock.playClock).toBe(start - a.cost - b.cost);
    expect(s.spent).toBe(a.cost + b.cost);
    expect(s.call(getDefenseCall('cover2'), clock)).toBeNull();
    const low = new DefAudibleSession(getDefenseCall('cover3'), getPlay('slants'), 'normal', new Rng(1));
    expect(low.call(getDefenseCall('cover1'), { ...clock, playClock: DEF_AUDIBLES.minPlayClock + defAudibleCost(1) - 0.5 })).toBeNull();
  });

  it('offense counters: a play that already beats the look stays, otherwise a same-formation check that does', () => {
    expect(lookClass(getDefenseCall('cover0'))).toBe('blitz');
    expect(lookClass(getDefenseCall('cover1'))).toBe('man');
    expect(offenseCounter(getPlay('slants'), getDefenseCall('cover0')).id).toBe('slants');
    const vsBlitz = offenseCounter(getPlay('four_verts'), getDefenseCall('cover0'));
    expect(vsBlitz.formation).toBe('shotgun');
    expect(DEF_AUDIBLES.counters.blitz).toContain(vsBlitz.id);
    const vsMan = offenseCounter(getPlay('hb_draw'), getDefenseCall('cover1'));
    expect(DEF_AUDIBLES.counters.man).toContain(vsMan.id);
  });

  const reactionAt = (difficulty: Difficulty, seed: number) => {
    const s = new DefAudibleSession(getDefenseCall('cover3'), getPlay('four_verts'), difficulty, new Rng(seed));
    s.update(0.3); // time passes before the change
    s.call(getDefenseCall('cover0'), createClock(300));
    const delay = DEF_AUDIBLES.cpuOffense[difficulty].react;
    let changedAt: number | null = null;
    for (let t = SIM_DT; t <= 4; t += SIM_DT) {
      if (s.update(SIM_DT)) {
        changedAt = t;
        break;
      }
    }
    return { changedAt, delay, play: s.play };
  };

  it('the CPU offense reacts exactly after the configured delay, not before; Hard recognizes more than Easy', () => {
    let recognized: Record<Difficulty, number> = { easy: 0, normal: 0, hard: 0 };
    for (const d of ['easy', 'normal', 'hard'] as Difficulty[]) {
      for (let seed = 1; seed <= 200; seed++) {
        const r = reactionAt(d, seed);
        if (r.changedAt === null) {
          expect(r.play.id).toBe('four_verts');
          continue;
        }
        recognized[d]++;
        expect(r.changedAt).toBeGreaterThanOrEqual(r.delay - 1e-9);
        expect(r.changedAt).toBeLessThan(r.delay + SIM_DT + 1e-9);
        expect(DEF_AUDIBLES.counters.blitz).toContain(r.play.id);
      }
    }
    expect(DEF_AUDIBLES.cpuOffense.hard.react).toBeLessThan(DEF_AUDIBLES.cpuOffense.easy.react);
    expect(recognized.hard).toBeGreaterThan(recognized.normal);
    expect(recognized.normal).toBeGreaterThan(recognized.easy);
    expect(recognized.normal / 200).toBeCloseTo(DEF_AUDIBLES.cpuOffense.normal.read, 1);
  });

  it('a snap before the re-read keeps the offense in its old play', () => {
    const s = new DefAudibleSession(getDefenseCall('cover3'), getPlay('four_verts'), 'hard', new Rng(3));
    s.call(getDefenseCall('cover0'), createClock(300));
    expect(s.update(DEF_AUDIBLES.cpuOffense.hard.react - 0.05)).toBeNull();
    expect(s.play.id).toBe('four_verts');
  });
});
