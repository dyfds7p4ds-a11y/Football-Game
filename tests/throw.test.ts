import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import { dist, v2 } from '../src/core/vec';
import {
  THROW, ballHeightAt, computeThrow, idealCharge, leadTarget, releaseQuality, speedForCharge, throwWindow,
} from '../src/play/throw';

const base = {
  from: v2(0, 20), target: v2(10, 40), targetVel: v2(0, 0), pressure: 0, accuracy: 90, power: 90, qbSpeed: 0, windowScale: 1,
};

describe('throw timing', () => {
  it('maps charge to speed monotonically within bounds', () => {
    expect(speedForCharge(0)).toBe(THROW.minSpeed);
    expect(speedForCharge(1)).toBe(THROW.maxSpeed);
    expect(speedForCharge(2)).toBe(THROW.maxSpeed);
    expect(speedForCharge(0.5)).toBeGreaterThan(speedForCharge(0.4));
  });

  it('needs more charge for longer throws', () => {
    expect(idealCharge(40)).toBeGreaterThan(idealCharge(15));
    expect(idealCharge(15)).toBeGreaterThan(idealCharge(5));
  });

  it('rewards releasing inside the sweet spot', () => {
    const w = throwWindow(20);
    expect(releaseQuality(w.center, w)).toBe(1);
    expect(releaseQuality(w.center + w.halfWidth, w)).toBeCloseTo(0.75);
    expect(releaseQuality(w.center - 3 * w.halfWidth, w)).toBe(0);
    expect(releaseQuality(w.center + 0.5 * w.halfWidth, w)).toBeGreaterThan(releaseQuality(w.center + 2 * w.halfWidth, w));
  });

  it('widens the window on easier difficulty', () => {
    expect(throwWindow(20, 1.5).halfWidth).toBeGreaterThan(throwWindow(20, 1).halfWidth);
  });

  it('leads a moving receiver', () => {
    const { aim } = leadTarget(v2(0, 0), v2(0, 20), v2(8, 0), 20);
    expect(aim.x).toBeGreaterThan(5);
    expect(aim.y).toBe(20);
  });

  it('lands a perfect throw close to the aim point', () => {
    const w = throwWindow(dist(base.from, base.target));
    let total = 0;
    for (let i = 0; i < 50; i++) {
      const sol = computeThrow({ ...base, charge: w.center, rng: new Rng(i) });
      total += sol.missDistance;
      expect(sol.quality).toBe(1);
    }
    expect(total / 50).toBeLessThan(1.2);
  });

  it('misses by more when mistimed or under pressure', () => {
    const w = throwWindow(dist(base.from, base.target));
    const avgMiss = (charge: number, pressure: number) => {
      let t = 0;
      for (let i = 0; i < 200; i++) t += computeThrow({ ...base, charge, pressure, rng: new Rng(i) }).missDistance;
      return t / 200;
    };
    const good = avgMiss(w.center, 0);
    expect(avgMiss(w.center - 0.3, 0)).toBeGreaterThan(good * 2);
    expect(avgMiss(w.center, 1)).toBeGreaterThan(good * 1.5);
  });

  it('under-charged throws fall short, over-charged sail long', () => {
    const w = throwWindow(dist(base.from, base.target));
    const short = computeThrow({ ...base, accuracy: 100, charge: w.center - 0.3, rng: new Rng(1) });
    const long = computeThrow({ ...base, accuracy: 100, charge: Math.min(1, w.center + 0.3), rng: new Rng(1) });
    expect(dist(base.from, short.landing)).toBeLessThan(dist(base.from, long.landing));
    expect(short.flightTime).toBeGreaterThan(long.flightTime);
  });

  it('is deterministic for a given seed', () => {
    const a = computeThrow({ ...base, charge: 0.5, rng: new Rng(42) });
    const b = computeThrow({ ...base, charge: 0.5, rng: new Rng(42) });
    expect(a).toEqual(b);
  });

  it('produces a trajectory that arrives at catch height', () => {
    const sol = computeThrow({ ...base, charge: 0.6, rng: new Rng(3) });
    expect(ballHeightAt(sol.vel.h, sol.flightTime)).toBeCloseTo(THROW.catchHeight, 5);
    expect(ballHeightAt(sol.vel.h, sol.flightTime / 2)).toBeGreaterThan(THROW.releaseHeight);
  });
});
