import { describe, expect, it } from 'vitest';
import { AUDIO, layerGains, reactionTo, reactionToFlag } from '../src/audio/crowdMix';
import type { PlayForCrowd } from '../src/game/crowd';

const play = (p: Partial<PlayForCrowd>): PlayForCrowd => ({
  homeOffense: true, yards: 3, firstDown: false, score: null, turnover: false, sack: false, penaltyOnHome: null, failedFourthDown: false, ...p,
});

describe('crowd mix', () => {
  it('ambience volume follows the crowd meter; the chant only when loud', () => {
    const q = layerGains(10), l = layerGains(90);
    expect(l.murmur).toBeGreaterThan(q.murmur);
    expect(l.chatter).toBeGreaterThan(q.chatter);
    expect(q.chant).toBe(0);
    expect(layerGains(AUDIO.chantFrom - 1).chant).toBe(0);
    expect(l.chant).toBeGreaterThan(0);
  });

  it('reactions: roar on home TDs, silence on home turnovers, boos on flags against the home team', () => {
    expect(reactionTo(play({ score: { home: true, points: 6 } }))?.kind).toBe('roar');
    expect(reactionTo(play({ score: { home: false, points: 6 }, homeOffense: false }))?.kind).toBe('silence');
    expect(reactionTo(play({ turnover: true }))?.kind).toBe('silence');
    expect(reactionTo(play({ turnover: true, homeOffense: false }))?.kind).toBe('roar');
    expect(reactionTo(play({ penaltyOnHome: true }))?.kind).toBe('boo');
    expect(reactionToFlag(true).kind).toBe('boo');
    expect(reactionToFlag(false).kind).toBe('cheer');
    expect(reactionTo(play({ yards: 25 }))?.kind).toBe('cheer');
    expect(reactionTo(play({ yards: 3 }))).toBeNull();
    expect(reactionTo(play({ homeOffense: false, sack: true }))?.kind).toBe('cheer');
  });
});
