import { DIFFICULTY, getPlay, getTeam } from '../src/data';
import type { Difficulty, EligibleSlot } from '../src/data/types';
import { dist } from '../src/core/vec';
import { DEFENSE_CALLS, getDefenseCall } from '../src/play/defenseCalls';
import { inPhase, throwingWindow } from '../src/play/windows';
import { PlaySim, SIM_DT, idleInput, type PlayEvent, type SimInput } from '../src/play/sim';
import { THROW, throwWindow } from '../src/play/throw';

export interface Script {
  /** Seconds after the snap to start charging a throw (null = never throw). */
  throwAt: number | null;
  target: EligibleSlot | null;
  /** Charge offset from the ideal (0 = perfect). */
  chargeError?: number;
  /** Joystick held downfield-negative (drop back) for this long. */
  dropFor?: number;
  /** Called after every step (balance probes sample the sim here). */
  onStep?: (sim: PlaySim) => void;
  /** Adjust the input before each step (custom movement, slides, ...). */
  script?: (sim: PlaySim, inp: SimInput) => void;
}

export function runPlay(playId: string, defId: string, seed: number, script: Script, difficulty: Difficulty = 'normal') {
  const sim = new PlaySim({
    play: getPlay(playId), defense: getDefenseCall(defId), offenseTeam: getTeam('rheinstadt'), defenseTeam: getTeam('elbtal'),
    ballX: 0, los: 30, difficulty: DIFFICULTY[difficulty], seed,
  });
  const events: PlayEvent[] = [];
  let chargeUntil = Infinity;
  let afterResult = 0;
  for (let i = 0; i < 60 * 30 && afterResult < 5; i++) {
    const inp = idleInput();
    inp.target = script.target;
    if (script.dropFor && sim.t < script.dropFor) inp.move = { x: 0, y: -1 };
    if (script.throwAt !== null && sim.t >= script.throwAt && sim.canThrow()) {
      if (script.target) {
        // Release when the charge reaches the sweet spot for the receiver's
        // current distance (the HUD window moves with him), plus any error.
        const d = dist(sim.get('QB').pos, sim.get(script.target).pos);
        const c = throwWindow(d, DIFFICULTY[difficulty].throwWindow).center + (script.chargeError ?? 0);
        if (chargeUntil === Infinity && sim.charge + SIM_DT / THROW.chargeTime >= c) chargeUntil = sim.t;
      }
      inp.throwHeld = sim.t < chargeUntil;
    }
    script.script?.(sim, inp);
    sim.step(inp);
    script.onStep?.(sim);
    events.push(...sim.drainEvents());
    if (sim.result) afterResult++;
  }
  return { sim, result: sim.result, events };
}

export interface OpenRateOptions {
  sampleTime: number;
  dropFor: number;
  seeds: number;
  openMargin: number;
  inPhaseDist: number;
  difficulty?: Difficulty;
}

/**
 * Fraction of snaps (all CPU coverages x seeds) in which each receiver is
 * open at `sampleTime`: a perfect throw would beat every defender to the
 * catch point by `openMargin` seconds and no defender is in phase with him.
 * Snaps that end before the sample time (sacks) are not counted.
 */
export function openRates(playId: string, slots: EligibleSlot[], o: OpenRateOptions): { rates: Record<string, number>; any: number; samples: number } {
  const open: Record<string, number> = Object.fromEntries(slots.map((s) => [s, 0]));
  let any = 0;
  let samples = 0;
  for (const d of DEFENSE_CALLS) {
    for (let s = 0; s < o.seeds; s++) {
      let done = false;
      runPlay(playId, d.id, s * 13 + 1, {
        throwAt: null, target: null, dropFor: o.dropFor,
        onStep: (sim) => {
          if (done || sim.result || sim.t < o.sampleTime) return;
          done = true;
          samples++;
          const qb = sim.get('QB');
          const defs = sim.actors.filter((a) => a.side === 'def' && !a.down);
          let anyOpen = false;
          for (const slot of slots) {
            const r = sim.get(slot);
            const w = throwingWindow(qb.pos, r, defs);
            if (w.margin > o.openMargin && !defs.some((x) => inPhase(r, x, o.inPhaseDist))) {
              open[slot]++;
              anyOpen = true;
            }
          }
          if (anyOpen) any++;
        },
      }, o.difficulty ?? 'normal');
    }
  }
  const n = Math.max(1, samples);
  return { rates: Object.fromEntries(slots.map((s) => [s, open[s] / n])), any: any / n, samples };
}
