import { Matrix4, Vector3, Vector4 } from 'three';
import type { ApiId } from '../core/state';

export type V3 = [number, number, number];
export type V4 = [number, number, number, number];

export interface Camera {
  eye: V3;
  target: V3;
  up: V3;
  fovY: number; // degrees
  near: number;
  far: number;
}

export const DEFAULT_CAMERA: Camera = {
  eye: [0, 0.9, 3.2],
  target: [0, 0, 0],
  up: [0, 1, 0],
  fovY: 45,
  near: 0.5,
  far: 10,
};

export interface Matrices {
  model: Matrix4;
  view: Matrix4;
  proj: Matrix4;
  mvp: Matrix4;
}

/** Model matrix: spin around Y, tilt a little around X. */
export function modelMatrix(rotY: number, rotX = 0, scale = 1): Matrix4 {
  return new Matrix4()
    .makeRotationX(rotX)
    .premultiply(new Matrix4().makeRotationY(rotY))
    .multiply(new Matrix4().makeScale(scale, scale, scale));
}

/** Right-handed look-at view matrix (camera looks down −Z), used for all APIs. */
export function viewMatrix(cam: Camera): Matrix4 {
  const eye = new Vector3(...cam.eye);
  const target = new Vector3(...cam.target);
  const up = new Vector3(...cam.up);
  const z = eye.clone().sub(target).normalize();
  const x = up.clone().cross(z).normalize();
  const y = z.clone().cross(x);
  return new Matrix4().set(
    x.x, x.y, x.z, -x.dot(eye),
    y.x, y.y, y.z, -y.dot(eye),
    z.x, z.y, z.z, -z.dot(eye),
    0, 0, 0, 1,
  );
}

/**
 * Perspective projection in each API's clip-space convention.
 * - OpenGL: NDC z ∈ [−1, 1], y up.
 * - Direct3D 12: NDC z ∈ [0, 1], y up (right-handed like XMMatrixPerspectiveFovRH).
 * - Vulkan: NDC z ∈ [0, 1], y down – so the Y axis is flipped in the matrix.
 */
export function projectionMatrix(api: ApiId, cam: Camera, aspect: number): Matrix4 {
  const f = 1 / Math.tan((cam.fovY * Math.PI) / 360);
  const n = cam.near;
  const fa = cam.far;
  if (api === 'opengl') {
    return new Matrix4().set(
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (fa + n) / (n - fa), (2 * fa * n) / (n - fa),
      0, 0, -1, 0,
    );
  }
  const yFlip = api === 'vulkan' ? -1 : 1;
  return new Matrix4().set(
    f / aspect, 0, 0, 0,
    0, yFlip * f, 0, 0,
    0, 0, fa / (n - fa), (fa * n) / (n - fa),
    0, 0, -1, 0,
  );
}

export function matrices(api: ApiId, rotY: number, aspect: number, cam = DEFAULT_CAMERA, rotX = 0): Matrices {
  const model = modelMatrix(rotY, rotX);
  const view = viewMatrix(cam);
  const proj = projectionMatrix(api, cam, aspect);
  const mvp = proj.clone().multiply(view).multiply(model);
  return { model, view, proj, mvp };
}

/** Matrix rows (three.js stores column-major; we display row-major like the math). */
export function rows(m: Matrix4): number[][] {
  const e = m.elements;
  return [0, 1, 2, 3].map((r) => [e[r], e[r + 4], e[r + 8], e[r + 12]]);
}

export interface VertexStages {
  object: V4;
  world: V4;
  view: V4;
  clip: V4;
  ndc: V3;
  /** Window coordinates in the API's own convention (GL: origin bottom-left). */
  window: V3;
  /** Canvas pixels: origin top-left, y down. Same picture for every API. */
  canvas: V3;
}

const v4 = (v: Vector4): V4 => [v.x, v.y, v.z, v.w];

/** NDC → viewport. Depth range is mapped to [0, 1] for every API. */
export function ndcToWindow(api: ApiId, ndc: V3, width: number, height: number): { window: V3; canvas: V3 } {
  const x = ((ndc[0] + 1) / 2) * width;
  const depth = api === 'opengl' ? (ndc[2] + 1) / 2 : ndc[2];
  if (api === 'opengl') {
    const y = ((ndc[1] + 1) / 2) * height; // bottom-left origin
    return { window: [x, y, depth], canvas: [x, height - y, depth] };
  }
  // Vulkan: NDC y already points down. D3D12: viewport transform flips y.
  const y = api === 'vulkan' ? ((ndc[1] + 1) / 2) * height : ((1 - ndc[1]) / 2) * height;
  return { window: [x, y, depth], canvas: [x, y, depth] };
}

export function runVertex(api: ApiId, p: V3, m: Matrices, width: number, height: number): VertexStages {
  const object = new Vector4(p[0], p[1], p[2], 1);
  const world = object.clone().applyMatrix4(m.model);
  const view = world.clone().applyMatrix4(m.view);
  const clip = view.clone().applyMatrix4(m.proj);
  const ndc: V3 = [clip.x / clip.w, clip.y / clip.w, clip.z / clip.w];
  const { window, canvas } = ndcToWindow(api, ndc, width, height);
  return { object: v4(object), world: v4(world), view: v4(view), clip: v4(clip), ndc, window, canvas };
}
