/**
 * Phase 3d: tap a defender on the field to take him over (pure). The app
 * projects every defender to the screen; the one nearest the tap within
 * `radius` px wins. Tunables: `data/touch.json` `tapSelect`.
 */
import TOUCH from '../data/touch.json';

export const TAP_SELECT = TOUCH.tapSelect;

export interface TapCandidate<S> {
  slot: S;
  x: number;
  y: number;
  onScreen: boolean;
}

export function pickAtTap<S>(tap: { x: number; y: number }, candidates: TapCandidate<S>[], radius = TAP_SELECT.radius): S | null {
  let best: S | null = null;
  let bd = radius;
  for (const c of candidates) {
    if (!c.onScreen) continue;
    const d = Math.hypot(c.x - tap.x, c.y - tap.y);
    if (d <= bd) {
      best = c.slot;
      bd = d;
    }
  }
  return best;
}

/** A pointer that went down and up quickly without moving much is a tap, not a look drag. */
export function isTap(ms: number, moved: number): boolean {
  return ms <= TAP_SELECT.maxMs && moved <= TAP_SELECT.maxMove;
}
