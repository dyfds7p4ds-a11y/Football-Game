/**
 * ReturnSim: a kickoff or punt from the kick to the whistle, on the same
 * fixed 60 Hz step as PlaySim. The returning team runs toward +y in its own
 * frame. One player (the returner) is controlled by the user (movement plus a
 * dash button) or by a simple CPU runner; blockers each take a cover man; the
 * coverage team runs down in lanes and pursues. Tackles use play/tackle.ts,
 * so returns feel like offense. The renderer reads `actors`, `ball` and
 * `officials` exactly like a PlaySim.
 */
import { Rng } from '../core/rng';
import { add, clamp, clampLen, dist, len, norm, scale, sub, v2, type Vec2 } from '../core/vec';
import type { DefSlot, OffSlot, PlayerData, TeamData } from '../data/types';
import { DEF_SLOTS } from '../data/types';
import { playerFor } from '../data';
import { FIELD } from './field';
import { ST, flightPos, type KickFlight } from './kicking';
import { TACKLE, resolveTackle } from './tackle';
import { setupOfficials, updateOfficials, type Official } from './officials';
import { SIM_DT, type Actor, type ContactAnim, type PlayEvent, type PlayEventType } from './sim';
import type { ReturnOutcome } from '../game/specialTeams';
import { toReceivingFrame } from '../game/specialTeams';

export interface ReturnInput {
  move: Vec2;
  /** Edge-triggered dash. */
  dash: boolean;
}

export interface ReturnResult {
  outcome: ReturnOutcome | 'outOfBoundsKick';
  /** Receiving team's frame. */
  endX: number;
  endY: number;
  /** Return yards (from the catch). */
  yards: number;
  duration: number;
  description: string;
  returnerName: string;
}

export interface ReturnOptions {
  kind: 'kickoff' | 'punt';
  flight: KickFlight;
  kickingTeam: TeamData;
  receivingTeam: TeamData;
  /** True: the user steers the returner. */
  userReturns: boolean;
  /** Difficulty tackling multiplier for the side that tackles. */
  tackling: number;
  seed: number;
}

const RECV_SLOTS: OffSlot[] = ['RB', 'WR1', 'WR2', 'WR3', 'TE', 'LT', 'LG', 'C', 'RG', 'RT', 'QB'];
const SPEED = (r: number) => 4.8 + 5.0 * (r / 100);

interface Block {
  blocker: number;
  defender: number;
  until: number;
}

export class ReturnSim {
  readonly actors: Actor[] = [];
  readonly officials: Official[];
  readonly flags = [];
  readonly kind: 'kickoff' | 'punt';
  readonly flight: KickFlight;
  readonly userReturns: boolean;
  /** Ball in the receiving frame. */
  readonly ball: {
    state: 'held' | 'air' | 'loose';
    holder: number | null;
    pos: Vec2;
    h: number;
    prevPos: Vec2;
    prevH: number;
    flight: null;
    looseVel: { x: number; y: number; h: number };
  };
  t = 0;
  result: ReturnResult | null = null;
  controlledId: number;
  /** Line of scrimmage of the kick (receiving frame), for markers. */
  readonly los: number;
  readonly ballX = 0;
  dashCooldown = 0;
  private dashUntil = 0;
  private rng: Rng;
  private events: PlayEvent[] = [];
  private blocks: Block[] = [];
  private caughtAt: Vec2 | null = null;
  private contact: { carrier: number; tackler: number; whistleAt: number } | null = null;
  private tacklingFactor: number;
  private landing: Vec2;
  private rolling: Vec2 | null = null;

  constructor(o: ReturnOptions) {
    this.kind = o.kind;
    this.flight = o.flight;
    this.userReturns = o.userReturns;
    this.rng = new Rng(o.seed);
    this.tacklingFactor = o.tackling;
    const from = toReceivingFrame(o.flight.from);
    this.landing = toReceivingFrame(o.flight.landing);
    // Kickoff: the kicking spot; punt: the line of scrimmage in front of the punter.
    this.los = o.kind === 'punt' ? from.y - ST.rules.puntSnapBack : from.y;
    this.setupReturnTeam(o.receivingTeam);
    this.setupCoverage(o.kickingTeam);
    this.controlledId = 0;
    const start = flightPos(o.flight, 0);
    const p = toReceivingFrame(start);
    this.ball = { state: 'air', holder: null, pos: p, h: start.h, prevPos: { ...p }, prevH: start.h, flight: null, looseVel: { x: 0, y: 0, h: 0 } };
    this.officials = setupOfficials(this.los, 0);
    this.emit('snap');
  }

  // ---------------------------------------------------------------- setup

  private addActor(side: 'off' | 'def', slot: OffSlot | DefSlot, player: PlayerData, pos: Vec2): Actor {
    const r = player.ratings;
    const a: Actor = {
      id: this.actors.length, side, slot, position: player.position, player,
      pos: { ...pos }, prevPos: { ...pos }, vel: v2(), facing: side === 'off' ? 0 : Math.PI,
      maxSpeed: SPEED(r.speed), accel: 9 + 6 * (r.speed / 100), routeIdx: 0, reaction: 0.25, coverOffset: v2(),
      blockCooldown: 0, tackleCooldown: 0, down: false, history: [], anim: null,
    };
    this.actors.push(a);
    return a;
  }

  /** Returner first (id 0), then the blockers in two waves. */
  private setupReturnTeam(team: TeamData) {
    const L = this.landing;
    const ret = this.addActor('off', 'RB', playerFor(team, 'RB'), v2(clamp(L.x, -20, 20), Math.max(-4, Math.min(L.y, this.kind === 'punt' ? L.y : 3))));
    ret.maxSpeed *= 1.02;
    // Receiving frame: the return team lines up below the LOS (lower y), the kicking team above it.
    const front = this.kind === 'kickoff' ? this.los - ST.return.kickoffFrontLine : this.los - 1;
    const wave2 = this.kind === 'kickoff' ? Math.max(12, (front + ret.pos.y) / 2) : this.los - 7;
    RECV_SLOTS.slice(1).forEach((slot, i) => {
      const first = i < 5;
      const k = first ? i : i - 5;
      const n = first ? 5 : 5;
      const x = -18 + (36 * k) / (n - 1);
      this.addActor('off', slot, playerFor(team, slot), v2(x, first ? front : wave2));
    });
  }

  private setupCoverage(team: TeamData) {
    DEF_SLOTS.forEach((slot, i) => {
      const x = -22 + (44 * i) / (DEF_SLOTS.length - 1);
      // Kickoff: line up across the field just behind the ball; punt: on the line.
      const y = this.kind === 'kickoff' ? this.los + 1 : this.los + 0.5;
      const a = this.addActor('def', slot, playerFor(team, slot), v2(x, y));
      a.reaction = 0.2 + this.rng.range(0, 0.15);
      a.coverOffset = v2(this.rng.normal() * 1.5, 0);
    });
  }

  // ---------------------------------------------------------------- helpers

  get returner(): Actor {
    return this.actors[0];
  }

  get carrier(): Actor | null {
    return this.ball.state === 'held' && this.ball.holder !== null ? this.actors[this.ball.holder] : null;
  }

  get inContact(): boolean {
    return this.contact !== null;
  }

  /** Flight progress in seconds (null once the ball came down). */
  get flightTime(): number | null {
    return this.ball.state === 'air' ? this.t : null;
  }

  private emit(type: PlayEventType, actor?: number) {
    this.events.push({ t: this.t, type, actor });
  }

  drainEvents(): PlayEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  private seek(a: Actor, target: Vec2, frac = 1): Vec2 {
    const d = sub(target, a.pos);
    const l = len(d);
    if (l < 0.05) return v2();
    return scale(d, Math.min(a.maxSpeed * frac, l * 4) / l);
  }

  // ---------------------------------------------------------------- step

  step(input: ReturnInput, dt = SIM_DT) {
    for (const a of this.actors) a.prevPos = { ...a.pos };
    this.ball.prevPos = { ...this.ball.pos };
    this.ball.prevH = this.ball.h;
    if (this.result) {
      for (const a of this.actors) {
        a.vel = scale(a.vel, Math.max(0, 1 - dt * 3));
        a.pos = add(a.pos, scale(a.vel, dt));
      }
      this.updateOfficials(dt, true);
      return;
    }
    this.t += dt;
    this.dashCooldown = Math.max(0, this.dashCooldown - dt);
    const desired = new Map<number, Vec2>();
    this.controlReturner(input, desired);
    this.returnTeamAI(desired);
    this.coverageAI(desired);
    this.integrate(dt, desired);
    this.updateBall(dt);
    if (!this.result) this.checkTackles();
    if (!this.result) this.checkBoundaries();
    if (!this.result && this.contact && this.t >= this.contact.whistleAt) this.whistle();
    if (!this.result && this.t > ST.return.maxTime) this.finish('tackle');
    this.updateOfficials(dt, false);
    for (const a of this.actors) {
      a.history.push({ ...a.pos });
      if (a.history.length > 60) a.history.shift();
      a.tackleCooldown = Math.max(0, a.tackleCooldown - dt);
    }
  }

  private updateOfficials(dt: number, dead: boolean) {
    const c = this.carrier;
    updateOfficials(this.officials, {
      los: this.los, ballX: 0, ball: this.ball.pos, carrier: c ? c.pos : null, players: this.actors.map((a) => a.pos), dead,
    }, dt);
  }

  private controlReturner(input: ReturnInput, desired: Map<number, Vec2>) {
    const r = this.returner;
    if (this.contact) {
      desired.set(r.id, r.vel);
      return;
    }
    const hasBall = this.carrier === r;
    let move: Vec2;
    if (!hasBall) {
      // Getting under the ball is automatic: the return starts at the catch.
      const target = this.rolling ?? this.landing;
      const d = dist(r.pos, target);
      move = d > 0.3 ? scale(norm(sub(target, r.pos)), Math.min(1, d / 2)) : v2();
    } else if (this.userReturns) {
      move = len(input.move) > 0.15 ? clampLen(input.move, 1) : v2(0, 1);
    } else {
      move = this.cpuRunDirection(r);
    }
    if (input.dash && hasBall && this.dashCooldown <= 0) {
      this.dashUntil = this.t + ST.return.dashTime;
      this.dashCooldown = ST.return.dashCooldown;
      this.emit('juke', r.id);
    }
    if (!this.userReturns && hasBall && this.dashCooldown <= 0 && this.nearestCover(r.pos).d < 4) {
      this.dashUntil = this.t + ST.return.dashTime;
      this.dashCooldown = ST.return.dashCooldown * 1.5;
    }
    const boost = this.t < this.dashUntil ? ST.return.dashBoost : 1;
    desired.set(r.id, scale(move, r.maxSpeed * boost));
  }

  private nearestCover(p: Vec2): { a: Actor | null; d: number } {
    let best: Actor | null = null;
    let bd = Infinity;
    for (const a of this.actors) {
      if (a.side !== 'def' || a.down) continue;
      const d = dist(a.pos, p);
      if (d < bd) {
        best = a;
        bd = d;
      }
    }
    return { a: best, d: bd };
  }

  /** CPU returner: upfield, bending away from the closest unblocked tacklers. */
  private cpuRunDirection(r: Actor): Vec2 {
    let dir = v2(0, 1);
    for (const a of this.actors) {
      if (a.side !== 'def' || a.down || this.blocks.some((b) => b.defender === a.id)) continue;
      const d = sub(r.pos, a.pos);
      const l = len(d);
      if (l > 9 || a.pos.y < r.pos.y - 1) continue;
      dir = add(dir, scale(norm(d), (9 - l) / 9 * 1.4));
    }
    // Stay off the sideline.
    if (Math.abs(r.pos.x) > FIELD.halfWidth - 4) dir.x -= Math.sign(r.pos.x) * 0.8;
    dir.y = Math.max(dir.y, 0.25);
    return norm(dir);
  }

  private returnTeamAI(desired: Map<number, Vec2>) {
    const r = this.returner;
    const ballDown = this.ball.state !== 'air' || this.t > this.flight.hang - 1.2;
    this.blocks = this.blocks.filter((b) => b.until > this.t && !this.actors[b.defender].down);
    for (const b of this.actors) {
      if (b.side !== 'off' || b === r || b.down) continue;
      const blk = this.blocks.find((x) => x.blocker === b.id);
      if (blk) {
        const d = this.actors[blk.defender];
        // Mirror the cover man between him and the returner.
        const front = add(d.pos, scale(norm(sub(r.pos, d.pos)), 0.8));
        desired.set(b.id, scale(sub(front, b.pos), 8));
        continue;
      }
      if (!ballDown) {
        // Drop back to form the wall in front of the returner.
        desired.set(b.id, this.seek(b, v2(b.pos.x * 0.85 + r.pos.x * 0.15, Math.max(r.pos.y + 8, b.pos.y - 6)), 0.7));
        continue;
      }
      // Pick up the most dangerous unblocked cover man.
      let best: Actor | null = null;
      let score = Infinity;
      for (const d of this.actors) {
        if (d.side !== 'def' || d.down || this.blocks.some((x) => x.defender === d.id)) continue;
        const sc = dist(d.pos, b.pos) + dist(d.pos, r.pos) * 0.5;
        if (sc < score) {
          best = d;
          score = sc;
        }
      }
      if (!best) {
        desired.set(b.id, this.seek(b, add(r.pos, v2(0, 4)), 0.8));
        continue;
      }
      if (dist(best.pos, b.pos) < 1.2) {
        const [lo, hi] = ST.return.blockHold;
        const ratio = clamp((b.player.ratings.blocking + b.player.ratings.strength) / Math.max(40, best.player.ratings.strength + best.player.ratings.tackling), 0.5, 1.5);
        this.blocks.push({ blocker: b.id, defender: best.id, until: this.t + this.rng.range(lo, hi) * ratio });
      }
      desired.set(b.id, this.seek(b, add(best.pos, scale(norm(sub(r.pos, best.pos)), 0.8)), 1));
    }
  }

  private coverageAI(desired: Map<number, Vec2>) {
    const r = this.returner;
    const c = this.carrier;
    for (const d of this.actors) {
      if (d.side !== 'def' || d.down) continue;
      if (this.contact && d.id === this.contact.tackler) {
        desired.set(d.id, this.actors[this.contact.carrier].vel);
        continue;
      }
      const blk = this.blocks.find((x) => x.defender === d.id);
      if (blk) {
        // Engaged: fight toward the returner slowly.
        desired.set(d.id, scale(norm(sub(r.pos, d.pos)), 1.2));
        continue;
      }
      if (this.t < d.reaction) {
        desired.set(d.id, v2());
        continue;
      }
      let goal: Vec2;
      if (!c) {
        // Run down in a lane toward the landing spot.
        const target = this.rolling ?? this.landing;
        goal = v2(target.x + d.coverOffset.x + (d.pos.x - target.x) * 0.35, target.y + 3);
      } else {
        const lead = clamp(dist(d.pos, c.pos) / d.maxSpeed, 0, 1.2);
        goal = add(add(c.pos, scale(c.vel, lead * 0.8)), scale(d.coverOffset, 0.2));
      }
      desired.set(d.id, this.seek(d, goal, ST.return.coverageSpeed));
    }
  }

  private integrate(dt: number, desired: Map<number, Vec2>) {
    const k = this.contact;
    for (const a of this.actors) {
      if (a.down) {
        a.vel = v2();
        continue;
      }
      const boost = a.id === 0 && this.t < this.dashUntil ? ST.return.dashBoost : 1;
      const want = clampLen(desired.get(a.id) ?? v2(), a.maxSpeed * boost);
      if (k && (a.id === k.carrier || a.id === k.tackler)) a.vel = want;
      else a.vel = add(a.vel, clampLen(sub(want, a.vel), a.accel * dt));
      a.pos = add(a.pos, scale(a.vel, dt));
      if (len(a.vel) > 0.5) a.facing = Math.atan2(a.vel.x, a.vel.y);
    }
    // Soft separation so players don't stack.
    for (let i = 0; i < this.actors.length; i++) {
      for (let j = i + 1; j < this.actors.length; j++) {
        const a = this.actors[i];
        const b = this.actors[j];
        if (a.down || b.down) continue;
        const c = this.carrier;
        if (c && (a === c || b === c) && a.side !== b.side) continue;
        const d = dist(a.pos, b.pos);
        if (d >= 0.7 || d < 1e-6) continue;
        const push = scale(norm(sub(a.pos, b.pos)), (0.7 - d) / 2);
        a.pos = add(a.pos, push);
        b.pos = sub(b.pos, push);
      }
    }
  }

  // ---------------------------------------------------------------- ball

  private updateBall(dt: number) {
    const b = this.ball;
    const r = this.returner;
    if (b.state === 'held') {
      const h = this.actors[b.holder!];
      b.pos = add(h.pos, v2(Math.sin(h.facing) * 0.35, Math.cos(h.facing) * 0.35));
      b.h = 1.15;
      return;
    }
    if (b.state === 'air') {
      const p = flightPos(this.flight, Math.min(this.t, this.flight.hang));
      b.pos = toReceivingFrame(p);
      b.h = Math.max(0.12, p.h);
      if (this.t < this.flight.hang - 0.05) return;
      // Ball comes down.
      if (Math.abs(b.pos.x) > FIELD.halfWidth) {
        this.finishKickOOB();
        return;
      }
      if (b.pos.y < -FIELD.endzone || (this.kind === 'kickoff' && b.pos.y < 0) || (this.kind === 'punt' && b.pos.y < 0)) {
        this.result = this.makeResult('touchback', b.pos);
        this.emit('incomplete');
        return;
      }
      if (dist(r.pos, b.pos) <= ST.return.catchRadius) {
        if (this.rng.chance(ST.return.muffChance * (1.4 - r.player.ratings.catching / 100))) {
          this.emit('drop', r.id);
          this.rolling = add(b.pos, v2(this.rng.range(-2, 2), -this.rng.range(1, 3)));
          b.state = 'loose';
          b.looseVel = { x: 0, y: 0, h: 0 };
          return;
        }
        this.catchBall();
        return;
      }
      // Nobody there: it bounces and rolls.
      b.state = 'loose';
      const dir = norm(v2(this.flight.vel.x, -this.flight.vel.y));
      b.looseVel = { x: -dir.x * 6, y: dir.y * 6, h: 2 };
      this.rolling = { ...b.pos };
      return;
    }
    // Loose ball rolling.
    const v = v2(b.looseVel.x, b.looseVel.y);
    const sp = len(v);
    const nv = sp > 0 ? scale(v, Math.max(0, sp - ST.return.rollFriction * dt) / sp) : v;
    b.looseVel.x = nv.x;
    b.looseVel.y = nv.y;
    b.looseVel.h -= 10.7 * dt;
    b.h = Math.max(0.12, b.h + b.looseVel.h * dt);
    if (b.h <= 0.12) b.looseVel.h = Math.abs(b.looseVel.h) * 0.4;
    b.pos = add(b.pos, scale(nv, dt));
    this.rolling = { ...b.pos };
    if (b.pos.y < 0) {
      this.result = this.makeResult('touchback', b.pos);
      return;
    }
    // Punt: the coverage team downs it if they get there first.
    const cov = this.nearestCover(b.pos);
    if (this.kind === 'punt' && cov.d < 1.0 && dist(r.pos, b.pos) > 1.0) {
      this.result = this.makeResult('downed', b.pos);
      this.emit('tackle', cov.a!.id);
      return;
    }
    if (dist(r.pos, b.pos) < 1.0) this.catchBall();
  }

  private catchBall() {
    const r = this.returner;
    this.ball.state = 'held';
    this.ball.holder = r.id;
    this.rolling = null;
    this.caughtAt = { ...r.pos };
    this.emit('catch', r.id);
  }

  // ---------------------------------------------------------------- whistle

  private checkTackles() {
    const c = this.carrier;
    if (!c || this.contact) return;
    for (const d of this.actors) {
      if (d.side !== 'def' || d.down || d.tackleCooldown > 0) continue;
      if (dist(d.pos, c.pos) > TACKLE.range) continue;
      const engaged = this.blocks.some((b) => b.defender === d.id);
      if (engaged && dist(d.pos, c.pos) > TACKLE.engagedRange) continue;
      const out = resolveTackle({
        tacklerPos: d.pos, tacklerVel: d.vel, carrierPos: c.pos, carrierVel: c.vel,
        tackling: d.player.ratings.tackling, carrierStrength: c.player.ratings.strength, carrierSpeed: c.player.ratings.speed,
        engaged, juking: this.t < this.dashUntil, factor: this.tacklingFactor, rng: this.rng,
      });
      const heading = Math.atan2(d.pos.x - c.pos.x, d.pos.y - c.pos.y);
      const anim = (role: 'carrier' | 'tackler'): ContactAnim => ({ kind: out.kind, role, t: this.t, duration: out.contactTime, down: out.success, heading: role === 'carrier' ? heading : heading + Math.PI });
      c.anim = anim('carrier');
      d.anim = anim('tackler');
      if (out.success) {
        const dir = len(c.vel) > 0.5 ? norm(c.vel) : v2(0, 1);
        c.vel = scale(dir, out.fallForward / out.contactTime);
        d.vel = c.vel;
        this.contact = { carrier: c.id, tackler: d.id, whistleAt: this.t + out.contactTime };
        return;
      }
      d.tackleCooldown = TACKLE.brokenCooldown;
      c.vel = scale(c.vel, out.slow);
      this.emit('brokenTackle', d.id);
    }
  }

  private whistle() {
    const c = this.actors[this.contact!.carrier];
    this.contact = null;
    c.down = true;
    this.finish(c.pos.y <= 0 && this.caughtAt && this.caughtAt.y <= 0 ? 'touchback' : c.pos.y <= 0 ? 'safety' : 'tackle');
  }

  private checkBoundaries() {
    const c = this.carrier;
    if (!c) return;
    if (c.pos.y >= FIELD.length) {
      this.finish('touchdown');
      return;
    }
    if (Math.abs(c.pos.x) > FIELD.halfWidth) this.finish(c.pos.y <= 0 ? 'safety' : 'outOfBounds');
  }

  private finish(outcome: ReturnOutcome) {
    const c = this.carrier ?? this.returner;
    this.emit(outcome === 'touchdown' ? 'touchdown' : outcome === 'outOfBounds' ? 'outOfBounds' : 'tackle', c.id);
    this.result = this.makeResult(outcome, c.pos);
  }

  private finishKickOOB() {
    this.result = { ...this.makeResult('tackle', this.ball.pos), outcome: 'outOfBoundsKick', description: 'Kick out of bounds' };
  }

  private makeResult(outcome: ReturnOutcome, at: Vec2): ReturnResult {
    const endY = outcome === 'touchdown' ? FIELD.length : clamp(at.y, -FIELD.endzone, FIELD.length);
    const from = this.caughtAt?.y ?? endY;
    const yards = Math.round(endY - from);
    const r = this.returner.player;
    const who = `#${r.number} ${r.name}`;
    const description =
      outcome === 'touchdown' ? `${who} takes it all the way!`
        : outcome === 'touchback' ? 'Touchback'
          : outcome === 'downed' ? 'Punt downed by the coverage team'
            : outcome === 'safety' ? 'Tackled in the end zone: safety'
              : `${who} returns it ${yards} yards${outcome === 'outOfBounds' ? ', out of bounds' : ''}`;
    return { outcome, endX: clamp(at.x, -FIELD.halfWidth, FIELD.halfWidth), endY, yards, duration: this.t, description, returnerName: who };
  }
}
