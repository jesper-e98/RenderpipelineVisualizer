type Child = Node | string | number | null | undefined | false;

export interface Props {
  attrs?: Record<string, string | number | boolean>;
  style?: Partial<CSSStyleDeclaration> | Record<string, string>;
  html?: string;
  text?: string;
  on?: Partial<{ [K in keyof HTMLElementEventMap]: (e: HTMLElementEventMap[K]) => void }>;
  dataset?: Record<string, string>;
}

/**
 * Tiny hyperscript helper. `h('div.card.glass', { text: 'hi' }, [child])`.
 * The tag may carry classes (`.a.b`) and an id (`#x`).
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K | `${K}.${string}` | `${K}#${string}`,
  props: Props = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const m = /^([a-z0-9]+)((?:[.#][\w-]+)*)$/i.exec(tag)!;
  const el = document.createElement(m[1] as K);
  for (const part of m[2].match(/[.#][\w-]+/g) ?? []) {
    if (part[0] === '.') el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  if (props.attrs) for (const [k, v] of Object.entries(props.attrs)) {
    if (v === false) continue;
    el.setAttribute(k, v === true ? '' : String(v));
  }
  if (props.style) Object.assign(el.style, props.style);
  if (props.dataset) Object.assign(el.dataset, props.dataset);
  if (props.html !== undefined) el.innerHTML = props.html;
  if (props.text !== undefined) el.textContent = props.text;
  if (props.on) for (const [k, fn] of Object.entries(props.on)) el.addEventListener(k, fn as EventListener);
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function s<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
  children: (SVGElement | string)[] = [],
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const c of children) el.append(c);
  return el;
}

export const reducedMotion = (): boolean => {
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

/** Animation duration helper: collapses to ~0 when the user prefers reduced motion. */
export const dur = (seconds: number): number => (reducedMotion() ? 0.001 : seconds);

/** Number formatting used in data panels. */
export function num(n: number, digits = 3): string {
  if (!Number.isFinite(n)) return String(n);
  const v = Math.abs(n) < 0.5 * 10 ** -digits ? 0 : n;
  return (v >= 0 ? ' ' : '') + v.toFixed(digits);
}

export function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
