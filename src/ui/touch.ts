/**
 * Touch controls: fixed joystick (bottom left, Phase 3c), look-drag (right half),
 * receiver buttons + primary action button (bottom right). Multi-touch safe:
 * every control tracks its own pointerId.
 */
import type { DefSlot, EligibleSlot } from '../data/types';
import { DEF_UNITS } from '../play/defenseSelect';
import type { InputManager } from '../input/input';
import { VirtualJoystick } from '../input/joystick';
import TOUCH from '../data/touch.json';
import { h } from './dom';
import type { SlotDisplay } from './slotState';

const SLOT_LABEL: Record<EligibleSlot, string> = { WR1: '1', WR2: '2', WR3: '3', RB: 'RB', TE: 'TE' };
// Arc of receiver buttons around the primary button (right, bottom offsets in px).
const SLOT_POS: Record<EligibleSlot, [number, number]> = {
  WR1: [150, 150], WR2: [82, 196], WR3: [8, 218], RB: [204, 84], TE: [212, 4],
};

export class TouchControls {
  readonly root: HTMLElement;
  readonly primary: HTMLButtonElement;
  readonly chargeZone: HTMLElement;
  readonly chargeFill: HTMLElement;
  readonly chargeBox: HTMLElement;
  readonly secondary: HTMLButtonElement;
  private slotBtns = new Map<EligibleSlot, HTMLButtonElement>();
  private defBtns = new Map<DefSlot, HTMLButtonElement>();
  private defStrip: HTMLElement;
  private joy = new VirtualJoystick();
  private joyId: number | null = null;
  private lookId: number | null = null;
  private lookLast = { x: 0, y: 0 };
  private base = h('div', { class: 'joy-base' });
  private knob = h('div', { class: 'joy-knob' });
  private joyzone: HTMLElement;

  constructor(private input: InputManager) {
    const J = TOUCH.joystick;
    const hit = J.radius + J.hitPadding;
    // The hit circle is the zone itself; base and knob are children, centered in it.
    const joyzone = h('div', { id: 'joyzone', style: {
      left: `calc(${J.left}px + var(--safe-l))`, bottom: `calc(${J.bottom}px + var(--safe-b))`,
      width: `${hit * 2}px`, height: `${hit * 2}px`,
    } }, this.base, this.knob);
    this.base.style.width = this.base.style.height = `${J.radius * 2}px`;
    this.knob.style.width = this.knob.style.height = `${J.knobRadius * 2}px`;
    this.joyzone = joyzone;
    const lookzone = h('div', { id: 'lookzone' });
    this.primary = h('button', { id: 'btn-primary' }, 'SNAP');
    this.chargeZone = h('div', { class: 'zone' });
    this.chargeFill = h('div', { class: 'fill' });
    this.chargeBox = h('div', { id: 'charge' }, this.chargeZone, this.chargeFill);
    this.secondary = h('button', { id: 'btn-secondary', class: 'hidden' }, 'SLIDE');
    this.secondary.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.secondary.classList.add('down');
      input.pressSecondary();
    });
    const secUp = () => this.secondary.classList.remove('down');
    this.secondary.addEventListener('pointerup', secUp);
    this.secondary.addEventListener('pointercancel', secUp);
    const A = TOUCH.actions;
    const actions = h('div', { id: 'actions', style: {
      right: `calc(${A.right}px + var(--safe-r))`, bottom: `calc(${A.bottom}px + var(--safe-b))`,
      width: `${A.size}px`, height: `${A.size}px`,
    } }, this.chargeBox, this.primary, this.secondary);
    for (const slot of Object.keys(SLOT_POS) as EligibleSlot[]) {
      const [r, b] = SLOT_POS[slot];
      const btn = h('button', { class: 'slot', style: { right: `${r}px`, bottom: `${b}px` } }, SLOT_LABEL[slot]);
      // Hold = charge the throw to this receiver, release = throw (Madden-style).
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        btn.setPointerCapture(e.pointerId);
        btn.classList.add('down');
        input.setTouchSlot(slot, true);
      });
      const up = () => {
        btn.classList.remove('down');
        input.setTouchSlot(slot, false);
      };
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointercancel', up);
      this.slotBtns.set(slot, btn);
      actions.append(btn);
    }
    // Defense (Phase 3b): a strip with every defender, grouped DL | LB | DB; tap one to take him over.
    const strip = h('div', { id: 'defstrip', class: 'hidden' });
    for (const unit of Object.values(DEF_UNITS)) {
      const group = h('div', { class: 'defgroup' });
      for (const slot of unit) {
        const btn = h('button', { class: 'defbtn' }, slot);
        btn.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          input.pressDefender(slot);
        });
        this.defBtns.set(slot, btn);
        group.append(btn);
      }
      strip.append(group);
    }
    this.defStrip = strip;
    this.root = h('div', { id: 'touch' }, joyzone, lookzone, actions, strip);

    // Primary button: hold state.
    this.primary.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.primary.setPointerCapture(e.pointerId);
      this.primary.classList.add('down');
      input.setTouchPrimary(true);
    });
    const release = () => {
      this.primary.classList.remove('down');
      input.setTouchPrimary(false);
    };
    this.primary.addEventListener('pointerup', release);
    this.primary.addEventListener('pointercancel', release);

    // Joystick.
    joyzone.addEventListener('pointerdown', (e) => {
      if (this.joyId !== null) return;
      e.preventDefault();
      joyzone.setPointerCapture(e.pointerId);
      this.joyId = e.pointerId;
      const r = joyzone.getBoundingClientRect();
      this.joy.place(r.left + r.width / 2, r.top + r.height / 2);
      this.joy.start(e.clientX, e.clientY);
      input.setTouchMove(this.joy.x, this.joy.y);
      this.drawJoy();
    });
    joyzone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.joyId) return;
      this.joy.move(e.clientX, e.clientY);
      input.setTouchMove(this.joy.x, this.joy.y);
      this.drawJoy();
    });
    const joyEnd = (e: PointerEvent) => {
      if (e.pointerId !== this.joyId) return;
      this.joyId = null;
      this.joy.end();
      input.setTouchMove(0, 0);
      this.drawJoy();
    };
    joyzone.addEventListener('pointerup', joyEnd);
    joyzone.addEventListener('pointercancel', joyEnd);

    // Look drag (also works with a mouse).
    lookzone.addEventListener('pointerdown', (e) => {
      if (this.lookId !== null) return;
      e.preventDefault();
      lookzone.setPointerCapture(e.pointerId);
      this.lookId = e.pointerId;
      this.lookLast = { x: e.clientX, y: e.clientY };
    });
    lookzone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.lookId) return;
      const dx = e.clientX - this.lookLast.x;
      const dy = e.clientY - this.lookLast.y;
      this.lookLast = { x: e.clientX, y: e.clientY };
      input.addLook(dx * 0.006, -dy * 0.004);
    });
    const lookEnd = (e: PointerEvent) => {
      if (e.pointerId === this.lookId) this.lookId = null;
    };
    lookzone.addEventListener('pointerup', lookEnd);
    lookzone.addEventListener('pointercancel', lookEnd);
  }

  private drawJoy() {
    this.joyzone.classList.toggle('active', this.joy.active);
    this.knob.style.transform =
      `translate(calc(-50% + ${this.joy.x * this.joy.radius}px), calc(-50% + ${-this.joy.y * this.joy.radius}px))`;
  }

  setPrimary(label: string, mode: 'snap' | 'throw' | 'juke' | 'kick' | 'none') {
    if (this.primary.textContent !== label) this.primary.textContent = label;
    this.primary.classList.toggle('throw', mode === 'throw' || mode === 'kick');
    this.primary.classList.toggle('juke', mode === 'juke');
    this.primary.disabled = mode === 'none';
  }

  /**
   * Phase 3d: one look per receiver (ui/slotState.ts); null hides the buttons.
   * Red (`invalid`) only for a real problem, never for the hot read.
   */
  setSlots(looks: Partial<Record<EligibleSlot, SlotDisplay>> | null) {
    for (const [slot, btn] of this.slotBtns) {
      const d = looks?.[slot];
      btn.classList.toggle('hidden', !looks);
      for (const look of ['selected', 'hot', 'invalid'] as const) btn.classList.toggle(look, d?.look === look);
      btn.dataset.reason = d?.reason ?? '';
    }
  }

  /** Defender strip on defense (null hides it); `selected` is the one under control. */
  setDefenders(selected: DefSlot | null) {
    this.defStrip.classList.toggle('hidden', !selected);
    for (const [slot, btn] of this.defBtns) btn.classList.toggle('selected', slot === selected);
  }

  /** Secondary action button (SLIDE / DASH); null hides it. */
  setSecondary(label: string | null, ready = true) {
    this.secondary.classList.toggle('hidden', !label);
    if (label && this.secondary.textContent !== label) this.secondary.textContent = label;
    this.secondary.disabled = !ready;
  }

  /** Charge meter: fill 0..1 and the sweet-spot window (null hides it). */
  setCharge(visible: boolean, charge: number, win: { center: number; halfWidth: number } | null) {
    this.chargeBox.classList.toggle('hidden', !visible);
    if (!visible) return;
    this.chargeFill.style.height = `${Math.min(100, (charge / 1.25) * 100)}%`;
    this.chargeFill.style.background = charge > 1 ? '#e63946' : '';
    if (win) {
      const lo = Math.max(0, win.center - win.halfWidth) / 1.25;
      const hi = Math.min(1.25, win.center + win.halfWidth) / 1.25;
      this.chargeZone.style.bottom = `${lo * 100}%`;
      this.chargeZone.style.height = `${(hi - lo) * 100}%`;
      this.chargeZone.classList.remove('hidden');
    } else {
      this.chargeZone.classList.add('hidden');
    }
  }

  setVisible(v: boolean) {
    this.root.classList.toggle('hidden', !v);
    if (!v) {
      this.joyId = null;
      this.joy.end();
      this.input.setTouchMove(0, 0);
      this.input.setTouchPrimary(false);
      for (const slot of this.slotBtns.keys()) this.input.setTouchSlot(slot, false);
      this.drawJoy();
    }
  }
}
