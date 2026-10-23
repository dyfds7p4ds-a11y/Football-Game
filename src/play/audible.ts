/**
 * Audibles (Phase 3c, pure). Before the snap the QB can check to one of 2-3
 * plays from the same formation (`audibleOptions`). Every audible costs
 * play-clock time, and each one costs more than the last (`audibleCost`).
 * The CPU defense sees the check and re-reads after a difficulty-dependent
 * delay (`audibleReact`), picking the right counter with chance
 * `audibleRead`; a snap before that catches it in the old call. A run
 * audible against a blitz look the defense did not adjust to earns an edge
 * in the sim (`PlaySim.audibleEdge`). Tunables: data/audibles.json.
 */
import type { Rng } from '../core/rng';
import { PLAYS } from '../data';
import audJson from '../data/audibles.json';
import type { DifficultyConfig, PlayData } from '../data/types';
import type { ClockState } from '../game/clock';
import { getDefenseCall, type DefenseCall } from './defenseCalls';

export const AUDIBLES = audJson as unknown as {
  maxPerPlay: number;
  cost: { first: number; step: number };
  counters: { run: string[]; pass: string[] };
  edge: { blitzRunRead: number; lineGrade: number; blitzTackle: number };
  options: Record<string, string[]>;
};

/** The plays the QB can check to from `play` (2-3, same formation). */
export function audibleOptions(play: PlayData, plays: PlayData[] = PLAYS): PlayData[] {
  const ids = AUDIBLES.options[play.id] ?? plays.filter((p) => p.id !== play.id && p.formation === play.formation).map((p) => p.id);
  return ids.map((id) => plays.find((p) => p.id === id)).filter((p): p is PlayData => !!p).slice(0, 3);
}

/** Play-clock seconds the k-th audible (1-based) of a play costs. */
export function audibleCost(k: number): number {
  return AUDIBLES.cost.first + (Math.max(1, k) - 1) * AUDIBLES.cost.step;
}

/** A call that sends anyone but the front four (a blitz look). */
export function isBlitz(call: DefenseCall): boolean {
  return Object.entries(call.assignments).some(([slot, a]) => a.kind === 'rush' && !/^D[ET]\d$/.test(slot));
}

/** The CPU defense's answer to an audible: the right counter with chance `audibleRead`, else its old call. */
export function counterCall(play: PlayData, current: DefenseCall, diff: DifficultyConfig, rng: Rng): DefenseCall {
  if (!rng.chance(diff.audibleRead)) return current;
  const list = play.run ? AUDIBLES.counters.run : AUDIBLES.counters.pass;
  if (list.includes(current.id)) return current; // already in a good call
  return getDefenseCall(list[rng.int(0, list.length - 1)]);
}

/** One pre-snap: the audibles called so far and the defense's pending re-read. */
export class AudibleSession {
  count = 0;
  /** Seconds since the play was called (the presnap clock of this session). */
  t = 0;
  /** The defense's re-read: the call it switches to and when. */
  pending: { at: number; call: DefenseCall } | null = null;
  /** Did the defense already answer the last audible? */
  adjusted = true;

  constructor(public play: PlayData, public defense: DefenseCall, private diff: DifficultyConfig, private rng: Rng) {}

  get options(): PlayData[] {
    return audibleOptions(this.play);
  }

  get canAudible(): boolean {
    return this.count < AUDIBLES.maxPerPlay;
  }

  /** Check to `play`: costs play-clock time, starts the defense's re-read. Returns the new clock (null: not allowed). */
  call(play: PlayData, clock: ClockState): { clock: ClockState; cost: number } | null {
    if (!this.canAudible || play.id === this.play.id) return null;
    this.count++;
    const cost = audibleCost(this.count);
    this.play = play;
    this.adjusted = false;
    this.pending = { at: this.t + this.diff.audibleReact, call: counterCall(play, this.defense, this.diff, this.rng) };
    return { clock: { ...clock, playClock: Math.max(0, clock.playClock - cost) }, cost };
  }

  /** Advance the presnap clock; returns the defense's new call when its re-read lands (null otherwise). */
  update(dt: number): DefenseCall | null {
    this.t += dt;
    if (!this.pending || this.t < this.pending.at) return null;
    const call = this.pending.call;
    this.pending = null;
    this.adjusted = true;
    const changed = call.id !== this.defense.id;
    this.defense = call;
    return changed ? call : null;
  }

  /** At the snap: a run audible against a blitz look the defense has not adjusted to. */
  get edge(): boolean {
    return this.count > 0 && !this.adjusted && !!this.play.run && isBlitz(this.defense);
  }
}
