/**
 * Hand gesture classification from WebXR hand-joint distances. Pure functions, so they can be
 * unit-tested without a headset.
 *
 * Pinch and fist go through the same small state machine (`latchStep`):
 *  - hysteresis: a gesture starts under one threshold and ends over a wider one, and the end
 *    threshold is wider still while something is being held,
 *  - grace: a release only counts once the hand has stayed open for `graceMs`, so a single noisy
 *    frame mid-drag doesn't drop what you hold,
 *  - dropouts: frames where the joints aren't tracked keep the last state (for up to `dropoutMs`),
 *  - no starts while the hand moves fast (a swipe that happens to close the fingers isn't a pinch).
 * Distances are normalised by hand size, so small and large hands get the same feel.
 */

export interface Thresholds {
  on: number;
  off: number;
}

/** Legacy absolute thresholds (metres) for an average adult hand. */
export const PINCH: Thresholds = { on: 0.018, off: 0.035 };
export const FIST: Thresholds = { on: 0.095, off: 0.12 };

/** Palm length (wrist → index metacarpal → index knuckle) of the reference hand, metres. */
export const REF_HAND = 0.09;

/** Pinch thresholds as a fraction of hand size (0.2 × 9 cm ≈ 18 mm). `offHeld` applies while holding. */
export const PINCH_N = { on: 0.2, off: 0.38, offHeld: 0.56 };
/** Fist thresholds: mean middle/ring/little fingertip → wrist distance as a fraction of hand size. */
export const FIST_N = { on: 1.05, off: 1.33, offHeld: 1.45 };

export const GESTURE_TIMING = {
  /** A release must last this long before it is accepted. */
  graceMs: 120,
  /** Tracking may drop out this long without changing the gesture. */
  dropoutMs: 300,
  /** Pinches don't start while the hand moves faster than this (m/s). */
  maxStartSpeed: 1.2,
};

/** True while the distance is under `on`, until it rises past `off`. */
export function hysteresis(distance: number, wasOn: boolean, t: Thresholds): boolean {
  return wasOn ? distance < t.off : distance < t.on;
}

/** Simple absolute-distance pinch (kept for tools and tests). */
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
 * Hand size used for normalisation. Unknown or implausible measurements fall back to the
 * reference hand, and the result is clamped so a glitchy frame can't make pinching impossible.
 */
export function handSize(palmLength: number | null | undefined): number {
  if (!palmLength || !Number.isFinite(palmLength)) return REF_HAND;
  return Math.min(REF_HAND * 1.4, Math.max(REF_HAND * 0.7, palmLength));
}

/** How close to a pinch the fingers are: 0 = open, 1 = pinching. For cursor feedback. */
export function pinchStrength(distance: number | null, size: number | null = REF_HAND): number {
  if (distance === null) return 0;
  const r = distance / handSize(size);
  return Math.min(1, Math.max(0, (0.7 - r) / (0.7 - PINCH_N.on)));
}

export interface LatchState {
  on: boolean;
  /** When the raw signal last went off while `on` (grace period running), else null. */
  offSince: number | null;
  /** When tracking was lost (dropout running), else null. */
  lostSince: number | null;
}

export const latch0 = (): LatchState => ({ on: false, offSince: null, lostSince: null });

export interface LatchOptions {
  canStart: boolean;
  graceMs: number;
  dropoutMs: number;
}

/**
 * One step of the gesture latch. `raw` is this frame's classification, or null when the joints
 * needed for it weren't tracked.
 */
export function latchStep(s: LatchState, raw: boolean | null, nowMs: number, o: LatchOptions): LatchState {
  if (raw === null) {
    const lostSince = s.lostSince ?? nowMs;
    if (s.on && nowMs - lostSince > o.dropoutMs) return { on: false, offSince: null, lostSince };
    return { on: s.on, offSince: s.offSince, lostSince };
  }
  if (raw) {
    if (s.on || o.canStart) return { on: true, offSince: null, lostSince: null };
    return { on: false, offSince: null, lostSince: null };
  }
  if (!s.on) return { on: false, offSince: null, lostSince: null };
  const offSince = s.offSince ?? nowMs;
  if (nowMs - offSince >= o.graceMs) return { on: false, offSince: null, lostSince: null };
  return { on: true, offSince, lostSince: null };
}

export interface PinchInput {
  /** Thumb tip ↔ index tip (m), or null if either isn't tracked. */
  distance: number | null;
  /** Measured palm length (m), see `handSize`. */
  size: number | null;
  /** Something is held: use the wider release threshold. */
  held: boolean;
  /** Hand speed (m/s). */
  speed: number;
  nowMs: number;
  /** Force the raw signal off (e.g. the hand is a fist). */
  suppress?: boolean;
  /** The platform's own pinch/select is pressed: keeps an ongoing pinch alive (never starts one). */
  systemHold?: boolean;
}

export function pinchStep(s: LatchState, i: PinchInput, timing = GESTURE_TIMING): LatchState {
  let raw: boolean | null = null;
  if (i.distance !== null) {
    const r = i.distance / handSize(i.size);
    const off = i.held ? PINCH_N.offHeld : PINCH_N.off;
    raw = !i.suppress && (s.on ? r < off || !!i.systemHold : r < PINCH_N.on);
  }
  return latchStep(s, raw, i.nowMs, { canStart: i.speed < timing.maxStartSpeed, graceMs: timing.graceMs, dropoutMs: timing.dropoutMs });
}

export interface FistInput {
  /** Middle, ring and little fingertip → wrist distances (m) that were tracked; null = none. */
  tipToWrist: number[] | null;
  size: number | null;
  held: boolean;
  nowMs: number;
}

export function fistStep(s: LatchState, i: FistInput, timing = GESTURE_TIMING): LatchState {
  let raw: boolean | null = null;
  if (i.tipToWrist && i.tipToWrist.length) {
    const mean = i.tipToWrist.reduce((a, b) => a + b, 0) / i.tipToWrist.length;
    const r = mean / handSize(i.size);
    raw = s.on ? r < (i.held ? FIST_N.offHeld : FIST_N.off) : r < FIST_N.on;
  }
  return latchStep(s, raw, i.nowMs, { canStart: true, graceMs: timing.graceMs, dropoutMs: timing.dropoutMs });
}
