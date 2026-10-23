/**
 * CPU offense for interactive CPU drives (the user plays defense): a QB brain
 * that turns the current PlaySim state into a SimInput each step, plus the
 * CPU play-caller and fourth-down decision. Uses the same reads the balance
 * tests use (`windows.throwingWindow`: who is open right now?) and the same
 * charge/sweet-spot throw as the user, with a release error that shrinks with
 * the difficulty's `cpuOffense`. Deterministic for a given Rng. Tunables in
 * data/cpuOffense.json.
 */
import type { Rng } from '../core/rng';
import { add, dist, len, norm, scale, sub, v2, type Vec2 } from '../core/vec';
import { PLAYS } from '../data';
import type { DifficultyConfig, EligibleSlot, PlayCategory, PlayData } from '../data/types';
import { ELIGIBLE } from '../data/types';
import cpuJson from '../data/cpuOffense.json';
import { SIM_DT, idleInput, type Actor, type PlaySim, type SimInput } from './sim';
import { THROW, throwWindow } from './throw';
import { throwingWindow, type WindowActor } from './windows';

type CallMix = Record<'run' | 'short' | 'medium' | 'deep', number>;

export const CPU_OFFENSE = cpuJson as {
  drop: { underCenter: number; shotgun: number };
  readStart: number;
  readEvery: number;
  openMargin: number;
  pressureBail: number;
  pressureMinTime: number;
  maxHold: number;
  throwAwayMargin: number;
  chargeSigma: number;
  readNoise: number;
  primaryBias: number;
  slotBias: Record<EligibleSlot, number>;
  checkdownAfter: number;
  hot: { margin: number; bail: number };
  runner: { lookAhead: number; avoid: number };
  calls: Record<'short' | 'normal' | 'long', CallMix>;
  callsLate: Record<'short' | 'normal' | 'long', CallMix> & { shortTo: number; longFrom: number };
  fourthDown: { goForItToGo: number; goForItFrom: number; fieldGoalFrom: number };
};

const toWA = (a: Actor): WindowActor => ({ pos: a.pos, vel: a.vel, maxSpeed: a.maxSpeed, reaction: a.reaction });

export class CpuQB {
  private target: EligibleSlot | null = null;
  /** This throw's release error around the sweet spot (drawn when the target is picked). */
  private releaseError = 0;
  /** Nothing open under pressure or out of time: throw it out of bounds toward this sideline. */
  private throwAway = 0;
  private nextRead: number;
  private dropTime = 0;
  private skill: number;

  constructor(private play: PlayData, diff: DifficultyConfig, private rng: Rng) {
    this.skill = diff.cpuOffense;
    this.nextRead = CPU_OFFENSE.readStart + rng.range(-0.15, 0.2);
  }

  input(sim: PlaySim): SimInput {
    const inp = idleInput();
    const qb = sim.get('QB');
    if (sim.t === 0) this.dropTime = sim.los - qb.pos.y > 3 ? CPU_OFFENSE.drop.shotgun : CPU_OFFENSE.drop.underCenter;
    const c = sim.carrier;
    // Ball carrier after a catch, handoff or scramble: run with simple avoidance.
    if (c && c.side === 'off' && (c !== qb || sim.pastLos(qb))) {
      inp.move = this.runLine(sim, c);
      return inp;
    }
    if (this.play.run || !sim.canThrow()) return inp;
    if (sim.t < this.dropTime) inp.move = v2(0, -1);

    if (!this.target && !this.throwAway) this.pickTarget(sim);
    if (this.throwAway) {
      inp.gazeYaw = this.throwAway * 1.1;
      inp.throwHeld = sim.charge < 0.7;
    } else if (this.target) {
      inp.target = this.target;
      const r = sim.get(this.target);
      inp.gazeYaw = Math.atan2(r.pos.x - qb.pos.x, r.pos.y - qb.pos.y);
      // Hold the button until the charge reaches the sweet spot for the receiver's current
      // distance (it moves with him, like the user's HUD window) plus this throw's error.
      const release = throwWindow(dist(qb.pos, r.pos)).center + this.releaseError;
      inp.throwHeld = sim.charge + SIM_DT / THROW.chargeTime < release;
    }
    return inp;
  }

  private pickTarget(sim: PlaySim) {
    const scr = this.play.screen;
    if (scr) {
      if (sim.t >= scr.release) this.choose(sim, scr.target);
      return;
    }
    const qb = sim.get('QB');
    const defenders = sim.actors.filter((a) => a.side === 'def' && !a.down).map(toWA);
    if (sim.qbAlert && sim.hot && sim.t >= this.dropTime * 0.5) {
      // Phase 3c: a rush nobody planned for: the ball comes out now, to the hot read or away.
      const w = throwingWindow(qb.pos, toWA(sim.get(sim.hot)), defenders);
      const m = w.margin + this.rng.normal() * (CPU_OFFENSE.readNoise / (this.skill * this.skill));
      if (m > CPU_OFFENSE.hot.margin) {
        this.choose(sim, sim.hot);
        return;
      }
      if (sim.pressure > CPU_OFFENSE.hot.bail) {
        this.throwAway = Math.sign(qb.pos.x - sim.ballX) || 1;
        return;
      }
    }
    if (sim.t < this.nextRead) return;
    this.nextRead = sim.t + CPU_OFFENSE.readEvery;
    let best: { slot: EligibleSlot; m: number } | null = null;
    const pressuredNow = sim.pressure > CPU_OFFENSE.pressureBail;
    for (const slot of ELIGIBLE) {
      const r = sim.get(slot);
      if (r.down || r.route?.blocks) continue;
      // Progression: the back is the check-down, read late (or when the pocket breaks down).
      if (slot === 'RB' && slot !== this.play.primary && sim.t < CPU_OFFENSE.checkdownAfter && !pressuredNow) continue;
      const w = throwingWindow(qb.pos, toWA(r), defenders);
      // Weaker QBs misjudge windows (read noise shrinks with cpuOffense squared).
      const m = w.margin + (slot === this.play.primary ? CPU_OFFENSE.primaryBias : 0) + (CPU_OFFENSE.slotBias[slot] ?? 0) +
        this.rng.normal() * (CPU_OFFENSE.readNoise / (this.skill * this.skill));
      if (!best || m > best.m) best = { slot, m };
    }
    if (!best) return;
    const pressured = sim.pressure > CPU_OFFENSE.pressureBail && sim.t > CPU_OFFENSE.pressureMinTime;
    const late = sim.t > CPU_OFFENSE.maxHold;
    if (best.m > CPU_OFFENSE.openMargin || ((pressured || late) && best.m > CPU_OFFENSE.throwAwayMargin)) this.choose(sim, best.slot);
    else if (pressured || late) this.throwAway = Math.sign(qb.pos.x - sim.ballX) || 1;
  }

  private choose(_sim: PlaySim, slot: EligibleSlot) {
    this.target = slot;
    // Accuracy is where the difficulty shows: release error shrinks with cpuOffense squared.
    this.releaseError = this.rng.normal() * (CPU_OFFENSE.chargeSigma / (this.skill * this.skill));
  }

  /** Upfield, bending away from the nearest defender ahead of the runner. */
  private runLine(sim: PlaySim, c: Actor): Vec2 {
    let dir = v2(0, 1);
    let worst: Actor | null = null;
    for (const d of sim.actors) {
      if (d.side !== 'def' || d.down) continue;
      const rel = sub(d.pos, c.pos);
      if (rel.y < -1 || len(rel) > CPU_OFFENSE.runner.lookAhead) continue;
      if (!worst || dist(d.pos, c.pos) < dist(worst.pos, c.pos)) worst = d;
    }
    if (worst) {
      const away = norm(sub(c.pos, worst.pos));
      dir = norm(add(dir, scale(v2(away.x, 0), CPU_OFFENSE.runner.avoid * 2)));
    }
    return dir;
  }
}

export interface OffenseSituation {
  down: number;
  toGo: number;
  /** Yards from the offense's own goal line. */
  yardline: number;
}

/**
 * Phase 3c: the call mix for down and distance. Long distance favours passes;
 * on 3rd / 4th and long (`callsLate.longFrom`) there is no designed run.
 */
export function callMix(sit: OffenseSituation): CallMix {
  const L = CPU_OFFENSE.callsLate;
  const bucket = sit.toGo <= L.shortTo ? 'short' : sit.toGo >= L.longFrom ? 'long' : 'normal';
  return sit.down >= 3 ? L[bucket] : CPU_OFFENSE.calls[bucket];
}

/** CPU play call by down and distance (fourth downs: see `fourthDownCall`). */
export function chooseCpuPlay(sit: OffenseSituation, rng: Rng): PlayData {
  const mix = callMix(sit);
  let r = rng.next();
  const kinds = (Object.keys(mix) as (keyof CallMix)[]).filter((k) => mix[k] > 0);
  let kind: keyof CallMix = kinds[kinds.length - 1];
  for (const k of kinds) {
    if ((r -= mix[k]) <= 0) {
      kind = k;
      break;
    }
  }
  const cats: Record<keyof CallMix, PlayCategory[]> = { run: ['run'], short: ['short', 'screen'], medium: ['medium', 'playaction'], deep: ['deep', 'playaction'] };
  // Deep shots need room in front of the goal line.
  const pool = PLAYS.filter((p) => cats[kind].includes(p.category) && !(kind === 'deep' && sit.yardline > 80));
  // No room for a deep shot: a pass from the medium / short menu instead (never a run the mix did not ask for).
  const fallback = PLAYS.filter((p) => (kind === 'run' ? p.run : !p.run && (p.category === 'medium' || p.category === 'short')));
  return rng.pick(pool.length ? pool : fallback);
}

/** Fourth down: go for it, kick a field goal or punt. */
export function fourthDownCall(sit: OffenseSituation, trailingLate: boolean): 'go' | 'fieldGoal' | 'punt' {
  const f = CPU_OFFENSE.fourthDown;
  if (sit.yardline >= f.fieldGoalFrom && !(trailingLate && sit.toGo <= 3)) return 'fieldGoal';
  if (trailingLate || (sit.toGo <= f.goForItToGo && sit.yardline >= f.goForItFrom)) return 'go';
  return 'punt';
}
