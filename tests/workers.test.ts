import { describe, expect, it } from 'vitest';
import { builtinMesh } from '../src/model/builtins';
import { renderMesh } from '../src/pipeline/raster';
import { packRender, unpackRender } from '../src/pipeline/renderPack';
import { computeMeshArrays } from '../src/core/meshGeometry';
import { pipelineArrays } from '../src/views/pipelineMaterial';
import { Derived, RENDER_PRESETS } from '../src/core/derived';

describe('render packing (worker → main thread)', () => {
  const mesh = builtinMesh('teapot');
  const r = renderMesh(mesh, 'vulkan', 64, 40, { rotY: 0.65, rotX: 0.25 });
  // Pack a structured clone, like postMessage would.
  const ref = structuredClone({ color: r.color, depth: r.depth, stats: r.stats, tris: r.triangles.slice(0, 50), mvp: [...r.matrices.mvp.elements] });
  const { packed } = packRender(r, 12.5);
  const u = unpackRender(structuredClone(packed));

  it('keeps pixels, depth, stats and timing', () => {
    expect(Array.from(u.color)).toEqual(Array.from(ref.color));
    expect(Array.from(u.depth)).toEqual(Array.from(ref.depth));
    expect(u.stats).toEqual(ref.stats);
    expect(u.ms).toBe(12.5);
  });

  it('rebuilds real Matrix4s', () => {
    expect(u.matrices.mvp.elements).toEqual(ref.mvp);
    expect(typeof u.matrices.view.clone).toBe('function');
  });

  it('decodes triangles lazily but identically, and array methods work', () => {
    expect(u.triangles.length).toBe(r.triangles.length);
    for (let i = 0; i < 50; i++) {
      const a = u.triangles[i];
      const b = ref.tris[i];
      expect(a.clip).toBe(b.clip);
      expect(a.culled).toBe(b.culled);
      expect(a.fragments).toBe(b.fragments);
      expect(a.screen.length).toBe(b.screen.length);
      a.screen.forEach((tri, k) => tri.forEach((v, j) => {
        expect(v.x).toBeCloseTo(b.screen[k][j].x, 3);
        expect(v.z).toBeCloseTo(b.screen[k][j].z, 5);
        expect(v.attrs.length).toBe(b.screen[k][j].attrs.length);
      }));
    }
    expect(u.triangles.filter((t) => t.culled).length).toBe(r.triangles.filter((t) => t.culled).length);
    expect(u.triangles.find((t) => t.fragments > 0)?.index).toBe(r.triangles.find((t) => t.fragments > 0)?.index);
    expect(u.triangles[u.triangles.length]).toBeUndefined();
  });
});

describe('shared mesh arrays', () => {
  it('worker arrays match the main-thread pipeline geometry', () => {
    const mesh = builtinMesh('cube');
    const a = computeMeshArrays(mesh);
    const b = pipelineArrays(mesh);
    expect(Array.from(a.pipeline.position)).toEqual(Array.from(b.position));
    expect(Array.from(a.pipeline.aTri)).toEqual(Array.from(b.aTri));
    expect(a.wire.length % 6).toBe(0);
    expect(a.hedge.length).toBe(mesh.vertexCount * 6);
  });
});

describe('Derived without workers', () => {
  it('prepare resolves (main-thread fallback) and renders come from the cache', async () => {
    const d = new Derived(builtinMesh('ico'));
    await d.prepare('opengl');
    expect(d.isReady('opengl')).toBe(true);
    const a = d.render('opengl', 160, 100);
    expect(d.render('opengl', 160, 100)).toBe(a);
  });
  it('presets cover the sizes slides use', () => {
    const keys = RENDER_PRESETS.map((p) => `${p.w}x${p.h}`);
    for (const k of ['160x100', '64x40', '320x200', '240x150']) expect(keys).toContain(k);
  });
});
