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

/**
 * Two-hand manipulation: the change in distance between the hands scales the object, the change
 * in direction of the hand-to-hand vector rotates it, and it stays anchored at the hands' midpoint.
 * Rotation is limited to yaw (around world up), which keeps the hologram upright.
 */
export function twoHandPose(
  a0: Vector3,
  b0: Vector3,
  a1: Vector3,
  b1: Vector3,
  start: Pose,
  limits = SCALE_LIMITS,
): Pose {
  const v0 = b0.clone().sub(a0);
  const v1 = b1.clone().sub(a1);
  const d0 = Math.max(v0.length(), 1e-4);
  const d1 = Math.max(v1.length(), 1e-4);
  const scale = clamp(start.scale * (d1 / d0), limits.min, limits.max);
  const ratio = scale / start.scale;

  // Yaw from the horizontal projections, pitch from the elevation change.
  const yaw0 = Math.atan2(v0.x, v0.z);
  const yaw1 = Math.atan2(v1.x, v1.z);
  const qYaw = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw1 - yaw0);
  const rot = qYaw;

  const mid0 = a0.clone().add(b0).multiplyScalar(0.5);
  const mid1 = a1.clone().add(b1).multiplyScalar(0.5);
  const rel = start.position.clone().sub(mid0).applyQuaternion(rot).multiplyScalar(ratio);
  return {
    position: mid1.clone().add(rel),
    quaternion: rot.clone().multiply(start.quaternion),
    scale,
  };
}

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
