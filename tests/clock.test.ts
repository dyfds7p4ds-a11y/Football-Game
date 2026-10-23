import { describe, expect, it } from 'vitest';
import {
  PACE, PLAY_CLOCK, callTimeoutClock, pacedSnap, paceRunoff, stopsClock, warningAt, createClock, endPlayClock, formatClock, nextQuarter, snapClock, tickClock,
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

  it('stops after incompletions, keeps running after in-bounds tackles (out of bounds early in a half: NFL restart)', () => {
    const live = snapClock(createClock(300));
    expect(endPlayClock(live, 'incomplete').running).toBe(false);
    expect(endPlayClock(live, 'outOfBounds').running).toBe(true);
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

    // Phase 3b: a tie goes to overtime, so give the home team the lead.
    r = checkQuarter({ ...r.state, score: { home: 3, away: 0 }, clock: { ...r.state.clock, quarter: 4, remaining: 0 } });
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

describe('Phase 3c: NFL clock rules and snap timing', () => {
  const at = (quarter: number, remaining: number, quarterLength = 900) => ({ ...snapClock(createClock(quarterLength)), quarter, remaining });

  it('first downs and in-bounds plays keep it running; incompletions, scores, turnovers, possession changes, timeouts stop it', () => {
    const c = at(1, 600);
    expect(stopsClock('inbounds', c)).toBe(false);
    for (const r of ['incomplete', 'score', 'turnover', 'possession', 'timeout'] as const) expect(stopsClock(r, c)).toBe(true);
  });

  it('out of bounds and penalties stop the clock only late in a half', () => {
    expect(stopsClock('outOfBounds', at(1, 100))).toBe(false);
    expect(stopsClock('outOfBounds', at(2, 300))).toBe(false);
    expect(stopsClock('outOfBounds', at(2, PACE.lateStop.q2 - 1))).toBe(true);
    expect(stopsClock('outOfBounds', at(4, PACE.lateStop.q4 + 1))).toBe(false);
    expect(stopsClock('penalty', at(4, PACE.lateStop.q4 - 1))).toBe(true);
    expect(stopsClock('outOfBounds', at(3, 30))).toBe(false);
    // Short quarters scale the late windows.
    expect(stopsClock('outOfBounds', at(4, 150, 300))).toBe(false);
    expect(stopsClock('outOfBounds', at(4, 90, 300))).toBe(true);
  });

  it('two-minute warning: stops between plays at the warning, or after the play that crosses it', () => {
    const between = endPlayClock(at(2, 125), 'inbounds');
    const t = tickClock(between, 10).clock;
    expect(t.remaining).toBe(PACE.warningAt);
    expect(t.running).toBe(false);
    expect(t.warned).toBe(true);
    // During a live play it runs on; the play's end stops it.
    const live = tickClock(at(4, 123), 6).clock;
    expect(live.remaining).toBe(117);
    expect(endPlayClock(live, 'inbounds').running).toBe(false);
    // Only once per quarter, and not in Q1 / Q3.
    expect(endPlayClock({ ...live, warned: true }, 'inbounds').running).toBe(true);
    expect(endPlayClock(tickClock(at(3, 123), 6).clock, 'inbounds').running).toBe(true);
    expect(nextQuarter({ ...live, warned: true }).warned).toBe(false);
    expect(warningAt(createClock(300))).toBeCloseTo(PACE.warningAt / 3, 9);
  });

  it('snap timing: a running clock runs off down to snapAt, never in the hurry-up, never past the warning', () => {
    const running = { ...endPlayClock(at(1, 600), 'inbounds'), playClock: 33 };
    expect(paceRunoff(running)).toBe(33 - PACE.snapAt);
    expect(pacedSnap(running).remaining).toBe(600 - (33 - PACE.snapAt));
    expect(pacedSnap(running).running).toBe(true);
    // Stopped clock (after an incompletion): no runoff.
    expect(paceRunoff({ ...endPlayClock(at(1, 600), 'incomplete'), playClock: 33 })).toBe(0);
    // Already below snapAt: no runoff.
    expect(paceRunoff({ ...running, playClock: PACE.snapAt - 2 })).toBe(0);
    // Hurry-up inside the warning is real time.
    expect(paceRunoff({ ...endPlayClock(at(4, 100), 'inbounds'), warned: true, playClock: 35 })).toBe(0);
    // Never past the warning: it stops right at it.
    const near = { ...endPlayClock(at(2, 130), 'inbounds'), playClock: 38 };
    expect(pacedSnap(near).remaining).toBe(PACE.warningAt);
    expect(pacedSnap(near).warned).toBe(true);
    // The quarter never ends before the snap.
    expect(pacedSnap({ ...endPlayClock(at(1, 8), 'inbounds'), playClock: 38 }).remaining).toBe(1);
  });
});
