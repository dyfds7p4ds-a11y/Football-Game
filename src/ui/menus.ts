/** Title screen, settings, pause, drive summaries and other modal panels. */
import { DIFFICULTY, TEAMS, getTeam } from '../data';
import type { Difficulty } from '../data/types';
import type { Settings } from '../game/settings';
import type { DriveEntry } from '../game/cpuDrive';
import type { GameState, TeamSide } from '../game/state';
import { h, onTap } from './dom';

export class Modal {
  readonly root = h('div', { class: 'overlay hidden', id: 'modal' });

  show(...children: (Node | string)[]) {
    this.root.replaceChildren(h('div', { class: 'panel' }, ...children));
    this.root.classList.remove('hidden');
  }

  hide() {
    this.root.classList.add('hidden');
    this.root.replaceChildren();
  }

  get visible() {
    return !this.root.classList.contains('hidden');
  }
}

export function button(label: string, fn: () => void, cls = ''): HTMLButtonElement {
  const b = h('button', { class: cls }, label);
  onTap(b, fn);
  return b;
}

function segmented<T extends string | number>(options: { value: T; label: string }[], current: T, onChange: (v: T) => void) {
  const wrap = h('div', { class: 'seg' });
  const render = (cur: T) => {
    wrap.replaceChildren(
      ...options.map((o) => {
        const b = h('button', { class: o.value === cur ? 'on' : '' }, o.label);
        onTap(b, () => {
          onChange(o.value);
          render(o.value);
        });
        return b;
      }),
    );
  };
  render(current);
  return wrap;
}

const row = (label: string, control: Node, note = '') =>
  h('div', { class: 'field-row' }, h('div', {}, h('label', {}, label), note ? h('div', { style: { fontSize: '12px', opacity: '0.7' } }, note) : null), control);

export function settingsPanel(s: Settings, onChange: (s: Settings) => void, inGame: boolean): HTMLElement {
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => {
    s = { ...s, [k]: v };
    onChange(s);
  };
  const diffNote: Record<Difficulty, string> = {
    easy: 'Slow reactions, loose coverage, soft pass rush, wide throw window.',
    normal: 'Balanced.',
    hard: 'Quick reads, tight coverage, heavy pass rush, narrow throw window.',
  };
  const note = h('div', { style: { fontSize: '12px', opacity: '0.7' } }, diffNote[s.difficulty]);
  return h('div', {},
    row('CPU difficulty', h('div', {},
      segmented((Object.keys(DIFFICULTY) as Difficulty[]).map((d) => ({ value: d, label: DIFFICULTY[d].label.toUpperCase() })), s.difficulty, (v) => {
        set('difficulty', v);
        note.textContent = diffNote[v];
      }), note)),
    row('Quarter length', segmented([3, 5, 8, 12, 15].map((m) => ({ value: m, label: `${m} MIN` })), s.quarterMinutes, (v) => set('quarterMinutes', v)),
      inGame ? 'Applies to the next game.' : ''),
    row('Camera', segmented([{ value: 'firstPerson', label: 'QB EYES' }, { value: 'behindQB', label: 'BEHIND QB' }] as const, s.cameraMode, (v) => set('cameraMode', v))),
    row('Show routes before snap', segmented([{ value: 1, label: 'ON' }, { value: 0, label: 'OFF' }], s.showRoutes ? 1 : 0, (v) => set('showRoutes', v === 1))),
    row('Retro pixels', segmented([{ value: 1, label: 'ON' }, { value: 0, label: 'OFF' }], s.retroPixels ? 1 : 0, (v) => set('retroPixels', v === 1)),
      'Chunky low-res rendering; also faster on older iPads.'),
    row('Look sensitivity', segmented([0.6, 1, 1.5, 2].map((v) => ({ value: v, label: `${v}x` })), s.lookSensitivity, (v) => set('lookSensitivity', v))),
  );
}

export function titleScreen(s: Settings, onChange: (s: Settings) => void, onStart: () => void, onHelp: () => void): HTMLElement {
  const teamGrid = (key: 'userTeam' | 'cpuTeam') => {
    const wrap = h('div', { class: 'teams' });
    const render = () =>
      wrap.replaceChildren(
        ...TEAMS.map((t) => {
          const chip = h('div', {
            class: `teamchip ${s[key] === t.id ? 'on' : ''}`,
            style: { background: t.colors.primary, color: t.colors.secondary, opacity: (key === 'userTeam' ? s.cpuTeam : s.userTeam) === t.id ? '0.35' : '1' },
          }, `${t.city} ${t.name}`);
          onTap(chip, () => {
            const otherKey = key === 'userTeam' ? 'cpuTeam' : 'userTeam';
            if (s[otherKey] === t.id) return;
            s = { ...s, [key]: t.id };
            onChange(s);
            renderAll();
          });
          return chip;
        }),
      );
    return { wrap, render };
  };
  const you = teamGrid('userTeam');
  const cpu = teamGrid('cpuTeam');
  const renderAll = () => {
    you.render();
    cpu.render();
  };
  renderAll();
  return h('div', {},
    h('div', { class: 'title-art' }, 'GRIDIRON', h('br'), 'QB'),
    h('p', {}, 'First-person American football. You are the quarterback.'),
    h('div', { class: 'row', style: { marginBottom: '16px' } }, button('KICK OFF', onStart, 'primary'), button('HOW TO PLAY', onHelp)),
    h('h2', {}, 'YOUR TEAM'), you.wrap,
    h('h2', { style: { marginTop: '14px' } }, 'OPPONENT (CPU)'), cpu.wrap,
    h('div', { style: { marginTop: '14px' } }, settingsPanel(s, (n) => {
      s = { ...n, userTeam: s.userTeam, cpuTeam: s.cpuTeam };
      onChange(s);
    }, false)),
  );
}

export function helpContent(): HTMLElement {
  return h('div', {},
    h('h2', {}, 'HOW TO PLAY'),
    h('ul', {},
      h('li', {}, 'Pick a play. The defense picks a coverage you will have to read.'),
      h('li', {}, 'Press SNAP. Put your LEFT thumb anywhere on the left half: an invisible joystick appears. Pull down to drop back, push to scramble.'),
      h('li', {}, 'Tap a receiver button (1, 2, 3, RB, TE) to look at him and target him. Drag on the right half of the screen to look around.'),
      h('li', {}, 'HOLD THROW to charge, RELEASE inside the green zone of the meter. Under-charged balls float short, over-charged balls sail. Throw early to a receiver who is about to be open: the ball leads him.'),
      h('li', {}, 'The pocket meter on the left shows pressure. Holding the ball too long gets you sacked; pressure also costs accuracy.'),
      h('li', {}, 'Run plays hand off automatically; then steer the runner. Press JUKE to dodge a tackle. Tap RB when he is next to you to hand off on any play; hold THROW on a run play to keep it yourself.'),
      h('li', {}, 'Clock: 40-second play clock (delay of game = 5 yards). The game clock stops on incompletions, out of bounds, scores and turnovers.'),
    ),
    h('h2', {}, 'KEYBOARD / GAMEPAD'),
    h('p', {}, 'Keyboard: WASD/arrows move · 1 2 3 = WR · 4 or R = RB · 5 or T = TE · SPACE snap/throw/juke · Q/E look · O timeout · P/Esc pause.'),
    h('p', {}, 'Gamepad: left stick move · right stick look · A or RT snap/throw/juke · X=1 Y=2 B=3 LB=RB RB=TE · Start pause · Back timeout.'),
  );
}

export function driveSummary(s: GameState, side: TeamSide, entries: DriveEntry[], headline: string): HTMLElement {
  const t = getTeam(s.teams[side]);
  return h('div', {},
    h('h2', {}, `${t.city.toUpperCase()} ${t.name.toUpperCase()} DRIVE`),
    h('p', { style: { opacity: '0.8' } }, 'You will play defense in Phase 2. For now the CPU drive is simulated:'),
    h('ol', { class: 'drive' }, ...entries.map((e) => h('li', {}, h('span', { class: 'sit' }, `${e.clock} · ${e.situation}  `), e.text))),
    h('h2', { style: { color: '#fff' } }, headline),
  );
}

export function scoreLine(s: GameState): string {
  const home = getTeam(s.teams.home);
  const away = getTeam(s.teams.away);
  return `${home.abbr} ${s.score.home} – ${s.score.away} ${away.abbr}`;
}

export function boxScore(s: GameState): HTMLElement {
  const sides: TeamSide[] = ['home', 'away'];
  const cell = (t: string) => h('td', { style: { padding: '4px 10px' } }, t);
  return h('table', { style: { borderCollapse: 'collapse', margin: '10px 0' } },
    h('tr', {}, cell(''), ...sides.map((sd) => cell(getTeam(s.teams[sd]).abbr))),
    h('tr', {}, cell('Points'), ...sides.map((sd) => cell(String(s.score[sd])))),
    h('tr', {}, cell('Passing'), ...sides.map((sd) => cell(`${s.stats[sd].passComp}/${s.stats[sd].passAtt}, ${s.stats[sd].passYds} yds`))),
    h('tr', {}, cell('Rushing'), ...sides.map((sd) => cell(`${s.stats[sd].rushAtt} for ${s.stats[sd].rushYds}`))),
    h('tr', {}, cell('Sacks taken'), ...sides.map((sd) => cell(String(s.stats[sd].sacks)))),
    h('tr', {}, cell('Turnovers'), ...sides.map((sd) => cell(String(s.stats[sd].turnovers)))),
  );
}
