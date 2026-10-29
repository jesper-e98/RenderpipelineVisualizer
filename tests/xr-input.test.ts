import { Object3D, Vector3 } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { palmNormal, XRInput, type Pointer } from '../src/xr/XRInput';

/** A fake WebXR hand: every joint as an Object3D, laid out as an open right hand, palm down. */
function makeHand(handedness: 'left' | 'right') {
  const s = handedness === 'right' ? 1 : -1; // thumb side is −x for a right hand palm down
  const joints: Record<string, Object3D> = {};
  const base = new Vector3(0, 1.2, -0.3);
  const put = (name: string, x: number, y: number, z: number) => {
    const o = new Object3D();
    o.position.set(base.x + x * s, base.y + y, base.z + z);
    joints[name] = o;
  };
  put('wrist', 0, 0, 0);
  put('thumb-metacarpal', -0.02, 0, -0.02);
  put('thumb-phalanx-proximal', -0.035, 0, -0.05);
  put('thumb-phalanx-distal', -0.045, 0, -0.075);
  put('thumb-tip', -0.05, 0, -0.095);
  const fingers: [string, number][] = [
    ['index-finger', -0.02],
    ['middle-finger', 0],
    ['ring-finger', 0.018],
    ['pinky-finger', 0.034],
  ];
  for (const [f, x] of fingers) {
    put(`${f}-metacarpal`, x * 0.5, 0, -0.02);
    put(`${f}-phalanx-proximal`, x, 0, -0.09);
    put(`${f}-phalanx-intermediate`, x, 0, -0.13);
    put(`${f}-phalanx-distal`, x, 0, -0.155);
    put(`${f}-tip`, x, 0, -0.175);
  }
  const rest = new Map(Object.entries(joints).map(([k, o]) => [k, o.position.clone()]));
  return { joints, rest };
}

let now = 0;
beforeEach(() => {
  now = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
});
afterEach(() => vi.restoreAllMocks());

function rig(handedness: 'left' | 'right' = 'right') {
  const input = new XRInput(null);
  const hand = makeHand(handedness);
  const ctrl = new Object3D();
  ctrl.position.set(0.1, 1.3, -0.2);
  const internals = input as unknown as { sources: unknown[]; controllers: Object3D[]; grips: Object3D[]; hands: unknown[] };
  internals.sources = [{ hand: {}, handedness }, null];
  internals.controllers = [ctrl];
  internals.grips = [new Object3D()];
  internals.hands = [{ joints: hand.joints }];
  input.pointers[0].handedness = handedness;
  const step = (): Pointer => {
    now += 11; // 90 Hz
    return input.update()[0];
  };
  return { input, hand, ctrl, step };
}

/** Deterministic noise in [−1, 1]. */
function noise(seed: number) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
}

describe('XRInput hand tracking', () => {
  it('filters joint / grip / ray jitter', () => {
    const { hand, ctrl, step } = rig();
    const rnd = noise(5);
    const grips: number[] = [];
    const dirs: number[] = [];
    for (let i = 0; i < 200; i++) {
      for (const [k, o] of Object.entries(hand.joints)) o.position.copy(hand.rest.get(k)!).add(new Vector3(rnd(), rnd(), rnd()).multiplyScalar(0.002));
      ctrl.rotation.set(rnd() * 0.01, rnd() * 0.01, 0); // ±0.6° ray jitter
      const p = step();
      if (i > 40) {
        grips.push(p.grip.x);
        dirs.push(p.ray.direction.x);
      }
    }
    const sd = (xs: number[]) => {
      const m = xs.reduce((a, b) => a + b, 0) / xs.length;
      return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
    };
    expect(sd(grips)).toBeLessThan(0.0006); // raw pinch-point noise is ~0.8 mm
    expect(sd(dirs)).toBeLessThan(0.002); // raw ray noise ~0.006
  });

  it('pinches, survives a short opening and a tracking dropout, and fires each edge once', () => {
    const { hand, step } = rig();
    let p = step();
    expect(p.pinch).toBe(false);
    const thumb = hand.joints['thumb-tip'];
    const index = hand.joints['index-finger-tip'];
    // Close the pinch over a few frames (a real pinch takes ~100 ms).
    const open = thumb.position.clone();
    const closed = index.position.clone().add(new Vector3(0.004, 0, 0));
    let downs = 0;
    let ups = 0;
    const frame = () => {
      p = step();
      if (p.pinchDown) downs++;
      if (p.pinchUp) ups++;
      return p;
    };
    for (let i = 1; i <= 8; i++) {
      thumb.position.lerpVectors(open, closed, i / 8);
      frame();
    }
    expect(p.pinch).toBe(true);
    // Noise: fingers fly apart for 4 frames (44 ms).
    thumb.position.copy(open);
    for (let i = 0; i < 4; i++) expect(frame().pinch).toBe(true);
    thumb.position.copy(closed);
    frame();
    // Tracking dropout (joints invisible) for 10 frames.
    Object.values(hand.joints).forEach((o) => (o.visible = false));
    for (let i = 0; i < 10; i++) expect(frame().pinch).toBe(true);
    Object.values(hand.joints).forEach((o) => (o.visible = true));
    frame();
    // A real release.
    thumb.position.copy(open);
    for (let i = 0; i < 20; i++) frame();
    expect(p.pinch).toBe(false);
    expect(downs).toBe(1);
    expect(ups).toBe(1);
  });

  it('palm normal points out of the palm for both hands', () => {
    for (const h of ['left', 'right'] as const) {
      const { hand, step } = rig(h);
      const p = step();
      // Palm down in the fixture.
      expect(p.palm, h).not.toBeNull();
      expect(p.palm!.normal.y, h).toBeLessThan(-0.95);
      const n = palmNormal(hand.joints['wrist'].position, hand.joints['index-finger-metacarpal'].position, hand.joints['pinky-finger-metacarpal'].position, h);
      expect(n.y).toBeLessThan(-0.95);
    }
  });
});
