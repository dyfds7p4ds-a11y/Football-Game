/**
 * Fixed virtual joystick (Phase 3c): the base sits at a fixed spot at the
 * bottom left (`data/touch.json`) and never moves to the touch point. A touch
 * anywhere inside the hit circle (base radius + padding) grabs the stick, and
 * the stick points from the base center to the thumb at once.
 * Reports a normalized vector (x = right, y = up/forward). Pure logic, no DOM.
 */
import TOUCH from '../data/touch.json';

export interface Rect { left: number; top: number; right: number; bottom: number }

export interface JoystickLayout {
  /** Base center in viewport px. */
  cx: number;
  cy: number;
  radius: number;
  /** Radius of the area that grabs the stick. */
  hitRadius: number;
}

export type TouchConfig = typeof TOUCH;

/** Where the stick sits in a viewport of `vw` x `vh` px (safe-area insets in px). */
export function joystickLayout(vw: number, vh: number, safeL = 0, safeB = 0, cfg: TouchConfig = TOUCH): JoystickLayout {
  void vw;
  const j = cfg.joystick;
  const hitRadius = j.radius + j.hitPadding;
  return { cx: safeL + j.left + hitRadius, cy: vh - safeB - j.bottom - hitRadius, radius: j.radius, hitRadius };
}

/** Bounding box of the stick's hit area. */
export function joystickRect(l: JoystickLayout): Rect {
  return { left: l.cx - l.hitRadius, top: l.cy - l.hitRadius, right: l.cx + l.hitRadius, bottom: l.cy + l.hitRadius };
}

/** Bounding box of the receiver / action cluster (bottom right). */
export function actionsRect(vw: number, vh: number, safeR = 0, safeB = 0, cfg: TouchConfig = TOUCH): Rect {
  const a = cfg.actions;
  const right = vw - safeR - a.right;
  const bottom = vh - safeB - a.bottom;
  return { left: right - a.size, top: bottom - a.size, right, bottom };
}

/** Horizontal gap between two rects that share vertical space (negative = overlap). */
export function rectGap(a: Rect, b: Rect): number {
  const dx = Math.max(a.left - b.right, b.left - a.right);
  const dy = Math.max(a.top - b.bottom, b.top - a.bottom);
  return Math.max(dx, dy);
}

export class VirtualJoystick {
  active = false;
  originX = 0;
  originY = 0;
  x = 0;
  y = 0;

  constructor(public radius = TOUCH.joystick.radius, public deadzone = TOUCH.joystick.deadzone) {}

  /** Fix the base center (viewport px). */
  place(cx: number, cy: number) {
    this.originX = cx;
    this.originY = cy;
  }

  /** Thumb down at (px, py); the base stays where it is. */
  start(px: number, py: number) {
    this.active = true;
    this.move(px, py);
  }

  move(px: number, py: number) {
    if (!this.active) return;
    let dx = (px - this.originX) / this.radius;
    let dy = -(py - this.originY) / this.radius;
    const l = Math.hypot(dx, dy);
    if (l > 1) {
      dx /= l;
      dy /= l;
    }
    const m = Math.min(1, l);
    if (m < this.deadzone) {
      this.x = 0;
      this.y = 0;
    } else {
      const k = (m - this.deadzone) / (1 - this.deadzone) / m;
      this.x = dx * k;
      this.y = dy * k;
    }
  }

  end() {
    this.active = false;
    this.x = 0;
    this.y = 0;
  }
}
