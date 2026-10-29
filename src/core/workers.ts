import type { MeshArrays } from './meshGeometry';
import type { ApiId } from './state';
import type { LoadStage } from '../model/normalize';
import type { MeshData } from '../model/types';
import type { RenderOptions, RenderResult } from '../pipeline/raster';
import { unpackRender, type PackedRender } from '../pipeline/renderPack';

/**
 * A small pool of pipeline workers (see `workers/pipeline.worker.ts`). Every call returns a
 * promise; if workers are unavailable (or one crashes) callers get a rejection and fall back to
 * doing the work on the main thread.
 */
type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void; onProgress?: (s: LoadStage) => void };

class PipelineWorkers {
  private workers: Worker[] = [];
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private rr = 0;
  /** Which workers already hold which mesh. */
  private loaded = new Map<string, Set<number>>();
  private keys = new WeakMap<MeshData, string>();
  private keySeq = 0;
  readonly available: boolean;

  constructor() {
    let ok = false;
    try {
      const n = Math.max(1, Math.min(2, (navigator.hardwareConcurrency || 2) - 1));
      for (let i = 0; i < n; i++) {
        const w = new Worker(new URL('../workers/pipeline.worker.ts', import.meta.url), { type: 'module' });
        w.onmessage = (e) => this.onMessage(e.data);
        w.onerror = (e) => {
          console.warn('pipeline worker error', e.message);
          this.failAll(new Error(e.message || 'worker error'));
        };
        this.workers.push(w);
      }
      ok = this.workers.length > 0;
    } catch (err) {
      console.warn('Web Workers unavailable – heavy work runs on the main thread', err);
    }
    this.available = ok;
  }

  get size(): number {
    return this.workers.length;
  }

  keyOf(mesh: MeshData): string {
    let k = this.keys.get(mesh);
    if (!k) {
      k = `m${++this.keySeq}`;
      this.keys.set(mesh, k);
    }
    return k;
  }

  private onMessage(d: { id: number; ok?: boolean; error?: string; progress?: LoadStage; [k: string]: unknown }): void {
    const p = this.pending.get(d.id);
    if (!p) return;
    if (d.progress) {
      p.onProgress?.(d.progress);
      return;
    }
    this.pending.delete(d.id);
    if (d.ok) p.resolve(d);
    else p.reject(new Error(d.error ?? 'worker failed'));
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private call<T>(worker: number, msg: Record<string, unknown>, transfer: Transferable[] = [], onProgress?: (s: LoadStage) => void): Promise<T> {
    if (!this.available) return Promise.reject(new Error('no workers'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
      this.workers[worker].postMessage({ ...msg, id }, transfer);
    });
  }

  private pick(): number {
    this.rr = (this.rr + 1) % this.workers.length;
    return this.rr;
  }

  /** Make sure worker `w` has the mesh (copied, the main thread keeps its own). */
  private async ensure(w: number, mesh: MeshData): Promise<string> {
    const key = this.keyOf(mesh);
    const set = this.loaded.get(key) ?? new Set<number>();
    this.loaded.set(key, set);
    if (!set.has(w)) {
      set.add(w);
      await this.call(w, { op: 'setMesh', key, mesh });
    }
    return key;
  }

  /** Parse a model file in a worker. The bytes are transferred (the caller's copy becomes empty). */
  async parse(name: string, bytes: ArrayBuffer, onProgress?: (s: LoadStage) => void): Promise<MeshData> {
    const w = this.pick();
    const key = `m${++this.keySeq}`;
    const res = await this.call<{ mesh: MeshData }>(w, { op: 'parse', key, name, bytes }, [bytes], onProgress);
    this.keys.set(res.mesh, key);
    this.loaded.set(key, new Set([w]));
    return res.mesh;
  }

  async render(mesh: MeshData, api: ApiId, w: number, h: number, opts: RenderOptions): Promise<RenderResult & { ms: number }> {
    const wi = this.pick();
    const key = await this.ensure(wi, mesh);
    const res = await this.call<{ packed: PackedRender }>(wi, { op: 'render', key, api, w, h, opts });
    return unpackRender(res.packed);
  }

  async arrays(mesh: MeshData): Promise<MeshArrays> {
    const wi = this.pick();
    const key = await this.ensure(wi, mesh);
    const res = await this.call<{ arrays: MeshArrays }>(wi, { op: 'arrays', key });
    return res.arrays;
  }

  async compute<R>(mesh: MeshData, kind: string, args: unknown): Promise<R> {
    const wi = this.pick();
    const key = await this.ensure(wi, mesh);
    const res = await this.call<{ result: R }>(wi, { op: 'compute', key, kind, args });
    return res.result;
  }

  /** Forget a mesh in every worker. */
  drop(mesh: MeshData): void {
    const key = this.keys.get(mesh);
    if (!key) return;
    const set = this.loaded.get(key);
    set?.forEach((w) => void this.call(w, { op: 'drop', key }).catch(() => {}));
    this.loaded.delete(key);
  }
}

let pool: PipelineWorkers | null = null;
/** The shared worker pool (created on first use). */
export function workers(): PipelineWorkers {
  return (pool ??= new PipelineWorkers());
}
