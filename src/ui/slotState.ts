/**
 * Phase 3d: what each receiver button shows (pure). Red (`invalid`) is
 * reserved for a real problem: the receiver is not eligible (blocking), he is
 * out of throwing range, or the user pressed a receiver after the ball was
 * thrown. Everything else is neutral, selected or hot (a calm outline).
 */
import type { EligibleSlot } from '../data/types';
import TOUCH from '../data/touch.json';

export type SlotLook = 'neutral' | 'selected' | 'hot' | 'invalid';
export type InvalidReason = 'ineligible' | 'outOfRange' | 'thrown';

export interface SlotFacts {
  /** The receiver blocks on this play (not a pass target). */
  blocks: boolean;
  /** Distance QB → receiver in yards. */
  distance: number;
  /** The ball has already been thrown (or handed off). */
  thrown: boolean;
  /** The user pressed this receiver within the last `thrownFlash` seconds. */
  pressedRecently: boolean;
  selected: boolean;
  hot: boolean;
}

export interface SlotDisplay {
  look: SlotLook;
  reason: InvalidReason | null;
}

export const SLOT_STATE = TOUCH.slotState;

export function invalidReason(f: SlotFacts, maxRange = SLOT_STATE.maxThrowRange): InvalidReason | null {
  if (f.thrown) return f.pressedRecently ? 'thrown' : null;
  if (f.blocks) return 'ineligible';
  if (f.distance > maxRange) return 'outOfRange';
  return null;
}

export function slotDisplay(f: SlotFacts, maxRange = SLOT_STATE.maxThrowRange): SlotDisplay {
  const reason = invalidReason(f, maxRange);
  if (reason) return { look: 'invalid', reason };
  if (f.thrown) return { look: 'neutral', reason: null };
  if (f.selected) return { look: 'selected', reason: null };
  if (f.hot) return { look: 'hot', reason: null };
  return { look: 'neutral', reason: null };
}

/**
 * The sim's hot read can change every step when two receivers are about
 * equally open. The latch shows a new hot receiver only after the current one
 * has been shown for `minHold` seconds (or is gone), so the button never flickers.
 */
export class HotLatch {
  private shown: EligibleSlot | null = null;
  private since = -Infinity;

  constructor(private minHold = SLOT_STATE.hotMinHold) {}

  update(t: number, hot: EligibleSlot | null): EligibleSlot | null {
    if (hot === this.shown) return this.shown;
    if (hot === null || this.shown === null || t - this.since >= this.minHold) {
      this.shown = hot;
      this.since = t;
    }
    return this.shown;
  }

  reset() {
    this.shown = null;
    this.since = -Infinity;
  }
}
