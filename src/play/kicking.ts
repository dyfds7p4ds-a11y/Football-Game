/**
 * Timing-based kicking (pure). The kicker holds to fill a power meter and
 * releases; a timing zone on the meter decides accuracy, like the throw sweet
 * spot. Phase 3b adds a second layer (`releaseKickAimed`): after the power is
 * locked an aim needle sweeps and a tap locks it: sideways direction for
 * kickoffs and field goals, launch angle for punts. `releaseKick` (power
 * only, the Phase 2 punt angle sweep) stays for the CPU and old callers. Results are ballistic flights in the
 * kicking team's frame (kicking toward +y); game/specialTeams.ts turns them
 * into field position. Tunables in data/specialTeams.json.
 */
import type { Rng } from '../core/rng';
import { clamp, type Vec2 } from '../core/vec';
import stJson from '../data/specialTeams.json';

export const ST = stJson as typeof stJson;

export type KickKind = 'punt' | 'fieldGoal' | 'kickoff';

export interface KickZone {
  center: number;
  halfWidth: number;
}

/** Meter value after holding for `t` seconds: fills to 1, then falls back (ping-pong). */
export function meterPower(t: number, fillTime = ST.meter.fillTime): number {
  const k = (t / fillTime) % 2;
  return k <= 1 ? k : 2 - k;
}

/** Punt angle needle (degrees) after holding for `t` seconds. */
export function meterAngle(t: number): number {
  const p = ST.meter.punt;
  const s = 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / ST.meter.anglePeriod);
  return p.angleMin + (p.angleMax - p.angleMin) * s;
}

/** Power needed for a field goal of `distance` yards (fraction of the kicker's max). */
export function fgPowerNeeded(distance: number): number {
  return clamp(distance / ST.meter.fieldGoal.maxDistance, 0.2, 1);
}

/** The timing zone on the meter (scaled by the difficulty's kickWindow). */
export function kickZone(kind: KickKind, windowScale: number, fgDistance = 40): KickZone {
  const m = ST.meter;
  if (kind === 'punt') return { center: m.punt.zoneCenter, halfWidth: m.punt.zoneHalfWidth * windowScale };
  if (kind === 'kickoff') return { center: m.kickoff.zoneCenter, halfWidth: m.kickoff.zoneHalfWidth * windowScale };
  return { center: Math.min(0.97, fgPowerNeeded(fgDistance) + m.fieldGoal.zoneMargin), halfWidth: m.fieldGoal.zoneHalfWidth * windowScale };
}

/** 1 in the middle of the zone, 0.75 at its edges, falling to 0 three half-widths out (same shape as the throw). */
export function zoneQuality(value: number, z: KickZone): number {
  const off = Math.abs(value - z.center) / z.halfWidth;
  if (off <= 1) return 1 - 0.25 * off;
  return clamp(0.75 - 0.375 * (off - 1), 0, 1);
}

export interface KickRelease {
  kind: KickKind;
  power: number;
  /** Launch angle in degrees. */
  angle: number;
  /** 0..1 timing quality (power vs zone; for punts also the angle). */
  quality: number;
  inZone: boolean;
  /** Phase 3b second layer: the locked aim needle (-1..1) and, for kickoffs / field goals, the sideways direction it sets. */
  aim?: number;
  lateralDeg?: number;
}

/** Aim needle (-1..1) `t` seconds after the power was locked: starts at the left end and sweeps back and forth. */
export function aimNeedle(t: number): number {
  const k = (t / ST.meter.aim.period) % 2;
  return k <= 1 ? -1 + 2 * k : 3 - 2 * k;
}

/** Green zone of the aim needle (center 0). Punts: the ideal angle mapped onto the needle. */
export function aimZone(kind: KickKind, windowScale: number): KickZone {
  if (kind === 'punt') {
    const p = ST.meter.punt;
    const half = (p.angleMax - p.angleMin) / 2;
    return { center: (p.idealAngle - (p.angleMin + half)) / half, halfWidth: (p.angleHalfWidth * windowScale) / half };
  }
  return { center: 0, halfWidth: ST.meter.aim.zoneHalfWidth * windowScale };
}

/** Punt launch angle for an aim needle value (left = low line drive, right = high hang). */
export function aimToAngle(aim: number): number {
  const p = ST.meter.punt;
  return p.angleMin + ((clamp(aim, -1, 1) + 1) / 2) * (p.angleMax - p.angleMin);
}

/**
 * Two-layer kick: power held for `held` seconds (layer 1, the Phase 2 zones),
 * then the aim needle locked at `aim` (layer 2).
 */
export function releaseKickAimed(kind: KickKind, held: number, aim: number, windowScale: number, fgDistance = 40): KickRelease {
  const power = meterPower(held);
  const z = kickZone(kind, windowScale, fgDistance);
  const pq = zoneQuality(power, z);
  const aq = zoneQuality(aim, aimZone(kind, windowScale));
  const w = ST.meter.aim.weight;
  const quality = pq * (1 - w) + aq * w;
  const inZone = Math.abs(power - z.center) <= z.halfWidth;
  if (kind === 'punt') return { kind, power, angle: clamp(aimToAngle(aim), 10, 80), quality, inZone, aim };
  const angle = kind === 'kickoff' ? ST.meter.kickoff.angle : ST.meter.fieldGoal.angle;
  return { kind, power, angle, quality, inZone, aim, lateralDeg: clamp(aim, -1, 1) * ST.meter.aim.maxLateralDeg };
}

export function releaseKick(kind: KickKind, held: number, windowScale: number, fgDistance = 40): KickRelease {
  const power = meterPower(held);
  const z = kickZone(kind, windowScale, fgDistance);
  let quality = zoneQuality(power, z);
  let angle = kind === 'punt' ? meterAngle(held) : kind === 'kickoff' ? ST.meter.kickoff.angle : ST.meter.fieldGoal.angle;
  if (kind === 'punt') {
    const p = ST.meter.punt;
    const aq = zoneQuality(angle, { center: p.idealAngle, halfWidth: p.angleHalfWidth * windowScale });
    quality = quality * 0.6 + aq * 0.4;
  }
  angle = clamp(angle, 10, 80);
  return { kind, power, angle, quality, inZone: Math.abs(power - z.center) <= z.halfWidth };
}

/** A CPU kicker: a release near the zone center with difficulty-dependent spread. */
export function cpuRelease(kind: KickKind, windowScale: number, sigma: number, rng: Rng, fgDistance = 40): KickRelease {
  const z = kickZone(kind, windowScale, fgDistance);
  const power = clamp(z.center + rng.normal() * sigma, 0.05, 1);
  const held = power * ST.meter.fillTime;
  if (kind !== 'punt') return { ...releaseKick(kind, held, windowScale, fgDistance), power };
  // Punter also times the angle: pick the needle phase near the ideal angle.
  const r = releaseKick(kind, held, windowScale);
  const angle = clamp(ST.meter.punt.idealAngle + rng.normal() * sigma * 80, ST.meter.punt.angleMin, ST.meter.punt.angleMax);
  const aq = zoneQuality(angle, { center: ST.meter.punt.idealAngle, halfWidth: ST.meter.punt.angleHalfWidth * windowScale });
  return { ...r, power, angle, quality: zoneQuality(power, z) * 0.6 + aq * 0.4 };
}

export interface KickFlight {
  /** Kicking team's frame: x lateral, y yards from the kicking team's goal line. */
  from: Vec2;
  landing: Vec2;
  /** Seconds in the air. */
  hang: number;
  /** Launch velocity: horizontal (x, y) and vertical (h), yd/s. */
  vel: { x: number; y: number; h: number };
  quality: number;
}

const DEG = Math.PI / 180;

/**
 * Ballistic flight for a release. Power sets launch speed, the angle the
 * trajectory; poor timing pulls the kick sideways (and can shank it).
 */
export function kickFlight(rel: KickRelease, from: Vec2, aimX: number, rng: Rng): KickFlight {
  const ph = ST.physics;
  const maxSpeed = rel.kind === 'punt' ? ph.puntMaxSpeed : rel.kind === 'kickoff' ? ph.kickoffMaxSpeed : ph.fgMaxSpeed;
  let speed = maxSpeed * (0.45 + 0.55 * rel.power);
  let lateral = (1 - rel.quality) * ph.maxLateralDeg * (rng.next() < 0.5 ? -1 : 1) * (0.5 + 0.5 * rng.next());
  // Aimed kicks: the needle sets the direction; only a little of the random spray remains.
  if (rel.lateralDeg !== undefined) lateral = rel.lateralDeg + lateral * ST.meter.aim.residualLateral;
  if (rel.quality < 0.3 && rng.chance(ph.shankChance)) {
    speed *= 0.6; // shank
    lateral *= 2;
  }
  const a = rel.angle * DEG;
  const vh = speed * Math.sin(a);
  const vg = speed * Math.cos(a);
  const hang = (2 * vh) / ph.gravity;
  const dirX = Math.sin(lateral * DEG);
  const dirY = Math.cos(lateral * DEG);
  // Aim toward aimX at the landing depth.
  const range = vg * hang;
  const aimShift = clamp((aimX - from.x) / Math.max(range, 1), -0.4, 0.4);
  const vx = vg * (dirX + aimShift);
  const vy = vg * dirY;
  return {
    from: { ...from },
    landing: { x: from.x + vx * hang, y: from.y + vy * hang },
    hang,
    vel: { x: vx, y: vy, h: vh },
    quality: rel.quality,
  };
}

export function flightHeight(f: KickFlight, t: number, startH = 0.5): number {
  return Math.max(0, startH + f.vel.h * t - 0.5 * ST.physics.gravity * t * t);
}

/** Position of the ball at time t of the flight (kicking frame). */
export function flightPos(f: KickFlight, t: number): { x: number; y: number; h: number } {
  return { x: f.from.x + f.vel.x * t, y: f.from.y + f.vel.y * t, h: flightHeight(f, t) };
}

export interface FieldGoalResult {
  good: boolean;
  /** Lateral offset (yards) when crossing the goal line plane at the posts, height there. */
  offset: number;
  height: number;
  reason: 'good' | 'wide' | 'short';
}

/**
 * Judge a field goal: the posts sit at the back of the end zone (kicking
 * frame y = 110). Good when the ball passes between the uprights above the bar.
 */
export function judgeFieldGoal(f: KickFlight): FieldGoalResult {
  const gp = ST.goalposts;
  const postY = 110;
  if (f.vel.y <= 0) return { good: false, offset: 0, height: 0, reason: 'short' };
  const t = (postY - f.from.y) / f.vel.y;
  const h = flightHeight(f, t);
  const offset = f.from.x + f.vel.x * t;
  if (t > f.hang || h < gp.crossbar) return { good: false, offset, height: h, reason: 'short' };
  if (Math.abs(offset) > gp.halfWidth) return { good: false, offset, height: h, reason: 'wide' };
  return { good: true, offset, height: h, reason: 'good' };
}
