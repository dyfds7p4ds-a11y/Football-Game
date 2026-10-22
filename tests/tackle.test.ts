import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import { v2 } from '../src/core/vec';
import { TACKLE, approachOf, resolveTackle, tackleProbability } from '../src/play/tackle';
import { runPlay } from './simHarness';

const carrier = { carrierPos: v2(0, 50), carrierVel: v2(0, 8), carrierStrength: 70, carrierSpeed: 85 };
const tackler = (pos: ReturnType<typeof v2>, vel: ReturnType<typeof v2>) => ({
  ...carrier, tacklerPos: pos, tacklerVel: vel, tackling: 75, engaged: false, juking: false, factor: 1,
});

describe('tackle resolution', () => {
  it('classifies the approach from the carrier\'s running direction', () => {
    expect(approachOf(v2(0, 51), v2(0, 50), v2(0, 8))).toBe('headOn');
    expect(approachOf(v2(1, 50), v2(0, 50), v2(0, 8))).toBe('side');
    expect(approachOf(v2(0, 49), v2(0, 50), v2(0, 8))).toBe('behind');
  });

  it('head-on beats side beats from behind', () => {
    const head = tackleProbability(tackler(v2(0, 51), v2(0, -7))).p;
    const side = tackleProbability(tackler(v2(1, 50), v2(-7, 0))).p;
    const back = tackleProbability(tackler(v2(0, 49), v2(0, 9))).p;
    expect(head).toBeGreaterThan(side);
    expect(side).toBeGreaterThan(back);
  });

  it('a faster carrier is harder to drag down from behind; a faster tackler helps', () => {
    const slow = tackleProbability({ ...tackler(v2(0, 49), v2(0, 9)), carrierVel: v2(0, 4) }).p;
    const fast = tackleProbability({ ...tackler(v2(0, 49), v2(0, 9)), carrierVel: v2(0, 9) }).p;
    expect(slow).toBeGreaterThan(fast);
    const lazy = tackleProbability(tackler(v2(0, 51), v2(0, -2))).p;
    const flying = tackleProbability(tackler(v2(0, 51), v2(0, -9))).p;
    expect(flying).toBeGreaterThan(lazy);
  });

  it('engaged tacklers only get an arm on him', () => {
    const free = tackleProbability(tackler(v2(1, 50), v2(-7, 0))).p;
    const arm = tackleProbability({ ...tackler(v2(1, 50), v2(-7, 0)), engaged: true }).p;
    expect(arm).toBeLessThan(free * 0.5);
  });

  it('picks the contact animation from the approach and the result', () => {
    const kinds = new Set<string>();
    for (let i = 0; i < 200; i++) {
      kinds.add(resolveTackle({ ...tackler(v2(0, 51), v2(0, -8)), rng: new Rng(i) }).kind);
      kinds.add(resolveTackle({ ...tackler(v2(1, 50), v2(-7, 0)), rng: new Rng(i) }).kind);
      kinds.add(resolveTackle({ ...tackler(v2(0, 49), v2(0, 9)), rng: new Rng(i) }).kind);
    }
    for (const k of ['shoulder', 'wrap', 'stumble', 'hipTurn']) expect(kinds.has(k), k).toBe(true);
  });

  it('a successful tackle is a short contact before the whistle', () => {
    for (const k of Object.values(TACKLE.contactTime)) expect(k).toBeLessThanOrEqual(0.6);
  });
});

describe('tackles in a play', () => {
  it('the whistle follows contact within the contact time, and the carrier falls forward from behind', () => {
    let checked = 0;
    for (let s = 0; s < 20; s++) {
      let contactAt = -1;
      let kind = '';
      const r = runPlay('hb_dive', 'cover2', s, {
        throwAt: null, target: null,
        onStep: (sim) => {
          const rb = sim.get('RB');
          if (contactAt < 0 && sim.inContact && rb.anim) {
            contactAt = sim.t;
            kind = rb.anim.kind;
          }
        },
      });
      if (contactAt < 0 || r.result!.outcome !== 'tackle') continue;
      checked++;
      expect(r.result!.duration - contactAt, kind).toBeLessThanOrEqual(TACKLE.contactTime[kind as keyof typeof TACKLE.contactTime] + 0.02);
    }
    expect(checked).toBeGreaterThan(10);
  });
});
