import { Matrix4 } from 'three';
import type { ClipResult } from './clip';
import type { RenderResult, ScreenVertex, TriangleInfo } from './raster';

/**
 * A RenderResult flattened into typed arrays so it can cross a worker boundary cheaply
 * (transferable buffers instead of 100k+ little objects). `unpackRender` turns it back into a
 * RenderResult whose `triangles` array decodes entries lazily, so slides keep their API.
 */
export interface PackedRender {
  width: number;
  height: number;
  matrices: { model: number[]; view: number[]; proj: number[]; mvp: number[] };
  color: Uint8ClampedArray;
  depth: Float32Array;
  overdraw: Uint16Array;
  stats: RenderResult['stats'];
  /** Per triangle: clip code, culled flag, number of screen triangles. */
  triFlags: Uint8Array; // clip(2 bits) | culled << 2
  triScreenCount: Uint8Array;
  triFragments: Uint32Array;
  triScreenStart: Uint32Array;
  /** 3 vertices × (x, y, z, invW, attrs…) per screen triangle. */
  screen: Float32Array;
  attrCount: number;
  /** Milliseconds the render took where it ran (for slides that show timing). */
  ms: number;
}

const CLIP: ClipResult[] = ['inside', 'outside', 'clipped'];

export function packRender(r: RenderResult, ms = 0): { packed: PackedRender; transfer: ArrayBuffer[] } {
  const n = r.triangles.length;
  const attrCount = r.triangles.find((t) => t.screen.length)?.screen[0][0].attrs.length ?? 0;
  const per = 3 * (4 + attrCount);
  const triFlags = new Uint8Array(n);
  const triScreenCount = new Uint8Array(n);
  const triFragments = new Uint32Array(n);
  const triScreenStart = new Uint32Array(n);
  let total = 0;
  for (const t of r.triangles) total += t.screen.length;
  const screen = new Float32Array(total * per);
  let at = 0;
  r.triangles.forEach((t, i) => {
    triFlags[i] = CLIP.indexOf(t.clip) | (t.culled ? 4 : 0);
    triScreenCount[i] = t.screen.length;
    triFragments[i] = t.fragments;
    triScreenStart[i] = at / per;
    for (const tri of t.screen) {
      for (const v of tri) {
        screen[at++] = v.x;
        screen[at++] = v.y;
        screen[at++] = v.z;
        screen[at++] = v.invW;
        for (let k = 0; k < attrCount; k++) screen[at++] = v.attrs[k] ?? 0;
      }
    }
  });
  const m = r.matrices;
  const packed: PackedRender = {
    width: r.width,
    height: r.height,
    matrices: { model: [...m.model.elements], view: [...m.view.elements], proj: [...m.proj.elements], mvp: [...m.mvp.elements] },
    color: r.color,
    depth: r.depth,
    overdraw: r.overdraw,
    stats: r.stats,
    triFlags,
    triScreenCount,
    triFragments,
    triScreenStart,
    screen,
    attrCount,
    ms,
  };
  const transfer = [r.color.buffer, r.depth.buffer, r.overdraw.buffer, triFlags.buffer, triScreenCount.buffer, triFragments.buffer, triScreenStart.buffer, screen.buffer].filter(
    (b, i, all) => all.indexOf(b) === i,
  ) as ArrayBuffer[];
  return { packed, transfer };
}

export function unpackRender(p: PackedRender): RenderResult & { ms: number } {
  const per = 3 * (4 + p.attrCount);
  const n = p.triFlags.length;
  const cache = new Map<number, TriangleInfo>();
  const decode = (i: number): TriangleInfo => {
    let t = cache.get(i);
    if (t) return t;
    const flags = p.triFlags[i];
    const screen: [ScreenVertex, ScreenVertex, ScreenVertex][] = [];
    const start = p.triScreenStart[i];
    for (let s = 0; s < p.triScreenCount[i]; s++) {
      const base = (start + s) * per;
      const tri = [0, 1, 2].map((k) => {
        const o = base + k * (4 + p.attrCount);
        return {
          x: p.screen[o],
          y: p.screen[o + 1],
          z: p.screen[o + 2],
          invW: p.screen[o + 3],
          attrs: Array.from(p.screen.subarray(o + 4, o + 4 + p.attrCount)),
        };
      }) as [ScreenVertex, ScreenVertex, ScreenVertex];
      screen.push(tri);
    }
    t = { index: i, clip: CLIP[flags & 3], culled: (flags & 4) !== 0, screen, fragments: p.triFragments[i] };
    cache.set(i, t);
    return t;
  };
  // An array-shaped proxy: index reads decode on demand; length/iteration/array methods work.
  const triangles = new Proxy(new Array<TriangleInfo>(n), {
    get(target, prop, recv) {
      if (typeof prop === 'string') {
        const c = prop.charCodeAt(0);
        if (c >= 48 && c <= 57) {
          const i = Number(prop);
          if (Number.isInteger(i) && i >= 0 && i < n) return decode(i);
        }
      }
      return Reflect.get(target, prop, recv);
    },
    has(target, prop) {
      if (typeof prop === 'string' && /^\d+$/.test(prop)) return Number(prop) < n;
      return Reflect.has(target, prop);
    },
  });
  const mat = (e: number[]) => new Matrix4().fromArray(e);
  return {
    width: p.width,
    height: p.height,
    matrices: { model: mat(p.matrices.model), view: mat(p.matrices.view), proj: mat(p.matrices.proj), mvp: mat(p.matrices.mvp) },
    color: p.color,
    depth: p.depth,
    overdraw: p.overdraw,
    triangles,
    stats: p.stats,
    ms: p.ms,
  };
}
