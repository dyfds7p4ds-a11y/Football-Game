/**
 * Phase 4: defensive audibles (pure). Before the snap the user can change the
 * defensive call to another coverage shell or a blitz look (2-3 options each,
 * `defensiveOptions`). Every change costs play-clock time (`defAudibleCost`).
 * The CPU offense re-reads the new look after a difficulty-dependent delay and,
 * if it recognizes it, checks to a play from its same-formation audible list
 * that beats the look (`offenseCounter`); a snap before the re-read catches it
 * in its old play. Tunables: data/defAudibles.json.
 */
import type { Rng } from '../core/rng';
import { PLAYS } from '../data';
import json from '../data/defAudibles.json';
import type { Difficulty, PlayData } from '../data/types';
import type { ClockState } from '../game/clock';
import { audibleOptions, isBlitz } from './audible';
import { getDefenseCall, type DefenseCall } from './defenseCalls';

export type LookClass = 'blitz' | 'man' | 'cover2' | 'cover3';

export const DEF_AUDIBLES = json as unknown as {
  maxPerPlay: number;
  maxOptions: number;
  cost: { first: number; step: number };
  minPlayClock: number;
  minAfterAdjust: number;
  shells: string[];
  blitzLooks: string[];
  cpuOffense: Record<Difficulty, { react: number; read: number }>;
  counters: Record<LookClass, string[]>;
};

/** The calls the user can change to: other coverage shells and blitz looks (each 2-3). */
export function defensiveOptions(current: DefenseCall): { shell: DefenseCall[]; blitz: DefenseCall[] } {
  const pick = (ids: string[]) => ids.filter((id) => id !== current.id).slice(0, DEF_AUDIBLES.maxOptions).map(getDefenseCall);
  return { shell: pick(DEF_AUDIBLES.shells), blitz: pick(DEF_AUDIBLES.blitzLooks) };
}

/** Play-clock seconds the k-th change (1-based) costs. */
export function defAudibleCost(k: number): number {
  return DEF_AUDIBLES.cost.first + (Math.max(1, k) - 1) * DEF_AUDIBLES.cost.step;
}

/** What the offense sees in a call: a blitz, man coverage, or a two- / three-deep zone. */
export function lookClass(call: DefenseCall): LookClass {
  if (isBlitz(call)) return 'blitz';
  if (call.shell === 'cover2') return 'cover2';
  if (call.shell === 'cover3') return 'cover3';
  return 'man';
}

/** The CPU offense's answer to a look: its play if it already beats it, else the first same-formation check that does, else its play. */
export function offenseCounter(play: PlayData, look: DefenseCall, plays: PlayData[] = PLAYS): PlayData {
  const good = DEF_AUDIBLES.counters[lookClass(look)];
  if (good.includes(play.id)) return play;
  const opts = audibleOptions(play, plays);
  for (const id of good) {
    const o = opts.find((p) => p.id === id);
    if (o) return o;
  }
  return play;
}

/** One defensive pre-snap: the changes so far and the CPU offense's pending re-read. */
export class DefAudibleSession {
  count = 0;
  /** Play-clock seconds spent on changes (the snap's game-clock runoff ignores them). */
  spent = 0;
  /** Seconds since the play was called. */
  t = 0;
  /** The offense's re-read: the play it checks to and when (null play = recognizes nothing, keeps its play). */
  pending: { at: number; play: PlayData } | null = null;

  constructor(public defense: DefenseCall, public play: PlayData, private difficulty: Difficulty, private rng: Rng) {}

  get options() {
    return defensiveOptions(this.defense);
  }

  /** Can the user still change the call with `clock` (count and play clock)? */
  canAdjust(clock: ClockState): boolean {
    return this.count < DEF_AUDIBLES.maxPerPlay && clock.playClock - defAudibleCost(this.count + 1) >= DEF_AUDIBLES.minPlayClock;
  }

  /** Change to `call`: costs play clock, starts the offense's re-read. Returns the new clock (null: not allowed). */
  call(call: DefenseCall, clock: ClockState): { clock: ClockState; cost: number } | null {
    if (call.id === this.defense.id || !this.canAdjust(clock)) return null;
    this.count++;
    const cost = defAudibleCost(this.count);
    this.spent += cost;
    this.defense = call;
    const cfg = DEF_AUDIBLES.cpuOffense[this.difficulty];
    const next = this.rng.chance(cfg.read) ? offenseCounter(this.play, call) : this.play;
    this.pending = { at: this.t + cfg.react, play: next };
    return { clock: { ...clock, playClock: clock.playClock - cost }, cost };
  }

  /** Advance the pre-snap clock; returns the offense's new play when its re-read lands and it changes (null otherwise). */
  update(dt: number): PlayData | null {
    this.t += dt;
    if (!this.pending || this.t < this.pending.at) return null;
    const p = this.pending.play;
    this.pending = null;
    if (p.id === this.play.id) return null;
    this.play = p;
    return p;
  }
}
