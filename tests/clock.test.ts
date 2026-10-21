import { describe, expect, it } from 'vitest';
import {
  PLAY_CLOCK, callTimeoutClock, createClock, endPlayClock, formatClock, nextQuarter, snapClock, tickClock,
} from '../src/game/clock';
import { afterPlay, checkQuarter } from '../src/game/flow';
import { newGame } from '../src/game/state';

describe('clock', () => {
  it('starts stopped with a full play clock', () => {
    const c = createClock(300);
    expect(c.running).toBe(false);
    expect(c.playClock).toBe(PLAY_CLOCK);
    const t = tickClock(c, 10);
    expect(t.clock.remaining).toBe(300);
    expect(t.clock.playClock).toBe(30);
  });

  it('runs the game clock during a live play and freezes the play clock', () => {
    const c = snapClock(createClock(300));
    const t = tickClock(c, 6);
    expect(t.clock.remaining).toBe(294);
    expect(t.clock.playClock).toBe(PLAY_CLOCK);
  });

  it('stops after incompletions and out of bounds, keeps running after in-bounds tackles', () => {
    const live = snapClock(createClock(300));
    expect(endPlayClock(live, 'incomplete').running).toBe(false);
    expect(endPlayClock(live, 'outOfBounds').running).toBe(false);
    expect(endPlayClock(live, 'score').running).toBe(false);
    expect(endPlayClock(live, 'turnover').running).toBe(false);
    const after = endPlayClock(live, 'inbounds');
    expect(after.running).toBe(true);
    expect(after.playClock).toBe(PLAY_CLOCK);
    expect(after.playClockRunning).toBe(true);
    // Running clock keeps ticking between plays.
    expect(tickClock(after, 20).clock.remaining).toBe(280);
  });

  it('flags play clock expiry (delay of game)', () => {
    const t = tickClock(createClock(300), 41);
    expect(t.playClockExpired).toBe(true);
    expect(t.clock.playClock).toBe(0);
  });

  it('flags quarter expiry and never goes negative', () => {
    const t = tickClock(snapClock(createClock(5)), 7);
    expect(t.quarterExpired).toBe(true);
    expect(t.clock.remaining).toBe(0);
  });

  it('timeouts stop the clock and reset the play clock', () => {
    const c = callTimeoutClock({ ...endPlayClock(snapClock(createClock(300)), 'inbounds'), playClock: 12 });
    expect(c.running).toBe(false);
    expect(c.playClock).toBe(PLAY_CLOCK);
  });

  it('advances quarters, flips possession at half time and ends the game', () => {
    let g = newGame({ home: 'rheinstadt', away: 'elbtal', userSide: 'home', difficulty: 'normal', quarterLength: 60, seed: 1 });
    g = { ...g, clock: { ...g.clock, remaining: 0 } };
    let r = checkQuarter(g);
    expect(r.brk).toBe('quarter');
    expect(r.state.clock.quarter).toBe(2);
    expect(r.state.possession).toBe('home');

    r = checkQuarter({ ...r.state, clock: { ...r.state.clock, remaining: 0 } });
    expect(r.brk).toBe('halftime');
    expect(r.state.clock.quarter).toBe(3);
    expect(r.state.possession).toBe('away');
    expect(r.state.ballY).toBe(25);

    r = checkQuarter({ ...r.state, clock: { ...r.state.clock, quarter: 4, remaining: 0 } });
    expect(r.brk).toBe('gameover');
    expect(r.state.over).toBe(true);
  });

  it('a play that ends at 0:00 ends the quarter afterwards', () => {
    const g = newGame({ home: 'rheinstadt', away: 'elbtal', userSide: 'home', difficulty: 'normal', quarterLength: 60, seed: 1 });
    const live = { ...g, clock: tickClock(snapClock(g.clock), 61).clock };
    expect(live.clock.remaining).toBe(0);
    const r = afterPlay(live, 'inbounds');
    expect(r.brk).toBe('quarter');
    expect(r.state.clock.remaining).toBe(60);
    expect(r.state.clock.running).toBe(false);
  });

  it('formats clock time', () => {
    expect(formatClock(125)).toBe('2:05');
    expect(formatClock(0.2)).toBe('0:01');
    expect(formatClock(-3)).toBe('0:00');
    expect(nextQuarter(createClock(300)).quarter).toBe(2);
  });
});
