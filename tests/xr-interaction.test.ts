import { Matrix4, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { classifyFist, classifyPinch, edges, pokeHover, pokeStep, POKE } from '../src/xr/gestures';
import { decaySpin, explodeFromHands, oneHandPose, SCALE_LIMITS, twoHandPose, yawVelocity } from '../src/xr/manipulate';

describe('gestures', () => {
  it('pinch uses hysteresis', () => {
    expect(classifyPinch(0.03, false)).toBe(false); // not yet
    expect(classifyPinch(0.015, false)).toBe(true); // on
    expect(classifyPinch(0.03, true)).toBe(true); // stays on between thresholds
    expect(classifyPinch(0.04, true)).toBe(false); // off
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
  it('poke fires once when the tip passes through, then needs to come back out', () => {
    let s = { armed: false, lastPress: -1e9 };
    let r = pokeStep(s, 0.05, true, 0); // approaching
    s = r.state;
    r = pokeStep(s, -0.01, true, 16); // through the surface
    expect(r.pressed).toBe(true);
    s = r.state;
    r = pokeStep(s, -0.012, true, 32); // still behind: no repeat
    expect(r.pressed).toBe(false);
    s = r.state;
    r = pokeStep(s, 0.03, true, 600); // back out
    s = r.state;
    r = pokeStep(s, -0.01, true, 620);
    expect(r.pressed).toBe(true);
  });
  it('poke ignores taps outside the button and respects the cooldown', () => {
    let r = pokeStep({ armed: true, lastPress: -1e9 }, -0.01, false, 0);
    expect(r.pressed).toBe(false);
    r = pokeStep({ armed: true, lastPress: 100 }, -0.01, true, 100 + POKE.cooldownMs - 1);
    expect(r.pressed).toBe(false);
    expect(pokeHover(0.02, true)).toBe(true);
    expect(pokeHover(0.2, true)).toBe(false);
  });
});

describe('manipulation', () => {
  it('one-hand grab keeps the object fixed relative to the hand', () => {
    const hand0 = new Matrix4().makeTranslation(0, 1, 0);
    const obj0 = new Matrix4().makeTranslation(0, 1.2, -0.5);
    const hand1 = new Matrix4().makeRotationY(Math.PI / 2).setPosition(1, 1, 0);
    const p = new Vector3().setFromMatrixPosition(oneHandPose(hand0, obj0, hand1));
    // Offset (0, 0.2, -0.5) rotated 90° around Y → (-0.5, 0.2, 0), plus the hand at (1,1,0).
    expect(p.x).toBeCloseTo(0.5, 5);
    expect(p.y).toBeCloseTo(1.2, 5);
    expect(p.z).toBeCloseTo(0, 5);
  });

  const start = { position: new Vector3(0, 1.2, -0.6), quaternion: new Quaternion(), scale: 0.2 };
  it('two hands moving apart scale up around their midpoint', () => {
    const r = twoHandPose(new Vector3(-0.1, 1.2, -0.6), new Vector3(0.1, 1.2, -0.6), new Vector3(-0.2, 1.2, -0.6), new Vector3(0.2, 1.2, -0.6), start);
    expect(r.scale).toBeCloseTo(0.4, 5);
    expect(r.position.distanceTo(start.position)).toBeLessThan(1e-6);
  });
  it('two hands rotating around each other yaw the object', () => {
    const r = twoHandPose(new Vector3(-0.1, 1.2, -0.6), new Vector3(0.1, 1.2, -0.6), new Vector3(0, 1.2, -0.5), new Vector3(0, 1.2, -0.7), start);
    const f = new Vector3(1, 0, 0).applyQuaternion(r.quaternion);
    expect(Math.abs(f.z)).toBeCloseTo(1, 5); // x axis now points along z
    expect(r.scale).toBeCloseTo(0.2, 5);
  });
  it('scale is clamped', () => {
    const r = twoHandPose(new Vector3(0, 0, 0), new Vector3(0.01, 0, 0), new Vector3(0, 0, 0), new Vector3(5, 0, 0), start);
    expect(r.scale).toBe(SCALE_LIMITS.max);
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
