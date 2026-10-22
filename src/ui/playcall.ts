/** Play-calling screen: filterable play cards with route diagrams. */
import { FORMATIONS, PLAYS } from '../data';
import type { EligibleSlot, PlayCategory, PlayData } from '../data/types';
import { ELIGIBLE, OFF_SLOTS } from '../data/types';
import { buildRoute } from '../play/routes';
import { DEFENSE_CALLS, type DefenseCall } from '../play/defenseCalls';
import { fieldGoalDistance, fieldGoalProbability } from '../game/rules';
import type { GameState } from '../game/state';
import { downText, ballOnText } from '../game/state';
import { formatClock } from '../game/clock';
import { h, onTap } from './dom';

const TABS: { id: PlayCategory | 'all'; label: string }[] = [
  { id: 'all', label: 'ALL' }, { id: 'run', label: 'RUN' }, { id: 'short', label: 'SHORT' }, { id: 'medium', label: 'MEDIUM' },
  { id: 'deep', label: 'DEEP' }, { id: 'screen', label: 'SCREEN' }, { id: 'playaction', label: 'PLAY ACTION' },
];
const SLOT_COLOR: Record<EligibleSlot, string> = { WR1: '#ffd23f', WR2: '#4ea8ff', WR3: '#ff8c42', RB: '#f1faee', TE: '#c77dff' };

export interface PlaycallHandlers {
  onPlay: (play: PlayData) => void;
  onPunt: () => void;
  onFieldGoal: () => void;
  onTimeout: () => void;
  /** Defense: the user's call (null = let the coordinator call it). */
  onDefense: (call: DefenseCall | null) => void;
}

const SHELL_NOTE: Record<DefenseCall['shell'], string> = {
  cover0: 'All-out pressure, man everywhere, no deep help. Big risk, big reward.',
  cover1: 'Man coverage with one deep safety over the top.',
  cover2: 'Two deep safeties, corners squat on the flats.',
  cover3: 'Three deep, four underneath. Safe against the deep ball.',
  cover2man: 'Man underneath, two safeties deep. Tight coverage, light rush.',
};

/** What the user's cornerbacks do in this call, e.g. "CB1 man WR1 · CB2 deep third". */
function cornerNote(call: DefenseCall): string {
  const what = (slot: 'CB1' | 'CB2' | 'NB') => {
    const a = call.assignments[slot];
    return a.kind === 'man' ? `man ${a.target}` : a.kind === 'zone' ? `zone ${a.zone}` : a.kind;
  };
  return `CB1 ${what('CB1')} · CB2 ${what('CB2')} · NB ${what('NB')}`;
}

export class PlaycallScreen {
  readonly root: HTMLElement;
  private grid = h('div', { class: 'cards' });
  private tabs = h('div', { class: 'tabs' });
  private header = h('div', { class: 'row' });
  private clockEl = h('span', { style: { fontFamily: 'var(--font)', fontSize: '14px' } });
  private puntBtn = h('button', {}, 'PUNT');
  private fgBtn = h('button', {}, 'FIELD GOAL');
  private toBtn = h('button', { class: 'ghost' }, 'TIMEOUT');
  private filter: PlayCategory | 'all' = 'all';
  private defense = false;

  constructor(private handlers: PlaycallHandlers) {
    for (const t of TABS) {
      const b = h('button', {}, t.label);
      onTap(b, () => {
        this.filter = t.id;
        this.renderCards();
      });
      this.tabs.append(b);
    }
    onTap(this.puntBtn, handlers.onPunt);
    onTap(this.fgBtn, handlers.onFieldGoal);
    onTap(this.toBtn, handlers.onTimeout);
    this.root = h('div', { class: 'overlay hidden', id: 'playcall' },
      this.header,
      h('div', { class: 'row' }, this.tabs, h('div', { class: 'spacer' }), this.puntBtn, this.fgBtn, this.toBtn),
      h('div', { class: 'scroll' }, this.grid));
    this.renderCards();
  }

  show(s: GameState) {
    this.defense = false;
    this.tabs.classList.remove('hidden');
    this.renderCards();
    this.root.classList.remove('hidden');
    this.update(s);
  }

  /** Defensive play call: coverage cards (the CPU calls its offensive play). */
  showDefense(s: GameState) {
    this.defense = true;
    this.tabs.classList.add('hidden');
    const auto = h('div', { class: 'card' },
      h('div', { class: 'row' }, h('span', { class: 'name' }, 'Coordinator\'s Call')),
      h('span', { class: 'tag run' }, 'auto'),
      h('div', { class: 'desc' }, 'Let the defensive coordinator read the situation and call it.'));
    onTap(auto, () => this.handlers.onDefense(null));
    this.grid.replaceChildren(auto, ...DEFENSE_CALLS.map((c) => {
      const card = h('div', { class: 'card' },
        h('div', { class: 'row' }, h('span', { class: 'name' }, c.name)),
        h('span', { class: 'tag deep' }, c.shell.replace('cover', 'cover ').replace('2man', '2 man')),
        h('div', { class: 'desc' }, SHELL_NOTE[c.shell]),
        h('div', { class: 'desc', style: { opacity: '0.7' } }, cornerNote(c)));
      let startY = 0;
      card.addEventListener('pointerdown', (e) => (startY = e.clientY));
      card.addEventListener('pointerup', (e) => {
        if (Math.abs(e.clientY - startY) < 12) this.handlers.onDefense(c);
      });
      return card;
    }));
    this.root.classList.remove('hidden');
    this.update(s);
  }

  hide() {
    this.root.classList.add('hidden');
  }

  get visible() {
    return !this.root.classList.contains('hidden');
  }

  update(s: GameState) {
    const dist = fieldGoalDistance(s.ballY);
    const pct = Math.round(fieldGoalProbability(dist) * 100);
    this.fgBtn.textContent = `FG ${dist}y (${pct}%)`;
    this.fgBtn.disabled = dist > 62 || this.defense;
    this.puntBtn.disabled = s.ballY > 65 || this.defense;
    this.fgBtn.classList.toggle('hidden', this.defense);
    this.puntBtn.classList.toggle('hidden', this.defense);
    this.toBtn.textContent = `TIMEOUT (${s.timeouts[s.userSide]})`;
    this.toBtn.disabled = s.timeouts[s.userSide] <= 0;
    const pc = Math.ceil(s.clock.playClock);
    this.clockEl.textContent = `PLAY CLOCK :${String(pc).padStart(2, '0')}`;
    this.clockEl.style.color = pc <= 10 ? '#e63946' : '#ffd23f';
    const title = `${this.defense ? 'CPU ball · ' : ''}${downText(s)} · ${ballOnText(s.ballY)} · Q${s.clock.quarter} ${formatClock(s.clock.remaining)}`;
    if (this.header.dataset.title !== title) {
      this.header.dataset.title = title;
      this.header.replaceChildren(h('h2', {}, this.defense ? 'CALL A DEFENSE' : 'CALL A PLAY'), h('span', { style: { opacity: '0.85' } }, title), h('div', { class: 'spacer' }), this.clockEl);
    }
  }

  private renderCards() {
    [...this.tabs.children].forEach((b, i) => b.classList.toggle('on', TABS[i].id === this.filter));
    this.grid.replaceChildren(
      ...PLAYS.filter((p) => this.filter === 'all' || p.category === this.filter).map((p) => {
        const card = h('div', { class: 'card' },
          h('div', { class: 'row' }, h('span', { class: 'name' }, p.name)),
          h('span', { class: `tag ${p.category}` }, p.category === 'playaction' ? 'play action' : p.category),
          drawDiagram(p),
          h('div', { class: 'desc' }, p.description));
        let startY = 0;
        card.addEventListener('pointerdown', (e) => (startY = e.clientY));
        card.addEventListener('pointerup', (e) => {
          if (Math.abs(e.clientY - startY) < 12) this.handlers.onPlay(p);
        });
        return card;
      }),
    );
  }
}

/** Mini chalkboard of the play's formation and routes. */
export function drawDiagram(p: PlayData): HTMLCanvasElement {
  const W = 360;
  const H = 200;
  const c = h('canvas', { width: W, height: H });
  const g = c.getContext('2d')!;
  g.fillStyle = '#3f8a2e';
  g.fillRect(0, 0, W, H);
  const sx = (x: number) => W / 2 + x * (W / 54);
  const sy = (y: number) => H - 40 - y * 6.2;
  g.strokeStyle = 'rgba(255,255,255,0.35)';
  g.lineWidth = 1;
  for (let y = -5; y <= 25; y += 5) {
    g.beginPath();
    g.moveTo(0, sy(y));
    g.lineTo(W, sy(y));
    g.stroke();
  }
  g.strokeStyle = '#4ea8ff';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(0, sy(0));
  g.lineTo(W, sy(0));
  g.stroke();

  const f = FORMATIONS[p.formation];
  g.lineWidth = 3;
  g.lineJoin = 'round';
  for (const slot of ELIGIBLE) {
    const [dx, dy] = f[slot];
    const start = { x: dx, y: dy };
    const color = SLOT_COLOR[slot];
    g.strokeStyle = color;
    g.fillStyle = color;
    if (p.run && slot === 'RB') {
      const aim = p.run.aim;
      const pts = p.run.style === 'toss' ? [start, { x: aim * 0.55, y: -4.5 }, { x: aim, y: -1.5 }, { x: aim + Math.sign(aim), y: 10 }] : [start, { x: f.QB[0] + Math.sign(aim || 1) * 0.5, y: f.QB[1] }, { x: aim, y: 0.5 }, { x: aim * 1.15, y: 10 }];
      polyline(g, pts.map((q) => [sx(q.x), sy(q.y)]), true);
      continue;
    }
    const r = buildRoute(p.routes[slot], start, 0);
    if (r.blocks) {
      g.beginPath();
      g.moveTo(sx(dx), sy(dy));
      g.lineTo(sx(dx), sy(dy + 1.5));
      g.moveTo(sx(dx) - 6, sy(dy + 1.5));
      g.lineTo(sx(dx) + 6, sy(dy + 1.5));
      g.stroke();
      continue;
    }
    const pts = [start, ...r.points.map((q) => ({ x: q.x, y: Math.min(q.y, 22) }))];
    polyline(g, pts.map((q) => [sx(q.x), sy(q.y)]), r.continues);
  }
  for (const slot of OFF_SLOTS) {
    const [dx, dy] = f[slot];
    const isElig = (ELIGIBLE as readonly string[]).includes(slot);
    g.fillStyle = isElig ? SLOT_COLOR[slot as EligibleSlot] : '#f4f1de';
    g.strokeStyle = '#101418';
    g.lineWidth = 2;
    g.beginPath();
    if (slot === 'C') g.rect(sx(dx) - 5, sy(dy) - 5, 10, 10);
    else g.arc(sx(dx), sy(dy), 5.5, 0, Math.PI * 2);
    g.fill();
    g.stroke();
  }
  if (p.playAction) {
    g.fillStyle = '#fff';
    g.font = 'bold 14px sans-serif';
    g.fillText('PA', 8, 20);
  }
  return c;
}

function polyline(g: CanvasRenderingContext2D, pts: number[][], arrow: boolean) {
  g.beginPath();
  g.moveTo(pts[0][0], pts[0][1]);
  for (const p of pts.slice(1)) g.lineTo(p[0], p[1]);
  g.stroke();
  const [a, b] = [pts[pts.length - 2], pts[pts.length - 1]];
  if (!a || !b) return;
  const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
  g.beginPath();
  if (arrow) {
    g.moveTo(b[0], b[1]);
    g.lineTo(b[0] - 9 * Math.cos(ang - 0.45), b[1] - 9 * Math.sin(ang - 0.45));
    g.lineTo(b[0] - 9 * Math.cos(ang + 0.45), b[1] - 9 * Math.sin(ang + 0.45));
    g.closePath();
    g.fill();
  } else {
    g.arc(b[0], b[1], 4, 0, Math.PI * 2);
    g.fill();
  }
}
