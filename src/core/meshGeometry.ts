import { BufferAttribute, BufferGeometry, EdgesGeometry, WireframeGeometry } from 'three';
import { meshToGeometry } from '../model/normalize';
import type { MeshData } from '../model/types';
import { pipelineArrays, pipelineGeometry, type PipelineArrays } from '../views/pipelineMaterial';

/**
 * Per-mesh GPU geometry shared by every slide: built once (ideally in a worker, see
 * `core/workers.ts`) instead of on every slide change. Shared geometries are flagged
 * `userData.shared` so `disposeScene` leaves them alone; they live until the mesh is dropped.
 */
export interface MeshArrays {
  pipeline: PipelineArrays;
  /** Line-segment positions for the wireframe layer (edges only for big meshes). */
  wire: Float32Array;
  /** Line-segment positions for the normals "hedgehog" (sampled for big meshes). */
  hedge: Float32Array;
}

export type SharedKind = 'pipeline' | 'indexed' | 'wire' | 'hedge' | 'points';

/** Pure: everything a worker can precompute for a mesh. */
export function computeMeshArrays(mesh: MeshData): MeshArrays {
  const indexed = meshToGeometry(mesh);
  const wireGeo = mesh.triangleCount > 20000 ? new EdgesGeometry(indexed, 25) : new WireframeGeometry(indexed);
  const wire = wireGeo.attributes.position.array as Float32Array;
  return { pipeline: pipelineArrays(mesh), wire: new Float32Array(wire), hedge: hedgehogArrays(mesh) };
}

export function hedgehogArrays(mesh: MeshData, length = 0.12, maxLines = 6000): Float32Array {
  const step = Math.max(1, Math.ceil(mesh.vertexCount / maxLines));
  const out = new Float32Array(Math.ceil(mesh.vertexCount / step) * 6);
  let o = 0;
  for (let i = 0; i < mesh.vertexCount; i += step) {
    const px = mesh.positions[i * 3], py = mesh.positions[i * 3 + 1], pz = mesh.positions[i * 3 + 2];
    out[o++] = px;
    out[o++] = py;
    out[o++] = pz;
    out[o++] = px + mesh.normals[i * 3] * length;
    out[o++] = py + mesh.normals[i * 3 + 1] * length;
    out[o++] = pz + mesh.normals[i * 3 + 2] * length;
  }
  return out.subarray(0, o);
}

interface Entry {
  arrays?: Partial<MeshArrays>;
  geos: Partial<Record<SharedKind, BufferGeometry>>;
  /** Slide-specific per-mesh geometry (see adoptGeometry). */
  extra: BufferGeometry[];
}
const cache = new WeakMap<MeshData, Entry>();

function entry(mesh: MeshData): Entry {
  let e = cache.get(mesh);
  if (!e) {
    e = { geos: {}, extra: [] };
    cache.set(mesh, e);
  }
  return e;
}

/** Hand over arrays computed elsewhere (a worker) so building the geometry is just a wrap. */
export function primeMeshArrays(mesh: MeshData, arrays: MeshArrays): void {
  entry(mesh).arrays = arrays;
}

export function hasMeshArrays(mesh: MeshData): boolean {
  return !!cache.get(mesh)?.arrays?.pipeline;
}

const lines = (pos: Float32Array) => {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  return g;
};

/** The shared geometry of `kind` for `mesh` (built on first use). Never dispose it yourself. */
export function sharedGeometry(mesh: MeshData, kind: SharedKind): BufferGeometry {
  const e = entry(mesh);
  let g = e.geos[kind];
  if (g) return g;
  const a = e.arrays ?? {};
  switch (kind) {
    case 'pipeline':
      g = pipelineGeometry(mesh, a.pipeline);
      break;
    case 'indexed':
      g = meshToGeometry(mesh);
      break;
    case 'wire': {
      if (a.wire) g = lines(a.wire);
      else {
        const idx = sharedGeometry(mesh, 'indexed');
        const w = mesh.triangleCount > 20000 ? new EdgesGeometry(idx, 25) : new WireframeGeometry(idx);
        g = lines(w.attributes.position.array as Float32Array);
      }
      break;
    }
    case 'hedge':
      g = lines(a.hedge ?? hedgehogArrays(mesh));
      break;
    case 'points':
      g = lines(mesh.positions);
      break;
  }
  g.computeBoundingSphere();
  g.userData.shared = true;
  e.geos[kind] = g;
  return g;
}

/**
 * Mark a slide's own per-mesh geometry as shared: it survives slide changes (so it is uploaded to
 * the GPU once, not on every visit) and is freed together with the mesh.
 */
export function adoptGeometry<G extends BufferGeometry>(mesh: MeshData, g: G): G {
  g.userData.shared = true;
  entry(mesh).extra.push(g);
  return g;
}

/** Free a mesh's shared GPU geometry (when switching to another model). */
export function releaseMesh(mesh: MeshData): void {
  const e = cache.get(mesh);
  if (!e) return;
  for (const g of Object.values(e.geos)) g?.dispose();
  for (const g of e.extra) g.dispose();
  cache.delete(mesh);
}
