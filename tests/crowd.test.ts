import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import { DIFFICULTY } from '../src/data';
import { simulateCpuDrive } from '../src/game/cpuDrive';
import { newGame } from '../src/game/state';
import { CROWD, crowdEdge, crowdEvents, crowdIntensity, updateCrowd, type PlayForCrowd } from '../src/game/crowd';

const play = (p: Partial<PlayForCrowd>): PlayForCrowd => ({
  homeOffense: true, yards: 4, firstDown: false, score: null, turnover: false, sack: false,
  penaltyOnHome: null, failedFourthDown: false, ...p,
});

describe('crowd meter', () => {
  it('rises after big plays, takeaways and scores', () => {
    expect(updateCrowd(50, play({ yards: 35 }))).toBeGreaterThan(50);
    expect(updateCrowd(50, play({ homeOffense: false, turnover: true }))).toBeGreaterThan(55);
    expect(updateCrowd(50, play({ score: { home: true, points: 7 } }))).toBeGreaterThan(60);
  });

  it('drops after penalties, turnovers and failed fourth downs', () => {
    expect(updateCrowd(50, play({ penaltyOnHome: true }))).toBeLessThan(50);
    expect(updateCrowd(50, play({ turnover: true }))).toBeLessThan(45);
    expect(updateCrowd(50, play({ failedFourthDown: true }))).toBeLessThan(45);
    expect(updateCrowd(50, play({ homeOffense: false, score: { home: false, points: 7 } }))).toBeLessThan(50);
  });

  it('a penalty on the visitors does not hurt the home crowd', () => {
    expect(crowdEvents(play({ penaltyOnHome: false }))).not.toContain('penaltyAgainst');
  });

  it('stays between 0 and 100 and drifts back toward the baseline', () => {
    let v = 50;
    for (let i = 0; i < 30; i++) v = updateCrowd(v, play({ score: { home: true, points: 7 }, yards: 60 }));
    expect(v).toBe(100);
    for (let i = 0; i < 30; i++) v = updateCrowd(v, play({ turnover: true, penaltyOnHome: true }));
    expect(v).toBe(0);
    for (let i = 0; i < 80; i++) v = updateCrowd(v, play({}));
    expect(Math.abs(v - CROWD.baseline)).toBeLessThan(2);
  });

  it('gives a small, bounded home edge only at high values and only when enabled', () => {
    expect(crowdEdge(40, true)).toEqual({ homePressure: 1, homePenalty: 1, awayPenalty: 1 });
    const loud = crowdEdge(100, true);
    expect(loud.homePressure).toBeGreaterThan(1);
    expect(loud.homePressure).toBeLessThanOrEqual(1 + CROWD.edge.maxPressure);
    expect(loud.awayPenalty).toBeGreaterThan(1);
    expect(loud.awayPenalty).toBeLessThanOrEqual(1 + CROWD.edge.maxPenalty);
    expect(loud.homePenalty).toBeLessThan(1);
    expect(crowdEdge(100, false)).toEqual({ homePressure: 1, homePenalty: 1, awayPenalty: 1 });
    expect(crowdIntensity(CROWD.edge.threshold)).toBe(0);
    expect(crowdIntensity(100)).toBe(1);
  });
});

describe('crowd in simulated CPU drives', () => {
  const start = (crowd: number) => ({
    ...newGame({ home: 'rheinstadt', away: 'elbtal', userSide: 'home', difficulty: 'normal', quarterLength: 900, seed: 1 }),
    possession: 'away' as const, ballY: 25, pendingKickoff: null, crowd,
  });
  const count = (crowd: number, crowdEffect: boolean) => {
    let falseStarts = 0;
    let sacks = 0;
    for (let i = 0; i < 150; i++) {
      const d = simulateCpuDrive(start(crowd), DIFFICULTY.normal, new Rng(i), { crowdEffect, penalties: 1 });
      falseStarts += d.entries.filter((e) => e.text.startsWith('False start')).length;
      sacks += d.entries.filter((e) => e.text.startsWith('Sacked')).length;
    }
    return { falseStarts, sacks };
  };

  it('a rocking home crowd makes the visitors jump early more often (only when the setting is on)', () => {
    const loud = count(100, true);
    const off = count(100, false);
    expect(loud.falseStarts).toBeGreaterThan(off.falseStarts);
    expect(loud.sacks).toBeGreaterThanOrEqual(off.sacks);
  });

  it('the meter moves during CPU drives', () => {
    const d = simulateCpuDrive(start(50), DIFFICULTY.normal, new Rng(3), { crowdEffect: true });
    expect(d.state.crowd).not.toBe(50);
  });

  it('interactive punts stop the drive at the punt', () => {
    let stopped = 0;
    for (let i = 0; i < 40; i++) {
      const d = simulateCpuDrive({ ...start(50), ballY: 10 }, DIFFICULTY.hard, new Rng(i), { interactivePunts: true });
      if (d.pendingPunt) {
        stopped++;
        expect(d.state.down).toBe(4);
        expect(d.state.possession).toBe('away');
      }
    }
    expect(stopped).toBeGreaterThan(0);
  });
});
