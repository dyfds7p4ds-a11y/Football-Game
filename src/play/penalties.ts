/**
 * Penalty definitions and the flag that marks a foul (pure). PlaySim decides
 * when a foul happens; game/penalties.ts enforces it after the play.
 * Tunables in data/penalties.json.
 */
import type { Rng } from '../core/rng';
import type { Vec2 } from '../core/vec';
import penaltiesJson from '../data/penalties.json';

export type FoulType = 'falseStart' | 'offside' | 'holdingOffense' | 'holdingDefense' | 'passInterference' | 'roughingPasser' | 'facemask';

export interface PenaltyDef {
  label: string;
  side: 'off' | 'def';
  yards: number;
  /** Dead-ball foul: the play never happens. */
  dead?: boolean;
  /** Ball goes to the spot of the foul. */
  spotFoul?: boolean;
  autoFirst?: boolean;
  /** Which foul is called when several happen on one play (higher wins). */
  severity: number;
  /** Base chance per opportunity (see PlaySim for what counts as one). */
  chance: number;
}

export const PENALTIES = penaltiesJson as {
  types: Record<FoulType, PenaltyDef>;
  flag: { throwDelay: number; flightTime: number; peakHeight: number; calloutDelay: number };
  lateHitWindow: number;
  holdingContactRange: number;
  dpiReach: number;
};

export interface Foul {
  type: FoulType;
  side: 'off' | 'def';
  /** Spot of the foul (offense frame). */
  spot: Vec2;
  /** Sim time of the foul. */
  t: number;
  yards: number;
  autoFirst: boolean;
  spotFoul: boolean;
  dead: boolean;
  label: string;
}

/** A thrown flag: arcs from the official's hand to the spot of the foul. */
export interface Flag {
  foul: Foul;
  official: number;
  from: Vec2;
  to: Vec2;
  /** Sim time the flag leaves the official's hand. */
  t0: number;
  T: number;
}

/** Scale factors for penalty chances per side (crowd noise, difficulty...). */
export interface PenaltyBias {
  off: number;
  def: number;
}

export function makeFoul(type: FoulType, spot: Vec2, t: number): Foul {
  const d = PENALTIES.types[type];
  return {
    type, side: d.side, spot: { ...spot }, t, yards: d.yards, autoFirst: !!d.autoFirst, spotFoul: !!d.spotFoul,
    dead: !!d.dead, label: d.label,
  };
}

/**
 * One flag per play: of the current call and a new candidate foul, the more
 * severe one is called (a tie keeps the current call). Returns the foul to call.
 */
export function callFoul(current: Foul | null, candidate: Foul): Foul {
  if (!current) return candidate;
  return PENALTIES.types[candidate.type].severity > PENALTIES.types[current.type].severity ? candidate : current;
}

/** Roll for a foul of this type, scaled by the side's bias and an optional extra factor. */
export function rollFoul(type: FoulType, bias: PenaltyBias, rng: Rng, factor = 1): boolean {
  const d = PENALTIES.types[type];
  return rng.chance(d.chance * (d.side === 'off' ? bias.off : bias.def) * factor);
}

/** Flag position at sim time `t` (x, y on the field plus height h), or null before it is thrown. */
export function flagPosition(f: Flag, t: number): { x: number; y: number; h: number; landed: boolean } | null {
  if (t < f.t0) return null;
  const k = Math.min(1, (t - f.t0) / f.T);
  const h = 2.0 * (1 - k) + PENALTIES.flag.peakHeight * 4 * k * (1 - k);
  return { x: f.from.x + (f.to.x - f.from.x) * k, y: f.from.y + (f.to.y - f.from.y) * k, h: Math.max(0.02, h), landed: k >= 1 };
}

/** "HOLDING · OFFENSE · 10 YARDS" */
export function calloutText(f: Foul, offenseName: string, defenseName: string): { title: string; sub: string } {
  const team = f.side === 'off' ? offenseName : defenseName;
  const yards = f.spotFoul ? 'spot foul' : `${f.yards} yards`;
  const extra = f.autoFirst ? ', automatic first down' : f.dead ? ', replay the down' : '';
  return { title: `FLAG: ${f.label.toUpperCase()}`, sub: `${team}, ${yards}${extra}` };
}
