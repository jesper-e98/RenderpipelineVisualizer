import { describe, expect, it } from 'vitest';
import { axisAction, hitTest, PANEL_H, PANEL_W, panelRegions, wrapText } from '../src/xr/panelLayout';

describe('XR panel layout', () => {
  const regions = panelRegions({ lang: 'sv', mode: 'data' });

  it('lays out the button row inside the panel without overlaps', () => {
    for (const r of regions) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(PANEL_W);
      expect(r.y + r.h).toBeLessThanOrEqual(PANEL_H);
    }
    for (let i = 1; i < regions.length; i++) expect(regions[i].x).toBeGreaterThan(regions[i - 1].x + regions[i - 1].w);
    expect(regions.map((r) => r.action)).toEqual(['prev', 'next', 'api:opengl', 'api:vulkan', 'api:d3d12', 'mode', 'exit']);
  });

  it('maps texture coordinates (v up) to buttons', () => {
    const next = regions.find((r) => r.action === 'next')!;
    const u = (next.x + next.w / 2) / PANEL_W;
    const v = 1 - (next.y + next.h / 2) / PANEL_H;
    expect(hitTest(regions, u, v)).toBe('next');
    expect(hitTest(regions, 0.5, 0.9)).toBeNull(); // the title area
  });

  it('labels the mode button with the mode you would switch to', () => {
    expect(panelRegions({ lang: 'sv', mode: 'data' }).find((r) => r.action === 'mode')!.label).toBe('Koncept');
    expect(panelRegions({ lang: 'en', mode: 'concept' }).find((r) => r.action === 'mode')!.label).toBe('Data');
  });

  it('wraps text and ellipsizes after the line limit', () => {
    const measure = (s: string) => s.length;
    expect(wrapText('aaa bbb ccc', 7, measure)).toEqual(['aaa bbb', 'ccc']);
    const lines = wrapText('one two three four five six seven', 9, measure, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1].endsWith('…')).toBe(true);
  });
});

describe('XR thumbstick', () => {
  it('fires once per push and needs a return to centre', () => {
    let r = axisAction(0.9, 0, false);
    expect(r.action).toBe('api-next');
    r = axisAction(0.95, 0, r.latched);
    expect(r.action).toBeNull();
    r = axisAction(0.1, 0, r.latched);
    expect(r.latched).toBe(false);
    expect(axisAction(-0.9, 0.1, false).action).toBe('api-prev');
    expect(axisAction(0.1, -0.9, false).action).toBe('mode');
    expect(axisAction(0.5, 0, false).action).toBeNull(); // dead zone
  });
});

describe('XR stage carousel', () => {
  it('puts 0–9 on the left arc and 10–19 on the right, clear of the table ahead', async () => {
    const { carouselAngle, carouselPosition } = await import('../src/xr/panelLayout');
    for (let i = 0; i < 10; i++) expect(carouselAngle(i)).toBeLessThanOrEqual(-27);
    for (let i = 10; i < 20; i++) expect(carouselAngle(i)).toBeGreaterThanOrEqual(27);
    expect(carouselAngle(0)).toBeCloseTo(-115, 5);
    expect(carouselAngle(9)).toBeCloseTo(-27, 5);
    expect(carouselAngle(19)).toBeCloseTo(115, 5);
    // Within arm's reach and evenly spaced.
    const d = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[2] - b[2]);
    const p = Array.from({ length: 20 }, (_, i) => carouselPosition(i));
    for (const q of p) expect(Math.hypot(q[0], q[2])).toBeCloseTo(0.62, 5);
    expect(d(p[0], p[1])).toBeCloseTo(d(p[5], p[6]), 5);
    expect(d(p[0], p[1])).toBeGreaterThan(0.085); // tiles (0.082 m) don't overlap
  });
});
