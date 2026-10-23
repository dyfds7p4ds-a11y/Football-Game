/**
 * Game clock + play clock (pure functions). Phase 3c: NFL rules
 * (data/pace.json).
 *
 * - The game clock runs during every live play.
 * - After a play it keeps running when the carrier was downed in bounds
 *   (first downs do not stop it). Incompletions, scores, turnovers,
 *   possession changes and timeouts stop it until the next snap. Out of
 *   bounds and penalties stop it only late in a half (`lateStop`); earlier
 *   it restarts when the ball is ready.
 * - Two-minute warning: the clock stops at `warningAt` in Q2 and Q4 (after
 *   the play if it happens during one).
 * - The play clock resets at the end of each play and counts down until the
 *   snap; at 0 the offense is flagged for delay of game.
 * - Snap timing: on a running clock the offense lets the play clock run down
 *   to `snapAt` (`paceRunoff`), so the game clock does not depend on how fast
 *   the user taps SNAP, except in the hurry-up after the two-minute warning.
 * - If the game clock hits 0 during a live play, the play is completed and the
 *   quarter ends afterwards.
 */
import paceJson from '../data/pace.json';

export const PACE = paceJson as {
  playClock: number;
  snapAt: number;
  jitter: number;
  warningAt: number;
  lateStop: { q2: number; q4: number };
  real: Record<'call' | 'presnap' | 'cpuPresnap' | 'live' | 'post' | 'cpuCall' | 'kick' | 'score' | 'break', number>;
  targetQuarterMinutes: number;
  targetRealMinutes: number;
  referenceQuarter: number;
  hurry: number;
};

/** NFL late-half seconds scaled to the quarter length (shorter quarters, shorter windows). */
function scaled(x: number, c: ClockState): number {
  return x * Math.min(1, c.quarterLength / PACE.referenceQuarter);
}

/** Two-minute warning time for this clock's quarter length. */
export function warningAt(c: ClockState): number {
  return scaled(PACE.warningAt, c);
}

export const PLAY_CLOCK = PACE.playClock;

export type StopReason =
  | 'inbounds' | 'incomplete' | 'outOfBounds' | 'score' | 'turnover' | 'timeout' | 'penalty' | 'possession';

export interface ClockState {
  quarter: number;
  /** Seconds left in the quarter. */
  remaining: number;
  running: boolean;
  playClock: number;
  playClockRunning: boolean;
  quarterLength: number;
  /** Phase 3c: the two-minute warning of this quarter has been given. */
  warned?: boolean;
}

export function createClock(quarterLength: number): ClockState {
  return {
    quarter: 1,
    remaining: quarterLength,
    running: false,
    playClock: PLAY_CLOCK,
    playClockRunning: true,
    quarterLength,
  };
}

export interface TickResult {
  clock: ClockState;
  /** Game clock reached 0 on this tick. */
  quarterExpired: boolean;
  /** Play clock reached 0 on this tick. */
  playClockExpired: boolean;
}

/** Q2 / Q4 before the two-minute warning was given. */
function warningDue(c: ClockState): boolean {
  return (c.quarter === 2 || c.quarter === 4) && !c.warned;
}

export function tickClock(c: ClockState, dt: number): TickResult {
  let { remaining, playClock, running, warned } = c;
  let quarterExpired = false;
  let playClockExpired = false;
  if (running && remaining > 0) {
    remaining = Math.max(0, remaining - dt);
    // Between plays the clock stops at the warning; during a play it runs on (stopped after it).
    if (warningDue(c) && c.remaining > warningAt(c) && remaining <= warningAt(c) && c.playClockRunning) {
      remaining = warningAt(c);
      running = false;
      warned = true;
    }
    quarterExpired = remaining === 0;
  }
  if (c.playClockRunning && playClock > 0) {
    playClock = Math.max(0, playClock - dt);
    playClockExpired = playClock === 0;
  }
  return { clock: { ...c, remaining, playClock, running, warned }, quarterExpired, playClockExpired };
}

/** Seconds left in the half's late window where out of bounds and penalties stop the clock (0: not late). */
function lateWindow(c: ClockState): number {
  return scaled(c.quarter === 2 ? PACE.lateStop.q2 : c.quarter === 4 ? PACE.lateStop.q4 : 0, c);
}

/**
 * Phase 3c snap timing: game seconds that run off at the snap on a running
 * clock (the offense lets the play clock run down to `snapAt`). None in the
 * hurry-up after the two-minute warning, never past the warning, and the
 * quarter never ends before the snap.
 */
export function paceRunoff(c: ClockState, snapAt = PACE.snapAt): number {
  if (!c.running || c.remaining <= 0) return 0;
  if ((c.quarter === 2 || c.quarter === 4) && c.remaining <= warningAt(c)) return 0;
  let r = Math.max(0, c.playClock - snapAt);
  const floor = warningDue(c) && c.remaining > warningAt(c) ? warningAt(c) : 1;
  r = Math.min(r, Math.max(0, c.remaining - floor));
  return r;
}

/** Snap with the pace runoff applied first (user and CPU snaps on a running clock). */
export function pacedSnap(c: ClockState, snapAt = PACE.snapAt): ClockState {
  const r = paceRunoff(c, snapAt);
  const remaining = c.remaining - r;
  const warned = c.warned || (warningDue(c) && r > 0 && remaining <= warningAt(c));
  return snapClock({ ...c, remaining, warned, running: warned && !c.warned ? false : c.running });
}

/** Ball is snapped: game clock runs, play clock stops. */
export function snapClock(c: ClockState): ClockState {
  return { ...c, running: c.remaining > 0, playClockRunning: false };
}

/** NFL: does this end of play stop the game clock (with the clock state, for the late-half rules)? */
export function stopsClock(reason: StopReason, c?: ClockState): boolean {
  if (reason === 'inbounds') return false;
  if (reason === 'outOfBounds' || reason === 'penalty') return !c || c.remaining <= lateWindow(c);
  return true;
}

/** Play is over: decide whether the game clock keeps running; reset play clock. */
export function endPlayClock(c: ClockState, reason: StopReason): ClockState {
  // Two-minute warning reached during the play: the clock stops now.
  const warning = warningDue(c) && c.remaining <= warningAt(c);
  return {
    ...c,
    running: !warning && !stopsClock(reason, c) && c.remaining > 0,
    warned: c.warned || warning,
    playClock: PLAY_CLOCK,
    playClockRunning: true,
  };
}

export function callTimeoutClock(c: ClockState): ClockState {
  return { ...c, running: false, playClock: PLAY_CLOCK, playClockRunning: true };
}

export function isQuarterOver(c: ClockState): boolean {
  return c.remaining <= 0;
}

export function nextQuarter(c: ClockState): ClockState {
  return {
    ...c,
    quarter: c.quarter + 1,
    remaining: c.quarterLength,
    running: false,
    warned: false,
    playClock: PLAY_CLOCK,
    playClockRunning: true,
  };
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
