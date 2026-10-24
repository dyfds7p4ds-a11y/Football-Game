/**
 * Pure throw-timing math. The QB holds the throw button to charge (0..1) and
 * releases. Each target distance has an ideal charge ("sweet spot"):
 *  - charge sets ball speed (more charge = faster, flatter ball)
 *  - distance between charge and sweet spot sets accuracy
 *  - under-charged balls fall short and float, over-charged balls sail long.
 */
import type { Rng } from '../core/rng';
import { clamp, dist, norm, sub, type Vec2 } from '../core/vec';
import { FIELD } from './field';
import passingJson from '../data/passing.json';

export const THROW = {
  /** Seconds to go from 0 to full charge. */
  chargeTime: 1.0,
  /** Ball speed (yd/s, horizontal) at 0 and full charge. */
  minSpeed: 11,
  maxSpeed: 31,
  /** Gravity in yd/s^2 (9.81 m/s^2). */
  gravity: 10.73,
  releaseHeight: 2.0,
  catchHeight: 1.3,
  /** Half-width of the sweet spot in charge units (scaled by difficulty). */
  windowHalfWidth: 0.09,
  /** Max random miss radius (yards) for a fully mistimed throw. */
  maxMiss: 5.5,
} as const;

export function speedForCharge(charge: number): number {
  return THROW.minSpeed + (THROW.maxSpeed - THROW.minSpeed) * clamp(charge, 0, 1);
}

/** The ball speed a QB "should" use for a throw of `distance` yards. */
export function idealSpeed(distance: number): number {
  return clamp(16 + 0.32 * distance, 16, 30);
}

export function idealCharge(distance: number): number {
  return clamp((idealSpeed(distance) - THROW.minSpeed) / (THROW.maxSpeed - THROW.minSpeed), 0, 1);
}

export interface ThrowWindow {
  center: number;
  halfWidth: number;
}

export function throwWindow(distance: number, windowScale = 1): ThrowWindow {
  return { center: idealCharge(distance), halfWidth: THROW.windowHalfWidth * windowScale };
}

/**
 * Release quality in [0, 1]: 1 at the center of the window, 0.75 at its edges,
 * falling to 0 three half-widths away.
 */
export function releaseQuality(charge: number, win: ThrowWindow): number {
  const off = Math.abs(charge - win.center) / win.halfWidth;
  if (off <= 1) return 1 - 0.25 * off;
  return clamp(0.75 - 0.375 * (off - 1), 0, 1);
}

export interface ThrowInput {
  from: Vec2;
  target: Vec2;
  targetVel: Vec2;
  charge: number;
  /** 0..1 pocket pressure at release. */
  pressure: number;
  /** QB throwAccuracy rating 0..100. */
  accuracy: number;
  /** QB throwPower rating 0..100 (scales top speed slightly). */
  power: number;
  /** QB speed at release (yd/s); throwing on the run costs accuracy. */
  qbSpeed: number;
  windowScale: number;
  rng: Rng;
}

export interface ThrowSolution {
  speed: number;
  flightTime: number;
  /** Where the ball was meant to go (receiver lead point). */
  aim: Vec2;
  /** Where the ball actually arrives at catch height. */
  landing: Vec2;
  /** Initial velocity: horizontal (x, y) and vertical (h). */
  vel: { x: number; y: number; h: number };
  quality: number;
  missDistance: number;
  window: ThrowWindow;
  /** Phase 4: released inside the green window (|charge - center| <= half-width). */
  green: boolean;
  /** Pressure at the release (as passed in). */
  pressure: number;
}

/** Iteratively lead a moving target for a ball travelling at `speed`. */
export function leadTarget(from: Vec2, target: Vec2, targetVel: Vec2, speed: number): { aim: Vec2; time: number } {
  let aim = target;
  let time = dist(from, aim) / speed;
  for (let i = 0; i < 4; i++) {
    aim = { x: target.x + targetVel.x * time, y: target.y + targetVel.y * time };
    time = dist(from, aim) / speed;
  }
  return { aim, time };
}

export function computeThrow(inp: ThrowInput): ThrowSolution {
  const baseDist = dist(inp.from, inp.target);
  const win = throwWindow(baseDist, inp.windowScale);
  const quality = releaseQuality(inp.charge, win);
  const powerScale = 0.85 + 0.15 * (inp.power / 100);
  const speed = Math.max(THROW.minSpeed * 0.9, speedForCharge(inp.charge) * powerScale);

  const led = leadTarget(inp.from, inp.target, inp.targetVel, speed).aim;
  // Receivers stop at the sideline, so never lead them out of bounds.
  const aim = { x: clamp(led.x, -FIELD.halfWidth + 1, FIELD.halfWidth - 1), y: Math.min(led.y, FIELD.length + FIELD.endzone - 1) };
  const dir = norm(sub(aim, inp.from));

  // Systematic error: short when under-charged, long when over-charged.
  const bias = clamp((inp.charge - win.center) / win.halfWidth, -4, 4);
  const along = bias * (Math.abs(bias) > 1 ? 1.3 : 0.35);

  // Random error grows with poor timing, pressure, low accuracy and movement.
  // Phase 4: inside the green window the rating / distance scatter shrinks (passing.json greenScatter).
  const green = Math.abs(inp.charge - win.center) <= win.halfWidth;
  const skill = ((1 - inp.accuracy / 100) * 1.6 + baseDist * 0.012) * (green ? passingJson.greenScatter : 1);
  const radius =
    (1 - quality) * THROW.maxMiss +
    inp.pressure * 2.2 +
    Math.min(inp.qbSpeed, 8) * 0.12 +
    skill;
  const ang = inp.rng.next() * Math.PI * 2;
  const mag = radius * Math.sqrt(inp.rng.next()) * 0.8;

  const landing = {
    x: aim.x + dir.x * along + Math.cos(ang) * mag,
    y: aim.y + dir.y * along + Math.sin(ang) * mag,
  };
  // Phase 4: a green ball to a receiver at the sideline stays in bounds (scatter alone never carries it out).
  if (green && inp.pressure <= passingJson.cleanCatch.maxPressure) {
    landing.x = clamp(landing.x, -FIELD.halfWidth + 0.5, FIELD.halfWidth - 0.5);
    landing.y = Math.min(landing.y, FIELD.length + FIELD.endzone - 0.5);
  }
  const d = dist(inp.from, landing);
  const flightTime = Math.max(0.15, d / speed);
  const h = (THROW.catchHeight - THROW.releaseHeight) / flightTime + 0.5 * THROW.gravity * flightTime;
  const ldir = norm(sub(landing, inp.from));
  return {
    speed,
    flightTime,
    aim,
    landing,
    vel: { x: ldir.x * speed, y: ldir.y * speed, h },
    quality,
    missDistance: dist(aim, landing),
    window: win,
    green,
    pressure: inp.pressure,
  };
}

/** Ball height at time t of a flight. */
export function ballHeightAt(vh: number, t: number): number {
  return THROW.releaseHeight + vh * t - 0.5 * THROW.gravity * t * t;
}
