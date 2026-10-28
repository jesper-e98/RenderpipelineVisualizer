import { describe, expect, it } from 'vitest';
import { parseModel } from '../src/model/loadModel';
import { makeBinaryStl, makeGlb } from './fixtures';

describe('file loaders', () => {
  it('loads a binary STL, welds vertices and shows a hex dump', async () => {
    const m = await parseModel('box.stl', makeBinaryStl());
    expect(m.format).toBe('STL');
    expect(m.sourceIsBinary).toBe(true);
    expect(m.triangleCount).toBe(12);
    expect(m.vertexCount).toBeLessThan(36);
    expect(m.sourcePreview[0]).toMatch(/^00000000 {2}/);
    expect(m.had.normals).toBe(false); // the file's normals were all zero
    expect(m.vertexCount).toBe(8);
    expect(Math.hypot(m.normals[0], m.normals[1], m.normals[2])).toBeCloseTo(1, 5);
  });

  it('loads a GLB, applies the node transform and normalizes', async () => {
    const m = await parseModel('box.glb', makeGlb());
    expect(m.format).toBe('GLB');
    expect(m.triangleCount).toBe(12);
    expect(m.had.normals).toBe(true);
    expect(m.had.indices).toBe(true);
    expect(m.originalCenter[0]).toBeCloseTo(5, 5);
    expect(m.sourcePreview.join('\n')).toContain('glTF');
  });

  it('rejects unknown formats', async () => {
    await expect(parseModel('x.fbx', new ArrayBuffer(4))).rejects.toThrow(/Unsupported/);
  });
});

describe('blend files', () => {
  it('explains that .blend must be exported first', async () => {
    const { BlendFileError } = await import('../src/model/loadModel');
    await expect(parseModel('scene.blend', new ArrayBuffer(4))).rejects.toBeInstanceOf(BlendFileError);
  });
});
