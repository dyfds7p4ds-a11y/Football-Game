/**
 * Phase 3c: the audible picker. A small row of 2-3 plays the QB can check to
 * at the line, each with its play-clock cost; 1 / 2 / 3 (or a tap) picks,
 * AUDIBLE again (or the X) closes it. Phase 4: generic over the item, so the
 * defensive ADJUST menu (coverage shells and blitz looks) uses it too.
 */
import type { PlayData } from '../data/types';
import { h } from './dom';

export class AudibleMenu<T extends { name: string } = PlayData> {
  readonly root: HTMLElement;
  private list: HTMLElement;
  private info: HTMLElement;
  private options: T[] = [];
  visible = false;

  constructor(
    private onPick: (p: T) => void,
    title = 'AUDIBLE',
    private tag: (p: T) => string = (p) => (p as unknown as PlayData).category.toUpperCase(),
  ) {
    this.list = h('div', { class: 'aud-list' });
    this.info = h('div', { class: 'aud-info' });
    const close = h('button', { class: 'aud-close' }, '×');
    close.addEventListener('pointerup', (e) => {
      e.preventDefault();
      this.hide();
    });
    this.root = h('div', { id: 'audible', class: 'hidden' }, h('div', { class: 'aud-head' }, title, close), this.list, this.info);
  }

  show(options: T[], cost: number, left: number) {
    this.options = options;
    this.list.replaceChildren(...options.map((p, i) => {
      const b = h('button', { class: 'aud-opt' }, h('span', { class: 'aud-key' }, String(i + 1)), h('span', {}, p.name),
        h('span', { class: 'aud-cat' }, this.tag(p)));
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
