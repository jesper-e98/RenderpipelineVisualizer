import type { MeshData } from '../model/types';
import { buildLayout, type VertexLayout } from '../pipeline/layout';
import { pickShowcaseTriangle, renderMesh, type RenderOptions, type RenderResult } from '../pipeline/raster';
import type { ApiId } from './state';

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

  constructor(public readonly mesh: MeshData) {}

  get layout(): VertexLayout {
    return (this.layoutCache ??= buildLayout(this.mesh));
  }

  /** Software-render the mesh at a (usually coarse) resolution with the API's conventions. */
  render(api: ApiId, width: number, height: number, opts: RenderOptions = {}): RenderResult {
    const full = { rotY: SHOWCASE_ROT_Y, rotX: SHOWCASE_ROT_X, ...opts };
    const key = `${api}|${width}x${height}|${JSON.stringify(full)}`;
    let r = this.renders.get(key);
    if (!r) {
      r = renderMesh(this.mesh, api, width, height, full);
      if (this.renders.size > 24) this.renders.clear();
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
