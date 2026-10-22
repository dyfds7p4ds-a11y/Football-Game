import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import { v2 } from '../src/core/vec';
import { getTeam } from '../src/data';
import {
  ST, cpuRelease, fgPowerNeeded, judgeFieldGoal, kickFlight, kickZone, meterAngle, meterPower, releaseKick, zoneQuality,
} from '../src/play/kicking';
import { ReturnSim } from '../src/play/returnSim';
import { SIM_DT } from '../src/play/sim';
import { applyFieldGoal, applyReturn } from '../src/game/specialTeams';
import { newGame } from '../src/game/state';

const heldFor = (power: number) => power * ST.meter.fillTime;

describe('kick meter', () => {
  it('fills, then falls back if you hold too long', () => {
    expect(meterPower(0)).toBe(0);
    expect(meterPower(ST.meter.fillTime)).toBeCloseTo(1);
    expect(meterPower(ST.meter.fillTime * 1.5)).toBeCloseTo(0.5);
  });

  it('the punt angle needle sweeps between its limits', () => {
    for (let t = 0; t < 3; t += 0.05) {
      const a = meterAngle(t);
      expect(a).toBeGreaterThanOrEqual(ST.meter.punt.angleMin - 1e-9);
      expect(a).toBeLessThanOrEqual(ST.meter.punt.angleMax + 1e-9);
    }
  });

  it('timing windows shrink with difficulty', () => {
    for (const k of ['punt', 'fieldGoal', 'kickoff'] as const) {
      expect(kickZone(k, 1.4).halfWidth).toBeGreaterThan(kickZone(k, 1).halfWidth);
      expect(kickZone(k, 1).halfWidth).toBeGreaterThan(kickZone(k, 0.7).halfWidth);
    }
  });

  it('a release inside the zone is good, outside it falls off', () => {
    const z = kickZone('kickoff', 1);
    expect(zoneQuality(z.center, z)).toBe(1);
    expect(zoneQuality(z.center + z.halfWidth, z)).toBeCloseTo(0.75);
    expect(zoneQuality(z.center - 3 * z.halfWidth, z)).toBeLessThan(0.1);
    expect(releaseKick('kickoff', heldFor(z.center), 1).inZone).toBe(true);
    expect(releaseKick('kickoff', heldFor(z.center - 2 * z.halfWidth), 1).inZone).toBe(false);
  });

  it('the field goal zone moves with the distance', () => {
    expect(kickZone('fieldGoal', 1, 50).center).toBeGreaterThan(kickZone('fieldGoal', 1, 25).center);
    expect(fgPowerNeeded(60)).toBeGreaterThan(fgPowerNeeded(30));
  });
});

describe('kick results', () => {
  const fg = (distance: number, power: number, seed = 1) => {
    // Kick spot so that the posts (y = 110) are `distance` yards away.
    const spot = v2(0, 110 - distance);
    const rel = { ...releaseKick('fieldGoal', heldFor(power), 1, distance), power };
    return judgeFieldGoal(kickFlight(rel, spot, 0, new Rng(seed)));
  };

  it('a well-timed field goal is good, a short-armed one falls short', () => {
    for (const d of [25, 40, 50]) expect(fg(d, kickZone('fieldGoal', 1, d).center).good, `${d}`).toBe(true);
    expect(fg(50, 0.4).good).toBe(false);
    expect(fg(50, 0.4).reason).toBe('short');
  });

  it('nobody makes a 75-yarder', () => {
    expect(fg(75, 1).good).toBe(false);
  });

  it('mistimed kicks go wide more often', () => {
    let wideGood = 0;
    let wideBad = 0;
    const z = kickZone('fieldGoal', 1, 45);
    for (let s = 0; s < 60; s++) {
      if (fg(45, z.center, s).reason === 'wide') wideGood++;
      if (fg(45, z.center + 2.5 * z.halfWidth, s).reason === 'wide') wideBad++;
    }
    expect(wideBad).toBeGreaterThan(wideGood);
  });

  it('a perfect kickoff from the 35 carries into the end zone (touchback)', () => {
    const z = kickZone('kickoff', 1);
    const f = kickFlight(releaseKick('kickoff', heldFor(z.center), 1), v2(0, ST.rules.kickoffSpot), 0, new Rng(3));
    expect(f.landing.y).toBeGreaterThan(100);
    const short = kickFlight(releaseKick('kickoff', heldFor(0.55), 1), v2(0, ST.rules.kickoffSpot), 0, new Rng(3));
    expect(short.landing.y).toBeLessThan(100);
  });

  it('a well-timed punt travels 40+ yards with real hang time', () => {
    const z = kickZone('punt', 1);
    // Hold until the needle is near the ideal angle and the power in the zone.
    let best = { q: 0, held: 0 };
    for (let t = 0; t < ST.meter.fillTime * 2; t += 0.005) {
      const r = releaseKick('punt', t, 1);
      if (r.quality > best.q) best = { q: r.quality, held: t };
    }
    const rel = releaseKick('punt', best.held, 1);
    expect(rel.quality).toBeGreaterThan(0.6);
    const f = kickFlight(rel, v2(0, 20), 0, new Rng(1));
    expect(f.landing.y - 20).toBeGreaterThan(38);
    expect(f.hang).toBeGreaterThan(2.8);
    expect(z.halfWidth).toBeGreaterThan(0);
  });

  it('CPU kickers are tighter on Hard than on Easy', () => {
    const spread = (sigma: number) => {
      const rng = new Rng(5);
      let q = 0;
      for (let i = 0; i < 200; i++) q += cpuRelease('kickoff', 1, sigma, rng).quality;
      return q / 200;
    };
    expect(spread(ST.cpu.timingSigma.hard)).toBeGreaterThan(spread(ST.cpu.timingSigma.easy));
  });
});

describe('returns', () => {
  const run = (kind: 'kickoff' | 'punt', power: number, seed: number, user?: (sim: ReturnSim) => { move: { x: number; y: number }; dash: boolean }) => {
    const from = kind === 'kickoff' ? v2(0, ST.rules.kickoffSpot) : v2(0, 30 - ST.rules.puntSnapBack);
    const rel = kind === 'kickoff' ? { ...releaseKick('kickoff', heldFor(power), 1), power } : releaseKick('punt', heldFor(power), 1);
    const flight = kickFlight(rel, from, 0, new Rng(seed));
    const sim = new ReturnSim({
      kind, flight, kickingTeam: getTeam('elbtal'), receivingTeam: getTeam('rheinstadt'), userReturns: !!user, tackling: 1, seed,
    });
    let anim = false;
    for (let i = 0; i < 60 * 25 && !sim.result; i++) {
      sim.step(user ? user(sim) : { move: { x: 0, y: 0 }, dash: false }, SIM_DT);
      if (sim.actors.some((a) => a.anim)) anim = true;
    }
    return { sim, res: sim.result!, anim };
  };

  it('a returnable kickoff is caught and returned, and ends on a tackle with a contact animation', () => {
    let returned = 0;
    let tackles = 0;
    let anims = 0;
    for (let s = 1; s <= 12; s++) {
      const { res, anim } = run('kickoff', 0.6, s);
      expect(res).not.toBeNull();
      if (res.outcome === 'tackle' || res.outcome === 'outOfBounds' || res.outcome === 'touchdown') returned++;
      if (res.outcome === 'tackle') tackles++;
      if (anim) anims++;
    }
    expect(returned).toBeGreaterThan(8);
    expect(tackles).toBeGreaterThan(4);
    expect(anims).toBeGreaterThan(4);
  });

  it('a deep kickoff into the end zone is a touchback', () => {
    const { res } = run('kickoff', kickZone('kickoff', 1).center, 2);
    expect(res.outcome).toBe('touchback');
  });

  it('the user steers the returner and can dash', () => {
    let dashed = false;
    const { sim, res } = run('kickoff', 0.6, 4, (s) => {
      const dash = !!s.carrier && !dashed;
      if (dash) dashed = true;
      return { move: { x: 0.3, y: 1 }, dash };
    });
    expect(dashed).toBe(true);
    expect(sim.dashCooldown).toBeGreaterThanOrEqual(0);
    expect(res.yards).toBeGreaterThan(0);
  });

  it('punt returns work the same way', () => {
    let done = 0;
    for (let s = 1; s <= 8; s++) if (run('punt', 0.85, s).res) done++;
    expect(done).toBe(8);
  });
});

describe('special-teams rules', () => {
  const g = () => newGame({ home: 'rheinstadt', away: 'elbtal', userSide: 'home', difficulty: 'normal', quarterLength: 300, seed: 1 });

  it('the game starts with the CPU kicking off to the user', () => {
    expect(g().pendingKickoff).toBe('away');
  });

  it('touchbacks: 25 after a kickoff, 20 after a punt', () => {
    expect(applyReturn(g(), 'away', 'kickoff', 'touchback', 0).state.ballY).toBe(ST.rules.touchback);
    expect(applyReturn(g(), 'away', 'punt', 'touchback', 0).state.ballY).toBe(ST.rules.puntTouchback);
  });

  it('a return touchdown scores and the returning team kicks off next', () => {
    const r = applyReturn(g(), 'away', 'kickoff', 'touchdown', 100);
    expect(r.state.score.home).toBe(7);
    expect(r.state.pendingKickoff).toBe('home');
    expect(r.state.possession).toBe('away');
  });

  it('the receiving team takes over where the return ends', () => {
    const r = applyReturn(g(), 'away', 'punt', 'tackle', 31);
    expect(r.state.possession).toBe('home');
    expect(r.state.ballY).toBe(31);
    expect(r.state.pendingKickoff).toBeNull();
  });

  it('a made field goal scores 3 and sets up a kickoff by the kicking team', () => {
    const s = { ...g(), ballY: 70, possession: 'home' as const, pendingKickoff: null };
    const r = applyFieldGoal(s, true, 47);
    expect(r.state.score.home).toBe(3);
    expect(r.state.pendingKickoff).toBe('home');
    const miss = applyFieldGoal(s, false, 47);
    expect(miss.state.possession).toBe('away');
    expect(miss.state.ballY).toBe(37);
  });
});
