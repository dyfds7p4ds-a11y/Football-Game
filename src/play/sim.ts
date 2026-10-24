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
import { ROUTE_BOUNDS, boundRouteVelocity, buildRoute, type Route } from './routes';
import { ZONES, type DefAssignment, type DefenseCall } from './defenseCalls';
import { computeThrow, ballHeightAt, THROW, throwWindow, type ThrowWindow } from './throw';
import { resolveCatch, type CatchCandidate } from './catch';
import { FIELD } from './field';
import { COVERAGE, CoverageReader, ZoneMatcher, carrySpot, inPhaseSpot, overTop, type Helper, type ReadTarget, type ZoneArea } from './coverage';
import { inPhase, throwingWindow } from './windows';
import RUN_GAME from '../data/runGame.json';
import { freshSprint, sprintFumbleFactor, sprintSpeed, stepSprint, type SprintState } from './sprint';
import { TACKLE, resolveTackle, type ContactKind } from './tackle';
import { SCREEN, screenTiming, type ScreenTiming } from './screen';
import { nearestOfficial, setupOfficials, updateOfficials, type Official } from './officials';
import { PENALTIES, callFoul, makeFoul, rollFoul, type Flag, type Foul, type FoulType, type PenaltyBias } from './penalties';
import { DEF_CONTROL, combinedEffect, jumpTiming, readGrade, type JumpGrade, type ReadGrade } from './interception';
import {
  BLOCKING, assignProtection, blockQuality, comboBonus, holdTime, runBlockGrade, runScheme, laneCandidates, pickLane, planRunBlocks, progressRate,
  type BlockAssignment, type BlockMode, type BlockRole, type LaneDefender, type Unit,
} from './blocking';
import { AUDIBLES } from './audible';
import turnoverJson from '../data/turnovers.json';
import { BLITZ, blitzDesign, blitzPath, classifyBlitz, recognizeChance, surpriseReaction, type BlitzFacts, type BlitzOutcome, type BlitzPath } from './blitz';
import { switchTarget } from './defenseSelect';
import pocketJson from '../data/pocket.json';

export const POCKET = pocketJson.pocket;
export const SCRAMBLE = pocketJson.scramble;

export const SIM_DT = 1 / 60;
const HISTORY = 90;
const MAX_PLAY_TIME = 25;
/** Phase 3c: returnable turnovers (data/turnovers.json). */
export const TURNOVERS = turnoverJson as {
  fumble: { base: number; shoulder: number; sack: number; strengthWeight: number; max: number };
  loose: { popSpeed: number; friction: number; recoverRadius: number; recoverChance: number; maxLoose: number };
  return: { lookAhead: number; avoid: number; blockRange: number; blockedSpeed: number; jukeSpeed: number; jukeTime: number; jukeCooldown: number; maxReturnTime: number };
};

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
  /** Sim time of the user defender's last JUMP press (-Infinity: none). */
  jumpT: number;
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
  /** Phase 3d: SPRINT held (user ball carrier). */
  sprint?: boolean;
  /** User on defense: stick for the selected defender and the edge-triggered JUMP button. */
  defense?: { move: Vec2; jump: boolean };
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
  /** Phase 4: pressure at the release, the aim point and whether the release was inside the green window. */
  pressure?: number;
  aim?: Vec2;
  green?: boolean;
}

/** Phase 4: why a pass fell incomplete (logged in debug mode, `PlaySim.incompleteReason`). */
export interface IncompleteReason {
  reason: 'tipped' | 'defended' | 'drop' | 'contestedDrop' | 'outOfReach' | 'outOfBounds';
  /** The release: inside the green window? quality 0..1, pressure 0..1. */
  green: boolean;
  quality: number;
  pressure: number;
  /** Yards between the aim point and the landing, and from the target to the landing at the arrival. */
  miss: number;
  targetDist: number | null;
  /** Nearest defender to the landing at the arrival (yd). */
  defenderDist: number;
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
  | 'scramble' | 'shed' | 'slide' | 'flag' | 'jump' | 'timing' | 'chip' | 'hurry' | 'pickup' | 'rip'
  | 'fumble' | 'recovery';

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
  /** Phase 3c: the defense got the ball on a fumble (outcome 'interception' = the defense's ball at endY). */
  fumble?: boolean;
  /** Phase 3c: yards the defense returned the turnover (toward the offense's goal line). */
  returnYards?: number;
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
  /** The user plays defense: `SimInput.defense` moves the selected defender (CB1 first). */
  userDefense?: boolean;
}

interface Engagement {
  blocker: number;
  defender: number;
  t: number;
  /** Phase 3b: matchup grade (blocking.ts), hold time and how much of it is used up. */
  mode: BlockMode;
  quality: number;
  holdT: number;
  progress: number;
}

/** A blitzing non-lineman: his path, where he is on it, and what has happened to him. */
/** Phase 3c: a rush the protection did not plan for (see blitz.json `surprise`). */
export interface SurpriseRush {
  id: number;
  /** The call sent him (a designed blitzer the line missed) or not (the user's own blitz). */
  scheduled: boolean;
  rushAt: number;
  /** When the line treats him as a rusher, and when the QB notices him. */
  lineAt: number;
  qbAt: number;
  blind: boolean;
  /** First throw / scramble after the QB noticed him. */
  reactedAt: number | null;
  facts: BlitzFacts;
}

interface BlitzRun {
  path: BlitzPath;
  delay: number;
  points: Vec2[];
  idx: number;
  facts: BlitzFacts;
}

export interface BlitzReport {
  id: number;
  slot: DefSlot;
  path: BlitzPath;
  outcome: BlitzOutcome;
}

/** Read-only view of a block for the renderer, HUD and tests. */
export interface BlockState {
  blocker: number;
  defender: number;
  role: BlockRole;
  quality: number;
  /** 0..1 share of the hold time used up. */
  progress: number;
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
  /** Phase 4: debug mode logs the reason for every incomplete pass (console.debug). */
  static debug = false;
  /** Phase 4: why the last pass fell incomplete (null: no incomplete pass). */
  incompleteReason: IncompleteReason | null = null;
  /** Phase 4: when the QB left the pocket (Infinity = never). */
  scrambleAt = Infinity;
  charge = 0;
  charging = false;
  readonly officials: Official[];
  readonly fouls: Foul[] = [];
  readonly flags: Flag[] = [];
  /** User-controlled defender (-1: the user plays offense). Every other defender stays CPU. */
  userDefId = -1;
  /** Timing grade of the user defender's jump on the last pass that arrived near him. */
  lastTiming: { grade: JumpGrade; offset: number; read: ReadGrade; margin: number } | null = null;


  private rng: Rng;
  private steps = 0;
  private events: PlayEvent[] = [];
  private engagements: Engagement[] = [];
  private passBlock = new Map<number, number>();
  private blockRoles = new Map<number, BlockAssignment>();
  /** Chip-and-release backs who already let go of their chip. */
  private chipDone = new Set<number>();
  private laneX: number | null = null;
  private blitzers = new Map<number, BlitzRun>();
  /** Designed blitzers the line identified at the snap. */
  private seenBlitz = new Set<number>();
  /** Phase 3c: rushes nobody planned for, by defender id. */
  readonly surprise = new Map<number, SurpriseRush>();
  /**
   * Phase 3c: a run audible caught the defense in a blitz it did not adjust
   * (play/audible.ts): blitzers read the run late, run blocks grade better.
   * Set before the first step.
   */
  audibleEdge = false;
  /** Phase 3c: a turnover being returned (interception, or a fumble the defense recovered). */
  turnover: { kind: 'interception' | 'fumble'; at: Vec2; t: number; by: number } | null = null;
  /** Phase 3c: a live fumble on the ground (who lost it, when, where). */
  loose: { t: number; by: number; at: Vec2 } | null = null;
  /** Phase 3c: offensive player the user steers while the defense returns a turnover. */
  private pursuerId = -1;
  private caughtPass = false;
  private fumbleRng: Rng;
  /** Phase 3c: the open receiver once the QB has noticed a surprise rush (null: no alert). */
  hot: EligibleSlot | null = null;
  private lastRip = -Infinity;
  private laneEvalAt = 0;
  private shedFrom = new Map<number, { blocker: number; until: number }>();
  private throwArmed = false;
  private keep = false;
  private passThrown = false;
  private handedOff = false;
  private runRecognizedAt = Infinity;
  /** Phase 3d: box defenders key the run off the line's run blocks at this time (designed runs, not draws). */
  private runKeyAt = new Map<number, number>();
  /** Phase 3d: the toss's contain man (-1: none), and where everyone lined up (reach blocks use the alignment). */
  private edgeSetter = -1;
  private edgePlan = { read: Infinity, aim: v2() };
  private aligned = new Map<number, Vec2>();
  private throwAt = Infinity;
  private pitched = false;
  private jukeUntil = 0;
  private jukeCooldown = 0;
  /** Phase 3d: the user carrier's sprint and stamina (per play). */
  readonly sprint: SprintState = freshSprint();
  private carrierPath: Vec2[] = [];
  private carrierIdx = 0;
  private bySlot = new Map<string, Actor>();
  readonly coverage: CoverageReader;
  /** Underneath defender id -> vertical receiver id he is carrying. */
  private carry = new Map<number, number>();
  /** Phase 3c: underneath zone ownership with handoffs. */
  readonly zones = new ZoneMatcher();
  /** Phase 3c: receiver handoffs between zone defenders so far (from, to, receiver). */
  readonly handoffs: { t: number; from: number; to: number; receiver: number }[] = [];
  private contact: Contact | null = null;
  /** When the defense has read the screen (Infinity until then). */
  private screenReadAt = Infinity;
  /** Separate stream so turning penalties on or off never changes the football. */
  private penRng: Rng;
  private penaltyBias: PenaltyBias;
  /** Block rep variance on its own stream, so blocking draws never shift the rest of the play. */
  private blockRng: Rng;

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
    this.blockRng = this.penRng.fork();
    // Own seed (not a fork): fumbles must not shift the block or penalty streams.
    this.fumbleRng = new Rng((opts.seed ^ 0x2c1b3c6d) >>> 0);
    const bias = opts.penaltyBias ?? { off: 1, def: 1 };
    this.penaltyBias = { off: bias.off * this.diff.penaltyRate, def: bias.def * this.diff.penaltyRate };
    this.officials = setupOfficials(this.los, this.ballX);
    if (opts.userDefense) this.userDefId = this.getDef('CB1').id;
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
    this.setupBlitzes();
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
      jumpT: -Infinity,
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
          ? [v2(this.ballX + run.aim * 0.55, this.los - RUN_GAME.toss.depth), v2(aimX, this.los - RUN_GAME.toss.cornerDepth), v2(aimX + Math.sign(run.aim), this.los + 40)]
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
    const unit = (a: Actor, kind: Unit['kind']): Unit => ({ id: a.id, x: a.pos.x, y: a.pos.y, kind });
    const defs = this.actors.filter((a) => a.side === 'def');
    if (this.play.run) {
      const blockers = OL_SLOTS.map((s) => unit(this.get(s), 'ol'));
      if (this.play.routes.TE?.route === 'block') blockers.push(unit(this.get('TE'), 'block'));
      // The box: the front, linebackers and any defender walked down within 6 yd of the ball.
      const inBox = (d: Actor) => Math.abs(d.pos.x - this.ballX) < 6 && d.pos.y < this.los + 8;
      const box = defs.filter((d) => d.position === 'DL' || d.position === 'LB' || inBox(d)).map((d) => ({
        ...unit(d, 'def'), rushing: d.position === 'DL' || d.assignment?.kind === 'rush', lb: d.position !== 'DL',
      }));
      for (const a of planRunBlocks(this.play.run, this.ballX, blockers, box)) this.blockRoles.set(a.blocker, a);
      for (const a of this.actors) this.aligned.set(a.id, { ...a.pos });
      if (runScheme(this.play.run) === 'toss') {
        const dir = Math.sign(this.play.run.aim) || 1;
        let best: Actor | null = null;
        for (const d of defs) {
          const inBoxOrRush = box.some((u) => u.id === d.id) || d.assignment?.kind === 'rush';
          if (inBoxOrRush && d.pos.y < this.los + RUN_GAME.edge.maxDepth && (!best || (d.pos.x - best.pos.x) * dir > 0)) best = d;
        }
        this.edgeSetter = best ? best.id : -1;
        if (best) {
          const E = RUN_GAME.edge;
          const late = this.blockRng.chance(E.late * (1.2 - best.player.ratings.awareness / 100)) ? E.lateDelay : 0;
          this.edgePlan = {
            read: E.read * Math.exp(this.blockRng.normal() * E.readSigma) + late,
            aim: v2(this.blockRng.normal() * E.aimSigma, this.blockRng.normal() * E.aimSigma),
          };
        }
      }
      const keyRead = (BLOCKING.runFit.keyReadByScheme as Record<string, number | undefined>)[runScheme(this.play.run)];
      if (keyRead !== undefined) {
        const F = BLOCKING.runFit;
        for (const u of box) {
          const aw = this.actors[u.id].player.ratings.awareness;
          const miss = this.blockRng.chance(F.misread * (1.2 - aw / 100)) ? F.misreadDelay : 0;
          this.runKeyAt.set(u.id, keyRead * Math.exp(this.blockRng.normal() * F.keySigma) + miss);
        }
      }
      this.laneX = this.ballX + this.play.run.aim;
      return;
    }
    const qb = this.get('QB');
    const rushers = defs.filter((a) => a.assignment?.kind === 'rush').map((d) => unit(d, 'def'));
    const blockers = OL_SLOTS.map((s) => unit(this.get(s), 'ol'));
    for (const s of ELIGIBLE) {
      const a = this.get(s);
      if (a.route?.blocks && a.route.type !== 'fake') blockers.push(unit(a, a.route.type === 'check' ? 'check' : 'block'));
    }
    // The protection may not see every blitz (path, line awareness): an unseen blitzer comes free.
    const ol = OL_SLOTS.map((s) => this.get(s));
    const awareness = ol.reduce((t, a) => t + a.player.ratings.awareness, 0) / ol.length;
    const seen = new Set<number>();
    for (const [id, bz] of this.blitzers) if (this.blockRng.chance(recognizeChance(bz.path, awareness))) seen.add(id);
    this.seenBlitz = seen;
    const recognized = (r: Unit) => !this.blitzers.has(r.id) || seen.has(r.id);
    for (const a of assignProtection(blockers, rushers, qb.pos, this.ballX, recognized)) {
      this.blockRoles.set(a.blocker, a);
      if (a.target !== null) this.passBlock.set(a.blocker, a.target);
    }
  }

  private setupBlitzes() {
    const qb = this.get('QB');
    const launch = v2(qb.pos.x, Math.min(qb.pos.y, this.los - 1) - 2);
    for (const d of this.actors) {
      if (d.side !== 'def' || d.assignment?.kind !== 'rush' || d.position === 'DL') continue;
      const design = blitzDesign(this.defense.id, d.slot as DefSlot, d.pos.x, this.ballX);
      this.blitzers.set(d.id, {
        ...design, points: blitzPath(design.path, d.pos, this.ballX, this.los, launch), idx: 0,
        facts: { sacked: false, closest: Infinity, atRelease: Infinity, engaged: false },
      });
    }
  }

  /** One outcome per blitzer (sack, hurry, blocked, late); final once the play is over. */
  blitzReport(): BlitzReport[] {
    return [...this.blitzers.entries()].map(([id, b]) => ({
      id, slot: this.actors[id].slot as DefSlot, path: b.path, outcome: classifyBlitz(b.facts),
    }));
  }

  /** Phase 3c: is the QB alerted to a surprise rush right now? */
  get qbAlert(): boolean {
    for (const r of this.surprise.values()) if (this.t >= r.qbAt && !this.actors[r.id].down) return true;
    return false;
  }

  /** Phase 3c: detection and outcome of every surprise rush (final once the play is over). */
  surpriseReport(): { id: number; slot: DefSlot; scheduled: boolean; detect: number; react: number | null; blind: boolean; outcome: BlitzOutcome }[] {
    return [...this.surprise.values()].map((r) => ({
      id: r.id, slot: this.actors[r.id].slot as DefSlot, scheduled: r.scheduled, detect: r.qbAt - r.rushAt,
      react: r.reactedAt === null ? null : r.reactedAt - r.rushAt, blind: r.blind, outcome: classifyBlitz(r.facts),
    }));
  }

  /**
   * Phase 3c: spot rushers the protection did not plan for by what they do,
   * not by the call: a non-lineman at the LOS closing on the QB. Gives the
   * line and the QB a reaction delay (awareness, field of view).
   */
  private trackSurprise() {
    const qb = this.get('QB');
    // Screens invite the rush on purpose: defenders rallying to the back are not a surprise.
    if (this.play.run || this.play.screen || this.passThrown || this.handedOff || this.ball.holder !== qb.id) return;
    const S = BLITZ.surprise;
    const ol = OL_SLOTS.map((x) => this.get(x));
    const lineAw = ol.reduce((t, a) => t + a.player.ratings.awareness, 0) / ol.length;
    for (const d of this.actors) {
      if (d.side !== 'def' || d.down || d.position === 'DL' || this.surprise.has(d.id)) continue;
      const designed = this.blitzers.has(d.id);
      if (designed && this.seenBlitz.has(d.id)) continue;
      if (!designed && d.assignment?.kind === 'rush') continue;
      // A man defender running with his receiver (a back near the QB) is covering, not rushing.
      const asg = d.assignment;
      // Linebackers stepping up on a play fake are not rushing.
      if (this.play.playAction && this.t < this.diff.playActionBite && d.id !== this.userDefId) continue;
      const to = sub(qb.pos, d.pos);
      const dd = len(to);
      if (!designed && asg?.kind === 'man' && d.id !== this.userDefId) {
        const r = this.get(asg.target);
        const toR = sub(r.pos, d.pos);
        const cosR = (toR.x * to.x + toR.y * to.y) / Math.max(1e-6, len(toR) * dd);
        if (r.route?.blocks || len(toR) < S.coverRange || cosR > Math.cos((S.coverAngle * Math.PI) / 180)) continue;
      }
      if (d.pos.y > this.los + S.maxDepth || dd > S.range || dd < 0.1) continue;
      const closing = (d.vel.x * to.x + d.vel.y * to.y) / dd;
      if (closing < S.minClosing) continue;
      const toward = Math.atan2(-to.x, -to.y); // heading from the QB to the rusher
      let ang = ((toward - qb.facing) * 180) / Math.PI;
      ang = ((ang + 540) % 360) - 180;
      const react = surpriseReaction(ang, lineAw, qb.player.ratings.awareness);
      this.surprise.set(d.id, {
        id: d.id, scheduled: designed, rushAt: this.t, lineAt: this.t + react.line, qbAt: this.t + react.qb, blind: react.blind,
        reactedAt: null, facts: { sacked: false, closest: dd, atRelease: Infinity, engaged: false },
      });
    }
    for (const r of this.surprise.values()) {
      const d = this.actors[r.id];
      r.facts.closest = Math.min(r.facts.closest, dist(d.pos, qb.pos));
      if (!r.facts.engaged && this.engagersOf(d) > 0) {
        r.facts.engaged = true;
        if (!r.scheduled) this.emit('pickup', r.id);
      }
    }
  }

  /** Phase 3c: once alerted, the most open receiver right now is the hot read. */
  private updateHot() {
    const qb = this.get('QB');
    if (!this.qbAlert || this.passThrown || this.handedOff || this.ball.holder !== qb.id) {
      this.hot = null;
      return;
    }
    const defs = this.actors.filter((a) => a.side === 'def' && !a.down);
    let best: { slot: EligibleSlot; m: number } | null = null;
    for (const slot of ELIGIBLE) {
      const r = this.get(slot);
      if (r.down || r.route?.blocks) continue;
      const m = throwingWindow(qb.pos, r, defs).margin;
      if (!best || m > best.m) best = { slot, m };
    }
    this.hot = best ? best.slot : null;
  }

  private markReaction() {
    for (const r of this.surprise.values()) if (r.reactedAt === null && this.t >= r.qbAt) r.reactedAt = this.t;
  }

  private trackBlitzes() {
    const qb = this.get('QB');
    this.trackSurprise();
    if (this.ball.holder !== qb.id || this.passThrown) return;
    for (const [id, b] of this.blitzers) {
      const d = this.actors[id];
      b.facts.closest = Math.min(b.facts.closest, dist(d.pos, qb.pos));
      if (!b.facts.engaged && this.engagersOf(d) > 0) {
        b.facts.engaged = true;
        this.emit('pickup', id);
      }
    }
  }

  /** Current blocks with their role, matchup grade and how close they are to breaking. */
  blockStates(): BlockState[] {
    return this.engagements.map((e) => ({
      blocker: e.blocker, defender: e.defender, role: this.blockRoles.get(e.blocker)?.role ?? (e.mode === 'run' ? 'runBlock' : 'passSet'),
      quality: e.quality, progress: clamp(e.progress / e.holdT, 0, 1),
    }));
  }

  /** Protection / run-block responsibility given at the snap. */
  blockRole(blocker: number): BlockAssignment | undefined {
    return this.blockRoles.get(blocker);
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

  /** Phase 3c: the defense has the ball and is returning it. */
  get returning(): boolean {
    return this.turnover !== null && this.carrier?.side === 'def';
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

  /** Phase 3d: the pass is out (the receiver buttons stay visible while it is in the air). */
  get thrown(): boolean {
    return this.passThrown;
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
    this.trackBlitzes();
    this.integrate(dt, desired);
    this.separate();
    this.keepInBounds();
    this.updateBall(dt);
    if (!this.result) this.handleThrowing(input);
    if (!this.result) this.checkTackles();
    if (!this.result) this.checkBoundaries();
    if (!this.result && this.contact && this.t >= this.contact.whistleAt) this.whistleContact();
    if (!this.result && this.t > MAX_PLAY_TIME + (this.turnover || this.loose ? TURNOVERS.return.maxReturnTime : 0)) {
      const c = this.carrier;
      this.finish(c ? 'tackle' : 'incomplete', c ?? this.get('QB'));
    }
    this.updatePressure();
    this.updateHot();
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

  /** User defense: hand control to another defender (CPU takes over the previous one). */
  selectDefender(slot: DefSlot) {
    // Phase 3c: the user keeps the man with the ball until the return is over.
    if (this.userDefId < 0 || (this.returning && this.carrier?.id === this.userDefId)) return;
    const d = this.getDef(slot);
    if (!d.down) this.userDefId = d.id;
  }

  /** SWITCH button: nearest the ball during the play, next in order before the snap. */
  switchDefender(live: boolean): DefSlot | null {
    const cur = this.userDefender;
    if (!cur) return null;
    const cands = this.actors.filter((a) => a.side === 'def').map((a) => ({ slot: a.slot as DefSlot, pos: a.pos, down: a.down }));
    const slot = switchTarget(cands, cur.slot as DefSlot, this.ball.pos, live);
    this.selectDefender(slot);
    return this.userDefender!.slot as DefSlot;
  }

  get userDefender(): Actor | null {
    return this.userDefId >= 0 ? this.actors[this.userDefId] : null;
  }

  /** The selected defender: stick movement plus a timed JUMP toward the ball, the carrier or his man. */
  private controlDefender(inp: { move: Vec2; jump: boolean } | undefined, desired: Map<number, Vec2>) {
    const d = this.userDefender;
    if (!d || d.down || (this.contact && this.contact.tackler === d.id)) return;
    const J = DEF_CONTROL.jump;
    if (this.t - d.jumpT < J.duration) {
      desired.set(d.id, d.vel); // airborne: momentum only
      return;
    }
    const move = clampLen(inp?.move ?? v2(), 1);
    if (this.carrier === d) {
      // Phase 3c: returning a turnover: full speed (idle stick = the CPU return line), JUMP = juke.
      desired.set(d.id, len(move) > 0.15 ? scale(move, d.maxSpeed) : this.returnRun(d));
      const R = TURNOVERS.return;
      if (inp?.jump && this.jukeCooldown <= 0) {
        const side = Math.abs(move.x) > 0.2 ? Math.sign(move.x) : this.rng.chance(0.5) ? 1 : -1;
        d.vel = add(d.vel, v2(side * R.jukeSpeed, 0));
        this.jukeUntil = this.t + R.jukeTime;
        this.jukeCooldown = R.jukeCooldown;
        this.emit('juke', d.id);
      }
      return;
    }
    desired.set(d.id, scale(move, d.maxSpeed * DEF_CONTROL.moveSpeed));
    if (!inp?.jump) return;
    const eng = this.engagements.find((e) => e.defender === d.id);
    if (eng && !(this.ball.state === 'air' && this.ball.flight && !this.ball.flight.lateral)) {
      // Engaged by a blocker: JUMP is a rip move that eats into the block's hold time.
      if (this.t - this.lastRip < DEF_CONTROL.rip.cooldown) return;
      this.lastRip = this.t;
      eng.progress += DEF_CONTROL.rip.progress * (d.player.ratings.passRush / 75);
      this.emit('rip', d.id);
      return;
    }
    if (this.t - d.jumpT < J.cooldown) return;
    const f = this.ball.state === 'air' && this.ball.flight && !this.ball.flight.lateral ? this.ball.flight : null;
    const c = this.carrier;
    const asg = d.assignment;
    const aim = f ? f.landing
      : c && c.side === 'off' ? c.pos
        : asg?.kind === 'man' ? this.get(asg.target).pos
          : this.nearestEligible(d.pos).pos;
    const dir = norm(sub(aim, d.pos));
    d.jumpT = this.t;
    d.vel = scale(dir, Math.min(d.maxSpeed + J.lunge, len(d.vel) + J.lunge));
    desired.set(d.id, d.vel);
    this.emit('jump', d.id);
  }

  /**
   * Phase 3c: the user's offense lost the ball: he steers the offensive player
   * nearest the ball (live fumble) or the returner (with a little hysteresis);
   * an idle stick takes the pursuit angle. Tackles come from the tackle model.
   */
  private controlPursuer(input: SimInput, desired: Map<number, Vec2>) {
    const target = this.loose ? this.ball.pos : this.carrier!.pos;
    const cands = this.actors.filter((a) => a.side === 'off' && !a.down);
    if (cands.length === 0) {
      this.controlledId = -1;
      return;
    }
    const best = cands.reduce((m, a) => (dist(a.pos, target) < dist(m.pos, target) ? a : m));
    const cur = this.actors[this.pursuerId];
    const keep = cur && cur.side === 'off' && !cur.down && dist(cur.pos, target) < dist(best.pos, target) + 2;
    const p = keep ? cur : best;
    this.pursuerId = p.id;
    this.controlledId = p.id;
    const move = clampLen(input.move, 1);
    if (len(move) > 0.15) desired.set(p.id, scale(move, p.maxSpeed));
    else desired.set(p.id, this.loose ? this.looseGoal(p) : this.chase(p, this.carrier!));
  }

  private nearestEligible(p: Vec2): Actor {
    return ELIGIBLE.map((s) => this.get(s)).reduce((m, a) => (dist(a.pos, p) < dist(m.pos, p) ? a : m));
  }

  private controlUser(input: SimInput, desired: Map<number, Vec2>) {
    if (this.userDefId >= 0) this.controlDefender(input.defense, desired);
    if (this.userDefId < 0 && (this.loose || this.returning)) return this.controlPursuer(input, desired);
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
    // Phase 3d: SPRINT for a runner, or a QB once he is out of the pocket.
    const mayRun = controlled !== qb || this.scrambling || this.pastLos(qb);
    stepSprint(this.sprint, !!input.sprint && mayRun && len(move) > 0.15, this.t, SIM_DT);
    let v = scale(move, controlled.maxSpeed * sprintSpeed(this.sprint, controlled === qb));
    if (controlled === qb && v.y < 0) v = scale(v, 0.9); // backpedal / drop
    // Phase 4: a QB running across the field behind the line (not downhill) is slower than a runner.
    if (controlled === qb && this.scrambling && !this.pastLos(qb) && len(v) > 0) v = scale(v, 1 - SCRAMBLE.flatSlow * Math.abs(norm(v).x));
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
        this.scrambleAt = this.t;
        this.markReaction();
      }
      if (holds && this.pastLos(qb) && this.runRecognizedAt === Infinity) {
        if (!this.scrambling) this.scrambleAt = this.t;
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
      if (this.play.run?.style === 'toss' && !this.pitched && this.t > RUN_GAME.toss.pitchAt && !this.keep) {
        this.pitched = true;
        this.launchLateral(qb.pos, rb, RUN_GAME.toss.pitchTime);
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
    if (a.slot === 'RB' && this.play.run && this.handedOff) this.readLane(a);
    while (this.carrierIdx < this.carrierPath.length && a.slot === 'RB') {
      const p = this.carrierPath[this.carrierIdx];
      if (dist(a.pos, p) < 1.2 || p.y < a.pos.y - 0.5) this.carrierIdx++;
      else if (this.carrierIdx >= 2 && this.play.run?.style === 'toss') return this.openFieldDirection(a, norm(sub(p, a.pos)));
      else return norm(sub(p, a.pos));
    }
    return v2(0, 1);
  }

  /** Phase 3d: toss past the corner: bend away from unblocked defenders ahead, stay off the sideline. */
  private openFieldDirection(a: Actor, base: Vec2): Vec2 {
    const O = RUN_GAME.openField;
    let dir = base;
    for (const d of this.actors) {
      if (d.side !== 'def' || d.down || this.isEngaged(d)) continue;
      const off = sub(a.pos, d.pos);
      const l = len(off);
      if (l > O.lookAhead || d.pos.y < a.pos.y - 1) continue;
      dir = add(dir, v2(Math.sign(off.x || 1) * ((O.lookAhead - l) / O.lookAhead) * O.avoid, 0));
    }
    if (Math.abs(a.pos.x) > FIELD.halfWidth - O.sidelineMargin) dir = v2(dir.x - Math.sign(a.pos.x), dir.y);
    return norm(v2(dir.x, Math.max(dir.y, 0.5)));
  }

  /**
   * Run plays: the carrier reads how the blocks are going and takes the most
   * open gap of the design (zone runs have more options, toss none).
   */
  private readLane(rb: Actor) {
    const run = this.play.run!;
    if (run.style === 'toss' || this.t < this.laneEvalAt || rb.pos.y > this.los - BLOCKING.run.decideDepth + 1.5) return;
    this.laneEvalAt = this.t + 0.1;
    const defs: LaneDefender[] = [];
    for (const d of this.actors) {
      if (d.side !== 'def' || d.down || dist(d.pos, rb.pos) > 12) continue;
      const e = this.engagements.find((x) => x.defender === d.id);
      const state = !e ? 'free' : e.progress / e.holdT < 0.6 ? 'held' : 'even';
      defs.push({ x: d.pos.x, y: d.pos.y, state });
    }
    const lane = pickLane(laneCandidates(run, this.ballX), this.los, defs);
    this.laneX = lane.x;
    const i = Math.max(0, this.carrierIdx);
    if (i < this.carrierPath.length - 1) {
      this.carrierPath[i] = v2(lane.x, this.carrierPath[i].y);
      this.carrierPath[i + 1] = v2(lane.x + run.aim * 0.15, this.carrierPath[i + 1].y);
    }
  }

  private handoff(rb: Actor) {
    this.ball.holder = rb.id;
    this.controlledId = rb.id;
    this.handedOff = true;
    this.runRecognizedAt = Math.min(this.runRecognizedAt, this.t);
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
    // A free rusher in the QB's face at the release hurries the throw.
    let hurrier: Actor | null = null;
    for (const d of this.actors) {
      if (d.side !== 'def' || d.down || !this.pressuring(d) || this.engagersOf(d) > 0) continue;
      const dd = dist(d.pos, qb.pos);
      const bz = this.blitzers.get(d.id);
      if (bz) bz.facts.atRelease = dd;
      const sr = this.surprise.get(d.id);
      if (sr) sr.facts.atRelease = dd;
      if (dd <= BLITZ.hurryRadius && (!hurrier || dd < dist(hurrier.pos, qb.pos))) hurrier = d;
    }
    if (hurrier) {
      this.pressure = Math.max(this.pressure, BLITZ.hurryPressure);
      this.emit('hurry', hurrier.id);
    }
    const tgtPos = target ? target.pos : add(qb.pos, fromHeading(input.gazeYaw, 8 + this.charge * 40));
    const sol = computeThrow({
      from: qb.pos,
      target: tgtPos,
      targetVel: target ? target.vel : v2(),
      charge: Math.min(1, this.charge) - Math.max(0, this.charge - 1) * 2, // holding too long hurts
      // Phase 4: a throw on the run while scrambling counts as extra pressure.
      pressure: Math.min(1, this.pressure + (this.scrambling ? SCRAMBLE.throwOnRunPressure : 0)),
      accuracy: qb.player.ratings.throwAccuracy,
      power: qb.player.ratings.throwPower,
      qbSpeed: len(qb.vel),
      windowScale: this.userDefId >= 0 ? 1 : this.diff.throwWindow, // the throw-window difficulty is the user QB's; a CPU QB uses data/cpuOffense.json
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
      pressure: sol.pressure, aim: sol.aim, green: sol.green,
    };
    this.passThrown = true;
    this.throwAt = this.t;
    this.emit('throw', target?.id);
    this.markReaction();
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
      // Phase 3c: live fumble: go get it; defense returning a turnover: chase the returner.
      if (this.loose) {
        desired.set(a.id, this.looseGoal(a));
        continue;
      }
      if (this.returning) {
        desired.set(a.id, this.chase(a, carrier!));
        continue;
      }
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
        const role = this.blockRoles.get(a.id);
        const chipping = role?.role === 'chip' && !this.chipDone.has(a.id);
        if (chipping && this.t > BLOCKING.protection.chipMax && !this.isEngaged(a)) this.chipDone.add(a.id);
        // Check-release: a back with a blitzer to pick up stays in while that man is still coming.
        const man = role?.role === 'passSet' && role.target !== null ? this.actors[role.target] : null;
        const manComing = !!man && !man.down && this.isRushing(man) && man.pos.y > this.get('QB').pos.y - 1;
        const checkRelease = a.route.type === 'check' && !this.isEngaged(a) && !manComing &&
          (role?.role === 'chip' ? this.chipDone.has(a.id) : this.t > 1.5);
        if (checkRelease) {
          a.route = buildRoute({ route: 'flat' }, a.pos, this.ballX);
          a.route.points.forEach((p) => (p.y = Math.max(p.y, this.los + 1.5)));
        } else {
          desired.set(a.id, this.passPro(a));
          continue;
        }
      }
      desired.set(a.id, boundRouteVelocity(a.pos, this.followRoute(a), a.routeIdx >= (a.route?.points.length ?? 0)));
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
      // Someone else still has him (a beaten blocker on cooldown doesn't count).
      if ([...this.passBlock.entries()].some(([bid, rid]) => rid === d.id && bid !== b.id && !this.actors[bid].down && this.actors[bid].blockCooldown <= 0)) continue;
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
    const doubling = this.blockRoles.get(b.id)?.role === 'double' && r && this.engagersOf(r) < 2;
    if (!r || r.down || (this.engagersOf(r) > 0 && !this.isEngaged(b) && !doubling)) {
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
    const plan = !ref && this.play.run ? this.blockRoles.get(b.id) : undefined;
    const eng = this.isEngaged(b);
    if (plan?.climbAt !== undefined && this.t >= plan.climbAt && plan.climbTo != null) {
      // Gap scheme: the second man of the double team comes off and climbs to the linebacker.
      if (eng && eng.defender === plan.target) this.engagements = this.engagements.filter((e) => e !== eng);
      plan.target = plan.climbTo;
      plan.climbTo = null;
      plan.role = 'runBlock';
    }
    if (this.isEngaged(b)) return v2();
    const carrier = ref ?? this.carrier ?? this.get('RB');
    const tgt = plan && plan.target !== null ? this.actors[plan.target] : null;
    if (tgt && !tgt.down && this.carrier !== tgt && dist(tgt.pos, b.pos) < 9 && !this.pastLos(carrier)) {
      // Designed block: get on the man, between him and the lane.
      const laneX = this.laneX ?? carrier.pos.x;
      const spot = add(tgt.pos, scale(norm(v2(laneX - tgt.pos.x, -1.2)), 0.8));
      if (this.engagersOf(tgt) < 2 || plan!.role === 'double') this.tryEngage(b, tgt);
      return this.seek(b, spot, 1);
    }
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
    const mode = this.blockMode(b);
    // Phase 3d: zone / toss blocks on a man lined up playside have to reach him.
    const run = this.play.run;
    const reach = mode === 'run' && run && !this.pastLos(this.carrier ?? this.get('RB')) && (runScheme(run) === 'zone' || runScheme(run) === 'toss')
      ? ((this.aligned.get(d.id) ?? d.pos).x - (this.aligned.get(b.id) ?? b.pos).x) * (Math.sign(run.aim) || 1) : undefined;
    const grade = mode === 'run' ? runBlockGrade(b.player.ratings, d.player.ratings, { reachOffset: reach, scheme: run ? runScheme(run) : undefined }) : blockQuality(b.player.ratings, d.player.ratings, mode);
    const quality = clamp(grade + (this.audibleEdge && mode === 'run' ? AUDIBLES.edge.lineGrade : 0), -1, 1);
    const holdT = holdTime(quality, { mode, passRush: this.diff.passRush * (mode === 'pass' ? this.diff.pocketPressure : 1), rng: this.blockRng });
    this.engagements.push({ blocker: b.id, defender: d.id, t: 0, mode, quality, holdT, progress: 0 });
    if (mode !== 'run' && (this.blitzers.has(d.id) || this.surprise.has(d.id))) {
      // Blitz pickup: both lose most of their momentum, so a fast blitzer can't slide past the block.
      d.vel = scale(d.vel, 0.35);
      b.vel = scale(b.vel, 0.35);
    }
  }

  private passRushing(): boolean {
    const qb = this.get('QB');
    return !this.handedOff && !this.play.run && !(this.carrier && this.carrier !== qb) && !this.passThrown;
  }

  private blockMode(b: Actor): BlockMode {
    if (!this.passRushing()) return 'run';
    return this.blockRoles.get(b.id)?.role === 'chip' && !this.chipDone.has(b.id) ? 'chip' : 'pass';
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
    this.updateZoneMatches(receivers);

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
    const bz = this.blitzers.get(d.id);
    if (bz && !this.scrambling) {
      if (this.t < bz.delay) return d.pos; // disguise: hold the alignment until the delay
      while (bz.idx < bz.points.length - 1 && (dist(d.pos, bz.points[bz.idx]) < BLITZ.waypointRadius || bz.points[bz.idx].y > d.pos.y + 0.5)) bz.idx++;
      return bz.idx < bz.points.length - 1 ? bz.points[bz.idx] : qb.pos;
    }
    const startX = d.history.length ? d.history[0].x : d.pos.x;
    const side = Math.sign(startX - this.ballX);
    // Phase 4: a scrambling QB is chased with a pursuit angle; edge rushers on his side keep contain (stay outside him).
    if (this.scrambling) {
      const p = this.pursuit(d, qb);
      const toward = Math.sign(qb.vel.x) === side && Math.abs(qb.vel.x) > 1;
      return toward && Math.abs(startX - this.ballX) >= POCKET.edgeStartWidth ? v2(p.x + side * SCRAMBLE.containOutside, p.y) : p;
    }
    if (Math.abs(startX - this.ballX) < POCKET.edgeStartWidth) return qb.pos;
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
  /** Rusher as the blockers see him: assigned, a green dog, or (Phase 3c) a surprise rusher once the line reacts. */
  private isRushing(d: Actor): boolean {
    const a = d.assignment;
    if (a?.kind === 'rush') return true;
    const sr = this.surprise.get(d.id);
    if (sr && this.t >= sr.lineAt) return true;
    if (a?.kind !== 'man' || this.t <= 1.2) return false;
    const r = this.get(a.target).route;
    return !!r?.blocks && !(r.type === 'check' && this.t > 1.5);
  }

  /**
   * Phase 4: does this coverage defender leave his assignment to play a scrambling QB?
   * Spies and underneath zones (and deep zones later) react once the QB is out of the
   * tackle box or heading upfield; man defenders stay on their man until he crosses the line.
   */
  private scrambleRead(d: Actor, asg: DefAssignment, isDeep: boolean, qb: Actor, flight: boolean): boolean {
    if (!this.scrambling || flight || this.ball.holder !== qb.id || this.passThrown) return false;
    if (asg.kind !== 'spy' && asg.kind !== 'zone') return false;
    const out = Math.abs(qb.pos.x - this.ballX) > SCRAMBLE.boxWidth || qb.vel.y > SCRAMBLE.upfieldSpeed;
    if (!out) return false;
    const read = asg.kind === 'spy' ? SCRAMBLE.spyRead : isDeep ? SCRAMBLE.deepRead : SCRAMBLE.underneathRead;
    return this.t > this.scrambleAt + read + d.reaction * SCRAMBLE.reactFactor;
  }

  /** Phase 3c: pressure comes from whoever is actually rushing, seen by the line or not. */
  private pressuring(d: Actor): boolean {
    return this.isRushing(d) || this.surprise.has(d.id);
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
    // Phase 3d: a pitch in the air is still a run: the defense fits on the back it goes to.
    const lat = this.ball.state === 'air' && this.ball.flight?.lateral ? this.ball.flight.targetId : null;
    const pitchTo = lat !== null ? this.actors[lat] : null;
    const runner = carrier && carrier.side === 'off' ? carrier : pitchTo;
    const runMode = runner && (runner !== qb || this.runRecognizedAt < Infinity);
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

      if (this.loose) {
        desired.set(d.id, this.looseGoal(d));
        continue;
      }
      // A blitzer caught by a run audible (3c edge) is still in his blitz: nobody sets the edge.
      if (d.id === this.edgeSetter && runner && !this.pastLos(runner) && this.carrierIdx < 2 && this.t > this.edgePlan.read &&
        !(this.audibleEdge && this.blitzers.has(d.id))) {
        // Phase 3d: contain on a toss: attack the corner before the back gets there.
        const corner = this.carrierPath[1];
        const dir = Math.sign(this.play.run!.aim) || 1;
        const aim = add(v2(corner.x + dir * 0.5, corner.y - RUN_GAME.edge.aimBehind), this.edgePlan.aim);
        desired.set(d.id, dist(d.pos, runner.pos) < 2.5 ? this.pursuit(d, runner) : this.seek(d, aim, 1));
        continue;
      }
      if (carrier && carrier.side === 'def') {
        // Phase 3c: the returner runs, the rest of the defense blocks for him.
        desired.set(d.id, d === carrier ? this.returnRun(d) : this.escort(d, carrier));
        continue;
      } else if (runMode && this.t > Math.min(this.runRecognizedAt, this.audibleEdge && this.blitzers.has(d.id) ? Infinity : this.runKeyAt.get(d.id) ?? Infinity) +
        d.reaction * (runner === qb ? SCRAMBLE.reactFactor : 1) + (isDeep ? 0.35 : 0) +
        (this.audibleEdge && this.blitzers.has(d.id) ? AUDIBLES.edge.blitzRunRead : 0)) {
        goal = this.pursuit(d, runner!);
      } else if (this.scrambleRead(d, asg, isDeep, qb, !!flight)) {
        // Phase 4: underneath zones and spies come up on a scrambling QB once he leaves the box.
        goal = this.pursuit(d, qb);
      } else if (flight && asg.kind === 'man' && this.get(asg.target).id === flight.targetId && this.trailing(d, this.get(asg.target))) {
        // Trailing man defender can't see the ball: play through the receiver's hands.
        const r = this.get(asg.target);
        goal = add(r.pos, scale(r.vel, 0.25));
      } else if (flight && this.t > this.throwAt + d.reaction * (asg.kind === 'zone' ? COVERAGE.zone.ballReadFactor : 1) + (asg.kind === 'man' ? COVERAGE.manBallReadDelay : 0)) {
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

  /** Phase 3c: the area an underneath zone defender owns (absolute yards). */
  private zoneArea(d: Actor, zone: keyof typeof ZONES): ZoneArea {
    const z = ZONES[zone];
    return { id: d.id, land: this.zoneLandmark(zone), w: z.w, minY: this.los + COVERAGE.zone.minDepth, maxY: this.los + z.y + COVERAGE.zone.maxExtra };
  }

  private updateZoneMatches(receivers: ReadTarget[]) {
    const areas: ZoneArea[] = [];
    for (const d of this.actors) {
      const a = d.assignment;
      if (d.side !== 'def' || d.down || a?.kind !== 'zone' || ZONES[a.zone].deep || this.t < d.reaction) continue;
      if (d.id === this.userDefId) continue; // the user plays his own zone
      areas.push(this.zoneArea(d, a.zone));
    }
    for (const h of this.zones.update(areas, receivers)) this.handoffs.push({ t: this.t, ...h });
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
        if (!z.deep) {
          // Phase 3c: pattern-match zone: work toward the receiver he owns, never out of his area.
          const rid = this.zones.matches.get(d.id);
          if (rid === undefined) return add(land, d.coverOffset);
          const ZC = COVERAGE.zone;
          const seen = this.perceived(this.actors[rid], d.reaction);
          const g = add(lerp(land, add(seen, v2(0, 0.8)), ZC.sink), d.coverOffset);
          return v2(clamp(g.x, land.x - z.w * ZC.leash, land.x + z.w * ZC.leash), clamp(g.y, this.los + 1, this.los + z.y + ZC.maxExtra));
        }
        let threat: Actor | null = null;
        let best = Infinity;
        for (const s of ELIGIBLE) {
          const r = this.get(s);
          if (r.route?.blocks) continue;
          const seen = this.perceived(r, d.reaction);
          const dx = Math.abs(seen.x - land.x);
          if (dx > z.w) continue;
          if (seen.y < this.los + 7) continue;
          // Deep defenders prioritise vertical stems over anything else in their zone.
          const score = dist(seen, land) - (z.deep && this.coverage.verticals.has(r.id) ? 8 : 0);
          if (score < best) {
            best = score;
            threat = r;
          }
        }
        if (!threat) return add(land, d.coverOffset);
        const seen = this.perceived(threat, d.reaction);
        const vel = this.perceivedVel(threat, d.reaction * 0.6);
        const top = overTop({ pos: seen, vel }, this.ballX, COVERAGE.deepCushion, COVERAGE.deepLead);
        return v2(land.x * 0.3 + top.x * 0.7 + d.coverOffset.x, Math.max(land.y, top.y));
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
      const rushing = this.passRushing();
      const mode: BlockMode = e.mode === 'chip' && rushing ? 'chip' : rushing ? 'pass' : 'run';
      if (mode !== e.mode) {
        // Pass set turns into a run block (handoff, catch): a new rep for the new job.
        e.mode = mode;
        e.quality = blockQuality(b.player.ratings, d.player.ratings, mode);
        e.holdT = holdTime(e.quality, { mode, passRush: this.diff.passRush, rng: this.blockRng });
        e.progress = 0;
      }
      const n = this.engagersOf(d);
      // A QB who holds the ball past the grace period wears the line down faster.
      const hold = rushing ? 1 + BLOCKING.hold.qbHoldFactor * Math.max(0, this.t - POCKET.holdGrace) * this.diff.pocketPressure : 1;
      e.progress += dt * progressRate(n, hold);
      if (e.progress >= e.holdT) {
        if (mode === 'chip') {
          // The chip did its job (slowed the rusher); the back releases into his route.
          this.chipDone.add(b.id);
          b.blockCooldown = 5;
          this.emit('chip', b.id);
          continue;
        }
        if (rollFoul('holdingOffense', this.penaltyBias, this.penRng)) {
          // Beaten blocker grabs on instead of letting go.
          this.addFoul('holdingOffense', b.pos);
          e.progress = 0;
          e.holdT = Infinity;
          keep.push(e);
          continue;
        }
        this.shedFrom.set(d.id, { blocker: b.id, until: this.t + 1.2 });
        b.blockCooldown = 0.8;
        this.emit('shed', d.id);
        continue;
      }
      // Phase 3d: a double team (combo) grades better and drives the man further.
      const defStat = -(e.quality + comboBonus(n));
      const comboDrive = n >= 2 ? BLOCKING.double.drive : 1;
      keep.push(e);
      // Defender fights toward his goal slowly; blocker mirrors in front.
      const goalVel = desired.get(d.id) ?? v2();
      const chipSlow = mode === 'chip' ? BLOCKING.protection.chipSlow : 1;
      const push = clamp(0.35 + defStat * 0.31, 0.08, 1.2) * this.diff.passRush * chipSlow / n;
      let dv = scale(norm(goalVel), push * (rushing ? 1 + e.t * 0.25 : 0.8));
      if (!rushing) {
        // Drive block: push the defender out of the lane (run plan) or away from the carrier.
        const drive = this.blockRoles.get(b.id)?.drive;
        const away = this.play.run && this.laneX !== null && drive !== undefined && !this.pastLos(carrier)
          ? norm(v2(drive || Math.sign(d.pos.x - this.laneX) || 1, 0.5))
          : norm(sub(d.pos, carrier.pos));
        dv = add(dv, scale(away, clamp((e.quality + comboBonus(n)) * BLOCKING.run.drivePush + 0.3, 0, 0.9) * comboDrive));
      }
      desired.set(d.id, dv);
      const front = add(d.pos, scale(norm(sub(rushing ? qb.pos : carrier.pos, d.pos)), 0.85));
      desired.set(b.id, add(scale(sub(front, b.pos), 8), d.vel));
    }
    this.engagements = keep;
  }

  private integrate(dt: number, desired: Map<number, Vec2>) {
    for (const a of this.actors) {
      if (a.down) {
        a.vel = v2();
        continue;
      }
      const boost = a.id === this.controlledId && this.sprint.sprinting ? Math.max(1, sprintSpeed(this.sprint, a.slot === 'QB')) : 1;
      const want = clampLen(desired.get(a.id) ?? v2(), a.maxSpeed * boost);
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

  /** Players without the ball stop at the sideline instead of drifting out (momentum, pushes). */
  private keepInBounds() {
    const xMax = FIELD.halfWidth - ROUTE_BOUNDS.holdInside;
    const c = this.carrier;
    for (const a of this.actors) {
      if (a === c || a.down || Math.abs(a.pos.x) <= xMax) continue;
      const side = Math.sign(a.pos.x);
      a.pos = { x: side * xMax, y: a.pos.y };
      if (Math.sign(a.vel.x) === side) a.vel = { x: 0, y: a.vel.y };
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
    if (b.state === 'loose' && this.loose) return this.updateLoose(dt);
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
          this.runRecognizedAt = Math.min(this.runRecognizedAt, this.t);
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
          if (this.rng.chance(COVERAGE.undercutInt * this.diff.ballSkills)) {
            this.finishInterception(d);
          } else {
            this.emit('deflection', d.id);
            this.incomplete(b.pos, 'tipped');
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
      .map((a) => ({ ...toCand(a), inPhase: !!target && inPhase(target, a, COVERAGE.inPhaseDist), timing: this.userTiming(a, f) }));
    const out = resolveCatch({
      landing: f.landing, quality: f.quality, speed: f.speed, offense, defense,
      ballSkills: this.diff.ballSkills, inPhaseBreakup: COVERAGE.inPhaseBreakup, inPhaseInt: COVERAGE.inPhaseInt,
      catchFactor: f.screen?.catchFactor, intBonus: f.screen?.intBonus, intBase: COVERAGE.intBase, noReceiverInt: COVERAGE.noReceiverInt, rng: this.rng,
      green: f.green, pressure: f.pressure,
    });
    const b = this.ball;
    switch (out.kind) {
      case 'catch': {
        const r = this.actors[out.id];
        if (Math.abs(f.landing.x) > FIELD.halfWidth || f.landing.y > FIELD.length + FIELD.endzone) {
          this.incomplete(f.landing, 'outOfBounds');
          return;
        }
        b.state = 'held';
        b.holder = r.id;
        b.flight = null;
        r.pos = lerp(r.pos, f.landing, 0.5);
        this.runRecognizedAt = this.t;
        this.controlledId = r.id;
        this.caughtPass = true;
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
        this.incomplete(f.landing, out.kind === 'deflection' ? 'defended' : out.kind === 'drop' && out.contested ? 'contestedDrop' : 'drop');
        return;
      case 'incomplete':
        this.incomplete(f.landing, 'outOfReach');
    }
  }

  /** Timing bonus for the user defender's jump when the ball arrives near him (none for CPU defenders). */
  private userTiming(a: Actor, f: Flight) {
    if (a.id !== this.userDefId || dist(a.pos, f.landing) > 4) return undefined;
    const t = jumpTiming(Number.isFinite(a.jumpT) ? a.jumpT : null, this.t);
    const tgt = f.targetId !== null ? this.actors[f.targetId] : this.nearestEligible(f.landing);
    const margin = dist(tgt.pos, f.landing) - dist(a.pos, f.landing);
    const read = readGrade(margin);
    this.lastTiming = { ...t, read, margin };
    this.emit('timing', a.id);
    return combinedEffect(t.grade, read);
  }

  private incomplete(at: Vec2, reason: IncompleteReason['reason']) {
    const f = this.ball.flight;
    if (f && !f.lateral) {
      let defenderDist = Infinity;
      for (const d of this.actors) if (d.side === 'def' && !d.down) defenderDist = Math.min(defenderDist, dist(d.pos, f.landing));
      const tgt = f.targetId !== null ? this.actors[f.targetId] : null;
      this.incompleteReason = {
        reason, green: !!f.green, quality: f.quality, pressure: f.pressure ?? 0,
        miss: f.aim ? dist(f.aim, f.landing) : 0, targetDist: tgt ? dist(tgt.pos, f.landing) : null, defenderDist,
      };
      if (PlaySim.debug) console.debug('[incomplete]', this.incompleteReason);
    }
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
    this.startReturn('interception', d);
  }

  // ---------------------------------------------------------------- turnovers (Phase 3c)

  /** The defense has the ball: the play goes on as a return until a tackle, the sideline or the end zone. */
  private startReturn(kind: 'interception' | 'fumble', d: Actor) {
    // Placed on the field if needed (a pick or recovery right at the sideline / end line).
    d.pos = v2(clamp(d.pos.x, -FIELD.halfWidth + 0.6, FIELD.halfWidth - 0.6), clamp(d.pos.y, -FIELD.endzone + 0.6, FIELD.length + FIELD.endzone - 0.6));
    this.turnover = { kind, at: { ...d.pos }, t: this.t, by: d.id };
    this.runRecognizedAt = this.t;
    this.engagements = [];
    this.contact = null;
    for (const a of this.actors) a.tackleCooldown = 0;
    // The user's defense: the man with the ball is the user's now.
    if (this.userDefId >= 0) this.userDefId = d.id;
    this.syncHeldBall();
  }

  /** Fumble roll on a successful tackle (own RNG stream, so the football before it never changes). */
  private fumbles(c: Actor, d: Actor, kind: ContactKind, sack: boolean): boolean {
    const F = TURNOVERS.fumble;
    const p = F.base * (kind === 'shoulder' ? F.shoulder : 1) * (sack ? F.sack : 1) *
      (1 + F.strengthWeight * (d.player.ratings.strength - c.player.ratings.strength) / 100);
    // Phase 3d: a sprinting user carrier puts the ball on the ground more often (after the cap).
    const sprint = c.id === this.controlledId ? sprintFumbleFactor(this.sprint, this.t) : 1;
    return this.fumbleRng.chance(clamp(p, 0, F.max) * sprint);
  }

  private startFumble(c: Actor) {
    const b = this.ball;
    b.state = 'loose';
    b.holder = null;
    b.flight = null;
    const a = this.fumbleRng.range(0, Math.PI * 2);
    const sp = TURNOVERS.loose.popSpeed * this.fumbleRng.range(0.5, 1);
    b.looseVel = { x: Math.sin(a) * sp, y: Math.cos(a) * sp - 1.5, h: 2 };
    b.pos = { ...c.pos };
    c.down = true;
    this.loose = { t: this.t, by: c.id, at: { ...c.pos } };
    this.emit('fumble', c.id);
  }

  /** A live fumble: it rolls, everybody goes for it, the nearest man falls on it. */
  private updateLoose(dt: number) {
    const b = this.ball;
    const L = TURNOVERS.loose;
    const v = v2(b.looseVel.x, b.looseVel.y);
    const sp = len(v);
    const nv = sp > 0 ? scale(v, Math.max(0, sp - L.friction * dt) / sp) : v;
    b.looseVel = { x: nv.x, y: nv.y, h: b.looseVel.h - 10.7 * dt };
    b.h = Math.max(0.12, b.h + b.looseVel.h * dt);
    if (b.h <= 0.12) b.looseVel.h = Math.abs(b.looseVel.h) * 0.4;
    b.pos = add(b.pos, scale(nv, dt));
    const lost = this.actors[this.loose!.by];
    if (Math.abs(b.pos.x) > FIELD.halfWidth || b.pos.y < -FIELD.endzone || b.pos.y > FIELD.length + FIELD.endzone) {
      // Out of bounds: the offense keeps it (never ahead of the fumble); out of its own end zone it is a safety,
      // out of the other end zone a touchback for the defense.
      this.loose = null;
      if (b.pos.y >= FIELD.length) {
        const r = this.makeResult('interception', v2(b.pos.x, FIELD.length), null);
        r.fumble = true;
        r.description = describe(r, null);
        this.result = r;
        return;
      }
      const spot = v2(b.pos.x, Math.min(b.pos.y, lost.pos.y));
      this.emit('outOfBounds', lost.id);
      this.result = this.makeResult(spot.y <= 0 ? 'safety' : 'outOfBounds', spot, lost);
      return;
    }
    let best: Actor | null = null;
    for (const a of this.actors) {
      if (a.down || dist(a.pos, b.pos) > L.recoverRadius) continue;
      if (!best || dist(a.pos, b.pos) < dist(best.pos, b.pos)) best = a;
    }
    if (!best && this.t - this.loose!.t > L.maxLoose) {
      best = this.actors.filter((a) => !a.down).reduce((m, a) => (dist(a.pos, b.pos) < dist(m.pos, b.pos) ? a : m));
    } else if (best && !this.fumbleRng.chance(L.recoverChance)) return;
    if (!best) return;
    this.loose = null;
    b.state = 'held';
    b.holder = best.id;
    this.emit('recovery', best.id);
    if (best.side === 'def') this.startReturn('fumble', best);
    else {
      this.runRecognizedAt = this.t;
      this.controlledId = best.id;
      this.syncHeldBall();
    }
  }

  /** Where everybody goes during a live fumble (both sides): the ball. */
  private looseGoal(a: Actor): Vec2 {
    return this.seek(a, this.ball.pos, 1);
  }

  /** CPU returner: for the offense's goal line (y = 0), bending away from the nearest pursuer ahead. */
  private returnRun(c: Actor): Vec2 {
    const R = TURNOVERS.return;
    let dir = v2(0, -1);
    let worst: Actor | null = null;
    for (const o of this.actors) {
      if (o.side !== 'off' || o.down) continue;
      const rel = sub(o.pos, c.pos);
      if (rel.y > 1 || len(rel) > R.lookAhead) continue;
      if (!worst || dist(o.pos, c.pos) < dist(worst.pos, c.pos)) worst = o;
    }
    if (worst) dir = norm(add(dir, scale(v2(norm(sub(c.pos, worst.pos)).x, 0), R.avoid * 2)));
    if (Math.abs(c.pos.x) > FIELD.halfWidth - 3) dir = norm(add(dir, v2(-Math.sign(c.pos.x) * 0.6, 0)));
    return scale(dir, c.maxSpeed);
  }

  /** Return team without the ball: get in front of the nearest pursuer (the contact slows him). */
  private escort(d: Actor, c: Actor): Vec2 {
    let target: Actor | null = null;
    for (const o of this.actors) {
      if (o.side !== 'off' || o.down) continue;
      if (!target || dist(o.pos, c.pos) < dist(target.pos, c.pos)) target = o;
    }
    if (!target) return this.seek(d, add(c.pos, v2(0, -4)), 1);
    return this.seek(d, lerp(target.pos, c.pos, 0.3), 1);
  }

  /** Offense chasing the returner: pursuit angle, slowed while a return blocker is on him. */
  private chase(a: Actor, c: Actor): Vec2 {
    const v = this.seek(a, this.pursuit(a, c), 1);
    return this.blockedOnReturn(a) ? scale(v, TURNOVERS.return.blockedSpeed) : v;
  }

  private blockedOnReturn(a: Actor): boolean {
    return this.actors.some((o) => o.side === 'def' && !o.down && o.id !== this.ball.holder && dist(o.pos, a.pos) < TURNOVERS.return.blockRange);
  }

  /** Return over: tackle, sideline or end zone. Outcome 'interception' = the defense's ball at the spot. */
  private finishReturn(how: 'tackle' | 'outOfBounds' | 'touchdown', c: Actor) {
    this.emit(how, c.id);
    const at = how === 'touchdown' ? v2(c.pos.x, 0) : c.pos;
    this.result = this.makeResult('interception', at, c);
  }

  // ---------------------------------------------------------------- whistle

  private checkTackles() {
    const c = this.carrier;
    if (!c || this.contact || (c.side === 'def' && !this.turnover)) return;
    // Phase 3c: on a return the offense tackles, with the same tackle model.
    const tacklers = c.side === 'off' ? 'def' : 'off';
    for (const d of this.actors) {
      if (d.side !== tacklers || d.down || d.tackleCooldown > 0) continue;
      // The user defender's JUMP doubles as a diving tackle: longer range, a little more stopping power.
      const diving = tacklers === 'def' && d.id === this.userDefId && this.t - d.jumpT < DEF_CONTROL.jump.duration;
      if (dist(d.pos, c.pos) > (diving ? DEF_CONTROL.tackle.diveRange : TACKLE.range)) continue;
      const engaged = !!this.isEngaged(d);
      if (engaged && dist(d.pos, c.pos) > TACKLE.engagedRange) continue;
      let factor = (tacklers === 'def' ? this.diff.tackling : 1) * (diving ? DEF_CONTROL.tackle.diveFactor : 1);
      // Phase 3c audible edge: a blitzer still rushing the QB only gets an arm on the runner going past.
      if (this.audibleEdge && this.blitzers.has(d.id) && this.t < this.runRecognizedAt + d.reaction + AUDIBLES.edge.blitzRunRead) factor *= AUDIBLES.edge.blitzTackle;
      if (c.side === 'off' && c.slot === 'QB' && !this.pastLos(c)) factor *= TACKLE.pocketSackFactor; // sacks: QB is a sitting duck
      else if (c.side === 'off' && c.slot === 'QB') factor *= SCRAMBLE.tackleBonus; // a scrambling QB is no running back
      // Phase 3d: a runner going sideways behind the line (toss, stretch) can't lower his shoulder.
      else if (c.side === 'off' && c.pos.y < this.los && len(c.vel) > 1 && Math.abs(c.vel.x) >= RUN_GAME.backfield.minLateral * len(c.vel)) factor *= RUN_GAME.backfield.lateralTackle;
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
        const sack = c.side === 'off' && c.slot === 'QB' && c.pos.y < this.los && !this.passThrown && !this.handedOff;
        if (c.side === 'off' && this.fumbles(c, d, out.kind, sack)) {
          // Phase 3c: the ball comes out on the hit.
          this.startFumble(c);
          return;
        }
        this.contact = { carrier: c.id, tackler: d.id, whistleAt: this.t + out.contactTime, sack };
        if (sack) {
          const bz = this.blitzers.get(d.id);
          if (bz) bz.facts.sacked = true;
          const sr = this.surprise.get(d.id);
          if (sr) sr.facts.sacked = true;
        }
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
    if (c.side === 'def') this.finishReturn('tackle', c);
    else if (c.pos.y <= 0) this.finish('safety', c);
    else this.finish(k.sack ? 'sack' : 'tackle', c);
  }

  /** A tackle is in progress (contact animation before the whistle). */
  get inContact(): boolean {
    return this.contact !== null;
  }


  private checkBoundaries() {
    const c = this.carrier;
    if (c && c.side === 'def' && this.turnover) {
      if (c.pos.y <= 0) this.finishReturn('touchdown', c);
      else if (Math.abs(c.pos.x) > FIELD.halfWidth) this.finishReturn('outOfBounds', c);
      else if (this.t - this.turnover.t > TURNOVERS.return.maxReturnTime) this.finishReturn('tackle', c);
      return;
    }
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
    if (outcome === 'interception' && this.turnover) {
      res.fumble = this.turnover.kind === 'fumble';
      res.returnYards = Math.round(this.turnover.at.y - endY);
      // A catch that was then fumbled away is still a completion.
      res.completion = this.passThrown && this.turnover.kind === 'fumble' && this.caughtPass;
    }
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
      if (d.side !== 'def' || d.down || !this.pressuring(d)) continue;
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
    case 'interception': {
      // Phase 3c: returns.
      const ret = r.returnYards === undefined ? '' : r.endY <= 0 ? ', returned for a touchdown!' : r.returnYards > 0 ? `, returned ${yds(r.returnYards)}` : '';
      if (r.fumble) return who ? `Fumble! Recovered by ${who}${ret}` : 'Fumble through the end zone: touchback';
      return `Intercepted by ${who}${ret || '!'}`;
    }
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
