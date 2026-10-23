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
import { dist } from './core/vec';
import { DIFFICULTY, getTeam } from './data';
import type { DefSlot, EligibleSlot, PlayData, TeamData } from './data/types';
import { ELIGIBLE } from './data/types';
import { InputManager, type InputFrame } from './input/input';
import { SceneView } from './render/view';
import { SLOT_COLORS } from './render/fieldMesh';
import { Cutscene } from './render/cutscene';
import { PlaySim, SIM_DT, type PlayEvent, type PlayResult, type SimInput } from './play/sim';
import { ReturnSim } from './play/returnSim';
import { AUDIBLES, AudibleSession, audibleCost } from './play/audible';
import { AudibleMenu } from './ui/audible';
import { chooseDefense, emptyTendencies, recordTendency, type DefenseCall } from './play/defenseCalls';
import { PENALTIES, calloutText, type Flag } from './play/penalties';
import { ST, aimNeedle, aimToAngle, aimZone, cpuRelease, judgeFieldGoal, kickFlight, kickZone, meterPower, releaseKickAimed, type KickFlight, type KickKind } from './play/kicking';
import { PACE, PLAY_CLOCK, pacedSnap, snapClock, tickClock } from './game/clock';
import { afterPlay, checkQuarter, type Break } from './game/flow';
import { attemptFieldGoal, delayOfGame, fieldGoalDistance, finishTry, punt, type RulesResult } from './game/rules';
import { chooseConversion, conversionOptions, patDistance, quickConversion, startTwoPointTry, type TryKind } from './game/conversion';
import { OT, overtimeLabel } from './game/overtime';
import { callTimeout, cpuWantsTimeout } from './game/timeouts';
import { enforcePenalties, type Enforcement } from './game/penalties';
import { applyFieldGoal, applyReturn, kickoffOutOfBounds } from './game/specialTeams';
import { crowdEdge, crowdIntensity, updateCrowd, type PlayForCrowd } from './game/crowd';
import { newGame, other, type GameState, type TeamSide } from './game/state';
import { simulateCpuDrive } from './game/cpuDrive';
import { loadSettings, saveSettings, type Settings } from './game/settings';
import { Hud, type EdgeMarker } from './ui/hud';
import { TouchControls } from './ui/touch';
import { TAP_SELECT, pickAtTap } from './ui/tapSelect';
import { HotLatch, SLOT_STATE, slotDisplay, type SlotDisplay } from './ui/slotState';
import { PlaycallScreen } from './ui/playcall';
import { IntroOverlay } from './ui/intro';
import { Modal, boxScore, button, driveSummary, helpContent, scoreLine, settingsPanel, titleScreen } from './ui/menus';
import { h } from './ui/dom';
import { CrowdAudio } from './audio/crowdAudio';
import { CpuQB, chooseCpuPlay, fourthDownCall } from './play/qbAI';
import { DEF_CONTROL } from './play/interception';
import { reactionTo, reactionToFlag } from './audio/crowdMix';

type Phase = 'title' | 'intro' | 'playcall' | 'presnap' | 'live' | 'postplay' | 'kick' | 'kickFlight' | 'return' | 'returnPost' | 'break' | 'gameover';

/** Seconds the result stays up after the whistle (tap NEXT to skip). */
/** Pause after the whistle (Phase 3c: data/pace.json real.post, part of the game-length budget). */
const POSTPLAY_TIME = PACE.real.post;
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
  /** Phase 3b: layer 1 (hold for power) then layer 2 (tap to lock the aim needle). */
  stage: 'power' | 'aim';
  aimT: number;
  /** Phase 3b: this field goal is the extra-point try. */
  pat?: boolean;
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
  /** Phase 3d: hot read shown without flicker, and when the user last pressed a receiver after the throw. */
  private hotLatch = new HotLatch();
  private latePress: { slot: EligibleSlot; t: number } | null = null;
  private acc = 0;
  private postTimer = 0;
  private bannerTimer = 0;
  private lastTime = 0;
  private playsRun = 0;
  private callouts: { at: number; flag: Flag }[] = [];
  /** A flag was thrown since the last snap: the next play-clock expiry is not a second penalty. */
  private waiveDelayOfGame = false;
  /** CPU has the ball and the user plays defense (interactive CPU drive). */
  private defense = false;
  private cpuQB: CpuQB | null = null;
  /** Cornerback the user controls; kept from play to play. */
  private defSlot: DefSlot = 'CB1';
  private presnapTimer = 0;
  /** Phase 3c: audibles at the line on the user's snaps. */
  private aud: AudibleSession | null = null;
  private audMenu = new AudibleMenu((p) => this.audible(p));
  private playSeed = 1;

  constructor(canvas: HTMLCanvasElement, ui: HTMLElement) {
    this.view = new SceneView(canvas);
    this.touch = new TouchControls(this.input);
    this.playcall = new PlaycallScreen({
      onPlay: (p) => this.callPlay(p),
      onPunt: () => this.userKickFromPlaycall('punt'),
      onFieldGoal: () => this.userKickFromPlaycall('fieldGoal'),
      onTimeout: () => this.timeout(),
      onDefense: (call) => this.callDefense(call),
    });
    ui.append(this.touch.root, this.audMenu.root, this.hud.root, this.playcall.root, this.intro.root, this.modal.root,
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
    if (p !== 'presnap') this.audMenu.hide();
    if (p !== 'live') this.touch.setSprint(false);
    if (p !== 'return') this.touch.setSwitch(false);
    const onField = p === 'presnap' || p === 'live' || p === 'postplay' || p === 'kick' || p === 'kickFlight' || p === 'return' || p === 'returnPost';
    this.touch.setVisible(onField);
    if (!this.defense) this.touch.setDefenders(null);
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
    if (g.pendingConversion) return this.startConversion(g.pendingConversion);
    if (g.pendingKickoff) {
      if (this.settings.quickSim) {
        // Phase 1 behavior: no kickoff, the receiving team starts at its 25 (already set by the rules).
        this.game = { ...g, pendingKickoff: null };
      } else {
        return this.startKickoff(g.pendingKickoff);
      }
    }
    if (this.game!.possession !== this.game!.userSide) return this.settings.simCpuDrives ? this.runCpuDrive() : this.enterDefense();
    this.enterPlaycall();
  }

  // ------------------------------------------------------------ tries (Phase 3b)

  /** The try after a touchdown: the user chooses on a modal, the CPU by its chart. */
  private startConversion(side: TeamSide) {
    const g = this.game!;
    this.playcall.hide();
    this.setPhase('break');
    const choose = (kind: TryKind) => {
      this.modal.hide();
      const st = this.game!;
      if (kind === 'two') {
        this.game = startTwoPointTry(st);
        if (side === st.userSide) return this.enterPlaycall();
        // CPU two-point play: defend it, unless CPU drives are simulated.
        if (!this.settings.simCpuDrives && !this.settings.quickSim) return this.enterDefense();
        return this.resolveQuickTry('two');
      }
      if (side === st.userSide && !this.settings.quickSim) {
        const d = patDistance();
        this.startUserKick('fieldGoal', side, { x: 0, y: 110 - d }, d);
        this.kick!.pat = true;
        this.hud.setPlayName(`EXTRA POINT · ${d} YDS`);
        return;
      }
      this.resolveQuickTry('kick');
    };
    if (side !== g.userSide) return choose(chooseConversion(g, side));
    const opts = conversionOptions(g);
    this.modal.show(h('h2', {}, 'TOUCHDOWN: THE TRY'), h('p', {}, scoreLine(g)),
      h('p', {}, opts.length === 1 ? `From the ${overtimeLabel(g)} on a touchdown must be followed by a two-point try.` : 'Kick the extra point (1) or run one play from the 3 (2).'),
      h('div', { class: 'row' },
        ...(opts.includes('kick') ? [button('KICK · 1 PT', () => choose('kick'))] : []),
        button('GO FOR 2', () => choose('two'), 'primary')));
  }

  /** A try resolved without playing it (CPU kick, quick sim). */
  private resolveQuickTry(kind: TryKind) {
    const g = this.game!;
    const side = g.pendingConversion ?? g.possession;
    const r = quickConversion(g, kind, this.rng);
    this.afterTry(g, side, r);
  }

  private afterTry(g: GameState, side: TeamSide, r: RulesResult) {
    const crowd = updateCrowd(g.crowd, {
      homeOffense: side === 'home', yards: 0, firstDown: false,
      score: r.scored ? { home: r.scored.side === 'home', points: r.scored.points } : null,
      turnover: false, sack: false, penaltyOnHome: null, failedFourthDown: false,
    });
    const ap = afterPlay({ ...r.state, crowd }, r.stop);
    this.game = ap.state;
    this.setPhase('break');
    this.modal.show(h('h2', {}, r.headline), h('p', {}, scoreLine(this.game)),
      h('div', { class: 'row' }, button('CONTINUE', () => {
        this.modal.hide();
        this.handleBreak(ap.brk);
      }, 'primary')));
  }

  private enterPlaycall() {
    const g = this.game!;
    this.defense = false;
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
    // No flags on tries (enforcement on a two-point play is not modelled).
    if (!this.settings.penalties || g.conversionTry) return { off: 0, def: 0 };
    const edge = crowdEdge(g.crowd, this.settings.crowdEffect);
    const offHome = g.possession === 'home';
    return { off: offHome ? edge.homePenalty : edge.awayPenalty, def: offHome ? edge.awayPenalty : edge.homePenalty };
  }

  // ------------------------------------------------------------ defense (interactive CPU drives)

  /** Down markers in the user's world: a CPU possession's yard lines are in the CPU's frame. */
  private setMarkersFor(g: GameState) {
    const flip = g.possession !== g.userSide;
    const los = flip ? 100 - g.ballY : g.ballY;
    const fd = flip ? 100 - (g.ballY + g.toGo) : g.ballY + g.toGo;
    this.view.field.setMarkers(los, fd);
    this.view.field.showMarkers(true);
  }

  /** CPU ball: fourth-down decision, then the user's defensive play call. */
  private enterDefense() {
    let g = this.game!;
    if (g.down === 4 && !g.conversionTry) {
      const trailingLate = !!g.overtime || (g.clock.quarter >= 4 && g.clock.remaining < 300 && g.score[g.possession] < g.score[g.userSide]);
      let call = fourthDownCall({ down: g.down, toGo: g.toGo, yardline: g.ballY }, trailingLate);
      // Overtime: no punts; kick it when in range, otherwise go for it.
      if (g.overtime && call === 'punt') call = fieldGoalDistance(g.ballY) <= 52 ? 'fieldGoal' : 'go';
      if (call === 'fieldGoal') return this.quickKick('fg');
      if (call === 'punt') return this.settings.quickSim ? this.quickKick('punt') : this.startCpuKick('punt');
    }
    const cpu = g.possession;
    if (cpuWantsTimeout(g, cpu)) {
      g = this.game = callTimeout(g, cpu)!;
      this.flash(`TIMEOUT ${getTeam(g.teams[cpu]).abbr}`, `${g.timeouts[cpu]} left`);
    }
    this.defense = true;
    this.kick = null;
    this.sim = null;
    this.setPhase('playcall');
    this.hud.showBanner(null);
    this.hud.setPlayName(null);
    this.hud.setHint(null);
    this.view.showRoutes(null);
    this.setMarkersFor(g);
    this.playcall.showDefense(g);
  }

  /** The user picked a defense (null: let the coordinator call it); the CPU picks its play. */
  private callDefense(call: DefenseCall | null) {
    const g = this.game!;
    if (!this.defense || this.phase !== 'playcall') return;
    this.playcall.hide();
    const diff = DIFFICULTY[g.difficulty];
    const sit = { down: g.down, toGo: g.toGo, yardline: g.ballY };
    const defense = call ?? chooseDefense(
      { ...sit, halfSecondsLeft: (g.clock.quarter % 2 === 1 ? g.clock.quarterLength : 0) + g.clock.remaining, scoreDiff: g.score[g.possession] - g.score[g.userSide] },
      emptyTendencies(), DIFFICULTY.normal, this.rng,
    );
    const play = chooseCpuPlay(sit, this.rng);
    this.play = play;
    // The defenders are the user's team: they cover at Normal. Difficulty shows in the CPU QB (cpuOffense) and the flag rate.
    this.sim = new PlaySim({
      play, defense, offenseTeam: this.cpuTeam, defenseTeam: this.userTeam, ballX: g.ballX, los: g.ballY,
      difficulty: { ...DIFFICULTY.normal, penaltyRate: diff.penaltyRate }, seed: this.rng.int(1, 2 ** 31 - 1),
      penaltyBias: this.penaltyBias(), userDefense: true,
    });
    this.sim.selectDefender(this.defSlot);
    this.cpuQB = new CpuQB(play, diff, new Rng(this.rng.int(1, 2 ** 31 - 1)));
    this.ret = null;
    this.callouts = [];
    this.target = null;
    this.view.bindPlay(this.sim, this.cpuTeam, this.userTeam);
    this.view.showRoutes(null);
    this.setMarkersFor(g);
    this.hud.setPlayName(`DEFENSE · ${defense.name}`);
    this.presnapTimer = 0;
    this.setPhase('presnap');
  }

  /**
   * Phase 3b: any defender. The defender strip (touch) picks a slot directly; SWITCH (secondary
   * button, X / Shift, pad 6 / 10) takes the defender nearest the ball (next in order before the
   * snap); 1 / 2 / 3 still jump to CB1 / CB2 / NB.
   */
  private switchDefender(f: InputFrame, live: boolean) {
    const keyMap: Partial<Record<EligibleSlot, DefSlot>> = { WR1: 'CB1', WR2: 'CB2', WR3: 'NB' };
    const sim = this.sim!;
    if (f.secondaryPressed) {
      const s = sim.switchDefender(live);
      if (s) this.defSlot = s;
      return;
    }
    const keySlot = f.slotPressed ? keyMap[f.slotPressed] ?? null : null;
    const slot = f.defenderPressed ?? keySlot ?? (f.tap ? this.defenderAtTap(f.tap) : null);
    if (!slot) return;
    sim.selectDefender(slot);
    if (sim.userDefender?.slot === slot) this.defSlot = slot;
  }

  /** Phase 3d: the defender drawn nearest a tap in the camera image (not the returner after a takeaway). */
  private defenderAtTap(tap: { x: number; y: number }): DefSlot | null {
    const sim = this.sim!;
    if (sim.returning) return null;
    const cands = sim.actors.filter((a) => a.side === 'def' && !a.down).map((a) => {
      const p = this.view.project(a.pos.x, a.pos.y, TAP_SELECT.aimHeight);
      return { slot: a.slot as DefSlot, x: p.x, y: p.y, onScreen: p.onScreen };
    });
    return pickAtTap(tap, cands);
  }

  private presnapDefense(f: InputFrame, dt: number) {
    this.presnapTimer += dt;
    this.switchDefender(f, false);
    const left = Math.max(0, DEF_CONTROL.presnapAutoSnap - this.presnapTimer);
    this.touch.setPrimary(`READY ${Math.ceil(left)}`, 'snap');
    this.touch.setSecondary(null);
    this.touch.setSlots(null);
    this.touch.setDefenders(this.defSlot);
    this.touch.setCharge(false, 0, null);
    this.hud.setEdgeMarkers(null);
    this.hud.setHint(this.playsRun < 6 ? `You are ${this.defSlot}. Left thumb moves him · JUMP plays the ball (time it!), dives at the runner or rips a block · tap a defender, SWITCH (left edge) or the PLAYERS menu changes player` : null);
    if (f.primaryPressed || left <= 0) {
      const g = this.game!;
      // Phase 3c: the CPU offense snaps on the pace (data/pace.json): the game clock does not depend on the auto-snap.
      this.game = { ...g, clock: g.conversionTry ? { ...snapClock(g.clock), running: false } : pacedSnap(g.clock) };
      this.waiveDelayOfGame = false;
      this.acc = 0;
      this.playsRun++;
      this.setPhase('live');
    }
  }

  private liveDefense(f: InputFrame, dt: number) {
    const sim = this.sim!;
    this.switchDefender(f, true);
    // The camera looks back at the offense: stick up = toward the line of scrimmage.
    const def = { move: { x: -f.move.x, y: -f.move.y }, jump: f.primaryPressed };
    this.acc += dt;
    let first = true;
    while (this.acc >= SIM_DT) {
      const inp = this.cpuQB!.input(sim);
      inp.defense = first ? def : { ...def, jump: false };
      sim.step(inp);
      first = false;
      this.acc -= SIM_DT;
      const t = tickClock(this.game!.clock, SIM_DT);
      this.game = { ...this.game!, clock: t.clock };
      this.onEvents(sim.drainEvents());
      if (sim.result) break;
    }
    this.checkCallouts();
    const c = sim.carrier;
    const runner = !!c && c.side === 'off' && (c.slot !== 'QB' || sim.pastLos(c));
    const blocked = sim.blockStates().some((b) => b.defender === sim.userDefId);
    const returner = sim.returning && c?.id === sim.userDefId;
    this.touch.setPrimary(returner ? 'JUKE' : runner ? 'DIVE' : blocked && sim.ball.state !== 'air' ? 'RIP' : 'JUMP', returner ? 'juke' : 'throw');
    this.touch.setSecondary(null);
    this.touch.setSlots(null);
    // The strip shows whoever the user controls now (the returner after a takeaway); no SWITCH while he runs.
    this.touch.setDefenders((sim.userDefender?.slot as DefSlot | undefined) ?? this.defSlot, !returner);
    this.touch.setCharge(false, 0, null);
    this.hud.setEdgeMarkers(null);
    this.hud.setHint(null);
    if (sim.result) this.whistle();
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
    this.playSeed = this.rng.int(1, 2 ** 31 - 1);
    this.aud = new AudibleSession(play, defense, diff, new Rng(this.playSeed ^ 0x5a5a));
    this.audMenu.hide();
    this.ret = null;
    this.callouts = [];
    this.buildOffenseSim(play, defense);
    this.view.field.setMarkers(g.ballY, g.ballY + g.toGo);
    this.view.field.showMarkers(true);
    this.gazeYaw = 0;
    this.gazePitch = -0.06;
    this.setPhase('presnap');
  }

  /** The user's snap with `play` against `defense` (also after an audible or the defense's re-read). */
  private buildOffenseSim(play: PlayData, defense: DefenseCall) {
    const g = this.game!;
    this.play = play;
    this.sim = new PlaySim({
      play, defense, offenseTeam: this.userTeam, defenseTeam: this.cpuTeam,
      ballX: g.ballX, los: g.ballY, difficulty: DIFFICULTY[g.difficulty], seed: this.playSeed, penaltyBias: this.penaltyBias(),
    });
    this.view.bindPlay(this.sim, this.userTeam, this.cpuTeam);
    this.view.showRoutes(this.settings.showRoutes ? this.sim : null);
    this.target = play.run ? null : (play.primary ?? null);
    this.hud.setPlayName(play.name);
  }

  /** Phase 3c: check to another play at the line. */
  private audible(play: PlayData) {
    const g = this.game!;
    const aud = this.aud;
    if (!aud || this.phase !== 'presnap' || this.defense) return;
    const r = aud.call(play, g.clock);
    if (!r) return;
    this.game = { ...g, clock: r.clock };
    this.buildOffenseSim(play, aud.defense);
    this.flash('AUDIBLE', `${play.name} · -${r.cost}s`, 1.2);
  }

  private snap() {
    const g = this.game!;
    // Tries are untimed: the game clock does not run on them.
    // Phase 3c snap timing: a running clock runs off down to the pace's snap point.
    const clock = g.conversionTry ? { ...snapClock(g.clock), running: false } : pacedSnap(g.clock);
    this.game = { ...g, clock, tendencies: recordTendency(g.tendencies, this.play!.category) };
    this.view.showRoutes(null);
    this.hotLatch.reset();
    this.latePress = null;
    this.audMenu.hide();
    // Phase 3c: a run audible the defense did not answer in time catches its blitz.
    if (this.aud && this.sim && !this.defense) this.sim.audibleEdge = this.aud.edge;
    this.waiveDelayOfGame = false;
    this.acc = 0;
    this.playsRun++;
    this.setPhase('live');
  }

  private timeout() {
    const g = this.game!;
    if (!(this.phase === 'playcall' || this.phase === 'presnap')) return;
    const st = callTimeout(g, g.userSide);
    if (!st) return;
    this.game = st;
    this.flash('TIMEOUT', `${st.timeouts[g.userSide]} left ${st.overtime ? 'this period' : 'this half'}`);
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
    if (res.fouls.length) this.waiveDelayOfGame = true;
    const r = enf.result;
    const st = { ...r.state, stats: { ...r.state.stats } };
    const side = g.possession;
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
    st.crowd = updateCrowd(g.crowd, this.playForCrowd(g, res, enf));
    const ap = afterPlay(st, r.stop);
    this.game = ap.state;
    this.handleBreak(ap.brk);
  }

  /** A finished scrimmage play from the home crowd's view (crowd meter and crowd sound). */
  private playForCrowd(g: GameState, res: PlayResult, enf: Enforcement): PlayForCrowd {
    const r = enf.result;
    return {
      homeOffense: g.possession === 'home', yards: enf.enforced ? 0 : res.yards, firstDown: r.headline === 'FIRST DOWN',
      score: r.scored ? { home: r.scored.side === 'home', points: r.scored.points } : null,
      turnover: res.turnover && !enf.enforced, sack: res.outcome === 'sack',
      penaltyOnHome: enf.enforced ? (enf.enforced.side === 'off') === (g.possession === 'home') : null,
      failedFourthDown: r.headline === 'TURNOVER ON DOWNS',
    };
  }

  private handleBreak(brk: Break) {
    if (brk === 'gameover') return this.showGameOver();
    if (brk === 'none') return this.nextSnap();
    this.setPhase('break');
    this.playcall.hide();
    const g = this.game!;
    const title = brk === 'halftime' ? 'HALFTIME' : brk === 'overtime' ? 'OVERTIME' : `END OF Q${g.clock.quarter - 1}`;
    const otText = brk === 'overtime'
      ? h('p', {}, `Tied after four quarters. ${getTeam(g.teams[other(g.overtime!.first)]).abbr} wins the toss and defers: ${getTeam(g.teams[g.overtime!.first]).abbr} has the ball first. Each team gets a possession from the ${OT.startYard}; from the 2nd overtime a touchdown needs a two-point try, from the 3rd it is one two-point play each.`)
      : '';
    this.modal.show(h('h2', {}, title), h('p', {}, scoreLine(g)), otText, brk === 'halftime' ? boxScore(g) : '',
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
    this.kick = { kind, side, spot, held: 0, holding: false, flight: null, t: 0, fgDistance, done: false, stage: 'power', aimT: 0 };
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
      // Phase 3b: on the user's own kicks the user plays a cover man.
      userCovers: kicking === g.userSide,
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
      if (k.stage === 'power') {
        if (f.primaryHeld && !k.done) {
          k.holding = true;
          k.held += dt;
        } else if (k.holding && !f.primaryHeld) {
          // Layer 1 done: power locked. Layer 2: the aim needle starts sweeping.
          k.stage = 'aim';
          k.aimT = 0;
          k.holding = false;
        }
      } else {
        k.aimT += dt;
        // Tap locks the needle (it locks itself after a few sweeps so the game never stalls).
        if (f.primaryPressed || k.aimT > ST.meter.aim.period * 6) {
          k.done = true;
          const rel = releaseKickAimed(k.kind, k.held, aimNeedle(k.aimT), diff.kickWindow, k.fgDistance);
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
      }
      const zone = kickZone(k.kind, diff.kickWindow, k.fgDistance);
      const P = ST.meter.punt;
      const aiming = k.stage === 'aim';
      const needle = aiming ? aimNeedle(k.aimT) : -1;
      const punt = k.kind === 'punt';
      this.hud.setKickMeter({
        title: k.kind === 'kickoff' ? 'KICKOFF' : punt ? 'PUNT' : `FIELD GOAL ${k.fgDistance} YDS`,
        power: meterPower(k.held),
        zone,
        step: aiming ? 2 : 1,
        angle: punt ? { value: aimToAngle(needle), min: P.angleMin, max: P.angleMax, ideal: P.idealAngle, halfWidth: P.angleHalfWidth * diff.kickWindow } : undefined,
        aim: aiming ? { value: needle, zone: aimZone(k.kind, diff.kickWindow), left: punt ? 'LOW' : 'LEFT', right: punt ? 'HIGH' : 'RIGHT', active: true, label: punt ? 'ANGLE' : 'ACCURACY' } : undefined,
        sub: aiming ? (punt ? 'Tap when the needle is in the green: the hang angle.' : 'Tap when the needle is in the green: straight through.') : 'Hold KICK, release in the green zone for power.',
      });
      this.touch.setPrimary(aiming ? 'TAP' : k.holding ? 'RELEASE' : 'KICK', 'kick');
      this.touch.setSlots(null);
      this.touch.setSecondary(null);
      this.touch.setCharge(false, 0, null);
      this.hud.setHint(this.playsRun < 6 ? (aiming ? 'Second tap: stop the needle in the green.' : 'Hold KICK to fill the meter, release in the green zone.') : null);
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
      if (k.pat) {
        this.kick = null;
        this.audio.react(judged.good ? { kind: 'cheer', intensity: 0.6 } : { kind: 'silence', intensity: 0.5 });
        return this.afterTry(g, k.side, finishTry(g, 'kick', judged.good));
      }
      const r = applyFieldGoal({ ...g, clock: tickClock(g.clock, 5).clock }, judged.good, k.fgDistance);
      const pfc: PlayForCrowd = {
        homeOffense: g.possession === 'home', yards: 0, firstDown: false,
        score: r.scored ? { home: r.scored.side === 'home', points: 3 } : null, turnover: false, sack: false, penaltyOnHome: null,
        failedFourthDown: false,
      };
      const crowd = updateCrowd(g.crowd, pfc);
      this.audio.react(judged.good ? reactionTo(pfc) : { kind: g.possession === 'home' ? 'silence' : 'cheer', intensity: 0.7 });
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
      // Phase 3d: caught in the end zone, the secondary button is TOUCHBACK (take a knee) instead of DASH.
      const decide = rs.canTouchback;
      while (this.acc >= SIM_DT) {
        rs.step({
          move: rs.userReturns ? f.move : { x: 0, y: 0 }, dash: first && rs.userReturns && (f.primaryPressed || (!decide && f.secondaryPressed)),
          touchback: first && decide && f.secondaryPressed,
          // Covering the user's own kick: the camera looks back at the returner, so the stick is mirrored (as on defense).
          cover: rs.coverMan ? { move: { x: -f.move.x, y: -f.move.y }, dive: first && f.primaryPressed, switch: first && f.secondaryPressed } : undefined,
        });
        first = false;
        this.acc -= SIM_DT;
        const t = tickClock(this.game!.clock, SIM_DT);
        this.game = { ...this.game!, clock: t.clock };
        this.onEvents(rs.drainEvents());
        if (rs.result) break;
      }
      const carrying = rs.userReturns && rs.carrier === rs.returner;
      if (rs.coverMan) {
        this.touch.setPrimary(rs.coverBlocked ? 'RIP' : 'DIVE', 'throw');
        this.touch.setSecondary(null);
        this.touch.setSwitch(true);
      } else {
        this.touch.setPrimary(carrying ? 'DASH' : '', carrying ? 'juke' : 'none');
        this.touch.setSecondary(rs.canTouchback ? 'TOUCH BACK' : null);
      }
      this.touch.setSlots(null);
      this.touch.setCharge(false, 0, null);
      this.hud.setHint(rs.coverMan && this.playsRun < 10 ? 'Cover the kick: left thumb runs your man down · DIVE to tackle (RIP when blocked) · SWITCH (left edge) = man nearest the ball'
        : rs.canTouchback ? 'In the end zone: TOUCH BACK to take a knee, or run it out'
        : rs.userReturns && this.playsRun < 8 ? (carrying ? 'Steer with your left thumb · DASH for a burst' : 'Get under the ball...') : null);
      if (rs.result) {
        this.audio.whistle();
        this.postTimer = 0;
        this.setPhase('returnPost');
        const res = rs.result;
        const head = res.outcome === 'touchdown' ? 'TOUCHDOWN!' : res.outcome === 'touchback' ? 'TOUCHBACK' : res.outcome === 'downed' ? 'DOWNED' : res.outcome === 'outOfBoundsKick' ? 'OUT OF BOUNDS' : 'RETURN';
        if (res.outcome === 'touchdown' && this.retInfo) this.audio.react(other(this.retInfo.kicking) === 'home' ? { kind: 'roar', intensity: 1 } : { kind: 'silence', intensity: 1 });
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
    if (t.clock.warned && !g.clock.warned) this.flash('TWO-MINUTE WARNING', '', 1.6);
    if (t.quarterExpired) {
      const q = checkQuarter(this.game);
      this.game = q.state;
      if (q.brk !== 'none') return this.handleBreak(q.brk);
    }
    if (t.playClockExpired && this.defense) {
      // The CPU offense is waiting on the user's defensive call: no delay of game for that.
      this.game = { ...this.game, clock: { ...this.game.clock, playClock: PLAY_CLOCK } };
    } else if (t.playClockExpired && this.waiveDelayOfGame) {
      // No penalty chains: the first expiry after a flagged play only resets the play clock.
      this.waiveDelayOfGame = false;
      this.game = { ...this.game, clock: { ...this.game.clock, playClock: PLAY_CLOCK } };
    } else if (t.playClockExpired) {
      this.waiveDelayOfGame = true;
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
    if (this.defense) return this.presnapDefense(f, dt);
    this.updateGaze(f, dt);
    const aud = this.aud;
    // Phase 3c: the defense re-reads an audible after its reaction time.
    const reread = aud?.update(dt);
    if (aud && reread) this.buildOffenseSim(aud.play, reread);
    if (this.audMenu.visible) {
      // 1 / 2 / 3 pick an audible while the menu is open; AUDIBLE again closes it.
      const idx = f.slotPressed ? (['WR1', 'WR2', 'WR3'] as EligibleSlot[]).indexOf(f.slotPressed) : -1;
      if (idx >= 0) this.audMenu.pick(idx);
      else if (f.secondaryPressed) this.audMenu.hide();
    } else {
      // Picking a receiver pre-snap only marks him; the QB does not turn his head.
      if (f.slotPressed) this.target = f.slotPressed;
      if (f.secondaryPressed && aud?.canAudible && !this.game!.conversionTry) {
        this.audMenu.show(aud.options, audibleCost(aud.count + 1), AUDIBLES.maxPerPlay - aud.count);
      }
    }
    this.touch.setPrimary('SNAP', 'snap');
    this.touch.setSecondary(aud?.canAudible && !this.game!.conversionTry ? 'AUDIBLE' : null);
    this.touch.setSlots(this.slotLooks(false));
    this.touch.setCharge(false, 0, null);
    this.hud.setHint(this.playsRun < 3 ? 'All receivers are marked. Tap SNAP, then HOLD a receiver button to charge and RELEASE to throw.' : null);
    this.updateEdgeMarkers(true);
    if (f.primaryPressed) this.snap();
  }

  /** Phase 3d: receiver button looks (ui/slotState.ts). `live`: after the snap (hot read, late presses). */
  private slotLooks(live: boolean): Partial<Record<EligibleSlot, SlotDisplay>> {
    const sim = this.sim!;
    const qb = sim.get('QB');
    const hot = live ? this.hotLatch.update(sim.t, sim.hot) : null;
    const out: Partial<Record<EligibleSlot, SlotDisplay>> = {};
    for (const s of ELIGIBLE) {
      const r = sim.get(s);
      out[s] = slotDisplay({
        blocks: !!r.route?.blocks, distance: dist(qb.pos, r.pos), thrown: live && sim.thrown,
        pressedRecently: !!this.latePress && this.latePress.slot === s && sim.t - this.latePress.t < SLOT_STATE.thrownFlash,
        selected: s === this.target, hot: s === hot,
      });
    }
    return out;
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
      sprint: f.sprintHeld,
    };
  }

  private live(f: InputFrame, dt: number) {
    if (this.defense) return this.liveDefense(f, dt);
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
    this.updateLiveControls(f);
    if (sim.result) this.whistle();
  }

  /** Whistle: result banner and crowd reaction, then the post-play phase. */
  private whistle() {
    const r = this.sim!.result!;
    const g = this.game!;
    {
      this.setPhase('postplay');
      this.postTimer = 0;
      this.audio.whistle();
      const headline = { noPlay: 'NO PLAY', touchdown: 'TOUCHDOWN!', interception: 'INTERCEPTED!', sack: 'SACKED!', safety: 'SAFETY!', incomplete: 'INCOMPLETE', outOfBounds: 'OUT OF BOUNDS', tackle: r.yards >= g.toGo ? 'FIRST DOWN!' : 'DOWN' }[r.outcome];
      const enf = enforcePenalties(g, r, r.fouls);
      // Flags get their boos at the call-out; interceptions already got their reaction at the catch.
      if (r.outcome !== 'interception') this.audio.react(reactionTo({ ...this.playForCrowd(g, r, enf), penaltyOnHome: null }));
      const sub = r.fouls.length ? `FLAG: ${enf.text}` : this.defense ? `${r.description} · ${this.play!.name}` : `${r.description} · vs ${r.defenseCall}`;
      this.flash(headline, sub, POSTPLAY_TIME + 1);
    }
  }

  /** Phase 3c: who returns the turnover (the user's team runs it back, or chases). */
  private turnoverSub(): string {
    const userHasBall = this.defense;
    return userHasBall ? 'Return it! Stick runs, JUMP jukes' : 'Chase him down!';
  }

  private onEvents(events: PlayEvent[]) {
    for (const e of events) {
      if (e.type === 'deflection') this.flash('BROKEN UP', '', 1);
      if (e.type === 'drop') this.flash('DROPPED', '', 1);
      if (e.type === 'brokenTackle') this.flash('BROKEN TACKLE', '', 0.7);
      if (e.type === 'timing' && this.sim?.lastTiming) {
        const gr = this.sim.lastTiming.grade;
        const early = this.sim.lastTiming.offset < 0;
        if (gr !== 'none') this.flash(gr === 'perfect' ? 'PERFECT JUMP' : gr === 'good' ? 'GOOD JUMP' : early ? 'JUMPED TOO EARLY' : 'JUMPED TOO LATE', '', 0.9);
      }
      // Phase 3c: turnovers are live: say who has the ball now.
      if (e.type === 'interception') this.flash('INTERCEPTED!', this.turnoverSub(), 1.4);
      if (e.type === 'fumble') this.flash('FUMBLE!', 'Ball is loose', 1.2);
      if (e.type === 'recovery' && this.sim && e.actor !== undefined) {
        const def = this.sim.actors[e.actor].side === 'def';
        this.flash(def ? 'TURNOVER!' : 'RECOVERED', def ? this.turnoverSub() : 'Offense keeps it', 1.4);
      }
      if (e.type === 'interception' && this.game) this.audio.react(this.game.possession === 'home' ? { kind: 'silence', intensity: 1 } : { kind: 'roar', intensity: 0.8 });
      if (e.type === 'flag' && this.sim) {
        const fl = this.sim.flags[this.sim.flags.length - 1];
        this.callouts.push({ at: fl.t0 + fl.T + PENALTIES.flag.calloutDelay, flag: fl });
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
      const t = calloutText(c.flag.foul, off, def);
      this.audio.react(reactionToFlag((c.flag.foul.side === 'off') === (g.possession === 'home')));
      this.hud.showCallout(t.title, t.sub);
    }
    this.callouts = this.callouts.filter((x) => sim.t < x.at);
  }

  private updateLiveControls(f: InputFrame) {
    const sim = this.sim!;
    const qb = sim.get('QB');
    if (sim.thrown && f.slotPressed) this.latePress = { slot: f.slotPressed, t: sim.t };
    // Buttons stay up while the pass is in the air, so a late press shows why nothing happens.
    const inAir = sim.thrown && sim.ball.state === 'air' && !sim.result;
    this.touch.setSlots(sim.canThrow() || inAir ? this.slotLooks(true) : null);
    if (sim.canThrow()) {
      this.touch.setSprint(false);
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
      this.touch.setSprint(userRuns, sim.sprint.stamina, sim.sprint.sprinting);
      this.touch.setSecondary(qbRuns ? 'SLIDE' : null);
      this.touch.setCharge(false, 0, null);
      this.hud.setHint(qbRuns && this.playsRun <= 6 ? 'Scrambling: find a lane · SLIDE to give yourself up' : userRuns && this.playsRun <= 3 ? 'Steer with your left thumb · JUKE to dodge · hold SPRINT (costs stamina, loosens the ball)' : null);
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
