import { BoxGeometry } from 'three';

/** Minimal binary STL with `tris` triangles (normals left zero, as many exporters do). */
export function makeBinaryStl(): ArrayBuffer {
  const g = new BoxGeometry(2, 1, 1).toNonIndexed();
  const p = g.attributes.position;
  const tris = p.count / 3;
  const buf = new ArrayBuffer(84 + tris * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris, true);
  for (let t = 0; t < tris; t++) {
    const o = 84 + t * 50;
    for (let v = 0; v < 3; v++) {
      const i = t * 3 + v;
      dv.setFloat32(o + 12 + v * 12, p.getX(i), true);
      dv.setFloat32(o + 16 + v * 12, p.getY(i), true);
      dv.setFloat32(o + 20 + v * 12, p.getZ(i), true);
    }
  }
  return buf;
}

/** Minimal GLB 2.0: one indexed mesh with POSITION + NORMAL, translated by a node transform. */
export function makeGlb(): ArrayBuffer {
  const g = new BoxGeometry(1, 1, 1);
  const pos = g.attributes.position.array as Float32Array;
  const nrm = g.attributes.normal.array as Float32Array;
  const idx = new Uint16Array(g.index!.array);
  const idxBytes = Math.ceil(idx.byteLength / 4) * 4;
  const bin = new Uint8Array(pos.byteLength + nrm.byteLength + idxBytes);
  bin.set(new Uint8Array(pos.buffer, pos.byteOffset, pos.byteLength), 0);
  bin.set(new Uint8Array(nrm.buffer, nrm.byteOffset, nrm.byteLength), pos.byteLength);
  bin.set(new Uint8Array(idx.buffer), pos.byteLength + nrm.byteLength);
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, translation: [5, 0, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 }] }],
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.byteLength },
      { buffer: 0, byteOffset: pos.byteLength, byteLength: nrm.byteLength },
      { buffer: 0, byteOffset: pos.byteLength + nrm.byteLength, byteLength: idx.byteLength },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: pos.length / 3, type: 'VEC3', min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
      { bufferView: 1, componentType: 5126, count: nrm.length / 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: idx.length, type: 'SCALAR' },
    ],
  };
  let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const pad = (4 - (jsonBytes.length % 4)) % 4;
  jsonBytes = new Uint8Array([...jsonBytes, ...new Array(pad).fill(0x20)]);
  const total = 12 + 8 + jsonBytes.length + 8 + bin.byteLength;
  const out = new ArrayBuffer(total);
  const dv = new DataView(out);
  const u8 = new Uint8Array(out);
  dv.setUint32(0, 0x46546c67, true); // 'glTF'
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length, true);
  dv.setUint32(16, 0x4e4f534a, true); // 'JSON'
  u8.set(jsonBytes, 20);
  const binStart = 20 + jsonBytes.length;
  dv.setUint32(binStart, bin.byteLength, true);
  dv.setUint32(binStart + 4, 0x004e4942, true); // 'BIN\0'
  u8.set(bin, binStart + 8);
  return out;
}
