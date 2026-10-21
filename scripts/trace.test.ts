import { it } from 'vitest';
import { runPlay } from '../tests/simHarness';
import { PlaySim } from '../src/play/sim';
import { dist } from '../src/core/vec';
it('trace', () => {
  const [play, def, at, target, seed] = (process.env.TRACE ?? 'slants,cover3,1.0,WR1,1').split(',');
  // monkeypatch step to log
  const orig = PlaySim.prototype.step;
  let n = 0;
  PlaySim.prototype.step = function (this: PlaySim, inp, dt) {
    orig.call(this, inp, dt);
    if (n++ % 15 === 0 && !this.result) {
      const c = this.carrier ?? this.get('QB');
      const defs = this.actors.filter((a) => a.side === 'def').map((a) => ({ a, d: dist(a.pos, c.pos) })).sort((x, y) => x.d - y.d).slice(0, 3);
      console.log(this.t.toFixed(2), c.slot, c.pos.x.toFixed(1), c.pos.y.toFixed(1), 'p', this.pressure.toFixed(2), defs.map((x) => `${x.a.slot}:${x.d.toFixed(1)}@${x.a.pos.x.toFixed(0)},${x.a.pos.y.toFixed(0)}`).join(' '));
    }
  };
  const r = runPlay(play, def, +seed, { throwAt: at === 'null' ? null : +at, target: target === 'null' ? null : (target as any), dropFor: 0.6 });
  PlaySim.prototype.step = orig;
  console.log(r.result?.description, r.result?.outcome);
  console.log(r.events.map((e) => `${e.t.toFixed(2)} ${e.type} ${e.actor !== undefined ? r.sim.actors[e.actor].slot : ''}`).join(' | '));
});
