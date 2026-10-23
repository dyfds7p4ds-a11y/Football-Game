import { describe, expect, it } from 'vitest';
import BALANCE from '../src/data/balance.json';
import { DIFFICULTY, getPlay, getTeam } from '../src/data';
import type { TeamData } from '../src/data/types';
import { DEFENSE_CALLS, getDefenseCall } from '../src/play/defenseCalls';
import { PlaySim, idleInput } from '../src/play/sim';

const T = BALANCE.toss;
const cap = (v: number) => Math.min(99, v);
/** The defense with a stout front seven (DL and LB stronger, surer tacklers, quicker reads). */
const stout = (t: TeamData, add: number): TeamData => ({
  ...t, roster: t.roster.map((p) => p.position === 'DL' || p.position === 'LB' ? {
    ...p, ratings: { ...p.ratings, strength: cap(p.ratings.strength + add), tackling: cap(p.ratings.tackling + add), speed: cap(p.ratings.speed + add / 2), awareness: cap(p.ratings.awareness + add) },
  } : p),
});

function toss(def: string, seed: number, defense: TeamData): number {
  const sim = new PlaySim({
    play: getPlay('hb_toss'), defense: getDefenseCall(def), offenseTeam: getTeam('rheinstadt'), defenseTeam: defense,
    ballX: 0, los: 30, difficulty: DIFFICULTY.normal, seed, penaltyBias: { off: 0, def: 0 },
  });
  for (let i = 0; i < 60 * 30 && !sim.result; i++) sim.step(idleInput());
  return sim.result!.yards;
}

function stats(ys: number[]) {
  const avg = ys.reduce((a, b) => a + b, 0) / ys.length;
  const sd = Math.sqrt(ys.reduce((a, b) => a + (b - avg) ** 2, 0) / ys.length);
  return { avg, sd, tfl: ys.filter((y) => y < 0).length / ys.length, big: ys.filter((y) => y >= T.bigPlayYards).length / ys.length };
}

describe('Phase 3d: HB toss balance', () => {
  const all: number[] = [];
  for (const d of DEFENSE_CALLS) for (let s = 0; s < T.seedsPerDefense; s++) all.push(toss(d.id, s * 11 + 5, getTeam('elbtal')));
  const overall = stats(all);
  if (process.env.BALANCE_STATS) console.log('toss overall', overall);

  it('average yards per toss sit inside the corridor', () => {
    expect(overall.avg).toBeGreaterThanOrEqual(T.avgMin);
    expect(overall.avg).toBeLessThanOrEqual(T.avgMax);
  });

  it('realistic variance: tackles for loss and big plays both happen', () => {
    expect(overall.sd).toBeGreaterThanOrEqual(T.sdMin);
    expect(overall.sd).toBeLessThanOrEqual(T.sdMax);
    expect(overall.tfl).toBeGreaterThanOrEqual(T.tflMin);
    expect(overall.tfl).toBeLessThanOrEqual(T.tflMax);
    expect(overall.big).toBeGreaterThanOrEqual(T.bigPlayMin);
  });

  it('good blitzes and a stout front seven produce tackles for loss', () => {
    const ys: number[] = [];
    for (const d of ['cover1blitz', 'cover0', 'firezone']) for (let s = 0; s < T.seedsPerDefense; s++) ys.push(toss(d, s * 11 + 5, stout(getTeam('elbtal'), T.stoutFront)));
    const st = stats(ys);
    if (process.env.BALANCE_STATS) console.log('toss vs blitz + stout front', st);
    expect(st.tfl).toBeGreaterThanOrEqual(T.stoutBlitzTflMin);
    expect(st.avg).toBeLessThan(overall.avg);
  });
});
