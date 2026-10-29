/// <reference lib="webworker" />
/**
 * Off-main-thread work: parsing model files, the CPU software renderer and building the shared
 * mesh geometry arrays. Messages are `{ id, op, ... }`; replies are `{ id, ok, ... }` plus
 * `{ id, progress }` updates while parsing.
 */
import { computeMeshArrays } from '../core/meshGeometry';
import { parseModel } from '../model/loadModel';
import type { MeshData } from '../model/types';
import { renderMesh, type RenderOptions } from '../pipeline/raster';
import { packRender } from '../pipeline/renderPack';
import type { ApiId } from '../core/state';
import { runCompute, type ComputeKind } from '../pipeline/compute';

declare const self: DedicatedWorkerGlobalScope;

const meshes = new Map<string, MeshData>();

type Msg =
  | { id: number; op: 'parse'; key: string; name: string; bytes: ArrayBuffer }
  | { id: number; op: 'setMesh'; key: string; mesh: MeshData }
  | { id: number; op: 'drop'; key: string }
  | { id: number; op: 'render'; key: string; api: ApiId; w: number; h: number; opts: RenderOptions }
  | { id: number; op: 'arrays'; key: string }
  | { id: number; op: 'compute'; key: string; kind: ComputeKind; args: unknown };

function meshArraysOf(m: MeshData): ArrayBuffer[] {
  return [m.positions.buffer, m.normals.buffer, m.indices.buffer, ...(m.uvs ? [m.uvs.buffer] : [])] as ArrayBuffer[];
}

/** A copy of the mesh whose arrays can be transferred while the worker keeps its own. */
function cloneMesh(m: MeshData): MeshData {
  return { ...m, positions: m.positions.slice(), normals: m.normals.slice(), indices: m.indices.slice(), uvs: m.uvs ? m.uvs.slice() : null };
}

function need(key: string): MeshData {
  const m = meshes.get(key);
  if (!m) throw new Error(`mesh ${key} not loaded in worker`);
  return m;
}

self.onmessage = async (e: MessageEvent<Msg>) => {
  const msg = e.data;
  try {
    switch (msg.op) {
      case 'parse': {
        const mesh = await parseModel(msg.name, msg.bytes, (stage) => self.postMessage({ id: msg.id, progress: stage }));
        meshes.set(msg.key, mesh);
        const out = cloneMesh(mesh);
        self.postMessage({ id: msg.id, ok: true, mesh: out }, meshArraysOf(out));
        break;
      }
      case 'setMesh':
        meshes.set(msg.key, msg.mesh);
        self.postMessage({ id: msg.id, ok: true });
        break;
      case 'drop':
        meshes.delete(msg.key);
        self.postMessage({ id: msg.id, ok: true });
        break;
      case 'render': {
        const t0 = performance.now();
        const r = renderMesh(need(msg.key), msg.api, msg.w, msg.h, msg.opts);
        const { packed, transfer } = packRender(r, performance.now() - t0);
        self.postMessage({ id: msg.id, ok: true, packed }, transfer);
        break;
      }
      case 'arrays': {
        const a = computeMeshArrays(need(msg.key));
        const p = a.pipeline;
        self.postMessage({ id: msg.id, ok: true, arrays: a }, [p.position.buffer, p.normal.buffer, p.uv.buffer, p.aFaceNormal.buffer, p.aTri.buffer, a.wire.buffer, a.hedge.buffer] as ArrayBuffer[]);
        break;
      }
      case 'compute': {
        const result = runCompute(msg.kind, need(msg.key), msg.args);
        self.postMessage({ id: msg.id, ok: true, result });
        break;
      }
    }
  } catch (err) {
    self.postMessage({ id: msg.id, ok: false, error: String((err as Error)?.message ?? err) });
  }
};
