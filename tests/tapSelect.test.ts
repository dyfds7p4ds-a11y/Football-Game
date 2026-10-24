import { describe, expect, it } from 'vitest';
import TOUCH from '../src/data/touch.json';
import { TAP_SELECT, isTap, pickAtTap } from '../src/ui/tapSelect';
import { actionsRect, joystickLayout, switchButtonRect } from '../src/input/joystick';

describe('Phase 3d: defender selection in the camera view', () => {
  const cands = [
    { slot: 'CB1', x: 300, y: 400, onScreen: true },
    { slot: 'LB1', x: 520, y: 380, onScreen: true },
    { slot: 'FS', x: 505, y: 300, onScreen: false },
  ];

  it('a tap takes the nearest on-screen defender within the radius', () => {
    expect(pickAtTap({ x: 510, y: 390 }, cands)).toBe('LB1');
    expect(pickAtTap({ x: 310, y: 395 }, cands)).toBe('CB1');
    // FS is off screen (behind the camera): never picked even right under the tap.
    expect(pickAtTap({ x: 505, y: 300 }, cands)).not.toBe('FS');
    expect(pickAtTap({ x: 900, y: 100 }, cands)).toBeNull();
    expect(pickAtTap({ x: 300 + TAP_SELECT.radius + 1, y: 400 }, cands)).toBeNull();
  });

  it('a quick touch is a tap, a drag is a look', () => {
    expect(isTap(120, 4)).toBe(true);
    expect(isTap(TAP_SELECT.maxMs + 50, 2)).toBe(false);
    expect(isTap(100, TAP_SELECT.maxMove + 10)).toBe(false);
  });

  it('Phase 4: SWITCH sits in the right-edge zone, clear of the action cluster and the PLAYERS menu (iPad landscape / portrait)', () => {
    const SB = TOUCH.switchButton;
    for (const [w, h] of [[1180, 820], [820, 1180], [1366, 1024], [1024, 768]]) {
      const btn = switchButtonRect(w, h);
      const a = actionsRect(w, h);
      const j = joystickLayout(w, h);
      expect(btn.left).toBeGreaterThanOrEqual(w * (1 - SB.edgeZonePct / 100)); // right-edge zone
      expect(btn.right).toBeLessThanOrEqual(w);
      expect(btn.bottom).toBeLessThan(a.top); // above the action cluster
      expect(btn.left).toBeGreaterThan(j.cx + j.hitRadius); // nowhere near the stick
      expect(btn.top).toBeGreaterThan(84 + 40); // below the PLAYERS menu
    }
  });
});
