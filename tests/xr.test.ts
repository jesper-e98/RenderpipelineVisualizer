import { describe, expect, it } from 'vitest';
import { axisAction, wrapText } from '../src/xr/panelLayout';

describe('XR info text', () => {
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
