/**
 * What the crowd should sound like (pure, testable): layer gains from the
 * crowd meter and the crowd's reaction to a play or a flag. CrowdAudio turns
 * this into Web Audio nodes. Tunables in data/audio.json.
 */
import { clamp } from '../core/vec';
import audioJson from '../data/audio.json';
import type { PlayForCrowd } from '../game/crowd';

type Envelope = { gain: number; attack: number; hold: number; release: number };

export const AUDIO = audioJson as {
  master: number;
  layers: Record<'murmur' | 'chatter' | 'chant', { quiet: number; loud: number }>;
  chantFrom: number;
  chantBpm: number;
  reactions: Record<'cheer' | 'roar' | 'boo', Envelope>;
  silence: { level: number; fall: number; hold: number; recover: number };
  bigPlayYards: number;
  sfx: { whistle: number; thump: number };
};

export type ReactionKind = 'cheer' | 'roar' | 'boo' | 'silence';

export interface Reaction {
  kind: ReactionKind;
  /** 0..1 */
  intensity: number;
}

export interface LayerGains {
  murmur: number;
  chatter: number;
  chant: number;
}

/** Crowd meter 0..100 -> gain of each ambience layer. */
export function layerGains(meter: number): LayerGains {
  const k = clamp(meter / 100, 0, 1);
  const lerp = (l: { quiet: number; loud: number }, t: number) => l.quiet + (l.loud - l.quiet) * t;
  const chantK = clamp((meter - AUDIO.chantFrom) / (100 - AUDIO.chantFrom), 0, 1);
  return {
    murmur: lerp(AUDIO.layers.murmur, k),
    chatter: lerp(AUDIO.layers.chatter, k),
    chant: chantK > 0 ? lerp(AUDIO.layers.chant, chantK) : 0,
  };
}

/**
 * The home crowd's reaction to a finished play (null: no reaction beyond the
 * ambience). Turnovers by the home team and opponent scores silence the
 * stadium; home touchdowns get a short roar; flags on the home team are booed.
 */
export function reactionTo(p: PlayForCrowd): Reaction | null {
  if (p.score) return p.score.home ? { kind: p.score.points >= 6 ? 'roar' : 'cheer', intensity: p.score.points >= 6 ? 1 : 0.7 } : { kind: 'silence', intensity: 1 };
  if (p.turnover) return p.homeOffense ? { kind: 'silence', intensity: 1 } : { kind: 'roar', intensity: 0.8 };
  if (p.failedFourthDown) return p.homeOffense ? { kind: 'silence', intensity: 0.7 } : { kind: 'cheer', intensity: 0.8 };
  if (p.penaltyOnHome === true) return { kind: 'boo', intensity: 0.8 };
  if (p.penaltyOnHome === false) return { kind: 'cheer', intensity: 0.35 };
  if (p.sack) return p.homeOffense ? null : { kind: 'cheer', intensity: 0.8 };
  if (p.homeOffense && p.yards >= AUDIO.bigPlayYards) return { kind: 'cheer', intensity: clamp(0.5 + (p.yards - AUDIO.bigPlayYards) / 40, 0.5, 1) };
  if (p.homeOffense && p.firstDown) return { kind: 'cheer', intensity: 0.35 };
  if (!p.homeOffense && p.yards <= 0) return { kind: 'cheer', intensity: 0.3 };
  return null;
}

/** A flag call as the referee announces it: booed when it goes against the home team. */
export function reactionToFlag(onHome: boolean): Reaction {
  return onHome ? { kind: 'boo', intensity: 1 } : { kind: 'cheer', intensity: 0.4 };
}
