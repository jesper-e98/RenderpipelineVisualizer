import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { expSmoothing, FILTER_PRESETS, OneEuro, OneEuroQuat, OneEuroVec3, smoothingAlpha } from '../src/xr/filters';

/** Deterministic pseudo-random noise in [−1, 1]. */
function noise(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s / 2147483647) * 2 - 1;
  };
}

const variance = (xs: number[]) => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length;
};

const DT = 1 / 90;

describe('One Euro filter', () => {
  it('alpha grows with cutoff and time step', () => {
    expect(smoothingAlpha(1, DT)).toBeLessThan(smoothingAlpha(10, DT));
    expect(smoothingAlpha(1, DT)).toBeLessThan(smoothingAlpha(1, DT * 4));
    expect(smoothingAlpha(1e6, DT)).toBeCloseTo(1, 3);
    expect(expSmoothing(0.05, 0.05)).toBeCloseTo(1 - Math.exp(-1), 9);
    expect(expSmoothing(0.05, 0)).toBe(1);
  });

  it('passes the first sample straight through and holds a constant', () => {
    const f = new OneEuro();
    expect(f.filter(3, DT)).toBe(3);
    for (let i = 0; i < 50; i++) expect(f.filter(3, DT)).toBeCloseTo(3, 9);
  });

  it('removes jitter while still (2 mm noise → well under 1 mm)', () => {
    const f = new OneEuro(FILTER_PRESETS.joint);
    const rnd = noise(7);
    const out: number[] = [];
    const raw: number[] = [];
    for (let i = 0; i < 400; i++) {
      const x = 0.002 * rnd();
      raw.push(x);
      const y = f.filter(x, DT);
      if (i > 50) out.push(y);
    }
    expect(Math.sqrt(variance(out))).toBeLessThan(Math.sqrt(variance(raw.slice(51))) * 0.35);
  });

  it('lags less when moving fast (speed raises the cutoff)', () => {
    const lagAt = (speed: number, beta: number) => {
      const f = new OneEuro({ minCutoff: 1, beta, dCutoff: 1 });
      let y = 0;
      for (let i = 0; i < 90; i++) y = f.filter(speed * i * DT, DT);
      return speed * 89 * DT - y;
    };
    // Relative lag (lag / speed) shrinks with speed when beta > 0, and is constant without it.
    expect(lagAt(1, 6) / 1).toBeLessThan(lagAt(0.05, 6) / 0.05);
    expect(lagAt(1, 0) / 1).toBeCloseTo(lagAt(0.05, 0) / 0.05, 6);
    expect(lagAt(1, 6)).toBeLessThan(0.03); // < 3 cm behind at 1 m/s
  });

  it('reset forgets the history', () => {
    const f = new OneEuro();
    f.filter(0, DT);
    f.filter(1, DT);
    f.reset();
    expect(f.value).toBeNull();
    expect(f.filter(5, DT)).toBe(5);
  });
});

describe('One Euro Vector3', () => {
  it('smooths each axis alike and converges on a step', () => {
    const f = new OneEuroVec3(FILTER_PRESETS.grip);
    f.filter(new Vector3(0, 0, 0), DT);
    const target = new Vector3(0.1, -0.1, 0.05);
    let v = new Vector3();
    for (let i = 0; i < 300; i++) v = f.filter(target, DT);
    expect(v.distanceTo(target)).toBeLessThan(1e-4);
    // Direction of travel is preserved (no per-axis distortion).
    const g = new OneEuroVec3(FILTER_PRESETS.grip);
    g.filter(new Vector3(), DT);
    const w = g.filter(new Vector3(0.02, 0.02, 0), DT).clone();
    expect(w.x).toBeCloseTo(w.y, 9);
  });

  it('reduces jitter and reports speed', () => {
    const f = new OneEuroVec3(FILTER_PRESETS.joint);
    const rnd = noise(3);
    const out: number[] = [];
    for (let i = 0; i < 300; i++) {
      const v = f.filter(new Vector3(0.002 * rnd(), 0.002 * rnd(), 0.002 * rnd()), DT);
      if (i > 50) out.push(v.x);
    }
    expect(Math.sqrt(variance(out))).toBeLessThan(0.0008);
    const m = new OneEuroVec3();
    for (let i = 0; i < 60; i++) m.filter(new Vector3(i * DT * 0.5, 0, 0), DT); // 0.5 m/s
    expect(m.speed).toBeGreaterThan(0.3);
    expect(m.speed).toBeLessThan(0.6);
    m.reset();
    expect(m.initialized).toBe(false);
  });
});

describe('One Euro quaternion', () => {
  it('converges, stays normalised and takes the short way', () => {
    const f = new OneEuroQuat(FILTER_PRESETS.rotation);
    f.filter(new Quaternion(), DT);
    const target = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 1);
    // Same rotation with flipped sign: must not swing the long way.
    const flipped = new Quaternion(-target.x, -target.y, -target.z, -target.w);
    let q = new Quaternion();
    for (let i = 0; i < 400; i++) q = f.filter(i % 2 ? target : flipped, DT);
    expect(q.angleTo(target)).toBeLessThan(1e-3);
    expect(q.length()).toBeCloseTo(1, 9);
  });

  it('removes rotational jitter', () => {
    const f = new OneEuroQuat(FILTER_PRESETS.rotation);
    const rnd = noise(11);
    const base = new Quaternion();
    let worst = 0;
    for (let i = 0; i < 300; i++) {
      const j = new Quaternion().setFromAxisAngle(new Vector3(rnd(), rnd(), rnd()).normalize(), 0.01 * rnd());
      const q = f.filter(j, DT);
      if (i > 60) worst = Math.max(worst, q.angleTo(base));
    }
    expect(worst).toBeLessThan(0.006);
  });
});
