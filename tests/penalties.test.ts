import { describe, expect, it } from 'vitest';
import { v2 } from '../src/core/vec';
import { newGame } from '../src/game/state';
import { enforcePenalties, penaltyState } from '../src/game/penalties';
import { callFoul, makeFoul, flagPosition, PENALTIES } from '../src/play/penalties';
import { DIFFICULTY } from '../src/data';
import { homeSpot, setupOfficials, updateOfficials } from '../src/play/officials';
import { runPlay } from './simHarness';

const game = (ballY = 40, down = 1, toGo = 10) => ({
  ...newGame({ home: 'rheinstadt', away: 'elbtal', userSide: 'home', difficulty: 'normal', quarterLength: 300, seed: 1 }),
  ballY, down, toGo,
});

describe('penalty enforcement', () => {
  it('offensive holding: 10 yards from the previous spot, replay the down', () => {
    const s = penaltyState(game(40, 2, 6), makeFoul('holdingOffense', v2(0, 39), 1));
    expect(s.ballY).toBe(30);
    expect(s.down).toBe(2);
    expect(s.toGo).toBe(16);
  });

  it('half the distance to the goal when the yardage would cross it', () => {
    expect(penaltyState(game(6), makeFoul('holdingOffense', v2(0, 5), 1)).ballY).toBe(3);
    expect(penaltyState(game(95, 1, 5), makeFoul('roughingPasser', v2(0, 90), 1)).ballY).toBe(97.5);
  });

  it('pass interference is a spot foul with an automatic first down', () => {
    const s = penaltyState(game(40, 3, 8), makeFoul('passInterference', v2(-10, 72), 2));
    expect(s.ballY).toBe(72);
    expect(s.down).toBe(1);
  });

  it('the offended team takes the better of play and penalty', () => {
    const s = game(40, 2, 10);
    // Defensive holding on a 30-yard completion: offense declines.
    const big = enforcePenalties(s, { outcome: 'tackle', endY: 70, endX: 0 }, [makeFoul('holdingDefense', v2(0, 45), 1)]);
    expect(big.declined?.type).toBe('holdingDefense');
    expect(big.result.state.ballY).toBe(70);
    // ...but accepts it on an incompletion (5 yards and an automatic first down).
    const inc = enforcePenalties(s, { outcome: 'incomplete', endY: 40, endX: 0 }, [makeFoul('holdingDefense', v2(0, 45), 1)]);
    expect(inc.enforced?.type).toBe('holdingDefense');
    expect(inc.result.state.down).toBe(1);
    // Offensive holding on a big gain: defense accepts and takes the yards away.
    const off = enforcePenalties(s, { outcome: 'tackle', endY: 60, endX: 0 }, [makeFoul('holdingOffense', v2(0, 39), 1)]);
    expect(off.enforced?.type).toBe('holdingOffense');
    expect(off.result.state.ballY).toBe(30);
  });

  it('a touchdown stands over a defensive foul', () => {
    const s = game(80, 1, 10);
    const td = enforcePenalties(s, { outcome: 'touchdown', endY: 100, endX: 0 }, [makeFoul('holdingDefense', v2(0, 85), 1)]);
    expect(td.result.scored?.points).toBe(7);
  });

  it('declined penalty: down and distance come from the play', () => {
    // 3rd and 4 at the 40, defensive holding on a 12-yard gain: decline, first down at the 52.
    const r = enforcePenalties(game(40, 3, 4), { outcome: 'tackle', endY: 52, endX: 0 }, [makeFoul('holdingDefense', v2(0, 44), 1)]);
    expect(r.declined?.type).toBe('holdingDefense');
    expect(r.result.state.ballY).toBe(52);
    expect(r.result.state.down).toBe(1);
    expect(r.result.state.toGo).toBe(10);
    // 3rd and 5, offensive holding on an 8-yard loss: defense declines, 4th and 13.
    const d = enforcePenalties(game(40, 3, 5), { outcome: 'tackle', endY: 32, endX: 0 }, [makeFoul('holdingOffense', v2(0, 38), 1)]);
    expect(d.declined?.type).toBe('holdingOffense');
    expect(d.result.state.down).toBe(4);
    expect(d.result.state.toGo).toBe(13);
  });

  it('accepted penalty: offside covering the line to gain is a first down', () => {
    // Offside 5 yards covers the 2 to go: first down.
    const r = enforcePenalties(game(40, 3, 2), { outcome: 'incomplete', endY: 40, endX: 0 }, [makeFoul('offside', v2(0, 41), 0)]);
    expect(r.enforced?.type).toBe('offside');
    expect(r.result.state.ballY).toBe(45);
    expect(r.result.state.down).toBe(1);
    expect(r.result.state.toGo).toBe(10);
  });
});

describe('one flag per play', () => {
  it('callFoul keeps the more severe foul; a tie keeps the first', () => {
    const hold = makeFoul('holdingOffense', v2(0, 29), 1);
    const dpi = makeFoul('passInterference', v2(5, 50), 2);
    const off = makeFoul('offside', v2(0, 31), 0);
    expect(callFoul(null, hold)).toBe(hold);
    expect(callFoul(hold, dpi)).toBe(dpi);
    expect(callFoul(dpi, hold)).toBe(dpi);
    expect(callFoul(hold, off)).toBe(hold);
    const hold2 = makeFoul('holdingDefense', v2(0, 35), 2);
    expect(callFoul(hold, hold2)).toBe(hold);
  });

  it('several fouls reaching enforcement: only the most severe is enforced, no offsetting', () => {
    const s = game(40, 2, 10);
    const r = enforcePenalties(s, { outcome: 'incomplete', endY: 40, endX: 0 },
      [makeFoul('holdingOffense', v2(0, 39), 1), makeFoul('passInterference', v2(-8, 62), 2)]);
    expect(r.offsetting).toBe(false);
    expect(r.enforced?.type).toBe('passInterference');
    expect(r.result.state.ballY).toBe(62);
    expect(r.result.state.down).toBe(1);
  });

  it('a play never has more than one flag or foul, even at very high foul rates', () => {
    let multiCandidates = 0;
    for (let s = 0; s < 60; s++) {
      const r = runPlay('four_verts', s % 2 ? 'cover1' : 'cover0', s, { throwAt: 2.2, target: 'WR1', dropFor: 0.6, penalties: 400 });
      expect(r.sim.flags.length).toBeLessThanOrEqual(1);
      expect(r.result!.fouls.length).toBeLessThanOrEqual(1);
      expect(r.events.filter((e) => e.type === 'flag').length).toBeLessThanOrEqual(1);
      if (r.sim.flags.length) {
        expect(r.sim.flags[0].foul).toBe(r.result!.fouls[0]);
        multiCandidates++;
      }
    }
    expect(multiCandidates).toBeGreaterThan(10);
  });

  it('difficulty penaltyRate keeps flags rare and scales them', () => {
    expect(DIFFICULTY.easy.penaltyRate).toBeLessThanOrEqual(DIFFICULTY.normal.penaltyRate);
    expect(DIFFICULTY.normal.penaltyRate).toBeLessThanOrEqual(DIFFICULTY.hard.penaltyRate);
    let flagged = 0, n = 0;
    for (const p of ['four_verts', 'slants', 'mesh', 'hb_dive']) for (let s = 0; s < 30; s++) {
      n++;
      if (runPlay(p, 'cover1', s, { throwAt: 2.2, target: 'WR1', dropFor: 0.6, penalties: 1 }).sim.flags.length) flagged++;
    }
    expect(flagged / n).toBeLessThan(0.12);
  });

  it('a false start is a dead-ball foul: no play, 5 yards back', () => {
    const r = enforcePenalties(game(40, 3, 2), { outcome: 'noPlay', endY: 40, endX: 0 }, [makeFoul('falseStart', v2(0, 39), 0)]);
    expect(r.result.state.ballY).toBe(35);
    expect(r.result.state.down).toBe(3);
    expect(r.result.state.toGo).toBe(7);
  });
});

describe('flags in a play', () => {
  it('fouls throw a flag that arcs from the nearest official to the spot and stays there', () => {
    let flagged = 0;
    for (let s = 0; s < 40 && flagged < 5; s++) {
      const r = runPlay('four_verts', 'cover1', s, { throwAt: 2.0, target: 'WR1', dropFor: 0.6, penalties: 15 });
      if (r.sim.flags.length === 0) continue;
      flagged++;
      const f = r.sim.flags[0];
      expect(r.events.some((e) => e.type === 'flag')).toBe(true);
      const mid = flagPosition(f, f.t0 + f.T / 2)!;
      expect(mid.h).toBeGreaterThan(2);
      const end = flagPosition(f, f.t0 + f.T + 5)!;
      expect(end.landed).toBe(true);
      expect(Math.hypot(end.x - f.foul.spot.x, end.y - f.foul.spot.y)).toBeLessThan(1e-6);
      expect(r.result!.fouls.length).toBeGreaterThan(0);
    }
    expect(flagged).toBeGreaterThan(0);
  });

  it('a false start kills the play at the snap', () => {
    let seen = false;
    for (let s = 0; s < 200 && !seen; s++) {
      const r = runPlay('slants', 'cover3', s, { throwAt: 1, target: 'WR1', penalties: 20 });
      if (r.result!.outcome === 'noPlay') {
        seen = true;
        expect(r.result!.fouls[0].type).toBe('falseStart');
        expect(r.result!.duration).toBe(0);
      }
    }
    expect(seen).toBe(true);
  });

  it('penalties off means no flags', () => {
    for (let s = 0; s < 10; s++) expect(runPlay('mesh', 'cover1', s, { throwAt: 1.5, target: 'WR3' }).sim.flags.length).toBe(0);
  });

  it('flag timing comes from data', () => {
    expect(PENALTIES.flag.flightTime).toBeGreaterThan(0.3);
  });
});

describe('officials', () => {
  it('line up behind the line of scrimmage and on the sidelines', () => {
    const offs = setupOfficials(30, 0);
    const r = offs.find((o) => o.role === 'R')!;
    const u = offs.find((o) => o.role === 'U')!;
    expect(r.pos.y).toBeLessThan(30);
    expect(u.pos.y).toBeLessThan(30);
    expect(Math.abs(offs.find((o) => o.role === 'H')!.pos.y - 30)).toBeLessThan(0.01);
    expect(homeSpot('B', 30, 0).y).toBeGreaterThan(40);
  });

  it('move with the play and keep clear of the players', () => {
    const offs = setupOfficials(30, 0);
    const players = [v2(5, 55)];
    for (let i = 0; i < 300; i++) updateOfficials(offs, { los: 30, ballX: 0, ball: v2(5, 55), carrier: v2(5, 55), players, dead: false }, 1 / 60);
    const h = offs.find((o) => o.role === 'H')!;
    expect(h.pos.y).toBeGreaterThan(45); // wing official runs down the sideline with the carrier
    for (const o of offs) expect(Math.hypot(o.pos.x - 5, o.pos.y - 55)).toBeGreaterThan(1.5);
  });
});
