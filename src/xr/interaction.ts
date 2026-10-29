/**
 * Pure interaction logic for the holo-UI: target sizes, sticky hover, select-on-release, poking
 * and the palm-up hand menu. No three.js objects, so it is all unit-testable.
 */

/** Smallest interactive target (metres). Smaller visuals get an invisible, larger hit area. */
export const MIN_TARGET = 0.04;

export function hitSize(w: number, h: number): [number, number] {
  return [Math.max(w, MIN_TARGET), Math.max(h, MIN_TARGET)];
}

/** Is local point (x, y) inside a w × h rectangle centred on the origin, grown by `margin`? */
export function inRect(x: number, y: number, w: number, h: number, margin = 0): boolean {
  return Math.abs(x) <= w / 2 + margin && Math.abs(y) <= h / 2 + margin;
}

export interface RayCandidate {
  id: string;
  /** Distance along the ray. */
  dist: number;
  /** Hit point relative to the target's centre, as a fraction of its half size (0 = centre, 1 = edge). */
  off: number;
  /** A background (panel plate): only wins when no interactive target is on the same surface. */
  passive?: boolean;
}

/**
 * Pick among ray hits: the nearest surface wins, but between targets on (nearly) the same surface,
 * e.g. neighbours whose enlarged hit areas overlap, the one whose centre is closest wins, and a
 * button always beats the panel it sits on.
 */
export function pickNearest<T extends RayCandidate>(hits: T[], sameSurface = 0.006): T | null {
  if (!hits.length) return null;
  const nearest = Math.min(...hits.map((h) => h.dist));
  let front = hits.filter((h) => h.dist <= nearest + sameSurface);
  if (front.some((h) => !h.passive)) front = front.filter((h) => !h.passive);
  return front.reduce((a, b) => (b.off < a.off ? b : a));
}

/* ------------------------------------------------------------------ */
/* Sticky hover                                                        */
/* ------------------------------------------------------------------ */

export interface HoverState {
  id: string | null;
  /** When the ray left the current target (hold time running), else null. */
  lostAt: number | null;
}

export const HOVER = {
  /** Keep a target this long after the ray slips off it into empty space. */
  holdMs: 120,
  /** The ray has to leave the current target's hit area by this much before another one takes over. */
  margin: 0.01,
};

/**
 * One step of sticky hover. `hit` = the target under the ray this frame (null = none),
 * `onCurrent` = the ray is still within the current target's hit area grown by `HOVER.margin`.
 * Switching to another target happens as soon as the ray clearly leaves the current one;
 * slipping off into nothing keeps the current target for `HOVER.holdMs`.
 */
export function stickyHover(s: HoverState, hit: string | null, onCurrent: boolean, nowMs: number): HoverState {
  if (s.id !== null && (onCurrent || hit === s.id)) return { id: s.id, lostAt: null };
  if (s.id !== null && hit === null) {
    const lostAt = s.lostAt ?? nowMs;
    if (nowMs - lostAt < HOVER.holdMs) return { id: s.id, lostAt };
  }
  return { id: hit, lostAt: null };
}

/* ------------------------------------------------------------------ */
/* Far select: fire on release over the same target                    */
/* ------------------------------------------------------------------ */

/**
 * Like the Quest system UI: pinching down on a target arms it, releasing over the same target
 * fires it. Sliding off before releasing cancels; sliding back on before releasing still fires.
 */
export function farSelect(pending: string | null, hover: string | null, down: boolean, up: boolean): { pending: string | null; fire: string | null } {
  if (down && up) return { pending: null, fire: hover }; // a whole click within one frame (simulator)
  if (down) return { pending: hover, fire: null };
  if (up) return { pending: null, fire: pending !== null && pending === hover ? pending : null };
  return { pending, fire: null };
}

/* ------------------------------------------------------------------ */
/* Poking                                                              */
/* ------------------------------------------------------------------ */

/**
 * Poke geometry (metres). The fingertip is a sphere of `radius`; `d` below is the signed distance
 * from that sphere's surface to the button plane (positive = in front, negative = pushed in).
 */
export const POKE = {
  radius: 0.01,
  /** Show the proximity ring / hover within this distance in front. */
  hover: 0.07,
  /** The finger has to be at least this far in front (inside the target area) to arm a press. */
  arm: 0.012,
  /** Push this deep to fire. */
  press: 0.006,
  /** Visual travel of a fully pressed button. */
  travel: 0.008,
  /** Deeper than this the finger has gone through: cancel. */
  through: 0.035,
  /** The target area is this much larger for a finger that is already pressing. */
  margin: 0.008,
  cooldownMs: 300,
};

export interface PokeState {
  armed: boolean;
  down: boolean;
  lastPress: number;
}

export const poke0 = (): PokeState => ({ armed: false, down: false, lastPress: -1e9 });

export interface PokeResult {
  state: PokeState;
  pressed: boolean;
  /** 0..1 how far the button is visually pushed in. */
  depth: number;
  /** The fingertip is touching (for dragging sliders). */
  touching: boolean;
}

/**
 * One step of poke detection for a target. Presses only arm when the finger is in front of the
 * target and inside its area, so a hand sweeping in from the side or from behind never fires.
 * After a press the finger has to pull back out (past `arm`) before the next one.
 */
export function pokeStep(s: PokeState, d: number, inside: boolean, nowMs: number): PokeResult {
  let { armed, down, lastPress } = s;
  let pressed = false;
  if (!inside || d < -POKE.through) {
    armed = false;
    down = false;
  } else if (d > POKE.arm) {
    armed = true;
    down = false;
  } else if (armed && -d >= POKE.press && nowMs - lastPress >= POKE.cooldownMs) {
    pressed = true;
    armed = false;
    down = true;
    lastPress = nowMs;
  }
  const pushing = inside && (armed || down);
  return {
    state: { armed, down, lastPress },
    pressed,
    depth: pushing ? Math.min(1, Math.max(0, -d / POKE.travel)) : 0,
    touching: pushing && d < 0,
  };
}

/** Hover by finger: in front of the target, close enough, within its area. */
export function pokeHover(d: number, inside: boolean): boolean {
  return inside && d < POKE.hover && d > -POKE.through;
}

/* ------------------------------------------------------------------ */
/* Palm-up hand menu                                                   */
/* ------------------------------------------------------------------ */

export const PALM = {
  /** Palm normal · direction to the head must exceed this to show the menu… */
  show: 0.7,
  /** …and fall below this to hide it. */
  hide: 0.45,
  showMs: 180,
  hideMs: 250,
  /** The hand has to be this still (m/s) for the menu to appear. */
  maxSpeed: 0.6,
};

export interface PalmState {
  shown: boolean;
  since: number | null;
}

/**
 * Show the hand menu once the palm has faced the user (steadily) for `showMs`, hide it once it has
 * turned away (or tracking is lost: `facing` null) for `hideMs`.
 */
export function palmMenuStep(s: PalmState, facing: number | null, speed: number, nowMs: number): PalmState {
  const want = facing === null ? false : s.shown ? facing > PALM.hide : facing > PALM.show && speed < PALM.maxSpeed;
  if (want === s.shown) return { shown: s.shown, since: null };
  const since = s.since ?? nowMs;
  if (nowMs - since >= (s.shown ? PALM.hideMs : PALM.showMs)) return { shown: want, since: null };
  return { shown: s.shown, since };
}
