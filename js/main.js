'use strict';
// Spielablauf: Menüs, Downs, Uhr, CPU-Playcalling, Eingabe

const QUARTER_LEN = 150; // Sekunden Spielzeit pro Viertel

const canvas = document.getElementById('screen');
const ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;

const TEAM_OBJS = TEAMS.map(buildTeam);

const G = {
  state: 'title', teamSel: 0, t: 0, timer: 0,
  user: null, cpu: null, score: { user: 0, cpu: 0 },
  quarter: 1, clock: QUARTER_LEN, poss: 'user', firstPoss: 'user',
  los: 25, down: 1, toGo: 10,
  play: null, kick: null, cam: 40, camY: CY, acc: 0,
  menu: { row: 0, col: 0 }, cpuOff: null,
  queue: [], after: null, hits: [],
  rosterTeam: null, rosterTab: 0, rosterBack: 'title', helpBack: 'title',
  stats: null,
};

const other = (w) => (w === 'user' ? 'cpu' : 'user');
const teamOf = (w) => (w === 'user' ? G.user : G.cpu);

// ---------- Eingabe ----------
const keys = new Set();
const pressed = new Set();
const touch = { dir: { x: 0, y: 0 }, tapThrow: 0 };

window.addEventListener('keydown', (e) => {
  Sound.init();
  if (!keys.has(e.code)) pressed.add(e.code);
  keys.add(e.code);
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

const hit = (...codes) => codes.some((c) => pressed.has(c));
const ACTION = ['Space', 'Enter', 'NumpadEnter', 'TouchA'];
const BACK = ['Escape', 'Backspace', 'TouchB'];

function inputDir() {
  let x = 0, y = 0;
  if (keys.has('ArrowLeft') || keys.has('KeyA')) x -= 1;
  if (keys.has('ArrowRight') || keys.has('KeyD')) x += 1;
  if (keys.has('ArrowUp') || keys.has('KeyW')) y -= 1;
  if (keys.has('ArrowDown') || keys.has('KeyS')) y += 1;
  if (!x && !y) { x = touch.dir.x; y = touch.dir.y; }
  return { x, y };
}

function throwKeyPressed() {
  for (let i = 1; i <= 5; i++) if (hit('Digit' + i, 'Numpad' + i)) return i;
  return touch.tapThrow;
}

function canvasPos(e) {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) * W / r.width, y: (e.clientY - r.top) * H / r.height };
}

canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse') return;
  const p = canvasPos(e);
  for (const h of G.hits) if (h.hover && inRect(p, h)) h.hover();
});
canvas.addEventListener('pointerdown', (e) => {
  Sound.init();
  const p = canvasPos(e);
  for (const h of G.hits) {
    if (inRect(p, h)) {
      if (e.pointerType === 'mouse' || !h.hover || h.selected) h.fn();
      else { h.hover(); Sound.play('menu'); }
      return;
    }
  }
  // Tippen auf einen Receiver = Pass
  const P = G.play;
  if (G.state === 'live' && P && P.userOff) {
    let best = 0, bd = 4;
    ELIGIBLE.forEach((role, i) => {
      const r = P.byRole[role];
      const d = Math.hypot(wx(r.x, G.cam) - p.x, wy(r.y) - p.y) / SCALE;
      if (d < bd) { bd = d; best = i + 1; }
    });
    if (best) touch.tapThrow = best;
    else pressed.add('TouchA');
  } else if (G.state === 'presnap' || G.state === 'result' || G.state === 'gameover' || G.state === 'live') {
    pressed.add('TouchA');
  }
});

function inRect(p, r) { return p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h; }

// Touch-Steuerung (Joystick + Buttons)
(function setupTouch() {
  const pad = document.getElementById('touch');
  if (!pad) return;
  const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  if (coarse) document.body.classList.add('touch');
  const stick = document.getElementById('stick');
  const knob = document.getElementById('knob');
  let sid = null;
  const upd = (e) => {
    const r = stick.getBoundingClientRect();
    let dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    const m = Math.hypot(dx, dy), max = r.width / 2;
    if (m > max) { dx = dx / m * max; dy = dy / m * max; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    if (m < max * 0.25) { touch.dir = { x: 0, y: 0 }; return; }
    const a = Math.atan2(dy, dx);
    const oct = Math.round(a / (Math.PI / 4)) * (Math.PI / 4);
    touch.dir = { x: Math.round(Math.cos(oct) * 100) / 100, y: Math.round(Math.sin(oct) * 100) / 100 };
    // für Menüs: Richtung als Tastendruck
    const code = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'ArrowRight' : 'ArrowLeft') : (dy > 0 ? 'ArrowDown' : 'ArrowUp');
    if (stick.lastCode !== code) { stick.lastCode = code; if (G.state !== 'live' && G.state !== 'presnap') pressed.add(code); }
  };
  stick.addEventListener('pointerdown', (e) => { Sound.init(); sid = e.pointerId; stick.setPointerCapture(sid); upd(e); });
  stick.addEventListener('pointermove', (e) => { if (e.pointerId === sid) upd(e); });
  const end = (e) => {
    if (e.pointerId !== sid) return;
    sid = null; stick.lastCode = null;
    touch.dir = { x: 0, y: 0 };
    knob.style.transform = '';
  };
  stick.addEventListener('pointerup', end);
  stick.addEventListener('pointercancel', end);
  for (const [id, code] of [['btnA', 'TouchA'], ['btnB', 'TouchB']]) {
    const b = document.getElementById(id);
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); Sound.init(); pressed.add(code); });
  }
})();

// ---------- Spielstand ----------
function newGame(userIdx) {
  const others = [0, 1, 2].filter((i) => i !== userIdx);
  const cpuIdx = others[Math.floor(Math.random() * others.length)];
  G.user = TEAM_OBJS[userIdx];
  G.cpu = TEAM_OBJS[cpuIdx];
  G.score = { user: 0, cpu: 0 };
  G.quarter = 1;
  G.clock = QUARTER_LEN;
  G.firstPoss = Math.random() < 0.5 ? 'user' : 'cpu';
  G.stats = { user: { rush: 0, pass: 0, to: 0, plays: 0 }, cpu: { rush: 0, pass: 0, to: 0, plays: 0 } };
  setPossession(G.firstPoss, 25);
  G.play = null;
  showMessages([
    { title: 'KICKOFF!', sub: G.user.name + ' VS ' + G.cpu.name, color: COL.hi },
    { title: 'MÜNZWURF', sub: teamOf(G.firstPoss).name + ' BEKOMMT DEN BALL', color: '#fff' },
  ], goSelect);
}

function setPossession(who, los) {
  G.poss = who;
  G.los = clamp(los, 1, 99);
  G.down = 1;
  G.toGo = Math.min(10, 100 - G.los);
}

function showMessages(list, after) {
  G.queue = list;
  G.after = after;
  G.timer = 0;
  G.state = 'result';
  if (list[0] && list[0].sound) Sound.play(list[0].sound);
}

function fgDistance() { return Math.round(100 - G.los + 17); }

function fgChance(dist, kck) {
  const range = 38 + kck / 100 * 22;
  const pen = 1.5 - kck / 100;
  let p = 0.99 - Math.max(0, dist - 20) * 0.011 * pen - Math.max(0, dist - 35) * 0.014 * pen;
  if (dist > range) p *= 0.15;
  return clamp(p, 0.02, 0.99);
}

// ---------- CPU-Playcalling ----------
function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function cpuOffCall() {
  const t = G.cpu;
  const late = G.quarter === 4 && G.clock < 90;
  const diff = G.score.cpu - G.score.user;
  if (G.down === 4) {
    const p = fgChance(fgDistance(), t.roster.K.attrs.KCK);
    const goForIt = (G.toGo <= 1.5 && G.los > 40) || (late && diff < -3) || (G.toGo <= 2 && G.los >= 45 && p < 0.45);
    if (!goForIt) return p > 0.45 ? SPECIAL_PLAYS[1] : SPECIAL_PLAYS[0];
  }
  let pRun = t.runBias;
  if (G.toGo >= 8) pRun -= 0.25;
  if (G.toGo <= 3) pRun += 0.2;
  if (late && diff < 0) pRun -= 0.3;
  return Math.random() < pRun ? pickRandom(RUN_PLAYS) : pickRandom(PASS_PLAYS);
}

function cpuDefCall() {
  let w;
  if (G.toGo >= 8) w = [0.35, 0.35, 0.2, 0.1];
  else if (G.toGo <= 3) w = [0.15, 0.25, 0.3, 0.3];
  else w = [0.27, 0.27, 0.26, 0.2];
  let r = Math.random();
  for (let i = 0; i < w.length; i++) { r -= w[i]; if (r <= 0) return DEF_PLAYS[i]; }
  return DEF_PLAYS[0];
}

// ---------- Ablauf ----------
function goSelect() {
  if (G.quarter > 4) { endGame(); return; }
  G.menu = { row: 0, col: 0 };
  if (G.poss === 'cpu') {
    const call = cpuOffCall();
    if (call.kind === 'punt' || call.kind === 'fg') {
      showMessages([{ title: G.cpu.short + (call.kind === 'punt' ? ' PUNTEN' : ' VERSUCHEN EIN FG'), sub: '4TH DOWN', color: '#fff' }], () => startKick(call.kind));
      return;
    }
    G.cpuOff = call;
  }
  G.state = 'select';
}

function startPlay(offPlay, defPlay) {
  const userOff = G.poss === 'user';
  G.play = createPlay({
    los: G.los, toGo: G.toGo,
    offTeam: teamOf(G.poss), defTeam: teamOf(other(G.poss)),
    offPlay, defPlay, userOff,
  });
  G.state = 'presnap';
  G.timer = 0;
  G.acc = 0;
  Sound.play('select');
}

function chooseOffense(play) {
  if (play.kind === 'punt' || play.kind === 'fg') { Sound.play('select'); startKick(play.kind); return; }
  startPlay(play, cpuDefCall());
}

function chooseDefense(play) { startPlay(G.cpuOff, play); }

function startKick(kind) {
  const who = G.poss;
  const kck = teamOf(who).roster.K.attrs.KCK;
  G.play = createPlay({
    los: G.los, toGo: G.toGo, offTeam: teamOf(who), defTeam: teamOf(other(who)),
    offPlay: RUN_PLAYS[0], defPlay: DEF_PLAYS[0], userOff: who === 'user',
  });
  G.play.byRole.QB.x = G.los - 7;
  G.play.byRole.RB.x = G.los - (kind === 'punt' ? 12 : 8);
  for (const d of G.play.def) d.ctrl = false;
  const k = { kind, t: 0, x0: G.los - (kind === 'punt' ? 12 : 7), y0: CY, y1: CY };
  if (kind === 'punt') {
    const d = 34 + kck / 100 * 14 + rnd(-6, 6);
    k.land = G.los + d;
    k.x1 = Math.min(k.land, 108);
    k.T = 2.2; k.peak = 9;
    k.y1 = CY + rnd(-8, 8);
  } else {
    k.dist = fgDistance();
    k.good = chance(fgChance(k.dist, kck));
    const range = 38 + kck / 100 * 22;
    k.x1 = k.dist > range + 4 && !k.good ? G.los - 7 + range * 0.95 : 110;
    k.y1 = k.good ? CY + rnd(-1.6, 1.6) : CY + (chance(0.5) ? -1 : 1) * rnd(3.8, 6);
    k.T = 1.6; k.peak = 5;
  }
  G.kick = k;
  G.state = 'kick';
  Sound.play('kick');
}

function finishKick() {
  const k = G.kick, who = G.poss, opp = other(who);
  const msgs = [];
  G.clock -= 6;
  if (k.kind === 'punt') {
    const yds = Math.round(k.land - G.los);
    if (k.land >= 100) {
      msgs.push({ title: 'PUNT: ' + yds + ' YDS', sub: 'TOUCHBACK', color: '#fff' });
      setPossession(opp, 20);
    } else {
      msgs.push({ title: 'PUNT: ' + yds + ' YDS', sub: teamOf(opp).short + ' ÜBERNIMMT', color: '#fff' });
      setPossession(opp, 100 - k.land);
    }
  } else if (k.good) {
    G.score[who] += 3;
    msgs.push({ title: 'FIELD GOAL GUT!', sub: k.dist + ' YARDS - 3 PUNKTE ' + teamOf(who).short, color: COL.hi, sound: 'good' });
    setPossession(opp, 25);
  } else {
    msgs.push({ title: 'NO GOOD!', sub: k.dist + '-YARD-VERSUCH DANEBEN', color: COL.red, sound: 'bad' });
    setPossession(opp, Math.max(20, 100 - (G.los - 7)));
  }
  checkClock(msgs);
  showMessages(msgs, goSelect);
}

function yardsText(g) {
  const n = Math.round(g);
  if (n === 0) return 'KEIN RAUMGEWINN';
  return (n > 0 ? 'GEWINN: ' : 'VERLUST: ') + Math.abs(n) + (Math.abs(n) === 1 ? ' YARD' : ' YARDS');
}

function finishPlay() {
  const P = G.play, r = P.result;
  const off = G.poss, def = other(off);
  const offTeam = teamOf(off), defTeam = teamOf(def);
  const st = G.stats[off];
  const msgs = [];
  const callInfo = off === 'user' ? 'CPU-DEFENSE: ' + P.defPlay.name : 'CPU-OFFENSE: ' + P.offPlay.name;
  const addYds = (g) => {
    if (r.passPlay || r.type === 'sack') st.pass += g; else st.rush += g;
  };
  st.plays++;
  let runoff = 0;
  switch (r.type) {
    case 'td': {
      addYds(100 - G.los);
      G.score[off] += 6;
      const pat = chance(0.72 + offTeam.roster.K.attrs.KCK / 100 * 0.27);
      if (pat) G.score[off] += 1;
      msgs.push({ title: 'TOUCHDOWN!', sub: offTeam.name + (pat ? ' - PAT GUT' : ' - PAT DANEBEN'), sub2: callInfo, color: COL.hi, sound: 'td' });
      setPossession(def, 25);
      break;
    }
    case 'safety':
      addYds(-G.los);
      G.score[def] += 2;
      msgs.push({ title: 'SAFETY!', sub: '+2 FÜR ' + defTeam.short, sub2: callInfo, color: COL.red, sound: 'bad' });
      setPossession(def, 35);
      break;
    case 'int': {
      st.to++;
      msgs.push({ title: 'INTERCEPTION!', sub: '#' + r.by.pd.num + ' ' + r.by.pd.name + ' (' + defTeam.short + ')', sub2: callInfo, color: COL.red, sound: 'bad' });
      setPossession(def, r.x >= 100 ? 20 : 100 - r.x);
      break;
    }
    case 'inc':
      msgs.push({ title: 'INCOMPLETE', sub: 'PASS UNVOLLSTÄNDIG', sub2: callInfo, color: '#fff' });
      nextDown(G.los, msgs);
      break;
    default: { // tackle, oob, sack
      const gain = r.x - G.los;
      addYds(gain);
      const title = r.type === 'sack' ? 'SACK!' : (r.type === 'oob' ? 'AUS' : 'TACKLE');
      const by = r.by ? ' (#' + r.by.pd.num + ' ' + r.by.pd.name + ')' : '';
      msgs.push({ title, sub: yardsText(gain) + (r.type === 'oob' ? '' : by), sub2: callInfo, color: r.type === 'sack' ? COL.red : '#fff' });
      if (r.type !== 'oob') runoff = 18;
      nextDown(r.x, msgs);
    }
  }
  G.clock -= Math.round(P.t) + runoff;
  checkClock(msgs);
  showMessages(msgs, goSelect);
}

function nextDown(newLos, msgs) {
  const fd = G.los + G.toGo;
  G.los = clamp(newLos, 0.5, 99.5);
  if (G.los >= fd) {
    G.down = 1;
    G.toGo = Math.min(10, 100 - G.los);
    msgs.push({ title: 'FIRST DOWN!', sub: teamOf(G.poss).short + ' MACHT WEITER', color: COL.green, short: true });
  } else {
    G.down++;
    G.toGo = fd - G.los;
    if (G.down > 4) {
      msgs.push({ title: 'TURNOVER ON DOWNS', sub: teamOf(other(G.poss)).short + ' ÜBERNIMMT', color: COL.red });
      setPossession(other(G.poss), 100 - G.los);
    }
  }
}

function checkClock(msgs) {
  if (G.clock > 0) return;
  if (G.quarter === 2) {
    msgs.push({ title: 'HALBZEIT', sub: G.user.short + ' ' + G.score.user + ' - ' + G.score.cpu + ' ' + G.cpu.short, color: COL.hi });
    G.quarter = 3;
    G.clock = QUARTER_LEN;
    setPossession(other(G.firstPoss), 25);
  } else if (G.quarter >= 4) {
    G.quarter = 5;
    G.clock = 0;
  } else {
    msgs.push({ title: 'ENDE Q' + G.quarter, sub: 'SEITENWECHSEL', color: '#fff' });
    G.quarter++;
    G.clock = QUARTER_LEN;
  }
}

function endGame() {
  G.state = 'gameover';
  G.timer = 0;
  Sound.play(G.score.user > G.score.cpu ? 'td' : 'bad');
}

// ---------- Update ----------
function update(dt) {
  G.timer += dt;
  if (hit('KeyM')) Sound.muted = !Sound.muted;
  switch (G.state) {
    case 'title': updateTitle(); break;
    case 'roster': updateRoster(); break;
    case 'help': if (hit(...ACTION, ...BACK, 'KeyH')) { G.state = G.helpBack; Sound.play('menu'); } break;
    case 'select': updateCam(G.los + 8, dt); updateSelect(); break;
    case 'presnap': updatePresnap(dt); break;
    case 'live': updateLive(dt); break;
    case 'kick': updateKick(dt); break;
    case 'result': updateResult(); break;
    case 'pause': if (hit('KeyP', ...ACTION, ...BACK)) G.state = G.pauseBack; break;
    case 'gameover': if (G.timer > 1 && hit(...ACTION)) { G.state = 'title'; Sound.play('select'); } break;
  }
}

function updateTitle() {
  if (hit('ArrowLeft', 'KeyA')) { G.teamSel = (G.teamSel + 2) % 3; Sound.play('menu'); }
  if (hit('ArrowRight', 'KeyD')) { G.teamSel = (G.teamSel + 1) % 3; Sound.play('menu'); }
  if (hit('KeyR')) openRoster(TEAM_OBJS[G.teamSel], 'title');
  if (hit('KeyH')) { G.helpBack = 'title'; G.state = 'help'; }
  if (hit(...ACTION)) { Sound.play('select'); newGame(G.teamSel); }
}

function openRoster(team, back) {
  G.rosterTeam = team;
  G.rosterTab = 0;
  G.rosterBack = back;
  G.state = 'roster';
  Sound.play('menu');
}

function updateRoster() {
  if (hit('ArrowLeft', 'ArrowRight', 'KeyA', 'KeyD')) { G.rosterTab = 1 - G.rosterTab; Sound.play('menu'); }
  if (hit('KeyG') && G.user) { G.rosterTeam = G.rosterTeam === G.user ? G.cpu : G.user; Sound.play('menu'); }
  if (hit(...BACK, ...ACTION, 'KeyR')) { G.state = G.rosterBack; Sound.play('menu'); }
}

function menuItems() {
  if (G.poss === 'user') return [RUN_PLAYS, PASS_PLAYS, SPECIAL_PLAYS];
  return [DEF_PLAYS];
}

function updateSelect() {
  const rows = menuItems();
  const m = G.menu;
  if (hit('ArrowUp', 'KeyW')) { m.row = (m.row + rows.length - 1) % rows.length; Sound.play('menu'); }
  if (hit('ArrowDown', 'KeyS')) { m.row = (m.row + 1) % rows.length; Sound.play('menu'); }
  m.col = Math.min(m.col, rows[m.row].length - 1);
  if (hit('ArrowLeft', 'KeyA')) { m.col = (m.col + rows[m.row].length - 1) % rows[m.row].length; Sound.play('menu'); }
  if (hit('ArrowRight', 'KeyD')) { m.col = (m.col + 1) % rows[m.row].length; Sound.play('menu'); }
  if (hit('KeyR')) { openRoster(G.user, 'select'); return; }
  if (hit('KeyH')) { G.helpBack = 'select'; G.state = 'help'; return; }
  if (hit(...ACTION)) {
    const play = rows[m.row][m.col];
    if (G.poss === 'user') chooseOffense(play); else chooseDefense(play);
  }
}

function updatePresnap(dt) {
  const P = G.play;
  updateCam(P.los + 8, dt);
  if (P.userOff) {
    if (hit(...ACTION)) { snap(P); G.state = 'live'; }
  } else {
    if (hit(...ACTION)) { presnapSwitch(P); Sound.play('menu'); }
    if (G.timer > 2.2) { snap(P); G.state = 'live'; }
  }
  if (hit('KeyP')) { G.pauseBack = 'presnap'; G.state = 'pause'; }
  flushSounds(P);
}

function updateLive(dt) {
  const P = G.play;
  if (hit('KeyP')) { G.pauseBack = 'live'; G.state = 'pause'; return; }
  const input = { dir: inputDir(), action: hit(...ACTION), throwKey: throwKeyPressed() };
  G.acc += dt;
  while (G.acc >= DT) {
    stepPlay(P, input);
    input.action = false;
    input.throwKey = 0;
    G.acc -= DT;
  }
  const b = P.ball;
  const fx = b.state === 'air' ? b.x : b.x + 6;
  updateCam(fx, dt, CY + (b.y - CY) * 0.8);
  flushSounds(P);
  if (P.phase === 'over' && P.overT > 0.9) finishPlay();
}

function updateKick(dt) {
  const k = G.kick;
  k.t += dt;
  const u = Math.min(1, k.t / k.T);
  updateCam(clamp(k.x0 + (k.x1 - k.x0) * u, 0, 100), dt, k.y0 + (k.y1 - k.y0) * u);
  if (k.t >= k.T + 0.5) finishKick();
}

function updateResult() {
  const m = G.queue[0];
  const dur = m && m.short ? 1.4 : 2.4;
  if (!m || G.timer > dur || (G.timer > 0.35 && hit(...ACTION))) {
    G.queue.shift();
    G.timer = 0;
    if (G.queue.length) { if (G.queue[0].sound) Sound.play(G.queue[0].sound); }
    else if (G.after) { const f = G.after; G.after = null; f(); }
  }
}

function updateCam(target, dt, targetY) {
  const k = Math.min(1, dt * 4);
  G.cam += (target - G.cam) * k;
  G.cam = clamp(G.cam, 18, 84);
  G.camY += ((targetY == null ? CY : targetY) - G.camY) * k;
  setCamY(G.camY);
}

function flushSounds(P) {
  for (const s of P.sounds) Sound.play(s);
  P.sounds.length = 0;
}

// ---------- Render ----------
function render() {
  G.hits = [];
  ctx.fillStyle = COL.bg;
  ctx.fillRect(0, 0, W, H);
  switch (G.state) {
    case 'title': renderTitle(); break;
    case 'roster': renderRoster(); break;
    case 'help': renderHelp(); break;
    case 'gameover': renderGameOver(); break;
    default: renderGame();
  }
}

function renderGame() {
  const P = G.play;
  const offT = teamOf(G.poss), defT = teamOf(other(G.poss));
  if (G.state === 'select' || !P) {
    drawField(ctx, G.cam, offT, defT);
    drawLines(ctx, G.cam, G.los, G.los + G.toGo);
  } else {
    drawPlayScene(ctx, P, G.cam, G.t, G.state === 'presnap');
    if (G.state === 'kick') drawKickBall();
    if (G.state === 'live' && P.userOff && P.offPlay.kind === 'pass' && P.ball.state === 'held' && P.ball.holder.role === 'QB' && !P.qbRun) {
      drawReceiverKeys(ctx, P, G.cam);
    }
  }
  drawHUD(ctx, G);
  if (G.state === 'select') renderSelect();
  if (G.state === 'presnap') renderPresnapHint();
  if (G.state === 'live' && P) renderLiveHint(P);
  if (G.state === 'result' && G.queue[0]) {
    const m = G.queue[0];
    drawBanner(ctx, m.title, m.sub, m.color, m.sub2);
  }
  if (G.state === 'pause') {
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, HUD_H, W, H - HUD_H);
    drawBanner(ctx, 'PAUSE', 'P ODER ENTER: WEITER', '#fff');
  }
}

function drawKickBall() {
  const k = G.kick;
  const u = Math.min(1, k.t / k.T);
  const x = k.x0 + (k.x1 - k.x0) * u;
  const y = k.y0 + (k.y1 - k.y0) * u;
  const z = k.peak * 4 * u * (1 - u) + (k.kind === 'fg' ? u * 1.5 : 0);
  drawBall(ctx, { x, y, z, state: 'air' }, G.cam);
}

function hintBar(lines) {
  const h = 6 + lines.length * 11;
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.fillRect(0, H - h, W, h);
  lines.forEach((l, i) => txt(ctx, l, W / 2, H - h + 4 + i * 11, i ? COL.dim : '#fff', 8, 'center'));
}

function renderPresnapHint() {
  const P = G.play;
  if (P.userOff) {
    const l2 = P.offPlay.kind === 'pass' ? 'PFEILE: QB  1-5/TIPPEN: WERFEN' : 'PFEILE: RB STEUERN  SPACE: JUKE';
    hintBar([P.offPlay.name + ' - SPACE/A: SNAP', l2]);
  } else {
    hintBar([P.defPlay.name + ' - SPACE/A: SPIELER WECHSELN', 'PFEILE: VERTEIDIGER STEUERN']);
  }
}

function renderLiveHint(P) {
  if (P.phase !== 'live') return;
  if (P.userOff && P.offPlay.kind === 'pass' && P.ball.state === 'held' && P.ball.holder.role === 'QB' && !P.qbRun) {
    hintBar(['1-5 ODER TIPPEN: PASS']);
  }
}

function situationText() {
  return downText(G) + '  -  ' + spotText(G);
}

function renderSelect() {
  ctx.fillStyle = 'rgba(8,10,18,0.9)';
  ctx.fillRect(0, HUD_H, W, H - HUD_H);
  const off = G.poss === 'user';
  txt(ctx, off ? 'OFFENSE - SPIELZUG WÄHLEN' : 'DEFENSE - SPIELZUG WÄHLEN', W / 2, 36, off ? COL.hi : '#7ad7ff', 8, 'center');
  txt(ctx, situationText(), W / 2, 48, COL.dim, 8, 'center');
  const rows = menuItems();
  const m = G.menu;
  let desc = '';
  if (off) {
    const labels = ['LAUF', 'PASS'];
    for (let r = 0; r < 2; r++) {
      const y0 = r === 0 ? 70 : 160;
      txt(ctx, labels[r], 8, y0 - 10, '#fff', 8);
      rows[r].forEach((pl, c) => {
        const x0 = 6 + c * 118;
        const sel = m.row === r && m.col === c;
        if (sel) desc = pl.desc;
        box(ctx, x0, y0, 114, 82, sel ? COL.panel2 : COL.panel, sel ? COL.hi : '#3a435a');
        drawOffDiagram(ctx, pl, x0 + 2, y0 + 2, 110, 62);
        txt(ctx, pl.name, x0 + 57, y0 + 69, sel ? COL.hi : '#fff', 8, 'center');
        addHit(x0, y0, 114, 82, r, c, sel, () => chooseOffense(pl));
      });
    }
    // Special Teams
    const kck = G.user.roster.K.attrs.KCK;
    const fd = fgDistance();
    const specials = [
      { pl: SPECIAL_PLAYS[0], label: 'PUNT', x: 6, w: 150 },
      { pl: SPECIAL_PLAYS[1], label: 'FG ' + fd + ' YDS ' + Math.round(fgChance(fd, kck) * 100) + '%', x: 162, w: 196 },
    ];
    specials.forEach((s, c) => {
      const sel = m.row === 2 && m.col === c;
      if (sel) desc = s.pl.desc;
      box(ctx, s.x, 250, s.w, 20, sel ? COL.panel2 : COL.panel, sel ? COL.hi : '#3a435a');
      txt(ctx, s.label, s.x + s.w / 2, 256, sel ? COL.hi : '#fff', 8, 'center');
      addHit(s.x, 250, s.w, 20, 2, c, sel, () => chooseOffense(s.pl));
    });
    rosterButton(364, 250, 110, 20);
    drawDesc(desc, 278);
  } else {
    txt(ctx, '4-3 DEFENSE', 8, 60, '#fff', 8);
    rows[0].forEach((pl, c) => {
      const x0 = 6 + c * 118, y0 = 70;
      const sel = m.col === c;
      if (sel) desc = pl.desc;
      box(ctx, x0, y0, 114, 176, sel ? COL.panel2 : COL.panel, sel ? '#7ad7ff' : '#3a435a');
      drawDefDiagram(ctx, pl, x0 + 2, y0 + 2, 110, 142);
      txt(ctx, pl.name, x0 + 57, y0 + 150, sel ? '#7ad7ff' : '#fff', 8, 'center');
      txt(ctx, pl.tag, x0 + 57, y0 + 162, COL.dim, 8, 'center');
      addHit(x0, y0, 114, 176, 0, c, sel, () => chooseDefense(pl));
    });
    rosterButton(364, 250, 110, 20);
    drawDesc(desc, 278);
  }
  txt(ctx, 'PFEILE + ENTER  -  R: KADER  -  H: HILFE', W / 2, 348, COL.dim, 8, 'center');
}

function rosterButton(x, y, w, h) {
  box(ctx, x, y, w, h, COL.panel, '#3a435a');
  txt(ctx, 'KADER (R)', x + w / 2, y + 6, '#fff', 8, 'center');
  G.hits.push({ x, y, w, h, fn: () => openRoster(G.user, 'select') });
}

function addHit(x, y, w, h, row, col, selected, fn) {
  G.hits.push({ x, y, w, h, fn, selected, hover: () => { G.menu.row = row; G.menu.col = col; } });
}

function drawDesc(desc, y) {
  const lines = wrapText(ctx, desc, W - 24, 8);
  lines.slice(0, 5).forEach((l, i) => txt(ctx, l, 12, y + i * 12, '#d8dce6', 8));
}

// ---------- Titel / Kader / Hilfe / Ende ----------
function renderTitle() {
  // Streifen-Hintergrund
  for (let y = 0; y < H; y += 12) {
    ctx.fillStyle = (y / 12) % 2 ? '#141a26' : '#111622';
    ctx.fillRect(0, y, W, 12);
  }
  txt(ctx, 'RETRO GRIDIRON', W / 2 + 2, 18, '#b8322a', 24, 'center', false);
  txt(ctx, 'RETRO GRIDIRON', W / 2, 16, COL.hi, 24, 'center', false);
  txt(ctx, '8-BIT AMERICAN FOOTBALL', W / 2, 48, '#fff', 8, 'center');
  txt(ctx, 'WÄHLE DEIN TEAM', W / 2, 70, COL.dim, 8, 'center');
  TEAM_OBJS.forEach((t, i) => {
    const x = 12 + i * 156, y = 86, w = 144, h = 190;
    const sel = G.teamSel === i;
    box(ctx, x, y, w, h, sel ? COL.panel2 : COL.panel, sel ? COL.hi : '#3a435a');
    ctx.fillStyle = shade(t.primary, -0.3);
    ctx.fillRect(x + 1, y + 1, w - 2, 56);
    const bob = sel ? Math.floor(G.t * 3) % 2 : 0;
    drawSprite(ctx, x + w / 2 - 17, y + 6 - bob, t, 1, sel ? Math.floor(G.t * 4) % 2 : 1, 5);
    txt(ctx, t.name, x + w / 2, y + 64, sel ? COL.hi : '#fff', 8, 'center');
    wrapText(ctx, t.style, w - 12, 8).forEach((l, k) => txt(ctx, l, x + 6, y + 80 + k * 11, '#c8ccd8', 8));
    const r = t.ratings;
    drawRatingBar(ctx, 'LAUF', r.LAUF, x + 6, y + 128, w - 12, '#ff9b3d');
    drawRatingBar(ctx, 'PASS', r.PASS, x + 6, y + 141, w - 12, '#7ad7ff');
    drawRatingBar(ctx, 'DEF', r.DEF, x + 6, y + 154, w - 12, '#ff5a5a');
    drawRatingBar(ctx, 'KICK', r.KICK, x + 6, y + 167, w - 12, COL.green);
    G.hits.push({
      x, y, w, h, selected: sel,
      hover: () => { G.teamSel = i; },
      fn: () => { G.teamSel = i; Sound.play('select'); newGame(i); },
    });
  });
  const blink = Math.floor(G.t * 2) % 2 === 0;
  if (blink) txt(ctx, 'ENTER / A: SPIEL STARTEN', W / 2, 288, COL.hi, 8, 'center');
  txt(ctx, '< >: TEAM   R: KADER   H: STEUERUNG', W / 2, 304, '#fff', 8, 'center');
  const bx = [[40, 'KADER', () => openRoster(TEAM_OBJS[G.teamSel], 'title')], [250, 'STEUERUNG', () => { G.helpBack = 'title'; G.state = 'help'; }]];
  for (const [x, label, fn] of bx) {
    box(ctx, x, 320, 190, 20, COL.panel, '#3a435a');
    txt(ctx, label, x + 95, 326, '#fff', 8, 'center');
    G.hits.push({ x, y: 320, w: 190, h: 20, fn });
  }
}

function renderRoster() {
  const t = G.rosterTeam;
  ctx.fillStyle = shade(t.primary, -0.55);
  ctx.fillRect(0, 0, W, 34);
  txt(ctx, t.name + ' - KADER', 8, 6, COL.hi, 8);
  const tabs = ['OFFENSE', 'DEFENSE'];
  tabs.forEach((s, i) => {
    const x = 8 + i * 90;
    const sel = G.rosterTab === i;
    box(ctx, x, 18, 84, 14, sel ? COL.panel2 : '#000', sel ? COL.hi : '#3a435a');
    txt(ctx, s, x + 42, 21, sel ? COL.hi : COL.dim, 8, 'center');
    G.hits.push({ x, y: 18, w: 84, h: 14, fn: () => { G.rosterTab = i; } });
  });
  if (G.user && G.rosterBack !== 'title') txt(ctx, 'G: GEGNER', 472, 21, COL.dim, 8, 'right');
  const roles = G.rosterTab === 0 ? OFF_ROLES : DEF_ROLES.concat(['K']);
  const y0 = 42;
  txt(ctx, 'POS', 6, y0, COL.dim, 8);
  txt(ctx, '#', 38, y0, COL.dim, 8);
  txt(ctx, 'NAME', 60, y0, COL.dim, 8);
  txt(ctx, 'OVR', 150, y0, COL.dim, 8);
  ATTRS.forEach((a, i) => txt(ctx, a, 184 + i * 29, y0, COL.dim, 8));
  ctx.fillStyle = '#3a435a';
  ctx.fillRect(4, y0 + 10, W - 8, 1);
  roles.forEach((role, k) => {
    const p = t.roster[role];
    const y = y0 + 15 + k * 13;
    if (k % 2) { ctx.fillStyle = 'rgba(255,255,255,0.04)'; ctx.fillRect(4, y - 2, W - 8, 12); }
    txt(ctx, p.label, 6, y, '#fff', 8);
    txt(ctx, String(p.num), 38, y, '#fff', 8);
    txt(ctx, p.name.length > 11 ? p.name.slice(0, 11) : p.name, 60, y, '#fff', 8);
    txt(ctx, String(p.ovr), 152, y, ovrColor(p.ovr), 8);
    const keysA = KEY_ATTRS[p.pos];
    ATTRS.forEach((a, i) => {
      const key = keysA.includes(a);
      txt(ctx, String(p.attrs[a]), 186 + i * 29, y, key ? ovrColor(p.attrs[a]) : '#4d5568', 8);
    });
  });
  // Legende
  const ly = 222;
  ctx.fillStyle = '#3a435a';
  ctx.fillRect(4, ly - 6, W - 8, 1);
  ATTRS.forEach((a, i) => {
    const x = 6 + (i % 2) * 238, y = ly + Math.floor(i / 2) * 12;
    txt(ctx, a, x, y, COL.hi, 8);
    txt(ctx, ATTR_INFO[a].replace(/^[^:]+: /, ''), x + 32, y, '#c8ccd8', 8);
  });
  txt(ctx, 'FARBIG = WICHTIG FÜR DIE POSITION', W / 2, 288, COL.dim, 8, 'center');
  txt(ctx, '< >: OFFENSE/DEFENSE   ESC/ENTER: ZURÜCK', W / 2, 304, '#fff', 8, 'center');
  box(ctx, 165, 320, 150, 20, COL.panel, '#3a435a');
  txt(ctx, 'ZURÜCK', 240, 326, '#fff', 8, 'center');
  G.hits.push({ x: 165, y: 320, w: 150, h: 20, fn: () => { G.state = G.rosterBack; } });
}

function ovrColor(v) {
  if (v >= 88) return '#7dff7a';
  if (v >= 78) return '#d4ff5a';
  if (v >= 68) return '#ffd23f';
  return '#ff9b3d';
}

function renderHelp() {
  txt(ctx, 'STEUERUNG', W / 2, 14, COL.hi, 16, 'center');
  const lines = [
    ['MENÜ', 'PFEILE + ENTER / KLICKEN'],
    ['SNAP', 'SPACE ODER ENTER'],
    ['', ''],
    ['OFFENSE PASS', 'PFEILE: QB BEWEGEN'],
    ['', '1-5: PASS AUF RECEIVER'],
    ['', '(ODER RECEIVER ANTIPPEN)'],
    ['OFFENSE LAUF', 'PFEILE: BALLTRÄGER'],
    ['', 'SPACE: JUKE (AGI!)'],
    ['', ''],
    ['DEFENSE', 'PFEILE: SPIELER STEUERN'],
    ['', 'SPACE: SPIELER NAHE BALL'],
    ['', 'TACKLE BEI KONTAKT'],
    ['', ''],
    ['SONSTIGES', 'P: PAUSE   M: TON AN/AUS'],
    ['', 'R: KADER IM PLAY-MENÜ'],
  ];
  lines.forEach(([a, b], i) => {
    txt(ctx, a, 30, 48 + i * 14, COL.hi, 8);
    txt(ctx, b, 170, 48 + i * 14, '#fff', 8);
  });
  txt(ctx, 'TIPP: QB-DRUCK? WIRF SCHNELL ODER LAUF!', W / 2, 270, COL.dim, 8, 'center');
  txt(ctx, 'ATTRIBUTE ENTSCHEIDEN 1-GEGEN-1-DUELLE.', W / 2, 284, COL.dim, 8, 'center');
  txt(ctx, 'ENTER / ESC: ZURÜCK', W / 2, 320, '#fff', 8, 'center');
  G.hits.push({ x: 0, y: 0, w: W, h: H, fn: () => { G.state = G.helpBack; } });
}

function renderGameOver() {
  const u = G.score.user, c = G.score.cpu;
  const title = u > c ? 'SIEG!' : (u < c ? 'NIEDERLAGE' : 'UNENTSCHIEDEN');
  txt(ctx, 'ENDSTAND', W / 2, 24, COL.dim, 8, 'center');
  txt(ctx, title, W / 2, 44, u > c ? COL.hi : (u < c ? COL.red : '#fff'), 24, 'center');
  const sy = 96;
  box(ctx, 60, sy, 360, 50, COL.panel, '#3a435a');
  txt(ctx, G.user.short, 140, sy + 10, '#fff', 8, 'center');
  txt(ctx, G.cpu.short, 340, sy + 10, '#fff', 8, 'center');
  txt(ctx, String(u), 140, sy + 24, COL.hi, 16, 'center');
  txt(ctx, String(c), 340, sy + 24, COL.hi, 16, 'center');
  txt(ctx, '-', 240, sy + 24, '#fff', 16, 'center');
  const rows = [
    ['LAUF-YARDS', 'rush'], ['PASS-YARDS', 'pass'], ['TURNOVER', 'to'], ['SPIELZÜGE', 'plays'],
  ];
  rows.forEach(([label, k], i) => {
    const y = 170 + i * 16;
    txt(ctx, String(Math.round(G.stats.user[k])), 140, y, '#fff', 8, 'center');
    txt(ctx, label, 240, y, COL.dim, 8, 'center');
    txt(ctx, String(Math.round(G.stats.cpu[k])), 340, y, '#fff', 8, 'center');
  });
  if (Math.floor(G.t * 2) % 2 === 0) txt(ctx, 'ENTER / A: NEUES SPIEL', W / 2, 300, COL.hi, 8, 'center');
  G.hits.push({ x: 0, y: 0, w: W, h: H, fn: () => { if (G.timer > 1) G.state = 'title'; } });
}

// ---------- Loop ----------
function resize() {
  const isTouch = document.body.classList.contains('touch');
  const landscape = window.innerWidth > window.innerHeight;
  const touchH = isTouch && !landscape ? 190 : 0;
  const availW = window.innerWidth - (isTouch && landscape ? 260 : 8);
  const availH = window.innerHeight - 8 - touchH;
  let s = Math.min(availW / W, availH / H);
  if (s >= 1) s = Math.max(1, Math.floor(s * 2) / 2);
  canvas.style.width = Math.floor(W * s) + 'px';
  canvas.style.height = Math.floor(H * s) + 'px';
}
window.addEventListener('resize', resize);

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  G.t += dt;
  update(dt);
  render();
  pressed.clear();
  touch.tapThrow = 0;
  requestAnimationFrame(frame);
}

function start() {
  resize();
  requestAnimationFrame((t) => { last = t; frame(t); });
}

if (document.fonts && document.fonts.load) {
  Promise.race([
    document.fonts.load('8px "Press Start 2P"'),
    new Promise((r) => setTimeout(r, 1500)),
  ]).then(start, start);
} else start();
