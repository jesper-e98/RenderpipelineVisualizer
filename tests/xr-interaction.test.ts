import { Matrix4, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  classifyFist,
  classifyPinch,
  edges,
  fistStep,
  GESTURE_TIMING,
  handSize,
  latch0,
  pinchStep,
  pinchStrength,
  REF_HAND,
  type LatchState,
  type PinchInput,
} from '../src/xr/gestures';
import {
  dampPose,
  decaySpin,
  EXPLODE_GATE,
  explodeFromHands,
  farGrabPosition,
  heldSince,
  oneHandPose,
  poseSettled,
  SCALE_LIMITS,
  softDeadZone,
  springAngle,
  springStep,
  TWO_HAND,
  twoHandPose,
  wrapAngle,
  yawVelocity,
} from '../src/xr/manipulate';

describe('gestures (legacy helpers)', () => {
  it('pinch uses hysteresis', () => {
    expect(classifyPinch(0.03, false)).toBe(false);
    expect(classifyPinch(0.015, false)).toBe(true);
    expect(classifyPinch(0.03, true)).toBe(true);
    expect(classifyPinch(0.04, true)).toBe(false);
  });
  it('fist from mean fingertip-to-wrist distance', () => {
    expect(classifyFist([0.08, 0.09, 0.085], false)).toBe(true);
    expect(classifyFist([0.15, 0.16, 0.17], false)).toBe(false);
    expect(classifyFist([0.11, 0.11, 0.11], true)).toBe(true);
    expect(classifyFist([], true)).toBe(false);
  });
  it('edges', () => {
    expect(edges(false, true)).toEqual({ down: true, up: false });
    expect(edges(true, false)).toEqual({ down: false, up: true });
  });
});

/** Run a pinch through a sequence of frames, 11 ms apart (90 Hz). */
function run(frames: Partial<PinchInput>[], s: LatchState = latch0(), t0 = 0): { s: LatchState; on: boolean[] } {
  const on: boolean[] = [];
  frames.forEach((f, i) => {
    s = pinchStep(s, { distance: 0.05, size: REF_HAND, held: false, speed: 0, nowMs: t0 + i * 11, ...f });
    on.push(s.on);
  });
  return { s, on };
}

describe('pinch', () => {
  it('normalises by hand size: the same finger gap is a pinch for a big hand, not for a small one', () => {
    const gap = 0.02;
    expect(pinchStep(latch0(), { distance: gap, size: 0.11, held: false, speed: 0, nowMs: 0 }).on).toBe(true);
    expect(pinchStep(latch0(), { distance: gap, size: 0.07, held: false, speed: 0, nowMs: 0 }).on).toBe(false);
    // Unknown or silly hand sizes fall back to / are clamped around the reference hand.
    expect(handSize(null)).toBe(REF_HAND);
    expect(handSize(0.01)).toBeCloseTo(REF_HAND * 0.7);
    expect(handSize(1)).toBeCloseTo(REF_HAND * 1.4);
  });

  it('a short opening mid-pinch (< 120 ms) does not release', () => {
    const frames = [
      { distance: 0.01 }, // pinch
      { distance: 0.01 },
      ...Array.from({ length: 8 }, () => ({ distance: 0.05 })), // 88 ms open (noise)
      { distance: 0.01 },
      { distance: 0.01 },
    ];
    const r = run(frames);
    expect(r.on.every((x) => x)).toBe(true);
  });

  it('a real release is accepted after the grace period', () => {
    const frames = [{ distance: 0.01 }, ...Array.from({ length: 16 }, () => ({ distance: 0.05 }))];
    const r = run(frames);
    const off = r.on.indexOf(false);
    expect(off).toBeGreaterThan(0);
    expect((off - 1) * 11).toBeGreaterThanOrEqual(GESTURE_TIMING.graceMs);
    expect(r.s.on).toBe(false);
  });

  it('holds on through tracking dropouts, but lets go after a long loss', () => {
    let r = run([{ distance: 0.01 }, ...Array.from({ length: 10 }, () => ({ distance: null }))]);
    expect(r.on.every((x) => x)).toBe(true);
    r = run([{ distance: 0.01 }, ...Array.from({ length: 40 }, () => ({ distance: null }))]);
    expect(r.s.on).toBe(false);
    // A dropout never starts a pinch.
    expect(run([{ distance: null }, { distance: null }]).s.on).toBe(false);
  });

  it('uses a wider release threshold while holding something', () => {
    const d = REF_HAND * 0.45; // between off (0.38) and offHeld (0.56)
    const free = run([{ distance: 0.01 }, ...Array.from({ length: 20 }, () => ({ distance: d }))]);
    const held = run([{ distance: 0.01, held: true }, ...Array.from({ length: 20 }, () => ({ distance: d, held: true }))]);
    expect(free.s.on).toBe(false);
    expect(held.s.on).toBe(true);
  });

  it('ignores pinch starts while the hand moves fast, but fast moves never drop a held pinch', () => {
    expect(run([{ distance: 0.01, speed: 2 }]).s.on).toBe(false);
    const r = run([{ distance: 0.01 }, { distance: 0.01, speed: 3 }, { distance: 0.01, speed: 3 }]);
    expect(r.s.on).toBe(true);
  });

  it('the system pinch keeps a pinch alive but never starts one; a fist suppresses it', () => {
    expect(run([{ distance: 0.05, systemHold: true }]).s.on).toBe(false);
    const kept = run([{ distance: 0.01 }, ...Array.from({ length: 20 }, () => ({ distance: 0.05, systemHold: true }))]);
    expect(kept.s.on).toBe(true);
    const fist = run([{ distance: 0.01 }, ...Array.from({ length: 20 }, () => ({ distance: 0.01, suppress: true }))]);
    expect(fist.s.on).toBe(false);
  });

  it('reports pinch strength for cursor feedback', () => {
    expect(pinchStrength(null)).toBe(0);
    expect(pinchStrength(0.1)).toBe(0);
    expect(pinchStrength(0.01)).toBe(1);
    const mid = pinchStrength(0.04);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });
});

describe('fist', () => {
  it('needs curled fingers, has a grace period and survives dropouts', () => {
    let s = fistStep(latch0(), { tipToWrist: [0.08, 0.085, 0.08], size: REF_HAND, held: false, nowMs: 0 });
    expect(s.on).toBe(true);
    s = fistStep(s, { tipToWrist: [0.17, 0.17, 0.17], size: REF_HAND, held: false, nowMs: 50 });
    expect(s.on).toBe(true); // within grace
    s = fistStep(s, { tipToWrist: null, size: REF_HAND, held: false, nowMs: 100 });
    expect(s.on).toBe(true);
    s = fistStep(s, { tipToWrist: [0.17, 0.17, 0.17], size: REF_HAND, held: false, nowMs: 300 });
    s = fistStep(s, { tipToWrist: [0.17, 0.17, 0.17], size: REF_HAND, held: false, nowMs: 450 });
    expect(s.on).toBe(false);
  });
});

describe('manipulation', () => {
  it('one-hand grab keeps the object fixed relative to the hand', () => {
    const hand0 = new Matrix4().makeTranslation(0, 1, 0);
    const obj0 = new Matrix4().makeTranslation(0, 1.2, -0.5);
    const hand1 = new Matrix4().makeRotationY(Math.PI / 2).setPosition(1, 1, 0);
    const p = new Vector3().setFromMatrixPosition(oneHandPose(hand0, obj0, hand1));
    expect(p.x).toBeCloseTo(0.5, 5);
    expect(p.y).toBeCloseTo(1.2, 5);
    expect(p.z).toBeCloseTo(0, 5);
  });

  const start = { position: new Vector3(0, 1.2, -0.6), quaternion: new Quaternion(), scale: 0.2 };
  const L0 = new Vector3(-0.1, 1.2, -0.6);
  const R0 = new Vector3(0.1, 1.2, -0.6);

  it('soft dead zone: flat, then a smooth ramp into 1:1', () => {
    expect(softDeadZone(0.03, 0.05, 0.1)).toBe(0);
    expect(softDeadZone(-0.05, 0.05, 0.1)).toBe(0);
    const a = softDeadZone(0.08, 0.05, 0.1);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(0.03); // ramping, slower than 1:1
    // Continuous at the end of the ramp and 1:1 beyond it.
    expect(softDeadZone(0.15, 0.05, 0.1)).toBeCloseTo(0.05, 6);
    expect(softDeadZone(0.15 + 1e-4, 0.05, 0.1)).toBeCloseTo(0.05 + 1e-4, 6);
    expect(softDeadZone(0.5, 0.05, 0.1) - softDeadZone(0.4, 0.05, 0.1)).toBeCloseTo(0.1, 6);
    expect(softDeadZone(-0.5, 0.05, 0.1)).toBeCloseTo(-softDeadZone(0.5, 0.05, 0.1), 9);
  });

  it('two hands: small changes in hand distance do not wobble the scale', () => {
    const r = twoHandPose(L0, R0, new Vector3(-0.102, 1.2, -0.6), new Vector3(0.103, 1.2, -0.6), start);
    expect(r.scale).toBe(0.2);
  });

  it('two hands moving apart scale up around their midpoint (beyond the dead zone)', () => {
    const r = twoHandPose(L0, R0, new Vector3(-0.2, 1.2, -0.6), new Vector3(0.2, 1.2, -0.6), start);
    const expected = 0.2 * Math.exp(Math.log(2) - TWO_HAND.scaleDeadZone - TWO_HAND.scaleRamp / 2);
    expect(r.scale).toBeCloseTo(expected, 5);
    expect(r.scale).toBeGreaterThan(0.3);
    expect(r.position.distanceTo(start.position)).toBeLessThan(1e-6);
  });

  it('two hands rotating around each other yaw the object around their midpoint', () => {
    const r = twoHandPose(L0, R0, new Vector3(0, 1.2, -0.5), new Vector3(0, 1.2, -0.7), start);
    const f = new Vector3(1, 0, 0).applyQuaternion(r.quaternion);
    // ~90° minus the dead zone.
    const yaw = Math.atan2(-f.z, f.x);
    expect(Math.abs(yaw)).toBeCloseTo(Math.PI / 2 - TWO_HAND.yawDeadZone - TWO_HAND.yawRamp / 2, 4);
    expect(r.scale).toBeCloseTo(0.2, 5);
    // Pivot: an object off to the side of the hands swings around the hands' midpoint.
    const off = { ...start, position: new Vector3(0.3, 1.2, -0.6) };
    const r2 = twoHandPose(L0, R0, new Vector3(0, 1.2, -0.5), new Vector3(0, 1.2, -0.7), off);
    expect(r2.position.distanceTo(new Vector3(0, 1.2, -0.6))).toBeCloseTo(0.3, 5);
  });

  it('a slight twist of the hands does not rotate the object', () => {
    const a = 0.03;
    const r = twoHandPose(L0, R0, new Vector3(-0.1 * Math.cos(a), 1.2, -0.6 + 0.1 * Math.sin(a)), new Vector3(0.1 * Math.cos(a), 1.2, -0.6 - 0.1 * Math.sin(a)), start);
    expect(r.quaternion.angleTo(start.quaternion)).toBeLessThan(1e-9);
  });

  it('scale is clamped', () => {
    const r = twoHandPose(new Vector3(0, 0, 0), new Vector3(0.01, 0, 0), new Vector3(0, 0, 0), new Vector3(5, 0, 0), start);
    expect(r.scale).toBe(SCALE_LIMITS.max);
  });

  it('critically damped spring converges without overshoot', () => {
    let x = 0;
    let v = 0;
    let max = 0;
    for (let i = 0; i < 120; i++) {
      [x, v] = springStep(x, v, 1, 12, 1 / 60);
      max = Math.max(max, x);
    }
    expect(x).toBeCloseTo(1, 4);
    expect(max).toBeLessThanOrEqual(1 + 1e-9);
    // Frame-rate independent: one big step equals many small ones.
    const [a] = springStep(0, 0, 1, 8, 0.2);
    let y = 0;
    let w = 0;
    for (let i = 0; i < 20; i++) [y, w] = springStep(y, w, 1, 8, 0.01);
    expect(a).toBeCloseTo(y, 9);
  });

  it('angle spring takes the short way round', () => {
    let x = 3;
    let v = 0;
    for (let i = 0; i < 200; i++) [x, v] = springAngle(x, v, -3, 10, 1 / 60);
    expect(wrapAngle(x)).toBeCloseTo(-3, 3);
    expect(x).toBeGreaterThan(3); // went up through π rather than down through 0
    expect(wrapAngle(Math.PI * 3)).toBeCloseTo(Math.PI, 9);
  });

  it('held objects glide after their target and settle', () => {
    const cur = { position: new Vector3(), quaternion: new Quaternion(), scale: 0.2 };
    const target = { position: new Vector3(0.1, 0, 0), quaternion: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.5), scale: 0.4 };
    dampPose(cur, target, 0.05, 0.05);
    expect(cur.position.x).toBeCloseTo(0.1 * (1 - Math.exp(-1)), 6);
    expect(cur.scale).toBeGreaterThan(0.2);
    expect(cur.scale).toBeLessThan(0.4);
    expect(poseSettled(cur, target)).toBe(false);
    for (let i = 0; i < 60; i++) dampPose(cur, target, 1 / 60, 0.05);
    expect(poseSettled(cur, target)).toBe(true);
  });

  it('explode waits until both fists have been steady for a moment', () => {
    let since: number | null = null;
    since = heldSince(since, true, 0);
    since = heldSince(since, true, 100);
    expect(100 - since!).toBeLessThan(EXPLODE_GATE.steadyMs);
    since = heldSince(since, true, 160);
    expect(160 - since!).toBeGreaterThanOrEqual(EXPLODE_GATE.steadyMs);
    expect(heldSince(since, false, 170)).toBeNull();
  });

  it('far grab rides on the ray and pushes / pulls with the hand', () => {
    const o = new Vector3(0, 1.5, 0);
    const dir = new Vector3(0, 0, -1);
    const off = new Vector3(0, 0.1, 0);
    expect(farGrabPosition(o, dir, 1, 0.4, 0.4, off).toArray()).toEqual([0, 1.6, -1]);
    expect(farGrabPosition(o, dir, 1, 0.4, 0.5, off).z).toBeCloseTo(-1.25, 6);
    expect(farGrabPosition(o, dir, 1, 0.4, 0, off).z).toBeCloseTo(-0.2, 6); // clamped near the user
  });

  it('explode follows the change in hand distance', () => {
    expect(explodeFromHands(0.3, 0.5, 0)).toBeCloseTo(0.44, 5);
    expect(explodeFromHands(0.5, 0.2, 0.2)).toBe(0);
    expect(explodeFromHands(0.1, 5, 0)).toBe(1.4);
  });

  it('yaw velocity and spin-down', () => {
    const q0 = new Quaternion();
    const q1 = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.1);
    expect(yawVelocity(q0, q1, 0.05)).toBeCloseTo(2, 4);
    expect(decaySpin(2, 0.1)).toBeLessThan(2);
    expect(decaySpin(0.01, 0.1)).toBe(0);
  });
});
