/** Scoreboard, situation strip, pressure meter, banner and hints. */
import { formatClock } from '../game/clock';
import { ballOnText, downText, type GameState, type TeamSide } from '../game/state';
import { getTeam } from '../data';
import type { EligibleSlot } from '../data/types';
import { h } from './dom';

export interface EdgeMarker {
  slot: EligibleSlot;
  label: string;
  color: string;
  x: number;
  y: number;
  onScreen: boolean;
  selected: boolean;
}

export interface KickMeterView {
  title: string;
  /** 0..1 meter fill and the timing zone. */
  power: number;
  zone: { center: number; halfWidth: number };
  /** Punt only: needle angle and ideal-angle zone (degrees) inside [min, max]. */
  angle?: { value: number; min: number; max: number; ideal: number; halfWidth: number };
  sub?: string;
}

export class Hud {
  readonly root: HTMLElement;
  private home = { name: h('span'), score: h('span', { class: 'score' }), box: h('div', { class: 'team' }) };
  private away = { name: h('span'), score: h('span', { class: 'score' }), box: h('div', { class: 'team' }) };
  private quarter = h('span');
  private clock = h('span');
  private playClock = h('span', { class: 'pc' });
  private situation = h('div', { id: 'situation' });
  private pressure = h('div', { id: 'pressure' });
  private pressureFill = h('div', { class: 'fill' });
  private pressureLabel = h('div', { id: 'pressure-label' }, 'POCKET');
  private banner = h('div', { id: 'banner', class: 'hidden' });
  private playName = h('div', { id: 'playname', class: 'hidden' });
  private hint = h('div', { id: 'hint', class: 'hidden' });
  private crowd = h('div', { id: 'crowd' });
  private crowdFill = h('div', { class: 'fill' });
  private cues = { left: h('div', { class: 'cue left' }), right: h('div', { class: 'cue right' }), back: h('div', { class: 'cue back' }) };
  private edges = h('div', { id: 'edges' });
  private edgeEls = new Map<EligibleSlot, HTMLElement>();
  private callout = h('div', { id: 'callout', class: 'hidden' });
  private calloutTimer = 0;
  private kick = h('div', { id: 'kickmeter', class: 'hidden' });
  private kickFill = h('div', { class: 'fill' });
  private kickZone = h('div', { class: 'zone' });
  private kickTitle = h('div', { class: 'title' });
  private kickSub = h('div', { class: 'sub' });
  private angle = h('div', { class: 'angle' });
  private angleZone = h('div', { class: 'azone' });
  private angleNeedle = h('div', { class: 'needle' });
  readonly pauseBtn = h('button', { class: 'ghost' }, '❚❚');
  readonly timeoutBtn = h('button', { class: 'ghost' }, 'T/O');
  private last = '';

  constructor() {
    this.home.box.append(this.home.name, this.home.score);
    this.away.box.append(this.away.name, this.away.score);
    const mid = h('div', { class: 'mid' }, this.quarter, this.clock, this.playClock);
    const bug = h('div', { id: 'scorebug' }, this.home.box, mid, this.away.box);
    this.pressure.append(this.pressureFill);
    this.crowd.append(h('span', {}, 'CROWD'), h('div', { class: 'bar' }, this.crowdFill));
    this.angle.append(this.angleZone, this.angleNeedle);
    this.kick.append(this.kickTitle, h('div', { class: 'row' }, h('div', { class: 'power' }, this.kickZone, this.kickFill), this.angle), this.kickSub);
    this.root = h('div', { id: 'hud' }, this.cues.left, this.cues.right, this.cues.back, this.edges, bug, this.crowd, this.situation,
      this.pressure, this.pressureLabel, this.banner, this.callout, this.kick, this.playName, this.hint,
      h('div', { id: 'topleft' }, this.pauseBtn, this.timeoutBtn));
  }

  /** Crowd pulse 0..100. */
  setCrowd(value: number, visible: boolean) {
    this.crowd.classList.toggle('hidden', !visible);
    this.crowdFill.style.width = `${Math.round(value)}%`;
    this.crowdFill.style.background = value > 75 ? '#ff8c42' : value > 55 ? '#ffd23f' : '#8ecae6';
  }

  /**
   * Pocket cue: a soft red glow at the screen edge on the side a free rusher
   * is closing from. `rel` is the rusher's direction relative to the QB's gaze
   * (0 = straight ahead, + = right); null hides it.
   */
  setPocketCue(rel: number | null, level: number) {
    let l = 0;
    let r = 0;
    let b = 0;
    if (rel !== null && level > 0.05) {
      const a = Math.atan2(Math.sin(rel), Math.cos(rel));
      if (Math.abs(a) > 2.2) b = level;
      else if (a > 0.45) r = level;
      else if (a < -0.45) l = level;
    }
    this.cues.left.style.opacity = String(l * 0.9);
    this.cues.right.style.opacity = String(r * 0.9);
    this.cues.back.style.opacity = String(b * 0.9);
  }

  /** Off-screen receiver arrows at the screen edge (on-screen receivers use their 3D labels). */
  setEdgeMarkers(markers: EdgeMarker[] | null) {
    this.edges.classList.toggle('hidden', !markers);
    if (!markers) return;
    const w = window.innerWidth;
    const hh = window.innerHeight;
    for (const m of markers) {
      let el = this.edgeEls.get(m.slot);
      if (!el) {
        el = h('div', { class: 'edge' });
        this.edgeEls.set(m.slot, el);
        this.edges.append(el);
      }
      el.classList.toggle('hidden', m.onScreen);
      if (m.onScreen) continue;
      const pad = 44;
      const x = Math.min(w - pad, Math.max(pad, m.x));
      const y = Math.min(hh - 120, Math.max(110, m.y));
      el.textContent = `${m.x < w / 2 ? '◀' : '▶'} ${m.label}`;
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.style.background = m.color;
      el.classList.toggle('selected', m.selected);
    }
  }

  /** Short penalty call-out (yellow), auto-hides. */
  showCallout(title: string, sub: string, secs = 2.2) {
    this.callout.replaceChildren(h('b', {}, title), h('small', {}, sub));
    this.callout.classList.remove('hidden');
    this.calloutTimer = secs;
  }

  tick(dt: number) {
    if (this.calloutTimer > 0) {
      this.calloutTimer -= dt;
      if (this.calloutTimer <= 0) this.callout.classList.add('hidden');
    }
  }

  setKickMeter(k: KickMeterView | null) {
    this.kick.classList.toggle('hidden', !k);
    if (!k) return;
    this.kickTitle.textContent = k.title;
    this.kickSub.textContent = k.sub ?? '';
    this.kickFill.style.height = `${Math.round(k.power * 100)}%`;
    const inZone = Math.abs(k.power - k.zone.center) <= k.zone.halfWidth;
    this.kickFill.style.background = inZone ? '#52b788' : '#f4f1de';
    this.kickZone.style.bottom = `${Math.max(0, k.zone.center - k.zone.halfWidth) * 100}%`;
    this.kickZone.style.height = `${Math.min(1, 2 * k.zone.halfWidth) * 100}%`;
    this.angle.classList.toggle('hidden', !k.angle);
    if (k.angle) {
      // The needle shows the real launch angle (0 deg = flat, to the right).
      const a = k.angle;
      this.angleNeedle.style.transform = `rotate(${-a.value}deg)`;
      const from = 90 - (a.ideal + a.halfWidth);
      this.angleZone.style.background = `conic-gradient(from ${from}deg at 0% 100%, rgba(82,183,136,0.85) 0deg ${2 * a.halfWidth}deg, transparent ${2 * a.halfWidth}deg)`;
    }
  }

  update(s: GameState) {
    const key = [s.score.home, s.score.away, s.possession, s.clock.quarter, Math.ceil(s.clock.remaining), Math.ceil(s.clock.playClock),
      s.clock.playClockRunning, s.down, s.toGo, s.ballY, s.timeouts[s.userSide]].join('|');
    if (key === this.last) return;
    this.last = key;
    for (const side of ['home', 'away'] as TeamSide[]) {
      const t = getTeam(s.teams[side]);
      const el = this[side];
      el.box.style.background = t.colors.primary;
      el.name.textContent = t.abbr;
      el.score.textContent = String(s.score[side]);
      el.box.classList.toggle('poss', s.possession === side);
    }
    this.quarter.textContent = s.clock.quarter > 4 ? 'FINAL' : `Q${s.clock.quarter}`;
    this.clock.textContent = formatClock(s.clock.remaining);
    const pc = Math.ceil(s.clock.playClock);
    this.playClock.textContent = s.clock.playClockRunning ? `:${String(pc).padStart(2, '0')}` : '';
    this.playClock.classList.toggle('low', pc <= 10);
    this.situation.textContent = `${downText(s)}  ·  BALL ON ${ballOnText(s.ballY)}`;
    this.timeoutBtn.textContent = `T/O ${s.timeouts[s.userSide]}`;
  }

  setPressure(visible: boolean, p: number) {
    this.pressure.classList.toggle('hidden', !visible);
    this.pressureLabel.classList.toggle('hidden', !visible);
    if (!visible) return;
    this.pressureFill.style.height = `${Math.round(p * 100)}%`;
    this.pressureFill.style.background = p > 0.66 ? '#e63946' : p > 0.33 ? '#ffb703' : '#52b788';
  }

  showBanner(text: string | null, sub = '') {
    this.banner.classList.toggle('hidden', !text);
    if (!text) return;
    this.banner.replaceChildren(text, ...(sub ? [h('small', {}, sub)] : []));
  }

  setPlayName(text: string | null) {
    this.playName.classList.toggle('hidden', !text);
    if (text) this.playName.textContent = text;
  }

  setHint(text: string | null) {
    this.hint.classList.toggle('hidden', !text);
    if (text && this.hint.textContent !== text) this.hint.textContent = text;
  }

  setSituationVisible(v: boolean) {
    this.situation.classList.toggle('hidden', !v);
  }
}
