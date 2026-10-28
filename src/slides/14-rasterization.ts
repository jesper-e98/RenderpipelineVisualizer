import {
  AdditiveBlending,
  ArrowHelper,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  Vector3,
  type Object3D,
} from 'three';
import { SHOWCASE_ROT_Y } from '../core/derived';
import { h } from '../core/dom';
import { L } from '../core/i18n';
import type { ApiId } from '../core/state';
import { rasterizeTriangle, signedArea, type Fragment, type RenderResult, type ScreenVertex } from '../pipeline/raster';
import { DEFAULT_CAMERA, type V3 } from '../pipeline/transform';
import { createModelStage, secs, type ModelStage } from '../views/ModelStage';
import { PixelCanvas } from '../views/PixelCanvas';
import { COLORS, label } from '../views/three-helpers';
import { stat } from '../views/widgets';
import { standardSlide } from './standard';
import type { ApiPanelSpec, SlideContext, Visual } from './types';
import '../styles/slides/rasterization.css';

/* ------------------------------------------------------------------ */
/* Shared helpers (also used by the fragment-shader slide)             */
/* ------------------------------------------------------------------ */

type Tri = [ScreenVertex, ScreenVertex, ScreenVertex];

export interface ZoomedTriangle {
  tri: number;
  /** Size of the zoomed crop, in pixels of the virtual render target. */
  cols: number;
  rows: number;
  /** The virtual render target the crop is cut from (same aspect as every data view). */
  fullW: number;
  fullH: number;
  /** Crop origin in the full render target (integers, so pixel centers stay at +0.5). */
  x0: number;
  y0: number;
  /** Triangle in crop coordinates. */
  verts: Tri;
  frags: Fragment[];
  /** Signed area ×2 (negative = counter-clockwise on screen = front face). */
  area: number;
}

/**
 * The showcase triangle, rendered into a render target big enough that the triangle spans many
 * pixels, and cropped around it. Screen coordinates scale linearly with the target size (the
 * aspect ratio is fixed), so this is exactly what a real rasterizer at that resolution produces.
 */
export function zoomShowcase(ctx: SlideContext, cols = 48, rows = 30): ZoomedTriangle | null {
  const api = ctx.state.api;
  const tri = ctx.derived.showcaseTriangle(api);
  const base = ctx.derived.render(api, 160, 100);
  const sv = base.triangles[tri]?.screen[0];
  if (!sv) return null;
  const xs = sv.map((v) => v.x);
  const ys = sv.map((v) => v.y);
  const bw = Math.max(1e-6, Math.max(...xs) - Math.min(...xs));
  const bh = Math.max(1e-6, Math.max(...ys) - Math.min(...ys));
  const k = Math.min((cols * 0.62) / bw, (rows * 0.74) / bh, 1500);
  const fullW = Math.max(Math.ceil(cols / 8) * 8, Math.round((160 * k) / 8) * 8, 64);
  const fullH = (fullW * 5) / 8;
  const s = fullW / 160;
  const cx = ((Math.min(...xs) + Math.max(...xs)) / 2) * s;
  const cy = ((Math.min(...ys) + Math.max(...ys)) / 2) * s;
  const x0 = Math.max(0, Math.min(fullW - cols, Math.round(cx - cols / 2)));
  const y0 = Math.max(0, Math.min(fullH - rows, Math.round(cy - rows / 2)));
  const verts = sv.map((v) => ({ ...v, x: v.x * s - x0, y: v.y * s - y0 })) as Tri;
  const frags = rasterizeTriangle(verts, cols, rows, tri);
  return { tri, cols, rows, fullW, fullH, x0, y0, verts, frags, area: signedArea(...verts) };
}

/** The fragment closest to the triangle's centroid – a "typical" pixel to follow. */
export function centerFragment(z: ZoomedTriangle): Fragment | null {
  if (!z.frags.length) return null;
  const cx = (z.verts[0].x + z.verts[1].x + z.verts[2].x) / 3;
  const cy = (z.verts[0].y + z.verts[1].y + z.verts[2].y) / 3;
  let best = z.frags[0];
  let bd = Infinity;
  for (const f of z.frags) {
    const d = (f.x + 0.5 - cx) ** 2 + (f.y + 0.5 - cy) ** 2;
    if (d < bd) {
      bd = d;
      best = f;
    }
  }
  return best;
}

/** Pixel-center coordinate as the fragment shader sees it (gl_FragCoord / SV_Position). */
export function fragCoord(api: ApiId, x: number, y: number, fullH: number): [number, number] {
  return api === 'opengl' ? [x + 0.5, fullH - y - 0.5] : [x + 0.5, y + 0.5];
}

export const fragCoordName = (api: ApiId) => (api === 'd3d12' ? 'SV_Position' : 'gl_FragCoord');

const edgeFn = (a: ScreenVertex, b: ScreenVertex, px: number, py: number) => (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x);
const isTopLeft = (a: ScreenVertex, b: ScreenVertex) => (a.y === b.y && b.x > a.x) || b.y < a.y;
const f2 = (v: number, d = 2) => (Math.abs(v) < 0.5 * 10 ** -d ? 0 : v).toFixed(d);
const triHue = (i: number) => (i * 137.508) % 360;
const VCOL = ['#ff5a6e', '#5cf08f', '#5aa9ff'];

/* ------------------------------------------------------------------ */
/* 3D toolkit for the raster-stage slides (rasterization … present):  */
/* the CPU pipeline's camera, a framebuffer plane in front of the      */
/* model, and glowing pixel cells that pop up on it.                   */
/* ------------------------------------------------------------------ */

const CAM = (() => {
  const c = DEFAULT_CAMERA;
  const eye = new Vector3(...c.eye);
  const back = eye.clone().sub(new Vector3(...c.target)).normalize();
  const right = new Vector3(...c.up).cross(back).normalize();
  const up = back.clone().cross(right);
  return { eye, back, right, up, tan: Math.tan((c.fovY * Math.PI) / 360) };
})();
/** Every data render in the app is 8:5 (160×100, 80×50 …). */
export const RT_ASPECT = 1.6;
/** The camera every CPU render uses, in world (= scene) space. */
export const VIRTUAL_EYE = CAM.eye.clone();
export const VIEW_FORWARD = CAM.back.clone().negate();

/** World point on the view ray through canvas pixel (cx, cy) of a W×H render, `dist` in front of the camera. */
export function viewRayPoint(cx: number, cy: number, W: number, H: number, dist: number): Vector3 {
  const nx = (2 * cx) / W - 1;
  const ny = 1 - (2 * cy) / H;
  return CAM.eye
    .clone()
    .addScaledVector(CAM.back, -dist)
    .addScaledVector(CAM.right, nx * dist * CAM.tan * RT_ASPECT)
    .addScaledVector(CAM.up, ny * dist * CAM.tan);
}

/** World point → canvas coordinates of a W×H render (like the CPU pipeline) + distance along the view axis. */
export function worldToCanvas(p: Vector3, W: number, H: number): [number, number, number] {
  const d = p.clone().sub(CAM.eye);
  const zc = Math.max(1e-4, -d.dot(CAM.back));
  const nx = d.dot(CAM.right) / (zc * CAM.tan * RT_ASPECT);
  const ny = d.dot(CAM.up) / (zc * CAM.tan);
  return [((nx + 1) / 2) * W, ((1 - ny) / 2) * H, zc];
}

/** sRGB-encoded 0..1 → linear (the 3D view encodes to sRGB on output). */
export const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
/** An 8-bit sRGB image → the same image with linear values, so the 3D view (which encodes to sRGB) shows it unchanged. */
export function linImage(rgba: Uint8ClampedArray): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) lut[i] = Math.round(toLinear(i / 255) * 255);
  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    out[i] = lut[rgba[i]];
    out[i + 1] = lut[rgba[i + 1]];
    out[i + 2] = lut[rgba[i + 2]];
    out[i + 3] = rgba[i + 3];
  }
  return out;
}
export const linRgb = (c: readonly number[]): V3 => [toLinear(c[0]), toLinear(c[1]), toLinear(c[2])];

function hsl(hh: number, s: number, l: number): V3 {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + hh / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}
/** The per-triangle color used for "which triangle covers this pixel" (sRGB 0..1). */
export const triColor = (i: number): V3 => hsl(triHue(i), 0.85, 0.58);

/** A set of line segments (pairs of points) whose points can be replaced every frame. */
export function lineSet(parent: Object3D, pts: Vector3[], color: number, opacity = 0.85): LineSegments {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(Math.max(2, pts.length) * 3), 3));
  const ls = new LineSegments(g, new LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
  ls.frustumCulled = false;
  setLines(ls, pts);
  parent.add(ls);
  return ls;
}
export function setLines(ls: LineSegments, pts: Vector3[]): void {
  let a = ls.geometry.attributes.position as BufferAttribute;
  if (a.count < pts.length) {
    a = new BufferAttribute(new Float32Array(pts.length * 3), 3);
    ls.geometry.setAttribute('position', a);
  }
  pts.forEach((p, i) => a.setXYZ(i, p.x, p.y, p.z));
  a.needsUpdate = true;
  ls.geometry.setDrawRange(0, pts.length);
}
/** Closed polygon → segment pairs. */
export const loopPts = (pts: Vector3[]) => pts.flatMap((p, i) => [p, pts[(i + 1) % pts.length]]);

/** A glowing dot (additive sprite). */
export function glowDot(parent: Object3D, pos: Vector3, color: number, size = 0.1): Mesh {
  const m = new Mesh(
    new PlaneGeometry(size, size),
    new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: AdditiveBlending,
      uniforms: { uColor: { value: new Color(color) } },
      vertexShader:
        'varying vec2 vUv; void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(0.0,0.0,0.0,1.0); mv.xy += position.xy; gl_Position = projectionMatrix * mv; }',
      fragmentShader:
        'uniform vec3 uColor; varying vec2 vUv; void main(){ float d = length(vUv - 0.5) * 2.0; float a = smoothstep(1.0, 0.0, d); gl_FragColor = vec4(uColor * a + vec3(a * a * 0.6), a); }',
    }),
  );
  m.position.copy(pos);
  m.renderOrder = 5;
  parent.add(m);
  return m;
}

/** An arrow (drawn on top of everything) with a label at its tip; re-aim it with `set`. */
export function vecArrow(parent: Object3D, color: number, text: string, cls = ''): Group & { set(o: Vector3, d: Vector3, len: number): void } {
  const g = new Group() as Group & { set(o: Vector3, d: Vector3, len: number): void };
  const a = new ArrowHelper(new Vector3(0, 1, 0), new Vector3(), 1, color, 0.1, 0.06);
  [a.line.material, a.cone.material].forEach((m) => Object.assign(m, { depthTest: false, transparent: true }));
  a.line.renderOrder = a.cone.renderOrder = 6;
  const l = label(text, cls);
  l.visible = !!text;
  g.add(a, l);
  g.set = (o, d, len) => {
    const dn = d.clone().normalize();
    a.position.copy(o);
    a.setDirection(dn);
    a.setLength(len, Math.min(0.12, len * 0.25), Math.min(0.07, len * 0.14));
    l.position.copy(o).addScaledVector(dn, len + 0.09);
  };
  parent.add(g);
  return g;
}

export interface Rig {
  /** Oriented like the virtual camera (x right, y up, z towards the camera); origin = plane center. */
  group: Group;
  w: number;
  h: number;
  dist: number;
  /** Canvas coordinates (cx, cy) of a W×H render → plane-local position (z above the plane). */
  local(cx: number, cy: number, W: number, H: number, z?: number): Vector3;
  /** Same in world space. */
  world(cx: number, cy: number, W: number, H: number, z?: number): Vector3;
  border: LineSegments;
  back: Mesh;
  /** Faint pixel grid (replaces an earlier one). */
  grid(cols: number, rows: number, opacity?: number): LineSegments;
  /** Lines every `n` pixels (tiles). */
  tiles(cols: number, rows: number, n: number, color?: number, opacity?: number): LineSegments;
}

/**
 * The framebuffer as a plane `dist` units in front of the CPU pipeline's camera, exactly
 * filling its view frustum – so every pixel of a data render sits on the view ray through it.
 */
/** Transform a point from `obj`'s local space into its scene's space (also correct when the scene is re-parented in XR). */
export function toScene(obj: Object3D, v: Vector3): Vector3 {
  let o: Object3D | null = obj;
  while (o && !(o as { isScene?: boolean }).isScene) {
    o.updateMatrix();
    v.applyMatrix4(o.matrix);
    o = o.parent;
  }
  return v;
}

/** A framebuffer-like plane (w × h, centered, facing +z) with a backing, border and optional grid. */
export function planeRig(parent: Object3D, w: number, hh: number, opts: { back?: number; color?: number } = {}): Rig {
  const group = new Group();
  parent.add(group);
  const back = new Mesh(
    new PlaneGeometry(w, hh),
    new MeshBasicMaterial({ color: opts.color ?? 0x0c1640, transparent: true, opacity: opts.back ?? 0.55, depthWrite: false, side: DoubleSide }),
  );
  back.renderOrder = -1;
  group.add(back);
  const c = [new Vector3(-w / 2, -hh / 2, 0), new Vector3(w / 2, -hh / 2, 0), new Vector3(w / 2, hh / 2, 0), new Vector3(-w / 2, hh / 2, 0)];
  const border = lineSet(group, loopPts(c), COLORS.cyan, 0.8);
  let gridLines: LineSegments | null = null;
  const local = (cx: number, cy: number, W: number, H: number, z = 0) => new Vector3((cx / W - 0.5) * w, (0.5 - cy / H) * hh, z);
  return {
    group,
    w,
    h: hh,
    dist: 0,
    local,
    world: (cx, cy, W, H, z = 0) => toScene(group, local(cx, cy, W, H, z)),
    border,
    back,
    grid(cols, rows, opacity = 0.09) {
      gridLines?.removeFromParent();
      gridLines?.geometry.dispose();
      const pts: Vector3[] = [];
      for (let x = 1; x < cols; x++) pts.push(local(x, 0, cols, rows, 0.001), local(x, rows, cols, rows, 0.001));
      for (let y = 1; y < rows; y++) pts.push(local(0, y, cols, rows, 0.001), local(cols, y, cols, rows, 0.001));
      gridLines = lineSet(group, pts, 0x8ca0ff, opacity);
      return gridLines;
    },
    tiles(cols, rows, n, color = COLORS.amber, opacity = 0.5) {
      const pts: Vector3[] = [];
      for (let x = n; x < cols; x += n) pts.push(local(x, 0, cols, rows, 0.002), local(x, rows, cols, rows, 0.002));
      for (let y = n; y < rows; y += n) pts.push(local(0, y, cols, rows, 0.002), local(cols, y, cols, rows, 0.002));
      return lineSet(group, pts, color, opacity);
    },
  };
}

/**
 * The framebuffer as a plane `dist` units in front of the CPU pipeline's camera, exactly
 * filling its view frustum – so every pixel of a data render sits on the view ray through it.
 */
export function projectionRig(ms: ModelStage, dist = 1.8, opts: { frustum?: boolean; back?: number } = {}): Rig {
  const hh = 2 * dist * CAM.tan;
  const w = hh * RT_ASPECT;
  const rig = planeRig(ms.scene, w, hh, opts);
  rig.dist = dist;
  rig.group.position.copy(CAM.eye).addScaledVector(CAM.back, -dist);
  rig.group.quaternion.setFromRotationMatrix(new Matrix4().makeBasis(CAM.right, CAM.up, CAM.back));
  rig.group.updateMatrix();
  if (opts.frustum !== false) {
    // The frustum edges, converging towards the camera (which sits behind the viewer).
    const eyeL = new Vector3(0, 0, dist);
    const c = [rig.local(0, 0, 1, 1), rig.local(1, 0, 1, 1), rig.local(1, 1, 1, 1), rig.local(0, 1, 1, 1)];
    lineSet(rig.group, c.flatMap((p) => [p, p.clone().lerp(eyeL, 0.42)]), COLORS.cyan, 0.22);
  }
  return rig;
}

/**
 * A magnifier in front of a framebuffer plane: a crop (x0, y0, cols × rows pixels of a W×H
 * target) shown big, with connector lines from the crop's footprint on the main plane.
 */
export function lensRig(rig: Rig, width: number, at: Vector3): Rig & { connect(x0: number, y0: number, cols: number, rows: number, W: number, H: number): void; links: LineSegments; foot: LineSegments } {
  const lens = planeRig(rig.group, width, width / RT_ASPECT, { back: 0.82, color: 0x070b22 }) as Rig & {
    connect(x0: number, y0: number, cols: number, rows: number, W: number, H: number): void;
    links: LineSegments;
    foot: LineSegments;
  };
  lens.group.position.copy(at);
  lens.links = lineSet(rig.group, [], 0xffffff, 0.35);
  lens.foot = lineSet(rig.group, [], 0xffffff, 0.8);
  lens.connect = (x0, y0, cols, rows, W, H) => {
    const foot = [rig.local(x0, y0, W, H, 0.004), rig.local(x0 + cols, y0, W, H, 0.004), rig.local(x0 + cols, y0 + rows, W, H, 0.004), rig.local(x0, y0 + rows, W, H, 0.004)];
    const corners = [lens.local(0, 0, 1, 1), lens.local(1, 0, 1, 1), lens.local(1, 1, 1, 1), lens.local(0, 1, 1, 1)].map((v) => v.add(at));
    setLines(lens.foot, loopPts(foot));
    setLines(lens.links, foot.flatMap((f, i) => [f, corners[i]]));
  };
  return lens;
}

export interface Cell {
  x: number;
  y: number;
  /** Color (linear 0..1). */
  c: readonly number[];
  /** When the cell pops up (in progress units, 0..1). */
  t: number;
  /** 1 = a rejected test: a brief red flash that disappears again. */
  kind?: number;
  /** Optional later color change (e.g. a nearer triangle overwrites the pixel). */
  c2?: readonly number[];
  t2?: number;
}

export interface CellField {
  mesh: Mesh;
  material: ShaderMaterial;
  /** Progress 0..1(+) – cells with t < p are up. */
  set(p: number): void;
}

const CELL_VERT = /* glsl */ `
attribute vec2 aCell;
attribute vec3 aColor;
attribute vec3 aColor2;
attribute float aT;
attribute float aT2;
attribute float aKind;
uniform vec2 uGrid;
uniform vec2 uSize;
uniform float uP;
uniform float uPop;
uniform float uHeight;
uniform float uInset;
varying vec3 vColor;
varying float vFlash;
varying float vShade;
void main() {
  float s = clamp((uP - aT) / uPop, 0.0, 1.0);
  float s2 = clamp((uP - aT2) / uPop, 0.0, 1.0);
  float vis = aKind > 0.5 ? step(0.0001, s) * step(s, 0.9999) : step(0.0001, s);
  float hgt = aKind > 0.5 ? 0.18 : s + sin(s * 3.14159) * 0.9 + sin(s2 * 3.14159) * 0.7;
  vec2 c = vec2((aCell.x + 0.5) / uGrid.x - 0.5, 0.5 - (aCell.y + 0.5) / uGrid.y) * uSize;
  vec3 p = position * vec3(uSize / uGrid * uInset * vis, max(hgt * uHeight, 0.0004) * vis);
  p.xy += c;
  vColor = s2 > 0.0 ? aColor2 : aColor;
  vFlash = aKind > 0.5 ? 0.0 : max(1.0 - s, s2 > 0.0 ? 1.0 - s2 : 0.0) * vis;
  vShade = normal.z > 0.5 ? 1.0 : 0.6;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;
const CELL_FRAG = /* glsl */ `
uniform float uGlow;
uniform float uOpacity;
varying vec3 vColor;
varying float vFlash;
varying float vShade;
void main() {
  gl_FragColor = vec4(vColor * vShade + vec3(0.9, 0.97, 1.0) * vFlash * uGlow, uOpacity);
}
`;

let cellBox: BoxGeometry | null = null;
const unitBox = () => {
  if (!cellBox) {
    cellBox = new BoxGeometry(1, 1, 1);
    cellBox.translate(0, 0, 0.5);
  }
  return cellBox;
};

/** Pixel cells on a rig plane that pop up (with a white flash) when the progress passes their time. */
export function cellField(
  rig: Rig,
  cols: number,
  rows: number,
  cells: Cell[],
  o: { height?: number; pop?: number; inset?: number; glow?: number; opacity?: number } = {},
): CellField {
  const n = Math.max(1, cells.length);
  const box = unitBox();
  const g = new InstancedBufferGeometry();
  g.index = box.index;
  g.setAttribute('position', box.getAttribute('position'));
  g.setAttribute('normal', box.getAttribute('normal'));
  const aCell = new Float32Array(n * 2);
  const aColor = new Float32Array(n * 3);
  const aColor2 = new Float32Array(n * 3);
  const aT = new Float32Array(n).fill(9);
  const aT2 = new Float32Array(n).fill(9);
  const aKind = new Float32Array(n);
  cells.forEach((c, i) => {
    aCell[i * 2] = c.x;
    aCell[i * 2 + 1] = c.y;
    aColor.set(c.c.slice(0, 3), i * 3);
    aColor2.set((c.c2 ?? c.c).slice(0, 3), i * 3);
    aT[i] = c.t;
    aT2[i] = c.t2 ?? 9;
    aKind[i] = c.kind ?? 0;
  });
  g.setAttribute('aCell', new InstancedBufferAttribute(aCell, 2));
  g.setAttribute('aColor', new InstancedBufferAttribute(aColor, 3));
  g.setAttribute('aColor2', new InstancedBufferAttribute(aColor2, 3));
  g.setAttribute('aT', new InstancedBufferAttribute(aT, 1));
  g.setAttribute('aT2', new InstancedBufferAttribute(aT2, 1));
  g.setAttribute('aKind', new InstancedBufferAttribute(aKind, 1));
  g.instanceCount = cells.length;
  const cellW = rig.w / cols;
  const material = new ShaderMaterial({
    vertexShader: CELL_VERT,
    fragmentShader: CELL_FRAG,
    transparent: (o.opacity ?? 1) < 1,
    uniforms: {
      uGrid: { value: [cols, rows] },
      uSize: { value: [rig.w, rig.h] },
      uP: { value: 0 },
      uPop: { value: o.pop ?? 0.08 },
      uHeight: { value: (o.height ?? 0.9) * cellW },
      uInset: { value: o.inset ?? 0.84 },
      uGlow: { value: o.glow ?? 1 },
      uOpacity: { value: o.opacity ?? 1 },
    },
  });
  const mesh = new Mesh(g, material);
  mesh.frustumCulled = false;
  rig.group.add(mesh);
  return {
    mesh,
    material,
    set(p) {
      material.uniforms.uP.value = p;
    },
  };
}

/** Per-triangle colors on the model, drawing only triangles < uDraw – matches the cell colors. */
export function triangleIdMesh(ms: ModelStage): Mesh & { material: ShaderMaterial } {
  const mat = new ShaderMaterial({
    uniforms: {
      uDraw: { value: 1e9 },
      uFlashN: { value: Math.max(1, ms.ctx.state.mesh.triangleCount * 0.03) },
      uLight: { value: ms.material.uniforms.uLightDir.value },
    },
    vertexShader: /* glsl */ `
      attribute float aTri;
      varying float vTri;
      varying vec3 vN;
      void main() {
        vTri = aTri;
        vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uDraw;
      uniform float uFlashN;
      uniform vec3 uLight;
      varying float vTri;
      varying vec3 vN;
      vec3 hsl2rgb(float h, float s, float l) {
        vec3 k = mod(vec3(0.0, 8.0, 4.0) + h / 30.0, 12.0);
        float a = s * min(l, 1.0 - l);
        return l - a * clamp(min(k - 3.0, 9.0 - k), -1.0, 1.0);
      }
      void main() {
        if (vTri >= uDraw) discard;
        vec3 c = pow(hsl2rgb(mod(vTri * 137.508, 360.0), 0.85, 0.58), vec3(2.2));
        float l = 0.5 + 0.5 * max(dot(normalize(vN), uLight), 0.0);
        float fresh = smoothstep(uDraw - uFlashN, uDraw, vTri);
        gl_FragColor = vec4(mix(c * l, vec3(1.0), fresh * 0.7), 1.0);
      }`,
  });
  const m = new Mesh(ms.layers.solid.geometry, mat) as unknown as Mesh & { material: ShaderMaterial };
  m.visible = false;
  ms.pivot.add(m);
  return m;
}

/** The showcase triangle with pure R/G/B corners – the GPU interpolates them perspective-correctly, like b0 b1 b2. */
export function baryTriangle(ms: ModelStage, tri: number): Mesh {
  const [a, b, c] = ms.ctx.derived.triangleVertices(tri);
  const P = [a, b, c].map((i) => new Vector3(...ms.ctx.derived.position(i)));
  const n = P[1].clone().sub(P[0]).cross(P[2].clone().sub(P[0])).normalize().multiplyScalar(0.004);
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(P.flatMap((p) => [p.x + n.x, p.y + n.y, p.z + n.z])), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), 3));
  const m = new Mesh(g, new MeshBasicMaterial({ vertexColors: true, side: DoubleSide }));
  m.visible = false;
  ms.pivot.add(m);
  return m;
}

/** First and final owner of every pixel when all triangles of a render are rasterized in order. */
export function coverage(r: RenderResult) {
  const W = r.width;
  const H = r.height;
  const first = new Int32Array(W * H).fill(-1);
  const owner = new Int32Array(W * H).fill(-1);
  const zb = new Float32Array(W * H).fill(2);
  const perPixel = new Uint16Array(W * H);
  const tiles = new Set<number>();
  let fragments = 0;
  let rasterized = 0;
  for (const info of r.triangles) {
    if (!info.screen.length) continue;
    rasterized++;
    for (const s of info.screen)
      for (const f of rasterizeTriangle(s, W, H, info.index)) {
        const p = f.y * W + f.x;
        fragments++;
        perPixel[p]++;
        tiles.add((f.y >> 3) * 1000 + (f.x >> 3));
        if (first[p] < 0) first[p] = f.tri;
        if (f.z < zb[p]) {
          zb[p] = f.z;
          owner[p] = f.tri;
        }
      }
  }
  let covered = 0;
  for (let p = 0; p < W * H; p++) if (first[p] >= 0) covered++;
  return { first, owner, perPixel, fragments, rasterized, covered, tiles: tiles.size };
}

/** Axis arrows at the window origin of the API (GL: bottom-left, y up; Vulkan/D3D12: top-left, y down). */
function windowAxes(rig: Rig, api: ApiId): Group {
  const g = new Group();
  const yUp = api === 'opengl';
  const o = new Vector3(-rig.w / 2, yUp ? -rig.h / 2 : rig.h / 2, 0.01);
  const len = rig.h * 0.32;
  g.add(new ArrowHelper(new Vector3(1, 0, 0), o, len, COLORS.amber, len * 0.18, len * 0.1));
  g.add(new ArrowHelper(new Vector3(0, yUp ? 1 : -1, 0), o, len, COLORS.amber, len * 0.18, len * 0.1));
  const lx = label('x', 'amber');
  lx.position.copy(o).add(new Vector3(len * 1.12, 0, 0));
  const ly = label('y', 'amber');
  ly.position.copy(o).add(new Vector3(0, (yUp ? 1 : -1) * len * 1.12, 0));
  const lo = label('(0, 0)', 'amber');
  lo.position.copy(o).add(new Vector3(-0.05, yUp ? -0.09 : 0.09, 0));
  g.add(lx, ly, lo);
  rig.group.add(g);
  return g;
}

function bboxOf(v: Tri, W: number, H: number) {
  const minX = Math.max(0, Math.floor(Math.min(v[0].x, v[1].x, v[2].x)));
  const maxX = Math.min(W - 1, Math.ceil(Math.max(v[0].x, v[1].x, v[2].x)));
  const minY = Math.max(0, Math.floor(Math.min(v[0].y, v[1].y, v[2].y)));
  const maxY = Math.min(H - 1, Math.ceil(Math.max(v[0].y, v[1].y, v[2].y)));
  return { minX, maxX, minY, maxY, w: maxX - minX + 1, h: maxY - minY + 1, count: (maxX - minX + 1) * (maxY - minY + 1) };
}

const rectPts = (rig: Rig, x0: number, y0: number, x1: number, y1: number, W: number, H: number, z = 0.003) =>
  loopPts([rig.local(x0, y0, W, H, z), rig.local(x1, y0, W, H, z), rig.local(x1, y1, W, H, z), rig.local(x0, y1, W, H, z)]);

/** Slide camera for the projection views: from the front-right, so model, plane and rays are all visible. */
export const RIG_EYE: V3 = [2.2, 1.6, 4.4];
const CYAN_L = linRgb([0.22, 0.88, 1]);
/** Where the magnifier floats, in framebuffer-plane coordinates (upper left, towards the viewer). */
const LENS_AT = new Vector3(0.15, -0.5, 0.8);
const LENS_W = 1.15;
const RED_L = linRgb([1, 0.35, 0.43]);

/* ------------------------------------------------------------------ */
/* Real data                                                           */
/* ------------------------------------------------------------------ */
function dataVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const api = ctx.state.api;
  const mesh = ctx.state.mesh;
  const N = mesh.triangleCount;
  const ms = createModelStage(host, ctx, { autoRotate: 0, shift: -0.1, eye: RIG_EYE, bloom: 0.45, bloomThreshold: 0.82, layers: { solid: 1, wire: 0.1 } });
  const z = zoomShowcase(ctx);
  if (!z) {
    ms.panel(t(L('Rasterisering', 'Rasterization')), [h('div.hint', { text: t(L('Ingen synlig triangel.', 'No visible triangle.')) })]);
    return { show() {}, destroy: () => ms.destroy() };
  }

  /* ---------- 3D: the framebuffer plane and the showcase triangle on it ---------- */
  const GW = 80;
  const GH = 50;
  const rig = projectionRig(ms, 1.8);
  rig.grid(GW, GH);
  const fbLabel = label(`${t(L('framebuffer', 'framebuffer'))} · ${GW}×${GH}`, 'cyan');
  fbLabel.position.set(0, rig.h / 2 + 0.1, 0);
  rig.group.add(fbLabel);
  const base = ctx.derived.render(api, 160, 100);
  const g80 = base.triangles[z.tri].screen[0].map((v) => ({ ...v, x: v.x / 2, y: v.y / 2 })) as Tri;
  const frags80 = rasterizeTriangle(g80, GW, GH, z.tri);
  const bb80 = bboxOf(g80, GW, GH);

  ms.pivot.updateMatrix();
  const vids = ctx.derived.triangleVertices(z.tri);
  const vWorld = vids.map((i) => new Vector3(...ctx.derived.position(i)).applyMatrix4(ms.pivot.matrix));
  const vPlane = g80.map((v) => rig.world(v.x, v.y, GW, GH, 0.004));
  const rays = lineSet(ms.scene, [], COLORS.white, 0.75);
  const rayTail = lineSet(ms.scene, [], COLORS.cyan, 0.3);
  const rayP = { p: 1 };
  const updateRays = () => {
    setLines(rays, vWorld.flatMap((a, i) => [a, a.clone().lerp(vPlane[i], rayP.p)]));
    setLines(rayTail, rayP.p >= 1 ? vPlane.flatMap((a) => [a, a.clone().lerp(VIRTUAL_EYE, 0.3)]) : []);
  };
  const outline = lineSet(rig.group, loopPts(g80.map((v) => rig.local(v.x, v.y, GW, GH, 0.006))), COLORS.cyan, 1);
  const bboxLines = lineSet(rig.group, rectPts(rig, bb80.minX, bb80.minY, bb80.maxX + 1, bb80.maxY + 1, GW, GH), COLORS.amber, 0.95);
  const planeDots = g80.map((v, i) => glowDot(rig.group, rig.local(v.x, v.y, GW, GH, 0.01), [0xff5a6e, 0x5cf08f, 0x5aa9ff][i], 0.06));
  const axes = windowAxes(rig, api);
  // Marks are created once and toggled (re-creating them would leave their CSS labels behind).
  const vMarks = ms.markVertices(vids, COLORS.white);
  vMarks.children.forEach((c) => c.scale.setScalar(0.06));

  // The magnifier: the close-up crop (same pixels as the 2D panel), floating in front of the plane.
  const zl = zoomShowcase(ctx, 32, 20) ?? z;
  const lens = lensRig(rig, LENS_W, LENS_AT);
  lens.grid(zl.cols, zl.rows, 0.12);
  lens.connect((zl.x0 * GW) / zl.fullW, (zl.y0 * GH) / zl.fullH, (zl.cols * GW) / zl.fullW, (zl.rows * GH) / zl.fullH, GW, GH);
  const lensLabel = label(t(L(`närbild ${zl.cols}×${zl.rows} @ ${zl.fullW}×${zl.fullH}`, `close-up ${zl.cols}×${zl.rows} @ ${zl.fullW}×${zl.fullH}`)), 'cyan');
  lensLabel.position.set(0, lens.h / 2 + 0.07, 0);
  lens.group.add(lensLabel);
  const LC = zl.cols;
  const LR = zl.rows;
  const bbC = bboxOf(zl.verts, LC, LR);
  const inC = new Set(zl.frags.map((f) => f.y * LC + f.x));
  lineSet(lens.group, loopPts(zl.verts.map((v) => lens.local(v.x, v.y, LC, LR, 0.006))), COLORS.cyan, 1);
  const lensBox = lineSet(lens.group, rectPts(lens, bbC.minX, bbC.minY, bbC.maxX + 1, bbC.maxY + 1, LC, LR, 0.004), COLORS.amber, 0.95);
  zl.verts.forEach((v, i) => {
    const d = glowDot(lens.group, lens.local(v.x, v.y, LC, LR, 0.01), [0xff5a6e, 0x5cf08f, 0x5aa9ff][i], 0.08);
    const l = label(`v${i}`, 'cyan');
    l.position.set(0, 0.06, 0);
    d.add(l);
  });
  // Step 1: every pixel center in the bounding box is tested, in scan order.
  const bbCells: Cell[] = [];
  for (let i = 0; i < bbC.count; i++) {
    const x = bbC.minX + (i % bbC.w);
    const y = bbC.minY + Math.floor(i / bbC.w);
    const inside = inC.has(y * LC + x);
    bbCells.push({ x, y, c: inside ? CYAN_L : RED_L, t: (i / bbC.count) * 0.92, kind: inside ? 0 : 1 });
  }
  const bboxField = cellField(lens, LC, LR, bbCells, { pop: Math.max(0.04, 3 / bbC.count), height: 2.2 });
  const cursor = lineSet(lens.group, [], COLORS.white, 1);
  // Step 2: the covered pixels with their barycentric weights as RGB.
  const baryField = cellField(
    lens,
    LC,
    LR,
    zl.frags.map((f) => ({ x: f.x, y: f.y, c: f.bary, t: Math.random() * 0.55 })),
    { pop: 0.35, height: 2.2 },
  );
  const baryTri = baryTriangle(ms, z.tri);
  // Step 3: the whole mesh, triangle after triangle.
  const full = ctx.derived.render(api, GW, GH);
  const cov = coverage(full);
  const fullCells: Cell[] = [];
  for (let p = 0; p < GW * GH; p++) {
    if (cov.first[p] < 0) continue;
    const a = cov.first[p];
    const b = cov.owner[p];
    fullCells.push({ x: p % GW, y: Math.floor(p / GW), c: linRgb(triColor(a)), t: a / Math.max(1, N), c2: b !== a ? linRgb(triColor(b)) : undefined, t2: b !== a ? b / Math.max(1, N) : undefined });
  }
  const fullField = cellField(rig, GW, GH, fullCells, { pop: 0.05, height: 0.9 });
  const tileLines = rig.tiles(GW, GH, 8);
  const idMesh = triangleIdMesh(ms);

  /* ---------- Panels: numbers + the zoomed 2D close-up ---------- */
  const numbers = ms.panel('', [], {});
  const numHead = numbers.querySelector('.ms-head span')!;
  const numBody = numbers.querySelector('.ms-body')!;
  const canvasHost = h('div.rz-zoom');
  const zoomPanel = ms.panel(t(L(`Närbild · ${z.cols}×${z.rows} av ${z.fullW}×${z.fullH}`, `Close-up · ${z.cols}×${z.rows} of ${z.fullW}×${z.fullH}`)), [canvasHost]);
  const pc = new PixelCanvas(canvasHost, z.cols, z.rows, 8);
  const V = z.verts;
  const sign = z.area < 0 ? -1 : 1;
  const absArea = Math.abs(z.area);
  const bb = bboxOf(V, z.cols, z.rows);
  const { minX, maxX, minY, maxY } = bb;
  const bbW = bb.w;
  const bbCount = bb.count;
  const covered = new Map<number, Fragment>();
  for (const f of z.frags) covered.set(f.y * z.cols + f.x, f);
  // The rasterizer orients the triangle to positive area; its top-left edges, in original vertex names.
  const o = sign < 0 ? [0, 2, 1] : [0, 1, 2];
  const tlEdges = new Set<string>();
  [[o[1], o[2]], [o[2], o[0]], [o[0], o[1]]].forEach(([a, b]) => {
    if (isTopLeft(V[a], V[b])) tlEdges.add([a, b].sort().join(''));
  });
  const center = centerFragment(z);
  const fc = (x: number, y: number) => fragCoord(api, x + z.x0, y + z.y0, z.fullH);
  const edges = (x: number, y: number) => {
    const px = x + 0.5;
    const py = y + 0.5;
    return [edgeFn(V[1], V[2], px, py) * sign, edgeFn(V[2], V[0], px, py) * sign, edgeFn(V[0], V[1], px, py) * sign];
  };
  // 2×2 quads in the full render target (aligned to even coordinates).
  const quads = new Map<string, number>();
  for (const f of z.frags) {
    const k = `${(f.x + z.x0) >> 1},${(f.y + z.y0) >> 1}`;
    quads.set(k, (quads.get(k) ?? 0) + 1);
  }
  const helperLanes = quads.size * 4 - z.frags.length;
  // Step 2 default probe: the fragment where perspective correction matters most.
  let perspProbe = center;
  let maxDiff = -1;
  for (const f of z.frags) {
    const w = edges(f.x, f.y).map((e) => e / absArea);
    const d = Math.abs(w[0] - f.bary[0]) + Math.abs(w[1] - f.bary[1]) + Math.abs(w[2] - f.bary[2]);
    if (d > maxDiff) {
      maxDiff = d;
      perspProbe = f;
    }
  }

  let step = 0;
  let sweep = 1;
  let fill = 1;
  let hover: [number, number] | null = null;
  const prog = { p: 1 };
  let progTween: ReturnType<ModelStage['tween']> | null = null;

  const currentProbe = (): [number, number] | null => {
    if (hover) return hover;
    if (step === 2) return perspProbe ? [perspProbe.x, perspProbe.y] : null;
    if (step === 1 && sweep < 1) {
      const i = Math.min(bbCount - 1, Math.floor(sweep * bbCount));
      return [minX + (i % bbW), minY + Math.floor(i / bbW)];
    }
    return center ? [center.x, center.y] : null;
  };

  const drawCrop = () => {
    pc.clear();
    pc.grid(0.1);
    const { ctx: g } = pc;
    const [bx, by] = pc.px(minX, minY);
    g.save();
    g.setLineDash([6, 5]);
    g.strokeStyle = 'rgba(255,181,71,0.85)';
    g.lineWidth = 1.5;
    g.shadowColor = '#ffb547';
    g.shadowBlur = 8;
    g.strokeRect(bx, by, bbW * pc.cell, (maxY - minY + 1) * pc.cell);
    g.restore();
    if (step === 0) for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) pc.fillCell(x, y, 'rgba(255,181,71,0.07)', 0.06);
    if (step === 1) {
      const tested = Math.floor(sweep * bbCount);
      for (let i = 0; i < tested; i++) {
        const x = minX + (i % bbW);
        const y = minY + Math.floor(i / bbW);
        const f = covered.get(y * z.cols + x);
        const age = (tested - i) / Math.max(8, bbW * 3);
        if (f) pc.fillCell(x, y, age < 1 ? `rgba(${Math.round(255 - 199 * age)},${Math.round(255 - 30 * age)},255,0.9)` : 'rgba(56,225,255,0.55)', 0.08);
        else pc.fillCell(x, y, 'rgba(255,90,110,0.07)', 0.2);
      }
    }
    if (step === 2) {
      const n = Math.floor(fill * z.frags.length);
      for (let i = 0; i < n; i++) {
        const f = z.frags[i];
        pc.fillCell(f.x, f.y, `rgb(${Math.round(f.bary[0] * 255)},${Math.round(f.bary[1] * 255)},${Math.round(f.bary[2] * 255)})`, 0.04);
      }
      if (fill >= 1) {
        // Quads: outline every 2×2 block; uncovered lanes run as helper invocations.
        g.save();
        g.strokeStyle = 'rgba(255,255,255,0.28)';
        g.lineWidth = 1;
        for (const k of quads.keys()) {
          const [qx, qy] = k.split(',').map(Number);
          const lx = qx * 2 - z.x0;
          const ly = qy * 2 - z.y0;
          for (let dy = 0; dy < 2; dy++)
            for (let dx = 0; dx < 2; dx++) {
              const cx = lx + dx;
              const cy = ly + dy;
              if (cx < 0 || cy < 0 || cx >= z.cols || cy >= z.rows || covered.has(cy * z.cols + cx)) continue;
              pc.fillCell(cx, cy, 'rgba(155,123,255,0.22)', 0.18);
            }
          const [px, py] = pc.px(lx, ly);
          g.strokeRect(px + 0.5, py + 0.5, pc.cell * 2 - 1, pc.cell * 2 - 1);
        }
        g.restore();
      }
    }
    pc.triangle(V.map((v) => [v.x, v.y] as [number, number]), '#38e1ff', 'rgba(56,225,255,0.05)', 2, step === 2 ? 6 : 14);
    if (step >= 1) {
      // Top-left edges stay solid; the others are exclusive (dashed overlay).
      g.save();
      [[0, 1], [1, 2], [2, 0]].forEach(([a, b]) => {
        if (tlEdges.has([a, b].sort().join(''))) return;
        const [ax, ay] = pc.px(V[a].x, V[a].y);
        const [bx2, by2] = pc.px(V[b].x, V[b].y);
        g.setLineDash([4, 5]);
        g.strokeStyle = 'rgba(5,6,13,0.9)';
        g.lineWidth = 2.5;
        g.beginPath();
        g.moveTo(ax, ay);
        g.lineTo(bx2, by2);
        g.stroke();
      });
      g.restore();
    }
    V.forEach((v, i) => pc.dot(v.x, v.y, VCOL[i], 4));
    V.forEach((v, i) => {
      const cx = (V[0].x + V[1].x + V[2].x) / 3;
      const cy = (V[0].y + V[1].y + V[2].y) / 3;
      const dx = v.x - cx;
      const dy = v.y - cy;
      const l = Math.hypot(dx, dy) || 1;
      pc.text(`v${i}`, v.x + (dx / l) * 1.8, v.y + (dy / l) * 1.5, VCOL[i], 11, 'center');
    });
    const probe = currentProbe();
    if (probe && step >= 1) {
      const [x, y] = probe;
      const [px, py] = pc.px(x, y);
      g.save();
      g.strokeStyle = '#fff';
      g.shadowColor = '#fff';
      g.shadowBlur = 10;
      g.lineWidth = 2;
      g.strokeRect(px, py, pc.cell, pc.cell);
      g.restore();
      pc.dot(x + 0.5, y + 0.5, '#ffb547', 2.5);
    }
  };

  const row = (k: string, v: string, cls = '') => `<div class="rz-row"><span>${k}</span><b class="${cls}">${v}</b></div>`;
  const coordName = fragCoordName(api);
  const titles = [
    L('Fönsterkoordinater', 'Window coordinates'),
    L('Edge functions', 'Edge functions'),
    L('Barycentriska vikter', 'Barycentric weights'),
    L(`Hela meshen @ ${GW}×${GH}`, `Whole mesh @ ${GW}×${GH}`),
  ];
  const statRow = (items: [string, string, string?][]) => `<div class="stat-row">${items.map(([v, k, c]) => stat(v, k, c ?? '').outerHTML).join('')}</div>`;
  const updateSide = () => {
    const probe = currentProbe();
    numHead.textContent = t(titles[step]);
    let html = '';
    if (step === 0) {
      const vrows = V.map((v, i) => {
        const wy = api === 'opengl' ? z.fullH - (v.y + z.y0) : v.y + z.y0;
        return `<tr><td style="color:${VCOL[i]}">v${i}</td><td>${f2(v.x + z.x0, 1)}</td><td>${f2(wy, 1)}</td><td>${f2(v.z, 3)}</td></tr>`;
      }).join('');
      html = `${statRow([[`${bb80.w}×${bb80.h}`, t(L(`bounding box @ ${GW}×${GH}`, `bounding box @ ${GW}×${GH}`)), 'glow-amber'], [String(frags80.length), t(L('pixlar täcks', 'pixels covered')), 'glow-cyan'], [z.area < 0 ? 'CCW' : 'CW', z.area < 0 ? 'front face' : 'back face']])}
        <table class="rz-table"><thead><tr><th></th><th>x</th><th>y${api === 'opengl' ? ' ↑' : ' ↓'}</th><th>z</th></tr></thead><tbody>${vrows}</tbody></table>
        <p class="rz-note">${t(L(`Hörn i ett ${z.fullW}×${z.fullH}-mål (närbilden). `, `Corners in a ${z.fullW}×${z.fullH} target (the close-up). `))}${t(api === 'opengl' ? L('OpenGL: origo nere till vänster, y uppåt.', 'OpenGL: origin bottom-left, y up.') : L(`${api === 'vulkan' ? 'Vulkan' : 'D3D12'}: origo uppe till vänster, y nedåt.`, `${api === 'vulkan' ? 'Vulkan' : 'D3D12'}: origin top-left, y down.`))}</p>`;
    } else if (step === 1 && probe) {
      const [x, y] = probe;
      const w = edges(x, y);
      const inBox = x >= minX && x <= maxX && y >= minY && y <= maxY;
      const inside = covered.has(y * z.cols + x);
      const [fx, fy] = fc(x, y);
      const tested = Math.min(bbCount, Math.floor(sweep * bbCount));
      let hits = 0;
      for (let i = 0; i < tested; i++) if (covered.has((minY + Math.floor(i / bbW)) * z.cols + minX + (i % bbW))) hits++;
      html = `${statRow([[`${tested} / ${bbCount}`, t(L('testade', 'tested'))], [String(hits), t(L('täckta', 'covered')), 'glow-cyan']])}
        ${row(coordName, `(${f2(fx, 1)}, ${f2(fy, 1)})`)}
        ${w.map((v, i) => row(`w${i} = E(v${(i + 1) % 3}→v${(i + 2) % 3})`, f2(v, 2), v >= 0 ? 'c-idx' : 'rz-neg')).join('')}
        <div class="rz-verdict ${inside ? 'in' : 'out'}">${inside ? t(L('alla ≥ 0 → fragment', 'all ≥ 0 → fragment')) : inBox ? t(L('någon < 0 → utanför', 'one < 0 → outside')) : t(L('utanför bounding box', 'outside bounding box'))}</div>
        <p class="rz-note">${t(L('Streckade kanter är <i>inte</i> top-left: ett pixelcentrum exakt på dem räknas inte.', 'Dashed edges are <i>not</i> top-left: a pixel center exactly on them is not covered.'))}</p>`;
    } else if (step === 2 && probe) {
      const [x, y] = probe;
      const f = covered.get(y * z.cols + x);
      const head = statRow([[String(quads.size), t(L('2×2-quads', '2×2 quads'))], [String(helperLanes), t(L('helper-trådar', 'helper lanes')), 'c-violet']]);
      if (f) {
        const lin = edges(x, y).map((v) => v / absArea);
        html = `${head}${row(coordName, fc(x, y).map((v) => f2(v, 1)).join(', '))}
          <div class="rz-bary"><span></span><span>${t(L('linjär', 'linear'))}</span><span>${t(L('persp.', 'persp.'))}</span>
          ${[0, 1, 2].map((i) => `<span style="color:${VCOL[i]}">b${i}</span><span>${f2(lin[i], 3)}</span><b>${f2(f.bary[i], 3)}</b>`).join('')}</div>
          <div class="rz-swatch" style="background:rgb(${f.bary.map((b) => Math.round(b * 255)).join(',')})"></div>
          ${row(t(L('1/w per hörn', '1/w per vertex')), V.map((v) => f2(v.invW, 3)).join(' '))}`;
      } else html = `${head}<p class="rz-note">${t(L('Peka på en täckt pixel i närbilden.', 'Point at a covered pixel in the close-up.'))}</p>`;
    } else if (step === 3) {
      const est = Math.round((cov.fragments * 1920 * 1080) / (GW * GH));
      html = `${statRow([[cov.fragments.toLocaleString(), t(L('fragment', 'fragments')), 'glow-cyan'], [`${cov.covered}`, t(L(`av ${GW * GH} pixlar`, `of ${GW * GH} pixels`))], [`${cov.tiles}`, t(L(`av ${(GW / 8) * Math.ceil(GH / 8)} tiles`, `of ${(GW / 8) * Math.ceil(GH / 8)} tiles`)), 'glow-amber']])}
        ${row(t(L('trianglar rasteriserade', 'triangles rasterized')), cov.rasterized.toLocaleString())}
        ${row(t(L('överritning (snitt)', 'overdraw (avg)')), cov.covered ? (cov.fragments / cov.covered).toFixed(2) + '×' : '–')}
        ${row(t(L('≈ fragment vid 1920×1080', '≈ fragments at 1920×1080')), est.toLocaleString())}
        <p class="rz-note">${t(L('Trianglarna ritas i indexordning – på modellen och i framebuffern samtidigt. Färg = triangel; en pixel byter färg när en närmare triangel täcker den. Gula linjer = 8×8-tiles.', 'Triangles are drawn in index order – on the model and in the framebuffer at the same time. Color = triangle; a pixel changes color when a nearer triangle covers it. Amber lines = 8×8 tiles.'))}</p>`;
    }
    numBody.innerHTML = html;
  };

  const redraw = () => {
    if (step <= 2) drawCrop();
    updateSide();
  };
  pc.onResize(() => step <= 2 && drawCrop());
  pc.canvas.addEventListener('mousemove', (e) => {
    if (step === 0 || step === 3) return;
    const r = pc.canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - r.left - pc.ox) / pc.cell);
    const y = Math.floor((e.clientY - r.top - pc.oy) / pc.cell);
    const nh: [number, number] | null = x >= 0 && y >= 0 && x < pc.cols && y < pc.rows ? [x, y] : null;
    if (nh?.[0] === hover?.[0] && nh?.[1] === hover?.[1]) return;
    hover = nh;
    redraw();
  });
  pc.canvas.addEventListener('mouseleave', () => {
    hover = null;
    redraw();
  });

  // Scan cursor on the 3D plane (step 1).
  const moveCursor = () => {
    const i = Math.floor((prog.p / 0.92) * bbC.count);
    if (step !== 1 || prog.p >= 1 || i >= bbC.count) return setLines(cursor, []);
    const x = bbC.minX + (i % bbC.w);
    const y = bbC.minY + Math.floor(i / bbC.w);
    setLines(cursor, rectPts(lens, x, y, x + 1, y + 1, LC, LR, 0.05));
  };
  const applyProgress = () => {
    const p = prog.p;
    if (step === 1) {
      sweep = Math.min(1, p / 0.92);
      bboxField.set(p);
      moveCursor();
    } else if (step === 2) {
      fill = Math.min(1, p);
      baryField.set(p);
    } else if (step === 3) {
      fullField.set(p);
      idMesh.material.uniforms.uDraw.value = p * N;
    }
    if (step === 1 || step === 2) drawCrop();
    if (step === 1) updateSide();
  };

  return {
    show(s, animate) {
      progTween?.kill();
      step = s;
      hover = null;
      sweep = 1;
      fill = 1;
      // Scene state for this step.
      outline.visible = s <= 2;
      bboxLines.visible = s <= 1;
      planeDots.forEach((d) => (d.visible = s <= 2));
      rays.visible = rayTail.visible = s <= 2;
      axes.visible = s === 0;
      ms.highlightTriangle(s <= 1 ? z.tri : null, COLORS.cyan);
      vMarks.visible = s <= 2;
      lens.group.visible = lens.links.visible = lens.foot.visible = s <= 2;
      lensBox.visible = s <= 1;
      baryTri.visible = s === 2;
      bboxField.mesh.visible = cursor.visible = s === 1;
      baryField.mesh.visible = s === 2;
      fullField.mesh.visible = tileLines.visible = idMesh.visible = s === 3;
      ms.setLayer('solid', s === 3 ? 0 : 1, 0);
      ms.setLayer('wire', s === 3 ? 0.05 : 0.1, secs(animate, 0.4));
      zoomPanel.style.display = s <= 2 ? '' : 'none';
      canvasHost.classList.toggle('hoverable', s === 1 || s === 2);
      rayP.p = s === 0 && animate ? 0 : 1;
      updateRays();
      if (s === 0 && animate) ms.tween(rayP, { p: 1, duration: secs(animate, 1.1), ease: 'power2.out', onUpdate: updateRays });
      const end = s === 3 ? 1.08 : 1;
      const duration = s === 1 ? Math.min(5, Math.max(2.4, bbCount / 160)) : s === 2 ? 1.2 : Math.min(5, 2.6 + N / 5000);
      prog.p = animate && s >= 1 ? 0 : end;
      applyProgress();
      if (animate && s >= 1) progTween = ms.tween(prog, { p: end, duration: secs(animate, duration), ease: 'none', onUpdate: applyProgress });
      redraw();
    },
    destroy() {
      progTween?.kill();
      pc.destroy();
      ms.destroy();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Concept: the model swings; one triangle is projected and scanned    */
/* into big pixels, live                                               */
/* ------------------------------------------------------------------ */
function conceptVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const api = ctx.state.api;
  const ms = createModelStage(host, ctx, { autoRotate: 0, shift: -0.05, eye: RIG_EYE, bloom: 0.6, bloomThreshold: 0.82, layers: { solid: 1, wire: 0.16 } });
  const CW = 40;
  const CH = 25;
  const rig = projectionRig(ms, 1.8);
  rig.grid(CW, CH, 0.1);
  const tri = ctx.derived.showcaseTriangle(api);
  const vids = ctx.derived.triangleVertices(tri);
  const P = vids.map((i) => new Vector3(...ctx.derived.position(i)));
  const baryTri = baryTriangle(ms, tri);
  const vMarks = ms.markVertices(vids, COLORS.white);
  vMarks.children.forEach((c) => c.scale.setScalar(0.06));
  // The magnifier: a 32×20 crop of a big render target that follows the triangle.
  const LC = 32;
  const LR = 20;
  const sv0 = ctx.derived.render(api, 160, 100).triangles[tri]?.screen[0];
  const bw0 = sv0 ? Math.max(1e-3, Math.max(...sv0.map((v) => v.x)) - Math.min(...sv0.map((v) => v.x))) : 10;
  const bh0 = sv0 ? Math.max(1e-3, Math.max(...sv0.map((v) => v.y)) - Math.min(...sv0.map((v) => v.y))) : 10;
  const kz = Math.max(0.25, Math.min((LC * 0.55) / bw0, (LR * 0.6) / bh0, 40));
  const FW = Math.max(64, Math.round((160 * kz) / 8) * 8);
  const FH = (FW * 5) / 8;
  const lens = lensRig(rig, LENS_W, LENS_AT);
  lens.grid(LC, LR, 0.12);
  const lensLabel = label(t(L(`närbild ${LC}×${LR} @ ${FW}×${Math.round(FH)}`, `close-up ${LC}×${LR} @ ${FW}×${Math.round(FH)}`)), 'cyan');
  lensLabel.position.set(0, lens.h / 2 + 0.07, 0);
  lens.group.add(lensLabel);

  // Live pixel cells (instanced boxes, rebuilt every frame for the one triangle).
  const live = new InstancedMesh(unitBox(), new MeshBasicMaterial({ color: 0xffffff }), LC * LR);
  live.instanceMatrix.setUsage(DynamicDrawUsage);
  live.count = 0;
  live.frustumCulled = false;
  lens.group.add(live);
  const outline = lineSet(rig.group, [], COLORS.cyan, 1);
  const lensOutline = lineSet(lens.group, [], COLORS.cyan, 1);
  const bboxLines = lineSet(lens.group, [], COLORS.amber, 0.95);
  const rays = lineSet(ms.scene, [], COLORS.white, 0.7);
  const cursor = lineSet(lens.group, [], COLORS.white, 1);
  const quad = lineSet(lens.group, [], COLORS.white, 0.95);
  const beam = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({ color: COLORS.cyan, transparent: true, opacity: 0.18, depthWrite: false, side: DoubleSide }));
  lens.group.add(beam);

  // Step 3: the whole model at 40×25, filled tile by tile "in parallel".
  const r = ctx.derived.render(api, CW, CH);
  const cov = coverage(r);
  const tileIds: number[] = [];
  for (let ty = 0; ty < CH; ty += 8) for (let tx = 0; tx < CW; tx += 8) tileIds.push(ty * 1000 + tx);
  const order = tileIds.map((_, i) => i).sort((a, b) => ((a * 7 + 3) % 11) - ((b * 7 + 3) % 11));
  const rank = new Map(order.map((ti, k) => [tileIds[ti], k]));
  const tileCells: Cell[] = [];
  for (let p = 0; p < CW * CH; p++) {
    if (cov.owner[p] < 0) continue;
    const x = p % CW;
    const y = Math.floor(p / CW);
    const k = rank.get((y - (y % 8)) * 1000 + (x - (x % 8)))!;
    const within = ((y % 8) * 8 + (x % 8)) / 64;
    tileCells.push({ x, y, c: linRgb(triColor(cov.owner[p])), t: (Math.floor(k / 3) * 0.28 + (k % 3) * 0.05 + within * 0.2) * 0.85 });
  }
  const tileField = cellField(rig, CW, CH, tileCells, { pop: 0.06, height: 0.8 });
  const tileLines = rig.tiles(CW, CH, 8, COLORS.amber, 0.7);

  const caption = ms.panel(t(L('Vad händer', 'What happens')), [h('p.rz-capt')], { side: 'bottom' });
  const text = caption.querySelector('.rz-capt')!;
  const captions = [
    L('Triangelns tre hörn projiceras på framebuffern. Bara pixlarna i den gula <b>bounding boxen</b> kan täckas.', 'The triangle\'s three corners are projected onto the framebuffer. Only pixels inside the amber <b>bounding box</b> can be covered.'),
    L('Varje pixelcentrum i boxen testas mot triangelns tre kanter. Inuti → pixeln poppar upp som ett <b>fragment</b>; utanför → rött och bort.', 'Every pixel center in the box is tested against the triangle\'s three edges. Inside → the pixel pops up as a <b>fragment</b>; outside → red, and gone.'),
    L('Varje fragment får vikter (b0, b1, b2) – här rött, grönt och blått, samma färger som hörnen på modellen. Fragment körs i <b>2×2-quads</b>.', 'Each fragment gets weights (b0, b1, b2) – red, green and blue here, the same colors as the corners on the model. Fragments run in <b>2×2 quads</b>.'),
    L('Hela modellen: GPU:n delar skärmen i <b>tiles</b> som fylls parallellt. Med <b>MSAA</b> testas täckning i flera punkter per pixel.', 'The whole model: the GPU splits the screen into <b>tiles</b> that are filled in parallel. With <b>MSAA</b>, coverage is tested at several points per pixel.'),
  ];
  // MSAA close-up (step 3): one edge pixel with the standard 4× pattern.
  const msaaCanvas = h('canvas.rz-msaa', { attrs: { width: 240, height: 120 } });
  const msaaPanel = ms.panel('MSAA 4×', [msaaCanvas], { side: 'right' });
  const drawMsaa = () => {
    const g = msaaCanvas.getContext('2d')!;
    g.clearRect(0, 0, 240, 120);
    const pts = [[-2, -6], [6, -2], [-6, 2], [2, 6]];
    [0, 1].forEach((k) => {
      const ox = 10 + k * 118;
      g.fillStyle = 'rgba(5,6,13,0.9)';
      g.strokeStyle = 'rgba(255,255,255,0.5)';
      g.fillRect(ox, 10, 100, 100);
      g.strokeRect(ox + 0.5, 10.5, 100, 100);
      // The edge: inside is the lower-left half.
      g.save();
      g.beginPath();
      g.rect(ox, 10, 100, 100);
      g.clip();
      g.fillStyle = 'rgba(56,225,255,0.12)';
      g.beginPath();
      g.moveTo(ox, 24);
      g.lineTo(ox + 100, 84);
      g.lineTo(ox + 100, 110);
      g.lineTo(ox, 110);
      g.fill();
      g.strokeStyle = '#38e1ff';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(ox, 24);
      g.lineTo(ox + 100, 84);
      g.stroke();
      g.restore();
      const samples = k === 0 ? [[0, 0]] : pts;
      let inside = 0;
      samples.forEach(([sx, sy]) => {
        const x = ox + 50 + sx * 6.25;
        const y = 60 + sy * 6.25;
        const isIn = y > 24 + ((x - ox) / 100) * 60;
        if (isIn) inside++;
        g.fillStyle = isIn ? '#5cf08f' : '#ff5a6e';
        g.beginPath();
        g.arc(x, y, 5, 0, Math.PI * 2);
        g.fill();
      });
      g.fillStyle = '#e8ebff';
      g.font = '600 11px "JetBrains Mono", monospace';
      g.fillText(k === 0 ? `1× · ${inside}/1` : `4× · ${inside}/4`, ox + 6, 104);
    });
  };
  drawMsaa();

  let step = 0;
  let t0 = 0;
  let now = 0;
  const tmpM = new Matrix4();
  const tmpQ = new Quaternion();
  const tmpS = new Vector3();
  const tmpC = new Color();
  const cellW = lens.w / LC;
  const cellH = lens.h / LR;
  let quadAt = -1;
  let quadPos: [number, number] = [0, 0];
  const setCell = (k: number, x: number, y: number, height: number, col: readonly number[], inset = 0.84) => {
    const p = lens.local(x + 0.5, y + 0.5, LC, LR, 0);
    tmpS.set(cellW * inset, cellH * inset, Math.max(0.0005, height * cellW));
    tmpM.compose(p, tmpQ, tmpS);
    live.setMatrixAt(k, tmpM);
    live.setColorAt(k, tmpC.setRGB(col[0], col[1], col[2]));
  };

  ms.onFrame((time) => {
    now = time;
    const tt = time - t0;
    if (step === 3) {
      const cycle = 4.2;
      tileField.set(((tt % cycle) / cycle) * 1.25);
      return;
    }
    // Swing the model gently so the projection is visibly live.
    ms.pivot.rotation.y = SHOWCASE_ROT_Y + 0.3 * Math.sin(time * 0.45);
    ms.pivot.updateMatrix();
    const W3 = P.map((p) => p.clone().applyMatrix4(ms.pivot.matrix));
    const S40 = W3.map((p) => worldToCanvas(p, CW, CH));
    setLines(outline, loopPts(S40.map(([x, y]) => rig.local(x, y, CW, CH, 0.006))));
    setLines(rays, W3.flatMap((p, i) => [p, rig.world(S40[i][0], S40[i][1], CW, CH, 0.004)]));
    // The same triangle in the big target, cropped around its centroid.
    const SF = W3.map((p) => worldToCanvas(p, FW, FH));
    const x0 = Math.max(0, Math.min(FW - LC, Math.round((SF[0][0] + SF[1][0] + SF[2][0]) / 3 - LC / 2)));
    const y0 = Math.max(0, Math.min(FH - LR, Math.round((SF[0][1] + SF[1][1] + SF[2][1]) / 3 - LR / 2)));
    lens.connect((x0 * CW) / FW, (y0 * CH) / FH, (LC * CW) / FW, (LR * CH) / FH, CW, CH);
    const sv = SF.map(([x, y]) => ({ x: x - x0, y: y - y0, z: 0, invW: 1, attrs: [] })) as unknown as Tri;
    setLines(lensOutline, loopPts(sv.map((v) => lens.local(v.x, v.y, LC, LR, 0.006))));
    const bb = bboxOf(sv, LC, LR);
    setLines(bboxLines, rectPts(lens, bb.minX, bb.minY, bb.maxX + 1, bb.maxY + 1, LC, LR, 0.004));
    const area = edgeFn(sv[0], sv[1], sv[2].x, sv[2].y);
    const bary = (px: number, py: number) => [edgeFn(sv[1], sv[2], px, py) / area, edgeFn(sv[2], sv[0], px, py) / area, edgeFn(sv[0], sv[1], px, py) / area];
    let n = 0;
    setLines(cursor, []);
    setLines(quad, []);
    beam.visible = false;
    if (step === 1) {
      const cellT = Math.min(0.06, 3.4 / bb.count);
      const cycle = bb.count * cellT + 1.4;
      const ct = tt % cycle;
      const scanned = Math.floor(ct / cellT);
      for (let i = 0; i < Math.min(scanned, bb.count); i++) {
        const x = bb.minX + (i % bb.w);
        const y = bb.minY + Math.floor(i / bb.w);
        const b = bary(x + 0.5, y + 0.5);
        const age = ct - i * cellT;
        if (b.every((v) => v >= 0)) {
          const s = Math.min(1, age / 0.3);
          const fade = ct > cycle - 0.4 ? (cycle - ct) / 0.4 : 1;
          const k = Math.min(1, age / 0.6);
          setCell(n++, x, y, (s + Math.sin(s * Math.PI) * 0.9) * 2 * fade, [toLinear(1 - 0.78 * k), toLinear(1 - 0.12 * k), 1]);
        } else if (age < 0.35) setCell(n++, x, y, 0.2, RED_L, 0.6);
      }
      if (scanned < bb.count) {
        const x = bb.minX + (scanned % bb.w);
        const y = bb.minY + Math.floor(scanned / bb.w);
        setLines(cursor, rectPts(lens, x, y, x + 1, y + 1, LC, LR, 0.05));
        beam.visible = true;
        beam.scale.set(bb.w * cellW + cellW * 2, cellH * 1.6, 1);
        beam.position.copy(lens.local(bb.minX + bb.w / 2, y + 0.5, LC, LR, 0.002));
      }
    } else if (step === 2) {
      const cells: [number, number][] = [];
      for (let y = bb.minY; y <= bb.maxY; y++)
        for (let x = bb.minX; x <= bb.maxX; x++) {
          const b = bary(x + 0.5, y + 0.5);
          if (!b.every((v) => v >= 0)) continue;
          const wave = 0.8 + 0.2 * Math.sin(tt * 3 - (x + y) * 0.45);
          setCell(n++, x, y, 2, [b[0] * wave, b[1] * wave, b[2] * wave]);
          cells.push([(x + x0) & ~1, (y + y0) & ~1]);
        }
      const qi = Math.floor(tt / 0.8);
      if (qi !== quadAt && cells.length) {
        quadAt = qi;
        quadPos = cells[(qi * 7919) % cells.length];
      }
      if (cells.length) setLines(quad, rectPts(lens, quadPos[0] - x0, quadPos[1] - y0, quadPos[0] - x0 + 2, quadPos[1] - y0 + 2, LC, LR, 0.06));
    }
    live.count = n;
    live.instanceMatrix.needsUpdate = true;
    if (live.instanceColor) live.instanceColor.needsUpdate = true;
  });

  return {
    show(s, animate) {
      step = s;
      t0 = now;
      text.innerHTML = t(captions[s]);
      if (animate) caption.animate([{ opacity: 0.3 }, { opacity: 1 }], { duration: secs(animate, 0.4) * 1000 });
      const tri3 = s <= 2;
      [outline, bboxLines, rays, live, lens.group, lens.links, lens.foot].forEach((o) => (o.visible = tri3));
      bboxLines.visible = s <= 1;
      cursor.visible = s === 1;
      quad.visible = s === 2;
      baryTri.visible = s === 2;
      tileField.mesh.visible = tileLines.visible = s === 3;
      msaaPanel.style.display = s === 3 ? '' : 'none';
      ms.highlightTriangle(s <= 1 ? tri : null, COLORS.cyan);
      vMarks.visible = s <= 2;
      if (s === 3) {
        ms.tween(ms.pivot.rotation, { y: SHOWCASE_ROT_Y, duration: secs(animate, 0.8), ease: 'power2.inOut' });
        if (!animate) ms.pivot.rotation.y = SHOWCASE_ROT_Y;
        tileField.set(0);
      }
      ms.setLayer('wire', s === 3 ? 0.08 : 0.16, secs(animate, 0.4));
    },
    destroy() {
      ms.destroy();
    },
  };
}

/* ------------------------------------------------------------------ */
/* API panels                                                          */
/* ------------------------------------------------------------------ */
function apis(ctx: SlideContext): Record<ApiId, ApiPanelSpec> {
  const n = ctx.state.mesh.indices.length;
  const idx16 = ctx.derived.layout.indexType === 'uint16';
  const gl = `// Rasterizer state is global context state in OpenGL
glViewport(0, 0, width, height);         // NDC → window pixels
glPolygonMode(GL_FRONT_AND_BACK, GL_FILL);  // GL_LINE = wireframe
glEnable(GL_CULL_FACE);
glCullFace(GL_BACK);
glFrontFace(GL_CCW);

// MSAA: a 4× multisampled color target + GL_MULTISAMPLE
glNamedRenderbufferStorageMultisample(msaaRb, 4, GL_RGBA8,
                                      width, height);
glEnable(GL_MULTISAMPLE);                // on by default

glDrawElements(GL_TRIANGLES, ${n}, ${idx16 ? 'GL_UNSIGNED_SHORT' : 'GL_UNSIGNED_INT'}, nullptr);`;
  const vk = `VkPipelineRasterizationStateCreateInfo rs{
    VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO};
rs.depthClampEnable        = VK_FALSE;
rs.rasterizerDiscardEnable = VK_FALSE;
rs.polygonMode = VK_POLYGON_MODE_FILL;  // LINE needs fillModeNonSolid
rs.cullMode    = VK_CULL_MODE_BACK_BIT;
rs.frontFace   = VK_FRONT_FACE_COUNTER_CLOCKWISE;
rs.lineWidth   = 1.0f;

VkPipelineMultisampleStateCreateInfo ms{
    VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO};
ms.rasterizationSamples = VK_SAMPLE_COUNT_4_BIT;  // MSAA 4×
ms.sampleShadingEnable  = VK_FALSE;  // shade once per pixel

pipelineInfo.pRasterizationState = &rs;
pipelineInfo.pMultisampleState   = &ms;
vkCmdDrawIndexed(cmd, ${n}, 1, 0, 0, 0);`;
  const dx = `D3D12_RASTERIZER_DESC rs{};
rs.FillMode              = D3D12_FILL_MODE_SOLID;  // _WIREFRAME
rs.CullMode              = D3D12_CULL_MODE_BACK;
rs.FrontCounterClockwise = TRUE;
rs.DepthClipEnable       = TRUE;
rs.MultisampleEnable     = FALSE;  // line AA mode only
rs.ConservativeRaster    =
    D3D12_CONSERVATIVE_RASTERIZATION_MODE_OFF;

D3D12_GRAPHICS_PIPELINE_STATE_DESC pso{};
pso.RasterizerState = rs;
pso.SampleDesc      = { 4, 0 };   // Count = 4 → MSAA 4×
pso.SampleMask      = UINT_MAX;
// the render target must use the same SampleDesc

cmd->DrawIndexedInstanced(${n}, 1, 0, 0, 0);`;
  return {
    opengl: {
      note: L(
        'Rasteriseringen är fast funktion – du styr den bara via tillstånd. I OpenGL är det globalt kontexttillstånd som gäller för nästa draw call.',
        'Rasterization is fixed function – you only steer it through state. In OpenGL that is global context state, applied to the next draw call.',
      ),
      code: [{ lang: 'cpp', src: gl, highlight: [[2], [3, 4, 5, 6], [13], [8, 9, 10, 11]] }],
      terms: [
        { term: 'fragment', desc: L('En täckt pixel (eller sample) med interpolerade attribut – kandidat till en pixel.', 'A covered pixel (or sample) with interpolated attributes – a candidate pixel.') },
        { term: 'gl_FragCoord', desc: L('Pixelcentrum i fönsterkoordinater, origo nere till vänster: (x+0.5, y+0.5).', 'Pixel center in window coordinates, origin bottom-left: (x+0.5, y+0.5).') },
        { term: 'GL_MULTISAMPLE', desc: L('Aktiverar MSAA när framebuffern har flera samples per pixel.', 'Enables MSAA when the framebuffer has several samples per pixel.') },
        { term: 'top-left rule', desc: L('D3D kräver den; GL och Vulkan kräver bara att delade kanter ritas exakt en gång – i praktiken används samma regel.', 'D3D mandates it; GL and Vulkan only require shared edges to be hit exactly once – in practice GPUs use the same rule.') },
      ],
      you: L('väljer fill/cull/MSAA', 'choose fill/cull/MSAA'),
      driver: L('GPU:n täcker pixlar', 'the GPU covers pixels'),
    },
    vulkan: {
      note: L(
        'I Vulkan bakas rasteriserings- och multisample-tillståndet in i pipelinen (vissa delar kan göras dynamiska, t.ex. cullMode med VK_DYNAMIC_STATE_CULL_MODE).',
        'In Vulkan, rasterization and multisample state are baked into the pipeline (some parts can be dynamic, e.g. cullMode with VK_DYNAMIC_STATE_CULL_MODE).',
      ),
      code: [{ lang: 'cpp', src: vk, highlight: [[1, 2, 3, 4], [5, 6, 7], [15, 17], [10, 11, 12, 13, 16]] }],
      terms: [
        { term: 'fragment', desc: L('En täckt pixel (eller sample) med interpolerade attribut.', 'A covered pixel (or sample) with interpolated attributes.') },
        { term: 'rasterizationSamples', desc: L('Antal samples per pixel; måste matcha attachmentens VkImage.', 'Samples per pixel; must match the attachment\'s VkImage.') },
        { term: 'sampleShadingEnable', desc: L('Kör fragment shadern per sample istället för per pixel (dyrare, skarpare).', 'Runs the fragment shader per sample instead of per pixel (costlier, sharper).') },
        { term: 'helper invocation', desc: L('Fragment shader-tråd i en 2×2-quad som inte täcks – körs bara för derivator.', 'Fragment shader lane in a 2×2 quad that is not covered – runs only for derivatives.') },
      ],
      you: L('fyller i pipeline-structs', 'fill in pipeline structs'),
      driver: L('GPU:n täcker pixlar', 'the GPU covers pixels'),
    },
    d3d12: {
      note: L(
        'I D3D12 ligger rasterizer-tillståndet i PSO:n. MSAA styrs av SampleDesc i PSO:n och render targeten – MultisampleEnable påverkar bara linjer.',
        'In D3D12 the rasterizer state lives in the PSO. MSAA is set by SampleDesc in the PSO and the render target – MultisampleEnable only affects lines.',
      ),
      code: [{ lang: 'cpp', src: dx, highlight: [[1, 10, 11], [2, 3, 4], [11, 16], [6, 12, 13, 14]] }],
      terms: [
        { term: 'SV_Position', desc: L('I pixel shadern: pixelcentrum (x+0.5, y+0.5), origo uppe till vänster.', 'In the pixel shader: pixel center (x+0.5, y+0.5), origin top-left.') },
        { term: 'top-left rule', desc: L('Ett pixelcentrum exakt på en kant täcks bara om kanten är en top- eller left-kant.', 'A pixel center exactly on an edge is covered only if it is a top or left edge.') },
        { term: 'SampleDesc', desc: L('Count = samples per pixel, Quality = leverantörsspecifik kvalitetsnivå.', 'Count = samples per pixel, Quality = vendor-specific quality level.') },
        { term: 'ConservativeRaster', desc: L('Täck varje pixel som triangeln rör vid alls – används för voxelisering m.m.', 'Cover every pixel the triangle touches at all – used for voxelization etc.') },
      ],
      you: L('fyller i PSO:n', 'fill in the PSO'),
      driver: L('GPU:n täcker pixlar', 'the GPU covers pixels'),
    },
  };
}

export default standardSlide({
  id: 'rasterization',
  group: 'gpu-fixed',
  short: L('Rasterisering', 'Rasterization'),
  title: L('Rasterisering – från triangel till fragment', 'Rasterization – from triangle to fragments'),
  lead: L(
    'Rasteriseraren tar reda på vilka pixlar en triangel täcker. Varje täckt pixel blir ett <b>fragment</b> med interpolerade attribut – inmatningen till fragment shadern.',
    'The rasterizer works out which pixels a triangle covers. Every covered pixel becomes a <b>fragment</b> with interpolated attributes – the input to the fragment shader.',
  ),
  bullets: [
    L(
      'Hörnen har nu <b>fönsterkoordinater</b> i pixlar. Bara pixlarna i triangelns <b>bounding box</b> behöver testas.',
      'The corners now have <b>window coordinates</b> in pixels. Only pixels inside the triangle\'s <b>bounding box</b> need testing.',
    ),
    L(
      'Varje pixelcentrum testas med tre <b>edge functions</b> w0, w1, w2. Alla ≥ 0 → täckt. Ligger centrum exakt på en kant avgör <b>top-left-regeln</b>, så delade kanter ritas exakt en gång.',
      'Each pixel center is tested with three <b>edge functions</b> w0, w1, w2. All ≥ 0 → covered. A center exactly on an edge is settled by the <b>top-left rule</b>, so shared edges are drawn exactly once.',
    ),
    L(
      'w / area ger <b>barycentriska vikter</b>, gjorda <b>perspektivkorrekta</b> via 1/w. Här är RGB = (b0, b1, b2). Fragment körs i <b>2×2-quads</b> för derivator (mipmapping).',
      'w / area gives <b>barycentric weights</b>, made <b>perspective-correct</b> via 1/w. Here RGB = (b0, b1, b2). Fragments run in <b>2×2 quads</b> for derivatives (mipmapping).',
    ),
    L(
      'Hela meshen: hårdvaran rasteriserar <b>tiles</b> parallellt. Med <b>MSAA</b> testas täckning i flera samples per pixel, men shadern körs oftast en gång per pixel.',
      'The whole mesh: hardware rasterizes <b>tiles</b> in parallel. With <b>MSAA</b>, coverage is tested at several samples per pixel, but the shader usually runs once per pixel.',
    ),
  ],
  api: apis,
  data: dataVisual,
  concept: conceptVisual,
});
