/**
 * PlaySim: deterministic, fixed-timestep simulation of a single play from snap
 * to whistle. No rendering or DOM here: the app feeds `SimInput` each step and
 * the renderer reads `actors` / `ball`. Given the same seed and inputs, a play
 * always resolves the same way (see tests/sim.test.ts).
 */
import { Rng } from '../core/rng';
import {
  add, clamp, clampLen, dist, fromHeading, len, lerp, norm, scale, sub, v2, type Vec2,
} from '../core/vec';
import type {
  DefSlot, DifficultyConfig, EligibleSlot, OffSlot, PlayData, PlayerData, Position, TeamData,
} from '../data/types';
import { ELIGIBLE, OL_SLOTS, DEF_SLOTS, OFF_SLOTS } from '../data/types';
import { FORMATIONS, playerFor } from '../data';
import { buildRoute, type Route } from './routes';
import { ZONES, type DefAssignment, type DefenseCall } from './defenseCalls';
import { computeThrow, ballHeightAt, THROW, throwWindow, type ThrowWindow } from './throw';
import { resolveCatch, type CatchCandidate } from './catch';
import { FIELD } from './field';

export const SIM_DT = 1 / 60;
const HISTORY = 90;
const TACKLE_RANGE = 1.2;
const MAX_PLAY_TIME = 25;

export type Side = 'off' | 'def';

export interface Actor {
  id: number;
  side: Side;
  slot: OffSlot | DefSlot;
  position: Position;
  player: PlayerData;
  pos: Vec2;
  prevPos: Vec2;
  vel: Vec2;
  facing: number;
  maxSpeed: number;
  accel: number;
  route?: Route;
  routeIdx: number;
  assignment?: DefAssignment;
  /** Per-play reaction delay (s) and coverage error, from difficulty. */
  reaction: number;
  coverOffset: Vec2;
  blockCooldown: number;
  tackleCooldown: number;
  down: boolean;
  history: Vec2[];
}

export interface SimInput {
  /** Joystick, field-relative: x = right, y = downfield. Length <= 1. */
  move: Vec2;
  /** QB gaze yaw (0 = downfield, + = right). */
  gazeYaw: number;
  throwHeld: boolean;
  target: EligibleSlot | null;
  /** Edge-triggered: RB button pressed (handoff when the RB is close). */
  handoff: boolean;
  /** Edge-triggered: juke move for the ball carrier. */
  juke: boolean;
}

export const idleInput = (): SimInput => ({
  move: v2(), gazeYaw: 0, throwHeld: false, target: null, handoff: false, juke: false,
});

interface Flight {
  from: Vec2;
  t: number;
  T: number;
  vel: { x: number; y: number; h: number };
  landing: Vec2;
  targetId: number | null;
  /** Snaps and pitches home in on the receiver and are always caught. */
  lateral: boolean;
  quality: number;
  speed: number;
  tipChecked: Set<number>;
}

export interface Ball {
  state: 'held' | 'air' | 'loose';
  holder: number | null;
  pos: Vec2;
  h: number;
  prevPos: Vec2;
  prevH: number;
  flight: Flight | null;
  /** Loose-ball physics after an incompletion (visual only). */
  looseVel: { x: number; y: number; h: number };
}

export type PlayEventType =
  | 'snap' | 'handoff' | 'pitch' | 'throw' | 'catch' | 'interception' | 'deflection' | 'drop'
  | 'incomplete' | 'tackle' | 'sack' | 'touchdown' | 'outOfBounds' | 'brokenTackle' | 'juke' | 'safety'
  | 'scramble' | 'shed';

export interface PlayEvent {
  t: number;
  type: PlayEventType;
  actor?: number;
}

export type PlayOutcome = 'tackle' | 'sack' | 'incomplete' | 'outOfBounds' | 'touchdown' | 'interception' | 'safety';

export interface PlayResult {
  outcome: PlayOutcome;
  /** Spot where the play ended (offense frame). */
  endX: number;
  endY: number;
  yards: number;
  duration: number;
  passAttempt: boolean;
  completion: boolean;
  rush: boolean;
  carrier: OffSlot | DefSlot | null;
  turnover: boolean;
  defenseCall: string;
  description: string;
}

export interface SimOptions {
  play: PlayData;
  defense: DefenseCall;
  offenseTeam: TeamData;
  defenseTeam: TeamData;
  ballX: number;
  /** Line of scrimmage (yards from the offense's own goal line). */
  los: number;
  difficulty: DifficultyConfig;
  seed: number;
}

interface Engagement {
  blocker: number;
  defender: number;
  t: number;
}

const SPEED = (r: number) => 4.8 + 5.0 * (r / 100);

export class PlaySim {
  readonly actors: Actor[] = [];
  readonly ball: Ball;
  readonly play: PlayData;
  readonly defense: DefenseCall;
  readonly los: number;
  readonly ballX: number;
  readonly diff: DifficultyConfig;
  t = 0;
  result: PlayResult | null = null;
  /** Which actor the user currently controls (QB, then the ball carrier). */
  controlledId: number;
  pressure = 0;
  charge = 0;
  charging = false;

  private rng: Rng;
  private steps = 0;
  private events: PlayEvent[] = [];
  private engagements: Engagement[] = [];
  private passBlock = new Map<number, number>();
  private shedFrom = new Map<number, { blocker: number; until: number }>();
  private throwArmed = false;
  private keep = false;
  private passThrown = false;
  private handedOff = false;
  private runRecognizedAt = Infinity;
  private throwAt = Infinity;
  private pitched = false;
  private jukeUntil = 0;
  private jukeCooldown = 0;
  private carrierPath: Vec2[] = [];
  private carrierIdx = 0;
  private bySlot = new Map<string, Actor>();

  constructor(opts: SimOptions) {
    this.play = opts.play;
    this.defense = opts.defense;
    this.los = opts.los;
    this.ballX = opts.ballX;
    this.diff = opts.difficulty;
    this.rng = new Rng(opts.seed);
    this.setupOffense(opts.offenseTeam);
    this.setupDefense(opts.defenseTeam);
    const qb = this.get('QB');
    this.controlledId = qb.id;
    const center = this.get('C');
    const underCenter = dist(qb.pos, center.pos) < 1.5;
    this.ball = {
      state: underCenter ? 'held' : 'air',
      holder: underCenter ? qb.id : null,
      pos: { ...center.pos },
      h: 0.3,
      prevPos: { ...center.pos },
      prevH: 0.3,
      flight: null,
      looseVel: { x: 0, y: 0, h: 0 },
    };
    if (!underCenter) this.launchLateral(center.pos, qb, 0.4);
    this.assignPassProtection();
    this.emit('snap');
  }

  // ---------------------------------------------------------------- setup

  private addActor(side: Side, slot: OffSlot | DefSlot, player: PlayerData, pos: Vec2): Actor {
    const r = player.ratings;
    const a: Actor = {
      id: this.actors.length,
      side,
      slot,
      position: player.position,
      player,
      pos: { ...pos },
      prevPos: { ...pos },
      vel: v2(),
      facing: side === 'off' ? 0 : Math.PI,
      maxSpeed: SPEED(r.speed),
      accel: 9 + 6 * (r.speed / 100),
      routeIdx: 0,
      reaction: 0,
      coverOffset: v2(),
      blockCooldown: 0,
      tackleCooldown: 0,
      down: false,
      history: [],
    };
    this.actors.push(a);
    this.bySlot.set(`${side}:${slot}`, a);
    return a;
  }

  get(slot: OffSlot): Actor {
    return this.bySlot.get(`off:${slot}`)!;
  }

  getDef(slot: DefSlot): Actor {
    return this.bySlot.get(`def:${slot}`)!;
  }

  private setupOffense(team: TeamData) {
    const f = FORMATIONS[this.play.formation];
    for (const slot of OFF_SLOTS) {
      const [dx, dy] = f[slot];
      const wide = slot.startsWith('WR');
      const x = wide ? clamp(this.ballX + dx, -FIELD.halfWidth + 2.5, FIELD.halfWidth - 2.5) : this.ballX + dx;
      const a = this.addActor('off', slot, playerFor(team, slot), v2(x, this.los + dy));
      if ((ELIGIBLE as readonly string[]).includes(slot)) {
        a.route = buildRoute(this.play.routes[slot as EligibleSlot], a.pos, this.ballX);
      }
    }
    const rb = this.get('RB');
    const run = this.play.run;
    if (run) {
      const aimX = this.ballX + run.aim;
      this.carrierPath =
        run.style === 'toss'
          ? [v2(this.ballX + run.aim * 0.55, this.los - 4.5), v2(aimX, this.los - 1.5), v2(aimX + Math.sign(run.aim), this.los + 40)]
          : [v2(aimX, this.los + 0.5), v2(aimX + run.aim * 0.15, this.los + 40)];
      if (run.style === 'toss') rb.route = { type: 'flat', points: this.carrierPath.slice(0, 2), continues: true, delay: 0, blocks: false };
    }
  }

  private setupDefense(team: TeamData) {
    const L = this.los;
    const bx = this.ballX;
    const base: Record<DefSlot, Vec2> = {
      DE1: v2(bx - 3.8, L + 1), DT1: v2(bx - 1.0, L + 1), DT2: v2(bx + 1.0, L + 1), DE2: v2(bx + 3.8, L + 1),
      LB1: v2(bx - 2.5, L + 4.5), LB2: v2(bx + 2.5, L + 4.5),
      CB1: v2(this.get('WR1').pos.x, L + 6), CB2: v2(this.get('WR2').pos.x, L + 6),
      NB: v2(this.get('WR3').pos.x, L + 5), FS: v2(bx - 6, L + 12), SS: v2(bx + 6, L + 10),
    };
    const press = this.defense.shell === 'cover0' || this.defense.shell === 'cover1' || this.defense.shell === 'cover2man';
    for (const slot of DEF_SLOTS) {
      const asg = this.defense.assignments[slot];
      let p = base[slot];
      if (asg.kind === 'man') {
        const r = this.get(asg.target).pos;
        const inward = Math.sign(bx - r.x) || 1;
        const isDB = slot === 'CB1' || slot === 'CB2' || slot === 'NB';
        p = v2(r.x + inward * (isDB ? 0.8 : 1.2), L + (isDB ? (press ? 1.8 : 5) : 4.5));
        if (asg.target === 'RB') p = base[slot];
      } else if (asg.kind === 'zone') {
        const z = ZONES[asg.zone];
        if (slot === 'CB1' || slot === 'CB2') {
          p = v2(base[slot].x + (Math.sign(bx - base[slot].x) || 1) * 1, L + (z.deep ? 7 : 3.5));
        } else if (z.deep) {
          p = v2(bx * 0.5 + z.x * 0.8, L + 12);
        } else if (slot === 'NB' || slot === 'SS' || slot === 'FS') {
          p = v2(bx + z.x * 0.75, L + 5.5);
        }
      } else if (asg.kind === 'rush' && !slot.startsWith('D')) {
        p = v2(base[slot].x * 0.7 + bx * 0.3, L + (slot.startsWith('LB') ? 3.5 : 5.5));
      }
      p.x = clamp(p.x, -FIELD.halfWidth + 1, FIELD.halfWidth - 1);
      const a = this.addActor('def', slot, playerFor(team, slot), p);
      a.assignment = asg;
      a.reaction = this.diff.reactionTime * this.rng.range(0.8, 1.25) * (1.15 - a.player.ratings.awareness / 400);
      const e = this.diff.coverageError * (1.2 - a.player.ratings.coverage / 100);
      a.coverOffset = v2(this.rng.normal() * e, this.rng.normal() * e);
    }
  }

  private assignPassProtection() {
    if (this.play.run) return;
    const qb = this.get('QB');
    const rushers = this.actors
      .filter((a) => a.side === 'def' && a.assignment?.kind === 'rush')
      .sort((a, b) => Math.abs(a.pos.x - this.ballX) - Math.abs(b.pos.x - this.ballX));
    const blockers = OL_SLOTS.map((s) => this.get(s));
    for (const s of ELIGIBLE) {
      const a = this.get(s);
      if (a.route?.blocks) blockers.push(a);
    }
    const free = new Set(blockers.map((b) => b.id));
    for (const r of rushers) {
      let best: Actor | null = null;
      for (const b of blockers) {
        if (!free.has(b.id)) continue;
        if (!best || dist(b.pos, r.pos) < dist(best.pos, r.pos)) best = b;
      }
      if (best) {
        this.passBlock.set(best.id, r.id);
        free.delete(best.id);
      }
    }
    // Leftover OL double-team the rusher nearest the QB's launch point.
    for (const id of free) {
      const b = this.actors[id];
      if (b.position !== 'OL' || rushers.length === 0) continue;
      const r = rushers.reduce((m, x) => (dist(x.pos, b.pos) < dist(m.pos, b.pos) ? x : m));
      if (dist(r.pos, qb.pos) < 12) this.passBlock.set(b.id, r.id);
    }
  }

  // ---------------------------------------------------------------- helpers

  private emit(type: PlayEventType, actor?: number) {
    this.events.push({ t: this.t, type, actor });
  }

  drainEvents(): PlayEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  get carrier(): Actor | null {
    return this.ball.state === 'held' && this.ball.holder !== null ? this.actors[this.ball.holder] : null;
  }

  /** Position `delay` seconds ago, as perceived by a reacting defender. */
  perceived(a: Actor, delay: number): Vec2 {
    const back = Math.min(a.history.length - 1, Math.round(delay / SIM_DT));
    if (back <= 0) return a.pos;
    return a.history[a.history.length - 1 - back];
  }

  private isEngaged(a: Actor): Engagement | undefined {
    return this.engagements.find((e) => e.defender === a.id || e.blocker === a.id);
  }

  private engagersOf(d: Actor): number {
    let n = 0;
    for (const e of this.engagements) if (e.defender === d.id) n++;
    return n;
  }

  /** Throw window for the HUD charge meter (null when no target selected). */
  throwInfo(target: EligibleSlot | null): { window: ThrowWindow | null; charge: number; charging: boolean } {
    const qb = this.get('QB');
    let win: ThrowWindow | null = null;
    if (target) win = throwWindow(dist(qb.pos, this.get(target).pos), this.diff.throwWindow);
    return { window: win, charge: this.charge, charging: this.charging };
  }

  canThrow(): boolean {
    const qb = this.get('QB');
    return !this.result && this.ball.state === 'held' && this.ball.holder === qb.id && qb.pos.y <= this.los + 0.2;
  }

  // ---------------------------------------------------------------- step

  step(input: SimInput, dt = SIM_DT) {
    for (const a of this.actors) a.prevPos = { ...a.pos };
    this.ball.prevPos = { ...this.ball.pos };
    this.ball.prevH = this.ball.h;
    if (this.result) {
      this.stepAfterWhistle(dt);
      return;
    }
    this.t += dt;
    this.steps++;
    if (!input.throwHeld) this.throwArmed = true;
    this.jukeCooldown = Math.max(0, this.jukeCooldown - dt);

    const desired = new Map<number, Vec2>();
    this.controlUser(input, desired);
    this.offenseAI(desired);
    this.defenseAI(desired);
    this.updateEngagements(dt, desired);
    this.integrate(dt, desired);
    this.separate();
    this.updateBall(dt);
    if (!this.result) this.handleThrowing(input);
    if (!this.result) this.checkTackles();
    if (!this.result) this.checkBoundaries();
    if (!this.result && this.t > MAX_PLAY_TIME) {
      const c = this.carrier;
      this.finish(c ? 'tackle' : 'incomplete', c ?? this.get('QB'));
    }
    this.updatePressure();
    for (const a of this.actors) {
      a.history.push({ ...a.pos });
      if (a.history.length > HISTORY) a.history.shift();
      a.blockCooldown = Math.max(0, a.blockCooldown - dt);
      a.tackleCooldown = Math.max(0, a.tackleCooldown - dt);
    }
  }

  private stepAfterWhistle(dt: number) {
    for (const a of this.actors) {
      a.vel = scale(a.vel, Math.max(0, 1 - dt * 3));
      a.pos = add(a.pos, scale(a.vel, dt));
    }
    const b = this.ball;
    if (b.state === 'held' && b.holder !== null) this.syncHeldBall();
    else if (b.h > 0.12) {
      b.pos = add(b.pos, scale(b.looseVel, dt));
      b.looseVel.h -= THROW.gravity * dt;
      b.h = Math.max(0.12, b.h + b.looseVel.h * dt);
    }
  }

  // ---------------------------------------------------------------- user control

  private controlUser(input: SimInput, desired: Map<number, Vec2>) {
    const qb = this.get('QB');
    const c = this.carrier;
    const controlled = c && c.side === 'off' ? c : this.passThrown || this.handedOff ? null : qb;
    this.controlledId = controlled ? controlled.id : -1;
    if (!controlled) return;

    let move = clampLen(input.move, 1);
    if (controlled !== qb && len(move) < 0.15) {
      // Ball carriers auto-run their designed path, then straight upfield.
      move = this.autoRunDirection(controlled);
    }
    let v = scale(move, controlled.maxSpeed * (controlled === qb ? 1 : 0.9));
    if (controlled === qb && v.y < 0) v = scale(v, 0.9); // backpedal / drop
    if (input.juke && this.jukeCooldown <= 0 && (controlled !== qb || this.pastLos(qb))) {
      const side = Math.abs(move.x) > 0.2 ? Math.sign(move.x) : this.rng.chance(0.5) ? 1 : -1;
      controlled.vel = add(controlled.vel, v2(side * 4.5, 0));
      this.jukeUntil = this.t + 0.45;
      this.jukeCooldown = 1.4;
      this.emit('juke', controlled.id);
    }
    desired.set(controlled.id, v);
    if (controlled === qb) {
      qb.facing = input.gazeYaw;
      if (this.ball.holder === qb.id && this.pastLos(qb) && !this.handedOff && this.runRecognizedAt === Infinity) {
        this.runRecognizedAt = this.t;
        this.emit('scramble', qb.id);
      }
    }

    // Handoff: on run plays automatically when the RB arrives, or on demand.
    const rb = this.get('RB');
    if (this.ball.state === 'held' && this.ball.holder === qb.id && !this.pastLos(qb)) {
      const close = dist(qb.pos, rb.pos) < 1.4;
      const auto = this.play.run?.style === 'handoff' && !this.keep && this.t > 0.15;
      if (close && (auto || input.handoff)) this.handoff(rb);
      if (this.play.run?.style === 'toss' && !this.pitched && this.t > 0.25 && !this.keep) {
        this.pitched = true;
        this.launchLateral(qb.pos, rb, 0.45);
        this.emit('pitch', rb.id);
      }
    }
  }

  private pastLos(a: Actor) {
    return a.pos.y > this.los + 0.3;
  }

  private autoRunDirection(a: Actor): Vec2 {
    while (this.carrierIdx < this.carrierPath.length && a.slot === 'RB') {
      const p = this.carrierPath[this.carrierIdx];
      if (dist(a.pos, p) < 1.2 || p.y < a.pos.y - 0.5) this.carrierIdx++;
      else return norm(sub(p, a.pos));
    }
    return v2(0, 1);
  }

  private handoff(rb: Actor) {
    this.ball.holder = rb.id;
    this.controlledId = rb.id;
    this.handedOff = true;
    this.runRecognizedAt = this.t;
    this.carrierIdx = 0;
    this.emit('handoff', rb.id);
  }

  private handleThrowing(input: SimInput) {
    const qb = this.get('QB');
    if (!this.canThrow()) {
      this.charging = false;
      this.charge = 0;
      return;
    }
    if (input.throwHeld && this.throwArmed) {
      if (this.play.run && !this.handedOff) this.keep = true;
      this.charging = true;
      this.charge = Math.min(1.25, this.charge + SIM_DT / THROW.chargeTime);
      return;
    }
    if (this.charging && !input.throwHeld) {
      this.charging = false;
      if (this.charge > 0.04) this.throwBall(qb, input);
      this.charge = 0;
    }
  }

  private throwBall(qb: Actor, input: SimInput) {
    const target = input.target ? this.get(input.target) : null;
    const tgtPos = target ? target.pos : add(qb.pos, fromHeading(input.gazeYaw, 8 + this.charge * 40));
    const sol = computeThrow({
      from: qb.pos,
      target: tgtPos,
      targetVel: target ? target.vel : v2(),
      charge: Math.min(1, this.charge) - Math.max(0, this.charge - 1) * 2, // holding too long hurts
      pressure: this.pressure,
      accuracy: qb.player.ratings.throwAccuracy,
      power: qb.player.ratings.throwPower,
      qbSpeed: len(qb.vel),
      windowScale: this.diff.throwWindow,
      rng: this.rng,
    });
    this.ball.state = 'air';
    this.ball.holder = null;
    this.ball.h = THROW.releaseHeight;
    this.ball.flight = {
      from: { ...qb.pos },
      t: 0,
      T: sol.flightTime,
      vel: sol.vel,
      landing: sol.landing,
      targetId: target ? target.id : null,
      lateral: false,
      quality: sol.quality,
      speed: sol.speed,
      tipChecked: new Set(),
    };
    this.passThrown = true;
    this.throwAt = this.t;
    this.emit('throw', target?.id);
  }

  private launchLateral(from: Vec2, to: Actor, T: number) {
    this.ball.state = 'air';
    this.ball.holder = null;
    this.ball.flight = {
      from: { ...from }, t: 0, T, vel: { x: 0, y: 0, h: 0 }, landing: { ...to.pos }, targetId: to.id,
      lateral: true, quality: 1, speed: 0, tipChecked: new Set(),
    };
  }

  // ---------------------------------------------------------------- offense AI

  private offenseAI(desired: Map<number, Vec2>) {
    const qb = this.get('QB');
    const carrier = this.carrier;
    const flight = this.ball.state === 'air' ? this.ball.flight : null;
    for (const a of this.actors) {
      if (a.side !== 'off' || desired.has(a.id) || a.down) continue;
      if (a === qb) {
        desired.set(a.id, v2());
        continue;
      }
      // Pass target tracks the ball.
      if (flight && !flight.lateral && flight.targetId === a.id) {
        desired.set(a.id, this.seek(a, flight.landing, 1));
        continue;
      }
      if (flight && flight.lateral && flight.targetId === a.id && a.route) {
        desired.set(a.id, this.followRoute(a));
        continue;
      }
      if (a.position === 'OL') {
        desired.set(a.id, this.play.run || this.handedOff || (carrier && carrier !== qb) ? this.runBlock(a) : this.passPro(a));
        continue;
      }
      // Eligible receivers.
      if (a.slot === 'RB' && this.play.run && !this.handedOff && this.play.run.style === 'handoff') {
        if (this.t < (a.route?.delay ?? 0)) { desired.set(a.id, v2()); continue; }
        const side = Math.sign(this.play.run.aim) || 1;
        desired.set(a.id, this.seek(a, add(qb.pos, v2(side * 0.5, 0.2)), 0.85));
        continue;
      }
      if (a.slot === 'RB' && this.play.run?.style === 'toss' && !this.handedOff) {
        desired.set(a.id, this.followRoute(a));
        continue;
      }
      if (a.slot === 'RB' && a.route?.type === 'fake' && this.t < 1.1) {
        desired.set(a.id, this.seek(a, add(qb.pos, v2(0.9, 0.6)), 0.8));
        continue;
      }
      const afterCatch = carrier && carrier.side === 'off' && carrier !== qb;
      if (afterCatch || this.handedOff || this.play.run) {
        desired.set(a.id, this.runBlock(a));
        continue;
      }
      if (a.route?.blocks) {
        const checkRelease = a.route.type === 'check' && this.t > 1.5 && !this.isEngaged(a);
        if (checkRelease) {
          a.route = buildRoute({ route: 'flat' }, a.pos, this.ballX);
          a.route.points.forEach((p) => (p.y = Math.max(p.y, this.los + 1.5)));
        } else {
          desired.set(a.id, this.passPro(a));
          continue;
        }
      }
      desired.set(a.id, this.followRoute(a));
    }
  }

  private followRoute(a: Actor): Vec2 {
    const r = a.route!;
    if (this.t < r.delay) return v2();
    while (a.routeIdx < r.points.length && dist(a.pos, r.points[a.routeIdx]) < 0.7) a.routeIdx++;
    if (a.routeIdx < r.points.length) return this.seek(a, r.points[a.routeIdx], 1);
    if (r.continues && r.points.length > 0) {
      const last = r.points[r.points.length - 1];
      const prev = r.points.length > 1 ? r.points[r.points.length - 2] : a.pos;
      return scale(norm(sub(last, prev)), a.maxSpeed);
    }
    // Settled routes (curl/hitch/flat): drift slightly to stay open.
    return v2(0, 0);
  }

  private seek(a: Actor, target: Vec2, speedFrac: number): Vec2 {
    const d = sub(target, a.pos);
    const l = len(d);
    if (l < 0.05) return v2();
    const s = Math.min(a.maxSpeed * speedFrac, l * 4);
    return scale(d, s / l);
  }

  private passPro(b: Actor): Vec2 {
    const qb = this.get('QB');
    if (this.isEngaged(b)) return v2(); // engagement code positions engaged blockers
    let rid = this.passBlock.get(b.id);
    let r = rid !== undefined ? this.actors[rid] : null;
    if (!r || r.down) {
      // Find an unblocked rusher threatening the QB.
      r = null;
      for (const d of this.actors) {
        if (d.side !== 'def' || d.down || d.assignment?.kind !== 'rush') continue;
        if (this.engagersOf(d) > 0) continue;
        if (dist(d.pos, b.pos) > 4) continue;
        if (!r || dist(d.pos, qb.pos) < dist(r.pos, qb.pos)) r = d;
      }
      if (r) this.passBlock.set(b.id, r.id);
    }
    if (!r) {
      const home = v2(b.pos.x, Math.max(qb.pos.y + 1.5, this.los - 2.2));
      return this.seek(b, home, 0.5);
    }
    const spot = add(r.pos, scale(norm(sub(qb.pos, r.pos)), 0.9));
    this.tryEngage(b, r);
    return this.seek(b, spot, 1);
  }

  private runBlock(b: Actor): Vec2 {
    if (this.isEngaged(b)) return v2();
    const carrier = this.carrier ?? this.get('RB');
    let best: Actor | null = null;
    let bestScore = Infinity;
    for (const d of this.actors) {
      if (d.side !== 'def' || d.down) continue;
      const dd = dist(d.pos, b.pos);
      if (dd > 7 || d.pos.y < b.pos.y - 1.5) continue;
      const score = dd + this.engagersOf(d) * 4 + dist(d.pos, carrier.pos) * 0.3;
      if (score < bestScore) {
        best = d;
        bestScore = score;
      }
    }
    if (!best) return this.seek(b, add(b.pos, v2(0, 3)), 0.6);
    this.tryEngage(b, best);
    const spot = add(best.pos, scale(norm(sub(carrier.pos, best.pos)), 0.8));
    return this.seek(b, spot, 1);
  }

  private tryEngage(b: Actor, d: Actor) {
    if (b.blockCooldown > 0 || d.down || dist(b.pos, d.pos) > 1.15) return;
    const shed = this.shedFrom.get(d.id);
    if (shed && shed.blocker === b.id && shed.until > this.t) return;
    if (this.engagersOf(d) >= 2) return;
    const c = this.carrier;
    if (c === d || (c && c.side === 'off' && dist(c.pos, d.pos) < 1.6)) return;
    this.engagements.push({ blocker: b.id, defender: d.id, t: 0 });
  }

  // ---------------------------------------------------------------- defense AI

  private defenseAI(desired: Map<number, Vec2>) {
    const qb = this.get('QB');
    const carrier = this.carrier;
    const flight = this.ball.state === 'air' && this.ball.flight && !this.ball.flight.lateral ? this.ball.flight : null;
    const runMode = carrier && carrier.side === 'off' && (carrier !== qb || this.runRecognizedAt < Infinity);
    for (const d of this.actors) {
      if (d.side !== 'def' || d.down || desired.has(d.id)) continue;
      const asg = d.assignment!;
      const isDeep = asg.kind === 'zone' && ZONES[asg.zone].deep;
      let goal: Vec2;
      let urgency = 1;

      if (carrier && carrier.side === 'def') {
        goal = d.pos;
      } else if (runMode && this.t > this.runRecognizedAt + d.reaction + (isDeep ? 0.35 : 0)) {
        goal = this.pursuit(d, carrier!);
      } else if (flight && this.t > this.throwAt + d.reaction) {
        const timeLeft = flight.T - flight.t;
        const canReach = dist(d.pos, flight.landing) / d.maxSpeed < timeLeft + 0.6;
        goal = canReach ? flight.landing : add(flight.landing, scale(norm(sub(d.pos, flight.landing)), 2));
      } else if (this.play.playAction && this.t < this.diff.playActionBite && !isDeep && asg.kind !== 'rush' && d.position !== 'CB') {
        goal = v2(d.pos.x * 0.9 + this.ballX * 0.1, this.los + 1.5);
        urgency = 0.55;
      } else {
        goal = this.coverageGoal(d, asg, qb);
        if (asg.kind === 'zone') urgency = 0.9;
      }
      if (asg.kind !== 'rush' && this.t < d.reaction && !(asg.kind === 'man')) goal = d.pos; // read step
      desired.set(d.id, this.seek(d, goal, urgency));
    }
  }

  /** Aim at the interception point of the (perceived) ball carrier's path. */
  private pursuit(d: Actor, c: Actor): Vec2 {
    const p = this.perceived(c, d.reaction * 0.5);
    const v = this.perceivedVel(c, d.reaction * 0.5);
    const r = sub(p, d.pos);
    if (len(r) < 4) return add(c.pos, scale(c.vel, 0.25)); // close: go straight for the tackle
    const s = d.maxSpeed * 0.97;
    const a = v.x * v.x + v.y * v.y - s * s;
    const b = 2 * (r.x * v.x + r.y * v.y);
    const cc = r.x * r.x + r.y * r.y;
    let t = 1;
    if (Math.abs(a) < 1e-6) t = b < 0 ? -cc / b : 1;
    else {
      const disc = b * b - 4 * a * cc;
      if (disc >= 0) {
        const sq = Math.sqrt(disc);
        const t1 = (-b - sq) / (2 * a);
        const t2 = (-b + sq) / (2 * a);
        t = Math.min(...[t1, t2].filter((x) => x > 0), 2);
      }
    }
    t = clamp(t, 0, 2);
    return add(add(p, scale(v, t)), scale(d.coverOffset, 0.2));
  }

  private perceivedVel(a: Actor, delay: number): Vec2 {
    const p1 = this.perceived(a, delay);
    const p0 = this.perceived(a, delay + 0.1);
    return scale(sub(p1, p0), 10);
  }

  private coverageGoal(d: Actor, asg: DefAssignment, qb: Actor): Vec2 {
    switch (asg.kind) {
      case 'rush':
        return qb.pos;
      case 'spy':
        return v2(qb.pos.x, Math.max(this.los + 4, qb.pos.y + 5));
      case 'man': {
        const r = this.get(asg.target);
        if (r.route?.blocks && !(r.route.type === 'check' && this.t > 1.5)) {
          // Receiver stayed in to block: become a spy / green-dog rusher.
          return this.t > 1.2 ? qb.pos : v2(qb.pos.x, this.los + 4);
        }
        const seen = this.perceived(r, d.reaction);
        const vel = this.perceivedVel(r, d.reaction);
        const inward = Math.sign(this.ballX - seen.x) || 1;
        const cushion = d.position === 'CB' ? 0.9 : 0.6;
        return add(add(seen, scale(vel, 0.35)), v2(inward * 0.5 + d.coverOffset.x, cushion + d.coverOffset.y * 0.5));
      }
      case 'zone': {
        const z = ZONES[asg.zone];
        const land = v2(clamp(this.ballX * 0.5 + z.x, -FIELD.halfWidth + 2, FIELD.halfWidth - 2), this.los + z.y);
        let threat: Actor | null = null;
        let best = Infinity;
        for (const s of ELIGIBLE) {
          const r = this.get(s);
          if (r.route?.blocks) continue;
          const seen = this.perceived(r, d.reaction);
          const dx = Math.abs(seen.x - land.x);
          if (dx > z.w) continue;
          if (z.deep ? seen.y < this.los + 7 : seen.y > this.los + 16 || seen.y < this.los - 1) continue;
          const score = dist(seen, land);
          if (score < best) {
            best = score;
            threat = r;
          }
        }
        if (!threat) return add(land, d.coverOffset);
        const seen = this.perceived(threat, d.reaction);
        if (z.deep) {
          const vel = this.perceivedVel(threat, d.reaction);
          return v2(land.x * 0.3 + seen.x * 0.7 + d.coverOffset.x, Math.max(land.y, seen.y + 4 + Math.max(0, vel.y) * 0.45));
        }
        return add(lerp(land, add(seen, v2(0, 0.8)), 0.7), d.coverOffset);
      }
    }
  }

  // ---------------------------------------------------------------- engagements & motion

  private updateEngagements(dt: number, desired: Map<number, Vec2>) {
    const qb = this.get('QB');
    const carrier = this.carrier ?? qb;
    const keep: Engagement[] = [];
    for (const e of this.engagements) {
      const b = this.actors[e.blocker];
      const d = this.actors[e.defender];
      e.t += dt;
      if (b.down || d.down || this.carrier === d || dist(b.pos, d.pos) > 2.2) continue;
      const rushing = !this.handedOff && !this.play.run && !(this.carrier && this.carrier !== qb) && !this.passThrown;
      const dr = d.player.ratings;
      const br = b.player.ratings;
      const defStat = rushing ? (dr.passRush * 2 + dr.strength) / 3 : (dr.tackling + dr.strength) / 2;
      const blkStat = (br.blocking * 2 + br.strength) / 3;
      const n = this.engagersOf(d);
      const ratio = defStat / Math.max(20, blkStat);
      // Hazard grows linearly with time engaged: pressure builds the longer the QB holds it.
      const rate = (rushing ? 0.05 * e.t : 0.05 + 0.08 * e.t) * ratio * ratio * ratio * this.diff.passRush / n;
      if (this.rng.chance(rate * dt)) {
        this.shedFrom.set(d.id, { blocker: b.id, until: this.t + 1.2 });
        b.blockCooldown = 0.8;
        this.emit('shed', d.id);
        continue;
      }
      keep.push(e);
      // Defender fights toward his goal slowly; blocker mirrors in front.
      const goalVel = desired.get(d.id) ?? v2();
      const push = clamp(0.35 + (defStat - blkStat) / 45, 0.08, 1.2) * this.diff.passRush / n;
      let dv = scale(norm(goalVel), push * (rushing ? 1 + e.t * 0.25 : 0.8));
      if (!rushing) {
        // Drive block: push the defender away from the ball carrier.
        const away = norm(sub(d.pos, carrier.pos));
        dv = add(dv, scale(away, clamp((blkStat - defStat) / 40 + 0.3, 0, 0.9)));
      }
      desired.set(d.id, dv);
      const front = add(d.pos, scale(norm(sub(rushing ? qb.pos : carrier.pos, d.pos)), 0.85));
      desired.set(b.id, scale(sub(front, b.pos), 8));
    }
    this.engagements = keep;
  }

  private integrate(dt: number, desired: Map<number, Vec2>) {
    for (const a of this.actors) {
      if (a.down) {
        a.vel = v2();
        continue;
      }
      const want = clampLen(desired.get(a.id) ?? v2(), a.maxSpeed);
      const dv = clampLen(sub(want, a.vel), a.accel * dt);
      a.vel = add(a.vel, dv);
      a.pos = add(a.pos, scale(a.vel, dt));
      const sp = len(a.vel);
      if (sp > 0.5 && !(a.slot === 'QB' && a.side === 'off' && this.controlledId === a.id)) {
        a.facing = Math.atan2(a.vel.x, a.vel.y);
      }
    }
  }

  private separate() {
    const n = this.actors.length;
    const c = this.carrier;
    for (let i = 0; i < n; i++) {
      const a = this.actors[i];
      if (a.down) continue;
      for (let j = i + 1; j < n; j++) {
        const b = this.actors[j];
        if (b.down) continue;
        const d = dist(a.pos, b.pos);
        if (d >= 0.7 || d < 1e-6) continue;
        if (c && (a === c || b === c) && a.side !== b.side) continue; // tackle contact handled separately
        const push = scale(norm(sub(a.pos, b.pos)), (0.7 - d) / 2);
        a.pos = add(a.pos, push);
        b.pos = sub(b.pos, push);
      }
    }
  }

  // ---------------------------------------------------------------- ball

  private syncHeldBall() {
    const h = this.actors[this.ball.holder!];
    this.ball.pos = add(h.pos, fromHeading(h.facing, 0.35));
    this.ball.h = 1.15;
  }

  private updateBall(dt: number) {
    const b = this.ball;
    if (b.state === 'held') {
      this.syncHeldBall();
      return;
    }
    if (b.state === 'loose' || !b.flight) return;
    const f = b.flight;
    f.t += dt;
    if (f.lateral) {
      const tgt = this.actors[f.targetId!];
      const k = clamp(f.t / f.T, 0, 1);
      b.pos = lerp(f.from, tgt.pos, k);
      b.h = 0.6 + Math.sin(k * Math.PI) * 0.6 + k * 0.5;
      if (k >= 1) {
        b.state = 'held';
        b.holder = tgt.id;
        b.flight = null;
        if (tgt.slot !== 'QB') this.controlledId = tgt.id;
        if (tgt.slot === 'RB' && this.play.run) {
          this.handedOff = true;
          this.runRecognizedAt = this.t;
          this.carrierIdx = 1;
        }
        this.syncHeldBall();
      }
      return;
    }
    b.pos = v2(f.from.x + f.vel.x * f.t, f.from.y + f.vel.y * f.t);
    b.h = ballHeightAt(f.vel.h, f.t);

    // Tipped / undercut passes along the flight path.
    if (f.t < f.T - 0.12 && b.h < 3.1) {
      for (const d of this.actors) {
        if (d.side !== 'def' || d.down || f.tipChecked.has(d.id)) continue;
        if (dist(d.pos, b.pos) > 0.9) continue;
        f.tipChecked.add(d.id);
        const p = clamp(0.3 * (d.player.ratings.coverage / 80) * this.diff.ballSkills * (b.h < 2.4 ? 1 : 0.5), 0.02, 0.6);
        if (this.rng.chance(p)) {
          if (this.rng.chance(0.3 * this.diff.ballSkills)) {
            this.finishInterception(d);
          } else {
            this.emit('deflection', d.id);
            this.incomplete(b.pos);
          }
          return;
        }
      }
    }
    if (f.t >= f.T) this.resolveArrival(f);
  }

  private resolveArrival(f: Flight) {
    const toCand = (a: Actor): CatchCandidate => ({
      id: a.id, pos: a.pos, catching: a.player.ratings.catching, coverage: a.player.ratings.coverage,
    });
    const offense = ELIGIBLE.map((s) => this.get(s)).filter((a) => !a.down).map(toCand);
    const defense = this.actors.filter((a) => a.side === 'def' && !a.down).map(toCand);
    const out = resolveCatch({
      landing: f.landing, quality: f.quality, speed: f.speed, offense, defense,
      ballSkills: this.diff.ballSkills, rng: this.rng,
    });
    const b = this.ball;
    switch (out.kind) {
      case 'catch': {
        const r = this.actors[out.id];
        if (Math.abs(f.landing.x) > FIELD.halfWidth || f.landing.y > FIELD.length + FIELD.endzone) {
          this.incomplete(f.landing);
          return;
        }
        b.state = 'held';
        b.holder = r.id;
        b.flight = null;
        r.pos = lerp(r.pos, f.landing, 0.5);
        this.runRecognizedAt = this.t;
        this.controlledId = r.id;
        this.emit('catch', r.id);
        this.syncHeldBall();
        return;
      }
      case 'interception':
        this.finishInterception(this.actors[out.id]);
        return;
      case 'deflection':
      case 'drop':
        this.emit(out.kind, out.id);
        this.incomplete(f.landing);
        return;
      case 'incomplete':
        this.incomplete(f.landing);
    }
  }

  private incomplete(at: Vec2) {
    const f = this.ball.flight;
    this.ball.state = 'loose';
    this.ball.looseVel = f ? { x: f.vel.x * 0.35, y: f.vel.y * 0.35, h: 1.5 } : { x: 0, y: 0, h: 0 };
    this.ball.flight = null;
    this.emit('incomplete');
    this.result = this.makeResult('incomplete', at, null);
  }

  private finishInterception(d: Actor) {
    this.ball.state = 'held';
    this.ball.holder = d.id;
    this.ball.flight = null;
    this.emit('interception', d.id);
    this.result = this.makeResult('interception', d.pos, d);
  }

  // ---------------------------------------------------------------- whistle

  private checkTackles() {
    const c = this.carrier;
    if (!c || c.side !== 'off') return;
    for (const d of this.actors) {
      if (d.side !== 'def' || d.down || d.tackleCooldown > 0) continue;
      if (dist(d.pos, c.pos) > TACKLE_RANGE) continue;
      const engaged = this.isEngaged(d);
      if (engaged && dist(d.pos, c.pos) > 0.85) continue;
      const armTackle = engaged ? 0.3 : 1;
      const tr = d.player.ratings.tackling / 100;
      const elusive = (c.player.ratings.strength + c.player.ratings.speed) / 200;
      let p = (0.5 + 0.38 * tr - 0.22 * elusive) * this.diff.tackling * armTackle;
      if (this.t < this.jukeUntil) p *= 0.4;
      if (c.slot === 'QB' && !this.pastLos(c)) p *= 1.15; // sacks: QB is a sitting duck
      if (this.rng.chance(clamp(p, 0.08, 0.97))) {
        c.down = true;
        d.vel = scale(d.vel, 0.3);
        const sack = c.slot === 'QB' && c.pos.y < this.los && !this.passThrown && !this.handedOff;
        if (c.pos.y <= 0) this.finish('safety', c);
        else this.finish(sack ? 'sack' : 'tackle', c);
        return;
      }
      d.tackleCooldown = 0.5;
      c.vel = scale(c.vel, 0.45);
      this.emit('brokenTackle', d.id);
    }
  }

  private checkBoundaries() {
    const c = this.carrier;
    if (!c || c.side !== 'off') return;
    if (c.pos.y >= FIELD.length) {
      this.finish('touchdown', c);
      return;
    }
    if (Math.abs(c.pos.x) > FIELD.halfWidth || c.pos.y < -FIELD.endzone) {
      this.finish(c.pos.y <= 0 ? 'safety' : 'outOfBounds', c);
    }
  }

  private finish(outcome: PlayOutcome, c: Actor) {
    this.emit(outcome === 'tackle' ? 'tackle' : (outcome as PlayEventType), c.id);
    this.result = this.makeResult(outcome, c.pos, c);
  }

  private makeResult(outcome: PlayOutcome, at: Vec2, c: Actor | null): PlayResult {
    const endY = outcome === 'incomplete' ? this.los : outcome === 'touchdown' ? FIELD.length : clamp(at.y, -FIELD.endzone, FIELD.length);
    const yards = outcome === 'interception' || outcome === 'incomplete' ? 0 : Math.round(endY - this.los);
    const completion = this.passThrown && c !== null && c.side === 'off' && c.slot !== 'QB';
    const res: PlayResult = {
      outcome,
      endX: clamp(at.x, -FIELD.halfWidth, FIELD.halfWidth),
      endY,
      yards,
      duration: this.t,
      passAttempt: this.passThrown,
      completion,
      rush: !this.passThrown && outcome !== 'sack' && outcome !== 'incomplete',
      carrier: c ? c.slot : null,
      turnover: outcome === 'interception',
      defenseCall: this.defense.name,
      description: '',
    };
    res.description = describe(res, c);
    return res;
  }

  private updatePressure() {
    const qb = this.get('QB');
    if (this.ball.holder !== qb.id || this.result) {
      this.pressure = 0;
      return;
    }
    let p = 0;
    const picked = new Set(this.passBlock.values());
    for (const d of this.actors) {
      if (d.side !== 'def' || d.down || d.assignment?.kind !== 'rush') continue;
      const dd = dist(d.pos, qb.pos);
      const engaged = this.engagements.some((e) => e.defender === d.id);
      const free = clamp(1 - (dd - 1.2) / 5, 0, 1);
      // Blocked rushers only count once they are pushing the pocket into the QB.
      const v = engaged ? clamp(1 - (dd - 1) / 3.5, 0, 1) * 0.55 : picked.has(d.id) && this.t < 1 ? free * 0.3 : free;
      p = Math.max(p, v);
    }
    this.pressure = this.pressure + (p - this.pressure) * 0.2;
  }
}

function describe(r: PlayResult, c: Actor | null): string {
  const who = c ? `#${c.player.number} ${c.player.name}` : '';
  const yds = (n: number) => `${Math.abs(n)} yard${Math.abs(n) === 1 ? '' : 's'}`;
  switch (r.outcome) {
    case 'incomplete': return 'Incomplete pass';
    case 'interception': return `Intercepted by ${who}!`;
    case 'sack': return `Sacked for a loss of ${yds(r.yards)}`;
    case 'safety': return 'Safety!';
    case 'touchdown': return `Touchdown! ${who}`;
    case 'outOfBounds':
    case 'tackle': {
      const verb = r.completion ? 'catches it' : 'runs';
      const how = r.outcome === 'outOfBounds' ? ', out of bounds' : '';
      return r.yards >= 0 ? `${who} ${verb} for ${yds(r.yards)}${how}` : `${who} ${verb}, loss of ${yds(r.yards)}${how}`;
    }
  }
}
