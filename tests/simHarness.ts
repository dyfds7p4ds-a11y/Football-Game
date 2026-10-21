import { DIFFICULTY, getPlay, getTeam } from '../src/data';
import type { Difficulty, EligibleSlot } from '../src/data/types';
import { dist } from '../src/core/vec';
import { getDefenseCall } from '../src/play/defenseCalls';
import { PlaySim, idleInput, type PlayEvent } from '../src/play/sim';
import { THROW, throwWindow } from '../src/play/throw';

export interface Script {
  /** Seconds after the snap to start charging a throw (null = never throw). */
  throwAt: number | null;
  target: EligibleSlot | null;
  /** Charge offset from the ideal (0 = perfect). */
  chargeError?: number;
  /** Joystick held downfield-negative (drop back) for this long. */
  dropFor?: number;
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
      if (chargeUntil === Infinity && script.target) {
        const d = dist(sim.get('QB').pos, sim.get(script.target).pos);
        const c = throwWindow(d, DIFFICULTY[difficulty].throwWindow).center + (script.chargeError ?? 0);
        chargeUntil = sim.t + c * THROW.chargeTime;
      }
      inp.throwHeld = sim.t < chargeUntil;
    }
    sim.step(inp);
    events.push(...sim.drainEvents());
    if (sim.result) afterResult++;
  }
  return { sim, result: sim.result, events };
}
