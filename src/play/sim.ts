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
import { COVERAGE, CoverageReader, carrySpot, inPhaseSpot, overTop, type Helper, type ReadTarget } from './coverage';
import { inPhase, throwingWindow } from './windows';
import { TACKLE, resolveTackle, type ContactKind } from './tackle';
import { SCREEN, screenTiming, type ScreenTiming } from './screen';
import { nearestOfficial, setupOfficials, updateOfficials, type Official } from './officials';
import { PENALTIES, callFoul, makeFoul, rollFoul, type Flag, type Foul, type FoulType, type PenaltyBias } from './penalties';
import pocketJson from '../data/pocket.json';

export const POCKET = pocketJson.pocket;
export const SCRAMBLE = pocketJson.scramble;

export const SIM_DT = 1 / 60;
const HISTORY = 90;
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
  /** Contact animation the renderer should play (tackles, broken tackles, slides). */
  anim: ContactAnim | null;
}

export interface ContactAnim {
  kind: ContactKind;
  role: 'carrier' | 'tackler';
  /** Sim time the contact started. */
  t: number;
  duration: number;
  /** Carrier went down (vs. broke the tackle). */
  down: boolean;
  /** Heading the contact comes from / falls toward. */
  heading: number;
}

/** A successful tackle in progress: the whistle blows when the carrier hits the turf. */
interface Contact {
  carrier: number;
  tackler: number;
  whistleAt: number;
  sack: boolean;
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
  /** Edge-triggered: QB slides (gives himself up) while scrambling. */
  slide?: boolean;
}

export const idleInput = (): SimInput => ({
  move: v2(), gazeYaw: 0, throwHeld: false, target: null, handoff: false, juke: false, slide: false,
});

/** Where the most dangerous rusher is coming from, for the pocket cue. */
export interface PocketCue {
  /** Field heading from the QB to the rusher (0 = downfield, + = right). */
  heading: number;
  /** 0..1, how close he is to getting home. */
  level: number;
}

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
  /** Screen throws: how well the throw hit the timing window. */
  screen?: ScreenTiming;
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
  | 'scramble' | 'shed' | 'slide' | 'flag';

export interface PlayEvent {
  t: number;
  type: PlayEventType;
  actor?: number;
}

export type PlayOutcome = 'tackle' | 'sack' | 'incomplete' | 'outOfBounds' | 'touchdown' | 'interception' | 'safety' | 'noPlay';

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
  /** Fouls flagged during the play; enforced after the whistle (game/penalties.ts). */
  fouls: Foul[];
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
  /** Penalty chance scale per side (crowd noise etc.); 0 turns fouls off. Default 1. */
  penaltyBias?: PenaltyBias;
}

interface Engagement {
  blocker: number;
  defender: number;
  t: number;
  /** The line doesn't hold perfectly: some reps are lost early, at this engagement time. */
  loseAt: number;
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
  pocketCue: PocketCue | null = null;
  /** QB is running with the ball (out of the pocket or past the LOS). */
  scrambling = false;
  charge = 0;
  charging = false;
  readonly officials: Official[];
  readonly fouls: Foul[] = [];
  readonly flags: Flag[] = [];

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
  readonly coverage: CoverageReader;
  /** Underneath defender id -> vertical receiver id he is carrying. */
  private carry = new Map<number, number>();
  private contact: Contact | null = null;
  /** When the defense has read the screen (Infinity until then). */
  private screenReadAt = Infinity;
  /** Separate stream so turning penalties on or off never changes the football. */
  private penRng: Rng;
  private penaltyBias: PenaltyBias;

  constructor(opts: SimOptions) {
    this.play = opts.play;
    this.defense = opts.defense;
    this.los = opts.los;
    this.ballX = opts.ballX;
    this.diff = opts.difficulty;
    this.rng = new Rng(opts.seed);
    this.setupOffense(opts.offenseTeam);
    this.setupDefense(opts.defenseTeam);
    this.coverage = new CoverageReader(this.diff.coverageRead, this.rng.fork());
    this.penRng = this.rng.fork();
    const bias = opts.penaltyBias ?? { off: 1, def: 1 };
    this.penaltyBias = { off: bias.off * this.diff.penaltyRate, def: bias.def * this.diff.penaltyRate };
    this.officials = setupOfficials(this.los, this.ballX);
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
      anim: null,
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

  /** The RB is next to the QB and the QB still has the ball behind the line: a handoff is possible. */
  canHandoff(): boolean {
    const qb = this.get('QB');
    return !this.result && this.ball.state === 'held' && this.ball.holder === qb.id && !this.pastLos(qb) && !this.passThrown &&
      dist(qb.pos, this.get('RB').pos) < 1.4;
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
    if (this.steps === 0) this.snapFouls();
    if (this.result) return;
    this.t += dt;
    this.steps++;
    if (!input.throwHeld) this.throwArmed = true;
    this.jukeCooldown = Math.max(0, this.jukeCooldown - dt);

    const desired = new Map<number, Vec2>();
    this.controlUser(input, desired);
    this.offenseAI(desired);
    this.updateReads();
    this.defenseAI(desired);
    this.updateEngagements(dt, desired);
    this.integrate(dt, desired);
    this.separate();
    this.updateBall(dt);
    if (!this.result) this.handleThrowing(input);
    if (!this.result) this.checkTackles();
    if (!this.result) this.checkBoundaries();
    if (!this.result && this.contact && this.t >= this.contact.whistleAt) this.whistleContact();
    if (!this.result && this.t > MAX_PLAY_TIME) {
      const c = this.carrier;
      this.finish(c ? 'tackle' : 'incomplete', c ?? this.get('QB'));
    }
    this.updatePressure();
    if (!this.result) this.checkLateHits();
    this.updateOfficials(dt);
    for (const a of this.actors) {
      a.history.push({ ...a.pos });
      if (a.history.length > HISTORY) a.history.shift();
      a.blockCooldown = Math.max(0, a.blockCooldown - dt);
      a.tackleCooldown = Math.max(0, a.tackleCooldown - dt);
    }
  }

  private updateOfficials(dt: number) {
    const c = this.carrier;
    updateOfficials(this.officials, {
      los: this.los, ballX: this.ballX, ball: this.ball.pos, carrier: c && c.side === 'off' && c.slot !== 'QB' ? c.pos : c && this.scrambling ? c.pos : null,
      players: this.actors.map((a) => a.pos), dead: !!this.result,
    }, dt);
  }

  // ---------------------------------------------------------------- penalties

  /**
   * At most one flag per play: the first foul throws it; a later, more severe
   * foul replaces the call (the flag already on the field stands for it), a
   * lesser one is not called. `fouls` therefore never holds more than one.
   */
  private addFoul(type: FoulType, spot: Vec2) {
    const current = this.fouls[0] ?? null;
    const foul = callFoul(current, makeFoul(type, spot, this.t));
    if (foul === current) return;
    this.fouls[0] = foul;
    if (this.flags.length) {
      this.flags[0].foul = foul;
      return;
    }
    const official = nearestOfficial(this.officials, spot);
    const o = this.officials[official];
    this.flags.push({ foul, official, from: { ...o.pos }, to: { ...spot }, t0: this.t + PENALTIES.flag.throwDelay, T: PENALTIES.flag.flightTime });
    this.emit('flag');
  }

  /** Pre-snap fouls: false start kills the play, offside gives a free play. */
  private snapFouls() {
    if (rollFoul('falseStart', this.penaltyBias, this.penRng)) {
      const ol = this.get(this.penRng.pick(OL_SLOTS));
      this.addFoul('falseStart', ol.pos);
      this.result = this.makeResult('noPlay', v2(this.ballX, this.los), null);
      return;
    }
    if (rollFoul('offside', this.penaltyBias, this.penRng)) {
      const d = this.getDef(this.penRng.pick(['DE1', 'DT1', 'DT2', 'DE2'] as const));
      this.addFoul('offside', d.pos);
    }
  }

  /** Roughing the passer: a rusher still arriving at the QB just after the throw. */
  private checkLateHits() {
    if (!this.passThrown || this.t - this.throwAt > PENALTIES.lateHitWindow) return;
    const qb = this.get('QB');
    for (const d of this.actors) {
      if (d.side !== 'def' || d.down || !this.isRushing(d) || dist(d.pos, qb.pos) > 0.9 || len(d.vel) < 3) continue;
      if (d.tackleCooldown > 0) continue;
      d.tackleCooldown = 1;
      if (rollFoul('roughingPasser', this.penaltyBias, this.penRng)) this.addFoul('roughingPasser', qb.pos);
    }
  }

  private stepAfterWhistle(dt: number) {
    // Time keeps running for the presentation only (flags landing, players getting up).
    this.t += dt;
    this.updateOfficials(dt);
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
    if (this.contact) {
      // Going down: momentum carries the runner, the stick does nothing.
      desired.set(controlled.id, controlled.vel);
      return;
    }

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
      const holds = this.ball.holder === qb.id && !this.handedOff && !this.passThrown;
      if (holds && !this.scrambling && this.t > SCRAMBLE.minTime && len(qb.vel) > SCRAMBLE.speedToScramble && qb.vel.y > -1) {
        this.scrambling = true; // out of the pocket: the head follows the running path
      }
      if (holds && this.pastLos(qb) && this.runRecognizedAt === Infinity) {
        this.scrambling = true;
        this.runRecognizedAt = this.t;
        this.emit('scramble', qb.id);
      }
      if (input.slide && holds && this.pastLos(qb) && !this.result) {
        this.slide(qb);
        return;
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

  /** QB gives himself up: down at the spot plus a little slide, no hit. */
  private slide(qb: Actor) {
    const dur = TACKLE.contactTime.slide;
    qb.vel = scale(norm(qb.vel), SCRAMBLE.slideGain / dur);
    qb.anim = { kind: 'slide', role: 'carrier', t: this.t, duration: dur, down: true, heading: Math.atan2(qb.vel.x, qb.vel.y) };
    this.contact = { carrier: qb.id, tackler: -1, whistleAt: this.t + dur, sack: false };
    this.emit('slide', qb.id);
  }

  pastLos(a: Actor) {
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
      screen: this.play.screen && target?.slot === this.play.screen.target ? screenTiming(this.t, this.play.screen) : undefined,
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
      const qbRun = this.runRecognizedAt < Infinity && carrier === qb;
      const scr = this.play.screen;
      if (scr && !(carrier && carrier !== qb) && !qbRun) {
        if ((scr.linemen as string[]).includes(a.slot) && this.t >= scr.release) {
          desired.set(a.id, this.screenConvoy(a, scr.linemen.indexOf(a.slot as never)));
          continue;
        }
        if (scr.stalk?.includes(a.slot as EligibleSlot)) {
          desired.set(a.id, this.runBlock(a, this.get(scr.target)));
          continue;
        }
      }
      if (a.position === 'OL') {
        desired.set(a.id, this.play.run || this.handedOff || (carrier && carrier !== qb) || qbRun ? this.runBlock(a) : this.passPro(a));
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
      if (afterCatch || this.handedOff || this.play.run || qbRun) {
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

  /** Nearest rusher nobody is blocking (within `range` of the blocker). */
  private freeRusher(b: Actor, range: number): Actor | null {
    const qb = this.get('QB');
    let r: Actor | null = null;
    for (const d of this.actors) {
      if (d.side !== 'def' || d.down || !this.isRushing(d)) continue;
      if (this.engagersOf(d) > 0) continue;
      if ([...this.passBlock.entries()].some(([bid, rid]) => rid === d.id && bid !== b.id && !this.actors[bid].down)) continue;
      if (dist(d.pos, b.pos) > range) continue;
      if (!r || dist(d.pos, qb.pos) < dist(r.pos, qb.pos)) r = d;
    }
    return r;
  }

  private passPro(b: Actor): Vec2 {
    const qb = this.get('QB');
    const eng = this.isEngaged(b);
    if (eng) {
      // The second man in a double team peels off to pick up a free rusher.
      const free = this.engagersOf(this.actors[eng.defender]) > 1 ? this.freeRusher(b, 4.5) : null;
      if (!free) return v2(); // engagement code positions engaged blockers
      this.engagements = this.engagements.filter((e) => e !== eng);
      this.passBlock.set(b.id, free.id);
    }
    let rid = this.passBlock.get(b.id);
    let r = rid !== undefined ? this.actors[rid] : null;
    if (!r || r.down || (this.engagersOf(r) > 0 && !this.isEngaged(b))) {
      // Find an unblocked rusher threatening the QB (backs scan further).
      r = this.freeRusher(b, b.position === 'OL' ? 4 : 7);
      if (r) this.passBlock.set(b.id, r.id);
    }
    if (!r) {
      // Backs and tight ends set up beside the QB instead of walking through him.
      const home = b.position === 'OL'
        ? v2(b.pos.x, Math.max(qb.pos.y + 1.5, this.los - 2.2))
        : v2(qb.pos.x + (Math.sign(b.pos.x - qb.pos.x) || 1) * POCKET.backBlockerSide, qb.pos.y + 0.6);
      return this.seek(b, home, 0.5);
    }
    const spot = add(r.pos, scale(norm(sub(qb.pos, r.pos)), 0.9));
    this.tryEngage(b, r);
    return this.seek(b, spot, 1);
  }

  private runBlock(b: Actor, ref?: Actor): Vec2 {
    if (this.isEngaged(b)) return v2();
    const carrier = ref ?? this.carrier ?? this.get('RB');
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

  /**
   * Screen linemen: let their man go at the release, then set up a convoy in
   * front of the catch point and block whoever comes to it.
   */
  private screenConvoy(b: Actor, i: number): Vec2 {
    const scr = this.play.screen!;
    const eng = this.isEngaged(b);
    if (eng && this.t < scr.release + 0.15) {
      this.engagements = this.engagements.filter((e) => e !== eng);
      this.shedFrom.set(eng.defender, { blocker: b.id, until: this.t + 3 });
      if (this.screenReadAt === Infinity) {
        this.screenReadAt = this.t + SCREEN.readDelay * (1 + 1.5 * (1 - this.diff.coverageRead));
      }
    }
    const tgt = this.get(scr.target);
    // Anchor on where the screen is going to be caught, not on the moving receiver.
    const pts = tgt.route?.points ?? [];
    const anchor = pts.length ? pts[pts.length - 1] : tgt.pos;
    const spot = v2(anchor.x + scr.side * (1.5 + i * SCREEN.convoySpacing), Math.max(anchor.y, this.los - 1) + SCREEN.convoyDepth + i * 0.8);
    // Block the first defender coming to the screen from downfield or outside.
    let threat: Actor | null = null;
    for (const d of this.actors) {
      if (d.side !== 'def' || d.down || d.pos.y < this.los - 0.5 || this.engagersOf(d) > 0) continue;
      if (dist(d.pos, b.pos) > 5) continue;
      if (!threat || dist(d.pos, tgt.pos) < dist(threat.pos, tgt.pos)) threat = d;
    }
    if (threat && dist(b.pos, spot) < 4) {
      this.tryEngage(b, threat);
      return this.seek(b, add(threat.pos, scale(norm(sub(tgt.pos, threat.pos)), 0.8)), 1);
    }
    return this.seek(b, spot, 1);
  }

  private tryEngage(b: Actor, d: Actor) {
    if (b.blockCooldown > 0 || d.down || dist(b.pos, d.pos) > 1.15) return;
    const shed = this.shedFrom.get(d.id);
    if (shed && shed.blocker === b.id && shed.until > this.t) return;
    if (this.engagersOf(d) >= 2) return;
    const c = this.carrier;
    if (c === d || (c && c.side === 'off' && dist(c.pos, d.pos) < 1.6)) return;
    const quick = this.rng.chance(POCKET.quickLossChance * this.diff.pocketPressure);
    this.engagements.push({ blocker: b.id, defender: d.id, t: 0, loseAt: quick ? this.rng.range(POCKET.quickLossMin, POCKET.quickLossMax) : Infinity });
  }

  // ---------------------------------------------------------------- defense AI

  /** Route-concept reads: vertical stems, over-the-top help, carries and the shell roll. */
  private updateReads() {
    if (this.play.run || this.passThrown || this.handedOff) return;
    const lag = this.diff.reactionTime;
    const receivers: ReadTarget[] = ELIGIBLE.map((s) => {
      const r = this.get(s);
      return { id: r.id, pos: this.perceived(r, lag), vel: this.perceivedVel(r, lag), maxSpeed: r.maxSpeed, blocks: !!r.route?.blocks };
    });
    const helpers: Helper[] = [];
    const isHelpZone = (z: string) => z === 'deepM' || z === 'deepL' || z === 'deepR';
    for (const d of this.actors) {
      const a = d.assignment;
      if (d.side === 'def' && !d.down && a?.kind === 'zone' && isHelpZone(a.zone)) {
        helpers.push({ id: d.id, homeX: this.ballX * 0.5 + ZONES[a.zone].x });
      }
    }
    const helperIds = new Set(helpers.map((x) => x.id));
    const qb = this.get('QB');
    const others = this.actors.filter((a) => a.side === 'def' && !a.down && !helperIds.has(a.id));
    const danger = (id: number) => throwingWindow(qb.pos, this.actors[id], others).margin;
    this.coverage.update(this.t, this.los, this.ballX, receivers, helpers, danger);

    // Underneath zone defenders carry vertical stems through their zone.
    this.carry.clear();
    if (this.t < this.coverage.readAt) return;
    const taken = new Set<number>();
    for (const d of this.actors) {
      const a = d.assignment;
      if (d.side !== 'def' || d.down || a?.kind !== 'zone' || ZONES[a.zone].deep) continue;
      const z = ZONES[a.zone];
      const landX = this.ballX * 0.5 + z.x;
      const shallowThreat = receivers.some((r) => !r.blocks && !this.coverage.verticals.has(r.id) &&
        Math.abs(r.pos.x - landX) < z.w && r.pos.y < this.los + 6 && r.pos.y > this.los - 2);
      if (shallowThreat && (a.zone === 'flatL' || a.zone === 'flatR')) continue;
      let best: ReadTarget | null = null;
      for (const r of receivers) {
        if (!this.coverage.verticals.has(r.id) || taken.has(r.id)) continue;
        if (Math.abs(r.pos.x - landX) > z.w + 2) continue;
        const depth = r.pos.y - this.los;
        const helped = [...this.coverage.help.values()].includes(r.id) || this.deepOverTop(r);
        if (depth > COVERAGE.carryDepth + (helped ? 0 : 8)) continue;
        if (!best || dist(r.pos, d.pos) < dist(best.pos, d.pos)) best = r;
      }
      if (best) {
        this.carry.set(d.id, best.id);
        taken.add(best.id);
      }
    }
  }

  /**
   * Rush lanes: interior rushers push straight at the QB, edge rushers arc
   * around the tackle and come at him from the side and from behind.
   */
  private rushGoal(d: Actor, qb: Actor): Vec2 {
    const startX = d.history.length ? d.history[0].x : d.pos.x;
    const side = Math.sign(startX - this.ballX);
    if (Math.abs(startX - this.ballX) < POCKET.edgeStartWidth || this.scrambling) return qb.pos;
    const beside = Math.abs(d.pos.x - qb.pos.x) < POCKET.edgeArcWidth + 0.6;
    if (d.pos.y <= qb.pos.y + POCKET.edgeArcDepth && beside) return qb.pos; // turned the corner
    return v2(qb.pos.x + side * POCKET.edgeArcWidth, qb.pos.y - POCKET.edgeArcDepth);
  }

  /** Has this defender read the screen? Then he attacks the screen target. */
  private screenRecognized(d: Actor, isDeep: boolean): boolean {
    const scr = this.play.screen;
    if (!scr || isDeep) return false;
    const read = scr.release > 0 ? this.screenReadAt : SCREEN.readDelay * (1 + 1.5 * (1 - this.diff.coverageRead));
    if (this.t < read + d.reaction) return false;
    return dist(d.pos, this.get(scr.target).pos) < SCREEN.reactRadius;
  }

  /** Rushers, plus man defenders whose receiver stayed in to block (green dog). */
  private isRushing(d: Actor): boolean {
    const a = d.assignment;
    if (a?.kind === 'rush') return true;
    if (a?.kind !== 'man' || this.t <= 1.2) return false;
    const r = this.get(a.target).route;
    return !!r?.blocks && !(r.type === 'check' && this.t > 1.5);
  }

  /** Defender is level with or behind his receiver, so his back is to the QB. */
  private trailing(d: Actor, r: Actor): boolean {
    return d.pos.y < r.pos.y + 0.5 && len(r.vel) > 3;
  }

  /** Is a deep zone defender already sitting over the top of this receiver? */
  private deepOverTop(r: ReadTarget): boolean {
    for (const d of this.actors) {
      const a = d.assignment;
      if (d.side !== 'def' || d.down || a?.kind !== 'zone' || !ZONES[a.zone].deep) continue;
      if (Math.abs(d.pos.x - r.pos.x) < 4 && d.pos.y - r.pos.y > COVERAGE.carryHandoffCushion) return true;
    }
    return false;
  }

  private defenseAI(desired: Map<number, Vec2>) {
    const qb = this.get('QB');
    const carrier = this.carrier;
    const flight = this.ball.state === 'air' && this.ball.flight && !this.ball.flight.lateral ? this.ball.flight : null;
    const runMode = carrier && carrier.side === 'off' && (carrier !== qb || this.runRecognizedAt < Infinity);
    for (const d of this.actors) {
      if (d.side !== 'def' || d.down || desired.has(d.id)) continue;
      if (this.contact && d.id === this.contact.tackler) {
        desired.set(d.id, this.actors[this.contact.carrier].vel); // ride the carrier to the turf
        continue;
      }
      const asg = d.assignment!;
      const isDeep = asg.kind === 'zone' && ZONES[asg.zone].deep;
      let goal: Vec2;
      let urgency = 1;

      if (carrier && carrier.side === 'def') {
        goal = d.pos;
      } else if (runMode && this.t > this.runRecognizedAt + d.reaction * (carrier === qb ? SCRAMBLE.reactFactor : 1) + (isDeep ? 0.35 : 0)) {
        goal = this.pursuit(d, carrier!);
      } else if (flight && asg.kind === 'man' && this.get(asg.target).id === flight.targetId && this.trailing(d, this.get(asg.target))) {
        // Trailing man defender can't see the ball: play through the receiver's hands.
        const r = this.get(asg.target);
        goal = add(r.pos, scale(r.vel, 0.25));
      } else if (flight && this.t > this.throwAt + d.reaction + (asg.kind === 'man' ? COVERAGE.manBallReadDelay : 0)) {
        const timeLeft = flight.T - flight.t;
        const canReach = dist(d.pos, flight.landing) / d.maxSpeed < timeLeft + 0.6;
        goal = canReach ? flight.landing : add(flight.landing, scale(norm(sub(d.pos, flight.landing)), 2));
      } else if (this.screenRecognized(d, isDeep)) {
        goal = this.pursuit(d, this.get(this.play.screen!.target));
      } else if (this.play.playAction && this.t < this.diff.playActionBite && !isDeep && asg.kind !== 'rush' && d.position !== 'CB') {
        goal = v2(d.pos.x * 0.9 + this.ballX * 0.1, this.los + 1.5);
        urgency = 0.55;
      } else {
        goal = this.coverageGoal(d, asg, qb);
        if (asg.kind === 'zone' && !isDeep && !this.carry.has(d.id)) urgency = 0.9;
      }
      if (asg.kind !== 'rush' && this.t < d.reaction && asg.kind !== 'man') {
        // Read step: underneath defenders hold, deep defenders bail to their landmark.
        goal = isDeep && asg.kind === 'zone' ? this.zoneLandmark(asg.zone) : d.pos;
      }
      desired.set(d.id, this.seek(d, goal, urgency));
      if (asg.kind === 'man' && !this.passThrown && this.t > 0.6) this.checkHolding(d, this.get(asg.target));
    }
  }

  /** Defensive holding: grabbing a receiver who is trying to get open (per second of contact). */
  private checkHolding(d: Actor, r: Actor) {
    if (r.route?.blocks || dist(d.pos, r.pos) > PENALTIES.holdingContactRange || len(r.vel) < 4) return;
    if (rollFoul('holdingDefense', this.penaltyBias, this.penRng, SIM_DT)) this.addFoul('holdingDefense', d.pos);
  }

  /**
   * Deep defender with vertical threats in his zone: over the top of one, or
   * split two, leaning toward the route he was assigned to help on.
   */
  private deepSplit(d: Actor, land: Vec2, width: number, helpId: number | undefined): Vec2 | null {
    const lag = d.reaction * 0.6;
    const tops: Vec2[] = [];
    let helpTop: Vec2 | null = null;
    for (const s of ELIGIBLE) {
      const r = this.get(s);
      if (!this.coverage.verticals.has(r.id)) continue;
      const seen = this.perceived(r, lag);
      const isHelp = r.id === helpId;
      if (!isHelp && Math.abs(seen.x - land.x) > width) continue;
      const top = overTop({ pos: seen, vel: this.perceivedVel(r, lag) }, this.ballX,
        isHelp ? COVERAGE.helpCushion : COVERAGE.deepCushion, isHelp ? COVERAGE.helpLead : COVERAGE.deepLead);
      tops.push(top);
      if (isHelp) helpTop = top;
    }
    if (tops.length === 0) return null;
    const mid = v2(tops.reduce((a, t) => a + t.x, 0) / tops.length, Math.max(land.y, ...tops.map((t) => t.y)));
    const goal = helpTop ? v2(mid.x + (helpTop.x - mid.x) * COVERAGE.helpLean, Math.max(mid.y, helpTop.y)) : mid;
    return add(goal, scale(d.coverOffset, 0.4));
  }

  private zoneLandmark(zone: keyof typeof ZONES): Vec2 {
    const z = ZONES[zone];
    const roll = z.deep ? this.coverage.roll : 0;
    return v2(clamp(this.ballX * 0.5 + z.x + roll, -FIELD.halfWidth + 2, FIELD.halfWidth - 2), this.los + z.y);
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
        return this.rushGoal(d, qb);
      case 'spy':
        return v2(qb.pos.x, Math.max(this.los + 4, qb.pos.y + 5));
      case 'man': {
        const r = this.get(asg.target);
        if (r.route?.blocks && !(r.route.type === 'check' && this.t > 1.5)) {
          // Receiver stayed in to block: become a spy / green-dog rusher.
          return this.t > 1.2 ? qb.pos : v2(qb.pos.x, this.los + 4);
        }
        if (this.coverage.verticals.has(r.id)) {
          // Vertical stem: get in phase on the receiver's inside hip. A break
          // (post, corner) costs the defender his full reaction time again.
          const lag = d.reaction * COVERAGE.phaseLag;
          const vel = this.perceivedVel(r, lag);
          if (vel.y > r.maxSpeed * COVERAGE.verticalSpeedFrac) {
            return add(inPhaseSpot({ pos: this.perceived(r, lag), vel }, this.ballX), scale(d.coverOffset, 0.3));
          }
        }
        // In press range the defender feels the release, so he reads it faster.
        const lag = dist(d.pos, r.pos) < 3 ? d.reaction * 0.5 : d.reaction;
        const seen = this.perceived(r, lag);
        const vel = this.perceivedVel(r, lag);
        const inward = Math.sign(this.ballX - seen.x) || 1;
        const cushion = d.position === 'CB' ? 0.9 : 0.6;
        const goal = add(add(seen, scale(vel, 0.35)), v2(inward * 0.5 + d.coverOffset.x, cushion + d.coverOffset.y * 0.5));
        // Never back down toward the LOS once the receiver releases upfield.
        if (vel.y > 1) goal.y = Math.max(goal.y, d.pos.y - 0.3);
        return goal;
      }
      case 'zone': {
        const z = ZONES[asg.zone];
        const land = this.zoneLandmark(asg.zone);
        const helpId = this.coverage.help.get(d.id);
        if (z.deep) {
          const split = this.deepSplit(d, land, z.w, helpId);
          if (split) return split;
        }
        const carryId = this.carry.get(d.id);
        if (carryId !== undefined) {
          const r = this.actors[carryId];
          const lag = d.reaction * 0.7;
          return add(carrySpot({ pos: this.perceived(r, lag), vel: this.perceivedVel(r, lag) }, this.ballX), scale(d.coverOffset, 0.3));
        }
        let threat: Actor | null = null;
        let best = Infinity;
        for (const s of ELIGIBLE) {
          const r = this.get(s);
          if (r.route?.blocks) continue;
          const seen = this.perceived(r, d.reaction);
          const dx = Math.abs(seen.x - land.x);
          if (dx > z.w) continue;
          if (z.deep ? seen.y < this.los + 7 : seen.y > this.los + 16 || seen.y < this.los - 1) continue;
          // Deep defenders prioritise vertical stems over anything else in their zone.
          const score = dist(seen, land) - (z.deep && this.coverage.verticals.has(r.id) ? 8 : 0);
          if (score < best) {
            best = score;
            threat = r;
          }
        }
        if (!threat) return add(land, d.coverOffset);
        const seen = this.perceived(threat, d.reaction);
        if (z.deep) {
          const vel = this.perceivedVel(threat, d.reaction * 0.6);
          const top = overTop({ pos: seen, vel }, this.ballX, COVERAGE.deepCushion, COVERAGE.deepLead);
          return v2(land.x * 0.3 + top.x * 0.7 + d.coverOffset.x, Math.max(land.y, top.y));
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
      // Hazard grows with time engaged and with how long the QB holds the ball.
      const hold = rushing ? 1 + POCKET.holdFactor * Math.max(0, this.t - POCKET.holdGrace) * this.diff.pocketPressure : 1;
      const rate = (rushing ? 0.05 * e.t * hold : 0.05 + 0.08 * e.t) * ratio * ratio * ratio * this.diff.passRush / n;
      if ((rushing && e.t >= e.loseAt && n === 1) || this.rng.chance(rate * dt)) {
        if (rollFoul('holdingOffense', this.penaltyBias, this.penRng)) {
          // Beaten blocker grabs on instead of letting go.
          this.addFoul('holdingOffense', b.pos);
          e.loseAt = Infinity;
          e.t = 0;
          keep.push(e);
          continue;
        }
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
      const k = this.contact;
      if (k && (a.id === k.carrier || a.id === k.tackler)) a.vel = want; // contact: momentum is scripted
      else a.vel = add(a.vel, clampLen(sub(want, a.vel), a.accel * dt));
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
    const target = f.targetId !== null ? this.actors[f.targetId] : null;
    if (target && dist(target.pos, f.landing) < 3) {
      // Pass interference: a beaten defender (not in phase) climbing on the receiver.
      for (const d of this.actors) {
        if (d.side !== 'def' || d.down || dist(d.pos, target.pos) > PENALTIES.dpiReach) continue;
        if (inPhase(target, d, COVERAGE.inPhaseDist)) continue;
        if (rollFoul('passInterference', this.penaltyBias, this.penRng)) this.addFoul('passInterference', f.landing);
        break;
      }
    }
    const defense = this.actors.filter((a) => a.side === 'def' && !a.down)
      .map((a) => ({ ...toCand(a), inPhase: !!target && inPhase(target, a, COVERAGE.inPhaseDist) }));
    const out = resolveCatch({
      landing: f.landing, quality: f.quality, speed: f.speed, offense, defense,
      ballSkills: this.diff.ballSkills, inPhaseBreakup: COVERAGE.inPhaseBreakup, inPhaseInt: COVERAGE.inPhaseInt,
      catchFactor: f.screen?.catchFactor, intBonus: f.screen?.intBonus, rng: this.rng,
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
    if (!c || c.side !== 'off' || this.contact) return;
    for (const d of this.actors) {
      if (d.side !== 'def' || d.down || d.tackleCooldown > 0) continue;
      if (dist(d.pos, c.pos) > TACKLE.range) continue;
      const engaged = !!this.isEngaged(d);
      if (engaged && dist(d.pos, c.pos) > TACKLE.engagedRange) continue;
      let factor = this.diff.tackling;
      if (c.slot === 'QB' && !this.pastLos(c)) factor *= TACKLE.pocketSackFactor; // sacks: QB is a sitting duck
      else if (c.slot === 'QB') factor *= SCRAMBLE.tackleBonus; // a scrambling QB is no running back
      const out = resolveTackle({
        tacklerPos: d.pos, tacklerVel: d.vel, carrierPos: c.pos, carrierVel: c.vel,
        tackling: d.player.ratings.tackling, carrierStrength: c.player.ratings.strength, carrierSpeed: c.player.ratings.speed,
        engaged, juking: this.t < this.jukeUntil, factor, rng: this.rng,
      });
      const heading = Math.atan2(d.pos.x - c.pos.x, d.pos.y - c.pos.y);
      c.anim = { kind: out.kind, role: 'carrier', t: this.t, duration: out.contactTime, down: out.success, heading };
      d.anim = { kind: out.kind, role: 'tackler', t: this.t, duration: out.contactTime, down: out.success, heading: heading + Math.PI };
      if (out.success) {
        // Momentum: the carrier keeps going (or is driven back) until he hits the turf.
        const dir = len(c.vel) > 0.5 ? norm(c.vel) : v2(0, 1);
        c.vel = scale(dir, out.fallForward / out.contactTime);
        d.vel = c.vel;
        const sack = c.slot === 'QB' && c.pos.y < this.los && !this.passThrown && !this.handedOff;
        this.contact = { carrier: c.id, tackler: d.id, whistleAt: this.t + out.contactTime, sack };
        if (rollFoul('facemask', this.penaltyBias, this.penRng)) this.addFoul('facemask', c.pos);
        return;
      }
      d.tackleCooldown = TACKLE.brokenCooldown;
      c.vel = scale(c.vel, out.slow);
      this.emit('brokenTackle', d.id);
    }
  }

  /** The ball carrier is down: blow the whistle at the spot. */
  private whistleContact() {
    const k = this.contact!;
    this.contact = null;
    const c = this.actors[k.carrier];
    c.down = true;
    if (k.tackler >= 0) this.actors[k.tackler].vel = scale(this.actors[k.tackler].vel, 0.3);
    if (c.pos.y <= 0) this.finish('safety', c);
    else this.finish(k.sack ? 'sack' : 'tackle', c);
  }

  /** A tackle is in progress (contact animation before the whistle). */
  get inContact(): boolean {
    return this.contact !== null;
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
    const endY = outcome === 'incomplete' || outcome === 'noPlay' ? this.los : outcome === 'touchdown' ? FIELD.length : clamp(at.y, -FIELD.endzone, FIELD.length);
    const yards = outcome === 'interception' || outcome === 'incomplete' || outcome === 'noPlay' ? 0 : Math.round(endY - this.los);
    const completion = this.passThrown && c !== null && c.side === 'off' && c.slot !== 'QB';
    const res: PlayResult = {
      outcome,
      endX: clamp(at.x, -FIELD.halfWidth, FIELD.halfWidth),
      endY,
      yards,
      duration: this.t,
      passAttempt: this.passThrown,
      completion,
      rush: !this.passThrown && outcome !== 'sack' && outcome !== 'incomplete' && outcome !== 'noPlay',
      carrier: c ? c.slot : null,
      turnover: outcome === 'interception',
      defenseCall: this.defense.name,
      description: '',
      fouls: this.fouls,
    };
    res.description = describe(res, c);
    return res;
  }

  private updatePressure() {
    const qb = this.get('QB');
    if (this.ball.holder !== qb.id || this.result) {
      this.pressure = 0;
      this.pocketCue = null;
      return;
    }
    let p = 0;
    let cue: PocketCue | null = null;
    const picked = new Set(this.passBlock.values());
    for (const d of this.actors) {
      if (d.side !== 'def' || d.down || !this.isRushing(d)) continue;
      const dd = dist(d.pos, qb.pos);
      const engaged = this.engagements.some((e) => e.defender === d.id);
      const free = clamp(1 - (dd - 1.2) / 5, 0, 1);
      // Blocked rushers only count once they are pushing the pocket into the QB.
      const v = engaged ? clamp(1 - (dd - 1) / 3.5, 0, 1) * 0.55 : picked.has(d.id) && this.t < 1 ? free * 0.3 : free;
      p = Math.max(p, v);
      if (!engaged) {
        // Cue: a free rusher closing in (by distance or by time to get home).
        const closing = Math.max(0, -((d.vel.x * (d.pos.x - qb.pos.x) + d.vel.y * (d.pos.y - qb.pos.y)) / Math.max(dd, 0.1)));
        const tHome = closing > 0.5 ? (dd - 1) / closing : Infinity;
        const level = Math.max(clamp(1 - (dd - 1.2) / POCKET.cueRange, 0, 1), clamp(1 - tHome / POCKET.cueTime, 0, 1));
        if (level > 0 && (!cue || level > cue.level)) cue = { heading: Math.atan2(d.pos.x - qb.pos.x, d.pos.y - qb.pos.y), level };
      }
    }
    this.pressure = this.pressure + (p - this.pressure) * 0.2;
    this.pocketCue = cue;
  }

}

function describe(r: PlayResult, c: Actor | null): string {
  const who = c ? `#${c.player.number} ${c.player.name}` : '';
  const yds = (n: number) => `${Math.abs(n)} yard${Math.abs(n) === 1 ? '' : 's'}`;
  switch (r.outcome) {
    case 'incomplete': return 'Incomplete pass';
    case 'noPlay': return 'No play';
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
