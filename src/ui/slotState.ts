/**
 * Phase 3d: what each receiver button shows (pure). Red (`invalid`) is
 * reserved for a real problem: the user presses a receiver who is not
 * eligible (he blocks on this play) or presses one after the ball was thrown,
 * or the receiver is out of throwing range. A blocker nobody pressed is only
 * dimmed (`blocking`), so a run play does not light up every button.
 * Everything else is neutral, selected or hot (a calm outline).
 */
import type { EligibleSlot } from '../data/types';
import TOUCH from '../data/touch.json';

export type SlotLook = 'neutral' | 'selected' | 'hot' | 'blocking' | 'invalid';
export type InvalidReason = 'ineligible' | 'outOfRange' | 'thrown';

export interface SlotFacts {
  /** The receiver blocks on this play (not a pass target). */
  blocks: boolean;
  /** Distance QB → receiver in yards. */
  distance: number;
  /** The ball has already been thrown (or handed off). */
  thrown: boolean;
  /** The user pressed this receiver within the last `thrownFlash` seconds (before or after the throw). */
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
  if (f.blocks) return f.pressedRecently ? 'ineligible' : null;
  if (f.distance > maxRange) return 'outOfRange';
  return null;
}

export function slotDisplay(f: SlotFacts, maxRange = SLOT_STATE.maxThrowRange): SlotDisplay {
  const reason = invalidReason(f, maxRange);
  if (reason) return { look: 'invalid', reason };
  if (f.thrown) return { look: 'neutral', reason: null };
  if (f.blocks) return { look: 'blocking', reason: null };
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
