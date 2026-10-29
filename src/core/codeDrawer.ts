/**
 * The code drawer: one place for the current slide's API panel (code, terms, who does what),
 * opened from the control dock instead of living inside every slide. Slides hand their panel
 * element over with `mountCode`; the dock listens for changes to enable/label its button.
 */
let host: HTMLElement | null = null;
let current: HTMLElement | null = null;
const listeners = new Set<(hasCode: boolean) => void>();

export function setCodeDrawerHost(el: HTMLElement): void {
  host = el;
}

/** Show `el` (or nothing, for slides without code) in the drawer. */
export function mountCode(el: HTMLElement | null): void {
  current = el;
  if (host) host.replaceChildren(...(el ? [el] : []));
  listeners.forEach((fn) => fn(!!el));
}

/** A slide is going away: clear the drawer only if it still shows that slide's panel. */
export function unmountCode(el: HTMLElement | null): void {
  if (el && current === el) mountCode(null);
}

export function onCodeChange(fn: (hasCode: boolean) => void): void {
  listeners.add(fn);
}
