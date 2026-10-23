import { describe, expect, it } from 'vitest';
import { HotLatch, SLOT_STATE, invalidReason, slotDisplay, type SlotFacts } from '../src/ui/slotState';

const base: SlotFacts = { blocks: false, distance: 12, thrown: false, pressedRecently: false, selected: false, hot: false };

describe('receiver button red state (Phase 3d)', () => {
  it('is never red for an eligible receiver in range before the throw', () => {
    for (const selected of [false, true]) {
      for (const hot of [false, true]) {
        for (const pressedRecently of [false, true]) {
          for (const distance of [0, 5, 30, SLOT_STATE.maxThrowRange]) {
            expect(slotDisplay({ ...base, selected, hot, pressedRecently, distance }).look).not.toBe('invalid');
          }
        }
      }
    }
  });

  it('is red exactly for the defined conditions', () => {
    expect(invalidReason({ ...base, blocks: true })).toBe('ineligible');
    expect(invalidReason({ ...base, distance: SLOT_STATE.maxThrowRange + 0.1 })).toBe('outOfRange');
    expect(invalidReason({ ...base, thrown: true, pressedRecently: true })).toBe('thrown');
    expect(invalidReason({ ...base, thrown: true })).toBeNull();
    expect(slotDisplay({ ...base, blocks: true, selected: true }).look).toBe('invalid');
  });

  it('exhaustive: invalid <=> (thrown & pressed) | (!thrown & (blocks | out of range))', () => {
    const bools = [false, true];
    for (const blocks of bools) for (const thrown of bools) for (const pressedRecently of bools)
      for (const selected of bools) for (const hot of bools) for (const distance of [10, 80]) {
        const f = { blocks, thrown, pressedRecently, selected, hot, distance };
        const expected = thrown ? pressedRecently : blocks || distance > SLOT_STATE.maxThrowRange;
        expect(slotDisplay(f).look === 'invalid').toBe(expected);
      }
  });

  it('hot read is its own neutral look, and the latch stops flicker', () => {
    expect(slotDisplay({ ...base, hot: true }).look).toBe('hot');
    const latch = new HotLatch(0.8);
    expect(latch.update(0, 'WR1')).toBe('WR1');
    // The sim alternates every step: the button keeps WR1 until the hold is over.
    let changes = 0;
    let last = 'WR1';
    for (let i = 1; i < 60; i++) {
      const shown = latch.update(i / 60, i % 2 ? 'WR2' : 'WR1');
      if (shown !== last) changes++;
      last = shown!;
    }
    expect(changes).toBeLessThanOrEqual(1);
    expect(latch.update(2, null)).toBeNull();
  });
});
