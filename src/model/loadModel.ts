import { Mesh, type BufferGeometry, type Matrix4, type Object3D } from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { geometryToMesh, hexDump, mergeParts, textPreview } from './normalize';
import type { MeshData } from './types';

export const ACCEPTED_EXTENSIONS = ['.obj', '.gltf', '.glb', '.stl'];

/** Blender's native format can't be read in a browser; the UI explains how to export instead. */
export class BlendFileError extends Error {
  constructor() {
    super('.blend files are not supported – export to glTF Binary (.glb) from Blender');
    this.name = 'BlendFileError';
  }
}

function collectMeshes(root: Object3D): { geometry: BufferGeometry; matrix: Matrix4 }[] {
  root.updateMatrixWorld(true);
  const parts: { geometry: BufferGeometry; matrix: Matrix4 }[] = [];
  root.traverse((o) => {
    if (o instanceof Mesh && o.geometry?.attributes?.position) {
      parts.push({ geometry: o.geometry, matrix: o.matrixWorld.clone() });
    }
  });
  return parts;
}

function fromParts(parts: { geometry: BufferGeometry; matrix?: Matrix4 }[], info: Parameters<typeof geometryToMesh>[2]): MeshData {
  if (!parts.length) throw new Error('No triangle meshes found in file');
  const { geometry, had } = mergeParts(parts);
  return geometryToMesh(geometry, had, info);
}

/** Parse a model file's bytes. The format is chosen from the file extension. */
export async function parseModel(fileName: string, buffer: ArrayBuffer): Promise<MeshData> {
  const ext = fileName.toLowerCase().slice(fileName.lastIndexOf('.'));
  const bytes = new Uint8Array(buffer);
  const name = fileName.replace(/\.[^.]+$/, '');
  const base = { name, fileSize: buffer.byteLength };

  if (ext === '.obj') {
    const text = new TextDecoder().decode(bytes);
    const group = new OBJLoader().parse(text);
    const parts = collectMeshes(group);
    // OBJLoader invents flat normals when the file has no "vn" lines; drop them so we can
    // report that honestly and generate smooth ones after welding.
    if (!/^vn\s/m.test(text)) for (const p of parts) p.geometry.deleteAttribute('normal');
    return fromParts(parts, {
      ...base,
      format: 'OBJ',
      sourcePreview: textPreview(text),
      sourceIsBinary: false,
    });
  }

  if (ext === '.stl') {
    const geometry = new STLLoader().parse(buffer);
    const isAscii = new TextDecoder().decode(bytes.subarray(0, 5)) === 'solid' && !looksBinaryStl(bytes);
    const preview = isAscii
      ? textPreview(new TextDecoder().decode(bytes), 'endfacet')
      : [...hexDump(bytes, 80), '…', ...hexDump(bytes, 50, 84)];
    return fromParts([{ geometry }], { ...base, format: 'STL', sourcePreview: preview, sourceIsBinary: !isAscii });
  }

  if (ext === '.gltf' || ext === '.glb') {
    const gltf = await new GLTFLoader().parseAsync(buffer, './');
    const isGlb = ext === '.glb';
    let preview: string[];
    if (isGlb) {
      const jsonLen = new DataView(buffer).getUint32(12, true);
      const json = new TextDecoder().decode(bytes.subarray(20, 20 + Math.min(jsonLen, 600)));
      preview = [...hexDump(bytes, 48), '…', ...json.match(/.{1,64}/g)!.slice(0, 8), '…'];
    } else {
      const text = new TextDecoder().decode(bytes);
      try {
        preview = textPreview(JSON.stringify(JSON.parse(text), null, 2));
      } catch {
        preview = textPreview(text);
      }
    }
    return fromParts(collectMeshes(gltf.scene), {
      ...base,
      format: isGlb ? 'GLB' : 'glTF',
      sourcePreview: preview,
      sourceIsBinary: isGlb,
    });
  }

  if (ext === '.blend') throw new BlendFileError();
  throw new Error(`Unsupported format "${ext}" (use ${ACCEPTED_EXTENSIONS.join(', ')})`);
}

/** Binary STL: 80-byte header + uint32 count + 50 bytes per triangle. */
function looksBinaryStl(bytes: Uint8Array): boolean {
  if (bytes.length < 84) return false;
  const count = new DataView(bytes.buffer, bytes.byteOffset).getUint32(80, true);
  return 84 + count * 50 === bytes.length;
}

export async function loadModelFile(file: File): Promise<MeshData> {
  return parseModel(file.name, await file.arrayBuffer());
}
