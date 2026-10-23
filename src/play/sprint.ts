/**
 * Phase 3d: sprint for the ball carrier (pure). Holding SPRINT runs at full
 * speed while stamina lasts; a tackle on a sprinting carrier is more likely
 * to jar the ball loose, and more so the more tired he is. Tunables:
 * `data/sprint.json`.
 */
import { clamp } from '../core/vec';
import SPRINT_DATA from '../data/sprint.json';

export const SPRINT = SPRINT_DATA;

export interface SprintState {
  stamina: number;
  sprinting: boolean;
  /** Sim time the carrier last sprinted (for the fumble afterglow). */
  lastSprint: number;
  /** Ran dry: no sprint until stamina is back to `restart`. */
  exhausted: boolean;
}

export const freshSprint = (): SprintState => ({ stamina: 1, sprinting: false, lastSprint: -Infinity, exhausted: false });

/** One step: `held` = the button is down and the carrier may sprint. Mutates and returns the state. */
export function stepSprint(s: SprintState, held: boolean, t: number, dt: number): SprintState {
  const S = SPRINT.stamina;
  if (s.exhausted && s.stamina >= S.restart) s.exhausted = false;
  s.sprinting = held && !s.exhausted && s.stamina > 0;
  if (s.sprinting) {
    s.stamina = Math.max(0, s.stamina - S.drain * dt);
    s.lastSprint = t;
    if (s.stamina <= 0) {
      s.exhausted = true;
      s.sprinting = false;
    }
  } else {
    s.stamina = Math.min(1, s.stamina + S.recover * dt);
  }
  return s;
}

/** Speed fraction of the carrier's top speed (runner jogs at 0.9, the QB at 1.0). */
export function sprintSpeed(s: SprintState, qb: boolean): number {
  if (!s.sprinting) return qb ? 1 : 0.9;
  return qb ? SPRINT.qbSpeed : SPRINT.speed;
}

/** Fumble chance multiplier at a tackle: 1 unless he is (or just was) sprinting. */
export function sprintFumbleFactor(s: SprintState, t: number): number {
  if (!s.sprinting && t - s.lastSprint > SPRINT.afterglow) return 1;
  return SPRINT.fumbleMin + (SPRINT.fumbleMax - SPRINT.fumbleMin) * clamp(1 - s.stamina, 0, 1);
}
