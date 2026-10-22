/**
 * Which defender the user controls (pure). Phase 3b: every defender is
 * playable. One SWITCH button moves control to the defender nearest the ball
 * during the play (to the next one in order before the snap); the on-screen
 * defender strip selects any slot directly. Units decide the camera preset.
 */
import type { Vec2 } from '../core/vec';
import type { DefSlot } from '../data/types';
import { DEF_SLOTS } from '../data/types';

export type DefUnit = 'DL' | 'LB' | 'DB';

export const DEF_UNITS: Record<DefUnit, DefSlot[]> = {
  DL: ['DE1', 'DT1', 'DT2', 'DE2'],
  LB: ['LB1', 'LB2'],
  DB: ['CB1', 'CB2', 'NB', 'FS', 'SS'],
};

export function unitOf(slot: DefSlot): DefUnit {
  return DEF_UNITS.DL.includes(slot) ? 'DL' : DEF_UNITS.LB.includes(slot) ? 'LB' : 'DB';
}

export interface SelectCandidate {
  slot: DefSlot;
  pos: Vec2;
  down: boolean;
}

/**
 * The SWITCH button. Live: the defender nearest the ball (never the current
 * one, so a press always changes something; players on the ground are
 * skipped). Before the snap: the next slot in order, wrapping around.
 */
export function switchTarget(cands: SelectCandidate[], current: DefSlot, ball: Vec2, live: boolean): DefSlot {
  const up = cands.filter((c) => !c.down && c.slot !== current);
  if (!up.length) return current;
  if (!live) {
    const i = DEF_SLOTS.indexOf(current);
    for (let k = 1; k <= DEF_SLOTS.length; k++) {
      const s = DEF_SLOTS[(i + k) % DEF_SLOTS.length];
      if (up.some((c) => c.slot === s)) return s;
    }
    return current;
  }
  const d = (c: SelectCandidate) => Math.hypot(c.pos.x - ball.x, c.pos.y - ball.y);
  return up.reduce((m, c) => (d(c) < d(m) ? c : m)).slot;
}
