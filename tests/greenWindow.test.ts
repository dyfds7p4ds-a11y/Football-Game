import { describe, expect, it } from 'vitest';
import { DIFFICULTY } from '../src/data';
import type { Difficulty, EligibleSlot } from '../src/data/types';
import { v2 } from '../src/core/vec';
import type { PlaySim } from '../src/play/sim';
import { THROW } from '../src/play/throw';
import { CATCH, PASSING, resolveCatch } from '../src/play/catch';
import { Rng } from '../src/core/rng';
import { runPlay } from './simHarness';

/** Clear the field of defenders: every defender stands far away and cannot move (no pressure, nobody near any receiver). */
const clearDefense = (sim: PlaySim) => {
  for (const d of sim.actors) {
    if (d.side !== 'def') continue;
    d.pos = v2(d.pos.x < 0 ? -40 : 40, sim.los + 70);
    d.prevPos = { ...d.pos };
    d.maxSpeed = 0;
  }
};

const CASES: { play: string; target: EligibleSlot }[] = [
  { play: 'slants', target: 'WR1' },
  { play: 'four_verts', target: 'WR1' },
  { play: 'four_verts', target: 'WR2' },
  { play: 'levels', target: 'WR3' },
  { play: 'curl_flat', target: 'TE' },
  { play: 'mesh', target: 'WR2' },
  { play: 'quick_outs', target: 'WR1' },
  { play: 'deep_post', target: 'WR1' },
];

/** A throw released inside the green window (offset in half-widths, |offset| < 1) to an uncovered receiver. */
function greenThrow(c: (typeof CASES)[number], seed: number, throwAt: number, offset: number, difficulty: Difficulty) {
  let cleared = false;
  const halfWidth = THROW.windowHalfWidth * DIFFICULTY[difficulty].throwWindow;
  return runPlay(c.play, 'cover3', seed, {
    throwAt, target: c.target, dropFor: 0.4, chargeError: offset * halfWidth,
    script: (sim) => {
      if (!cleared) {
        clearDefense(sim);
        cleared = true;
      }
    },
  }, difficulty);
}

describe('Phase 4: green-window throws (Part D)', () => {
  it('a green-window throw to an uncovered receiver completes in 100 % of seeded runs', () => {
    const misses: string[] = [];
    let n = 0;
    for (const difficulty of ['easy', 'normal', 'hard'] as Difficulty[]) {
      for (const c of CASES) {
        for (let seed = 1; seed <= 12; seed++) {
          const throwAt = 0.9 + (seed % 6) * 0.25;
          const offset = ((seed * 37) % 19) / 10 - 0.9; // -0.9 .. +0.9 half-widths: always inside the green
          const r = greenThrow(c, seed, throwAt, offset, difficulty);
          if (!r.result?.passAttempt) continue; // the QB never released (receiver out of range etc.)
          n++;
          if (!r.result.completion) misses.push(`${difficulty} ${c.play}/${c.target} seed ${seed} t ${throwAt} off ${offset.toFixed(1)}: ${r.result.outcome} ${JSON.stringify(r.sim.incompleteReason)}`);
        }
      }
    }
    expect(n).toBeGreaterThan(200);
    expect(misses).toEqual([]);
  }, 60_000);

  it('only pressure, defender proximity and timing can make a well-placed ball incomplete', () => {
    const base = {
      landing: v2(0, 50), quality: 0.8, speed: 26, ballSkills: 1,
      offense: [{ id: 1, pos: v2(0.6, 50), catching: 40, coverage: 0 }],
    };
    const clear = [{ id: 9, pos: v2(0, 50 + CATCH.reach + CATCH.contest + 0.5), catching: 60, coverage: 90 }];
    const near = [{ id: 9, pos: v2(1.2, 50.8), catching: 60, coverage: 90 }];
    const run = (o: Partial<Parameters<typeof resolveCatch>[0]>) => {
      let caught = 0;
      for (let s = 1; s <= 300; s++) if (resolveCatch({ ...base, defense: clear, green: true, pressure: 0, rng: new Rng(s), ...o }).kind === 'catch') caught++;
      return caught / 300;
    };
    expect(run({})).toBe(1); // clean: even a 40-catching receiver never drops it
    expect(run({ green: false })).toBeLessThan(1); // badly timed release
    expect(run({ pressure: PASSING.cleanCatch.maxPressure + 0.2 })).toBeLessThan(1); // pressure
    expect(run({ defense: near })).toBeLessThan(1); // a defender in the contest radius
  });

  it('debug mode records the reason for an incomplete', () => {
    const r = runPlay('four_verts', 'cover3', 5, { throwAt: 1.2, target: 'WR1', dropFor: 0.4, chargeError: 0.5 });
    if (r.result?.outcome === 'incomplete') expect(r.sim.incompleteReason?.reason).toBeTruthy();
    expect(r.sim.incompleteReason === null || r.result?.outcome === 'incomplete').toBe(true);
  });
});
