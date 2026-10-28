import gsap from 'gsap';
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  LineBasicMaterial,
  LineLoop,
  LineSegments,
  Matrix4,
  Mesh,
  Points,
  PointsMaterial,
  Vector3,
} from 'three';
import type { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import '../styles/slides/clipping.css';
import { SHOWCASE_ROT_X, SHOWCASE_ROT_Y } from '../core/derived';
import { dur, h, num } from '../core/dom';
import { L, type Text } from '../core/i18n';
import type { ApiId } from '../core/state';
import type { MeshData } from '../model/types';
import { clipPlanes, clipPolygon, type ClipVertex } from '../pipeline/clip';
import { DEFAULT_CAMERA, modelMatrix, projectionMatrix, viewMatrix, type Camera, type V4 } from '../pipeline/transform';
import { createModelStage, glowTexture, secs, type ModelStage } from '../views/ModelStage';
import type { PipelineMaterial } from '../views/pipelineMaterial';
import { COLORS, label } from '../views/three-helpers';
import { stat } from '../views/widgets';
import { standardSlide } from './standard';
import type { ApiPanelSpec, SlideContext, Visual } from './types';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
const ASPECT = 1.6;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const hdr = (hex: number, k: number) => new Color(hex).multiplyScalar(k);
const ease = (x: number) => x * x * (3 - 2 * x);
const zRange = (api: ApiId) => (api === 'opengl' ? '−w ≤ z ≤ w' : '0 ≤ z ≤ w');
const PLANE_LABEL = (api: ApiId) => ['−w ≤ x', 'x ≤ w', '−w ≤ y', 'y ≤ w', api === 'opengl' ? '−w ≤ z' : '0 ≤ z', 'z ≤ w'];
const VCOL = ['#38e1ff', '#ff3fd2', '#ffb547', '#5cf08f', '#9b7bff', '#ffffff', '#ff5a6e'];
/** Triangles that only cross x/y planes and stay within ±GB in NDC are not clipped (guard band). */
const GB = 2;

const mulV4 = (m: Matrix4, x: number, y: number, z: number): V4 => {
  const e = m.elements;
  return [e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14], e[3] * x + e[7] * y + e[11] * z + e[15]];
};

/** Shows only the panels of the current step (so the XR panel reads the right stats). */
function stepPanels(list: { el: HTMLElement; steps: number[] }[]) {
  const slots = list.map((p) => p.el.parentElement!);
  return (step: number, animate: boolean) => {
    list.forEach((p, i) => {
      const on = p.steps.includes(step);
      if (!on) p.el.remove();
      else if (!p.el.isConnected) {
        slots[i].append(p.el);
        if (animate) gsap.fromTo(p.el, { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: dur(0.45), ease: 'power2.out' });
      }
    });
    list.forEach((p, i) => p.el.isConnected && slots[i].append(p.el));
  };
}

/* ------------------------------------------------------------------ */
/* Real clipping of the whole mesh for one camera                      */
/* ------------------------------------------------------------------ */
/** Triangle soup with the attributes the pipeline material needs. */
class Soup {
  pos: number[] = [];
  nrm: number[] = [];
  face: number[] = [];
  tri: number[] = [];
  push(p: Vector3, n: Vector3, f: Vector3, t: number) {
    this.pos.push(p.x, p.y, p.z);
    this.nrm.push(n.x, n.y, n.z);
    this.face.push(f.x, f.y, f.z);
    this.tri.push(t);
  }
  get triangles() {
    return this.tri.length / 3;
  }
  geometry(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.nrm), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array((this.pos.length / 3) * 2), 2));
    g.setAttribute('aFaceNormal', new BufferAttribute(new Float32Array(this.face), 3));
    g.setAttribute('aTri', new BufferAttribute(new Float32Array(this.tri), 1));
    return g;
  }
}

interface ClipCase {
  cam: Camera;
  /** Fully inside. */
  inside: Soup;
  /** Clipped polygons (fans) of triangles that need real clipping (near/far, or beyond the guard band). */
  cut: Soup;
  /** Clipped polygons of x/y-only triangles inside the guard band… */
  cutXY: Soup;
  /** …and the same triangles unclipped (what the hardware really rasterizes). */
  fullXY: Soup;
  /** Original triangles that cross a plane or lie outside (the parts that go away). */
  away: Soup;
  fresh: number[];
  edges: number[];
  nInside: number;
  nCrossing: number;
  nOutside: number;
  nOut: number;
  nNew: number;
  nNearFar: number;
  nGuard: number;
  nBeyond: number;
  stride: number;
  example: { tri: number; clip: V4[]; poly: ClipVertex[] } | null;
}

const caseCache = new WeakMap<MeshData, Map<string, ClipCase>>();

function clipCase(mesh: MeshData, api: ApiId, cam: Camera, key: string): ClipCase {
  let per = caseCache.get(mesh);
  if (!per) caseCache.set(mesh, (per = new Map()));
  const k = `${api}:${key}`;
  const hit = per.get(k);
  if (hit) return hit;
  const M = modelMatrix(SHOWCASE_ROT_Y, SHOWCASE_ROT_X);
  const mvp = projectionMatrix(api, cam, ASPECT).multiply(viewMatrix(cam)).multiply(M);
  const vc = mesh.vertexCount;
  const clip = new Float32Array(vc * 4);
  for (let i = 0; i < vc; i++) clip.set(mulV4(mvp, mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]), i * 4);
  const planes = clipPlanes(api);
  const c: ClipCase = {
    cam,
    inside: new Soup(),
    cut: new Soup(),
    cutXY: new Soup(),
    fullXY: new Soup(),
    away: new Soup(),
    fresh: [],
    edges: [],
    nInside: 0,
    nCrossing: 0,
    nOutside: 0,
    nOut: 0,
    nNew: 0,
    nNearFar: 0,
    nGuard: 0,
    nBeyond: 0,
    stride: Math.max(1, Math.ceil(mesh.triangleCount / 300000)),
    example: null,
  };
  const P = mesh.positions;
  const N = mesh.normals;
  const pv = (v: number) => new Vector3(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
  const nv = (v: number) => new Vector3(N[v * 3], N[v * 3 + 1], N[v * 3 + 2]);
  let bestScore = -1;
  const ab = new Vector3();
  const ac = new Vector3();
  for (let t = 0; t < mesh.triangleCount; t += c.stride) {
    const ids = [mesh.indices[t * 3], mesh.indices[t * 3 + 1], mesh.indices[t * 3 + 2]];
    const cp = ids.map((v) => Array.from(clip.subarray(v * 4, v * 4 + 4)) as V4);
    const pts = ids.map(pv);
    const nrm = ids.map(nv);
    const face = ab.subVectors(pts[1], pts[0]).clone().cross(ac.subVectors(pts[2], pts[0])).normalize();
    const pushOrig = (s: Soup) => pts.forEach((p, j) => s.push(p, nrm[j], face, t));
    const allIn = cp.every((p) => planes.every((pl) => pl.dist(p) >= 0));
    if (allIn) {
      c.nInside++;
      c.nOut++;
      pushOrig(c.inside);
      continue;
    }
    const trivial = planes.some((pl) => cp.every((p) => pl.dist(p) < 0));
    const poly = trivial ? [] : clipPolygon(api, cp.map((pos, j) => ({ pos, attrs: [j === 0 ? 1 : 0, j === 1 ? 1 : 0, j === 2 ? 1 : 0] })));
    pushOrig(c.away);
    if (poly.length < 3) {
      c.nOutside++;
      continue;
    }
    c.nCrossing++;
    c.nOut += poly.length - 2;
    // Object-space position and normal of a clipped vertex from its barycentric weights
    // (clip space is linear in object space, so this is exact).
    const at = (v: ClipVertex) => pts[0].clone().multiplyScalar(v.attrs[0]).addScaledVector(pts[1], v.attrs[1]).addScaledVector(pts[2], v.attrs[2]);
    const nat = (v: ClipVertex) => nrm[0].clone().multiplyScalar(v.attrs[0]).addScaledVector(nrm[1], v.attrs[1]).addScaledVector(nrm[2], v.attrs[2]).normalize();
    const nearFar = cp.some((p) => planes[4].dist(p) < 0 || planes[5].dist(p) < 0);
    const allW = cp.every((p) => p[3] > 1e-6);
    const withinGB = allW && cp.every((p) => Math.abs(p[0] / p[3]) <= GB && Math.abs(p[1] / p[3]) <= GB);
    const guard = !nearFar && withinGB;
    if (nearFar) c.nNearFar++;
    else if (guard) c.nGuard++;
    else c.nBeyond++;
    const target = guard ? c.cutXY : c.cut;
    for (let i = 1; i + 1 < poly.length; i++) [poly[0], poly[i], poly[i + 1]].forEach((v) => target.push(at(v), nat(v), face, t));
    if (guard) pushOrig(c.fullXY);
    const fresh = poly.map((v) => Math.max(...v.attrs) < 0.9999);
    poly.forEach((v, i) => {
      if (!fresh[i]) return;
      c.nNew++;
      if (c.fresh.length < 3000 * 3) c.fresh.push(...at(v).toArray());
      const j = (i + 1) % poly.length;
      if (fresh[j] && c.edges.length < 1500 * 6) c.edges.push(...at(v).toArray(), ...at(poly[j]).toArray());
    });
    // An example: a clipped triangle with many corners that is large on screen.
    if (allW) {
      const xs = poly.map((v) => v.pos[0] / v.pos[3]);
      const ys = poly.map((v) => v.pos[1] / v.pos[3]);
      const size = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
      const score = poly.length * 10 + Math.min(size, 0.5) * 20 + (nearFar ? 0 : 4);
      if (score > bestScore) {
        bestScore = score;
        c.example = { tri: t, clip: cp, poly };
      }
    }
  }
  per.set(k, c);
  return c;
}

/* ------------------------------------------------------------------ */
/* The 3D scene shared by both modes                                   */
/* ------------------------------------------------------------------ */
function frustumCorners(cam: Camera, far: number): Vector3[] {
  const eye = new Vector3(...cam.eye);
  const z = eye.clone().sub(new Vector3(...cam.target)).normalize();
  const x = new Vector3(...cam.up).cross(z).normalize();
  const y = z.clone().cross(x);
  const tan = Math.tan((cam.fovY * Math.PI) / 360);
  const out: Vector3[] = [];
  for (const d of [cam.near, far]) {
    for (const [sx, sy] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]) {
      out.push(eye.clone().addScaledVector(z, -d).addScaledVector(x, sx * d * tan * ASPECT).addScaledVector(y, sy * d * tan));
    }
  }
  return out;
}
const EDGES = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];

interface ClipScene {
  ms: ModelStage;
  c: ClipCase;
  /** cut 0..1 (slice + fall away), morph 0..1 (divide → NDC), guard 0..1, cam 0..1 (camera flies in). */
  P: { cut: number; morph: number; guard: number; cam: number; test: number };
  exLabels: CSS2DObject[];
  observer(step: number, animate: boolean): void;
  sparks: boolean;
}

function buildScene(host: HTMLElement, ctx: SlideContext, concept: boolean): ClipScene {
  const api = ctx.state.api;
  const mesh = ctx.state.mesh;
  const cam: Camera = concept
    ? { eye: [0.8, 0.32, 1.45], target: [0.12, 0, 0], up: [0, 1, 0], fovY: 38, near: 1.25, far: 1.95 }
    : { ...DEFAULT_CAMERA, eye: DEFAULT_CAMERA.eye.map((v) => v * 0.3) as [number, number, number] };
  const c = clipCase(mesh, api, cam, concept ? 'concept' : 'zoom');
  const ms = createModelStage(host, ctx, {
    shift: concept ? 0 : -0.17,
    autoRotate: 0,
    bloom: 0.5,
    bloomThreshold: 0.9,
    eye: [2.7, 1.4, 2.2],
    layers: { solid: 0, wire: 0 },
  });
  const tex = glowTexture();
  const zMin = api === 'opengl' ? -1 : 0;
  const BOX = 1.15;
  const V = viewMatrix(cam);
  const Pm = projectionMatrix(api, cam, ASPECT);
  const D = new Matrix4().set(BOX, 0, 0, 0, 0, BOX, 0, 0, 0, 0, -BOX, (BOX * (1 + zMin)) / 2, 0, 0, 0, 1);
  const B = D.clone().multiply(Pm).multiply(V); // world → NDC box (after the GPU's divide by w)
  const M = modelMatrix(SHOWCASE_ROT_Y, SHOWCASE_ROT_X);
  const eye = new Vector3(...cam.eye);
  const camDist = eye.distanceTo(new Vector3(...cam.target));
  const DISP_FAR = Math.min(cam.far, camDist + 1.1);

  const root = new Group();
  root.scale.setScalar(0.9);
  ms.scene.add(root);
  // world → display (mix of identity and the clip-space box; GPU does the divide).
  const disp = new Group();
  disp.matrixAutoUpdate = false;
  root.add(disp);
  const model = new Group(); // model space inside `disp`
  model.matrixAutoUpdate = false;
  model.matrix.copy(M);
  disp.add(model);

  // One pipeline-material clone per set, tinted through the base color.
  const mat = (base: number | null, opts: { side?: boolean; transparent?: boolean } = {}) => {
    const m = ms.material.clone() as PipelineMaterial;
    if (base !== null) m.uniforms.uBaseColor.value = new Color(base);
    m.side = opts.side === false ? m.side : DoubleSide;
    m.uniforms.uBackTint.value = 0.35;
    if (opts.transparent) {
      m.transparent = true;
      m.depthWrite = false;
    }
    return m;
  };
  const mk = (s: Soup, m: PipelineMaterial) => {
    const me = new Mesh(s.geometry(), m);
    me.frustumCulled = false;
    model.add(me);
    return me;
  };
  const insideM = mat(null);
  const cutM = mat(0xffa94d);
  const cutXYM = mat(0xffa94d);
  const fullXYM = mat(0x9b7bff, { transparent: true });
  const awayM = mat(0xff5a6e, { transparent: true });
  mk(c.inside, insideM);
  const mCut = mk(c.cut, cutM);
  const mCutXY = mk(c.cutXY, cutXYM);
  const mFullXY = mk(c.fullXY, fullXYM);
  const mAway = mk(c.away, awayM);
  mAway.renderOrder = 3;
  mFullXY.renderOrder = 4;

  // New vertices on the planes.
  const fg = new BufferGeometry();
  fg.setAttribute('position', new BufferAttribute(new Float32Array(c.fresh.length ? c.fresh : [0, 0, 0]), 3));
  const freshPts = new Points(fg, new PointsMaterial({ size: 0.045, map: tex, color: hdr(COLORS.amber, 2.2), transparent: true, opacity: 0, depthWrite: false, blending: AdditiveBlending }));
  freshPts.frustumCulled = false;
  freshPts.renderOrder = 6;
  model.add(freshPts);

  // Example triangle: outline + labelled corners.
  const ex = c.example;
  const exPts = ex ? ex.clip.map((_, j) => new Vector3(...ctx.derived.position(mesh.indices[ex.tri * 3 + j]))) : [];
  const exLine = new LineLoop(new BufferGeometry().setFromPoints(exPts.length ? exPts : [new Vector3()]), new LineBasicMaterial({ color: hdr(COLORS.magenta, 2.6), transparent: true, depthTest: false }));
  exLine.renderOrder = 8;
  exLine.frustumCulled = false;
  model.add(exLine);
  const exPolyPts = ex ? ex.poly.map((v) => exPts[0].clone().multiplyScalar(v.attrs[0]).addScaledVector(exPts[1], v.attrs[1]).addScaledVector(exPts[2], v.attrs[2])) : [];
  const exPoly = new LineLoop(new BufferGeometry().setFromPoints(exPolyPts.length ? exPolyPts : [new Vector3()]), new LineBasicMaterial({ color: hdr(COLORS.cyan, 2.6), transparent: true, depthTest: false }));
  exPoly.renderOrder = 9;
  exPoly.frustumCulled = false;
  model.add(exPoly);
  const exLabels = exPts.map((_, k) => {
    const lb = label(`v${k}`, 'clip-tag');
    lb.element.style.color = VCOL[k];
    root.add(lb);
    return lb;
  });

  // Frustum (CPU, exact via the same matrix mix).
  const frArr = new Float32Array((EDGES.length + 8) * 3);
  const frGeo = new BufferGeometry();
  frGeo.setAttribute('position', new BufferAttribute(frArr, 3));
  const frMat = new LineBasicMaterial({ color: hdr(COLORS.amber, 1.6), transparent: true, opacity: 0.9, depthWrite: false });
  const frLines = new LineSegments(frGeo, frMat);
  frLines.frustumCulled = false;
  root.add(frLines);
  const camDot = new Points(
    new BufferGeometry().setFromPoints([new Vector3()]),
    new PointsMaterial({ size: 0.16, map: tex, color: hdr(COLORS.amber, 2.4), transparent: true, depthWrite: false, blending: AdditiveBlending }),
  );
  camDot.frustumCulled = false;
  root.add(camDot);
  const tags = {
    cam: label('camera', 'clip-tag amber'),
    near: label('', 'clip-tag amber'),
    far: label('', 'clip-tag amber'),
    y: label('', 'clip-tag'),
    guard: label('guard band', 'clip-tag violet'),
  };
  Object.values(tags).forEach((l) => root.add(l));
  // Guard band frame on the near face of the box.
  const gbZ = (BOX * (1 + zMin)) / 2 - zMin * BOX;
  const gbS = GB * BOX;
  const guard = new LineLoop(
    new BufferGeometry().setFromPoints([new Vector3(-gbS, -gbS, gbZ), new Vector3(gbS, -gbS, gbZ), new Vector3(gbS, gbS, gbZ), new Vector3(-gbS, gbS, gbZ)]),
    new LineBasicMaterial({ color: hdr(COLORS.violet, 1.8), transparent: true, opacity: 0 }),
  );
  root.add(guard);

  // Sparks along the cut edges (world space, root).
  const NS = 360;
  const sPos = new Float32Array(NS * 3);
  const sCol = new Float32Array(NS * 3);
  const sGeo = new BufferGeometry();
  sGeo.setAttribute('position', new BufferAttribute(sPos, 3));
  sGeo.setAttribute('color', new BufferAttribute(sCol, 3));
  const sparkPts = new Points(sGeo, new PointsMaterial({ size: 0.05, map: tex, vertexColors: true, transparent: true, depthWrite: false, blending: AdditiveBlending }));
  sparkPts.frustumCulled = false;
  root.add(sparkPts);
  const spark = Array.from({ length: NS }, () => ({ p: new Vector3(), v: new Vector3(), born: -10, life: 1 }));
  const nEdges = c.edges.length / 6;

  const P = { cut: 0, morph: 0, guard: 0, cam: 1, test: 1 };
  const S: ClipScene = { ms, c, P, exLabels, observer, sparks: false };
  const startEye = new Vector3(...DEFAULT_CAMERA.eye);
  const dm = new Matrix4();
  const tv = new Vector3();
  const dispPoint = (w: Vector3) => tv.copy(w).applyMatrix4(dm);
  const setO = (lb: CSS2DObject, o: number) => {
    lb.element.style.opacity = String(o);
    lb.visible = o > 0.01;
  };
  ms.onFrame((time, dt) => {
    const m = ease(P.morph);
    const I = new Matrix4();
    for (let i = 0; i < 16; i++) dm.elements[i] = I.elements[i] * (1 - m) + B.elements[i] * m;
    disp.matrix.copy(dm);
    disp.matrixWorldNeedsUpdate = true;
    const cut = ease(P.cut);
    // Before the cut, every triangle shows whole: inside normal, crossing/outside tinted.
    insideM.uniforms.uOpacity.value = 1;
    mAway.visible = m < 0.99;
    awayM.uniforms.uOpacity.value = (cut < 1e-3 ? 1 : 0.85 * (1 - cut)) * (1 - m) * P.test;
    awayM.uniforms.uExplode.value = cut * 0.6;
    awayM.uniforms.uSpecW.value = 0.3;
    mCut.visible = mCutXY.visible = cut > 1e-3;
    mFullXY.visible = P.guard > 0.01;
    fullXYM.uniforms.uOpacity.value = 0.7 * P.guard;
    cutXYM.uniforms.uOpacity.value = 1;
    mCutXY.visible = cut > 1e-3 && P.guard < 0.99;
    // Before the test, the crossing/outside triangles look like the rest of the model.
    const tint = P.test;
    awayM.uniforms.uBaseColor.value.set(0xff5a6e).lerp(new Color(insideM.uniforms.uBaseColor.value), 1 - tint);
    (freshPts.material as PointsMaterial).opacity = clamp01(P.cut * 2) * (0.8 + 0.2 * Math.sin(time * 6));
    // Frustum: the camera flies in from the default position.
    const e = startEye.clone().lerp(eye, ease(P.cam));
    const pose: Camera = { ...cam, eye: [e.x, e.y, e.z] };
    const far = DISP_FAR + (cam.far - DISP_FAR) * m;
    const cs = frustumCorners(pose, far);
    EDGES.forEach((ci, k) => frArr.set(dispPoint(cs[ci]).toArray(), k * 3));
    for (let i = 0; i < 4; i++) {
      frArr.set(m < 0.02 ? dispPoint(e).toArray() : dispPoint(cs[i]).toArray(), (EDGES.length + i * 2) * 3);
      frArr.set(dispPoint(cs[i]).toArray(), (EDGES.length + i * 2 + 1) * 3);
    }
    frGeo.attributes.position.needsUpdate = true;
    frMat.opacity = 0.55 + 0.35 * m;
    camDot.visible = m < 0.02;
    if (camDot.visible) camDot.position.copy(e);
    tags.cam.position.copy(e).add(new Vector3(0, 0.14, 0));
    setO(tags.cam, 1 - clamp01(m * 20));
    const zr = api === 'opengl' ? ['−1', '+1'] : ['0', '1'];
    tags.near.element.textContent = m > 0.5 ? `near · z = ${zr[0]}` : `near · ${api === 'opengl' ? '−w ≤ z' : '0 ≤ z'}`;
    tags.far.element.textContent = m > 0.5 ? `far · z = ${zr[1]}` : 'far · z ≤ w';
    tags.near.position.copy(dispPoint(cs[1]));
    tags.far.position.copy(dispPoint(cs[4]));
    setO(tags.near, 1);
    setO(tags.far, cam.far <= DISP_FAR + 1e-6 || m > 0.5 ? 1 : 0.6);
    tags.y.element.textContent = api === 'vulkan' ? '+y ↓ (Vulkan NDC)' : '+y ↑';
    tags.y.position.copy(dispPoint(cs[7]));
    setO(tags.y, m);
    (guard.material as LineBasicMaterial).opacity = P.guard * 0.9;
    tags.guard.position.set(-gbS, gbS + 0.12, gbZ);
    setO(tags.guard, P.guard);
    // Example triangle.
    exLine.visible = !!ex && cut < 0.5 && m < 0.5;
    exPoly.visible = !!ex && cut > 0.3;
    (exLine.material as LineBasicMaterial).opacity = 1 - cut;
    exLabels.forEach((lb, k) => {
      lb.position.copy(tv.copy(exPts[k]).applyMatrix4(M).applyMatrix4(dm)).add(new Vector3(0, 0.07, 0));
      setO(lb, (1 - cut) * (1 - m));
    });
    // Sparks.
    for (let i = 0; i < NS; i++) {
      const s = spark[i];
      let age = time - s.born;
      if (S.sparks && nEdges && age > s.life && Math.random() < dt * 2.5) {
        const k = Math.floor(Math.random() * nEdges) * 6;
        const a = new Vector3(c.edges[k], c.edges[k + 1], c.edges[k + 2]);
        const b = new Vector3(c.edges[k + 3], c.edges[k + 4], c.edges[k + 5]);
        s.p.copy(a.lerp(b, Math.random())).applyMatrix4(M);
        s.v.set(Math.random() - 0.5, Math.random() * 0.6 + 0.1, Math.random() - 0.5).multiplyScalar(0.8);
        s.born = time;
        s.life = 0.4 + Math.random() * 0.7;
        age = 0;
      }
      const k = clamp01(1 - age / s.life) * (1 - m);
      sPos.set(tv.copy(s.p).addScaledVector(s.v, age).add(new Vector3(0, -0.5 * age * age, 0)).toArray(), i * 3);
      const col = hdr(COLORS.amber, 2.2 * k).lerp(hdr(COLORS.white, 2.2 * k), k * k * 0.5);
      sCol.set([col.r, col.g, col.b], i * 3);
    }
    sGeo.attributes.position.needsUpdate = true;
    sGeo.attributes.color.needsUpdate = true;
  });

  function observer(step: number, animate: boolean) {
    // From the side while the frustum slices the model; from the front once it is the NDC box.
    const target = step === 3 ? new Vector3(1.7, 1.1, 5.4) : step === 2 ? new Vector3(1.5, 1.0, 4.2) : concept ? new Vector3(2.9, 1.5, 1.6) : new Vector3(2.8, 1.5, 1.4);
    gsap.killTweensOf(ms.camera.position);
    if (animate) gsap.to(ms.camera.position, { x: target.x, y: target.y, z: target.z, duration: dur(1.4), ease: 'power2.inOut' });
    else ms.camera.position.copy(target);
  }
  return S;
}

const TARGETS = [
  { cut: 0, morph: 0, guard: 0, cam: 1, test: 1 },
  { cut: 1, morph: 0, guard: 0, cam: 1, test: 1 },
  { cut: 1, morph: 1, guard: 0, cam: 1, test: 1 },
  { cut: 1, morph: 1, guard: 1, cam: 1, test: 1 },
];

function animateTo(S: ClipScene, step: number, fwd: boolean) {
  const P = S.P;
  gsap.killTweensOf(P);
  const tg = TARGETS[step];
  if (fwd && step === 0) {
    // The camera moves in close: then the test colors the triangles.
    Object.assign(P, { ...tg, cam: 0, test: 0 });
    gsap.to(P, { cam: 1, duration: dur(1.6), ease: 'power2.inOut' });
    gsap.to(P, { test: 1, duration: dur(0.6), delay: dur(1.5) });
  } else if (fwd && step === 1) gsap.to(P, { cut: 1, duration: dur(1.8), ease: 'power2.inOut', delay: dur(0.2) });
  else if (fwd) gsap.to(P, { ...tg, duration: dur(step === 2 ? 2.2 : 1.2), ease: 'power2.inOut' });
  else Object.assign(P, tg);
  S.sparks = step === 1;
  S.observer(step, fwd);
}

/* ------------------------------------------------------------------ */
/* Real data                                                           */
/* ------------------------------------------------------------------ */
function dataVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const api = ctx.state.api;
  const S = buildScene(host, ctx, false);
  const { ms, c } = S;
  const planes = clipPlanes(api);
  const ex = c.example;
  const camDist = new Vector3(...c.cam.eye).length();
  const sampled = c.stride > 1 ? t(L(` (var ${c.stride}:e triangel)`, ` (every ${c.stride}th triangle)`)) : '';

  // Step 0: the test.
  const labels = PLANE_LABEL(api);
  const testTable = ex
    ? h('table.clip-table', {}, [
        h('thead', {}, [h('tr', {}, [h('th', { text: '' }), h('th', { text: 'clip (x, y, z, w)' }), ...labels.map((l, i) => h(`th${i === 4 ? '.api' : ''}`, { text: l }))])]),
        h(
          'tbody',
          {},
          ex.clip.map((p, k) =>
            h('tr', {}, [
              h('td', {}, [h('span.clip-v', { text: `v${k}`, style: { color: VCOL[k] } })]),
              h('td.mono', { text: p.map((x) => num(x, 2)).join(' ') }),
              ...planes.map((pl) => {
                const d = pl.dist(p);
                return h(`td.mono.${d >= 0 ? 'ok' : 'bad'}`, { text: d >= 0 ? '✓' : '✗', attrs: { title: num(d, 3) } });
              }),
            ]),
          ),
        ),
      ])
    : h('div.hint', { text: t(L('Inget hörn hamnar utanför med den här kameran.', 'No corner ends up outside with this camera.')) });
  const p0 = ms.panel(t(L(`Testet i clip space – kameran på ${camDist.toFixed(2)} avstånd`, `The test in clip space – camera at distance ${camDist.toFixed(2)}`)), [
    h('div.stat-row', {}, [
      stat(c.nInside.toLocaleString(), t(L('helt innanför', 'fully inside')), 'glow-cyan'),
      stat(c.nCrossing.toLocaleString(), t(L('korsar ett plan', 'cross a plane')), 'glow-amber'),
      stat(c.nOutside.toLocaleString(), t(L('helt utanför', 'fully outside')), 'glow-magenta'),
    ]),
    ...(ex ? [h('div.clip-sub', { text: t(L(`Triangel #${ex.tri}:`, `Triangle #${ex.tri}:`)) })] : []),
    testTable,
    h('div.clip-note', {
      html: t(
        L(
          `Testerna görs <b>före</b> divisionen, mot w. ${api === 'opengl' ? 'OpenGL' : api === 'vulkan' ? 'Vulkan' : 'D3D12'}: <code>${zRange(api)}</code>. <span class="r">Rött</span> = utanför minst ett plan${sampled}.`,
          `The tests happen <b>before</b> the divide, against w. ${api === 'opengl' ? 'OpenGL' : api === 'vulkan' ? 'Vulkan' : 'D3D12'}: <code>${zRange(api)}</code>. <span class="r">Red</span> = outside at least one plane${sampled}.`,
        ),
      ),
    }),
  ]);
  // Step 1: clipping.
  const p1 = ms.panel(t(L('Klippning – Sutherland–Hodgman', 'Clipping – Sutherland–Hodgman')), [
    h('div.stat-row', {}, [
      stat(c.nCrossing.toLocaleString(), t(L('klippta', 'clipped')), 'glow-amber'),
      stat(c.nOutside.toLocaleString(), t(L('kastade', 'discarded')), 'glow-magenta'),
      stat(c.nNew.toLocaleString(), t(L('nya vertices', 'new vertices')), 'glow-cyan'),
    ]),
    h('div.clip-note', {
      html: t(
        L(
          `${c.nOut.toLocaleString()} trianglar går vidare. <span class="a">Orange</span> = det som blev kvar av klippta trianglar, prickarna = nya hörn på planen.${ex ? ` Triangel #${ex.tri}: 3 → ${ex.poly.length} hörn → ${ex.poly.length - 2} trianglar (fan).` : ''}`,
          `${c.nOut.toLocaleString()} triangles go on. <span class="a">Orange</span> = what remains of clipped triangles, the dots = new corners on the planes.${ex ? ` Triangle #${ex.tri}: 3 → ${ex.poly.length} corners → ${ex.poly.length - 2} triangles (fan).` : ''}`,
        ),
      ),
    }),
  ]);
  // Step 2: the divide.
  const rows = (ex ? ex.poly : []).slice(0, 6);
  const divTable = h('table.clip-table.div', {}, [
    h('thead', {}, [h('tr', {}, [h('th', { text: '' }), h('th', { text: 'w' }), h('th', { text: 'x / w' }), h('th', { text: 'y / w' }), h('th.api', { text: 'z / w' })])]),
    h(
      'tbody',
      {},
      rows.map((v, k) => {
        const p = v.pos;
        const fresh = Math.max(...v.attrs) < 0.9999;
        return h('tr', {}, [
          h('td', {}, [h('span.clip-v', { text: fresh ? `n${k}` : `v${v.attrs.indexOf(Math.max(...v.attrs))}`, style: { color: fresh ? VCOL[2] : VCOL[v.attrs.indexOf(Math.max(...v.attrs))] } })]),
          h('td.mono.w', { text: num(p[3], 3) }),
          h('td.mono', { html: `<b>${num(p[0] / p[3], 3)}</b>` }),
          h('td.mono', { html: `<b>${num(p[1] / p[3], 3)}</b>` }),
          h('td.mono', { html: `<b>${num(p[2] / p[3], 3)}</b>` }),
        ]);
      }),
    ),
  ]);
  const p2 = ms.panel(t(L('Perspektivdivision → NDC', 'Perspective divide → NDC')), [
    h('div.stat-row', {}, [stat(api === 'opengl' ? '[−1, 1]' : '[0, 1]', t(L('NDC z', 'NDC z')), 'glow-amber'), stat(api === 'vulkan' ? '+y ↓' : '+y ↑', t(L('NDC y', 'NDC y')), 'glow-cyan')]),
    ...(ex ? [h('div.clip-sub', { text: t(L(`Den klippta triangeln #${ex.tri} (n = nytt hörn):`, `The clipped triangle #${ex.tri} (n = new corner):`)) })] : []),
    divTable,
    h('div.clip-note', {
      html: t(
        L(
          `Efter divisionen ligger allt som överlevde i <b>NDC</b>: x, y ∈ [−1, 1], z ∈ ${api === 'opengl' ? '[−1, 1]' : '[0, 1]'}. Frustumet blir en låda – nära saker blir stora. z är inte linjärt i avstånd.`,
          `After the divide everything that survived lies in <b>NDC</b>: x, y ∈ [−1, 1], z ∈ ${api === 'opengl' ? '[−1, 1]' : '[0, 1]'}. The frustum becomes a box – near things get big. z is not linear in distance.`,
        ),
      ),
    }),
  ]);
  // Step 3: guard band.
  const p3 = ms.panel(t(L('Guard band – vad som verkligen klipps', 'Guard band – what really gets clipped')), [
    h('div.stat-row', {}, [
      stat(c.nGuard.toLocaleString(), t(L('bara x/y – rastras direkt', 'x/y only – rasterized as is')), 'glow-violet'),
      stat(c.nNearFar.toLocaleString(), t(L('near/far – klipps', 'near/far – clipped')), 'glow-amber'),
      stat(c.nBeyond.toLocaleString(), t(L(`utanför ±${GB} – klipps`, `beyond ±${GB} – clipped`))),
    ]),
    h('div.clip-note', {
      html: t(
        L(
          `Hårdvaran klipper sällan mot sidoplanen. Trianglar som bara sticker ut i x/y (<span class="v">lila</span>) rasteriseras hela inom ett <b>guard band</b> (här ±${GB} i NDC) och pixlar utanför viewporten kastas. Bara near/far – eller hörn bakom kameran – kräver riktig klippning.`,
          `Hardware rarely clips against the side planes. Triangles that only stick out in x/y (<span class="v">violet</span>) are rasterized whole within a <b>guard band</b> (here ±${GB} in NDC) and pixels outside the viewport are discarded. Only near/far – or corners behind the camera – need real clipping.`,
        ),
      ),
    }),
  ]);
  const showPanels = stepPanels([
    { el: p0, steps: [0] },
    { el: p1, steps: [1] },
    { el: p2, steps: [2] },
    { el: p3, steps: [3] },
  ]);
  let last = -1;
  return {
    show(step, animate) {
      const fwd = animate && step > last;
      last = step;
      showPanels(step, fwd);
      animateTo(S, step, fwd);
      ms.uniform('uDiffuseW', 1, secs(fwd, 0.4));
    },
    destroy() {
      gsap.killTweensOf(S.P);
      gsap.killTweensOf(ms.camera.position);
      ms.destroy();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Concept: a narrow frustum slices the model, then morphs into NDC    */
/* ------------------------------------------------------------------ */
function conceptVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const api = ctx.state.api;
  const S = buildScene(host, ctx, true);
  const { ms } = S;
  const legend = ms.panel(t(L('Färger', 'Colors')), [
    h('div.clipc-legend', {
      html: `<span class="r">■</span> ${t(L('utanför', 'outside'))} <span class="a">■</span> ${t(L('klippt', 'clipped'))} <span class="a">●</span> ${t(L('ny vertex', 'new vertex'))} <span class="v">■</span> guard band`,
    }),
  ], { side: 'top' });
  const capPanel = ms.panel(t(L('Vad händer', 'What happens')), [h('p.clipc-cap')], { side: 'bottom' });
  const cap = capPanel.querySelector('.clipc-cap')!;
  legend.classList.add('clipc-legend-panel');
  const captions: Text[] = [
    L(
      `Synvolymen – frustumet – avgränsas av sex plan. I clip space: −w ≤ x, y ≤ w och <b>${zRange(api)}</b>. <span class="r">Rött</span> ligger utanför minst ett plan.`,
      `The view volume – the frustum – is bounded by six planes. In clip space: −w ≤ x, y ≤ w and <b>${zRange(api)}</b>. <span class="r">Red</span> lies outside at least one plane.`,
    ),
    L(
      'Trianglar som korsar ett plan klipps: delarna utanför skärs bort och <span class="a">nya vertices</span> skapas där kanterna korsar planet. Helt utanför → kastas.',
      'Triangles that cross a plane are clipped: the parts outside are cut away and <span class="a">new vertices</span> are created where edges cross the plane. Fully outside → discarded.',
    ),
    L(
      `Perspektivdivisionen (x/w, y/w, z/w) gör frustumet till NDC-lådan: x, y ∈ [−1, 1], z ∈ ${api === 'opengl' ? '[−1, 1]' : '[0, 1]'}.${api === 'vulkan' ? ' I Vulkan pekar +y nedåt.' : ''} Det som var nära kameran blir stort.`,
      `The perspective divide (x/w, y/w, z/w) turns the frustum into the NDC box: x, y ∈ [−1, 1], z ∈ ${api === 'opengl' ? '[−1, 1]' : '[0, 1]'}.${api === 'vulkan' ? ' In Vulkan +y points down.' : ''} What was near the camera becomes big.`,
    ),
    L(
      'I praktiken: trianglar som bara sticker ut i x/y klipps inte – de rasteriseras hela inom ett <span class="v">guard band</span> och överflödiga pixlar kastas. Near/far klipps på riktigt.',
      'In practice: triangles that only stick out in x/y are not clipped – they are rasterized whole within a <span class="v">guard band</span> and extra pixels are discarded. Near/far are clipped for real.',
    ),
  ];
  let last = -1;
  return {
    show(step, animate) {
      const fwd = animate && step > last;
      last = step;
      cap.innerHTML = t(captions[step]);
      if (fwd) gsap.fromTo(cap, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: dur(0.4) });
      animateTo(S, step, fwd);
    },
    destroy() {
      gsap.killTweensOf(S.P);
      gsap.killTweensOf(ms.camera.position);
      ms.destroy();
    },
  };
}

/* ------------------------------------------------------------------ */
/* API panels                                                          */
/* ------------------------------------------------------------------ */
function apis(ctx: SlideContext): Record<ApiId, ApiPanelSpec> {
  const st = ctx.derived.render(ctx.state.api, 160, 100).stats;
  const statLine = L(
    `Den här modellen i standardvyn: ${st.clipped} klippta, ${st.clippedAway} kastade av ${st.trianglesIn}.`,
    `This model in the default view: ${st.clipped} clipped, ${st.clippedAway} discarded of ${st.trianglesIn}.`,
  );
  const terms = (extra: { term: string; desc: L }[]) => [
    { term: 'clip space', desc: L('Homogena koordinater (x, y, z, w) ut från vertex shadern.', 'Homogeneous coordinates (x, y, z, w) out of the vertex shader.') },
    { term: 'NDC', desc: L('Normalized device coordinates = clip / w.', 'Normalized device coordinates = clip / w.') },
    ...extra,
  ];
  return {
    opengl: {
      note: L(
        `Klippning och division sker automatiskt efter VS. Standard i OpenGL är z ∈ [−w, w]; glClipControl kan byta till [0, w] som i Vulkan/D3D. ${statLine.sv}`,
        `Clipping and the divide happen automatically after the VS. OpenGL's default is z ∈ [−w, w]; glClipControl can switch to [0, w] like Vulkan/D3D. ${statLine.en}`,
      ),
      code: [
        {
          lang: 'cpp',
          src: `// Default: −w ≤ x, y, z ≤ w  →  NDC z in [−1, 1]
glClipControl(GL_LOWER_LEFT, GL_NEGATIVE_ONE_TO_ONE);
// Optional: D3D-style depth, z in [0, w] (better precision)
// glClipControl(GL_LOWER_LEFT, GL_ZERO_TO_ONE);

// Skip near/far clipping, clamp depth instead
glEnable(GL_DEPTH_CLAMP);

// Extra user clip planes, written by the vertex shader
glEnable(GL_CLIP_DISTANCE0);
// GLSL: gl_ClipDistance[0] = dot(worldPos, uPlane);

// The divide is not in your code: GL computes
// ndc = gl_Position.xyz / gl_Position.w`,
          highlight: [[1, 2], [6, 7, 9, 10, 11], [13, 14], [6, 7]],
        },
      ],
      terms: terms([{ term: 'GL_DEPTH_CLAMP', desc: L('Stänger av near/far-klippning; djupet klämms i stället.', 'Disables near/far clipping; depth is clamped instead.') }]),
      you: L('väljer z-konvention och ev. klipplan', 'choose the z convention and any clip planes'),
      driver: L('GPU:n klipper och dividerar', 'the GPU clips and divides'),
    },
    vulkan: {
      note: L(`Vulkan har fast z ∈ [0, w] och +y nedåt i clip space. Klippning sker i hårdvaran; depth clamp är pipeline-tillstånd. ${statLine.sv}`, `Vulkan has a fixed z ∈ [0, w] and +y down in clip space. Clipping is done in hardware; depth clamp is pipeline state. ${statLine.en}`),
      code: [
        {
          lang: 'cpp',
          src: `// Clip volume: −w ≤ x, y ≤ w,  0 ≤ z ≤ w
VkPipelineRasterizationStateCreateInfo rs{
    .sType = VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO,
    .depthClampEnable = VK_FALSE,   // VK_TRUE: clamp instead of clip
    .polygonMode = VK_POLYGON_MODE_FILL,
    .lineWidth = 1.0f,
};
// Near/far clipping separately (VK_EXT_depth_clip_enable):
VkPipelineRasterizationDepthClipStateCreateInfoEXT clip{
    .sType = VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_DEPTH_CLIP_STATE_CREATE_INFO_EXT,
    .depthClipEnable = VK_TRUE,
};
rs.pNext = &clip;
// GLSL: gl_ClipDistance[0] = dot(worldPos, uPlane);
// NDC = gl_Position.xyz / gl_Position.w (fixed function)`,
          highlight: [[1], [4, 8, 9, 10, 11, 13], [14], [4, 8, 10, 11]],
        },
      ],
      terms: terms([{ term: 'depthClampEnable', desc: L('Kläm djup i stället för att klippa (kräver featuren depthClamp).', 'Clamp depth instead of clipping (needs the depthClamp feature).') }]),
      you: L('sätter rasteriseringstillståndet', 'set the rasterization state'),
      driver: L('GPU:n klipper och dividerar', 'the GPU clips and divides'),
    },
    d3d12: {
      note: L(`D3D12 klipper mot 0 ≤ z ≤ w. DepthClipEnable i rasterizer-delen av PSO:n styr near/far-klippningen. ${statLine.sv}`, `D3D12 clips against 0 ≤ z ≤ w. DepthClipEnable in the PSO's rasterizer state controls near/far clipping. ${statLine.en}`),
      code: [
        {
          lang: 'cpp',
          src: `// Clip volume: −w ≤ x, y ≤ w,  0 ≤ z ≤ w
D3D12_RASTERIZER_DESC rs = {};
rs.FillMode        = D3D12_FILL_MODE_SOLID;
rs.CullMode        = D3D12_CULL_MODE_BACK;
rs.DepthClipEnable = TRUE;      // FALSE: clamp z instead of clipping
psoDesc.RasterizerState = rs;

// HLSL user clip planes:
struct VSOut {
    float4 pos  : SV_Position;   // clip space
    float  clip : SV_ClipDistance0;
};
// NDC = SV_Position.xyz / SV_Position.w (fixed function)`,
          highlight: [[1, 10], [5, 9, 10, 11], [13], [5]],
        },
      ],
      terms: terms([{ term: 'SV_ClipDistance', desc: L('Användardefinierade klipplan från VS (< 0 = bort).', 'User-defined clip planes from the VS (< 0 = removed).') }]),
      you: L('sätter DepthClipEnable i PSO:n', 'set DepthClipEnable in the PSO'),
      driver: L('GPU:n klipper och dividerar', 'the GPU clips and divides'),
    },
  };
}

export default standardSlide({
  id: 'clipping',
  group: 'gpu-fixed',
  short: L('Clipping', 'Clipping'),
  title: L('Clipping & perspektivdivision', 'Clipping & perspective divide'),
  lead: L(
    'Allt som hamnar utanför synvolymen ska bort. GPU:n testar varje triangel mot sex plan i clip space, skär av det som sticker ut och delar sedan med w.',
    'Anything outside the view volume must go. The GPU tests every triangle against six planes in clip space, cuts off what sticks out and then divides by w.',
  ),
  bullets: [
    L(
      'Testet görs i <b>clip space</b>, före divisionen: innanför om −w ≤ x, y ≤ w. För z skiljer sig API:erna: OpenGL <code>−w ≤ z ≤ w</code>, Vulkan och D3D12 <code>0 ≤ z ≤ w</code>.',
      'The test happens in <b>clip space</b>, before the divide: inside if −w ≤ x, y ≤ w. For z the APIs differ: OpenGL <code>−w ≤ z ≤ w</code>, Vulkan and D3D12 <code>0 ≤ z ≤ w</code>.',
    ),
    L(
      'Trianglar som korsar ett plan <b>klipps</b> (Sutherland–Hodgman): nya vertices skapas på planet och polygonen delas i trianglar. Helt utanför → kastas.',
      'Triangles that cross a plane are <b>clipped</b> (Sutherland–Hodgman): new vertices are created on the plane and the polygon is split into triangles. Fully outside → discarded.',
    ),
    L(
      '<b>Perspektivdivisionen</b> x/w, y/w, z/w ger normalized device coordinates (NDC). Frustumet blir en låda – långt borta krymper.',
      'The <b>perspective divide</b> x/w, y/w, z/w gives normalized device coordinates (NDC). The frustum becomes a box – far things shrink.',
    ),
    L(
      'I hårdvaran klipps bara near/far på riktigt; för x/y används ett <b>guard band</b> där rasteriseraren helt enkelt kastar pixlar utanför viewporten.',
      'In hardware only near/far are really clipped; for x/y a <b>guard band</b> is used where the rasterizer simply discards pixels outside the viewport.',
    ),
  ],
  api: apis,
  data: dataVisual,
  concept: conceptVisual,
});
