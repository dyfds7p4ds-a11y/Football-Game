/**
 * Defensive play calls (coverage shells + pressure packages) and the CPU
 * play-caller. Phase 2 can let the user pick from DEFENSE_CALLS instead.
 */
import type { Rng } from '../core/rng';
import type { DefSlot, DifficultyConfig, EligibleSlot, PlayCategory } from '../data/types';

export type ZoneId =
  | 'deepL' | 'deepR' | 'deep3L' | 'deepM' | 'deep3R'
  | 'flatL' | 'flatR' | 'curlL' | 'curlR' | 'hookL' | 'hookR' | 'hookM';

export type DefAssignment =
  | { kind: 'rush' }
  | { kind: 'man'; target: EligibleSlot }
  | { kind: 'zone'; zone: ZoneId }
  | { kind: 'spy' };

export interface DefenseCall {
  id: string;
  name: string;
  shell: 'cover0' | 'cover1' | 'cover2' | 'cover3' | 'cover2man';
  assignments: Record<DefSlot, DefAssignment>;
}

const R = { kind: 'rush' } as const;
const man = (target: EligibleSlot): DefAssignment => ({ kind: 'man', target });
const zone = (z: ZoneId): DefAssignment => ({ kind: 'zone', zone: z });
const DL = { DE1: R, DT1: R, DT2: R, DE2: R };

export const DEFENSE_CALLS: DefenseCall[] = [
  {
    id: 'cover3', name: 'Cover 3 Sky', shell: 'cover3',
    assignments: { ...DL, CB1: zone('deep3L'), CB2: zone('deep3R'), FS: zone('deepM'), SS: zone('curlR'),
      NB: zone('curlL'), LB1: zone('hookL'), LB2: zone('hookR') },
  },
  {
    id: 'cover2', name: 'Cover 2 Zone', shell: 'cover2',
    assignments: { ...DL, CB1: zone('flatL'), CB2: zone('flatR'), FS: zone('deepL'), SS: zone('deepR'),
      NB: zone('curlL'), LB1: zone('hookM'), LB2: zone('curlR') },
  },
  {
    id: 'cover1', name: 'Cover 1 Man', shell: 'cover1',
    assignments: { ...DL, CB1: man('WR1'), CB2: man('WR2'), NB: man('WR3'), SS: man('TE'), LB2: man('RB'),
      FS: zone('deepM'), LB1: { kind: 'spy' } },
  },
  {
    id: 'cover2man', name: '2-Man Under', shell: 'cover2man',
    assignments: { ...DL, CB1: man('WR1'), CB2: man('WR2'), NB: man('WR3'), LB1: man('TE'), LB2: man('RB'),
      FS: zone('deepL'), SS: zone('deepR') },
  },
  {
    id: 'firezone', name: 'Fire Zone (Nickel Blitz)', shell: 'cover3',
    assignments: { ...DL, NB: R, CB1: zone('deep3L'), CB2: zone('deep3R'), FS: zone('deepM'), SS: zone('flatL'),
      LB1: zone('hookM'), LB2: zone('curlR') },
  },
  {
    id: 'cover1blitz', name: 'Cover 1 LB Blitz', shell: 'cover1',
    assignments: { ...DL, LB1: R, CB1: man('WR1'), CB2: man('WR2'), NB: man('WR3'), SS: man('TE'), LB2: man('RB'),
      FS: zone('deepM') },
  },
  {
    id: 'cover0', name: 'Cover 0 All-Out Blitz', shell: 'cover0',
    assignments: { ...DL, LB1: R, FS: R, CB1: man('WR1'), CB2: man('WR2'), NB: man('WR3'), SS: man('TE'),
      LB2: man('RB') },
  },
];

export function getDefenseCall(id: string): DefenseCall {
  const c = DEFENSE_CALLS.find((d) => d.id === id);
  if (!c) throw new Error(`unknown defense ${id}`);
  return c;
}

export interface Situation {
  down: number;
  toGo: number;
  yardline: number;
  /** Seconds left in the half. */
  halfSecondsLeft: number;
  scoreDiff: number;
}

/** Running tally of what the user calls; smart defenses lean against it. */
export interface Tendencies {
  run: number;
  pass: number;
  deep: number;
}

export const emptyTendencies = (): Tendencies => ({ run: 0, pass: 0, deep: 0 });

export function recordTendency(t: Tendencies, cat: PlayCategory): Tendencies {
  const run = cat === 'run' ? 1 : 0;
  return {
    run: t.run * 0.85 + run,
    pass: t.pass * 0.85 + (1 - run),
    deep: t.deep * 0.85 + (cat === 'deep' || cat === 'playaction' ? 1 : 0),
  };
}

/** CPU picks a defense from down & distance, field position and tendencies. */
export function chooseDefense(sit: Situation, tend: Tendencies, diff: DifficultyConfig, rng: Rng): DefenseCall {
  const w: Record<string, number> = { cover3: 3, cover2: 2.5, cover1: 2, cover2man: 1.5, firezone: 1.2, cover1blitz: 1, cover0: 0.4 };
  const passDown = (sit.down >= 2 && sit.toGo >= 7) || sit.down === 3 && sit.toGo >= 4;
  const shortYardage = sit.toGo <= 2;
  if (passDown) { w.cover2 += 1.5; w.cover2man += 1.5; w.firezone += 0.8; w.cover1blitz += 0.6; }
  if (shortYardage) { w.cover1 += 1.5; w.cover1blitz += 1.5; w.cover0 += 1; w.cover2 -= 1; }
  if (sit.yardline >= 90) { w.cover0 += 1; w.cover1 += 1; w.cover3 -= 1; }
  if (sit.halfSecondsLeft < 60 && sit.scoreDiff < 0) { w.cover2 += 2; w.cover3 += 1; w.cover0 = 0.1; }

  // Read tendencies (scaled by difficulty "intelligence").
  const k = diff.callIntelligence;
  const total = tend.run + tend.pass;
  if (total > 0.5 && k > 0) {
    const runShare = tend.run / total;
    const deepShare = tend.deep / Math.max(0.5, tend.pass);
    w.cover1 += k * runShare * 2;
    w.cover1blitz += k * runShare * 1.5;
    w.cover2 += k * deepShare * 2;
    w.cover3 += k * deepShare;
    w.cover0 -= k * deepShare * 0.4;
  }
  return getDefenseCall(rng.weighted(Object.entries(w).map(([item, weight]) => ({ item, weight }))));
}

/** Zone landmarks relative to (ballX, LOS). */
export const ZONES: Record<ZoneId, { x: number; y: number; deep: boolean; w: number }> = {
  deepL: { x: -10, y: 16, deep: true, w: 14 },
  deepR: { x: 10, y: 16, deep: true, w: 14 },
  deep3L: { x: -16, y: 15, deep: true, w: 10 },
  deepM: { x: 0, y: 17, deep: true, w: 10 },
  deep3R: { x: 16, y: 15, deep: true, w: 10 },
  flatL: { x: -18, y: 4, deep: false, w: 8 },
  flatR: { x: 18, y: 4, deep: false, w: 8 },
  curlL: { x: -12, y: 9, deep: false, w: 6 },
  curlR: { x: 12, y: 9, deep: false, w: 6 },
  hookL: { x: -5, y: 8, deep: false, w: 6 },
  hookR: { x: 5, y: 8, deep: false, w: 6 },
  hookM: { x: 0, y: 9, deep: false, w: 6 },
};
