/**
 * App: top-level state machine. Owns the GameState and the current PlaySim
 * or ReturnSim, routes InputFrames into them, and drives SceneView + UI. All
 * football logic lives in game/ and play/; this file is glue.
 *
 * Phases: title → intro → (kickoff) → playcall → presnap → live → postplay
 * → ... Special teams add kick (user meter), kickFlight (field goal in the
 * air) and return / returnPost (kick returns).
 */
import { Rng } from './core/rng';
import { DIFFICULTY, getTeam } from './data';
import type { EligibleSlot, PlayData, TeamData } from './data/types';
import { ELIGIBLE } from './data/types';
import { InputManager, type InputFrame } from './input/input';
import { SceneView } from './render/view';
import { SLOT_COLORS } from './render/fieldMesh';
import { Cutscene } from './render/cutscene';
import { PlaySim, SIM_DT, type PlayEvent, type SimInput } from './play/sim';
import { ReturnSim } from './play/returnSim';
import { chooseDefense, recordTendency } from './play/defenseCalls';
import { PENALTIES, calloutText, type Foul } from './play/penalties';
import { ST, cpuRelease, judgeFieldGoal, kickFlight, kickZone, meterAngle, meterPower, releaseKick, type KickFlight, type KickKind } from './play/kicking';
import { callTimeoutClock, snapClock, tickClock } from './game/clock';
import { afterPlay, checkQuarter, type Break } from './game/flow';
import { attemptFieldGoal, delayOfGame, fieldGoalDistance, punt, type RulesResult } from './game/rules';
import { enforcePenalties } from './game/penalties';
import { applyFieldGoal, applyReturn, kickoffOutOfBounds } from './game/specialTeams';
import { crowdEdge, crowdIntensity, updateCrowd } from './game/crowd';
import { newGame, other, type GameState, type TeamSide } from './game/state';
import { simulateCpuDrive } from './game/cpuDrive';
import { loadSettings, saveSettings, type Settings } from './game/settings';
import { Hud, type EdgeMarker } from './ui/hud';
import { TouchControls } from './ui/touch';
import { PlaycallScreen } from './ui/playcall';
import { IntroOverlay } from './ui/intro';
import { Modal, boxScore, button, driveSummary, helpContent, scoreLine, settingsPanel, titleScreen } from './ui/menus';
import { h } from './ui/dom';
import { CrowdAudio } from './audio/crowdAudio';

type Phase = 'title' | 'intro' | 'playcall' | 'presnap' | 'live' | 'postplay' | 'kick' | 'kickFlight' | 'return' | 'returnPost' | 'break' | 'gameover';

/** Seconds the result stays up after the whistle (tap NEXT to skip). */
const POSTPLAY_TIME = 1.7;
const LABELS: Record<EligibleSlot, string> = { WR1: '1', WR2: '2', WR3: '3', RB: 'RB', TE: 'TE' };
const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;

interface KickState {
  kind: KickKind;
  /** Kicking side. */
  side: TeamSide;
  /** Kick spot in the kicking team's frame. */
  spot: { x: number; y: number };
  held: number;
  holding: boolean;
  flight: KickFlight | null;
  t: number;
  fgDistance: number;
  done: boolean;
}

export class App {
  private settings: Settings = loadSettings();
  private input = new InputManager();
  private view: SceneView;
  private hud = new Hud();
  private touch: TouchControls;
  private playcall: PlaycallScreen;
  private modal = new Modal();
  private intro = new IntroOverlay();
  private audio = new CrowdAudio();
  private game: GameState | null = null;
  private rng = new Rng(1);
  private sim: PlaySim | null = null;
  private ret: ReturnSim | null = null;
  private retInfo: { kind: 'kickoff' | 'punt'; kicking: TeamSide } | null = null;
  private kick: KickState | null = null;
  private cutscene: Cutscene | null = null;
  private play: PlayData | null = null;
  private phase: Phase = 'title';
  private paused = false;
  private gazeYaw = 0;
  private gazePitch = -0.06;
  private target: EligibleSlot | null = null;
  private acc = 0;
  private postTimer = 0;
  private bannerTimer = 0;
  private lastTime = 0;
  private playsRun = 0;
  private callouts: { at: number; foul: Foul }[] = [];

  constructor(canvas: HTMLCanvasElement, ui: HTMLElement) {
    this.view = new SceneView(canvas);
    this.touch = new TouchControls(this.input);
    this.playcall = new PlaycallScreen({
      onPlay: (p) => this.callPlay(p),
      onPunt: () => this.userKickFromPlaycall('punt'),
      onFieldGoal: () => this.userKickFromPlaycall('fieldGoal'),
      onTimeout: () => this.timeout(),
    });
    ui.append(this.touch.root, this.hud.root, this.playcall.root, this.intro.root, this.modal.root,
      h('div', { id: 'rotate' }, 'Rotate your iPad to landscape for the best experience.'));
    this.hud.pauseBtn.addEventListener('pointerup', () => this.input.pressPause());
    this.hud.timeoutBtn.addEventListener('pointerup', () => this.input.pressTimeout());
    window.addEventListener('resize', () => this.view.resize());
    this.applySettings();
    this.showTitle();
  }

  start() {
    const loop = (t: number) => {
      const dt = Math.min(0.1, this.lastTime ? (t - this.lastTime) / 1000 : 0);
      this.lastTime = t;
      this.frame(dt);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  // ------------------------------------------------------------ settings & screens

  private applySettings() {
    this.view.setPixelScale(this.settings.retroPixels ? 0.4 : 1);
    this.view.setShadows(this.settings.shadows);
    this.input.lookSensitivity = this.settings.lookSensitivity;
    this.audio.setEnabled(this.settings.sound);
    if (this.game) this.game = { ...this.game, difficulty: this.settings.difficulty };
    if (this.sim && this.phase === 'presnap') this.view.showRoutes(this.settings.showRoutes ? this.sim : null);
  }

  private updateSettings = (s: Settings) => {
    this.settings = s;
    saveSettings(s);
    this.applySettings();
  };

  private setPhase(p: Phase) {
    this.phase = p;
    const onField = p === 'presnap' || p === 'live' || p === 'postplay' || p === 'kick' || p === 'kickFlight' || p === 'return' || p === 'returnPost';
    this.touch.setVisible(onField);
    this.hud.root.classList.toggle('hidden', p === 'title' || p === 'intro');
    this.intro.show(p === 'intro');
    if (p !== 'kick') this.hud.setKickMeter(null);
  }

  private showTitle() {
    this.setPhase('title');
    this.sim = null;
    this.ret = null;
    this.kick = null;
    this.playcall.hide();
    this.modal.show(titleScreen(this.settings, this.updateSettings, () => this.startGame(), () => this.showHelp(() => this.showTitle())));
  }

  private showHelp(back: () => void) {
    this.modal.show(helpContent(), h('div', { class: 'row' }, button('BACK', back, 'primary')));
  }

  private startGame() {
    this.modal.hide();
    this.audio.unlock();
    const seed = (Date.now() & 0x7fffffff) >>> 0;
    this.rng = new Rng(seed);
    this.game = newGame({
      home: this.settings.userTeam, away: this.settings.cpuTeam, userSide: 'home',
      difficulty: this.settings.difficulty, quarterLength: this.settings.quarterMinutes * 60, seed,
    });
    this.view.setTeams(this.userTeam, this.cpuTeam);
    this.playsRun = 0;
    if (this.settings.intro) {
      // Cutscenes are pure presentation: the game is already set up, any tap goes straight to it.
      const g = this.game;
      this.cutscene = new Cutscene(this.view, getTeam(g.teams.home), getTeam(g.teams.away), g.pendingKickoff !== 'home');
      this.setPhase('intro');
      return;
    }
    this.nextSnap();
  }

  private endIntro() {
    this.cutscene?.dispose();
    this.cutscene = null;
    this.nextSnap();
  }

  private get userTeam(): TeamData {
    return getTeam(this.game!.teams[this.game!.userSide]);
  }

  private get cpuTeam(): TeamData {
    return getTeam(this.game!.teams[other(this.game!.userSide)]);
  }

  private teamOf(side: TeamSide): TeamData {
    return getTeam(this.game!.teams[side]);
  }

  private togglePause() {
    if (this.paused) {
      this.paused = false;
      this.modal.hide();
      this.setPhase(this.phase);
      return;
    }
    if (this.phase === 'title' || this.phase === 'break' || this.phase === 'gameover' || this.phase === 'intro') return;
    this.paused = true;
    this.touch.setVisible(false);
    const resume = () => {
      this.paused = false;
      this.modal.hide();
      this.setPhase(this.phase);
    };
    const showMenu = () =>
      this.modal.show(
        h('h2', {}, 'PAUSED'),
        h('p', {}, scoreLine(this.game!)),
        h('div', { class: 'row' },
          button('RESUME', resume, 'primary'),
          button('SETTINGS', () => this.modal.show(h('h2', {}, 'SETTINGS'), settingsPanel(this.settings, this.updateSettings, true),
            h('div', { class: 'row', style: { marginTop: '12px' } }, button('BACK', showMenu, 'primary')))),
          button('HOW TO PLAY', () => this.showHelp(showMenu)),
          button('QUIT GAME', () => {
            this.paused = false;
            this.showTitle();
          })),
      );
    showMenu();
  }

  // ------------------------------------------------------------ flow

  /** What happens before the next snap: game over, a kickoff, a CPU drive or the user's play call. */
  private nextSnap() {
    const g = this.game!;
    if (g.over) return this.showGameOver();
    if (g.pendingKickoff) {
      if (this.settings.quickSim) {
        // Phase 1 behavior: no kickoff, the receiving team starts at its 25 (already set by the rules).
        this.game = { ...g, pendingKickoff: null };
      } else {
        return this.startKickoff(g.pendingKickoff);
      }
    }
    if (this.game!.possession !== this.game!.userSide) return this.runCpuDrive();
    this.enterPlaycall();
  }

  private enterPlaycall() {
    const g = this.game!;
    this.kick = null;
    this.setPhase('playcall');
    this.hud.showBanner(null);
    this.hud.setPlayName(null);
    this.hud.setHint(null);
    this.view.showRoutes(null);
    this.view.field.setMarkers(g.ballY, g.ballY + g.toGo);
    this.view.field.showMarkers(true);
    this.playcall.show(g);
  }

  /** Penalty chance per side for a user offense play: crowd edge, or off. */
  private penaltyBias() {
    const g = this.game!;
    if (!this.settings.penalties) return { off: 0, def: 0 };
    const edge = crowdEdge(g.crowd, this.settings.crowdEffect);
    const offHome = g.possession === 'home';
    return { off: offHome ? edge.homePenalty : edge.awayPenalty, def: offHome ? edge.awayPenalty : edge.homePenalty };
  }

  private callPlay(play: PlayData) {
    const g = this.game!;
    this.play = play;
    this.playcall.hide();
    const diff = DIFFICULTY[g.difficulty];
    const defense = chooseDefense(
      { down: g.down, toGo: g.toGo, yardline: g.ballY, halfSecondsLeft: (g.clock.quarter % 2 === 1 ? g.clock.quarterLength : 0) + g.clock.remaining,
        scoreDiff: g.score[g.userSide] - g.score[other(g.userSide)] },
      g.tendencies, diff, this.rng,
    );
    this.sim = new PlaySim({
      play, defense, offenseTeam: this.userTeam, defenseTeam: this.cpuTeam,
      ballX: g.ballX, los: g.ballY, difficulty: diff, seed: this.rng.int(1, 2 ** 31 - 1), penaltyBias: this.penaltyBias(),
    });
    this.ret = null;
    this.callouts = [];
    this.view.bindPlay(this.sim, this.userTeam, this.cpuTeam);
    this.view.showRoutes(this.settings.showRoutes ? this.sim : null);
    this.view.field.setMarkers(g.ballY, g.ballY + g.toGo);
    this.view.field.showMarkers(true);
    this.gazeYaw = 0;
    this.gazePitch = -0.06;
    this.target = play.run ? null : (play.primary ?? null);
    this.hud.setPlayName(play.name);
    this.setPhase('presnap');
  }

  private snap() {
    const g = this.game!;
    this.game = { ...g, clock: snapClock(g.clock), tendencies: recordTendency(g.tendencies, this.play!.category) };
    this.view.showRoutes(null);
    this.acc = 0;
    this.playsRun++;
    this.setPhase('live');
  }

  private timeout() {
    const g = this.game!;
    if (!(this.phase === 'playcall' || this.phase === 'presnap') || g.timeouts[g.userSide] <= 0) return;
    this.game = { ...g, timeouts: { ...g.timeouts, [g.userSide]: g.timeouts[g.userSide] - 1 }, clock: callTimeoutClock(g.clock) };
    this.flash('TIMEOUT', `${this.game.timeouts[g.userSide]} left this half`);
    if (this.playcall.visible) this.playcall.update(this.game);
  }

  private flash(text: string, sub = '', secs = 1.6) {
    this.hud.showBanner(text, sub);
    this.bannerTimer = secs;
  }

  private finishPlay() {
    const g = this.game!;
    const res = this.sim!.result!;
    // Flags stayed on the field during the play; now the penalty is applied.
    const enf = enforcePenalties(g, res, res.fouls);
    const r = enf.result;
    const st = { ...r.state, stats: { ...r.state.stats } };
    const side = g.userSide;
    const s = { ...st.stats[side] };
    // A play wiped out by an accepted penalty doesn't count in the box score.
    if (!enf.enforced && !enf.offsetting) {
      if (res.passAttempt) {
        s.passAtt++;
        if (res.completion) {
          s.passComp++;
          s.passYds += res.yards;
        }
      } else if (res.outcome === 'sack') {
        s.sacks++;
      } else if (res.rush) {
        s.rushAtt++;
        s.rushYds += res.yards;
      }
      if (res.turnover) s.turnovers++;
    }
    st.stats[side] = s;
    st.crowd = updateCrowd(g.crowd, {
      homeOffense: g.possession === 'home', yards: enf.enforced ? 0 : res.yards, firstDown: r.headline === 'FIRST DOWN',
      score: r.scored ? { home: r.scored.side === 'home', points: r.scored.points } : null,
      turnover: res.turnover && !enf.enforced, sack: res.outcome === 'sack',
      penaltyOnHome: enf.enforced ? (enf.enforced.side === 'off') === (g.possession === 'home') : null,
      failedFourthDown: r.headline === 'TURNOVER ON DOWNS',
    });
    const ap = afterPlay(st, r.stop);
    this.game = ap.state;
    this.handleBreak(ap.brk);
  }

  private handleBreak(brk: Break) {
    if (brk === 'gameover') return this.showGameOver();
    if (brk === 'none') return this.nextSnap();
    this.setPhase('break');
    this.playcall.hide();
    const g = this.game!;
    const title = brk === 'halftime' ? 'HALFTIME' : `END OF Q${g.clock.quarter - 1}`;
    this.modal.show(h('h2', {}, title), h('p', {}, scoreLine(g)), brk === 'halftime' ? boxScore(g) : '',
      h('div', { class: 'row' }, button('CONTINUE', () => {
        this.modal.hide();
        this.nextSnap();
      }, 'primary')));
  }

  private runCpuDrive() {
    const g = this.game!;
    const cpuSide = g.possession;
    const sum = simulateCpuDrive(g, DIFFICULTY[g.difficulty], this.rng, {
      interactivePunts: !this.settings.quickSim, crowdEffect: this.settings.crowdEffect, penalties: this.settings.penalties ? 1 : 0,
    });
    this.game = sum.state;
    this.setPhase('break');
    this.playcall.hide();
    this.view.field.showMarkers(false);
    this.modal.show(driveSummary(g, cpuSide, sum.entries, sum.headline), h('p', {}, scoreLine(this.game)),
      h('div', { class: 'row' }, button(sum.pendingPunt ? 'RETURN THE PUNT' : 'CONTINUE', () => {
        this.modal.hide();
        if (sum.brk === 'gameover' || this.game!.over) return this.showGameOver();
        if (sum.brk === 'halftime') return this.handleBreak('halftime');
        if (sum.pendingPunt) return this.startCpuKick('punt');
        this.nextSnap();
      }, 'primary')));
  }

  /** Phase 1 instant punts and field goals (Quick sim setting). */
  private quickKick(kind: 'punt' | 'fg') {
    const g = this.game!;
    this.playcall.hide();
    let live: GameState = { ...g, clock: tickClock(snapClock(g.clock), 6).clock };
    const r: RulesResult = kind === 'punt' ? punt(live, this.rng) : attemptFieldGoal(live, this.rng);
    live = { ...r.state, pendingKickoff: null };
    const ap = afterPlay(live, r.stop);
    this.game = ap.state;
    this.setPhase('break');
    this.modal.show(h('h2', {}, r.headline), h('p', {}, scoreLine(this.game)),
      h('div', { class: 'row' }, button('CONTINUE', () => {
        this.modal.hide();
        this.handleBreak(ap.brk);
      }, 'primary')));
  }

  private showGameOver() {
    const g = this.game!;
    this.setPhase('gameover');
    this.playcall.hide();
    const u = g.score[g.userSide];
    const c = g.score[other(g.userSide)];
    const verdict = u > c ? 'YOU WIN!' : u < c ? 'YOU LOSE' : 'TIE GAME';
    this.modal.show(h('h1', {}, 'FINAL'), h('h2', {}, verdict), h('p', {}, scoreLine(g)), boxScore(g),
      h('div', { class: 'row' }, button('NEW GAME', () => this.showTitle(), 'primary')));
  }

  // ------------------------------------------------------------ special teams

  private userKickFromPlaycall(kind: 'punt' | 'fieldGoal') {
    if (this.phase !== 'playcall') return;
    if (this.settings.quickSim) return this.quickKick(kind === 'punt' ? 'punt' : 'fg');
    this.playcall.hide();
    const g = this.game!;
    this.game = { ...g, clock: snapClock(g.clock) };
    const spot = kind === 'punt'
      ? { x: g.ballX, y: g.ballY - ST.rules.puntSnapBack }
      : { x: g.ballX * 0.5, y: g.ballY - ST.rules.fieldGoalSnapBack };
    this.startUserKick(kind, g.userSide, spot, fieldGoalDistance(g.ballY));
  }

  private startKickoff(kicking: TeamSide) {
    const g = this.game!;
    this.game = { ...g, pendingKickoff: null };
    if (kicking === g.userSide) this.startUserKick('kickoff', kicking, { x: 0, y: ST.rules.kickoffSpot }, 0);
    else this.startCpuKick('kickoff');
  }

  private startUserKick(kind: KickKind, side: TeamSide, spot: { x: number; y: number }, fgDistance: number) {
    this.kick = { kind, side, spot, held: 0, holding: false, flight: null, t: 0, fgDistance, done: false };
    this.sim = null;
    this.ret = null;
    this.view.resetCamera();
    this.view.field.showMarkers(false);
    this.hud.setPlayName(kind === 'kickoff' ? 'KICKOFF' : kind === 'punt' ? 'PUNT' : `FIELD GOAL · ${fgDistance} YDS`);
    this.setPhase('kick');
  }

  /** The CPU kicks (kickoff or punt) and the user returns it. */
  private startCpuKick(kind: 'kickoff' | 'punt') {
    const g = this.game!;
    const cpuSide = other(g.userSide);
    const diff = DIFFICULTY[g.difficulty];
    const rel = cpuRelease(kind, diff.kickWindow, ST.cpu.timingSigma[g.difficulty], this.rng);
    // Kicking frame = the CPU's frame (ballY is in the frame of the team in possession).
    const spot = kind === 'kickoff' ? { x: 0, y: ST.rules.kickoffSpot } : { x: g.ballX, y: g.ballY - ST.rules.puntSnapBack };
    if (kind === 'punt') this.game = { ...g, clock: snapClock(g.clock) };
    const flight = kickFlight(rel, spot, 0, this.rng);
    this.audio.thump();
    this.startReturn(kind, cpuSide, flight, true);
  }

  private startReturn(kind: 'kickoff' | 'punt', kicking: TeamSide, flight: KickFlight, userReturns: boolean) {
    const g = this.game!;
    const diff = DIFFICULTY[g.difficulty];
    this.ret = new ReturnSim({
      kind, flight, kickingTeam: this.teamOf(kicking), receivingTeam: this.teamOf(other(kicking)), userReturns,
      // The CPU's tackling scales with difficulty when the user returns; the user's cover team is neutral.
      tackling: userReturns ? diff.tackling : 1, seed: this.rng.int(1, 2 ** 31 - 1),
    });
    this.retInfo = { kind, kicking };
    this.kick = null;
    this.sim = null;
    this.acc = 0;
    this.view.bindPlay(this.ret, this.teamOf(other(kicking)), this.teamOf(kicking));
    this.view.field.showMarkers(false);
    this.hud.setPlayName(kind === 'kickoff' ? 'KICKOFF RETURN' : 'PUNT RETURN');
    this.setPhase('return');
  }

  private updateKick(f: InputFrame, dt: number) {
    const k = this.kick!;
    const diff = DIFFICULTY[this.game!.difficulty];
    if (this.phase === 'kick') {
      if (f.primaryHeld && !k.done) {
        k.holding = true;
        k.held += dt;
      } else if (k.holding && !f.primaryHeld) {
        // Release: lock power (and the punt angle), kick it.
        k.done = true;
        const rel = releaseKick(k.kind, k.held, diff.kickWindow, k.fgDistance);
        k.flight = kickFlight(rel, k.spot, k.kind === 'fieldGoal' ? 0 : k.spot.x * 0.3, this.rng);
        this.audio.thump();
        if (k.kind === 'fieldGoal') {
          k.t = 0;
          this.setPhase('kickFlight');
        } else {
          this.startReturn(k.kind as 'kickoff' | 'punt', k.side, k.flight, false);
        }
        return;
      }
      const zone = kickZone(k.kind, diff.kickWindow, k.fgDistance);
      const P = ST.meter.punt;
      this.hud.setKickMeter({
        title: k.kind === 'kickoff' ? 'KICKOFF' : k.kind === 'punt' ? 'PUNT' : `FIELD GOAL ${k.fgDistance} YDS`,
        power: meterPower(k.held),
        zone,
        angle: k.kind === 'punt' ? { value: meterAngle(k.held), min: P.angleMin, max: P.angleMax, ideal: P.idealAngle, halfWidth: P.angleHalfWidth * diff.kickWindow } : undefined,
        sub: k.kind === 'punt' ? 'Hold for power, release when the needle is in the green.' : 'Hold KICK, release in the green zone.',
      });
      this.touch.setPrimary(k.holding ? 'RELEASE' : 'KICK', 'kick');
      this.touch.setSlots(null, new Set(), false);
      this.touch.setSecondary(null);
      this.touch.setCharge(false, 0, null);
      this.hud.setHint(this.playsRun < 6 ? 'Hold KICK to fill the meter, release in the green zone.' : null);
      return;
    }
    // Field goal in the air.
    k.t += dt;
    this.touch.setPrimary('', 'none');
    const fl = k.flight!;
    const posts = (110 - fl.from.y) / Math.max(0.1, fl.vel.y);
    if (k.t > Math.min(fl.hang, posts) + 0.6) {
      const judged = judgeFieldGoal(fl);
      const g = this.game!;
      const r = applyFieldGoal({ ...g, clock: tickClock(g.clock, 5).clock }, judged.good, k.fgDistance);
      const crowd = updateCrowd(g.crowd, {
        homeOffense: g.possession === 'home', yards: 0, firstDown: false,
        score: r.scored ? { home: r.scored.side === 'home', points: 3 } : null, turnover: false, sack: false, penaltyOnHome: null,
        failedFourthDown: false,
      });
      if (judged.good) this.audio.roar(0.7);
      const ap = afterPlay({ ...r.state, crowd }, r.stop);
      this.game = ap.state;
      this.setPhase('break');
      this.modal.show(h('h2', {}, judged.good ? "IT'S GOOD!" : judged.reason === 'wide' ? 'NO GOOD: WIDE' : 'NO GOOD: SHORT'),
        h('p', {}, r.headline), h('p', {}, scoreLine(this.game)),
        h('div', { class: 'row' }, button('CONTINUE', () => {
          this.modal.hide();
          this.kick = null;
          this.handleBreak(ap.brk);
        }, 'primary')));
    }
  }

  private updateReturn(f: InputFrame, dt: number) {
    const rs = this.ret!;
    if (this.phase === 'return') {
      this.acc += dt;
      let first = true;
      while (this.acc >= SIM_DT) {
        rs.step({ move: rs.userReturns ? f.move : { x: 0, y: 0 }, dash: first && rs.userReturns && (f.secondaryPressed || f.primaryPressed) });
        first = false;
        this.acc -= SIM_DT;
        const t = tickClock(this.game!.clock, SIM_DT);
        this.game = { ...this.game!, clock: t.clock };
        this.onEvents(rs.drainEvents());
        if (rs.result) break;
      }
      const carrying = rs.userReturns && rs.carrier === rs.returner;
      this.touch.setPrimary(carrying ? 'DASH' : '', carrying ? 'juke' : 'none');
      this.touch.setSecondary(null);
      this.touch.setSlots(null, new Set(), false);
      this.touch.setCharge(false, 0, null);
      this.hud.setHint(rs.userReturns && this.playsRun < 8 ? (carrying ? 'Steer with your left thumb · DASH for a burst' : 'Get under the ball...') : null);
      if (rs.result) {
        this.audio.whistle();
        this.postTimer = 0;
        this.setPhase('returnPost');
        const res = rs.result;
        const head = res.outcome === 'touchdown' ? 'TOUCHDOWN!' : res.outcome === 'touchback' ? 'TOUCHBACK' : res.outcome === 'downed' ? 'DOWNED' : res.outcome === 'outOfBoundsKick' ? 'OUT OF BOUNDS' : 'RETURN';
        if (res.outcome === 'touchdown') this.audio.roar(1);
        this.flash(head, res.description, POSTPLAY_TIME + 1);
      }
      return;
    }
    // After the whistle.
    this.acc += dt;
    while (this.acc >= SIM_DT) {
      rs.step({ move: { x: 0, y: 0 }, dash: false });
      this.acc -= SIM_DT;
    }
    this.postTimer += dt;
    this.touch.setPrimary('NEXT', 'snap');
    this.hud.setHint(null);
    if (this.postTimer > POSTPLAY_TIME || (f.primaryPressed && this.postTimer > 0.3)) {
      this.hud.showBanner(null);
      this.finishReturn();
    }
  }

  private finishReturn() {
    const rs = this.ret!;
    const info = this.retInfo!;
    const res = rs.result!;
    const g = this.game!;
    let r: RulesResult;
    if (res.outcome === 'outOfBoundsKick') {
      r = info.kind === 'kickoff' ? kickoffOutOfBounds(g, info.kicking) : applyReturn(g, info.kicking, 'punt', 'tackle', Math.max(1, res.endY));
    } else {
      r = applyReturn(g, info.kicking, info.kind, res.outcome, res.endY);
    }
    const recvHome = other(info.kicking) === 'home';
    const crowd = updateCrowd(g.crowd, {
      homeOffense: recvHome, yards: res.yards, firstDown: false,
      score: r.scored ? { home: r.scored.side === 'home', points: r.scored.points } : null,
      turnover: false, sack: false, penaltyOnHome: null, failedFourthDown: false,
      defensiveStop: info.kind === 'punt' && recvHome,
    });
    const ap = afterPlay({ ...r.state, crowd }, r.stop);
    this.game = ap.state;
    this.ret = null;
    this.retInfo = null;
    this.handleBreak(ap.brk);
  }

  // ------------------------------------------------------------ per-frame

  private frame(dt: number) {
    const f = this.input.poll(dt);
    if (f.anyPressed) this.audio.unlock();
    if (f.pausePressed) this.togglePause();
    this.hud.tick(dt);
    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0) {
        this.bannerTimer = 0;
        if (this.phase !== 'postplay' && this.phase !== 'returnPost') this.hud.showBanner(null);
      }
    }

    if (this.phase === 'intro' && this.cutscene) {
      const c = this.cutscene.caption();
      this.intro.setCaption(c.title, c.sub);
      if (f.anyPressed || !this.cutscene.update(dt)) this.endIntro();
    } else if (!this.paused && this.game) {
      if (f.timeoutPressed) this.timeout();
      switch (this.phase) {
        case 'playcall':
        case 'presnap':
          this.tickBetweenPlays(dt);
          if (this.phase === 'presnap') this.presnap(f, dt);
          break;
        case 'live':
          this.live(f, dt);
          break;
        case 'postplay':
          this.postplay(f, dt);
          break;
        case 'kick':
        case 'kickFlight':
          this.updateKick(f, dt);
          break;
        case 'return':
        case 'returnPost':
          this.updateReturn(f, dt);
          break;
      }
    }

    this.render(dt);
  }

  private tickBetweenPlays(dt: number) {
    const g = this.game!;
    const t = tickClock(g.clock, dt);
    this.game = { ...g, clock: t.clock };
    if (t.quarterExpired) {
      const q = checkQuarter(this.game);
      this.game = q.state;
      if (q.brk !== 'none') return this.handleBreak(q.brk);
    }
    if (t.playClockExpired) {
      const r = delayOfGame(this.game);
      const ap = afterPlay(r.state, r.stop);
      this.game = ap.state;
      this.flash('DELAY OF GAME', '5-yard penalty, replay the down', 2);
      if (this.phase === 'presnap' && this.play) this.callPlay(this.play);
      else this.view.field.setMarkers(this.game.ballY, this.game.ballY + this.game.toGo);
    }
    if (this.playcall.visible) this.playcall.update(this.game);
  }

  private updateGaze(f: InputFrame, dt: number) {
    const sim = this.sim!;
    if (f.lookYaw || f.lookPitch) {
      this.gazeYaw += f.lookYaw;
      this.gazePitch += f.lookPitch;
    }
    // Scrambling: the head follows the running path, not the last receiver.
    const qb = sim.get('QB');
    if (sim.scrambling && sim.carrier === qb && Math.hypot(qb.vel.x, qb.vel.y) > 1.5) {
      const want = Math.atan2(qb.vel.x, qb.vel.y);
      let d = want - this.gazeYaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.gazeYaw += Math.sign(d) * Math.min(Math.abs(d), 6 * dt);
      this.gazePitch += (-0.1 - this.gazePitch) * Math.min(1, dt * 4);
    }
    this.gazeYaw = Math.max(-2.6, Math.min(2.6, this.gazeYaw));
    this.gazePitch = Math.max(-0.6, Math.min(0.45, this.gazePitch));
  }

  private presnap(f: InputFrame, dt: number) {
    this.updateGaze(f, dt);
    // Picking a receiver pre-snap only marks him; the QB does not turn his head.
    if (f.slotPressed) this.target = f.slotPressed;
    this.touch.setPrimary('SNAP', 'snap');
    this.touch.setSecondary(null);
    this.touch.setSlots(this.target, this.blockingSlots(), true);
    this.touch.setCharge(false, 0, null);
    this.hud.setHint(this.playsRun < 3 ? 'All receivers are marked. Tap SNAP, then HOLD a receiver button to charge and RELEASE to throw.' : null);
    this.updateEdgeMarkers(true);
    if (f.primaryPressed) this.snap();
  }

  private blockingSlots(): Set<EligibleSlot> {
    const blocking = new Set<EligibleSlot>();
    for (const s of ELIGIBLE) if (this.sim!.get(s).route?.blocks) blocking.add(s);
    return blocking;
  }

  private simInput(f: InputFrame): SimInput {
    const sim = this.sim!;
    const qb = sim.get('QB');
    let throwHeld = false;
    let handoff = false;
    if (sim.canThrow()) {
      if (f.slotPressed === 'RB' && sim.canHandoff()) {
        handoff = true;
      } else if (f.slotHeld && !(f.slotHeld === 'RB' && sim.canHandoff())) {
        // Madden-style: holding a receiver button picks him and charges the throw.
        this.target = f.slotHeld;
        throwHeld = true;
      } else if (f.primaryHeld && sim.controlledId === qb.id) {
        throwHeld = true;
      }
    }
    return {
      move: f.move,
      gazeYaw: this.gazeYaw,
      throwHeld,
      target: this.target,
      handoff,
      juke: f.primaryPressed && !sim.canThrow(),
      slide: f.secondaryPressed,
    };
  }

  private live(f: InputFrame, dt: number) {
    const sim = this.sim!;
    this.updateGaze(f, dt);
    const inp = this.simInput(f);
    this.acc += dt;
    let first = true;
    while (this.acc >= SIM_DT) {
      sim.step(first ? inp : { ...inp, handoff: false, juke: false, slide: false });
      first = false;
      this.acc -= SIM_DT;
      const t = tickClock(this.game!.clock, SIM_DT);
      this.game = { ...this.game!, clock: t.clock };
      this.onEvents(sim.drainEvents());
      if (sim.result) break;
    }
    this.checkCallouts();
    this.updateLiveControls();
    if (sim.result) {
      this.setPhase('postplay');
      this.postTimer = 0;
      this.audio.whistle();
      const r = sim.result;
      const g = this.game!;
      const headline = { noPlay: 'NO PLAY', touchdown: 'TOUCHDOWN!', interception: 'INTERCEPTED!', sack: 'SACKED!', safety: 'SAFETY!', incomplete: 'INCOMPLETE', outOfBounds: 'OUT OF BOUNDS', tackle: r.yards >= g.toGo ? 'FIRST DOWN!' : 'DOWN' }[r.outcome];
      if (r.outcome === 'touchdown') this.audio.roar(1);
      else if (r.yards >= 20) this.audio.roar(0.6);
      const sub = r.fouls.length ? `FLAG: ${enforcePenalties(g, r, r.fouls).text}` : `${r.description} · vs ${r.defenseCall}`;
      this.flash(headline, sub, POSTPLAY_TIME + 1);
    }
  }

  private onEvents(events: PlayEvent[]) {
    for (const e of events) {
      if (e.type === 'deflection') this.flash('BROKEN UP', '', 1);
      if (e.type === 'drop') this.flash('DROPPED', '', 1);
      if (e.type === 'brokenTackle') this.flash('BROKEN TACKLE', '', 0.7);
      if (e.type === 'interception') this.audio.roar(0.4);
      if (e.type === 'flag' && this.sim) {
        const fl = this.sim.flags[this.sim.flags.length - 1];
        this.callouts.push({ at: fl.t0 + fl.T + PENALTIES.flag.calloutDelay, foul: fl.foul });
      }
    }
  }

  /** The penalty call-out appears once the flag has landed. */
  private checkCallouts() {
    const sim = this.sim;
    if (!sim) return;
    const g = this.game!;
    for (const c of this.callouts.filter((x) => sim.t >= x.at)) {
      const off = getTeam(g.teams[g.possession]).name;
      const def = getTeam(g.teams[other(g.possession)]).name;
      const t = calloutText(c.foul, off, def);
      this.hud.showCallout(t.title, t.sub);
    }
    this.callouts = this.callouts.filter((x) => sim.t < x.at);
  }

  private updateLiveControls() {
    const sim = this.sim!;
    const qb = sim.get('QB');
    this.touch.setSlots(this.target, this.blockingSlots(), sim.canThrow());
    if (sim.canThrow()) {
      this.touch.setPrimary(sim.charging ? 'RELEASE' : 'THROW', 'throw');
      const info = sim.throwInfo(this.target);
      this.touch.setCharge(true, info.charge, info.window);
      this.touch.setSecondary(null);
      this.hud.setHint(this.playsRun <= 3 && !sim.play.run ? 'Hold a receiver button, release in the green zone.' : null);
    } else {
      const carrier = sim.carrier;
      const userRuns = !!carrier && carrier.side === 'off' && sim.controlledId === carrier.id && !sim.result;
      const qbRuns = userRuns && carrier === qb && sim.pastLos(qb);
      this.touch.setPrimary(userRuns ? 'JUKE' : '', userRuns ? 'juke' : 'none');
      this.touch.setSecondary(qbRuns ? 'SLIDE' : null);
      this.touch.setCharge(false, 0, null);
      this.hud.setHint(qbRuns && this.playsRun <= 6 ? 'Scrambling: find a lane · SLIDE to give yourself up' : userRuns && this.playsRun <= 3 ? 'Steer with your left thumb · JUKE to dodge' : null);
    }
    const holds = sim.ball.holder === qb.id && !sim.result;
    this.hud.setPressure(holds, sim.pressure);
    const cue = holds ? sim.pocketCue : null;
    this.hud.setPocketCue(cue ? cue.heading - this.gazeYaw : null, cue ? cue.level : 0);
    this.updateEdgeMarkers(sim.canThrow());
  }

  /** Receivers outside the view show up as arrows at the screen edge. */
  private updateEdgeMarkers(show: boolean) {
    const sim = this.sim;
    if (!sim || !show) {
      this.hud.setEdgeMarkers(null);
      return;
    }
    const markers: EdgeMarker[] = [];
    for (const slot of ELIGIBLE) {
      const r = sim.get(slot);
      if (r.route?.blocks) continue;
      const p = this.view.project(r.pos.x, r.pos.y, 2.6);
      markers.push({ slot, label: LABELS[slot], color: hex(SLOT_COLORS[slot]), x: p.x, y: p.y, onScreen: p.onScreen, selected: slot === this.target });
    }
    this.hud.setEdgeMarkers(markers);
  }

  private postplay(f: InputFrame, dt: number) {
    const sim = this.sim!;
    this.acc += dt;
    while (this.acc >= SIM_DT) {
      sim.step({ move: { x: 0, y: 0 }, gazeYaw: this.gazeYaw, throwHeld: false, target: null, handoff: false, juke: false });
      this.acc -= SIM_DT;
    }
    this.checkCallouts();
    this.postTimer += dt;
    this.touch.setPrimary('NEXT', 'snap');
    this.touch.setSecondary(null);
    this.touch.setCharge(false, 0, null);
    this.hud.setPressure(false, 0);
    this.hud.setPocketCue(null, 0);
    this.hud.setEdgeMarkers(null);
    this.hud.setHint(null);
    if (this.postTimer > POSTPLAY_TIME || (f.primaryPressed && this.postTimer > 0.3)) {
      this.hud.showBanner(null);
      this.finishPlay();
    }
  }

  private render(dt: number) {
    const g = this.game;
    if (g) {
      this.hud.update(g);
      this.hud.setCrowd(g.crowd, this.phase !== 'title' && this.phase !== 'gameover');
      this.view.setCrowdEnergy(0.15 + 0.85 * Math.max(crowdIntensity(g.crowd), (g.crowd - 25) / 100));
      this.audio.setLevel(g.crowd);
    }
    const dtv = this.paused ? 0 : dt;
    if (this.phase === 'intro') {
      // The cutscene director already placed meshes and camera.
    } else if (this.kick && (this.phase === 'kick' || this.phase === 'kickFlight' || this.phase === 'break')) {
      const k = this.kick;
      this.view.updateKick(k.spot, k.flight, k.t, dtv, this.teamOf(k.side), k.kind === 'fieldGoal', k.side !== g!.userSide);
    } else if (this.ret && (this.phase === 'return' || this.phase === 'returnPost' || this.phase === 'break')) {
      this.view.update(this.ret, this.phase === 'break' ? 1 : this.acc / SIM_DT, dtv, {
        gazeYaw: 0, gazePitch: 0, target: null, cameraMode: 'behindQB', presnap: false,
      });
    } else if (this.sim && (this.phase === 'presnap' || this.phase === 'live' || this.phase === 'postplay' || this.phase === 'playcall')) {
      this.view.update(this.sim, this.phase === 'live' || this.phase === 'postplay' ? this.acc / SIM_DT : 1, dtv, {
        gazeYaw: this.gazeYaw, gazePitch: this.gazePitch, target: this.target, cameraMode: this.settings.cameraMode,
        presnap: this.phase === 'presnap',
      });
      if (this.phase === 'playcall') this.view.field.setTargetRing(null, 0);
    } else {
      this.view.updateIdle(g ? g.ballX : 0, g ? g.ballY : 25, dt);
    }
    this.hud.setSituationVisible(this.phase !== 'title' && this.phase !== 'gameover');
    if (this.phase !== 'live') {
      this.hud.setPressure(false, 0);
      this.hud.setPocketCue(null, 0);
    }
    if (this.phase !== 'live' && this.phase !== 'presnap') this.hud.setEdgeMarkers(null);
    this.view.render();
  }
}
