import { describe, expect, it } from 'vitest';
import TURNOVERS from '../src/data/turnovers.json';
import { SPRINT, freshSprint, sprintFumbleFactor, sprintSpeed, stepSprint } from '../src/play/sprint';
import { runPlay } from './simHarness';

describe('sprint (Phase 3d)', () => {
  it('configured fumble multipliers sit inside the configured range', () => {
    const [lo, hi] = SPRINT.fumbleRange;
    expect(SPRINT.fumbleMin).toBeGreaterThanOrEqual(lo);
    expect(SPRINT.fumbleMax).toBeLessThanOrEqual(hi);
    expect(SPRINT.fumbleMin).toBeGreaterThan(1);
  });

  it('fumble factor: 1 without sprint, inside the range while sprinting, higher when tired', () => {
    const [lo, hi] = SPRINT.fumbleRange;
    const s = freshSprint();
    expect(sprintFumbleFactor(s, 0)).toBe(1);
    stepSprint(s, true, 0, 1 / 60);
    const fresh = sprintFumbleFactor(s, 0);
    expect(fresh).toBeGreaterThanOrEqual(lo);
    expect(fresh).toBeLessThanOrEqual(hi);
    for (let i = 0; i < 90; i++) stepSprint(s, true, i / 60, 1 / 60);
    const tired = sprintFumbleFactor(s, 1.5);
    expect(tired).toBeGreaterThan(fresh);
    expect(tired).toBeLessThanOrEqual(hi);
    // Afterglow, then back to 1.
    stepSprint(s, false, 1.6, 1 / 60);
    expect(sprintFumbleFactor(s, 1.6)).toBeGreaterThan(1);
    expect(sprintFumbleFactor(s, 1.6 + SPRINT.afterglow + 0.1)).toBe(1);
  });

  it('stamina drains, runs dry, and recovers before the next sprint', () => {
    const s = freshSprint();
    let t = 0;
    while (!s.exhausted && t < 10) stepSprint(s, true, (t += 1 / 60), 1 / 60);
    expect(t).toBeCloseTo(1 / SPRINT.stamina.drain, 0);
    expect(s.sprinting).toBe(false);
    stepSprint(s, true, (t += 1 / 60), 1 / 60);
    expect(s.sprinting).toBe(false); // must recover to `restart` first
    while (s.exhausted) stepSprint(s, false, (t += 1 / 60), 1 / 60);
    expect(s.stamina).toBeGreaterThanOrEqual(SPRINT.stamina.restart);
    expect(sprintSpeed(s, false)).toBe(0.9);
    stepSprint(s, true, (t += 1 / 60), 1 / 60);
    expect(sprintSpeed(s, false)).toBe(SPRINT.speed);
  });

  it('in the sim: the sprinting carrier is faster and fumbles more, within the configured range', () => {
    // Raise the base fumble rate so the effect is measurable on a few hundred carries.
    const F = TURNOVERS.fumble as { base: number; max: number };
    const keep = { base: F.base, max: F.max };
    F.base = 0.25;
    F.max = 0.3;
    try {
      const rate = (sprint: boolean) => {
        let fumbles = 0;
        let tackled = 0;
        let speed = 0;
        for (let seed = 1; seed <= 400; seed++) {
          let top = 0;
          const { result } = runPlay('hb_dive', ['cover2', 'cover3', 'cover1'][seed % 3], seed, {
            throwAt: null, target: null,
            script: (s, inp) => {
              inp.move = s.carrier && s.carrier.slot === 'RB' ? { x: 0, y: 1 } : { x: 0, y: 0 };
              inp.sprint = sprint;
            },
            onStep: (s) => {
              const c = s.carrier;
              if (c && c.slot === 'RB') top = Math.max(top, Math.hypot(c.vel.x, c.vel.y));
            },
          });
          speed += top;
          if (!result || result.outcome === 'touchdown') continue;
          tackled++;
          if (result.fumble) fumbles++;
        }
        return { rate: fumbles / tackled, speed: speed / 400 };
      };
      const walk = rate(false);
      const run = rate(true);
      expect(run.speed).toBeGreaterThan(walk.speed * 1.05);
      const ratio = run.rate / walk.rate;
      if (process.env.BALANCE_STATS) console.log("sprint", walk, run, ratio);
      const [lo, hi] = SPRINT.fumbleRange;
      // Measured about 1.55 (the multiplier plus harder hits at sprint speed); small sampling tolerance.
      expect(ratio).toBeGreaterThan(lo - 0.1);
      expect(ratio).toBeLessThan(hi + 0.1);
    } finally {
      F.base = keep.base;
      F.max = keep.max;
    }
  }, 120000);
});
