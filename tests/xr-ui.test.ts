import { describe, expect, it } from 'vitest';
import {
  farSelect,
  HOVER,
  hitSize,
  inRect,
  MIN_TARGET,
  PALM,
  palmMenuStep,
  pickNearest,
  poke0,
  pokeHover,
  pokeStep,
  POKE,
  stickyHover,
  type HoverState,
  type PalmState,
  type PokeState,
} from '../src/xr/interaction';

describe('target size', () => {
  it('enlarges small targets to 4 × 4 cm', () => {
    expect(hitSize(0.02, 0.03)).toEqual([MIN_TARGET, MIN_TARGET]);
    expect(hitSize(0.1, 0.03)).toEqual([0.1, MIN_TARGET]);
    expect(inRect(0.019, 0, 0.04, 0.04)).toBe(true);
    expect(inRect(0.021, 0, 0.04, 0.04)).toBe(false);
    expect(inRect(0.021, 0, 0.04, 0.04, 0.002)).toBe(true);
  });

  it('picks the nearest surface, and the closest centre among neighbours on it', () => {
    expect(pickNearest([])).toBeNull();
    const a = { id: 'a', dist: 0.6, off: 0.9 };
    const b = { id: 'b', dist: 0.601, off: 0.2 };
    const far = { id: 'far', dist: 0.9, off: 0 };
    expect(pickNearest([a, b, far])!.id).toBe('b');
    expect(pickNearest([far, { id: 'front', dist: 0.5, off: 0.99 }])!.id).toBe('front');
    // A button on a panel beats the panel, even off-centre, even with the panel a few mm nearer.
    const plate = { id: 'plate', dist: 0.596, off: 0.05, passive: true };
    expect(pickNearest([plate, { id: 'btn', dist: 0.6, off: 0.95 }])!.id).toBe('btn');
    expect(pickNearest([plate])!.id).toBe('plate');
  });
});

describe('sticky hover', () => {
  const s0: HoverState = { id: null, lostAt: null };

  it('keeps the target for a moment when the ray slips off into nothing', () => {
    let s = stickyHover(s0, 'a', true, 0);
    expect(s.id).toBe('a');
    s = stickyHover(s, null, false, 10);
    expect(s.id).toBe('a');
    s = stickyHover(s, null, false, 10 + HOVER.holdMs - 1);
    expect(s.id).toBe('a');
    s = stickyHover(s, null, false, 10 + HOVER.holdMs + 1);
    expect(s.id).toBeNull();
  });

  it('coming back within the hold time keeps it without a flicker', () => {
    let s = stickyHover(s0, 'a', true, 0);
    s = stickyHover(s, null, false, 10);
    s = stickyHover(s, 'a', true, 60);
    expect(s).toEqual({ id: 'a', lostAt: null });
  });

  it('needs the ray to clearly leave the current target before switching to a neighbour', () => {
    let s = stickyHover(s0, 'a', true, 0);
    // The ray is over b's hit area but still within a's margin: stay on a.
    s = stickyHover(s, 'b', true, 20);
    expect(s.id).toBe('a');
    // Clearly off a and on b: switch straight away.
    s = stickyHover(s, 'b', false, 40);
    expect(s.id).toBe('b');
  });
});

describe('select on release (far)', () => {
  it('fires on release over the same target, like the Quest UI', () => {
    let r = farSelect(null, 'a', true, false);
    expect(r).toEqual({ pending: 'a', fire: null });
    r = farSelect(r.pending, 'a', false, false);
    expect(r.fire).toBeNull();
    r = farSelect(r.pending, 'a', false, true);
    expect(r).toEqual({ pending: null, fire: 'a' });
  });

  it('sliding off before releasing cancels; sliding back on still fires', () => {
    let r = farSelect(null, 'a', true, false);
    r = farSelect(r.pending, 'b', false, true);
    expect(r.fire).toBeNull();
    r = farSelect(null, 'a', true, false);
    r = farSelect(r.pending, null, false, false);
    r = farSelect(r.pending, 'a', false, true);
    expect(r.fire).toBe('a');
  });

  it('a pinch that started elsewhere never fires a button it is released over', () => {
    let r = farSelect(null, null, true, false);
    r = farSelect(r.pending, 'a', false, true);
    expect(r.fire).toBeNull();
  });
});

describe('poke', () => {
  const step = (s: PokeState, d: number, inside = true, t = 0) => pokeStep(s, d, inside, t);

  it('fires once when the finger pushes in from the front, then needs to pull back out', () => {
    let r = step(poke0(), 0.04); // approaching, in front
    expect(r.state.armed).toBe(true);
    r = step(r.state, 0.0, true, 16); // touching
    expect(r.pressed).toBe(false);
    expect(r.touching).toBe(false);
    r = step(r.state, -POKE.press - 0.001, true, 32); // pushed in
    expect(r.pressed).toBe(true);
    expect(r.depth).toBeGreaterThan(0.8);
    r = step(r.state, -0.008, true, 48); // still in: no repeat
    expect(r.pressed).toBe(false);
    r = step(r.state, 0.005, true, 600); // backing off a little isn't enough
    r = step(r.state, -0.008, true, 620);
    expect(r.pressed).toBe(false);
    r = step(r.state, 0.03, true, 700); // pulled back out
    r = step(r.state, -0.008, true, 720);
    expect(r.pressed).toBe(true);
  });

  it('the button travels with the finger', () => {
    let r = step(poke0(), 0.03);
    r = step(r.state, -0.002);
    expect(r.depth).toBeCloseTo(0.002 / POKE.travel, 6);
    expect(r.touching).toBe(true);
  });

  it('ignores a finger coming in from the side or from behind', () => {
    // From the side: already level with the surface when it enters the area.
    let r = step(poke0(), -0.01, false);
    r = step(r.state, -0.01, true, 16);
    r = step(r.state, -0.012, true, 32);
    expect(r.pressed).toBe(false);
    expect(r.depth).toBe(0);
    // From behind: deep behind, then coming forward through the surface.
    r = step(poke0(), -0.03);
    r = step(r.state, -0.01, true, 16);
    expect(r.pressed).toBe(false);
  });

  it('a hand passing straight through cancels', () => {
    let r = step(poke0(), 0.05);
    r = step(r.state, -POKE.through - 0.01, true, 16); // one big jump: too deep, not a press
    expect(r.pressed).toBe(false);
    expect(r.state.armed).toBe(false);
  });

  it('respects the cooldown', () => {
    const r = pokeStep({ armed: true, down: false, lastPress: 100 }, -0.01, true, 100 + POKE.cooldownMs - 1);
    expect(r.pressed).toBe(false);
    expect(pokeHover(0.02, true)).toBe(true);
    expect(pokeHover(0.2, true)).toBe(false);
    expect(pokeHover(0.02, false)).toBe(false);
  });
});

describe('palm-up hand menu', () => {
  const s0: PalmState = { shown: false, since: null };

  it('appears only after the palm has faced the user steadily', () => {
    let s = palmMenuStep(s0, 0.9, 0, 0);
    expect(s.shown).toBe(false);
    s = palmMenuStep(s, 0.9, 0, PALM.showMs - 10);
    expect(s.shown).toBe(false);
    s = palmMenuStep(s, 0.9, 0, PALM.showMs + 10);
    expect(s.shown).toBe(true);
    // A palm that only briefly faces the user (turning the hand) doesn't open it.
    let q = palmMenuStep(s0, 0.9, 0, 0);
    q = palmMenuStep(q, 0.3, 0, 100);
    q = palmMenuStep(q, 0.9, 0, 150);
    q = palmMenuStep(q, 0.9, 0, 250);
    expect(q.shown).toBe(false);
  });

  it('does not open while the hand moves fast, and closes with hysteresis', () => {
    let s = palmMenuStep(s0, 0.9, 1.5, 0);
    s = palmMenuStep(s, 0.9, 1.5, 400);
    expect(s.shown).toBe(false);
    let t: PalmState = { shown: true, since: null };
    t = palmMenuStep(t, 0.55, 0, 0); // between hide and show: stays
    t = palmMenuStep(t, 0.55, 0, 1000);
    expect(t.shown).toBe(true);
    t = palmMenuStep(t, 0.1, 0, 1100);
    t = palmMenuStep(t, 0.1, 0, 1100 + PALM.hideMs + 1);
    expect(t.shown).toBe(false);
    // Lost tracking also closes it.
    let u: PalmState = { shown: true, since: null };
    u = palmMenuStep(u, null, 0, 0);
    u = palmMenuStep(u, null, 0, PALM.hideMs + 1);
    expect(u.shown).toBe(false);
  });
});
