import { describe, expect, it } from 'vitest';
import { v2 } from '../src/core/vec';
import { SCRAMBLE } from '../src/play/sim';
import { tackleProbability } from '../src/play/tackle';
import { runPlay } from './simHarness';

describe('pocket', () => {
  it('pressure comes from the edges and from behind, not only up the middle', () => {
    let sideOrBack = 0;
    let sacks = 0;
    for (let s = 0; s < 24; s++) {
      const r = runPlay('four_verts', 'cover3', s, { throwAt: null, target: null, dropFor: 0.8 });
      if (r.result!.outcome !== 'sack') continue;
      sacks++;
      const qb = r.sim.get('QB');
      const ev = r.events.find((e) => e.type === 'sack')!;
      // Who made the sack? The nearest defender at the whistle.
      const d = r.sim.actors.filter((a) => a.side === 'def').sort((a, b) =>
        Math.hypot(a.pos.x - qb.pos.x, a.pos.y - qb.pos.y) - Math.hypot(b.pos.x - qb.pos.x, b.pos.y - qb.pos.y))[0];
      const heading = Math.abs(Math.atan2(d.pos.x - qb.pos.x, d.pos.y - qb.pos.y));
      if (heading > Math.PI / 3) sideOrBack++;
      expect(ev).toBeDefined();
    }
    expect(sacks).toBeGreaterThan(15);
    expect(sideOrBack / sacks).toBeGreaterThan(0.25);
  });

  it('the line does not hold forever: holding the ball longer means more lost blocks', () => {
    let early = 0;
    let late = 0;
    for (let s = 0; s < 30; s++) {
      const r = runPlay('deep_post', 'cover3', s, { throwAt: null, target: null, dropFor: 0.8 });
      for (const e of r.events) {
        if (e.type !== 'shed') continue;
        if (e.t < 1.6) early++;
        else if (e.t < 3.2) late++;
      }
    }
    expect(late).toBeGreaterThan(early);
    expect(early).toBeGreaterThan(0); // some reps are lost quickly
  });

  it('shows a pocket cue when a free rusher closes in', () => {
    let cueSeen = false;
    runPlay('four_verts', 'cover0', 3, {
      throwAt: null, target: null, dropFor: 0.8,
      onStep: (sim) => {
        if (sim.pocketCue && sim.pocketCue.level > 0.5) cueSeen = true;
      },
    });
    expect(cueSeen).toBe(true);
  });

  it('harder difficulty brings more pocket pressure', () => {
    let easy = 0;
    let hard = 0;
    for (let s = 0; s < 16; s++) {
      const o = { throwAt: null, target: null, dropFor: 0.8 } as const;
      easy += runPlay('four_verts', 'cover3', s, o, 'easy').result!.duration;
      hard += runPlay('four_verts', 'cover3', s, o, 'hard').result!.duration;
    }
    expect(hard).toBeLessThan(easy);
  });
});

describe('scrambling', () => {
  it('a QB who runs out of the pocket is scrambling and can slide to end the play safely', () => {
    let slid = false;
    const r = runPlay('four_verts', 'cover2', 4, {
      throwAt: null, target: null,
      script: (sim, inp) => {
        inp.move = { x: 1, y: sim.t < 0.5 ? -1 : 0.6 };
        if (sim.pastLos(sim.get('QB')) && sim.get('QB').pos.y > sim.los + 2 && !slid) {
          inp.slide = true;
          slid = true;
        }
      },
    });
    expect(r.sim.scrambling).toBe(true);
    expect(r.events.some((e) => e.type === 'slide')).toBe(true);
    expect(r.result!.outcome).toBe('tackle');
    expect(r.result!.yards).toBeGreaterThanOrEqual(2);
  });

  it('a scrambling QB past the line is easier to bring down than in the open field as a runner', () => {
    // Same runner, same angle: the scramble factor makes the tackle more likely.
    const base = {
      tacklerPos: v2(1, 40), tacklerVel: v2(-5, 0), carrierPos: v2(0, 40), carrierVel: v2(0, 7),
      tackling: 50, carrierStrength: 60, carrierSpeed: 70, engaged: false, juking: false,
    };
    const runner = tackleProbability({ ...base, factor: 1 }).p;
    const qb = tackleProbability({ ...base, factor: SCRAMBLE.tackleBonus }).p;
    expect(qb).toBeGreaterThan(runner);
  });
});
