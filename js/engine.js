'use strict';
// Spielzug-Simulation. Einheiten: Yards und Sekunden.
// Die Offense spielt immer nach rechts (+x), 0 = eigene Goal Line, 100 = gegnerische.

const DT = 1 / 60;
const FIELD_W = 160 / 3;
const CY = FIELD_W / 2;
const ELIGIBLE = ['WR1', 'WR3', 'TE', 'WR2', 'RB']; // Wurf-Tasten 1-5
const DBS = ['LCB', 'RCB', 'FS', 'SS'];

function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function rnd(a, b) { return a + Math.random() * (b - a); }
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function chance(p) { return Math.random() < p; }
function gauss() { return (Math.random() + Math.random() + Math.random() - 1.5) / 1.5; }

function makePlayer(pd, side, x, y) {
  const a = pd.attrs;
  return {
    pd, a, role: pd.role, side, x, y, sx: x, sy: y, vx: 0, vy: 0,
    maxSpd: 4.6 + a.SPD / 100 * 4.9,
    acc: 10 + a.AGI / 100 * 18,
    react: (0.12 + (100 - a.AGI) / 100 * 0.45) * rnd(0.7, 1.3),
    job: { t: 'idle' }, wp: 0, engaged: null, engT: 0, shedCd: 0, blockCd: 0,
    stun: 0, stumble: 0, juke: 0, jukeCd: 0, hist: [], anim: 0,
    ctrl: false, freeRun: false, dropDone: false, blockTarget: null,
    facing: side === 'off' ? 1 : -1,
  };
}

function relPt(P, d) { return { x: P.los + d[0], y: clamp(CY + d[1], 1, FIELD_W - 1) }; }

function createPlay(o) {
  const P = {
    los: o.los, toGo: o.toGo, offTeam: o.offTeam, defTeam: o.defTeam,
    offPlay: o.offPlay, defPlay: o.defPlay, userOff: o.userOff,
    t: 0, overT: 0, phase: 'presnap', off: [], def: [], all: [], byRole: {},
    ball: { state: 'held', holder: null, x: o.los, y: CY, z: 0 },
    result: null, handoffT: -1, runT: -1, qbRun: false, catchT: -1,
    popups: [], sounds: [], cpuRead: rnd(0.8, 1.8), frame: 0, passer: null,
  };
  const form = FORMATIONS[o.offPlay.formation || 'singleback'];
  for (const r of OFF_ROLES) {
    const pt = relPt(P, form[r]);
    const p = makePlayer(o.offTeam.roster[r], 'off', pt.x, pt.y);
    P.off.push(p); P.byRole[r] = p;
  }
  const align = Object.assign({}, DEF_ALIGN, o.defPlay.align || {});
  for (const r of DEF_ROLES) {
    const pt = relPt(P, align[r]);
    const p = makePlayer(o.defTeam.roster[r], 'def', pt.x, pt.y);
    P.def.push(p); P.byRole[r] = p;
  }
  P.all = P.off.concat(P.def);
  P.ball.holder = P.byRole.QB;
  buildJobs(P);
  if (!o.userOff) P.byRole.MLB.ctrl = true;
  return P;
}

function buildRoute(p, rd) {
  const sign = (p.sy - CY) <= 0 ? 1 : -1;
  const pts = rd.pts.map(([dx, di]) => ({ x: p.sx + dx, y: clamp(p.sy + sign * di, 1, FIELD_W - 1) }));
  return { t: 'route', pts, end: rd.end };
}

function buildJobs(P) {
  const op = P.offPlay, dp = P.defPlay;
  for (const p of P.off) {
    const r = p.role;
    p.setX = p.sx - 1.4; p.setY = p.sy;
    if (op.kind === 'run') {
      if (r === 'QB') p.job = { t: 'qbRun', mesh: op.qbMesh ? relPt(P, op.qbMesh) : null };
      else if (r === 'RB') p.job = { t: 'path', pts: op.rbPath.map(d => relPt(P, d)) };
      else if (op.pull && op.pull[r]) p.job = { t: 'pull', pts: op.pull[r].map(d => relPt(P, d)) };
      else if (r === 'WR1' || r === 'WR2' || r === 'WR3') p.job = { t: 'stalk' };
      else p.job = { t: op.block || 'drive' };
    } else {
      if (r === 'QB') p.job = { t: 'qbPass' };
      else if (op.routes[r]) p.job = buildRoute(p, op.routes[r]);
      else { p.job = { t: 'pass' }; if (r === 'RB') { p.setX = p.sx - 0.5; p.setY = p.sy - 1.5; } }
    }
  }
  for (const d of P.def) {
    const a = dp.assign[d.role];
    d.job = Object.assign({}, a);
    if (a.t === 'man') d.job.target = P.byRole[a.on];
    if (a.t === 'zone') { d.job.zx = P.los + a.x; d.job.zy = CY + a.y; }
  }
}

function snap(P) {
  P.phase = 'live';
  P.t = 0;
  P.sounds.push('snap');
}

// ---------- Bewegung ----------
function accelerateTo(p, dvx, dvy, accMul) {
  const ax = dvx - p.vx, ay = dvy - p.vy;
  const m = Math.hypot(ax, ay);
  const maxA = p.acc * (accMul || 1) * DT;
  if (m > maxA) { p.vx += ax / m * maxA; p.vy += ay / m * maxA; } else { p.vx = dvx; p.vy = dvy; }
}
function spdMul(p) {
  let m = p.hasBall ? 0.94 : 1;
  if (p.stumble > 0) m *= 0.55;
  if (p.juke > 0) m *= 1.08;
  return m;
}
function steer(p, tx, ty, mul) {
  const dx = tx - p.x, dy = ty - p.y;
  const d = Math.hypot(dx, dy);
  if (d < 0.05) { accelerateTo(p, 0, 0); return; }
  const s = Math.min(p.maxSpd * (mul || 1) * spdMul(p), d * 5);
  accelerateTo(p, dx / d * s, dy / d * s);
}
function steerDir(p, dx, dy, mul) {
  const m = Math.hypot(dx, dy) || 1;
  const s = p.maxSpd * (mul || 1) * spdMul(p);
  accelerateTo(p, dx / m * s, dy / m * s);
}
function brake(p) { accelerateTo(p, 0, 0, 1.4); }

function followPath(p, pts, mul) {
  if (p.wp >= pts.length) return false;
  const t = pts[p.wp];
  if (Math.hypot(t.x - p.x, t.y - p.y) < 0.8) { p.wp++; if (p.wp >= pts.length) return false; }
  const n = pts[p.wp];
  const d = Math.hypot(n.x - p.x, n.y - p.y) || 1;
  steerDir(p, (n.x - p.x) / d, (n.y - p.y) / d, mul);
  return true;
}

function histPos(p, delay) {
  const n = Math.round(delay / DT);
  const i = p.hist.length - 2 - 2 * n;
  if (i < 0) return { x: p.hist.length ? p.hist[0] : p.x, y: p.hist.length ? p.hist[1] : p.y };
  return { x: p.hist[i], y: p.hist[i + 1] };
}

function pursue(d, c, leadMul) {
  const dd = dist(d, c);
  const lead = Math.min(dd / d.maxSpd, 1.0) * (leadMul == null ? 0.9 : leadMul);
  steer(d, c.x + c.vx * lead, c.y + c.vy * lead, 1);
}

function popup(P, text, x, y, color) {
  if (P.popups.some(pp => pp.text === text && pp.t < 0.4)) return;
  P.popups.push({ text, x, y, t: 0, color: color || '#fff' });
}

// ---------- Ballbesitz / Pässe ----------
function carrier(P) { return P.ball.state === 'held' ? P.ball.holder : null; }

function giveBall(P, p) {
  for (const q of P.all) q.hasBall = false;
  p.hasBall = true;
  P.ball = { state: 'held', holder: p, x: p.x, y: p.y, z: 0.6 };
  if (p.role !== 'QB' && P.runT < 0) P.runT = P.t;
}

function passSpeed(qb) { return 17 + qb.a.THR / 100 * 11; }
function maxThrow(qb) { return 26 + qb.a.THR / 100 * 38; }

function throwTo(P, qb, r) {
  const v = passSpeed(qb);
  let tx = r.x, ty = r.y, T = 0;
  for (let i = 0; i < 3; i++) {
    const dd = Math.hypot(tx - qb.x, ty - qb.y);
    T = dd / (v * (1 - clamp((dd - 12) / 40, 0, 0.3)));
    tx = r.x + r.vx * T; ty = r.y + r.vy * T;
  }
  let d = Math.hypot(tx - qb.x, ty - qb.y);
  const maxD = maxThrow(qb);
  if (d > maxD) { const k = maxD / d; tx = qb.x + (tx - qb.x) * k; ty = qb.y + (ty - qb.y) * k; d = maxD; }
  const pressure = P.def.some(x => !x.engaged && dist(x, qb) < 2.3) ? 1 : 0;
  const moving = Math.hypot(qb.vx, qb.vy) > 3 ? 1 : 0;
  const err = (1.25 - qb.a.ACC / 100) * (0.5 + d * 0.1 + Math.max(0, d - 15) * 0.08) * (1 + pressure * 0.8 + moving * 0.4);
  const ang = Math.random() * Math.PI * 2, m = Math.abs(gauss()) * err;
  tx += Math.cos(ang) * m; ty += Math.sin(ang) * m;
  d = Math.hypot(tx - qb.x, ty - qb.y);
  const lob = 1 - clamp((d - 12) / 40, 0, 0.3); // tiefe Bälle fliegen höher und langsamer
  P.ball = {
    state: 'air', fx: qb.x, fy: qb.y, tx, ty, t: 0, T: Math.max(0.25, d / (v * lob)),
    arc: Math.min(d / 8, 5), target: r, x: qb.x, y: qb.y, z: 1,
  };
  P.passer = qb;
  P.sounds.push('throw');
}

function throwAway(P, qb) {
  const ty = qb.y < CY ? -3 : FIELD_W + 3;
  const tx = P.los + 4;
  const d = Math.hypot(tx - qb.x, ty - qb.y);
  P.ball = { state: 'air', fx: qb.x, fy: qb.y, tx, ty, t: 0, T: d / passSpeed(qb), arc: 2, target: null, throwaway: true, x: qb.x, y: qb.y, z: 1 };
  P.passer = qb;
  P.sounds.push('throw');
}

function pitchTo(P, qb, rb) {
  const v = 13;
  let tx = rb.x, ty = rb.y, T = 0;
  for (let i = 0; i < 3; i++) {
    T = Math.hypot(tx - qb.x, ty - qb.y) / v;
    tx = rb.x + rb.vx * T; ty = rb.y + rb.vy * T;
  }
  P.ball = { state: 'air', fx: qb.x, fy: qb.y, tx, ty, t: 0, T: Math.max(0.2, T), arc: 0.8, target: rb, pitch: true, x: qb.x, y: qb.y, z: 1 };
}

function userThrow(P, key) {
  const b = P.ball;
  if (P.phase !== 'live' || !P.userOff || b.state !== 'held') return;
  const qb = b.holder;
  if (qb.role !== 'QB' || P.offPlay.kind !== 'pass' || P.qbRun) return;
  const r = P.byRole[ELIGIBLE[key - 1]];
  if (r) throwTo(P, qb, r);
}

function resolveBall(P) {
  const b = P.ball;
  if (b.pitch) {
    const r = b.target;
    if (Math.hypot(r.x - b.tx, r.y - b.ty) < 2.6) { giveBall(P, r); P.handoffT = P.t; }
    else { popup(P, 'FUMBLE!', b.tx, b.ty, '#ff6'); endPlay(P, 'tackle', { x: b.tx }); }
    return;
  }
  if (b.throwaway || b.ty < 0 || b.ty > FIELD_W || b.tx > 110) { endPlay(P, 'inc'); return; }
  let o = null, od = 1e9, d = null, dd = 1e9;
  for (const p of P.off) {
    if (!ELIGIBLE.includes(p.role)) continue;
    const q = Math.hypot(p.x - b.tx, p.y - b.ty);
    if (q < od) { od = q; o = p; }
  }
  for (const p of P.def) {
    if (p.stun > 0) continue;
    const q = Math.hypot(p.x - b.tx, p.y - b.ty);
    if (q < dd) { dd = q; d = p; }
  }
  const R = 1.6, RD = 2.1;
  if (o && od < R) {
    let p = 0.45 + o.a.HND / 100 * 0.47 - od * 0.15;
    if (d && dd < RD) {
      const cover = clamp((od - dd + 1.2) / 2.4, 0, 1);
      p -= cover * (0.25 + d.a.COV / 100 * 0.35);
      if (!chance(p)) {
        if (dd < od && chance(0.18 + d.a.HND / 100 * 0.25)) { intercept(P, d); return; }
        popup(P, 'BROKEN UP!', b.tx, b.ty, '#f88');
        endPlay(P, 'inc');
        return;
      }
    } else if (!chance(p)) {
      popup(P, 'DROP!', b.tx, b.ty, '#f88');
      endPlay(P, 'inc');
      return;
    }
    giveBall(P, o);
    o.job = { t: 'carry' };
    P.catchT = P.t;
    P.sounds.push('catch');
    popup(P, 'CATCH!', o.x, o.y - 2, '#8f8');
    for (const q of P.off) if (q !== o && q.job.t === 'route') q.job = { t: 'stalk' };
    return;
  }
  if (d && dd < 1.3 && chance(0.22 + d.a.HND / 100 * 0.3 + d.a.COV / 100 * 0.1)) { intercept(P, d); return; }
  endPlay(P, 'inc');
}

function intercept(P, d) {
  P.ball = { state: 'held', holder: d, x: d.x, y: d.y, z: 0.6 };
  popup(P, 'PICK!', d.x, d.y - 2, '#f66');
  endPlay(P, 'int', { x: d.x, by: d });
}

function endPlay(P, type, info) {
  if (P.phase !== 'live') return;
  info = info || {};
  const c = carrier(P);
  const x = info.x != null ? info.x : (c ? c.x : P.los);
  if ((type === 'tackle' || type === 'sack') && x <= 0) type = 'safety';
  P.phase = 'over';
  P.result = {
    type, x, by: info.by || null, carrier: c,
    passPlay: P.passer != null && P.catchT >= 0,
  };
  P.sounds.push(type === 'td' ? 'td' : (type === 'inc' ? 'inc' : 'whistle'));
}

// ---------- Kontrolle ----------
function updateControl(P, input) {
  const b = P.ball;
  if (P.userOff) {
    for (const p of P.off) p.ctrl = (b.state === 'held' && b.holder === p);
    return;
  }
  let cur = P.def.find(d => d.ctrl);
  if (input.action) {
    const bx = b.state === 'air' ? b.tx : b.x, by = b.state === 'air' ? b.ty : b.y;
    let best = null, bd = 1e9;
    for (const d of P.def) {
      if (d === cur) continue;
      const q = Math.hypot(d.x - bx, d.y - by);
      if (q < bd) { bd = q; best = d; }
    }
    if (best) { if (cur) cur.ctrl = false; best.ctrl = true; }
  }
}

function presnapSwitch(P) {
  if (P.userOff) return;
  const i = P.def.findIndex(d => d.ctrl);
  if (i >= 0) P.def[i].ctrl = false;
  P.def[(i + 1) % P.def.length].ctrl = true;
}

// ---------- Offense-KI ----------
function protectPoint(P) {
  const b = P.ball;
  if (b.state === 'held') return b.holder;
  if (b.state === 'air' && b.target) return b.target;
  return P.byRole.QB;
}

function findBlockTarget(P, b, mode) {
  let best = null, bd = 1e9;
  const prot = protectPoint(P);
  for (const d of P.def) {
    if (d.engaged || d.shedCd > 0) continue;
    const dx = d.x - b.x, dy = d.y - b.y;
    let s;
    if (mode === 'drive' || mode === 'pull') {
      const lane = mode === 'pull' ? 6 : 3.5 + Math.max(0, dx) * 0.3;
      if (dx < -1.5 || dx > 9 || Math.abs(dy) > lane) continue;
      s = Math.hypot(dx, dy * 1.4);
    } else if (mode === 'reach') {
      if (dx < -1.5 || dx > 9 || dy < -2.5 || dy > 7) continue;
      s = Math.hypot(dx, (dy - 1.5) * 1.2);
    } else if (mode === 'pass') {
      const ds = Math.hypot(d.x - b.setX, d.y - b.setY);
      if (ds > 4.5) continue;
      s = ds;
    } else { // stalk
      if (!DBS.includes(d.role) && P.catchT < 0) continue;
      s = Math.hypot(dx, dy);
      if (s > 13) continue;
      if (P.catchT >= 0) s += dist(d, prot) * 0.5;
    }
    if (d.claimedBy && d.claimedBy !== b) s += 4;
    if (s < bd) { bd = s; best = d; }
  }
  return best;
}

function engage(b, d) {
  b.engaged = d; d.engaged = b; b.engT = 0;
}
function release(b, d) {
  b.engaged = null; d.engaged = null;
  d.shedCd = 1.0; b.blockCd = 0.7; b.blockTarget = null;
}

function defGoal(P, d) {
  const c = carrier(P);
  if (c) return c;
  const b = P.ball;
  if (b.state === 'air') return { x: b.tx, y: b.ty };
  return P.byRole.QB;
}

function engagedMove(P, b) {
  const d = b.engaged;
  const g = defGoal(P, d);
  let ux = g.x - d.x, uy = g.y - d.y;
  const n = Math.hypot(ux, uy) || 1; ux /= n; uy /= n;
  const bp = b.a.BLK * 0.65 + b.a.STR * 0.35;
  const dp = d.a.STR * 0.65 + d.a.AGI * 0.35;
  const diff = (bp - dp) / 100;
  const isRun = P.runT >= 0 || P.offPlay.kind === 'run';
  const rate = clamp(0.3 - diff * 1.4, 0.06, 1.3) * (isRun ? 1.15 : 1.4);
  b.engT += DT;
  if (b.engT > 0.3 && Math.random() < rate * DT) { release(b, d); return; }
  // Blocks lösen sich, wenn der Ballträger schon vorbei ist
  const c = carrier(P);
  if (c && c.x > d.x + 4 && c.role !== 'QB') { release(b, d); return; }
  const s = clamp(0.5 - diff * 3, -1.2, 1.6);
  d.vx = ux * s; d.vy = uy * s;
  b.vx = d.vx; b.vy = d.vy;
  const tx = d.x + ux * 0.95, ty = d.y + uy * 0.95;
  b.x += (tx - b.x) * 0.25; b.y += (ty - b.y) * 0.25;
}

function blockJob(P, b, mode) {
  if (b.blockCd > 0) { brake(b); return; }
  let tgt = b.blockTarget;
  if (!tgt || tgt.engaged || tgt.shedCd > 0 || P.frame % 12 === 0) {
    if (tgt && tgt.claimedBy === b) tgt.claimedBy = null;
    tgt = findBlockTarget(P, b, mode);
    b.blockTarget = tgt;
    if (tgt) tgt.claimedBy = b;
  }
  if (!tgt) {
    if (mode === 'pass') steer(b, b.setX, b.setY, 0.6);
    else if (mode === 'stalk') brake(b);
    else steer(b, b.x + 2, b.y, 0.5);
    return;
  }
  const prot = protectPoint(P);
  let ux = prot.x - tgt.x, uy = prot.y - tgt.y;
  const n = Math.hypot(ux, uy) || 1;
  steer(b, tgt.x + ux / n * 0.9, tgt.y + uy / n * 0.9, 1);
  if (dist(b, tgt) < 1.15 && !tgt.engaged && tgt.shedCd <= 0) engage(b, tgt);
}

function aiRun(P, c) {
  let fx = 1.0, fy = 0;
  for (const d of P.def) {
    if (d.engaged || d.stun > 0) continue;
    const dx = c.x - d.x, dy = c.y - d.y;
    const dd = Math.hypot(dx, dy) || 0.01;
    if (dd < 7 && d.x > c.x - 2) {
      const w = 1.6 / (dd * dd + 0.5);
      fy += dy / dd * w * 3;
      fx += dx / dd * w * 0.8;
    }
  }
  if (c.y < 3) fy += (3 - c.y) * 0.5;
  if (c.y > FIELD_W - 3) fy -= (c.y - (FIELD_W - 3)) * 0.5;
  const m = Math.hypot(fx, fy) || 1;
  fx /= m; fy /= m;
  if (fx < 0.35) { fx = 0.35; const k = Math.sqrt(1 - fx * fx); fy = Math.sign(fy || 1) * k; }
  steerDir(c, fx, fy, 1);
  // CPU-Juke, wenn ein Verteidiger direkt vor ihm steht
  if (c.jukeCd <= 0 && P.def.some(d => !d.engaged && d.stun <= 0 && dist(d, c) < 1.8) && chance(0.04 + c.a.AGI / 100 * 0.06)) {
    c.juke = 0.4; c.jukeCd = 1.6;
  }
}

function cpuQB(P, qb) {
  if (!qb.dropDone) {
    steer(qb, P.los - 7, qb.sy, 0.85);
    if (qb.x <= P.los - 6.6) qb.dropDone = true;
  } else brake(qb);
  if (P.frame % 15 !== 0) return; // der QB liest nur alle 0,25 s
  const pressure = P.def.some(d => !d.engaged && d.stun <= 0 && dist(d, qb) < 2.6);
  if (P.t < P.cpuRead && !pressure) return;
  let best = null, bs = -1e9, bestSep = 0;
  for (const role of ELIGIBLE) {
    const r = P.byRole[role];
    if (r.job.t !== 'route') continue;
    const tt = dist(qb, r) / passSpeed(qb);
    const px = r.x + r.vx * tt, py = r.y + r.vy * tt;
    if (Math.hypot(px - qb.x, py - qb.y) > maxThrow(qb) || py < 1 || py > FIELD_W - 1) continue;
    let sep = 99;
    for (const d of P.def) { const q = Math.hypot(d.x - px, d.y - py); if (q < sep) sep = q; }
    const depth = px - P.los;
    const score = Math.min(sep, 6) + clamp(depth, -3, 25) * 0.12 + (depth >= P.toGo ? 0.8 : 0) + rnd(0, 1.5);
    if (score > bs) { bs = score; best = r; bestSep = sep; }
  }
  const late = P.t > P.cpuRead + 1.5;
  if (best && (bestSep > 3.2 || late || (pressure && bestSep > 1.5))) throwTo(P, qb, best);
  else if (pressure && P.t > P.cpuRead + 0.6 && chance(0.05)) throwAway(P, qb);
}

function carrierAI(P, p, input) {
  const user = P.userOff && p.ctrl;
  const op = P.offPlay;
  if (p.role === 'QB' && op.kind === 'pass' && !P.qbRun) {
    if (user) {
      const d = input.dir;
      if (d.x || d.y) steerDir(p, d.x, d.y, 0.9);
      else if (!p.dropDone) { steer(p, P.los - 7, p.sy, 0.85); if (p.x <= P.los - 6.6) p.dropDone = true; }
      else brake(p);
    } else cpuQB(P, p);
    return;
  }
  if (p.role === 'QB' && op.kind === 'run' && P.handoffT < 0) {
    if (p.job.mesh) steer(p, p.job.mesh.x, p.job.mesh.y, 0.6); else brake(p);
    if (op.toss && P.t >= 0.25) pitchTo(P, p, P.byRole.RB);
    return;
  }
  if (user) {
    const d = input.dir;
    if (d.x || d.y) { p.freeRun = true; steerDir(p, d.x, d.y, 1); }
    else if (!p.freeRun && p.job.t === 'path' && followPath(p, p.job.pts, 1)) { /* Laufweg */ }
    else if (p.role === 'QB') brake(p);
    else steerDir(p, 1, 0, 1);
    if (input.action && p.jukeCd <= 0) {
      p.juke = 0.4; p.jukeCd = 1.6;
      popup(P, 'JUKE!', p.x, p.y - 2, '#ff6');
      P.sounds.push('juke');
    }
  } else {
    if (!(p.job.t === 'path' && followPath(p, p.job.pts, 1))) aiRun(P, p);
  }
}

function offAI(P, p, input) {
  if (p.stun > 0) { brake(p); return; }
  if (p.engaged) { engagedMove(P, p); return; }
  const b = P.ball;
  if (b.state === 'held' && b.holder === p) { carrierAI(P, p, input); return; }
  if (b.state === 'air' && b.target === p) { steer(p, b.tx, b.ty, 1); return; }
  const j = p.job;
  switch (j.t) {
    case 'qbRun':
      if (P.handoffT < 0 && j.mesh && !P.offPlay.toss) steer(p, j.mesh.x, j.mesh.y, 0.6);
      else steer(p, P.los - 4, CY - 3, 0.4);
      break;
    case 'qbPass': brake(p); break;
    case 'path':
      if (!followPath(p, j.pts, 1)) steerDir(p, 1, 0, 1);
      // Handoff
      if (P.offPlay.kind === 'run' && !P.offPlay.toss && b.state === 'held' && b.holder.role === 'QB' && P.handoffT < 0 && dist(p, b.holder) < 1.1) {
        giveBall(P, p); P.handoffT = P.t;
      }
      break;
    case 'pull':
      if (!followPath(p, j.pts, 0.95)) blockJob(P, p, 'pull');
      break;
    case 'route':
      if (p.wp < j.pts.length) followPath(p, j.pts, 0.88);
      if (p.wp >= j.pts.length) {
        if (j.end === 'sit') brake(p);
        else {
          const a = j.pts.length > 1 ? j.pts[j.pts.length - 2] : { x: p.sx, y: p.sy };
          const z = j.pts[j.pts.length - 1];
          let dx = z.x - a.x, dy = z.y - a.y;
          const m = Math.hypot(dx, dy) || 1;
          const ty = clamp(p.y + dy / m * 5, 1.5, FIELD_W - 1.5);
          steer(p, Math.min(p.x + dx / m * 5, 108), ty, 0.95);
        }
      }
      break;
    case 'drive': case 'reach': case 'pass': case 'stalk':
      blockJob(P, p, j.t);
      break;
    default:
      brake(p);
  }
}

// ---------- Defense-KI ----------
function zoneTarget(P, d) {
  const j = d.job;
  let threat = null, best = 1e9;
  for (const r of P.off) {
    if (r.job.t !== 'route') continue;
    const hp = histPos(r, 0.2);
    const dz = Math.hypot(hp.x - j.zx, hp.y - j.zy);
    if (dz < j.r) {
      const s = dz - (hp.x - P.los) * 0.15;
      if (s < best) { best = s; threat = hp; }
    }
  }
  if (threat) {
    const deep = j.x > 12;
    return { x: threat.x + (deep ? 3 : 1.2), y: threat.y * 0.8 + j.zy * 0.2 };
  }
  return { x: j.zx, y: j.zy };
}

function manCover(P, d) {
  const r = d.job.target;
  if (r.job.t !== 'route') { steer(d, P.los + 4, r.y, 0.8); return; }
  const delay = clamp(0.32 - d.a.COV / 100 * 0.27, 0.04, 0.3);
  const hp = histPos(r, delay);
  const inside = Math.sign(CY - hp.y) * 0.6;
  steer(d, hp.x + 1.0, hp.y + inside, 1);
}

function defAI(P, d, input) {
  if (d.engaged) return;
  if (d.stun > 0) { brake(d); return; }
  if (!P.userOff && d.ctrl) {
    const dir = input.dir;
    if (dir.x || dir.y) { steerDir(d, dir.x, dir.y, 1); return; }
  }
  const b = P.ball;
  const c = carrier(P);
  if (b.state === 'air' && b.pitch) { pursue(d, b.target, 1); return; }
  if (b.state === 'air') {
    if (d.job.t === 'rush') { steer(d, b.fx, b.fy, 0.5); return; }
    const tl = b.T - b.t;
    const dl = Math.hypot(d.x - b.tx, d.y - b.ty);
    if (dl < d.maxSpd * tl + 4) { steer(d, b.tx, b.ty, 1); return; }
    if (b.target) pursue(d, b.target, 1); else brake(d);
    return;
  }
  const runOn = c && (c.role !== 'QB' || P.qbRun);
  if (runOn && P.runT < 0) P.runT = P.t;
  if (runOn && (P.t - P.runT >= d.react || dist(d, c) < 4)) { pursue(d, c); return; }
  const j = d.job;
  if (j.t === 'rush') { pursue(d, c || P.byRole.QB, 0.3); return; }
  if (P.offPlay.kind === 'run' && P.t > 0.35) {
    // Lauf erkannt: Richtung Ball
    const q = c || P.byRole.RB;
    if (j.t === 'man' && DBS.includes(d.role)) { manCover(P, d); return; }
    steer(d, q.x + 2, q.y, 0.8);
    return;
  }
  if (j.t === 'man') { manCover(P, d); return; }
  if (j.t === 'zone') { const z = zoneTarget(P, d); steer(d, z.x, z.y, 0.95); return; }
  brake(d);
}

// ---------- Kollisionen / Tackles ----------
function separate(P) {
  const c = carrier(P);
  const all = P.all;
  for (let i = 0; i < all.length; i++) {
    const a = all[i];
    if (a === c) continue;
    for (let k = i + 1; k < all.length; k++) {
      const b = all[k];
      if (b === c || a.engaged === b) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      if (d > 0 && d < 0.8) {
        const push = (0.8 - d) / 2;
        a.x -= dx / d * push; a.y -= dy / d * push;
        b.x += dx / d * push; b.y += dy / d * push;
      }
    }
  }
}

function checkTackles(P) {
  const c = carrier(P);
  if (!c || P.phase !== 'live' || c.side !== 'off') return;
  const inPocket = c.role === 'QB' && P.offPlay.kind === 'pass' && !P.qbRun;
  for (const d of P.def) {
    if (d.engaged || d.stun > 0) continue;
    if (dist(d, c) < 0.95) {
      const ev = c.a.AGI * 0.5 + c.a.STR * 0.5;
      let p = 0.8 + (d.a.TKL - ev) / 140;
      if (c.juke > 0) p -= 0.1 + c.a.AGI / 100 * 0.25;
      if (inPocket) p += 0.12;
      p = clamp(p, 0.2, 0.97);
      if (chance(p)) {
        endPlay(P, inPocket && c.x < P.los ? 'sack' : 'tackle', { x: c.x, by: d });
        P.sounds.push('hit');
        return;
      }
      d.stun = 0.9;
      c.stumble = 0.45;
      popup(P, 'BROKEN TACKLE!', c.x, c.y - 2, '#ff6');
      P.sounds.push('bump');
    }
  }
}

function checkBounds(P) {
  const c = carrier(P);
  if (!c || P.phase !== 'live' || c.side !== 'off') return;
  if (c.x >= 100) { endPlay(P, 'td', { x: 100 }); return; }
  if (c.y < 0 || c.y > FIELD_W) { endPlay(P, 'oob', { x: c.x }); return; }
  if (c.x < -10) endPlay(P, 'safety', { x: 0 });
}

function updateBall(P) {
  const b = P.ball;
  if (b.state === 'held') {
    const h = b.holder;
    b.x = h.x + 0.3 * h.facing; b.y = h.y; b.z = 0.6;
  } else if (b.state === 'air') {
    b.t += DT;
    const k = Math.min(b.t / b.T, 1);
    b.x = b.fx + (b.tx - b.fx) * k;
    b.y = b.fy + (b.ty - b.fy) * k;
    b.z = 1 + 4 * b.arc * k * (1 - k);
    if (k >= 1) resolveBall(P);
  }
}

function integrate(P) {
  for (const p of P.all) {
    p.x += p.vx * DT; p.y += p.vy * DT;
    p.x = clamp(p.x, -12, 112); p.y = clamp(p.y, -3, FIELD_W + 3);
    if (p.stun > 0) p.stun -= DT;
    if (p.stumble > 0) p.stumble -= DT;
    if (p.juke > 0) p.juke -= DT;
    if (p.jukeCd > 0) p.jukeCd -= DT;
    if (p.shedCd > 0) p.shedCd -= DT;
    if (p.blockCd > 0) p.blockCd -= DT;
    const sp = Math.hypot(p.vx, p.vy);
    p.anim += sp * DT;
    if (p.vx > 0.4) p.facing = 1; else if (p.vx < -0.4) p.facing = -1;
    p.hist.push(p.x, p.y);
    if (p.hist.length > 90) p.hist.splice(0, 2);
  }
}

function stepPlay(P, input) {
  P.frame++;
  for (const pp of P.popups) pp.t += DT;
  P.popups = P.popups.filter(pp => pp.t < 1.2);
  if (P.phase === 'over') {
    P.overT += DT;
    for (const p of P.all) brake(p);
    integrate(P);
    updateBall(P);
    return;
  }
  if (P.phase !== 'live') return;
  P.t += DT;
  if (input.throwKey) userThrow(P, input.throwKey);
  const b = P.ball;
  if (b.state === 'held' && b.holder.role === 'QB' && b.holder.x > P.los + 0.3) P.qbRun = true;
  updateControl(P, input);
  for (const p of P.off) offAI(P, p, input);
  for (const d of P.def) defAI(P, d, input);
  integrate(P);
  separate(P);
  updateBall(P);
  checkTackles(P);
  checkBounds(P);
}
