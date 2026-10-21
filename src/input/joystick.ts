/**
 * Invisible virtual joystick: spawns wherever the thumb lands and reports a
 * normalized vector (x = right, y = up/forward). Pure logic, no DOM.
 */
export class VirtualJoystick {
  active = false;
  originX = 0;
  originY = 0;
  x = 0;
  y = 0;

  constructor(public radius = 60, public deadzone = 0.12) {}

  start(px: number, py: number) {
    this.active = true;
    this.originX = px;
    this.originY = py;
    this.x = 0;
    this.y = 0;
  }

  move(px: number, py: number) {
    if (!this.active) return;
    let dx = (px - this.originX) / this.radius;
    let dy = -(py - this.originY) / this.radius;
    const l = Math.hypot(dx, dy);
    if (l > 1) {
      // Let the base trail the thumb so direction changes stay responsive.
      const excess = (l - 1) * this.radius;
      this.originX += (dx / l) * excess;
      this.originY -= (dy / l) * excess;
      dx /= l;
      dy /= l;
    }
    const m = Math.hypot(dx, dy);
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
