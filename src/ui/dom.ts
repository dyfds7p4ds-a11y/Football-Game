/** Tiny DOM helper: h('div', { class: 'x', onclick }, ...children). */
type Attrs = Record<string, unknown>;
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Node | string | null | false)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== false) el.append(c);
  return el;
}

/** Fires on pointerup inside the element (works with multi-touch, no 300ms delay). */
export function onTap(el: HTMLElement, fn: () => void) {
  el.addEventListener('pointerup', (e) => {
    e.preventDefault();
    fn();
  });
}
