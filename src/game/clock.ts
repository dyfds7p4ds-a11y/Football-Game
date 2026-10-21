/**
 * Game clock + 40-second play clock (simplified rules, pure functions).
 *
 * - The game clock runs during every live play.
 * - After a play it keeps running only if the ball carrier was downed in
 *   bounds; incompletions, out of bounds, scores, turnovers, timeouts and
 *   penalties stop it until the next snap.
 * - The play clock resets to 40 at the end of each play and counts down until
 *   the snap; at 0 the offense is flagged for delay of game.
 * - If the game clock hits 0 during a live play, the play is completed and the
 *   quarter ends afterwards.
 */
export const PLAY_CLOCK = 40;

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

export function tickClock(c: ClockState, dt: number): TickResult {
  let { remaining, playClock } = c;
  let quarterExpired = false;
  let playClockExpired = false;
  if (c.running && remaining > 0) {
    remaining = Math.max(0, remaining - dt);
    quarterExpired = remaining === 0;
  }
  if (c.playClockRunning && playClock > 0) {
    playClock = Math.max(0, playClock - dt);
    playClockExpired = playClock === 0;
  }
  return { clock: { ...c, remaining, playClock }, quarterExpired, playClockExpired };
}

/** Ball is snapped: game clock runs, play clock stops. */
export function snapClock(c: ClockState): ClockState {
  return { ...c, running: c.remaining > 0, playClockRunning: false };
}

export function stopsClock(reason: StopReason): boolean {
  return reason !== 'inbounds';
}

/** Play is over: decide whether the game clock keeps running; reset play clock. */
export function endPlayClock(c: ClockState, reason: StopReason): ClockState {
  return {
    ...c,
    running: !stopsClock(reason) && c.remaining > 0,
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
    playClock: PLAY_CLOCK,
    playClockRunning: true,
  };
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
