import { Matrix4, Quaternion, Vector3 } from 'three';

/**
 * Grab / rotate / scale / pull-apart maths for the hologram, as pure functions so they can be
 * unit-tested without a headset.
 */

export const SCALE_LIMITS = { min: 0.06, max: 0.9 };

/**
 * One-hand grab: the object keeps its pose relative to the hand from the moment of grabbing.
 * Returns the object's new world matrix.
 */
export function oneHandPose(handAtGrab: Matrix4, objectAtGrab: Matrix4, handNow: Matrix4): Matrix4 {
  const offset = handAtGrab.clone().invert().multiply(objectAtGrab);
  return handNow.clone().multiply(offset);
}

export interface Pose {
  position: Vector3;
  quaternion: Quaternion;
  scale: number;
}

/** Dead zones of two-hand manipulation: scale in log units (0.06 ≈ 6 %), yaw in radians. */
export const TWO_HAND = { scaleDeadZone: 0.06, scaleRamp: 0.1, yawDeadZone: 0.05, yawRamp: 0.12 };

/**
 * Soft dead zone: 0 while |x| < `dz`, then a quadratic ramp over `ramp` that blends into a 1:1
 * slope (continuous and with a continuous derivative, so nothing jumps when it engages).
 */
export function softDeadZone(x: number, dz: number, ramp: number): number {
  const t = Math.abs(x) - dz;
  if (t <= 0) return 0;
  const y = ramp > 0 && t < ramp ? (t * t) / (2 * ramp) : t - ramp / 2;
  return Math.sign(x) * y;
}

/**
 * Two-hand manipulation: the change in distance between the hands scales the object, the change
 * in direction of the hand-to-hand vector rotates it, both pivoting around the hands' midpoint,
 * which the object follows. Small changes fall in a dead zone so moving both hands doesn't wobble
 * the scale, and rotating doesn't creep. Rotation is limited to yaw, keeping the hologram upright.
 */
export function twoHandPose(
  a0: Vector3,
  b0: Vector3,
  a1: Vector3,
  b1: Vector3,
  start: Pose,
  limits = SCALE_LIMITS,
  dz = TWO_HAND,
): Pose {
  const v0 = b0.clone().sub(a0);
  const v1 = b1.clone().sub(a1);
  const d0 = Math.max(v0.length(), 1e-4);
  const d1 = Math.max(v1.length(), 1e-4);
  const logRatio = softDeadZone(Math.log(d1 / d0), dz.scaleDeadZone, dz.scaleRamp);
  const scale = clamp(start.scale * Math.exp(logRatio), limits.min, limits.max);
  const ratio = scale / start.scale;

  const yaw0 = Math.atan2(v0.x, v0.z);
  const yaw1 = Math.atan2(v1.x, v1.z);
  const yaw = softDeadZone(wrapAngle(yaw1 - yaw0), dz.yawDeadZone, dz.yawRamp);
  const rot = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw);

  const mid0 = a0.clone().add(b0).multiplyScalar(0.5);
  const mid1 = a1.clone().add(b1).multiplyScalar(0.5);
  const rel = start.position.clone().sub(mid0).applyQuaternion(rot).multiplyScalar(ratio);
  return {
    position: mid1.clone().add(rel),
    quaternion: rot.clone().multiply(start.quaternion),
    scale,
  };
}

/** Angle wrapped to (−π, π]. */
export function wrapAngle(a: number): number {
  a = ((((a + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI;
  return a === -Math.PI ? Math.PI : a;
}

/**
 * Exact step of a critically damped spring (no overshoot) towards `target`; `omega` (rad/s) sets
 * the stiffness, ~1/omega is the time constant. Returns [position, velocity].
 */
export function springStep(x: number, v: number, target: number, omega: number, dt: number): [number, number] {
  const y = x - target;
  const e = Math.exp(-omega * dt);
  const b = v + omega * y;
  return [target + (y + b * dt) * e, (v - omega * b * dt) * e];
}

/** `springStep` for angles: takes the short way round. */
export function springAngle(x: number, v: number, target: number, omega: number, dt: number): [number, number] {
  const [y, nv] = springStep(0, v, wrapAngle(target - x), omega, dt);
  return [x + y, nv];
}

/**
 * Exponential smoothing of a whole pose towards `target` with time constant `tau` (s): position
 * lerps, rotation slerps, scale moves in log space. Mutates and returns `current`.
 */
export function dampPose(current: Pose, target: Pose, dt: number, tau = 0.05): Pose {
  const k = tau <= 0 ? 1 : 1 - Math.exp(-Math.max(0, dt) / tau);
  current.position.lerp(target.position, k);
  current.quaternion.slerp(target.quaternion, k);
  current.scale = Math.exp(Math.log(current.scale) + (Math.log(target.scale) - Math.log(current.scale)) * k);
  return current;
}

/** Has `current` reached `target` (within a millimetre, a tenth of a degree, 0.1 % scale)? */
export function poseSettled(current: Pose, target: Pose): boolean {
  return (
    current.position.distanceTo(target.position) < 0.001 &&
    current.quaternion.angleTo(target.quaternion) < 0.002 &&
    Math.abs(current.scale / target.scale - 1) < 0.001
  );
}

/**
 * Tracks how long a condition has held: returns the time it became true (kept while it stays
 * true) or null. "Held for 150 ms" = `since !== null && now - since >= 150`.
 */
export function heldSince(since: number | null, condition: boolean, nowMs: number): number | null {
  if (!condition) return null;
  return since ?? nowMs;
}

/** Explode needs both fists closed and held still for this long (ms) at under `maxSpeed` (m/s). */
export const EXPLODE_GATE = { steadyMs: 150, maxSpeed: 0.45 };

/** Two fists pulled apart → explode amount (0 = assembled). */
export function explodeFromHands(d0: number, d1: number, explodeAtStart: number, gain = 2.2, max = 1.4): number {
  return clamp(explodeAtStart + (d1 - d0) * gain, 0, max);
}

/** Angular velocity (rad/s) around world up from two orientations `dt` seconds apart. */
export function yawVelocity(q0: Quaternion, q1: Quaternion, dt: number): number {
  if (dt <= 0) return 0;
  const f0 = new Vector3(0, 0, -1).applyQuaternion(q0);
  const f1 = new Vector3(0, 0, -1).applyQuaternion(q1);
  let d = Math.atan2(f1.x, f1.z) - Math.atan2(f0.x, f0.z);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d / dt;
}

/** Exponential spin-down after a throw. */
export function decaySpin(omega: number, dt: number, rate = 1.8): number {
  const next = omega * Math.exp(-rate * dt);
  return Math.abs(next) < 0.02 ? 0 : next;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Far grab (ray on the hologram + pinch): the object rides on the ray at the distance where it was
 * grabbed, keeping the offset from the grab point. Moving the hand away from / towards the body
 * (`reach`, hand ↔ head distance) pushes / pulls it, amplified by `gain`.
 */
export function farGrabPosition(
  origin: Vector3,
  dir: Vector3,
  grabDist: number,
  reachAtGrab: number,
  reachNow: number,
  offset: Vector3,
  gain = 2.5,
  range: [number, number] = [0.2, 4],
): Vector3 {
  const d = clamp(grabDist + (reachNow - reachAtGrab) * gain, range[0], range[1]);
  return origin.clone().addScaledVector(dir.clone().normalize(), d).add(offset);
}
