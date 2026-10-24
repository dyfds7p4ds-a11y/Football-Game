import { describe, expect, it } from 'vitest';
import type { Difficulty } from '../src/data/types';
import type { SimInput, PlaySim } from '../src/play/sim';
import BALANCE from '../src/data/balance.json';
import { DEFENSE_CALLS } from '../src/play/defenseCalls';
import { runPlay } from './simHarness';

type Steer = (sim: PlaySim, inp: SimInput) => void;

/** Flat run to one side, then upfield (the exploit: a single flat run around the edge). */
const flat = (side: number, start: number): Steer => (sim, inp) => {
  if (sim.t < start || sim.ball.holder !== sim.get("QB").id) return;
  const qb = sim.get('QB');
  const wide = Math.abs(qb.pos.x - sim.ballX) > 10 || sim.t > start + 1.8 || sim.pastLos(qb);
  inp.move = wide ? { x: 0.15 * side, y: 1 } : { x: side, y: 0 };
  inp.sprint = true;
};
/** Straight up the middle. */
const up = (start: number): Steer => (sim, inp) => {
  if (sim.t < start || sim.ball.holder !== sim.get("QB").id) return;
  inp.move = { x: 0, y: 1 };
  inp.sprint = true;
};

/** A scrambler who reads the rush: steps into the widest lane between unblocked defenders (re-read every 0.3 s), then bends away from tacklers. */
const lane = (start: number): Steer => {
  let dir = { x: 0, y: 1 };
  let next = 0;
  return (sim, inp) => {
    if (sim.t < start || sim.ball.holder !== sim.get('QB').id) return;
    const qb = sim.get('QB');
    // Blocked defenders are no threat: the lane is what the line opens.
    const engaged = new Set(sim.blockStates().map((b) => b.defender));
    const defs = sim.actors.filter((a) => a.side === 'def' && !a.down && !engaged.has(a.id));
    if (sim.t >= next) {
      next = sim.t + 0.3;
      let best = -Infinity;
      for (let deg = -70; deg <= 70; deg += 10) {
        const a = (deg * Math.PI) / 180;
        const d = { x: Math.sin(a), y: Math.cos(a) };
        let score = Infinity;
        for (const k of [1.5, 3, 5]) {
          const p = { x: qb.pos.x + d.x * k, y: qb.pos.y + d.y * k };
          for (const e of defs) score = Math.min(score, Math.hypot(e.pos.x - p.x, e.pos.y - p.y) - k * 0.35);
        }
        score += d.y * 2; // prefer gaining ground
        if (score > best) {
          best = score;
          dir = d;
        }
      }
    }
    inp.move = dir;
    inp.sprint = true;
  };
};

/** Scramble styles; each takes the seed, so the scramble starts at a different moment on every snap. */
export const scrambleScripts: Record<string, (seed: number) => Steer> = {
  flatRight: (seed) => flat(1, 0.9 + (seed % 7) * 0.2),
  flatLeft: (seed) => flat(-1, 0.9 + (seed % 7) * 0.2),
  upMiddle: (seed) => up(1.1 + (seed % 7) * 0.2),
  lane: (seed) => lane(1.1 + (seed % 7) * 0.2),
  laneLate: (seed) => lane(1.8 + (seed % 5) * 0.25),
};

/** Scrambles of one group: 'lane' = a QB who reads the rush, 'flat' = the flat-run exploit, 'all' = every style. */
export function scrambleSample(seeds: number, group: 'lane' | 'flat' | 'all', difficulty: Difficulty = 'normal') {
  const ys: number[] = [];
  const scripts = Object.entries(scrambleScripts).filter(([k]) => group === 'all' || (group === 'lane' ? k.startsWith('lane') : k.startsWith('flat')));
  for (const [, make] of scripts) {
    for (const d of DEFENSE_CALLS) {
      for (let s = 0; s < seeds; s++) {
        const r = runPlay('four_verts', d.id, s * 7 + 3, { throwAt: null, target: null, dropFor: 0.5, script: make(s) }, difficulty);
        if (r.sim.scrambling && r.result && !r.result.passAttempt) ys.push(r.result.yards);
      }
    }
  }
  return ys;
}

const B = BALANCE.scramble;
const mean = (ys: number[]) => ys.reduce((a, b) => a + b, 0) / ys.length;
const share = (ys: number[], f: (y: number) => boolean) => ys.filter(f).length / ys.length;

describe('Phase 4: scramble balance', () => {
  it('yards per scramble and tackle-for-loss rate stay inside the corridor at Normal', () => {
    const ys = scrambleSample(B.seeds, 'all');
    expect(ys.length).toBeGreaterThan(200);
    expect(mean(ys)).toBeGreaterThanOrEqual(B.minAvg);
    expect(mean(ys)).toBeLessThanOrEqual(B.maxAvg);
    expect(share(ys, (y) => y < 0)).toBeGreaterThanOrEqual(B.minTfl);
    expect(share(ys, (y) => y < 0)).toBeLessThanOrEqual(B.maxTfl);
  }, 120_000);

  it('a single flat run hands over no lane: it gains less than a scramble through the lanes the line opens', () => {
    const flatYs = scrambleSample(B.seeds, 'flat');
    const laneYs = scrambleSample(B.seeds, 'lane');
    expect(mean(flatYs)).toBeLessThanOrEqual(B.flatMaxAvg);
    expect(share(flatYs, (y) => y >= 15)).toBeLessThanOrEqual(B.flatMax15Plus);
    expect(mean(flatYs)).toBeLessThan(mean(laneYs));
  }, 120_000);
});
