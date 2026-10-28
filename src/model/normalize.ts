import { BufferAttribute, BufferGeometry, Matrix3, Matrix4, Vector3 } from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { MeshData, SourceFormat } from './types';

export interface SourceInfo {
  name: string;
  format: SourceFormat;
  fileSize: number;
  sourcePreview: string[];
  sourceIsBinary: boolean;
}

/** Read any (possibly interleaved / normalized) attribute into a plain Float32Array. */
function readAttr(attr: BufferGeometry['attributes'][string], comps: number): Float32Array {
  const out = new Float32Array(attr.count * comps);
  for (let i = 0; i < attr.count; i++) {
    out[i * comps] = attr.getX(i);
    if (comps > 1) out[i * comps + 1] = attr.getY(i);
    if (comps > 2) out[i * comps + 2] = attr.getZ(i);
  }
  return out;
}

/**
 * Merge several geometries (each with its own world matrix) into one indexed geometry
 * holding only position / normal / uv. Normals and UVs are kept only if every part has them.
 */
export function mergeParts(parts: { geometry: BufferGeometry; matrix?: Matrix4 }[]): {
  geometry: BufferGeometry;
  had: MeshData['had'];
} {
  const allNormals = parts.every((p) => !!p.geometry.attributes.normal);
  const allUvs = parts.every((p) => !!p.geometry.attributes.uv);
  const allIndexed = parts.every((p) => !!p.geometry.index);
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  let base = 0;
  const v = new Vector3();
  for (const { geometry, matrix } of parts) {
    const p = geometry.attributes.position;
    if (!p) continue;
    const m = matrix ?? new Matrix4();
    const nm = new Matrix3().getNormalMatrix(m);
    for (let i = 0; i < p.count; i++) {
      v.set(p.getX(i), p.getY(i), p.getZ(i)).applyMatrix4(m);
      pos.push(v.x, v.y, v.z);
    }
    if (allNormals) {
      const n = geometry.attributes.normal;
      for (let i = 0; i < n.count; i++) {
        v.set(n.getX(i), n.getY(i), n.getZ(i)).applyMatrix3(nm).normalize();
        nrm.push(v.x, v.y, v.z);
      }
    }
    if (allUvs) {
      const t = geometry.attributes.uv;
      for (let i = 0; i < t.count; i++) uv.push(t.getX(i), t.getY(i));
    }
    if (geometry.index) {
      const ix = geometry.index;
      for (let i = 0; i < ix.count; i++) idx.push(ix.getX(i) + base);
    } else {
      for (let i = 0; i < p.count; i++) idx.push(i + base);
    }
    base += p.count;
  }
  const g = new BufferGeometry();
  // Keep the index buffer only when every source part really had one. Otherwise expand to
  // a plain triangle list; geometryToMesh welds duplicates and builds an index afterwards.
  const gather = (src: number[], comps: number) =>
    allIndexed ? new Float32Array(src) : Float32Array.from(idx.flatMap((i) => src.slice(i * comps, i * comps + comps)));
  g.setAttribute('position', new BufferAttribute(gather(pos, 3), 3));
  if (allNormals) g.setAttribute('normal', new BufferAttribute(gather(nrm, 3), 3));
  if (allUvs) g.setAttribute('uv', new BufferAttribute(gather(uv, 2), 2));
  if (allIndexed) g.setIndex(idx);
  return { geometry: g, had: { normals: allNormals, uvs: allUvs, indices: allIndexed } };
}

/** Turn a merged geometry into the normalized MeshData used by every slide. */
export function geometryToMesh(
  input: BufferGeometry,
  had: MeshData['had'],
  info: SourceInfo,
): MeshData {
  let g = input.clone();
  for (const name of Object.keys(g.attributes)) {
    if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
  }
  if (!g.index) g = mergeVertices(g, 1e-5); // weld duplicate vertices → index buffer
  if (!had.normals || !g.attributes.normal) g.computeVertexNormals();

  g.computeBoundingBox();
  const center = new Vector3();
  g.boundingBox!.getCenter(center);
  g.translate(-center.x, -center.y, -center.z);
  g.computeBoundingSphere();
  const radius = g.boundingSphere!.radius || 1;
  const scale = 1 / radius;
  g.scale(scale, scale, scale);

  const positions = readAttr(g.attributes.position, 3);
  const normals = readAttr(g.attributes.normal, 3);
  const uvs = g.attributes.uv ? readAttr(g.attributes.uv, 2) : null;
  const indices = new Uint32Array(g.index!.count);
  for (let i = 0; i < indices.length; i++) indices[i] = g.index!.getX(i);

  return {
    ...info,
    positions,
    normals,
    uvs,
    indices,
    vertexCount: positions.length / 3,
    triangleCount: Math.floor(indices.length / 3),
    had,
    normalizeScale: scale,
    originalCenter: [center.x, center.y, center.z],
  };
}

/** Build a three.js geometry back from MeshData (for 3D views). */
export function meshToGeometry(mesh: MeshData): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(mesh.positions, 3));
  g.setAttribute('normal', new BufferAttribute(mesh.normals, 3));
  if (mesh.uvs) g.setAttribute('uv', new BufferAttribute(mesh.uvs, 2));
  g.setIndex(new BufferAttribute(mesh.indices, 1));
  g.computeBoundingSphere();
  return g;
}

const f = (n: number) => (Math.abs(n) < 5e-7 ? '0' : n.toFixed(6).replace(/0+$/, '').replace(/\.$/, ''));

/** Serialize a geometry as Wavefront OBJ text (used for built-in models' "source"). */
export function geometryToObj(g: BufferGeometry, name: string): string {
  const p = g.attributes.position;
  const n = g.attributes.normal;
  const t = g.attributes.uv;
  const lines = [`# ${name} – generated by Render Pipeline Visualizer`, `o ${name}`];
  for (let i = 0; i < p.count; i++) lines.push(`v ${f(p.getX(i))} ${f(p.getY(i))} ${f(p.getZ(i))}`);
  if (t) for (let i = 0; i < t.count; i++) lines.push(`vt ${f(t.getX(i))} ${f(t.getY(i))}`);
  if (n) for (let i = 0; i < n.count; i++) lines.push(`vn ${f(n.getX(i))} ${f(n.getY(i))} ${f(n.getZ(i))}`);
  const ix = g.index;
  const count = ix ? ix.count : p.count;
  const ref = (k: number) => {
    const a = (ix ? ix.getX(k) : k) + 1;
    return t && n ? `${a}/${a}/${a}` : n ? `${a}//${a}` : `${a}`;
  };
  for (let k = 0; k + 2 < count; k += 3) lines.push(`f ${ref(k)} ${ref(k + 1)} ${ref(k + 2)}`);
  return lines.join('\n') + '\n';
}

/** Short excerpt of a text file: the head, then the first face lines if they come later. */
export function textPreview(text: string, faceTag = 'f '): string[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  const head = lines.slice(0, 14);
  const firstFace = lines.findIndex((l) => l.startsWith(faceTag));
  if (firstFace > head.length) {
    return [...head, '…', ...lines.slice(firstFace, firstFace + 6), '…'];
  }
  return lines.length > 22 ? [...lines.slice(0, 22), '…'] : lines;
}

/** Classic hex dump: offset, 16 bytes, ASCII column. */
export function hexDump(bytes: Uint8Array, length = 128, start = 0): string[] {
  const out: string[] = [];
  const end = Math.min(bytes.length, start + length);
  for (let off = start; off < end; off += 16) {
    const row = bytes.subarray(off, Math.min(off + 16, end));
    const hex = Array.from(row, (b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = Array.from(row, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
    out.push(`${off.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  ${ascii}`);
  }
  return out;
}
