import type { ApiId } from '../core/state';
import type { MeshData } from '../model/types';
import { clipTriangle, type ClipResult, type ClipVertex } from './clip';
import { shade } from './shade';
import { matrices, ndcToWindow, type Matrices, type V3, type V4 } from './transform';

/** A vertex after the viewport transform, in canvas pixels (origin top-left, y down). */
export interface ScreenVertex {
  x: number;
  y: number;
  z: number; // depth 0..1
  invW: number;
  attrs: number[];
}

export interface Fragment {
  x: number;
  y: number;
  z: number;
  bary: V3; // perspective-correct barycentrics
  attrs: number[];
  tri: number;
}

const edge = (ax: number, ay: number, bx: number, by: number, px: number, py: number) =>
  (bx - ax) * (py - ay) - (by - ay) * (px - ax);

/** Top-left fill rule for a triangle with positive area in y-down coordinates. */
const isTopLeft = (a: ScreenVertex, b: ScreenVertex) => (a.y === b.y && b.x > a.x) || b.y < a.y;

/** Signed area ×2 in canvas space. Negative = counter-clockwise as seen on screen = front face. */
export function signedArea(a: ScreenVertex, b: ScreenVertex, c: ScreenVertex): number {
  return edge(a.x, a.y, b.x, b.y, c.x, c.y);
}

export const isFrontFacing = (a: ScreenVertex, b: ScreenVertex, c: ScreenVertex) => signedArea(a, b, c) < 0;

/**
 * Rasterize one triangle: test every pixel center in the bounding box with three edge
 * functions, apply the top-left rule, and produce perspective-correct barycentrics.
 */
export function rasterizeTriangle(
  tri: [ScreenVertex, ScreenVertex, ScreenVertex],
  width: number,
  height: number,
  triIndex = 0,
): Fragment[] {
  let [v0, v1, v2] = tri;
  let order: [number, number, number] = [0, 1, 2];
  let area = signedArea(v0, v1, v2);
  if (area === 0) return [];
  if (area < 0) {
    [v1, v2] = [v2, v1];
    order = [0, 2, 1];
    area = -area;
  }
  const minX = Math.max(0, Math.floor(Math.min(v0.x, v1.x, v2.x)));
  const maxX = Math.min(width - 1, Math.ceil(Math.max(v0.x, v1.x, v2.x)));
  const minY = Math.max(0, Math.floor(Math.min(v0.y, v1.y, v2.y)));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(v0.y, v1.y, v2.y)));
  const tl0 = isTopLeft(v1, v2);
  const tl1 = isTopLeft(v2, v0);
  const tl2 = isTopLeft(v0, v1);
  const out: Fragment[] = [];
  const nAttr = v0.attrs.length;
  for (let y = minY; y <= maxY; y++) {
    const py = y + 0.5;
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const w0 = edge(v1.x, v1.y, v2.x, v2.y, px, py);
      const w1 = edge(v2.x, v2.y, v0.x, v0.y, px, py);
      const w2 = edge(v0.x, v0.y, v1.x, v1.y, px, py);
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      if ((w0 === 0 && !tl0) || (w1 === 0 && !tl1) || (w2 === 0 && !tl2)) continue;
      const b0 = w0 / area;
      const b1 = w1 / area;
      const b2 = w2 / area;
      const z = b0 * v0.z + b1 * v1.z + b2 * v2.z; // depth is linear in screen space
      // Perspective-correct weights: interpolate attr/w and 1/w, then divide.
      const p0 = b0 * v0.invW;
      const p1 = b1 * v1.invW;
      const p2 = b2 * v2.invW;
      const sum = p0 + p1 + p2;
      const pc = [p0 / sum, p1 / sum, p2 / sum];
      const attrs = new Array(nAttr);
      for (let k = 0; k < nAttr; k++) attrs[k] = pc[0] * v0.attrs[k] + pc[1] * v1.attrs[k] + pc[2] * v2.attrs[k];
      // Report barycentrics in the caller's original vertex order.
      const bary: V3 = [0, 0, 0];
      bary[order[0]] = pc[0];
      bary[order[1]] = pc[1];
      bary[order[2]] = pc[2];
      out.push({ x, y, z, bary, attrs, tri: triIndex });
    }
  }
  return out;
}

export interface RenderOptions {
  rotY?: number;
  rotX?: number;
  cullBack?: boolean;
  depthTest?: boolean;
  maxTriangles?: number;
  clearColor?: V3;
}

export interface TriangleInfo {
  index: number;
  clip: ClipResult;
  culled: boolean;
  screen: [ScreenVertex, ScreenVertex, ScreenVertex][];
  fragments: number;
}

export interface RenderResult {
  width: number;
  height: number;
  matrices: Matrices;
  color: Uint8ClampedArray; // RGBA
  depth: Float32Array; // 1 = cleared (far)
  overdraw: Uint16Array; // fragments generated per pixel
  triangles: TriangleInfo[];
  stats: {
    trianglesIn: number;
    clippedAway: number;
    clipped: number;
    culled: number;
    fragments: number;
    depthRejected: number;
    written: number;
  };
}

/** Full software pipeline: vertex → clip → divide → viewport → cull → raster → shade → depth. */
export function renderMesh(mesh: MeshData, api: ApiId, width: number, height: number, opts: RenderOptions = {}): RenderResult {
  const { rotY = 0.6, rotX = 0, cullBack = true, depthTest = true, clearColor = [0.03, 0.04, 0.08] } = opts;
  const m = matrices(api, rotY, width / height, undefined, rotX);
  const color = new Uint8ClampedArray(width * height * 4);
  const depth = new Float32Array(width * height).fill(1);
  const overdraw = new Uint16Array(width * height);
  for (let i = 0; i < width * height; i++) {
    color[i * 4] = clearColor[0] * 255;
    color[i * 4 + 1] = clearColor[1] * 255;
    color[i * 4 + 2] = clearColor[2] * 255;
    color[i * 4 + 3] = 255;
  }
  const stats = { trianglesIn: 0, clippedAway: 0, clipped: 0, culled: 0, fragments: 0, depthRejected: 0, written: 0 };
  const triangles: TriangleInfo[] = [];

  // Vertex shader: once per vertex (this is what the post-transform cache saves).
  const me = m.model.elements;
  const clipPos: V4[] = [];
  const worldN: V3[] = [];
  const mvp = m.mvp.elements;
  for (let i = 0; i < mesh.vertexCount; i++) {
    const x = mesh.positions[i * 3];
    const y = mesh.positions[i * 3 + 1];
    const z = mesh.positions[i * 3 + 2];
    clipPos.push([
      mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12],
      mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13],
      mvp[2] * x + mvp[6] * y + mvp[10] * z + mvp[14],
      mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15],
    ]);
    const nx = mesh.normals[i * 3];
    const ny = mesh.normals[i * 3 + 1];
    const nz = mesh.normals[i * 3 + 2];
    worldN.push([
      me[0] * nx + me[4] * ny + me[8] * nz,
      me[1] * nx + me[5] * ny + me[9] * nz,
      me[2] * nx + me[6] * ny + me[10] * nz,
    ]);
  }

  const count = Math.min(mesh.triangleCount, opts.maxTriangles ?? Infinity);
  for (let t = 0; t < count; t++) {
    stats.trianglesIn++;
    const ids = [mesh.indices[t * 3], mesh.indices[t * 3 + 1], mesh.indices[t * 3 + 2]];
    const tri = ids.map((i) => ({ pos: clipPos[i], attrs: worldN[i] as number[] })) as [ClipVertex, ClipVertex, ClipVertex];
    const clipped = clipTriangle(api, tri);
    const info: TriangleInfo = { index: t, clip: clipped.result, culled: false, screen: [], fragments: 0 };
    triangles.push(info);
    if (clipped.result === 'outside') {
      stats.clippedAway++;
      continue;
    }
    if (clipped.result === 'clipped') stats.clipped++;
    for (const ct of clipped.triangles) {
      const sv = ct.map((v) => {
        const w = v.pos[3];
        const { canvas } = ndcToWindow(api, [v.pos[0] / w, v.pos[1] / w, v.pos[2] / w], width, height);
        return { x: canvas[0], y: canvas[1], z: canvas[2], invW: 1 / w, attrs: v.attrs };
      }) as [ScreenVertex, ScreenVertex, ScreenVertex];
      if (cullBack && !isFrontFacing(...sv)) {
        info.culled = true;
        continue;
      }
      info.screen.push(sv);
      for (const frag of rasterizeTriangle(sv, width, height, t)) {
        stats.fragments++;
        info.fragments++;
        const p = frag.y * width + frag.x;
        overdraw[p]++;
        if (depthTest && frag.z >= depth[p]) {
          stats.depthRejected++;
          continue;
        }
        depth[p] = frag.z;
        const c = shade(frag.attrs as V3).color;
        color[p * 4] = c[0] * 255;
        color[p * 4 + 1] = c[1] * 255;
        color[p * 4 + 2] = c[2] * 255;
        stats.written++;
      }
    }
    if (info.culled && !info.screen.length) stats.culled++;
  }
  return { width, height, matrices: m, color, depth, overdraw, triangles, stats };
}

/** Pick a nicely visible, front-facing triangle to follow through the pipeline. */
export function pickShowcaseTriangle(result: RenderResult): number {
  let best = 0;
  let bestArea = -1;
  for (const t of result.triangles) {
    if (t.clip !== 'inside' || t.culled || !t.screen.length) continue;
    const a = Math.abs(signedArea(...t.screen[0]));
    if (a > bestArea && t.fragments > 0) {
      bestArea = a;
      best = t.index;
    }
  }
  return best;
}
