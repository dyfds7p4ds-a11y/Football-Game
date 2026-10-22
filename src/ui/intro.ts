/** Letterboxed caption overlay for the intro cutscenes; any tap skips to the game. */
import { h } from './dom';

export class IntroOverlay {
  readonly root = h('div', { id: 'intro', class: 'hidden' });
  private cap = h('div', { class: 'cap' });
  private sub = h('div', { class: 'sub' });

  constructor() {
    this.root.append(h('div', { class: 'bars top' }), h('div', { class: 'bars bottom' }), h('div', { class: 'skip' }, 'TAP TO SKIP ▸▸'), this.cap, this.sub);
  }

  show(on: boolean) {
    this.root.classList.toggle('hidden', !on);
  }

  setCaption(title: string, sub: string) {
    if (this.cap.textContent !== title) this.cap.textContent = title;
    if (this.sub.textContent !== sub) this.sub.textContent = sub;
  }
}
