import type { ApiId } from '../core/state';
import type { V4 } from './transform';

/** A clip-space vertex plus any attributes that must be interpolated along with it. */
export interface ClipVertex {
  pos: V4;
  attrs: number[];
}

export interface Plane {
  name: string;
  /** Signed distance; ≥ 0 means inside. */
  dist: (p: V4) => number;
}

/** The six clip planes. Only the near plane differs: OpenGL uses −w ≤ z, the others 0 ≤ z. */
export function clipPlanes(api: ApiId): Plane[] {
  return [
    { name: 'left', dist: (p) => p[3] + p[0] },
    { name: 'right', dist: (p) => p[3] - p[0] },
    { name: 'bottom', dist: (p) => p[3] + p[1] },
    { name: 'top', dist: (p) => p[3] - p[1] },
    { name: 'near', dist: api === 'opengl' ? (p) => p[3] + p[2] : (p) => p[2] },
    { name: 'far', dist: (p) => p[3] - p[2] },
  ];
}

export function isInside(api: ApiId, p: V4): boolean {
  return clipPlanes(api).every((pl) => pl.dist(p) >= 0);
}

/** Which planes a point is outside of (empty → inside the view volume). */
export function outsidePlanes(api: ApiId, p: V4): string[] {
  return clipPlanes(api)
    .filter((pl) => pl.dist(p) < 0)
    .map((pl) => pl.name);
}

function lerpVertex(a: ClipVertex, b: ClipVertex, t: number): ClipVertex {
  return {
    pos: a.pos.map((v, i) => v + (b.pos[i] - v) * t) as V4,
    attrs: a.attrs.map((v, i) => v + (b.attrs[i] - v) * t),
  };
}

/** Sutherland–Hodgman clipping of a polygon against all six planes, in homogeneous space. */
export function clipPolygon(api: ApiId, poly: ClipVertex[]): ClipVertex[] {
  let out = poly;
  for (const plane of clipPlanes(api)) {
    if (!out.length) break;
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i];
      const prev = input[(i + input.length - 1) % input.length];
      const dc = plane.dist(cur.pos);
      const dp = plane.dist(prev.pos);
      if (dc >= 0) {
        if (dp < 0) out.push(lerpVertex(prev, cur, dp / (dp - dc)));
        out.push(cur);
      } else if (dp >= 0) {
        out.push(lerpVertex(prev, cur, dp / (dp - dc)));
      }
    }
  }
  return out;
}

export type ClipResult = 'inside' | 'outside' | 'clipped';

/** Clip a triangle; returns the resulting triangles (fan) and what happened. */
export function clipTriangle(api: ApiId, tri: [ClipVertex, ClipVertex, ClipVertex]): {
  result: ClipResult;
  triangles: [ClipVertex, ClipVertex, ClipVertex][];
} {
  const planes = clipPlanes(api);
  const allIn = tri.every((v) => planes.every((pl) => pl.dist(v.pos) >= 0));
  if (allIn) return { result: 'inside', triangles: [tri] };
  // Trivially outside when all three vertices are behind the same plane.
  if (planes.some((pl) => tri.every((v) => pl.dist(v.pos) < 0))) return { result: 'outside', triangles: [] };
  const poly = clipPolygon(api, tri);
  const triangles: [ClipVertex, ClipVertex, ClipVertex][] = [];
  for (let i = 1; i + 1 < poly.length; i++) triangles.push([poly[0], poly[i], poly[i + 1]]);
  return { result: triangles.length ? 'clipped' : 'outside', triangles };
}
