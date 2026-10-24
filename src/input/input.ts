/**
 * InputManager merges touch, keyboard and gamepad into one InputFrame per
 * frame. Game code never looks at raw events.
 */
import type { DefSlot, EligibleSlot } from '../data/types';
import type { Vec2 } from '../core/vec';

export interface InputFrame {
  /** Movement, x = right, y = forward/downfield. Length <= 1. */
  move: Vec2;
  /** Look deltas since last frame (radians). */
  lookYaw: number;
  lookPitch: number;
  /** Big action button (Snap / Throw-hold / Juke). */
  primaryHeld: boolean;
  primaryPressed: boolean;
  /** Receiver button pressed this frame (edge). */
  slotPressed: EligibleSlot | null;
  /** Receiver button currently held (Madden-style: hold = charge the throw to him). */
  slotHeld: EligibleSlot | null;
  /** Secondary action: slide (QB) / dash (returner). */
  secondaryPressed: boolean;
  /** Phase 3d: SPRINT held (touch button, C, pad R3). */
  sprintHeld: boolean;
  /** On defense: on-screen cornerback button pressed this frame (switch control to him). */
  defenderPressed: DefSlot | null;
  /** Phase 3d: a short tap on the field this frame (screen px), for picking a defender. */
  tap: { x: number; y: number } | null;
  /** Any button, key or tap this frame (skips cutscenes). */
  anyPressed: boolean;
  pausePressed: boolean;
  timeoutPressed: boolean;
  /** Phase 4: ADJUST (defensive audible menu) pressed (touch button, Q). */
  adjustPressed: boolean;
}

const KEY_SLOTS: Record<string, EligibleSlot> = {
  Digit1: 'WR1', Digit2: 'WR2', Digit3: 'WR3', Digit4: 'RB', KeyR: 'RB', Digit5: 'TE', KeyT: 'TE',
};
const SECONDARY_KEYS = new Set(['KeyX', 'ShiftLeft', 'ShiftRight']);
// Standard gamepad mapping.
const PAD_SLOTS: [number, EligibleSlot][] = [[2, 'WR1'], [3, 'WR2'], [1, 'WR3'], [4, 'RB'], [5, 'TE']];
const PAD_SECONDARY = [6, 10];

export class InputManager {
  private touchMove: Vec2 = { x: 0, y: 0 };
  private touchPrimary = false;
  private touchSprint = false;
  private padSprint = false;
  private keys = new Set<string>();
  private lookYaw = 0;
  private lookPitch = 0;
  private primaryWasHeld = false;
  private pendingSlot: EligibleSlot | null = null;
  /** Receiver buttons held per device (touch / keyboard). */
  private touchSlot: EligibleSlot | null = null;
  private keySlots: EligibleSlot[] = [];
  private padSlot: EligibleSlot | null = null;
  private pendingSecondary = false;
  private pendingDefender: DefSlot | null = null;
  private pendingTap: { x: number; y: number } | null = null;
  private pendingAny = false;
  /** Latched so a tap shorter than one frame is never lost. */
  private pendingPrimary = false;
  private pendingPause = false;
  private pendingTimeout = false;
  private pendingAdjust = false;
  private padPrev: boolean[] = [];
  lookSensitivity = 1;
  /** Which device was used last: lets the UI hide touch buttons for keyboard/pad players. */
  lastDevice: 'touch' | 'keyboard' | 'gamepad' = 'touch';

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.lastDevice = 'keyboard';
      this.keys.add(e.code);
      this.pendingAny = true;
      const slot = KEY_SLOTS[e.code];
      if (slot) {
        this.pendingSlot = slot;
        this.keySlots = [...this.keySlots.filter((x) => x !== slot), slot];
      }
      if (SECONDARY_KEYS.has(e.code)) this.pendingSecondary = true;
      if (e.code === 'Escape' || e.code === 'KeyP') this.pendingPause = true;
      if (e.code === 'KeyO') this.pendingTimeout = true;
      if (e.code === 'KeyQ') this.pendingAdjust = true;
      if (e.code === 'Space' || e.code === 'Enter') this.pendingPrimary = true;
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      const slot = KEY_SLOTS[e.code];
      if (slot) this.keySlots = this.keySlots.filter((x) => x !== slot);
    });
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.keySlots = [];
      this.touchSlot = null;
    });
    window.addEventListener('pointerdown', () => (this.pendingAny = true), { capture: true });
  }

  // --- touch UI hooks
  setTouchMove(x: number, y: number) {
    this.lastDevice = 'touch';
    this.touchMove = { x, y };
  }
  addLook(yaw: number, pitch: number) {
    this.lookYaw += yaw * this.lookSensitivity;
    this.lookPitch += pitch * this.lookSensitivity;
  }
  setTouchPrimary(held: boolean) {
    this.lastDevice = 'touch';
    this.touchPrimary = held;
    if (held) this.pendingPrimary = true;
  }
  setTouchSprint(held: boolean) {
    this.lastDevice = 'touch';
    this.touchSprint = held;
  }
  pressSlot(slot: EligibleSlot) {
    this.pendingSlot = slot;
  }
  /** Touch receiver button held / released. */
  setTouchSlot(slot: EligibleSlot, held: boolean) {
    this.lastDevice = 'touch';
    if (held) {
      this.touchSlot = slot;
      this.pendingSlot = slot;
    } else if (this.touchSlot === slot) {
      this.touchSlot = null;
    }
  }
  pressSecondary() {
    this.pendingSecondary = true;
  }
  pressDefender(slot: DefSlot) {
    this.lastDevice = 'touch';
    this.pendingDefender = slot;
  }
  tapAt(x: number, y: number) {
    this.lastDevice = 'touch';
    this.pendingTap = { x, y };
  }
  pressPause() {
    this.pendingPause = true;
  }
  pressTimeout() {
    this.pendingTimeout = true;
  }
  pressAdjust() {
    this.pendingAdjust = true;
  }

  /** Build this frame's input; call once per animation frame. */
  poll(dt: number): InputFrame {
    let mx = this.touchMove.x;
    let my = this.touchMove.y;
    const k = this.keys;
    const kx = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const ky = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    if (kx || ky) {
      const l = Math.hypot(kx, ky);
      mx = kx / l;
      my = ky / l;
    }
    let primary = this.touchPrimary || k.has('Space') || k.has('Enter');
    this.lookYaw += ((k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0)) * 2.2 * dt * this.lookSensitivity;

    let pads: (Gamepad | null)[] = [];
    try {
      // Some embedded contexts block the Gamepad API via permissions policy.
      pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    } catch {
      pads = [];
    }
    for (const pad of pads) {
      if (!pad) continue;
      const dz = (v: number) => (Math.abs(v) < 0.18 ? 0 : v);
      const lx = dz(pad.axes[0] ?? 0);
      const ly = dz(pad.axes[1] ?? 0);
      if (lx || ly) {
        this.lastDevice = 'gamepad';
        mx = lx;
        my = -ly;
        const l = Math.hypot(mx, my);
        if (l > 1) {
          mx /= l;
          my /= l;
        }
      }
      this.lookYaw += dz(pad.axes[2] ?? 0) * 2.4 * dt * this.lookSensitivity;
      this.lookPitch -= dz(pad.axes[3] ?? 0) * 1.2 * dt * this.lookSensitivity;
      const btn = (i: number) => !!pad.buttons[i]?.pressed;
      const edge = (i: number) => btn(i) && !this.padPrev[i];
      if (btn(0) || btn(7)) {
        primary = true;
        this.lastDevice = 'gamepad';
      }
      for (const [i, slot] of PAD_SLOTS) if (edge(i)) this.pendingSlot = slot;
      this.padSlot = PAD_SLOTS.find(([i]) => btn(i))?.[1] ?? null;
      if (PAD_SECONDARY.some(edge)) this.pendingSecondary = true;
      this.padSprint = btn(11);
      if (pad.buttons.some((_, i) => edge(i))) this.pendingAny = true;
      if (edge(9)) this.pendingPause = true;
      if (edge(8)) this.pendingTimeout = true;
      this.padPrev = pad.buttons.map((b) => b.pressed);
      break;
    }

    const frame: InputFrame = {
      move: { x: mx, y: my },
      lookYaw: this.lookYaw,
      lookPitch: this.lookPitch,
      primaryHeld: primary,
      primaryPressed: this.pendingPrimary || (primary && !this.primaryWasHeld),
      slotPressed: this.pendingSlot,
      slotHeld: this.touchSlot ?? this.keySlots[this.keySlots.length - 1] ?? this.padSlot,
      secondaryPressed: this.pendingSecondary,
      sprintHeld: this.touchSprint || k.has('KeyC') || this.padSprint,
      defenderPressed: this.pendingDefender,
      tap: this.pendingTap,
      anyPressed: this.pendingAny,
      pausePressed: this.pendingPause,
      timeoutPressed: this.pendingTimeout,
      adjustPressed: this.pendingAdjust,
    };
    this.primaryWasHeld = primary;
    this.lookYaw = 0;
    this.lookPitch = 0;
    this.pendingSlot = null;
    this.pendingSecondary = false;
    this.pendingDefender = null;
    this.pendingTap = null;
    this.pendingAny = false;
    this.pendingPrimary = false;
    this.pendingPause = false;
    this.pendingTimeout = false;
    this.pendingAdjust = false;
    return frame;
  }
}
