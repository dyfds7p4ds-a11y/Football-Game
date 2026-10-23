import { describe, expect, it } from 'vitest';
import TOUCH from '../src/data/touch.json';
import { VirtualJoystick, actionsRect, joystickLayout, joystickRect, rectGap } from '../src/input/joystick';

const VIEWPORTS: [number, number][] = [[1180, 820], [820, 1180], [1366, 1024], [1024, 768], [844, 390]];

describe('fixed joystick (Phase 3c)', () => {
  it('base stays fixed: a touch off-center points the stick, it does not move the base', () => {
    const j = new VirtualJoystick();
    j.place(200, 600);
    j.start(200 + TOUCH.joystick.radius, 600);
    expect(j.originX).toBe(200);
    expect(j.originY).toBe(600);
    expect(j.x).toBeCloseTo(1, 5);
    j.move(200, 600 - 5 * TOUCH.joystick.radius);
    expect(j.originY).toBe(600);
    expect(j.y).toBeCloseTo(1, 5);
    expect(Math.hypot(j.x, j.y)).toBeLessThanOrEqual(1 + 1e-9);
    j.move(203, 600);
    expect(j.x).toBe(0);
    j.end();
    expect(j.active).toBe(false);
  });

  it('is large: hit radius at least 120 px', () => {
    const l = joystickLayout(1180, 820);
    expect(l.hitRadius).toBeGreaterThanOrEqual(120);
    expect(l.radius).toBeGreaterThanOrEqual(80);
  });

  it('sits bottom left and never overlaps the action cluster at full size', () => {
    for (const [w, h] of VIEWPORTS) {
      const l = joystickLayout(w, h);
      const jr = joystickRect(l);
      expect(jr.left).toBeGreaterThanOrEqual(0);
      expect(jr.bottom).toBeLessThanOrEqual(h);
      expect(l.cx).toBeLessThan(w / 2);
      const ar = actionsRect(w, h);
      expect(ar.right - ar.left).toBe(TOUCH.actions.size);
      expect(rectGap(jr, ar)).toBeGreaterThanOrEqual(TOUCH.minClearance);
    }
  });
});
