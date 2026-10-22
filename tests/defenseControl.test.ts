import { describe, expect, it } from 'vitest';
import { add, dist, norm, scale, sub, v2 } from '../src/core/vec';
import { DIFFICULTY, getPlay, getTeam } from '../src/data';
import { getDefenseCall } from '../src/play/defenseCalls';
import { DEF_CONTROL } from '../src/play/interception';
import { PlaySim, idleInput, type PlayResult } from '../src/play/sim';
import { THROW, throwWindow } from '../src/play/throw';

const mk = (seed: number, play = 'four_verts', def = 'cover1') => new PlaySim({
  play: getPlay(play), defense: getDefenseCall(def), offenseTeam: getTeam('rheinstadt'), defenseTeam: getTeam('elbtal'),
  ballX: 0, los: 30, difficulty: DIFFICULTY.normal, seed, penaltyBias: { off: 0, def: 0 }, userDefense: true,
});

/** QB throws to WR1 at 2.2 s with a perfect charge; the user CB1 shadows WR1 and jumps `jumpOffset` s from ideal (null: never). */
function coverWr1(seed: number, jumpOffset: number | null, play = 'four_verts', throwAt = 2.2, trail = false): { result: PlayResult; grade: string | null; read: string | null; margin: number } {
  const sim = mk(seed, play);
  const cb = sim.getDef('CB1');
  let chargeUntil = Infinity;
  let jumpAt = Infinity;
  for (let i = 0; i < 60 * 12 && !sim.result; i++) {
    const inp = idleInput();
    inp.target = 'WR1';
    if (sim.t < 0.6) inp.move = v2(0, -1);
    if (sim.t >= throwAt && sim.canThrow()) {
      const c = throwWindow(dist(sim.get('QB').pos, sim.get('WR1').pos), 1).center;
      if (chargeUntil === Infinity && sim.charge + 1 / 60 / THROW.chargeTime >= c) chargeUntil = sim.t;
      inp.throwHeld = sim.t < chargeUntil;
    }
    const wr = sim.get('WR1');
    const f = sim.ball.state === 'air' && sim.ball.flight && !sim.ball.flight.lateral ? sim.ball.flight : null;
    if (f && jumpAt === Infinity && jumpOffset !== null) jumpAt = sim.t + (f.T - f.t) - DEF_CONTROL.jump.peakAt + jumpOffset;
    // Reading the throw: shadow ahead of the man and break to the catch point. `trail`: stay on his hip instead.
    const goal = trail ? add(wr.pos, scale(norm(wr.vel), -0.8)) : f ? f.landing : add(wr.pos, scale(wr.vel, 0.6));
    inp.defense = { move: dist(goal, cb.pos) > 0.3 ? norm(sub(goal, cb.pos)) : v2(), jump: sim.t >= jumpAt && sim.t < jumpAt + 1 / 30 };
    sim.step(inp);
  }
  return { result: sim.result!, grade: sim.lastTiming?.grade ?? null, read: sim.lastTiming?.read ?? null, margin: sim.lastTiming?.margin ?? NaN };
}

describe('user-controlled cornerback', () => {
  it('starts on CB1, follows only the stick, and the CPU keeps the other ten', () => {
    const sim = mk(5);
    const cb = sim.getDef('CB1');
    const cb2 = sim.getDef('CB2');
    expect(sim.userDefId).toBe(cb.id);
    const start = { ...cb.pos };
    const start2 = { ...cb2.pos };
    for (let i = 0; i < 90; i++) sim.step(idleInput());
    expect(dist(cb.pos, start)).toBeLessThan(0.3);
    expect(dist(cb2.pos, start2)).toBeGreaterThan(1);
    for (let i = 0; i < 45; i++) {
      const inp = idleInput();
      inp.defense = { move: v2(1, 0), jump: false };
      sim.step(inp);
    }
    expect(cb.pos.x - start.x).toBeGreaterThan(2);
  });

  it('switches between cornerbacks; the released one goes back to CPU coverage', () => {
    const sim = mk(6);
    sim.selectDefender('CB2');
    expect(sim.userDefId).toBe(sim.getDef('CB2').id);
    const cb1 = sim.getDef('CB1');
    const s1 = { ...cb1.pos };
    for (let i = 0; i < 90; i++) sim.step(idleInput());
    expect(dist(cb1.pos, s1)).toBeGreaterThan(1);
  });

  it('is deterministic with the same inputs', () => {
    const a = coverWr1(11, 0);
    const b = coverWr1(11, 0);
    expect(a.result.outcome).toBe(b.result.outcome);
    expect(a.result.endY).toBe(b.result.endY);
  });

  it('a well-timed jump breaks up or picks more passes than no jump; picks stay rare', () => {
    const tally = (offset: number | null) => {
      // Shadowing the receiver closely is the user's job; the jump timing decides what happens at the catch point.
      let ints = 0, stops = 0, n = 0, perfect = 0;
      for (let s = 0; s < 80; s++) {
        const r = coverWr1(s, offset);
        n++;
        if (r.result.outcome === 'interception') ints++;
        if (r.result.outcome === 'interception' || r.result.outcome === 'incomplete') stops++;
        if (r.grade === 'perfect') perfect++;
      }
      return { int: ints / n, stop: stops / n, perfect: perfect / n };
    };
    const timed = tally(0);
    const none = tally(null);
    const late = tally(DEF_CONTROL.window.good + 0.08);
    if (process.env.JUMP_STATS) console.log('jump timing', { timed, none, late });
    expect(timed.perfect).toBeGreaterThan(0.5);
    expect(timed.stop).toBeGreaterThan(none.stop);
    expect(timed.int).toBeGreaterThanOrEqual(none.int);
    expect(late.stop).toBeLessThan(timed.stop);
    expect(timed.int).toBeLessThan(0.45);
  });

  it('reading the throw plus a timed jump gets more picks than trailing the receiver', () => {
    let read = 0, trail = 0;
    let n = 0;
    for (const [play, at] of [['smash', 2.0], ['levels', 2.0], ['curl_flat', 2.0], ['four_verts', 2.2]] as const) for (let s = 0; s < 20; s++) {
      const a = coverWr1(s, 0, play, at, false);
      const b = coverWr1(s, 0, play, at, true);
      n++;
      if (a.result.outcome === 'interception') read++;
      if (b.result.outcome === 'interception') trail++;
    }
    if (process.env.JUMP_STATS) console.log('read', { read: read / n, trail: trail / n });
    expect(read).toBeGreaterThan(trail * 1.5);
    expect(read / n).toBeLessThan(0.5);
  });
});
