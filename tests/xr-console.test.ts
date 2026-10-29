import { describe, expect, it } from 'vitest';
import {
  CONSOLE,
  consoleHeight,
  consoleLayout,
  followStep,
  handMenuLayout,
  itemPose,
  surfacePose,
  type ConsoleItem,
} from '../src/xr/consoleLayout';
import { MIN_TARGET } from '../src/xr/interaction';

const items = consoleLayout(20);
const interactive = items.filter((i) => i.kind !== 'plate' && i.kind !== 'info');
const EYE_Y = 1.6;
const y0 = consoleHeight(EYE_Y);
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function overlaps(a: ConsoleItem, b: ConsoleItem): boolean {
  return Math.abs(a.x - b.x) < (a.hitW + b.hitW) / 2 - 1e-9 && Math.abs(a.y - b.y) < (a.hitH + b.hitH) / 2 - 1e-9;
}

describe('holo-console layout', () => {
  it('has every tool in one place, with unique ids', () => {
    const ids = items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of [
      'info',
      'api:opengl',
      'api:vulkan',
      'api:d3d12',
      'mode:data',
      'mode:concept',
      'slider:explode',
      'layer:solid',
      'layer:wire',
      'layer:points',
      'layer:normals',
      'model:teapot',
      'model:triangle',
      'reset',
      'sound',
      'exit',
      'pin',
      'handle',
      'prev',
      'next',
    ])
      expect(ids).toContain(id);
  });

  it('every interactive target is at least 4 × 4 cm', () => {
    for (const it of interactive) {
      expect(it.hitW, it.id).toBeGreaterThanOrEqual(MIN_TARGET);
      expect(it.hitH, it.id).toBeGreaterThanOrEqual(MIN_TARGET);
      expect(it.hitW).toBeGreaterThanOrEqual(it.w - 1e-9);
      expect(it.hitH).toBeGreaterThanOrEqual(it.h - 1e-9);
    }
  });

  it('hit areas never overlap, and stay inside their facet', () => {
    for (const facet of ['left', 'right', 'center', 'top', 'strip'] as const) {
      const inFacet = interactive.filter((i) => i.facet === facet);
      for (let i = 0; i < inFacet.length; i++) for (let j = i + 1; j < inFacet.length; j++) expect(overlaps(inFacet[i], inFacet[j]), `${inFacet[i].id} × ${inFacet[j].id}`).toBe(false);
      const plate = items.find((p) => p.facet === facet && (p.kind === 'plate' || p.kind === 'info'));
      if (!plate) continue;
      for (const it of inFacet) {
        expect(Math.abs(it.x) + it.w / 2, it.id).toBeLessThanOrEqual(plate.w / 2);
        expect(Math.abs(it.y) + it.h / 2, it.id).toBeLessThanOrEqual(plate.h / 2);
      }
    }
  });

  it('puts the 20 stages in one row, in order, with ‹ › at the ends', () => {
    const strip = items.filter((i) => i.facet === 'strip').sort((a, b) => a.x - b.x);
    expect(strip[0].id).toBe('prev');
    expect(strip[strip.length - 1].id).toBe('next');
    const tiles = strip.slice(1, -1);
    expect(tiles.map((t) => t.index)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(new Set(strip.map((s) => s.y)).size).toBe(1);
  });

  it('keeps the facets clear of the strip (no hit area reaches across)', () => {
    const strip = items.filter((i) => i.facet === 'strip');
    const top = Math.max(...strip.map((s) => s.hitH / 2));
    for (const it of interactive.filter((i) => i.facet === 'left' || i.facet === 'right')) {
      // Lowest point of the item on the console surface (v), vs the strip's top.
      const pose = itemPose(it, 0);
      const stripTop = surfacePose(0, top, 0).position[1];
      expect(pose.position[1] - (it.hitH / 2) * Math.cos(CONSOLE.tilt)).toBeGreaterThan(stripTop);
    }
  });

  it('is within arm’s reach in front of and below the eyes, and faces the user', () => {
    const eye = [0, EYE_Y, 0];
    const shoulders = [
      [-0.18, EYE_Y - 0.2, 0.02],
      [0.18, EYE_Y - 0.2, 0.02],
    ];
    const centre = itemPose(items.find((i) => i.id === 'info')!, y0).position;
    expect(dist(centre, eye)).toBeGreaterThan(0.55);
    expect(dist(centre, eye)).toBeLessThan(0.72);
    for (const it of interactive) {
      const p = itemPose(it, y0);
      expect(p.position[1], it.id).toBeLessThan(EYE_Y - 0.25); // below the eyes
      expect(p.position[2], it.id).toBeLessThan(-0.15); // in front
      const reach = Math.min(...shoulders.map((s) => dist(p.position, s)));
      expect(reach, it.id).toBeLessThan(0.68);
      // The surface faces the eyes (normal · direction to eye).
      const toEye = eye.map((e, k) => e - p.position[k]);
      const len = Math.hypot(...toEye);
      const facing = p.normal.reduce((a, n, k) => a + (n * toEye[k]) / len, 0);
      expect(facing, it.id).toBeGreaterThan(0.75);
    }
  });

  it('curves gently towards the user at the ends', () => {
    const mid = surfacePose(0, 0, y0).position;
    const end = surfacePose(0.45, 0, y0).position;
    expect(end[2]).toBeGreaterThan(mid[2]); // closer
    const pose = surfacePose(0.3, 0.1, y0);
    // Orthonormal frame.
    const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    expect(dot(pose.right, pose.up)).toBeCloseTo(0, 9);
    expect(dot(pose.right, pose.normal)).toBeCloseTo(0, 9);
    expect(dot(pose.up, pose.normal)).toBeCloseTo(0, 9);
    expect(dot(pose.normal, pose.normal)).toBeCloseTo(1, 9);
  });

  it('adapts its height to the user and clamps it', () => {
    expect(consoleHeight(1.7)).toBeCloseTo(1.7 - CONSOLE.below, 9);
    expect(consoleHeight(0.9)).toBe(CONSOLE.minHeight);
    expect(consoleHeight(3)).toBe(CONSOLE.maxHeight);
  });
});

describe('console follow', () => {
  const deg = (d: number) => (d * Math.PI) / 180;
  it('stays put for small head turns, follows past ~35°, and stops once caught up', () => {
    expect(followStep(0, deg(20), false)).toEqual({ following: false, target: 0 });
    let f = followStep(0, deg(40), false);
    expect(f.following).toBe(true);
    expect(f.target).toBeCloseTo(deg(40));
    f = followStep(deg(20), deg(40), f.following);
    expect(f.following).toBe(true);
    f = followStep(deg(38), deg(40), f.following);
    expect(f.following).toBe(false);
    // Wraps around ±180°.
    expect(followStep(deg(170), deg(-170), false).following).toBe(false);
  });
});

describe('hand menu layout', () => {
  it('has four 4.6 cm buttons that do not overlap', () => {
    const m = handMenuLayout();
    expect(m.map((i) => i.id).sort()).toEqual(['hm:api', 'hm:next', 'hm:prev', 'hm:summon']);
    for (const a of m) {
      expect(a.w).toBeGreaterThanOrEqual(MIN_TARGET);
      expect(a.h).toBeGreaterThanOrEqual(MIN_TARGET);
      for (const b of m) if (a !== b) expect(Math.abs(a.x - b.x) >= (a.w + b.w) / 2 || Math.abs(a.y - b.y) >= (a.h + b.h) / 2).toBe(true);
    }
  });
});
