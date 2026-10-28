import { describe, expect, it } from 'vitest';
import { builtinMesh } from '../src/model/builtins';
import { parseModel } from '../src/model/loadModel';
import { clipTriangle, isInside } from '../src/pipeline/clip';
import { buildLayout } from '../src/pipeline/layout';
import { rasterizeTriangle, renderMesh, type ScreenVertex } from '../src/pipeline/raster';
import { DEFAULT_CAMERA, matrices, runVertex } from '../src/pipeline/transform';
import type { ApiId } from '../src/core/state';

const APIS: ApiId[] = ['opengl', 'vulkan', 'd3d12'];

describe('transform', () => {
  it('maps a point on the near plane to each API depth convention', () => {
    for (const api of APIS) {
      const m = matrices(api, 0, 1);
      // A point straight ahead of the camera, exactly at the near plane distance.
      const eye = DEFAULT_CAMERA.eye;
      const dir = [-eye[0], -eye[1], -eye[2]];
      const len = Math.hypot(...dir);
      const p = dir.map((d, i) => eye[i] + (d / len) * DEFAULT_CAMERA.near) as [number, number, number];
      const s = runVertex(api, p, m, 100, 100);
      expect(s.ndc[2]).toBeCloseTo(api === 'opengl' ? -1 : 0, 5);
      expect(s.window[2]).toBeCloseTo(0, 5);
      expect(s.canvas[0]).toBeCloseTo(50, 4);
      expect(s.canvas[1]).toBeCloseTo(50, 4);
    }
  });

  it('produces the same canvas picture for every API', () => {
    const p: [number, number, number] = [0.3, 0.5, -0.2];
    const results = APIS.map((api) => runVertex(api, p, matrices(api, 0.7, 1.5), 300, 200).canvas);
    for (const r of results) {
      expect(r[0]).toBeCloseTo(results[0][0], 4);
      expect(r[1]).toBeCloseTo(results[0][1], 4);
      expect(r[2]).toBeCloseTo(results[0][2], 4);
    }
  });

  it('flips y in Vulkan clip space and keeps it in OpenGL / D3D12', () => {
    const p: [number, number, number] = [0, 0.8, 0];
    const gl = runVertex('opengl', p, matrices('opengl', 0, 1), 10, 10);
    const vk = runVertex('vulkan', p, matrices('vulkan', 0, 1), 10, 10);
    expect(Math.sign(gl.ndc[1])).toBe(1);
    expect(Math.sign(vk.ndc[1])).toBe(-1);
  });
});

describe('clip', () => {
  const v = (x: number, y: number, z: number, w: number) => ({ pos: [x, y, z, w] as [number, number, number, number], attrs: [] });
  it('uses −w..w depth for OpenGL and 0..w for the others', () => {
    expect(isInside('opengl', [0, 0, -0.5, 1])).toBe(true);
    expect(isInside('vulkan', [0, 0, -0.5, 1])).toBe(false);
  });
  it('clips a triangle crossing the right plane into two triangles', () => {
    const r = clipTriangle('opengl', [v(0, 0, 0, 1), v(2, 0, 0, 1), v(0, 0.5, 0, 1)]);
    expect(r.result).toBe('clipped');
    expect(r.triangles.length).toBe(2);
    for (const t of r.triangles) for (const p of t) expect(p.pos[0]).toBeLessThanOrEqual(1 + 1e-9);
  });
  it('rejects a triangle fully outside', () => {
    expect(clipTriangle('d3d12', [v(2, 0, 0, 1), v(3, 0, 0, 1), v(2, 1, 0, 1)]).result).toBe('outside');
  });
});

describe('raster', () => {
  const sv = (x: number, y: number): ScreenVertex => ({ x, y, z: 0.5, invW: 1, attrs: [] });
  it('covers each pixel of a shared edge exactly once (top-left rule)', () => {
    const a = rasterizeTriangle([sv(0, 0), sv(8, 0), sv(0, 8)], 8, 8);
    const b = rasterizeTriangle([sv(8, 0), sv(8, 8), sv(0, 8)], 8, 8);
    const seen = new Map<string, number>();
    for (const f of [...a, ...b]) seen.set(`${f.x},${f.y}`, (seen.get(`${f.x},${f.y}`) ?? 0) + 1);
    expect(seen.size).toBe(64);
    expect([...seen.values()].every((n) => n === 1)).toBe(true);
  });
  it('barycentrics sum to one', () => {
    for (const f of rasterizeTriangle([sv(1, 1), sv(7, 2), sv(3, 7)], 8, 8)) {
      expect(f.bary[0] + f.bary[1] + f.bary[2]).toBeCloseTo(1, 6);
    }
  });
  it('renders the built-in cube with culling and depth test', () => {
    const r = renderMesh(builtinMesh('cube'), 'vulkan', 64, 40);
    expect(r.stats.trianglesIn).toBe(12);
    expect(r.stats.culled).toBeGreaterThan(0);
    expect(r.stats.written).toBeGreaterThan(100);
    expect(r.depth.some((d) => d < 1)).toBe(true);
  });
});

describe('model', () => {
  it('normalizes built-ins into a unit sphere with an index buffer', () => {
    const m = builtinMesh('teapot');
    expect(m.triangleCount).toBeGreaterThan(100);
    let maxR = 0;
    for (let i = 0; i < m.vertexCount; i++) {
      maxR = Math.max(maxR, Math.hypot(m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]));
    }
    expect(maxR).toBeLessThanOrEqual(1.0001);
  });
  it('parses an OBJ without normals and generates them', async () => {
    const obj = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nv 1 1 0\nf 1 2 3\nf 2 4 3\n';
    const m = await parseModel('quad.obj', new TextEncoder().encode(obj).buffer as ArrayBuffer);
    expect(m.format).toBe('OBJ');
    expect(m.triangleCount).toBe(2);
    expect(m.vertexCount).toBe(4); // welded from 6 OBJ-expanded vertices
    expect(m.had.normals).toBe(false);
    expect(Math.abs(m.normals[2])).toBeCloseTo(1, 5);
  });
  it('interleaves the vertex buffer with the expected stride', () => {
    const m = builtinMesh('cube');
    const l = buildLayout(m);
    expect(l.stride).toBe(32);
    expect(l.vertexBytes).toBe(32 * m.vertexCount);
    expect(l.indexType).toBe('uint16');
    expect(new Float32Array(l.vertexBuffer, 0, 3)[0]).toBeCloseTo(m.positions[0]);
  });
});
