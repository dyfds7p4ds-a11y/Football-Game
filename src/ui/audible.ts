/**
 * Phase 3c: the audible picker. A small row of 2-3 plays the QB can check to
 * at the line, each with its play-clock cost; 1 / 2 / 3 (or a tap) picks,
 * AUDIBLE again (or the X) closes it.
 */
import type { PlayData } from '../data/types';
import { h } from './dom';

export class AudibleMenu {
  readonly root: HTMLElement;
  private list: HTMLElement;
  private info: HTMLElement;
  private options: PlayData[] = [];
  visible = false;

  constructor(private onPick: (p: PlayData) => void) {
    this.list = h('div', { class: 'aud-list' });
    this.info = h('div', { class: 'aud-info' });
    const close = h('button', { class: 'aud-close' }, '×');
    close.addEventListener('pointerup', (e) => {
      e.preventDefault();
      this.hide();
    });
    this.root = h('div', { id: 'audible', class: 'hidden' }, h('div', { class: 'aud-head' }, 'AUDIBLE', close), this.list, this.info);
  }

  show(options: PlayData[], cost: number, left: number) {
    this.options = options;
    this.list.replaceChildren(...options.map((p, i) => {
      const b = h('button', { class: 'aud-opt' }, h('span', { class: 'aud-key' }, String(i + 1)), h('span', {}, p.name),
        h('span', { class: 'aud-cat' }, p.category.toUpperCase()));
      b.addEventListener('pointerup', (e) => {
        e.preventDefault();
        this.pick(i);
      });
      return b;
    }));
    this.info.textContent = `-${cost}s play clock · ${left} left`;
    this.root.classList.remove('hidden');
    this.visible = true;
  }

  pick(i: number) {
    const p = this.options[i];
    if (!this.visible || !p) return;
    this.hide();
    this.onPick(p);
  }

  hide() {
    this.root.classList.add('hidden');
    this.visible = false;
  }
}
