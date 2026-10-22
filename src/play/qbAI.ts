/**
 * CPU offense for interactive CPU drives (the user plays defense): a QB brain
 * that turns the current PlaySim state into a SimInput each step, plus the
 * CPU play-caller and fourth-down decision. Uses the same reads the balance
 * tests use (`windows.throwingWindow`: who is open right now?) and the same
 * charge/sweet-spot throw as the user, with an error that shrinks with the
 * difficulty's `cpuOffense`. Deterministic for a given Rng. Tunables in
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
  primaryBias: number;
  runner: { lookAhead: number; avoid: number };
  calls: Record<'short' | 'normal' | 'long', CallMix>;
  fourthDown: { goForItToGo: number; goForItFrom: number; fieldGoalFrom: number };
};

const toWA = (a: Actor): WindowActor => ({ pos: a.pos, vel: a.vel, maxSpeed: a.maxSpeed, reaction: a.reaction });

export class CpuQB {
  private target: EligibleSlot | null = null;
  /** Charge at which to release (sweet spot + this QB's error), set when the target is picked. */
  private release = 0;
  private nextRead: number;
  private dropTime = 0;
  private skill: number;

  constructor(private play: PlayData, diff: DifficultyConfig, private rng: Rng) {
    this.skill = diff.cpuOffense;
    this.nextRead = CPU_OFFENSE.readStart / this.skill + rng.range(-0.15, 0.2);
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

    if (!this.target) this.pickTarget(sim);
    if (this.target) {
      inp.target = this.target;
      const r = sim.get(this.target);
      inp.gazeYaw = Math.atan2(r.pos.x - qb.pos.x, r.pos.y - qb.pos.y);
      // Hold the button until the charge reaches the chosen release point, then let go.
      inp.throwHeld = sim.charge + SIM_DT / THROW.chargeTime < this.release;
    }
    return inp;
  }

  private pickTarget(sim: PlaySim) {
    const scr = this.play.screen;
    if (scr) {
      if (sim.t >= scr.release) this.choose(sim, scr.target);
      return;
    }
    if (sim.t < this.nextRead) return;
    this.nextRead = sim.t + CPU_OFFENSE.readEvery;
    const qb = sim.get('QB');
    const defenders = sim.actors.filter((a) => a.side === 'def' && !a.down).map(toWA);
    const margin = CPU_OFFENSE.openMargin - (this.skill - 1) * 0.15;
    let best: { slot: EligibleSlot; m: number } | null = null;
    for (const slot of ELIGIBLE) {
      const r = sim.get(slot);
      if (r.down || r.route?.blocks) continue;
      const w = throwingWindow(qb.pos, toWA(r), defenders);
      const m = w.margin + (slot === this.play.primary ? CPU_OFFENSE.primaryBias : 0) + this.rng.range(-0.05, 0.05);
      if (!best || m > best.m) best = { slot, m };
    }
    if (!best) return;
    const pressured = sim.pressure > CPU_OFFENSE.pressureBail && sim.t > CPU_OFFENSE.pressureMinTime;
    const late = sim.t > CPU_OFFENSE.maxHold;
    if (best.m > margin || ((pressured || late) && best.m > CPU_OFFENSE.throwAwayMargin)) this.choose(sim, best.slot);
    else if (late) this.choose(sim, best.slot); // nothing open and out of time: force it
  }

  private choose(sim: PlaySim, slot: EligibleSlot) {
    this.target = slot;
    const d = dist(sim.get('QB').pos, sim.get(slot).pos);
    this.release = throwWindow(d).center + this.rng.normal() * (CPU_OFFENSE.chargeSigma / this.skill);
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

/** CPU play call by down and distance (fourth downs: see `fourthDownCall`). */
export function chooseCpuPlay(sit: OffenseSituation, rng: Rng): PlayData {
  const mix = sit.toGo <= 2 ? CPU_OFFENSE.calls.short : sit.toGo >= 8 ? CPU_OFFENSE.calls.long : CPU_OFFENSE.calls.normal;
  let r = rng.next();
  let kind: keyof CallMix = 'run';
  for (const k of Object.keys(mix) as (keyof CallMix)[]) {
    if ((r -= mix[k]) <= 0) {
      kind = k;
      break;
    }
  }
  const cats: Record<keyof CallMix, PlayCategory[]> = { run: ['run'], short: ['short', 'screen'], medium: ['medium', 'playaction'], deep: ['deep', 'playaction'] };
  // Deep shots need room in front of the goal line.
  const pool = PLAYS.filter((p) => cats[kind].includes(p.category) && !(kind === 'deep' && sit.yardline > 80));
  return rng.pick(pool.length ? pool : PLAYS);
}

/** Fourth down: go for it, kick a field goal or punt. */
export function fourthDownCall(sit: OffenseSituation, trailingLate: boolean): 'go' | 'fieldGoal' | 'punt' {
  const f = CPU_OFFENSE.fourthDown;
  if (sit.yardline >= f.fieldGoalFrom && !(trailingLate && sit.toGo <= 3)) return 'fieldGoal';
  if (trailingLate || (sit.toGo <= f.goForItToGo && sit.yardline >= f.goForItFrom)) return 'go';
  return 'punt';
}
