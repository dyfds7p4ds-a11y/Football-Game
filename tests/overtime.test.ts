import { describe, expect, it } from 'vitest';
import { checkQuarter } from '../src/game/flow';
import { OT, endOvertimePossession, isShootout, mustGoForTwo, overtimeLabel, startOvertime } from '../src/game/overtime';
import { applyPlay, attemptFieldGoal, finishTry } from '../src/game/rules';
import { applyFieldGoal } from '../src/game/specialTeams';
import { newGame, type GameState } from '../src/game/state';
import { Rng } from '../src/core/rng';

const tied = (): GameState => {
  const g = newGame({ home: 'rheinstadt', away: 'elbtal', userSide: 'home', difficulty: 'normal', quarterLength: 60, seed: 2 });
  return { ...g, score: { home: 14, away: 14 }, pendingKickoff: null, clock: { ...g.clock, quarter: 4, remaining: 0 } };
};
const td = (s: GameState) => applyPlay(s, { outcome: 'touchdown', endY: 100, endX: 0 }).state;
const stop = (s: GameState) => applyPlay({ ...s, down: 4, toGo: 10 }, { outcome: 'incomplete', endY: s.ballY, endX: 0 }).state;

describe('overtime sequence (college rules)', () => {
  it('a tie after regulation goes to overtime: toss winner defers, ball at the 25, no kickoff, untimed, 1 timeout each', () => {
    const r = checkQuarter(tied());
    expect(r.brk).toBe('overtime');
    const s = r.state;
    expect(s.overtime).toEqual({ period: 1, first: 'away', done: 0 }); // seed 2: home wins the toss and defers
    expect(s.possession).toBe('away');
    expect(s.ballY).toBe(100 - OT.startYard);
    expect(s.down).toBe(1);
    expect(s.pendingKickoff).toBeNull();
    expect(s.timeouts).toEqual({ home: 1, away: 1 });
    expect(overtimeLabel(s)).toBe('OT');
    // Untimed: no quarter break can end it.
    expect(checkQuarter(s).brk).toBe('none');
  });

  it('both teams get a possession; a stop after a field goal wins it', () => {
    let s = startOvertime(tied(), 'home');
    s = attemptFieldGoalGood(s);
    expect(s.score.away).toBe(17);
    expect(s.possession).toBe('home');
    expect(s.over).toBe(false);
    s = stop(s);
    expect(s.over).toBe(true);
    expect(checkQuarter(s).brk).toBe('gameover');
  });

  it('matching scores go to the next period with the other team first; teams alternate', () => {
    let s = startOvertime(tied(), 'home');
    expect(s.overtime!.first).toBe('away');
    s = finishTry(td(s), 'kick', true).state; // away 21
    s = finishTry(td(s), 'kick', true).state; // home 21
    expect(s.over).toBe(false);
    expect(s.overtime).toEqual({ period: 2, first: 'home', done: 0 });
    expect(s.possession).toBe('home');
    expect(s.timeouts).toEqual({ home: 1, away: 1 });
    expect(overtimeLabel(s)).toBe('2OT');
  });

  it('from the second period a touchdown must be followed by a two-point try', () => {
    let s = startOvertime(tied(), 'home');
    expect(mustGoForTwo(s)).toBe(false);
    s = stop(stop(s)); // both fail in period 1
    expect(s.overtime!.period).toBe(2);
    expect(mustGoForTwo(s)).toBe(true);
  });

  it('from the third period each possession is one two-point play', () => {
    let s = startOvertime(tied(), 'home');
    for (let i = 0; i < 4; i++) s = stop(s);
    expect(s.overtime!.period).toBe(3);
    expect(isShootout(s)).toBe(true);
    expect(s.conversionTry).toBe('two');
    expect(s.ballY).toBe(97);
    const first = s.possession;
    s = applyPlay(s, { outcome: 'touchdown', endY: 100, endX: 0 }).state; // good: +2
    expect(s.score[first]).toBe(16);
    expect(s.possession).not.toBe(first);
    expect(s.conversionTry).toBe('two');
    s = applyPlay(s, { outcome: 'tackle', endY: 98, endX: 0 }).state; // fails
    expect(s.over).toBe(true);
  });

  it('a defensive touchdown ends it; a winning touchdown on the second possession needs no try', () => {
    let s = startOvertime(tied(), 'home');
    s = applyPlay(s, { outcome: 'interception', endY: 0, endX: 0 }).state; // pick six by home
    expect(s.over).toBe(true);
    expect(s.score.home).toBe(20);

    s = startOvertime(tied(), 'home');
    s = attemptFieldGoalGood(s); // away 17
    const r = applyPlay(s, { outcome: 'touchdown', endY: 100, endX: 0 });
    expect(r.state.score.home).toBe(20);
    expect(r.state.pendingConversion).toBeNull();
    expect(r.state.over).toBe(true);
  });

  it('a played field goal in overtime ends the possession too', () => {
    const s = startOvertime(tied(), 'home');
    const r = applyFieldGoal(s, false, 42);
    expect(r.state.possession).toBe('home');
    expect(r.state.ballY).toBe(100 - OT.startYard);
    expect(endOvertimePossession(r.state, true).over).toBe(true);
  });
});

function attemptFieldGoalGood(s: GameState): GameState {
  // Retry seeds until the instant field goal is good (deterministic).
  for (let seed = 1; seed < 50; seed++) {
    const r = attemptFieldGoal(s, new Rng(seed));
    if (r.good) return r.state;
  }
  throw new Error('no good field goal');
}
