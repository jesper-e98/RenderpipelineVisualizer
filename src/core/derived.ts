import type { MeshData } from '../model/types';
import { runCompute } from '../pipeline/compute';
import { buildLayout, type VertexLayout } from '../pipeline/layout';
import { pickShowcaseTriangle, renderMesh, type RenderOptions, type RenderResult } from '../pipeline/raster';
import { hasMeshArrays, primeMeshArrays, releaseMesh } from './meshGeometry';
import type { ApiId } from './state';
import { workers } from './workers';

/** A software render that slides ask for: size and options (rotation defaults to the showcase pose). */
export interface RenderPreset {
  w: number;
  h: number;
  opts?: RenderOptions;
}

/**
 * Every software render the slides use (measured by walking all slides, see `Derived.misses`).
 * `prepare()` computes these in workers so entering a slide never blocks on the CPU rasterizer.
 */
export const RENDER_PRESETS: RenderPreset[] = [
  { w: 160, h: 100 },
  { w: 64, h: 40 },
  { w: 80, h: 50 },
  { w: 40, h: 25 },
  { w: 240, h: 150 },
  { w: 320, h: 200 },
  { w: 160, h: 100, opts: { cullBack: false } },
  { w: 160, h: 100, opts: { depthTest: false } },
  { w: 160, h: 100, opts: { depthTest: false, cullBack: false } },
  { w: 160, h: 100, opts: { rotY: 1.1 } },
  { w: 160, h: 100, opts: { rotY: 1.55 } },
];

/** Compute kinds (pipeline/compute.ts) slides use; prepared in workers like the renders. */
export const COMPUTE_PRESETS: { kind: string; args?: unknown }[] = [];

export type PrepareProgress = (done: number, total: number) => void;

/** Rotation used for every "frozen" data view so all slides show the same frame. */
export const SHOWCASE_ROT_Y = 0.65;
export const SHOWCASE_ROT_X = 0.25;

/**
 * Expensive per-mesh computations, cached so that flipping between slides and APIs stays fast.
 * A new Derived is created whenever the mesh changes.
 */
export class Derived {
  private layoutCache?: VertexLayout;
  private renders = new Map<string, RenderResult>();
  private showcase = new Map<ApiId, number>();
  private computed = new Map<string, unknown>();
  private readyApis = new Set<ApiId>();
  private preparing = new Map<ApiId, Promise<void>>();
  private arraysJob: Promise<void> | null = null;
  /** Render keys that had to be computed synchronously (cache misses) – learned for next time. */
  static misses = new Map<string, RenderPreset>();

  constructor(public readonly mesh: MeshData) {}

  private static key(api: ApiId, width: number, height: number, opts: RenderOptions): string {
    const full = { rotY: SHOWCASE_ROT_Y, rotX: SHOWCASE_ROT_X, ...opts };
    return `${api}|${width}x${height}|${JSON.stringify(full)}`;
  }

  /** True when every preset render for `api` is cached. */
  isReady(api: ApiId): boolean {
    return this.readyApis.has(api);
  }

  /**
   * Precompute, off the main thread, everything slides will ask for with this API:
   * shared geometry arrays, all preset renders and compute presets. Safe to call repeatedly.
   */
  prepare(api: ApiId, onProgress?: PrepareProgress): Promise<void> {
    if (this.readyApis.has(api)) return Promise.resolve();
    let job = this.preparing.get(api);
    if (job) return job;
    const pool = workers();
    if (!pool.available) {
      this.readyApis.add(api);
      return Promise.resolve();
    }
    const presets = new Map<string, RenderPreset>();
    for (const p of [...RENDER_PRESETS, ...Derived.misses.values()]) presets.set(Derived.key(api, p.w, p.h, p.opts ?? {}), p);
    const tasks: (() => Promise<void>)[] = [];
    if (!this.arraysJob && !hasMeshArrays(this.mesh)) {
      this.arraysJob = pool.arrays(this.mesh).then((a) => primeMeshArrays(this.mesh, a));
      tasks.push(() => this.arraysJob!);
    }
    for (const [key, p] of presets) {
      if (this.renders.has(key)) continue;
      tasks.push(() =>
        pool.render(this.mesh, api, p.w, p.h, { rotY: SHOWCASE_ROT_Y, rotX: SHOWCASE_ROT_X, ...p.opts }).then((r) => {
          this.renders.set(key, r);
        }),
      );
    }
    for (const c of COMPUTE_PRESETS) {
      const key = `${c.kind}|${JSON.stringify(c.args ?? null)}`;
      if (this.computed.has(key)) continue;
      tasks.push(() => pool.compute(this.mesh, c.kind, c.args ?? null).then((r) => void this.computed.set(key, r)));
    }
    const total = tasks.length;
    let done = 0;
    onProgress?.(0, total);
    job = Promise.all(
      tasks.map((t) =>
        t()
          .catch((err) => console.warn('worker task failed, will compute on demand', err))
          .then(() => onProgress?.(++done, total)),
      ),
    ).then(() => {
      this.readyApis.add(api);
      this.preparing.delete(api);
    });
    this.preparing.set(api, job);
    return job;
  }

  /** A pure per-mesh computation (pipeline/compute.ts), from the worker cache or run now. */
  compute<R>(kind: string, args: unknown = null): R {
    const key = `${kind}|${JSON.stringify(args)}`;
    if (!this.computed.has(key)) {
      if (import.meta.env?.DEV) console.warn(`[derived] compute "${kind}" ran on the main thread`);
      this.computed.set(key, runCompute(kind, this.mesh, args));
    }
    return this.computed.get(key) as R;
  }

  /** Release GPU geometry and worker copies of this mesh. */
  dispose(): void {
    releaseMesh(this.mesh);
    if (workers().available) workers().drop(this.mesh);
  }

  get layout(): VertexLayout {
    return (this.layoutCache ??= buildLayout(this.mesh));
  }

  /** Software-render the mesh at a (usually coarse) resolution with the API's conventions. */
  render(api: ApiId, width: number, height: number, opts: RenderOptions = {}): RenderResult {
    const full = { rotY: SHOWCASE_ROT_Y, rotX: SHOWCASE_ROT_X, ...opts };
    const key = Derived.key(api, width, height, opts);
    let r = this.renders.get(key);
    if (!r) {
      // Not prepared: compute here, and remember the preset so the next mesh prepares it too.
      const known = RENDER_PRESETS.some((p) => Derived.key(api, p.w, p.h, p.opts ?? {}) === key);
      if (!known) Derived.misses.set(`${width}x${height}|${JSON.stringify(opts)}`, { w: width, h: height, opts });
      if (import.meta.env?.DEV && this.readyApis.has(api)) console.warn(`[derived] render ${key} ran on the main thread`);
      r = renderMesh(this.mesh, api, width, height, full);
      if (this.renders.size > 160) this.renders.clear();
      this.renders.set(key, r);
    }
    return r;
  }

  /** Index of a well-visible, front-facing triangle to follow through the slides. */
  showcaseTriangle(api: ApiId): number {
    let t = this.showcase.get(api);
    if (t === undefined) {
      t = pickShowcaseTriangle(this.render(api, 160, 100));
      this.showcase.set(api, t);
    }
    return t;
  }

  /** The three vertex indices of a triangle. */
  triangleVertices(tri: number): [number, number, number] {
    const ix = this.mesh.indices;
    return [ix[tri * 3], ix[tri * 3 + 1], ix[tri * 3 + 2]];
  }

  position(i: number): [number, number, number] {
    const p = this.mesh.positions;
    return [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];
  }

  normal(i: number): [number, number, number] {
    const n = this.mesh.normals;
    return [n[i * 3], n[i * 3 + 1], n[i * 3 + 2]];
  }

  uv(i: number): [number, number] | null {
    const u = this.mesh.uvs;
    return u ? [u[i * 2], u[i * 2 + 1]] : null;
  }
}
