import type { V3 } from './transform';

/**
 * The "fragment shader" used everywhere in the app – both by the CPU rasterizer and by the
 * GLSL ShaderMaterial in the 3D views – so the numbers on screen match what you see.
 */
export const LIGHT_DIR: V3 = normalize([0.5, 0.8, 0.6]);
export const VIEW_DIR: V3 = [0, 0, 1];
export const BASE_COLOR: V3 = [0.95, 0.55, 0.25];
export const AMBIENT = 0.12;
export const SHININESS = 48;

export function normalize(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export interface ShadeTerms {
  n: V3;
  diffuse: number;
  specular: number;
  color: V3; // linear 0..1
}

/** Blinn–Phong with one directional light, normal in world space. */
export function shade(normal: V3, base: V3 = BASE_COLOR): ShadeTerms {
  const n = normalize(normal);
  const diffuse = Math.max(dot(n, LIGHT_DIR), 0);
  const h = normalize([LIGHT_DIR[0] + VIEW_DIR[0], LIGHT_DIR[1] + VIEW_DIR[1], LIGHT_DIR[2] + VIEW_DIR[2]]);
  const specular = diffuse > 0 ? Math.pow(Math.max(dot(n, h), 0), SHININESS) : 0;
  const color: V3 = [0, 1, 2].map((i) => Math.min(1, base[i] * (AMBIENT + diffuse) + specular * 0.8)) as V3;
  return { n, diffuse, specular, color };
}

/** Same shader as GLSL, for the 3D views. Keep in sync with shade(). */
export const FRAGMENT_GLSL = /* glsl */ `
uniform vec3 uLightDir;
uniform vec3 uBaseColor;
varying vec3 vNormal;
void main() {
  vec3 n = normalize(vNormal);
  float diffuse = max(dot(n, uLightDir), 0.0);
  vec3 h = normalize(uLightDir + vec3(0.0, 0.0, 1.0));
  float spec = diffuse > 0.0 ? pow(max(dot(n, h), 0.0), ${SHININESS.toFixed(1)}) : 0.0;
  vec3 color = uBaseColor * (${AMBIENT.toFixed(2)} + diffuse) + spec * 0.8;
  gl_FragColor = vec4(min(color, vec3(1.0)), 1.0);
}
`;

export const VERTEX_GLSL = /* glsl */ `
varying vec3 vNormal;
void main() {
  vNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
