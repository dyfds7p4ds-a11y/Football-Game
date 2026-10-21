import { it } from 'vitest';
import { runPlay } from '../tests/simHarness';
import { PlaySim } from '../src/play/sim';
it('dbg', () => {
  const orig = PlaySim.prototype.step;
  let n = 0;
  PlaySim.prototype.step = function (this: PlaySim, inp, dt) {
    orig.call(this, inp, dt);
    if (n++ % 30 === 0 && this.t > 3 && !this.result) {
      const nb = this.getDef('CB2');
      const c = this.carrier!;
      console.log(this.t.toFixed(2), c.slot, c.pos.x.toFixed(2), c.pos.y.toFixed(2), c.vel.y.toFixed(2), 'cb', nb.pos.x.toFixed(2), nb.pos.y.toFixed(2), nb.vel.x.toFixed(2), nb.vel.y.toFixed(2), nb.maxSpeed, nb.tackleCooldown, (this as any).runRecognizedAt);
    }
  };
  const r = runPlay('quick_outs', 'cover3', +(process.env.SEED ?? 1), { throwAt: 1.0, target: 'WR2', dropFor: 0.6 });
  PlaySim.prototype.step = orig; console.log(r.result?.outcome, r.events.map(e=>e.type+r.sim.actors[e.actor??0].slot).join(' '));
});
