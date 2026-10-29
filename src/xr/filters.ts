import { Quaternion, Vector3 } from 'three';

/**
 * Jitter filters for hand / controller tracking.
 *
 * The One Euro filter (Casiez et al., CHI 2012) is a low-pass filter whose cutoff frequency rises
 * with speed: when the hand is still it smooths hard (no jitter), when it moves fast it barely
 * smooths (little lag). `minCutoff` (Hz) sets the smoothing at rest, `beta` how quickly the cutoff
 * rises with speed (units/s), `dCutoff` (Hz) smooths the speed estimate itself.
 */
export interface OneEuroParams {
  minCutoff: number;
  beta: number;
  dCutoff: number;
}

/** Ready-made settings, tuned for metres (positions) and unit vectors (directions) at 72–120 Hz. */
export const FILTER_PRESETS = {
  /** Hand joints for the skeleton drawing. */
  joint: { minCutoff: 1.6, beta: 6, dCutoff: 1 },
  /** Pinch point / grip: what grabbed objects follow. */
  grip: { minCutoff: 1.3, beta: 6, dCutoff: 1 },
  /** Index fingertip: poking wants a little less lag. */
  tip: { minCutoff: 2.2, beta: 9, dCutoff: 1 },
  /** Ray origin. */
  rayOrigin: { minCutoff: 1.2, beta: 5, dCutoff: 1 },
  /** Ray direction (unit vector, speed ≈ rad/s). Jitter here is amplified by distance, so smooth harder. */
  rayDir: { minCutoff: 0.9, beta: 3, dCutoff: 1.2 },
  /** Hand / controller orientation. */
  rotation: { minCutoff: 1.2, beta: 1.5, dCutoff: 1 },
  /** Controllers are tracked far better than hands: filter lightly. */
  controller: { minCutoff: 4, beta: 12, dCutoff: 1 },
  controllerDir: { minCutoff: 2.5, beta: 6, dCutoff: 1.2 },
} satisfies Record<string, OneEuroParams>;

/** Smoothing factor of a first-order low-pass filter with the given cutoff, for a step of `dt` seconds. */
export function smoothingAlpha(cutoffHz: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * Math.max(cutoffHz, 1e-6));
  return 1 / (1 + tau / dt);
}

/** Exponential smoothing factor for time constant `tau` (seconds): x += (target − x) · factor. */
export function expSmoothing(dt: number, tau: number): number {
  if (tau <= 0) return 1;
  return 1 - Math.exp(-Math.max(0, dt) / tau);
}

/** Clamp silly frame times (first frame, tab switches) to something the filters can digest. */
function safeDt(dt: number): number {
  return Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.1) : 1 / 72;
}

/** One Euro filter for a scalar. */
export class OneEuro {
  private x: number | null = null;
  private prev = 0;
  private dx = 0;
  constructor(public params: OneEuroParams = FILTER_PRESETS.joint) {}

  /** Filtered rate of change (units/s). */
  get speed(): number {
    return Math.abs(this.dx);
  }

  get value(): number | null {
    return this.x;
  }

  reset(): void {
    this.x = null;
    this.dx = 0;
  }

  filter(value: number, dt: number): number {
    if (this.x === null) {
      this.x = value;
      this.prev = value;
      this.dx = 0;
      return value;
    }
    dt = safeDt(dt);
    // Speed from consecutive raw samples (unbiased by the filter's own lag).
    const rate = (value - this.prev) / dt;
    this.prev = value;
    this.dx += smoothingAlpha(this.params.dCutoff, dt) * (rate - this.dx);
    const cutoff = this.params.minCutoff + this.params.beta * Math.abs(this.dx);
    this.x += smoothingAlpha(cutoff, dt) * (value - this.x);
    return this.x;
  }
}

/**
 * One Euro filter for a 3D point (or direction). The cutoff follows the magnitude of the velocity,
 * so all three axes are smoothed alike and a diagonal movement isn't treated as slower.
 */
export class OneEuroVec3 {
  readonly value = new Vector3();
  private velocity = new Vector3();
  private rate = new Vector3();
  private prev = new Vector3();
  private has = false;
  constructor(public params: OneEuroParams = FILTER_PRESETS.joint) {}

  get initialized(): boolean {
    return this.has;
  }

  /** Filtered speed (units/s). */
  get speed(): number {
    return this.velocity.length();
  }

  reset(): void {
    this.has = false;
    this.velocity.set(0, 0, 0);
  }

  /** Filter `v` and return the (shared) filtered vector. */
  filter(v: Vector3, dt: number): Vector3 {
    if (!this.has) {
      this.value.copy(v);
      this.prev.copy(v);
      this.velocity.set(0, 0, 0);
      this.has = true;
      return this.value;
    }
    dt = safeDt(dt);
    this.rate.copy(v).sub(this.prev).divideScalar(dt);
    this.prev.copy(v);
    this.velocity.lerp(this.rate, smoothingAlpha(this.params.dCutoff, dt));
    const cutoff = this.params.minCutoff + this.params.beta * this.velocity.length();
    this.value.lerp(v, smoothingAlpha(cutoff, dt));
    return this.value;
  }
}

/**
 * One Euro filter for orientations: slerps towards the new rotation with an alpha that grows with
 * the filtered angular speed. Takes the short way round (q and −q are the same rotation).
 */
export class OneEuroQuat {
  readonly value = new Quaternion();
  private prev = new Quaternion();
  private omega = 0;
  private has = false;
  constructor(public params: OneEuroParams = FILTER_PRESETS.rotation) {}

  /** Filtered angular speed (rad/s). */
  get speed(): number {
    return this.omega;
  }

  reset(): void {
    this.has = false;
    this.omega = 0;
  }

  filter(q: Quaternion, dt: number): Quaternion {
    if (!this.has) {
      this.value.copy(q).normalize();
      this.prev.copy(this.value);
      this.omega = 0;
      this.has = true;
      return this.value;
    }
    dt = safeDt(dt);
    const angle = this.prev.angleTo(q);
    this.prev.copy(q);
    this.omega += smoothingAlpha(this.params.dCutoff, dt) * (angle / dt - this.omega);
    const cutoff = this.params.minCutoff + this.params.beta * this.omega;
    this.value.slerp(q, smoothingAlpha(cutoff, dt)).normalize();
    return this.value;
  }
}
