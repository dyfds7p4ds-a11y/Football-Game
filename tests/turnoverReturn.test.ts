import { afterEach, describe, expect, it } from 'vitest';
import { add, dist, norm, scale, sub, v2, type Vec2 } from '../src/core/vec';
import { DIFFICULTY, getPlay, getTeam } from '../src/data';
import { applyPlay } from '../src/game/rules';
import { newGame } from '../src/game/state';
import { getDefenseCall } from '../src/play/defenseCalls';
import { DEF_CONTROL } from '../src/play/interception';
import { PlaySim, TURNOVERS, idleInput, type PlayEvent, type SimInput } from '../src/play/sim';
import { THROW, throwWindow } from '../src/play/throw';
import { runPlay } from './simHarness';

const mk = (seed: number, userDefense: boolean, play = 'four_verts', def = 'cover1') => new PlaySim({
  play: getPlay(play), defense: getDefenseCall(def), offenseTeam: getTeam('rheinstadt'), defenseTeam: getTeam('elbtal'),
  ballX: 0, los: 30, difficulty: DIFFICULTY.normal, seed, penaltyBias: { off: 0, def: 0 }, userDefense,
});

/**
 * QB throws to WR1 at 2.2 s; the user's CB1 breaks on the ball and jumps on time.
 * After the pick, `ret` steers the returner (user defense). Returns the sim and its events.
 */
function pick(seed: number, ret: (sim: PlaySim) => Vec2 = () => v2(0, -1)) {
  const sim = mk(seed, true);
  const cb = () => sim.userDefender!;
  let chargeUntil = Infinity;
  let jumpAt = Infinity;
  const events: PlayEvent[] = [];
  let returning = false;
  let moved: { from: Vec2; to: Vec2 } | null = null;
  let startT = 0;
  let from: Vec2 | null = null;
  for (let i = 0; i < 60 * 30 && !sim.result; i++) {
    const inp = idleInput();
    inp.target = 'WR1';
    if (sim.t < 0.6) inp.move = v2(0, -1);
    if (sim.t >= 2.2 && sim.canThrow()) {
      const c = throwWindow(dist(sim.get('QB').pos, sim.get('WR1').pos), 1).center;
      if (chargeUntil === Infinity && sim.charge + 1 / 60 / THROW.chargeTime >= c) chargeUntil = sim.t;
      inp.throwHeld = sim.t < chargeUntil;
    }
    const f = sim.ball.state === 'air' && sim.ball.flight && !sim.ball.flight.lateral ? sim.ball.flight : null;
    if (f && jumpAt === Infinity) jumpAt = sim.t + (f.T - f.t) - DEF_CONTROL.jump.peakAt;
    if (sim.returning) {
      if (!returning) {
        startT = sim.t;
        from = { ...cb().pos };
      }
      returning = true;
      inp.defense = { move: ret(sim), jump: false };
      sim.step(inp);
      // Once his jump and momentum are gone, the stick decides where he goes.
      if (!moved && !sim.result && sim.t - startT > 1.5) moved = { from: from!, to: { ...cb().vel } };
    } else {
      const wr = sim.get('WR1');
      const goal = f ? f.landing : add(wr.pos, scale(wr.vel, 0.6));
      inp.defense = { move: dist(goal, cb().pos) > 0.3 ? norm(sub(goal, cb().pos)) : v2(), jump: sim.t >= jumpAt && sim.t < jumpAt + 1 / 30 };
      sim.step(inp);
    }
    events.push(...sim.drainEvents());
  }
  return { sim, events, returning, moved };
}

const picks = (n: number, ret?: (sim: PlaySim) => Vec2) => {
  const out: ReturnType<typeof pick>[] = [];
  for (let s = 1; s < 200 && out.length < n; s++) {
    const r = pick(s, ret);
    if (r.events.some((e) => e.type === 'interception')) out.push(r);
  }
  return out;
};

describe('Phase 3c: interception returns', () => {
  it('the play goes on after a pick; the user controls the interceptor until a tackle, the sideline or the end zone', () => {
    const ps = picks(5);
    expect(ps.length).toBe(5);
    for (const p of ps) {
      expect(p.returning).toBe(true);
      const r = p.sim.result!;
      expect(r.outcome).toBe('interception');
      expect(r.fumble).toBe(false);
      expect(r.returnYards).toBeDefined();
      // The stick moves him (sim frame: the offense's goal line is -y).
      if (p.moved) expect(p.moved.to.y).toBeLessThan(-3); // running toward the offense's goal line
      const end = p.events.filter((e) => e.type === 'tackle' || e.type === 'outOfBounds' || e.type === 'touchdown');
      expect(end.length).toBeGreaterThan(0);
      expect(r.description).toMatch(/Intercepted/);
    }
    // Tackled by the offense with the shared tackle model (an offensive player makes the tackle).
    const tackled = ps.filter((p) => p.events.some((e) => e.type === 'tackle'));
    expect(tackled.length).toBeGreaterThan(0);
    for (const p of tackled) {
      const t = p.events.find((e) => e.type === 'tackle')!;
      expect(p.sim.actors[t.actor!].side).toBe('def'); // the tackle event names the carrier who went down
    }
  }, 60000);

  it('running to the sideline ends the return out of bounds at the spot', () => {
    const ps = picks(2, (sim) => v2(Math.sign(sim.userDefender!.pos.x) || 1, -0.2));
    for (const p of ps) {
      const r = p.sim.result!;
      expect(r.outcome).toBe('interception');
      if (p.events.some((e) => e.type === 'outOfBounds')) expect(Math.abs(r.endX)).toBeGreaterThan(25);
    }
  }, 60000);

  it('the rules give the defense the ball where the return ended, and a return to the end zone is a pick six', () => {
    const g = newGame({ home: 'rheinstadt', away: 'elbtal', userSide: 'home', difficulty: 'normal', quarterLength: 300, seed: 1 });
    const s = { ...g, possession: 'home' as const, ballY: 30 };
    const ret = applyPlay(s, { outcome: 'interception', endY: 22, endX: 0 });
    expect(ret.state.possession).toBe('away');
    expect(ret.state.ballY).toBe(78);
    expect(applyPlay(s, { outcome: 'interception', endY: 0, endX: 0 }).headline).toBe('PICK SIX!');
    expect(applyPlay(s, { outcome: 'interception', endY: 0, endX: 0, fumble: true }).headline).toBe('SCOOP AND SCORE!');
    expect(applyPlay(s, { outcome: 'interception', endY: 40, endX: 0, fumble: true }).headline).toBe('FUMBLE LOST');
  });

  it('a CPU pick of the user pass: the user steers the nearest offensive player and can make the tackle', () => {
    let found = 0;
    for (let s = 1; s < 300 && found < 3; s++) {
      const sim = mk(s, false, 'four_verts', 'cover2');
      let steered = false;
      for (let i = 0; i < 60 * 30 && !sim.result; i++) {
        const inp: SimInput = idleInput();
        inp.target = 'WR3';
        if (sim.t < 0.6) inp.move = v2(0, -1);
        if (sim.t >= 2.6 && sim.canThrow()) inp.throwHeld = sim.charge < 0.75;
        const me = sim.actors[sim.controlledId];
        if (sim.returning && me) {
          expect(me.side).toBe('off');
          inp.move = norm(sub(sim.carrier!.pos, me.pos));
          steered = true;
        }
        sim.step(inp);
      }
      if (steered) {
        found++;
        expect(sim.result!.outcome).toBe('interception');
      }
    }
    expect(found).toBeGreaterThan(0);
  }, 60000);
});

describe('Phase 3c: fumbles', () => {
  const saved = { ...TURNOVERS.fumble };
  afterEach(() => Object.assign(TURNOVERS.fumble, saved));

  it('a fumble on the tackle is live: the ball is loose, someone recovers it, a defensive recovery is returned', () => {
    Object.assign(TURNOVERS.fumble, { base: 1, max: 1 });
    let defRec = 0, offRec = 0, plays = 0;
    for (let s = 1; s <= 40; s++) {
      const r = runPlay('hb_dive', 'cover3', s, { throwAt: null, target: null });
      const ev = r.events.map((e) => e.type);
      if (!ev.includes('fumble')) continue;
      plays++;
      const rec = r.events.find((e) => e.type === 'recovery');
      if (!rec) {
        expect(['outOfBounds', 'safety', 'interception']).toContain(r.result!.outcome); // out of bounds / out of the end zone
        continue;
      }
      if (r.sim.actors[rec.actor!].side === 'def') {
        defRec++;
        expect(r.result!.outcome).toBe('interception');
        expect(r.result!.fumble).toBe(true);
        expect(r.result!.description).toMatch(/Fumble/);
      } else offRec++;
    }
    expect(plays).toBeGreaterThan(20);
    expect(defRec).toBeGreaterThan(0);
    expect(offRec).toBeGreaterThan(0);
  }, 60000);

  it('fumbles are rare at the default rates', () => {
    let fumbles = 0, n = 0;
    for (const play of ['hb_dive', 'hb_stretch', 'slants', 'curl_flat']) for (let s = 1; s <= 40; s++) {
      const r = runPlay(play, 'cover3', s, { throwAt: play.startsWith('hb') ? null : 1.0, target: play === 'slants' ? 'WR1' : play === 'curl_flat' ? 'WR2' : null });
      n++;
      if (r.events.some((e) => e.type === 'fumble')) fumbles++;
    }
    expect(fumbles / n).toBeLessThan(0.06);
  }, 60000);

  it('a returner at the sideline is placed back on the field', () => {
    const sim = mk(3, true);
    const d = sim.getDef('FS');
    d.pos = v2(40, 120);
    sim.ball.state = 'held';
    sim.ball.holder = d.id;
    (sim as unknown as { startReturn(k: string, a: typeof d): void }).startReturn('fumble', d);
    expect(Math.abs(d.pos.x)).toBeLessThan(26.67);
    expect(d.pos.y).toBeLessThan(110);
    expect(sim.userDefId).toBe(d.id);
  });
});
