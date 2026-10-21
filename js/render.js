'use strict';
// Pixel-Grafik: Feld, Spieler, HUD, Menüs, Playbook-Diagramme

const W = 480, H = 360;
const SCALE = 8;           // Pixel pro Yard
const HUD_H = 28;
const FIELD_TOP = HUD_H + 6;
const FONT = '"Press Start 2P", monospace';

const COL = {
  bg: '#10141c', grass1: '#3e8e3a', grass2: '#388434', out: '#2d6b2a', line: '#eef2e6',
  los: '#4aa3ff', fd: '#ffd23f', text: '#ffffff', dim: '#8a93a6', hi: '#ffd23f',
  panel: '#1a2030', panel2: '#252d42', red: '#ff5a5a', green: '#7dff7a',
};

const VIEW_H = (H - FIELD_TOP) / SCALE; // sichtbare Feldbreite in Yards
let camY = 0;                            // vertikale Kamera (Yards)

function wx(x, cam) { return Math.round((x - cam) * SCALE + W / 2); }
function wy(y) { return Math.round(FIELD_TOP + (y - camY) * SCALE); }
function setCamY(y) { camY = clamp(y - VIEW_H / 2, -1.5, FIELD_W + 1.5 - VIEW_H); }

function txt(ctx, s, x, y, color, size, align, shadow) {
  ctx.font = (size || 8) + 'px ' + FONT;
  ctx.textAlign = align || 'left';
  ctx.textBaseline = 'top';
  if (shadow !== false) {
    ctx.fillStyle = '#000';
    ctx.fillText(s, x + 1, y + 1);
  }
  ctx.fillStyle = color || COL.text;
  ctx.fillText(s, x, y);
}

function wrapText(ctx, s, maxW, size) {
  ctx.font = (size || 8) + 'px ' + FONT;
  const words = s.split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t;
  }
  if (cur) lines.push(cur);
  return lines;
}

function box(ctx, x, y, w, h, fill, border) {
  ctx.fillStyle = fill || COL.panel;
  ctx.fillRect(x, y, w, h);
  if (border) {
    ctx.fillStyle = border;
    ctx.fillRect(x, y, w, 1); ctx.fillRect(x, y + h - 1, w, 1);
    ctx.fillRect(x, y, 1, h); ctx.fillRect(x + w - 1, y, 1, h);
  }
}

// ---------- Sprites ----------
const SPRITE_TOP = [
  '..HHH..',
  '.HHHHM.',
  '..HHHM.',
  '.JJJJJ.',
  'JJJTJJJ',
  '.JJTJJ.',
  '..PPP..',
];
const SPRITE_LEGS = [
  ['.PP.PP.', '.S...S.'],
  ['..P.P..', '..S.S..'],
];

function drawSprite(ctx, x0, y0, team, facing, frame, px) {
  px = px || 1;
  const cmap = { H: team.helmet, M: '#9aa0a8', J: team.primary, T: team.secondary, P: team.pants, S: '#1a1a1a' };
  const rows = SPRITE_TOP.concat(SPRITE_LEGS[frame]);
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    for (let c = 0; c < 7; c++) {
      const ch = row[c];
      if (ch === '.') continue;
      const cx = facing >= 0 ? c : 6 - c;
      ctx.fillStyle = cmap[ch];
      ctx.fillRect(x0 + cx * px, y0 + r * px, px, px);
    }
  }
}

function drawPlayer(ctx, p, cam, team, t) {
  const sx = wx(p.x, cam), sy = wy(p.y);
  if (sx < -10 || sx > W + 10) return;
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.fillRect(sx - 3, sy, 7, 2);
  const moving = Math.hypot(p.vx, p.vy) > 0.5;
  const frame = moving ? (Math.floor(p.anim * 1.6) % 2) : 1;
  let y0 = sy - 8;
  if (p.stun > 0) y0 += 1;
  drawSprite(ctx, sx - 3, y0, team, p.facing, frame);
  if (p.engaged) { ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.fillRect(sx - 1, sy - 10, 3, 1); }
  if (p.ctrl && Math.floor(t * 4) % 2 === 0) {
    ctx.fillStyle = COL.hi;
    ctx.fillRect(sx - 2, sy - 13, 5, 1);
    ctx.fillRect(sx - 1, sy - 12, 3, 1);
    ctx.fillRect(sx, sy - 11, 1, 1);
  }
}

function drawBall(ctx, b, cam) {
  const sx = wx(b.x, cam), sy = wy(b.y);
  if (b.state === 'air') {
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(sx - 1, sy, 3, 1);
  }
  const lift = Math.round((b.z || 0) * SCALE * 0.9);
  const px = (b.z || 0) > 3.5 ? 2 : 1; // hohe Bälle wirken näher
  const by = sy - 4 - lift;
  ctx.fillStyle = '#7a3e12';
  ctx.fillRect(sx - px, by, 3 * px, 2 * px);
  ctx.fillStyle = '#fff';
  ctx.fillRect(sx, by, px, px);
}

// ---------- Feld ----------
function drawField(ctx, cam, leftTeam, rightTeam) {
  ctx.fillStyle = COL.out;
  ctx.fillRect(0, HUD_H, W, H - HUD_H);
  const top = wy(0), bot = wy(FIELD_W);
  for (let x = -10; x < 110; x += 5) {
    const a = wx(x, cam), b = wx(x + 5, cam);
    if (b < 0 || a > W) continue;
    let c = (Math.floor(x / 5) % 2 === 0) ? COL.grass1 : COL.grass2;
    if (x < 0) c = shade(leftTeam.primary, -0.25);
    if (x >= 100) c = shade(rightTeam.primary, -0.25);
    ctx.fillStyle = c;
    ctx.fillRect(a, top, b - a, bot - top);
  }
  ctx.fillStyle = COL.line;
  // Seiten- und Endlinien
  ctx.fillRect(wx(-10, cam), top - 1, wx(110, cam) - wx(-10, cam), 1);
  ctx.fillRect(wx(-10, cam), bot, wx(110, cam) - wx(-10, cam), 1);
  ctx.fillRect(wx(-10, cam), top, 1, bot - top);
  ctx.fillRect(wx(110, cam) - 1, top, 1, bot - top);
  for (let x = 0; x <= 100; x += 5) {
    const a = wx(x, cam);
    if (a < -2 || a > W + 2) continue;
    ctx.fillStyle = COL.line;
    ctx.fillRect(a, top, (x === 0 || x === 100) ? 2 : 1, bot - top);
  }
  // Hash Marks
  ctx.fillStyle = COL.line;
  for (let x = 1; x < 100; x++) {
    if (x % 5 === 0) continue;
    const a = wx(x, cam);
    if (a < 0 || a > W) continue;
    for (const hy of [0.4, 23.58, 29.75, FIELD_W - 0.9]) ctx.fillRect(a, wy(hy), 1, 2);
  }
  // Zahlen
  for (let x = 10; x <= 90; x += 10) {
    const a = wx(x, cam);
    if (a < -20 || a > W + 20) continue;
    const n = String(x <= 50 ? x : 100 - x);
    txt(ctx, n, a + 1, wy(5), 'rgba(238,242,230,0.85)', 8, 'center', false);
    txt(ctx, n, a + 1, wy(FIELD_W - 6.5), 'rgba(238,242,230,0.85)', 8, 'center', false);
  }
  // Endzonen-Schriftzug
  drawEndzoneText(ctx, leftTeam.short, wx(-5, cam), (top + bot) / 2, -1);
  drawEndzoneText(ctx, rightTeam.short, wx(105, cam), (top + bot) / 2, 1);
  // Goal Posts
  for (const gx of [-10, 110]) {
    const a = wx(gx, cam);
    if (a < -30 || a > W + 30) continue;
    const dir = gx < 0 ? -1 : 1;
    const y1 = wy(CY - 3.1), y2 = wy(CY + 3.1);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(a + dir * 3, y1 + 2, 2, y2 - y1);
    ctx.fillStyle = '#ffe14a';
    ctx.fillRect(a - 1, y1, 2, y2 - y1);       // Querlatte
    ctx.fillRect(Math.min(a, a + dir * 6), wy(CY) - 1, 7, 2); // Pfosten
    for (const uy of [y1, y2 - 2]) {             // Stangen
      for (let k = 0; k < 18; k++) ctx.fillRect(a + dir * Math.round(k * 0.6), uy - k, 2, 2);
    }
  }
}

function drawEndzoneText(ctx, s, x, y, dir) {
  if (x < -40 || x > W + 40) return;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(dir * Math.PI / 2);
  txt(ctx, s, 0, -8, 'rgba(255,255,255,0.8)', 16, 'center');
  ctx.restore();
}

function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const f = (v) => Math.round(k < 0 ? v * (1 + k) : v + (255 - v) * k);
  r = f(r); g = f(g); b = f(b);
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

function drawLines(ctx, cam, los, fdLine) {
  const top = wy(0), bot = wy(FIELD_W);
  ctx.fillStyle = COL.los;
  ctx.fillRect(wx(los, cam), top, 1, bot - top);
  if (fdLine != null && fdLine < 100) {
    ctx.fillStyle = COL.fd;
    ctx.fillRect(wx(fdLine, cam), top, 1, bot - top);
  }
}

// Vorschau der eigenen Zuweisungen vor dem Snap
function drawPreview(ctx, P, cam) {
  ctx.save();
  ctx.globalAlpha = 0.55;
  if (P.userOff) {
    for (const p of P.off) {
      const j = p.job;
      let pts = null, color = '#ffffff';
      if (j.t === 'route') { pts = j.pts; color = '#fff'; }
      else if (j.t === 'path') { pts = j.pts; color = COL.hi; }
      else if (j.t === 'pull') { pts = j.pts; color = '#ff9b3d'; }
      if (!pts) continue;
      dotted(ctx, [{ x: p.x, y: p.y }].concat(pts), cam, color);
    }
  } else {
    for (const d of P.def) {
      const j = d.job;
      if (j.t === 'zone') {
        ctx.strokeStyle = DBS.includes(d.role) ? '#7ad7ff' : '#c08bff';
        ctx.beginPath();
        ctx.ellipse(wx(j.zx, cam), wy(j.zy), j.r * SCALE * 0.6, j.r * SCALE * 0.6, 0, 0, Math.PI * 2);
        ctx.stroke();
        dotted(ctx, [{ x: d.x, y: d.y }, { x: j.zx, y: j.zy }], cam, '#c0e8ff');
      } else if (j.t === 'man') {
        dotted(ctx, [{ x: d.x, y: d.y }, { x: j.target.x, y: j.target.y }], cam, '#ff8080');
      } else if (j.t === 'rush') {
        dotted(ctx, [{ x: d.x, y: d.y }, { x: P.los - 4, y: d.y + (CY - d.y) * 0.5 }], cam, '#ff5a5a');
      }
    }
  }
  ctx.restore();
}

function dotted(ctx, pts, cam, color) {
  ctx.fillStyle = color;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const ax = wx(a.x, cam), ay = wy(a.y), bx = wx(b.x, cam), by = wy(b.y);
    const n = Math.max(1, Math.floor(Math.hypot(bx - ax, by - ay) / 3));
    for (let k = 0; k <= n; k++) {
      ctx.fillRect(Math.round(ax + (bx - ax) * k / n), Math.round(ay + (by - ay) * k / n), 1, 1);
    }
  }
}

function drawReceiverKeys(ctx, P, cam) {
  for (let i = 0; i < ELIGIBLE.length; i++) {
    const r = P.byRole[ELIGIBLE[i]];
    const sx = wx(r.x, cam), sy = wy(r.y) - 20;
    const blocking = r.job.t !== 'route';
    box(ctx, sx - 5, sy, 10, 10, blocking ? '#555' : COL.hi, '#000');
    txt(ctx, String(i + 1), sx + 1, sy + 2, '#000', 8, 'center', false);
  }
}

function drawPopups(ctx, P, cam) {
  for (const pp of P.popups) {
    const sy = wy(pp.y) - 14 - pp.t * 14;
    txt(ctx, pp.text, wx(pp.x, cam), sy, pp.color, 8, 'center');
  }
}

function drawPlayScene(ctx, P, cam, t, showPreview) {
  const offTeam = P.offTeam, defTeam = P.defTeam;
  drawField(ctx, cam, offTeam, defTeam);
  drawLines(ctx, cam, P.los, P.los + P.toGo);
  if (showPreview) drawPreview(ctx, P, cam);
  const sorted = P.all.slice().sort((a, b) => a.y - b.y);
  for (const p of sorted) drawPlayer(ctx, p, cam, p.side === 'off' ? offTeam : defTeam, t);
  if (P.phase === 'presnap') drawBall(ctx, { x: P.los - 0.3, y: CY, z: 0, state: 'held' }, cam);
  else drawBall(ctx, P.ball, cam);
  drawPopups(ctx, P, cam);
}

// ---------- HUD ----------
function drawHUD(ctx, G) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, HUD_H);
  ctx.fillStyle = '#333a4d';
  ctx.fillRect(0, HUD_H - 1, W, 1);
  const teams = [['user', G.user], ['cpu', G.cpu]];
  teams.forEach(([who, tm], i) => {
    const x = 4 + i * 118;
    box(ctx, x, 4, 114, 20, tm.primary, '#000');
    box(ctx, x + 84, 4, 30, 20, '#000', tm.primary);
    txt(ctx, tm.short, x + 5, 10, '#fff', 8);
    txt(ctx, String(G.score[who]), x + 99, 10, COL.hi, 8, 'center');
    if (G.poss === who) { ctx.fillStyle = '#7a3e12'; ctx.fillRect(x + 76, 12, 5, 3); ctx.fillStyle = '#fff'; ctx.fillRect(x + 78, 12, 1, 1); }
    if (who === 'user') txt(ctx, 'DU', x + 58, 10, 'rgba(255,255,255,0.6)', 8);
  });
  const q = G.quarter > 4 ? 'END' : 'Q' + G.quarter;
  const cl = Math.max(0, Math.ceil(G.clock));
  const clock = Math.floor(cl / 60) + ':' + String(cl % 60).padStart(2, '0');
  txt(ctx, q, 262, 6, COL.dim, 8, 'center');
  txt(ctx, clock, 262, 16, '#fff', 8, 'center');
  txt(ctx, downText(G), 474, 6, '#fff', 8, 'right');
  txt(ctx, spotText(G), 474, 16, COL.dim, 8, 'right');
}

function downText(G) {
  const d = ['1ST', '2ND', '3RD', '4TH'][G.down - 1] || '';
  const goal = G.los + G.toGo >= 100;
  return d + ' & ' + (goal ? 'GOAL' : Math.max(1, Math.round(G.toGo)));
}

function spotText(G) {
  const l = Math.round(G.los);
  const off = G.poss === 'user' ? G.user : G.cpu;
  const def = G.poss === 'user' ? G.cpu : G.user;
  if (l === 50) return 'BALL @ 50';
  return 'BALL @ ' + (l < 50 ? off.short + ' ' + l : def.short + ' ' + (100 - l));
}

function drawBanner(ctx, title, sub, color, sub2) {
  const h = sub2 ? 70 : 56;
  const y = 130;
  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  ctx.fillRect(0, y, W, h);
  ctx.fillStyle = color || COL.hi;
  ctx.fillRect(0, y, W, 2); ctx.fillRect(0, y + h - 2, W, 2);
  txt(ctx, title, W / 2, y + 12, color || COL.hi, 16, 'center');
  if (sub) txt(ctx, sub, W / 2, y + 36, '#fff', 8, 'center');
  if (sub2) txt(ctx, sub2, W / 2, y + 50, COL.dim, 8, 'center');
}

// ---------- Playbook-Diagramme ----------
const DIA_S = 2.4;

function diaPt(cx, losY, dx, dy) { return [Math.round(cx + dy * DIA_S), Math.round(losY - dx * DIA_S)]; }

function diaLine(ctx, pts, color, dash) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash(dash ? [2, 2] : []);
  ctx.beginPath();
  pts.forEach(([x, y], i) => i ? ctx.lineTo(x + 0.5, y + 0.5) : ctx.moveTo(x + 0.5, y + 0.5));
  ctx.stroke();
  ctx.setLineDash([]);
  if (pts.length > 1) {
    const [ax, ay] = pts[pts.length - 2], [bx, by] = pts[pts.length - 1];
    const ang = Math.atan2(by - ay, bx - ax);
    ctx.fillStyle = color;
    for (const da of [-2.5, 2.5]) {
      ctx.fillRect(Math.round(bx - Math.cos(ang + da / 6) * 3), Math.round(by - Math.sin(ang + da / 6) * 3), 1, 1);
    }
    ctx.fillRect(bx, by, 1, 1);
  }
}

function drawOffDiagram(ctx, play, x, y, w, h) {
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.fillStyle = '#245c25';
  ctx.fillRect(x, y, w, h);
  const cx = x + w / 2, losY = y + h - 18;
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.fillRect(x, losY, w, 1);
  const form = FORMATIONS[play.formation];
  for (const r of OFF_ROLES) {
    const [dx, dy] = form[r];
    const [sx, sy] = diaPt(cx, losY, dx, dy);
    if (play.kind === 'pass' && play.routes[r]) {
      const sign = dy <= 0 ? 1 : -1;
      const pts = [[sx, sy]].concat(play.routes[r].pts.map(([a, b]) => diaPt(cx, losY, dx + a, clamp(dy + sign * b, -26, 26))));
      if (play.routes[r].end === 'go') {
        const n = pts.length;
        const [ax, ay] = n > 1 ? pts[n - 2] : [sx, sy];
        const [bx, by] = pts[n - 1];
        const m = Math.hypot(bx - ax, by - ay) || 1;
        pts.push([Math.round(bx + (bx - ax) / m * 8), Math.round(by + (by - ay) / m * 8)]);
      }
      diaLine(ctx, pts, r === 'RB' ? '#ffb347' : '#ffffff');
    } else if (play.kind === 'run' && r === 'RB') {
      const pts = [[sx, sy]].concat(play.rbPath.map(([a, b]) => diaPt(cx, losY, a, b)));
      diaLine(ctx, pts, COL.hi);
    } else if (play.kind === 'run' && play.pull && play.pull[r]) {
      const pts = [[sx, sy]].concat(play.pull[r].map(([a, b]) => diaPt(cx, losY, a, b)));
      diaLine(ctx, pts, '#ff9b3d');
    } else if (r !== 'QB') {
      // Block
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      const off = play.block === 'reach' ? 2 : 0;
      ctx.fillRect(sx + off, sy - 4, 1, 3);
      ctx.fillRect(sx + off - 1, sy - 5, 3, 1);
    }
    ctx.fillStyle = r === 'QB' ? COL.hi : '#fff';
    ctx.fillRect(sx - 1, sy - 1, 3, 3);
  }
  if (play.toss) {
    const [qx, qy] = diaPt(cx, losY, form.QB[0], form.QB[1]);
    const [rx, ry] = diaPt(cx, losY, play.rbPath[0][0], play.rbPath[0][1]);
    diaLine(ctx, [[qx, qy], [rx, ry]], '#ffe9a0', true);
  }
  ctx.restore();
}

function drawDefDiagram(ctx, play, x, y, w, h) {
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.fillStyle = '#245c25';
  ctx.fillRect(x, y, w, h);
  const cx = x + w / 2, losY = y + h - 22;
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.fillRect(x, losY, w, 1);
  const form = FORMATIONS.shotgun;
  const offPos = {};
  for (const r of OFF_ROLES) {
    const [dx, dy] = form[r];
    const p = diaPt(cx, losY, dx, dy);
    offPos[r] = p;
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(p[0] - 1, p[1] - 1, 3, 3);
  }
  const align = Object.assign({}, DEF_ALIGN, play.align || {});
  // Zonen zuerst
  for (const r of DEF_ROLES) {
    const a = play.assign[r];
    if (a.t !== 'zone') continue;
    const [zx, zy] = diaPt(cx, losY, a.x, a.y);
    ctx.fillStyle = DBS.includes(r) ? 'rgba(90,190,255,0.28)' : 'rgba(190,130,255,0.3)';
    ctx.beginPath();
    ctx.ellipse(zx, zy, a.r * DIA_S * 0.7, a.r * DIA_S * 0.45, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  for (const r of DEF_ROLES) {
    const a = play.assign[r];
    const [dx, dy] = align[r];
    const [sx, sy] = diaPt(cx, losY, dx, dy);
    if (a.t === 'zone') {
      const [zx, zy] = diaPt(cx, losY, a.x, a.y);
      diaLine(ctx, [[sx, sy], [zx, zy]], DBS.includes(r) ? '#9ad8ff' : '#d3b0ff');
    } else if (a.t === 'man') {
      diaLine(ctx, [[sx, sy], offPos[a.on]], '#ff9090', true);
    } else {
      diaLine(ctx, [[sx, sy], [Math.round(sx + (cx - sx) * 0.4), losY + 9]], '#ff5a5a');
    }
    ctx.fillStyle = '#ff5a5a';
    ctx.fillRect(sx - 1, sy - 1, 1, 1); ctx.fillRect(sx + 1, sy - 1, 1, 1);
    ctx.fillRect(sx, sy, 1, 1);
    ctx.fillRect(sx - 1, sy + 1, 1, 1); ctx.fillRect(sx + 1, sy + 1, 1, 1);
  }
  ctx.restore();
}

function drawRatingBar(ctx, label, v, x, y, w, color) {
  txt(ctx, label, x, y, COL.dim, 8);
  const bx = x + 40, bw = w - 66;
  ctx.fillStyle = '#000';
  ctx.fillRect(bx, y, bw, 7);
  ctx.fillStyle = color;
  ctx.fillRect(bx + 1, y + 1, Math.round((bw - 2) * clamp((v - 40) / 59, 0.05, 1)), 5);
  txt(ctx, String(v), x + w - 2, y, '#fff', 8, 'right');
}
