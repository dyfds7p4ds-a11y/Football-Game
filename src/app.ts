/**
 * App: top-level state machine. Owns the GameState and the current PlaySim,
 * routes InputFrames into them, and drives SceneView + UI. All football
 * logic lives in game/ and play/; this file is glue.
 */
import { Rng } from './core/rng';
import { DIFFICULTY, getTeam } from './data';
import type { EligibleSlot, PlayData, TeamData } from './data/types';
import { InputManager, type InputFrame } from './input/input';
import { SceneView } from './render/view';
import { PlaySim, SIM_DT, type PlayEvent, type SimInput } from './play/sim';
import { chooseDefense, recordTendency } from './play/defenseCalls';
import { callTimeoutClock, snapClock, tickClock } from './game/clock';
import { afterPlay, checkQuarter, type Break } from './game/flow';
import { applyPlay, attemptFieldGoal, delayOfGame, punt, type RulesResult } from './game/rules';
import { newGame, other, type GameState } from './game/state';
import { simulateCpuDrive } from './game/cpuDrive';
import { loadSettings, saveSettings, type Settings } from './game/settings';
import { Hud } from './ui/hud';
import { TouchControls } from './ui/touch';
import { PlaycallScreen } from './ui/playcall';
import { Modal, boxScore, button, driveSummary, helpContent, scoreLine, settingsPanel, titleScreen } from './ui/menus';
import { h } from './ui/dom';

type Phase = 'title' | 'playcall' | 'presnap' | 'live' | 'postplay' | 'break' | 'gameover';

const POSTPLAY_TIME = 2.6;

export class App {
  private settings: Settings = loadSettings();
  private input = new InputManager();
  private view: SceneView;
  private hud = new Hud();
  private touch: TouchControls;
  private playcall: PlaycallScreen;
  private modal = new Modal();
  private game: GameState | null = null;
  private rng = new Rng(1);
  private sim: PlaySim | null = null;
  private play: PlayData | null = null;
  private phase: Phase = 'title';
  private paused = false;
  private gazeYaw = 0;
  private gazePitch = -0.06;
  private lockOn = false;
  private target: EligibleSlot | null = null;
  private acc = 0;
  private postTimer = 0;
  private bannerTimer = 0;
  private lastTime = 0;
  private playsRun = 0;

  constructor(canvas: HTMLCanvasElement, ui: HTMLElement) {
    this.view = new SceneView(canvas);
    this.touch = new TouchControls(this.input);
    this.playcall = new PlaycallScreen({
      onPlay: (p) => this.callPlay(p),
      onPunt: () => this.kick('punt'),
      onFieldGoal: () => this.kick('fg'),
      onTimeout: () => this.timeout(),
    });
    ui.append(this.touch.root, this.hud.root, this.playcall.root, this.modal.root,
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
    this.input.lookSensitivity = this.settings.lookSensitivity;
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
    const onField = p === 'presnap' || p === 'live' || p === 'postplay';
    this.touch.setVisible(onField);
    this.hud.root.classList.toggle('hidden', p === 'title');
  }

  private showTitle() {
    this.setPhase('title');
    this.sim = null;
    this.playcall.hide();
    this.modal.show(titleScreen(this.settings, this.updateSettings, () => this.startGame(), () => this.showHelp(() => this.showTitle())));
  }

  private showHelp(back: () => void) {
    this.modal.show(helpContent(), h('div', { class: 'row' }, button('BACK', back, 'primary')));
  }

  private startGame() {
    this.modal.hide();
    const seed = (Date.now() & 0x7fffffff) >>> 0;
    this.rng = new Rng(seed);
    this.game = newGame({
      home: this.settings.userTeam, away: this.settings.cpuTeam, userSide: 'home',
      difficulty: this.settings.difficulty, quarterLength: this.settings.quarterMinutes * 60, seed,
    });
    this.view.setTeams(this.userTeam, this.cpuTeam);
    this.playsRun = 0;
    this.enterPlaycall();
  }

  private get userTeam(): TeamData {
    return getTeam(this.game!.teams[this.game!.userSide]);
  }

  private get cpuTeam(): TeamData {
    return getTeam(this.game!.teams[other(this.game!.userSide)]);
  }

  private togglePause() {
    if (this.paused) {
      this.paused = false;
      this.modal.hide();
      return;
    }
    if (this.phase === 'title' || this.phase === 'break' || this.phase === 'gameover') return;
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

  private enterPlaycall() {
    const g = this.game!;
    if (g.over) return this.showGameOver();
    if (g.possession !== g.userSide) return this.runCpuDrive();
    this.setPhase('playcall');
    this.hud.showBanner(null);
    this.hud.setPlayName(null);
    this.hud.setHint(null);
    this.view.showRoutes(null);
    this.view.field.setMarkers(g.ballY, g.ballY + g.toGo);
    this.playcall.show(g);
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
      ballX: g.ballX, los: g.ballY, difficulty: diff, seed: this.rng.int(1, 2 ** 31 - 1),
    });
    this.view.bindPlay(this.sim, this.userTeam, this.cpuTeam);
    this.view.showRoutes(this.settings.showRoutes ? this.sim : null);
    this.view.field.setMarkers(g.ballY, g.ballY + g.toGo);
    this.view.field.showMarkers(true);
    this.gazeYaw = 0;
    this.gazePitch = -0.06;
    this.lockOn = false;
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
    const r = applyPlay(g, res);
    const st = { ...r.state, stats: { ...r.state.stats } };
    const side = g.userSide;
    const s = { ...st.stats[side] };
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
    st.stats[side] = s;
    const ap = afterPlay(st, r.stop);
    this.game = ap.state;
    this.handleBreak(ap.brk);
  }

  private handleBreak(brk: Break) {
    if (brk === 'gameover') return this.showGameOver();
    if (brk === 'none') return this.enterPlaycall();
    this.setPhase('break');
    this.playcall.hide();
    const g = this.game!;
    const title = brk === 'halftime' ? 'HALFTIME' : `END OF Q${g.clock.quarter - 1}`;
    this.modal.show(h('h2', {}, title), h('p', {}, scoreLine(g)), brk === 'halftime' ? boxScore(g) : '',
      h('div', { class: 'row' }, button('CONTINUE', () => {
        this.modal.hide();
        this.enterPlaycall();
      }, 'primary')));
  }

  private runCpuDrive() {
    const g = this.game!;
    const cpuSide = g.possession;
    const sum = simulateCpuDrive(g, DIFFICULTY[g.difficulty], this.rng);
    this.game = sum.state;
    this.setPhase('break');
    this.playcall.hide();
    this.view.field.showMarkers(false);
    this.modal.show(driveSummary(g, cpuSide, sum.entries, sum.headline), h('p', {}, scoreLine(this.game)),
      h('div', { class: 'row' }, button('CONTINUE', () => {
        this.modal.hide();
        if (sum.brk === 'gameover' || this.game!.over) return this.showGameOver();
        if (sum.brk === 'halftime') return this.handleBreak('halftime');
        this.enterPlaycall();
      }, 'primary')));
  }

  private kick(kind: 'punt' | 'fg') {
    const g = this.game!;
    if (this.phase !== 'playcall') return;
    this.playcall.hide();
    let live: GameState = { ...g, clock: tickClock(snapClock(g.clock), 6).clock };
    const r: RulesResult = kind === 'punt' ? punt(live, this.rng) : attemptFieldGoal(live, this.rng);
    live = r.state;
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

  // ------------------------------------------------------------ per-frame

  private frame(dt: number) {
    const f = this.input.poll(dt);
    if (f.pausePressed) this.togglePause();
    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0 && this.phase !== 'postplay') this.hud.showBanner(null);
    }

    if (!this.paused && this.game) {
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
      this.lockOn = false;
      this.gazeYaw += f.lookYaw;
      this.gazePitch += f.lookPitch;
    }
    if (f.slotPressed) {
      this.target = f.slotPressed;
      this.lockOn = true;
    }
    if (this.lockOn && this.target) {
      const qb = sim.get('QB').pos;
      const r = sim.get(this.target).pos;
      const want = Math.atan2(r.x - qb.x, r.y - qb.y);
      const d = want - this.gazeYaw;
      this.gazeYaw += Math.sign(d) * Math.min(Math.abs(d), 7 * dt);
      this.gazePitch += (-0.08 - this.gazePitch) * Math.min(1, dt * 6);
    }
    this.gazeYaw = Math.max(-1.9, Math.min(1.9, this.gazeYaw));
    this.gazePitch = Math.max(-0.6, Math.min(0.45, this.gazePitch));
  }

  private presnap(f: InputFrame, dt: number) {
    this.updateGaze(f, dt);
    this.touch.setPrimary('SNAP', 'snap');
    this.hud.setHint(this.playsRun < 3 ? 'Tap a receiver to target him, then SNAP. Left thumb moves the QB.' : null);
    if (f.primaryPressed) this.snap();
  }

  private simInput(f: InputFrame): SimInput {
    const sim = this.sim!;
    const qb = sim.get('QB');
    const controlsQB = sim.controlledId === qb.id;
    return {
      move: f.move,
      gazeYaw: this.gazeYaw,
      throwHeld: f.primaryHeld && controlsQB,
      target: this.target,
      handoff: f.slotPressed === 'RB',
      juke: f.primaryPressed && !sim.canThrow(),
    };
  }

  private live(f: InputFrame, dt: number) {
    const sim = this.sim!;
    this.updateGaze(f, dt);
    const inp = this.simInput(f);
    this.acc += dt;
    let first = true;
    while (this.acc >= SIM_DT) {
      sim.step(first ? inp : { ...inp, handoff: false, juke: false });
      first = false;
      this.acc -= SIM_DT;
      const t = tickClock(this.game!.clock, SIM_DT);
      this.game = { ...this.game!, clock: t.clock };
      this.onEvents(sim.drainEvents());
      if (sim.result) break;
    }
    this.updateLiveControls();
    if (sim.result) {
      this.setPhase('postplay');
      this.postTimer = 0;
      const r = sim.result;
      const headline = { noPlay: 'NO PLAY', touchdown: 'TOUCHDOWN!', interception: 'INTERCEPTED!', sack: 'SACKED!', safety: 'SAFETY!', incomplete: 'INCOMPLETE', outOfBounds: 'OUT OF BOUNDS', tackle: r.yards >= this.game!.toGo ? 'FIRST DOWN!' : 'DOWN' }[r.outcome];
      this.flash(headline, `${r.description} · vs ${r.defenseCall}`, POSTPLAY_TIME + 1);
    }
  }

  private onEvents(events: PlayEvent[]) {
    for (const e of events) {
      if (e.type === 'deflection') this.flash('BROKEN UP', '', 1);
      if (e.type === 'drop') this.flash('DROPPED', '', 1);
      if (e.type === 'brokenTackle') this.flash('BROKEN TACKLE', '', 0.7);
    }
  }

  private updateLiveControls() {
    const sim = this.sim!;
    const qb = sim.get('QB');
    const blocking = new Set<EligibleSlot>();
    for (const s of ['WR1', 'WR2', 'WR3', 'RB', 'TE'] as EligibleSlot[]) if (sim.get(s).route?.blocks) blocking.add(s);
    this.touch.setSlots(this.target, blocking);
    if (sim.canThrow()) {
      this.touch.setPrimary(sim.charging ? 'RELEASE' : 'THROW', 'throw');
      const info = sim.throwInfo(this.target);
      this.touch.setCharge(true, info.charge, info.window);
      this.hud.setHint(this.playsRun <= 3 && !sim.play.run ? 'Hold THROW, release in the green zone.' : null);
    } else {
      const carrier = sim.carrier;
      const userRuns = carrier && carrier.side === 'off' && sim.controlledId === carrier.id;
      this.touch.setPrimary(userRuns ? 'JUKE' : '', userRuns ? 'juke' : 'none');
      this.touch.setCharge(false, 0, null);
      this.hud.setHint(userRuns && this.playsRun <= 3 ? 'Steer with your left thumb · JUKE to dodge' : null);
    }
    this.hud.setPressure(sim.ball.holder === qb.id && !sim.result, sim.pressure);
  }

  private postplay(f: InputFrame, dt: number) {
    const sim = this.sim!;
    this.acc += dt;
    while (this.acc >= SIM_DT) {
      sim.step({ move: { x: 0, y: 0 }, gazeYaw: this.gazeYaw, throwHeld: false, target: null, handoff: false, juke: false });
      this.acc -= SIM_DT;
    }
    this.postTimer += dt;
    this.touch.setPrimary('NEXT', 'snap');
    this.touch.setCharge(false, 0, null);
    this.hud.setPressure(false, 0);
    this.hud.setHint(null);
    if (this.postTimer > POSTPLAY_TIME || (f.primaryPressed && this.postTimer > 0.4)) {
      this.hud.showBanner(null);
      this.finishPlay();
    }
  }

  private render(dt: number) {
    const g = this.game;
    if (g) this.hud.update(g);
    const onField = this.sim && (this.phase === 'presnap' || this.phase === 'live' || this.phase === 'postplay' || this.phase === 'playcall');
    if (onField && this.sim) {
      this.view.update(this.sim, this.phase === 'live' || this.phase === 'postplay' ? this.acc / SIM_DT : 1, this.paused ? 0 : dt, {
        gazeYaw: this.gazeYaw, gazePitch: this.gazePitch, target: this.target, cameraMode: this.settings.cameraMode,
        presnap: this.phase === 'presnap',
      });
      if (this.phase === 'playcall') this.view.field.setTargetRing(null, 0);
    } else {
      this.view.updateIdle(g ? g.ballX : 0, g ? g.ballY : 25, dt);
    }
    this.hud.setSituationVisible(this.phase !== 'title' && this.phase !== 'gameover');
    if (this.phase !== 'live') this.hud.setPressure(false, 0);
    this.view.render();
  }
}
