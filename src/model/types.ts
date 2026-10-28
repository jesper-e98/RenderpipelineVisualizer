export type SourceFormat = 'OBJ' | 'glTF' | 'GLB' | 'STL' | 'builtin';

/**
 * A single, normalized triangle mesh. Everything the slides show is derived from this.
 * Positions are centered on the origin and scaled to fit a unit sphere.
 */
export interface MeshData {
  name: string;
  format: SourceFormat;
  positions: Float32Array; // xyz per vertex
  normals: Float32Array; // xyz per vertex
  uvs: Float32Array | null; // uv per vertex
  indices: Uint32Array; // 3 per triangle
  vertexCount: number;
  triangleCount: number;
  fileSize: number; // bytes of the original file (or a synthetic estimate for built-ins)
  /** What the original data looked like: text lines or a hex dump. */
  sourcePreview: string[];
  sourceIsBinary: boolean;
  /** Whether the source had these, or they were generated during import. */
  had: { normals: boolean; uvs: boolean; indices: boolean };
  /** The scale factor applied during normalization, and the original center. */
  normalizeScale: number;
  originalCenter: [number, number, number];
}
