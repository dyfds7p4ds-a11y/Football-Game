import { describe, expect, it } from 'vitest';
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
