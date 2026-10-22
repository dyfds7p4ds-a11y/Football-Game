/**
 * Throwing-window metric: is a receiver "open" right now? Used by the balance
 * tests (open-receiver rate on vertical concepts) and by the catch code to
 * tell whether a defender is "in phase" with his receiver.
 *
 * A receiver is open when a perfectly timed throw released now would arrive
 * at his lead point before any defender (after his reaction to the throw) can
 * get within catch reach of it.
 */
import { dist, dot, len, norm, sub, type Vec2 } from '../core/vec';
import { CATCH } from './catch';
import { idealCharge, leadTarget, speedForCharge } from './throw';

export interface WindowActor {
  pos: Vec2;
  vel: Vec2;
  maxSpeed: number;
  reaction: number;
}

export interface ThrowWindowResult {
  /** Seconds the receiver has on the closest defender (> 0 = open). */
  margin: number;
  flightTime: number;
  aim: Vec2;
  /** The defender that closes fastest (index into `defenders`), -1 if none. */
  closest: number;
}

export function throwingWindow(qbPos: Vec2, receiver: WindowActor, defenders: readonly WindowActor[]): ThrowWindowResult {
  const speed = speedForCharge(idealCharge(dist(qbPos, receiver.pos)));
  const { aim, time } = leadTarget(qbPos, receiver.pos, receiver.vel, speed);
  let best = Infinity;
  let closest = -1;
  defenders.forEach((d, i) => {
    // During his reaction time the defender keeps running the way he was going.
    const coast = { x: d.pos.x + d.vel.x * d.reaction, y: d.pos.y + d.vel.y * d.reaction };
    const t = Math.max(0, dist(coast, aim) - CATCH.reach) / d.maxSpeed + d.reaction;
    if (t < best) {
      best = t;
      closest = i;
    }
  });
  return { margin: best - time, flightTime: time, aim, closest };
}

/**
 * "In phase": the defender is on the receiver's hip and running the same way,
 * so he can play the ball as well as the receiver can.
 */
export function inPhase(receiver: { pos: Vec2; vel: Vec2 }, defender: { pos: Vec2; vel: Vec2 }, maxDist: number): boolean {
  if (dist(receiver.pos, defender.pos) > maxDist) return false;
  const rv = len(receiver.vel);
  const dv = len(defender.vel);
  if (rv < 3 || dv < 3) return false;
  return dot(norm(receiver.vel), norm(defender.vel)) > 0.8 && dv > rv * 0.8;
}

/** Signed downfield cushion: > 0 when the defender is deeper than the receiver. */
export function cushion(receiver: Vec2, defender: Vec2): number {
  return sub(defender, receiver).y;
}
