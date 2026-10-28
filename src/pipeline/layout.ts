import type { MeshData } from '../model/types';

export interface VertexAttribute {
  name: 'position' | 'normal' | 'uv';
  semantic: string; // HLSL semantic
  location: number; // GLSL / SPIR-V location
  components: number;
  offset: number; // bytes from start of vertex
  /** Format names per API. */
  formats: { opengl: string; vulkan: string; d3d12: string };
}

export interface VertexLayout {
  attributes: VertexAttribute[];
  stride: number;
  vertexBuffer: ArrayBuffer;
  indexBuffer: ArrayBuffer;
  indexType: 'uint16' | 'uint32';
  vertexBytes: number;
  indexBytes: number;
}

const FORMATS: Record<number, VertexAttribute['formats']> = {
  2: { opengl: '2, GL_FLOAT', vulkan: 'VK_FORMAT_R32G32_SFLOAT', d3d12: 'DXGI_FORMAT_R32G32_FLOAT' },
  3: { opengl: '3, GL_FLOAT', vulkan: 'VK_FORMAT_R32G32B32_SFLOAT', d3d12: 'DXGI_FORMAT_R32G32B32_FLOAT' },
};

/** Interleave position / normal / uv into one vertex buffer, exactly like an engine would. */
export function buildLayout(mesh: MeshData): VertexLayout {
  const attrs: VertexAttribute[] = [];
  let offset = 0;
  const add = (name: VertexAttribute['name'], semantic: string, components: number) => {
    attrs.push({ name, semantic, location: attrs.length, components, offset, formats: FORMATS[components] });
    offset += components * 4;
  };
  add('position', 'POSITION', 3);
  add('normal', 'NORMAL', 3);
  if (mesh.uvs) add('uv', 'TEXCOORD', 2);
  const stride = offset;

  const vb = new ArrayBuffer(stride * mesh.vertexCount);
  const view = new DataView(vb);
  for (let i = 0; i < mesh.vertexCount; i++) {
    const base = i * stride;
    for (const a of attrs) {
      const src = a.name === 'position' ? mesh.positions : a.name === 'normal' ? mesh.normals : mesh.uvs!;
      for (let c = 0; c < a.components; c++) {
        view.setFloat32(base + a.offset + c * 4, src[i * a.components + c], true); // GPUs are little-endian
      }
    }
  }

  const indexType = mesh.vertexCount <= 0xffff ? 'uint16' : 'uint32';
  const ib = indexType === 'uint16' ? new Uint16Array(mesh.indices).buffer : new Uint32Array(mesh.indices).buffer;
  return {
    attributes: attrs,
    stride,
    vertexBuffer: vb,
    indexBuffer: ib as ArrayBuffer,
    indexType,
    vertexBytes: vb.byteLength,
    indexBytes: ib.byteLength,
  };
}

/** Bytes of one vertex as hex strings, for the memory view. */
export function vertexBytesHex(layout: VertexLayout, index: number): string[] {
  const bytes = new Uint8Array(layout.vertexBuffer, index * layout.stride, layout.stride);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0'));
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}
