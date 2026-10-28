import { BufferAttribute, BufferGeometry, Color, FrontSide, ShaderMaterial, Vector2, Vector3 } from 'three';
import type { MeshData } from '../model/types';
import { AMBIENT, BASE_COLOR, LIGHT_DIR, SHININESS } from '../pipeline/shade';

/** What the solid layer shows. Mixed with the regular Blinn–Phong shading by `uModeMix`. */
export const VIEW_MODE = {
  shaded: 0,
  normals: 1,
  uv: 2,
  depth: 3,
  unlit: 4,
  triangleId: 5,
  ghost: 6,
} as const;
export type ViewMode = keyof typeof VIEW_MODE;

/**
 * Non-indexed copy of the mesh with per-triangle attributes, so a single material can explode
 * triangles, draw them in index order, highlight one, and so on.
 */
export function pipelineGeometry(mesh: MeshData): BufferGeometry {
  const n = mesh.triangleCount;
  const pos = new Float32Array(n * 9);
  const nrm = new Float32Array(n * 9);
  const uv = new Float32Array(n * 6);
  const face = new Float32Array(n * 9);
  const tri = new Float32Array(n * 3);
  const P = mesh.positions;
  const N = mesh.normals;
  const U = mesh.uvs;
  for (let t = 0; t < n; t++) {
    const ia = mesh.indices[t * 3];
    const ib = mesh.indices[t * 3 + 1];
    const ic = mesh.indices[t * 3 + 2];
    const ax = P[ia * 3], ay = P[ia * 3 + 1], az = P[ia * 3 + 2];
    const bx = P[ib * 3], by = P[ib * 3 + 1], bz = P[ib * 3 + 2];
    const cx = P[ic * 3], cy = P[ic * 3 + 1], cz = P[ic * 3 + 2];
    // Face normal for the explode effect.
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    const fl = Math.hypot(fx, fy, fz) || 1;
    fx /= fl; fy /= fl; fz /= fl;
    [ia, ib, ic].forEach((vi, k) => {
      const o = t * 9 + k * 3;
      pos[o] = P[vi * 3]; pos[o + 1] = P[vi * 3 + 1]; pos[o + 2] = P[vi * 3 + 2];
      nrm[o] = N[vi * 3]; nrm[o + 1] = N[vi * 3 + 1]; nrm[o + 2] = N[vi * 3 + 2];
      face[o] = fx; face[o + 1] = fy; face[o + 2] = fz;
      if (U) { uv[t * 6 + k * 2] = U[vi * 2]; uv[t * 6 + k * 2 + 1] = U[vi * 2 + 1]; }
      tri[t * 3 + k] = t;
    });
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('normal', new BufferAttribute(nrm, 3));
  g.setAttribute('uv', new BufferAttribute(uv, 2));
  g.setAttribute('aFaceNormal', new BufferAttribute(face, 3));
  g.setAttribute('aTri', new BufferAttribute(tri, 1));
  g.computeBoundingSphere();
  return g;
}

const VERT = /* glsl */ `
attribute vec3 aFaceNormal;
attribute float aTri;
uniform float uExplode;
varying vec3 vNormal;
varying vec3 vObjPos;
varying vec2 vUv;
varying float vTri;
varying float vViewZ;
void main() {
  vec3 p = position + aFaceNormal * uExplode;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vObjPos = position;
  vUv = uv;
  vTri = aTri;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vViewZ = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
uniform vec3 uLightDir;
uniform vec3 uBaseColor;
uniform float uAmbient;
uniform float uDiffuseW;
uniform float uSpecW;
uniform float uOpacity;
uniform float uDrawTris;
uniform float uHighlightTri;
uniform vec3 uHighlightColor;
uniform int uMode;
uniform float uModeMix;
uniform vec2 uDepthRange;
uniform float uSweep;
uniform int uSweepMode;
uniform vec3 uSweepColor;
uniform float uBackTint;
uniform float uTime;
varying vec3 vNormal;
varying vec3 vObjPos;
varying vec2 vUv;
varying float vTri;
varying float vViewZ;

vec3 heat(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 a = vec3(1.0, 0.98, 0.86), b = vec3(1.0, 0.71, 0.28), c = vec3(1.0, 0.25, 0.82), d = vec3(0.43, 0.27, 1.0), e = vec3(0.04, 0.05, 0.16);
  if (t < 0.25) return mix(a, b, t / 0.25);
  if (t < 0.5) return mix(b, c, (t - 0.25) / 0.25);
  if (t < 0.75) return mix(c, d, (t - 0.5) / 0.25);
  return mix(d, e, (t - 0.75) / 0.25);
}

vec3 hashColor(float id) {
  vec3 h = fract(sin(vec3(id * 12.9898, id * 78.233, id * 37.719)) * 43758.5453);
  return 0.35 + 0.65 * h;
}

vec3 shadeBP(vec3 n) {
  float diffuse = max(dot(n, uLightDir), 0.0);
  vec3 h = normalize(uLightDir + vec3(0.0, 0.0, 1.0));
  float spec = diffuse > 0.0 ? pow(max(dot(n, h), 0.0), ${SHININESS.toFixed(1)}) : 0.0;
  vec3 c = uBaseColor * (uAmbient + diffuse * uDiffuseW) + spec * 0.8 * uSpecW;
  return min(c, vec3(1.0));
}

vec3 modeColor(int m, vec3 n) {
  if (m == 1) return n * 0.5 + 0.5;
  if (m == 2) {
    float checker = mod(floor(vUv.x * 8.0) + floor(vUv.y * 8.0), 2.0);
    return vec3(vUv, 0.55) * (0.65 + 0.35 * checker);
  }
  if (m == 3) return heat((vViewZ - uDepthRange.x) / max(uDepthRange.y - uDepthRange.x, 1e-4));
  if (m == 4) return uBaseColor;
  if (m == 5) return hashColor(vTri);
  if (m == 6) return vec3(0.22, 0.88, 1.0) * (0.25 + 0.5 * pow(1.0 - abs(n.z), 2.0));
  return shadeBP(n);
}

void main() {
  if (vTri >= uDrawTris) discard;
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  vec3 c = mix(shadeBP(n), modeColor(uMode, n), uModeMix);
  if (vObjPos.y > uSweep) c = modeColor(uSweepMode, n);
  c += uSweepColor * smoothstep(0.035, 0.0, abs(vObjPos.y - uSweep)) * 1.6;
  if (abs(vTri - uHighlightTri) < 0.5) c = mix(c, uHighlightColor, 0.55 + 0.3 * sin(uTime * 6.0));
  if (!gl_FrontFacing) c = mix(c, vec3(1.0, 0.35, 0.43), uBackTint);
  gl_FragColor = vec4(c, uOpacity);
}
`;

export type PipelineMaterial = ShaderMaterial & {
  uniforms: {
    uLightDir: { value: Vector3 };
    uBaseColor: { value: Color };
    uAmbient: { value: number };
    uDiffuseW: { value: number };
    uSpecW: { value: number };
    uOpacity: { value: number };
    uDrawTris: { value: number };
    uHighlightTri: { value: number };
    uHighlightColor: { value: Color };
    uMode: { value: number };
    uModeMix: { value: number };
    uDepthRange: { value: Vector2 };
    uSweep: { value: number };
    uSweepMode: { value: number };
    uSweepColor: { value: Color };
    uBackTint: { value: number };
    uExplode: { value: number };
    uTime: { value: number };
  };
};

/** The one material behind every 3D view of the model. Defaults reproduce shade.ts exactly. */
export function pipelineMaterial(): PipelineMaterial {
  return new ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: FrontSide, // back-face culling, like the pipeline's default state
    transparent: false,
    uniforms: {
      uLightDir: { value: new Vector3(...LIGHT_DIR) },
      uBaseColor: { value: new Color(...BASE_COLOR) },
      uAmbient: { value: AMBIENT },
      uDiffuseW: { value: 1 },
      uSpecW: { value: 1 },
      uOpacity: { value: 1 },
      uDrawTris: { value: 1e9 },
      uHighlightTri: { value: -10 },
      uHighlightColor: { value: new Color(0x38e1ff) },
      uMode: { value: 0 },
      uModeMix: { value: 0 },
      uDepthRange: { value: new Vector2(2.2, 4.2) },
      uSweep: { value: 100 },
      uSweepMode: { value: VIEW_MODE.ghost },
      uSweepColor: { value: new Color(0x000000) },
      uBackTint: { value: 0 },
      uExplode: { value: 0 },
      uTime: { value: 0 },
    },
  }) as PipelineMaterial;
}
