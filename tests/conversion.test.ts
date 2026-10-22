import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import { CONVERSION, chooseConversion, conversionOptions, quickConversion, startTwoPointTry } from '../src/game/conversion';
import { startOvertime } from '../src/game/overtime';
import { applyPlay } from '../src/game/rules';
import { newGame, type GameState } from '../src/game/state';
import { callTimeout, cpuWantsTimeout } from '../src/game/timeouts';
import { checkQuarter } from '../src/game/flow';
import { simulateCpuDrive } from '../src/game/cpuDrive';
import { DIFFICULTY } from '../src/data';

const base = (): GameState => ({ ...newGame({ home: 'rheinstadt', away: 'elbtal', userSide: 'home', difficulty: 'normal', quarterLength: 900, seed: 3 }), pendingKickoff: null });
/** Home just scored a touchdown (6 points already on the board). */
const afterTd = (home: number, away: number, quarter = 4): GameState =>
  ({ ...base(), score: { home, away }, possession: 'home', pendingConversion: 'home', clock: { ...base().clock, quarter, remaining: 300 } });

describe('conversion choice', () => {
  it('the user may kick or go for two; in 2OT+ only two', () => {
    expect(conversionOptions(afterTd(6, 0))).toEqual(['kick', 'two']);
    let ot = startOvertime({ ...base(), score: { home: 7, away: 7 } }, 'home');
    ot = { ...ot, overtime: { ...ot.overtime!, period: 2 } };
    expect(conversionOptions(ot)).toEqual(['two']);
    expect(chooseConversion(ot, 'away')).toBe('two');
  });

  it('the CPU kicks early, then follows the chart in the fourth quarter', () => {
    expect(chooseConversion(afterTd(12, 14, 2), 'home')).toBe('kick'); // trailing by 2 in Q2: kick
    expect(chooseConversion(afterTd(12, 14), 'home')).toBe('two'); // trailing by 2 late: tie it
    expect(chooseConversion(afterTd(15, 20), 'home')).toBe('two'); // trailing by 5
    expect(chooseConversion(afterTd(13, 12), 'home')).toBe('two'); // leading by 1
    expect(chooseConversion(afterTd(13, 10), 'home')).toBe('kick'); // leading by 3: kick for 4
    for (const t of CONVERSION.chart.goForTwoTrailing) expect(chooseConversion(afterTd(20, 20 + t), 'home')).toBe('two');
  });

  it('a two-point try is one play from the 3: a touchdown is good for 2, anything else fails', () => {
    const s = startTwoPointTry(afterTd(6, 0, 1));
    expect(s.ballY).toBe(100 - CONVERSION.spot);
    expect(s.conversionTry).toBe('two');
    const good = applyPlay(s, { outcome: 'touchdown', endY: 100, endX: 0 });
    expect(good.state.score.home).toBe(8);
    expect(good.state.pendingKickoff).toBe('home');
    expect(good.state.possession).toBe('away');
    const bad = applyPlay(s, { outcome: 'interception', endY: 99, endX: 0 });
    expect(bad.state.score).toEqual({ home: 6, away: 0 });
    expect(bad.state.conversionTry).toBeNull();
    expect(bad.state.pendingKickoff).toBe('home');
    // A false start replays the try.
    expect(applyPlay(s, { outcome: 'noPlay', endY: 97, endX: 0 }).state.conversionTry).toBe('two');
  });

  it('quick tries: kicks are near-automatic, two-pointers about a coin flip', () => {
    const rng = new Rng(9);
    let kicks = 0, twos = 0;
    for (let i = 0; i < 400; i++) {
      if (quickConversion(afterTd(6, 0, 1), 'kick', rng).scored) kicks++;
      if (quickConversion(afterTd(6, 0, 1), 'two', rng).scored) twos++;
    }
    expect(kicks / 400).toBeGreaterThan(0.9);
    expect(twos / 400).toBeGreaterThan(0.3);
    expect(twos / 400).toBeLessThan(0.6);
  });

  it('a try at 0:00 is still played before the quarter ends', () => {
    const s = { ...afterTd(6, 0, 2), clock: { ...base().clock, quarter: 2, remaining: 0 } };
    expect(checkQuarter(s).brk).toBe('none');
  });

  it('simulated CPU drives play the try right after a touchdown', () => {
    let tds = 0;
    for (let seed = 1; seed < 80 && tds < 3; seed++) {
      const g: GameState = { ...base(), possession: 'away', ballY: 80, down: 1, toGo: 10 };
      const sum = simulateCpuDrive(g, DIFFICULTY.normal, new Rng(seed));
      if (sum.state.score.away >= 6) {
        tds++;
        expect([6, 7, 8]).toContain(sum.state.score.away);
        expect(sum.state.pendingConversion).toBeNull();
        expect(sum.state.pendingKickoff).toBe('away');
      }
    }
    expect(tds).toBeGreaterThan(0);
  });
});

describe('timeouts', () => {
  it('three per half, each stops the clock; none left = no timeout', () => {
    let s: GameState | null = { ...base(), clock: { ...base().clock, running: true } };
    for (let i = 0; i < 3; i++) {
      s = callTimeout(s!, 'home');
      expect(s!.clock.running).toBe(false);
    }
    expect(s!.timeouts.home).toBe(0);
    expect(callTimeout(s!, 'home')).toBeNull();
  });

  it('the CPU offense uses them late in a half when it needs time', () => {
    const late = (q: number, rem: number, cpuScore: number): GameState =>
      ({ ...base(), possession: 'away', score: { home: 10, away: cpuScore }, clock: { ...base().clock, quarter: q, remaining: rem, running: true } });
    expect(cpuWantsTimeout(late(4, 90, 3), 'away')).toBe(true);
    expect(cpuWantsTimeout(late(4, 90, 17), 'away')).toBe(false); // leading: let it run
    expect(cpuWantsTimeout(late(3, 90, 3), 'away')).toBe(false);
    expect(cpuWantsTimeout(late(4, 400, 3), 'away')).toBe(false);
  });
});
