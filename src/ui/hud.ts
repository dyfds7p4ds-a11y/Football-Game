/** Scoreboard, situation strip, pressure meter, banner and hints. */
import { formatClock } from '../game/clock';
import { ballOnText, downText, type GameState, type TeamSide } from '../game/state';
import { getTeam } from '../data';
import { h } from './dom';

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
  readonly pauseBtn = h('button', { class: 'ghost' }, '❚❚');
  readonly timeoutBtn = h('button', { class: 'ghost' }, 'T/O');
  private last = '';

  constructor() {
    this.home.box.append(this.home.name, this.home.score);
    this.away.box.append(this.away.name, this.away.score);
    const mid = h('div', { class: 'mid' }, this.quarter, this.clock, this.playClock);
    const bug = h('div', { id: 'scorebug' }, this.home.box, mid, this.away.box);
    this.pressure.append(this.pressureFill);
    this.root = h('div', { id: 'hud' }, bug, this.situation, this.pressure, this.pressureLabel, this.banner, this.playName, this.hint,
      h('div', { id: 'topleft' }, this.pauseBtn, this.timeoutBtn));
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
