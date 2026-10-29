/**
 * Hand gesture classification from WebXR hand-joint distances, with hysteresis so a gesture
 * doesn't flicker on and off at the threshold. Distances are in metres.
 */

export interface Thresholds {
  on: number;
  off: number;
}

/** Thumb tip ↔ index tip. */
export const PINCH: Thresholds = { on: 0.018, off: 0.035 };
/** Mean distance from the middle, ring and little finger tips to the wrist. */
export const FIST: Thresholds = { on: 0.095, off: 0.12 };

/** True while the distance is under `on`, until it rises past `off`. */
export function hysteresis(distance: number, wasOn: boolean, t: Thresholds): boolean {
  return wasOn ? distance < t.off : distance < t.on;
}

export function classifyPinch(thumbIndexDistance: number, wasPinching: boolean): boolean {
  return hysteresis(thumbIndexDistance, wasPinching, PINCH);
}

export function classifyFist(tipToWristDistances: number[], wasFist: boolean): boolean {
  if (!tipToWristDistances.length) return false;
  const mean = tipToWristDistances.reduce((a, b) => a + b, 0) / tipToWristDistances.length;
  return hysteresis(mean, wasFist, FIST);
}

/** Rising / falling edges of a boolean signal. */
export function edges(prev: boolean, now: boolean): { down: boolean; up: boolean } {
  return { down: !prev && now, up: prev && !now };
}

/**
 * Poke detection for a flat button. `depth` is the fingertip's signed distance to the button
 * plane along its normal (positive = in front), `inside` whether it is within the button's
 * width/height. A press fires when the tip crosses from in front to behind the surface while
 * inside, and the button then needs the tip to come back out (and a short cooldown) to fire again.
 */
export interface PokeState {
  armed: boolean;
  lastPress: number;
}

export const POKE = { front: 0.012, behind: -0.004, cooldownMs: 350, maxDepth: -0.06 };

export function pokeStep(state: PokeState, depth: number, inside: boolean, nowMs: number): { pressed: boolean; state: PokeState } {
  let { armed, lastPress } = state;
  let pressed = false;
  if (!inside || depth > POKE.front) {
    // In front of (or beside) the button: ready for a press.
    armed = true;
  } else if (armed && depth < POKE.behind && depth > POKE.maxDepth && nowMs - lastPress > POKE.cooldownMs) {
    pressed = true;
    armed = false;
    lastPress = nowMs;
  }
  return { pressed, state: { armed, lastPress } };
}

/** Hover: the tip is near the surface (in front) and inside its bounds. */
export function pokeHover(depth: number, inside: boolean): boolean {
  return inside && depth < 0.06 && depth > POKE.maxDepth;
}
