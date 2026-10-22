import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import { DIFFICULTY, getPlay, getTeam } from '../src/data';
import type { Ratings, TeamData } from '../src/data/types';
import {
  BLOCKING, assignProtection, blockQuality, holdTime, laneCandidates, pickLane, planRunBlocks, progressRate, type Unit,
} from '../src/play/blocking';
import { getDefenseCall } from '../src/play/defenseCalls';
import { PlaySim, idleInput } from '../src/play/sim';

const R = (o: Partial<Ratings>): Ratings => ({
  speed: 60, strength: 75, awareness: 70, catching: 40, throwPower: 40, throwAccuracy: 40,
  blocking: 75, passRush: 75, tackling: 70, coverage: 40, ...o,
});

/** Same team with every OL's blocking and strength set to `v`. */
function withLine(team: TeamData, v: number): TeamData {
  return { ...team, roster: team.roster.map((p) => p.position === 'OL' ? { ...p, ratings: { ...p.ratings, blocking: v, strength: v } } : p) };
}

describe('block outcome', () => {
  it('grades matchups from ratings: strong blockers win, weak ones lose', () => {
    expect(blockQuality(R({ blocking: 92, strength: 90 }), R({ passRush: 65, strength: 70 }), 'pass')).toBeGreaterThan(0.5);
    expect(blockQuality(R({ blocking: 60, strength: 65 }), R({ passRush: 90, strength: 88 }), 'pass')).toBeLessThan(-0.5);
    expect(Math.abs(blockQuality(R({}), R({}), 'pass'))).toBeLessThan(0.2);
    // Run blocks weight strength, so a strong mauler wins in the run game even with average technique.
    const mauler = R({ blocking: 70, strength: 95 });
    const finesse = R({ passRush: 90, strength: 60, tackling: 60 });
    expect(blockQuality(mauler, finesse, 'run')).toBeGreaterThan(blockQuality(mauler, finesse, 'pass'));
  });

  it('hold time follows block quality, not a fixed roll', () => {
    const o = { mode: 'pass' as const, passRush: 1 };
    expect(holdTime(0.6, o)).toBeGreaterThan(holdTime(0, o));
    expect(holdTime(0, o)).toBeGreaterThan(holdTime(-0.6, o));
    expect(holdTime(0, o)).toBeCloseTo(BLOCKING.hold.passBase, 5);
    // Harder pass rush shortens every block.
    expect(holdTime(0, { ...o, passRush: 1.2 })).toBeLessThan(holdTime(0, o));
    // Rep variance stays around the matchup: a strong block usually outlasts a weak one.
    const rng = new Rng(3);
    let strongWins = 0;
    for (let i = 0; i < 400; i++) if (holdTime(0.5, { ...o, rng }) > holdTime(-0.5, { ...o, rng })) strongWins++;
    expect(strongWins / 400).toBeGreaterThan(0.85);
  });

  it('a double team holds longer; a QB holding the ball wears the line down', () => {
    expect(progressRate(2)).toBeLessThan(progressRate(1));
    expect(progressRate(1, 1.5)).toBeGreaterThan(progressRate(1));
  });
});

describe('protection assignments', () => {
  const ol = (i: number): Unit => ({ id: i, x: (i - 2) * 1.3, y: 29, kind: 'ol' });
  const line = [0, 1, 2, 3, 4].map(ol);
  const rusher = (id: number, x: number, y = 31): Unit => ({ id, x, y, kind: 'def' });
  const qb = { x: 0, y: 25 };

  it('four rushers: four pass sets and a double team', () => {
    const a = assignProtection(line, [rusher(10, -3.8), rusher(11, -1), rusher(12, 1), rusher(13, 3.8)], qb, 0);
    expect(a.filter((x) => x.role === 'passSet' && x.target !== null)).toHaveLength(4);
    expect(a.filter((x) => x.role === 'double')).toHaveLength(1);
  });

  it('a blitzer beyond the line is picked up by the back who stays in', () => {
    const rb: Unit = { id: 5, x: 0.5, y: 25, kind: 'block' };
    const rs = [rusher(10, -3.8), rusher(11, -1), rusher(12, 1), rusher(13, 3.8), rusher(14, -2, 34), rusher(15, 6, 33)];
    const a = assignProtection([...line, rb], rs, qb, 0);
    expect(a.find((x) => x.blocker === 5)?.target).not.toBeNull();
    const blocked = new Set(a.map((x) => x.target));
    expect(rs.filter((r) => !blocked.has(r.id))).toHaveLength(0); // six rushers, six blockers
  });

  it('a back on a check route with nobody to pick up chips the edge, then releases', () => {
    const rb: Unit = { id: 5, x: 2.5, y: 25, kind: 'check' };
    const a = assignProtection([...line, rb], [rusher(10, -3.8), rusher(11, -1), rusher(12, 1), rusher(13, 3.8)], qb, 0);
    const chip = a.find((x) => x.blocker === 5)!;
    expect(chip.role).toBe('chip');
    expect(chip.target).toBe(13);
  });
});

describe('run blocking', () => {
  const line: Unit[] = [0, 1, 2, 3, 4].map((i) => ({ id: i, x: (i - 2) * 1.3, y: 29, kind: 'ol' }));
  const box: Unit[] = [
    { id: 10, x: -3.8, y: 31, kind: 'def', rushing: true }, { id: 11, x: -1, y: 31, kind: 'def', rushing: true },
    { id: 12, x: 1, y: 31, kind: 'def', rushing: true }, { id: 13, x: 3.8, y: 31, kind: 'def', rushing: true },
    { id: 14, x: -2.5, y: 34.5, kind: 'def', lb: true }, { id: 15, x: 2.5, y: 34.5, kind: 'def', lb: true },
  ];

  it('inside runs double the point of attack and climb to a linebacker', () => {
    const plan = planRunBlocks({ aim: 1.3, style: 'handoff', scheme: 'inside' }, 0, line, box);
    const dbl = plan.filter((p) => p.role === 'double');
    expect(dbl).toHaveLength(2);
    expect(dbl[0].target).toBe(12);
    const climber = dbl.find((p) => p.climbTo != null);
    expect(climber?.climbTo).toBe(15);
    // Every other lineman has a man.
    expect(plan.filter((p) => p.role === 'runBlock' && p.target === null)).toHaveLength(0);
  });

  it('zone runs drive everyone playside', () => {
    const plan = planRunBlocks({ aim: 6.5, style: 'handoff', scheme: 'zone' }, 0, line, box);
    expect(plan.every((p) => p.drive === 1)).toBe(true);
  });

  it('the carrier takes the lane the blocks open: design gap when it holds, cutback when it is clogged', () => {
    const run = { aim: 6.5, style: 'handoff' as const, scheme: 'zone' as const };
    const gaps = laneCandidates(run, 0);
    expect(gaps[0]).toBe(6.5);
    expect(gaps.length).toBe(1 + 2 * BLOCKING.run.zoneGaps);
    const held = pickLane(gaps, 30, [{ x: 5, y: 31, state: 'held' }, { x: 8, y: 31, state: 'held' }]);
    expect(held.x).toBe(6.5);
    const clogged = pickLane(gaps, 30, [{ x: 6.5, y: 31.2, state: 'free' }, { x: 9, y: 31, state: 'free' }]);
    expect(clogged.x).toBeLessThan(6.5);
  });
});

describe('matchups show in outcomes', () => {
  const home = getTeam('rheinstadt');
  const away = getTeam('elbtal');

  function holdBall(team: TeamData, seed: number) {
    const sim = new PlaySim({
      play: getPlay('deep_post'), defense: getDefenseCall('cover3'), offenseTeam: team, defenseTeam: away,
      ballX: 0, los: 30, difficulty: DIFFICULTY.normal, seed, penaltyBias: { off: 0, def: 0 },
    });
    let firstShed = Infinity;
    for (let i = 0; i < 60 * 8 && !sim.result; i++) {
      const inp = idleInput();
      if (sim.t < 0.8) inp.move = { x: 0, y: -1 };
      sim.step(inp);
      for (const e of sim.drainEvents()) if (e.type === 'shed') firstShed = Math.min(firstShed, e.t);
    }
    return { firstShed, sackT: sim.result?.outcome === 'sack' ? sim.result.duration : 8 };
  }

  it('a weak line gives up pressure early, a strong line holds', () => {
    let weakShed = 0;
    let strongShed = 0;
    let weakSack = 0;
    let strongSack = 0;
    const N = 16;
    for (let s = 0; s < N; s++) {
      const w = holdBall(withLine(home, 50), s);
      const st = holdBall(withLine(home, 95), s);
      weakShed += Math.min(w.firstShed, 8);
      strongShed += Math.min(st.firstShed, 8);
      weakSack += w.sackT;
      strongSack += st.sackT;
    }
    expect(weakShed / N).toBeLessThan(2.2);
    expect(strongShed / N).toBeGreaterThan(weakShed / N + 1.5);
    expect(strongSack).toBeGreaterThan(weakSack);
  });

  it('run blocking: a strong line opens bigger lanes than a weak one', () => {
    const yards = (team: TeamData) => {
      let y = 0;
      for (const play of ['hb_dive', 'hb_stretch', 'counter']) for (let s = 0; s < 12; s++) {
        const sim = new PlaySim({
          play: getPlay(play), defense: getDefenseCall(s % 2 ? 'cover3' : 'cover1'), offenseTeam: team, defenseTeam: away,
          ballX: 0, los: 30, difficulty: DIFFICULTY.normal, seed: 100 + s, penaltyBias: { off: 0, def: 0 },
        });
        for (let i = 0; i < 60 * 15 && !sim.result; i++) {
          const inp = idleInput();
          if (sim.canHandoff()) inp.handoff = true;
          sim.step(inp);
        }
        y += sim.result?.yards ?? 0;
      }
      return y / 36;
    };
    expect(yards(withLine(home, 95))).toBeGreaterThan(yards(withLine(home, 50)) + 1);
  });

  it('blocks expose role, grade and progress for the HUD and renderer', () => {
    const sim = new PlaySim({
      play: getPlay('deep_post'), defense: getDefenseCall('cover3'), offenseTeam: home, defenseTeam: away,
      ballX: 0, los: 30, difficulty: DIFFICULTY.normal, seed: 1, penaltyBias: { off: 0, def: 0 },
    });
    for (let i = 0; i < 40; i++) sim.step(idleInput());
    const st = sim.blockStates();
    expect(st.length).toBeGreaterThan(2);
    for (const b of st) {
      expect(['passSet', 'double', 'chip', 'runBlock']).toContain(b.role);
      expect(b.progress).toBeGreaterThanOrEqual(0);
      expect(b.progress).toBeLessThanOrEqual(1);
    }
  });
});
