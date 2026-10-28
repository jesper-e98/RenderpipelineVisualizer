import gsap from 'gsap';
import {
  AdditiveBlending,
  ArrowHelper,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  LineBasicMaterial,
  LineSegments,
  Matrix3,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  Sprite,
  SpriteMaterial,
  Vector3,
} from 'three';
import type { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import '../styles/slides/vertex-shader.css';
import { SHOWCASE_ROT_X, SHOWCASE_ROT_Y } from '../core/derived';
import { dur, h, num } from '../core/dom';
import { L, type Text } from '../core/i18n';
import type { ApiId } from '../core/state';
import { DEFAULT_CAMERA, matrices, modelMatrix, projectionMatrix, runVertex, viewMatrix, type Camera } from '../pipeline/transform';
import { createModelStage, glowTexture, secs, type ModelStage } from '../views/ModelStage';
import { COLORS, label } from '../views/three-helpers';
import { matrixEl, stat } from '../views/widgets';
import { standardSlide } from './standard';
import type { ApiPanelSpec, SlideContext, Visual } from './types';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
const ASPECT = 1.6; // the 160 × 100 software render every data slide shares
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const hdr = (hex: number, k: number) => new Color(hex).multiplyScalar(k);
const ease = (x: number) => x * x * (3 - 2 * x);
const vecText = (v: readonly number[], d = 2) => `(${v.map((x) => num(x, d).trim()).join(', ')})`;

/** A column vector styled like the matrix widget. */
function colEl(v: readonly number[], digits = 3, cls = ''): HTMLElement {
  return h(`div.matrix.vs-col${cls ? '.' + cls : ''}`, {}, v.map((x) => h('span', { text: num(x, digits) })));
}

/** 3×3 matrix (normal matrix) in the same style. */
function mat3El(m: Matrix3, digits = 3): HTMLElement {
  const e = m.elements; // column-major
  const vals = [0, 1, 2].flatMap((r) => [e[r], e[r + 3], e[r + 6]]);
  return h('div.matrix.vs-m3', {}, vals.map((x) => h('span', { text: num(x, digits) })));
}

/** Frustum corners (near quad 0–3, far quad 4–7) in world space for a camera pose. */
function frustumCorners(cam: Camera, aspect: number, far: number): Vector3[] {
  const eye = new Vector3(...cam.eye);
  const z = eye.clone().sub(new Vector3(...cam.target)).normalize();
  const x = new Vector3(...cam.up).cross(z).normalize();
  const y = z.clone().cross(x);
  const tan = Math.tan((cam.fovY * Math.PI) / 360);
  const out: Vector3[] = [];
  for (const d of [cam.near, far]) {
    const hy = d * tan;
    const hx = hy * aspect;
    for (const [sx, sy] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]) {
      out.push(eye.clone().addScaledVector(z, -d).addScaledVector(x, sx * hx).addScaledVector(y, sy * hy));
    }
  }
  return out;
}

/** 12 edges of a frustum / box given 8 corners (near 0–3, far 4–7). */
const BOX_EDGES = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];

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

function killStageTweens(ms: ModelStage) {
  Object.values(ms.material.uniforms).forEach((u) => gsap.killTweensOf(u));
  Object.values(ms.layers).forEach((l) => gsap.killTweensOf(l.material));
}

/** A dynamic line set whose points are recomputed on the CPU every frame. */
function lineSet(parent: Group, n: number, color: Color, opacity: number, vertexColors?: Float32Array) {
  const arr = new Float32Array(n * 3);
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(arr, 3));
  if (vertexColors) g.setAttribute('color', new BufferAttribute(vertexColors, 3));
  const mat = new LineBasicMaterial({ color: vertexColors ? 0xffffff : color, vertexColors: !!vertexColors, transparent: true, opacity, depthWrite: false });
  const ls = new LineSegments(g, mat);
  ls.frustumCulled = false;
  parent.add(ls);
  return {
    ls,
    mat,
    set(i: number, v: Vector3) {
      arr[i * 3] = v.x;
      arr[i * 3 + 1] = v.y;
      arr[i * 3 + 2] = v.z;
    },
    done() {
      g.attributes.position.needsUpdate = true;
    },
  };
}

const axisColors = (k: number) => {
  const c = new Float32Array(18);
  [COLORS.red, COLORS.green, COLORS.cyan].forEach((hex, i) => {
    const col = hdr(hex, k);
    c.set([col.r, col.g, col.b, col.r, col.g, col.b], i * 6);
  });
  return c;
};

/* ------------------------------------------------------------------ */
/* One scene for both modes: the model travels object → world → view → clip */
/* ------------------------------------------------------------------ */
interface VsSetup {
  /** Model matrix at progress a (0 = identity, 1 = the real one). */
  model: (a: number) => Matrix4;
  cam: Camera;
  /** Camera pose before it "flies in" (concept). */
  startEye?: Vector3;
  /** World props (concept): pairs of points. */
  props?: { pts: Vector3[]; color: number; opacity: number }[];
}

interface VsScene {
  ms: ModelStage;
  S: { s: number; cam: number; fly: number; nrm: number; obj: number };
  /** Display position (root space) of a model-space point at the current s. */
  vertexAt(p: Vector3): Vector3;
  observer(step: number, animate: boolean): void;
}

function buildScene(host: HTMLElement, ctx: SlideContext, setup: VsSetup, opts: { shift: number; vIdx: number }): VsScene {
  const api = ctx.state.api;
  const ms = createModelStage(host, ctx, {
    shift: opts.shift,
    autoRotate: 0,
    bloom: 0.35,
    bloomThreshold: 0.92,
    eye: [2.4, 1.3, 2.9],
    layers: { solid: 1, wire: 0.1 },
  });
  const tex = glowTexture();
  const cam = setup.cam;
  const V = viewMatrix(cam);
  const P = projectionMatrix(api, cam, ASPECT);
  const camDist = new Vector3(...cam.eye).distanceTo(new Vector3(...cam.target));
  const K = camDist * 0.28; // the view-space scene: model near the middle, camera off to the side
  const zMin = api === 'opengl' ? -1 : 0;
  const BOX = 1.15;
  const vq = new Quaternion().setFromRotationMatrix(V);
  const vt = new Vector3().setFromMatrixPosition(V);
  const D = new Matrix4().set(BOX, 0, 0, 0, 0, BOX, 0, 0, 0, 0, -BOX, (BOX * (1 + zMin)) / 2, 0, 0, 0, 1);
  const A3 = new Matrix4().makeTranslation(0, 0, camDist - K).multiply(V); // view space, centred
  const B3 = D.clone().multiply(P).multiply(V); // clip space shown as the NDC box (after the GPU divide)
  const DISP_FAR = Math.min(cam.far, camDist + 0.5);

  // Everything lives under a scaled root so the whole journey stays within ~±2.5 units.
  const root = new Group();
  root.scale.setScalar(0.78);
  ms.scene.add(root);
  root.add(ms.pivot);
  ms.pivot.matrixAutoUpdate = false;
  Object.values(ms.layers).forEach((l) => (l.frustumCulled = false));

  const S = { s: 0, cam: 0, fly: 1, nrm: 0, obj: 1 };
  const disp = new Matrix4();
  const tmpM = new Matrix4();
  const qI = new Quaternion();
  const q = new Quaternion();
  /** world → display (root space) for the current s. */
  const worldDisp = (s: number, out: Matrix4) => {
    if (s <= 1) return out.identity();
    if (s <= 2) {
      const a2 = ease(clamp01(s - 1));
      q.slerpQuaternions(qI, vq, a2);
      const t = vt.clone().multiplyScalar(a2);
      t.z += (camDist - K) * a2;
      return out.compose(t, q, new Vector3(1, 1, 1));
    }
    const a3 = ease(clamp01(s - 2));
    const ea = A3.elements;
    const eb = B3.elements;
    for (let i = 0; i < 16; i++) out.elements[i] = ea[i] * (1 - a3) + eb[i] * a3;
    return out;
  };

  // Object axes ride with the model (GPU), labels are placed on the CPU.
  const objAxes = new LineSegments(
    new BufferGeometry().setFromPoints([new Vector3(), new Vector3(1.25, 0, 0), new Vector3(), new Vector3(0, 1.25, 0), new Vector3(), new Vector3(0, 0, 1.25)]),
    new LineBasicMaterial({ vertexColors: true, transparent: true, depthTest: false }),
  );
  objAxes.geometry.setAttribute('color', new BufferAttribute(axisColors(1.8), 3));
  objAxes.frustumCulled = false;
  objAxes.renderOrder = 6;
  ms.pivot.add(objAxes);
  const mkLabel = (text: string, cls: string, color?: number) => {
    const lb = label(text, cls);
    if (color !== undefined) lb.element.style.color = '#' + new Color(color).getHexString();
    root.add(lb);
    return lb;
  };
  const AX = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];
  const AXC = [COLORS.red, COLORS.green, COLORS.cyan];
  const objAxisLabels = ['x', 'y', 'z'].map((n, i) => mkLabel(n, 'vs-axis', AXC[i]));
  const objTag = mkLabel('object', 'vs-tag');

  // World axes (and concept props) are transformed on the CPU.
  const worldAxes = lineSet(root, 6, new Color(), 1, axisColors(1.6));
  const worldAxisLabels = ['X', 'Y', 'Z'].map((n, i) => mkLabel(n, 'vs-axis', AXC[i]));
  const worldTag = mkLabel('world', 'vs-tag');
  const props = (setup.props ?? []).map((p) => ({ ...p, set: lineSet(root, p.pts.length, hdr(p.color, 1.3), p.opacity) }));

  // Camera gizmo + frustum.
  const camAxes = lineSet(root, 6, new Color(), 1, axisColors(1.8));
  const camTag = mkLabel('camera', 'vs-tag');
  const frustum = lineSet(root, BOX_EDGES.length + 8, hdr(COLORS.amber, 1.5), 0.8);
  const nearTag = mkLabel('', 'vs-tag amber');
  const farTag = mkLabel('', 'vs-tag amber');
  const yTag = mkLabel('', 'vs-tag');

  // The followed vertex, its position vector and the view ray.
  const p0 = new Vector3(...ctx.derived.position(opts.vIdx));
  const n0 = new Vector3(...ctx.derived.normal(opts.vIdx));
  const vSprite = new Sprite(new SpriteMaterial({ map: tex, color: hdr(COLORS.cyan, 1.35), transparent: true, depthTest: false, blending: AdditiveBlending }));
  vSprite.renderOrder = 20;
  root.add(vSprite);
  const vLabel = mkLabel(`v${opts.vIdx}`, 'cyan big');
  const posLine = lineSet(root, 2, hdr(COLORS.cyan, 1.8), 0);
  const ray = lineSet(root, 2, hdr(COLORS.amber, 2), 0);
  ray.mat.depthTest = false;
  posLine.mat.depthTest = false;
  const arrow = new ArrowHelper(new Vector3(0, 1, 0), new Vector3(), 0.6, COLORS.magenta, 0.14, 0.08);
  (arrow.line.material as LineBasicMaterial).color = hdr(COLORS.magenta, 2.2);
  for (const m of [arrow.line.material, arrow.cone.material] as (LineBasicMaterial | MeshBasicMaterial)[]) m.depthTest = false;
  arrow.line.renderOrder = arrow.cone.renderOrder = 21;
  root.add(arrow);
  const nLabel = mkLabel('n', 'magenta');

  const M = new Matrix4();
  const full = new Matrix4();
  const tv = new Vector3();
  const setO = (lb: CSS2DObject, o: number) => {
    lb.element.style.opacity = String(o);
    lb.visible = o > 0.01;
  };
  const tagAt = (lb: CSS2DObject, w: Vector3, o: number) => {
    lb.position.copy(w).applyMatrix4(disp);
    setO(lb, o);
  };
  /** Concept props can sit behind the camera: lerp with clamped NDC instead of the exact path. */
  const propPoint = (w: Vector3, s: number, out: Vector3) => {
    if (s <= 2) return out.copy(w).applyMatrix4(worldDisp(s, tmpM));
    const a3 = ease(clamp01(s - 2));
    const a = out.copy(w).applyMatrix4(A3);
    const c = w.clone().applyMatrix4(V);
    const clip = [P.elements[0] * c.x + P.elements[4] * c.y + P.elements[8] * c.z + P.elements[12], P.elements[1] * c.x + P.elements[5] * c.y + P.elements[9] * c.z + P.elements[13], P.elements[2] * c.x + P.elements[6] * c.y + P.elements[10] * c.z + P.elements[14], P.elements[3] * c.x + P.elements[7] * c.y + P.elements[11] * c.z + P.elements[15]];
    const ww = Math.max(1e-3, clip[3]);
    const nx = Math.max(-1.6, Math.min(1.6, clip[0] / ww));
    const ny = Math.max(-1.6, Math.min(1.6, clip[1] / ww));
    const nz = Math.max(zMin - 0.3, Math.min(1.3, clip[2] / ww));
    const b = new Vector3(nx, ny, nz).applyMatrix4(D);
    return a.lerp(b, a3);
  };
  const pivotM = new Matrix4();

  ms.onFrame((time) => {
    const s = S.s;
    const a1 = ease(clamp01(s));
    const a3 = clamp01(s - 2);
    M.copy(setup.model(a1));
    worldDisp(s, disp);
    full.multiplyMatrices(disp, M);
    pivotM.copy(full);
    ms.pivot.matrix.copy(pivotM);
    ms.pivot.matrixWorldNeedsUpdate = true;
    const pulse = 0.5 + 0.5 * Math.sin(time * 4);
    // Object axes + labels.
    const objO = S.obj * (1 - a3);
    (objAxes.material as LineBasicMaterial).opacity = 0.15 + 0.85 * objO;
    AX.forEach((d, i) => tagAt(objAxisLabels[i], tv.copy(d).multiplyScalar(1.33).applyMatrix4(M), objO));
    tagAt(objTag, tv.set(0.12, -0.2, 0).applyMatrix4(M), objO);
    // World axes.
    const worldO = clamp01(s * 2) * (1 - 0.75 * clamp01(s - 1)) * (1 - a3) * (1 - S.nrm * 0.6);
    const wl = 1.7;
    [0, 1, 2].forEach((i) => {
      worldAxes.set(i * 2, tv.set(0, 0, 0).applyMatrix4(disp));
      worldAxes.set(i * 2 + 1, tv.copy(AX[i]).multiplyScalar(wl).applyMatrix4(disp));
      tagAt(worldAxisLabels[i], tv.copy(AX[i]).multiplyScalar(wl * 1.07), worldO);
    });
    worldAxes.done();
    worldAxes.mat.opacity = worldO;
    tagAt(worldTag, tv.set(wl * 0.55, -0.12, 0), worldO * (1 - clamp01(s - 1)));
    // Concept props.
    props.forEach((p) => {
      p.pts.forEach((w, i) => p.set.set(i, propPoint(w, s, tv)));
      p.set.done();
      p.set.mat.opacity = p.opacity * (0.35 + 0.65 * clamp01(s));
    });
    // Camera gizmo (it flies in for the concept) and frustum.
    const fly = ease(S.fly);
    const eyeNow = setup.startEye ? setup.startEye.clone().lerp(new Vector3(...cam.eye), fly) : new Vector3(...cam.eye);
    const pose: Camera = { ...cam, eye: [eyeNow.x, eyeNow.y, eyeNow.z] };
    const inv = viewMatrix(pose).invert();
    const camO = S.cam * clamp01(1 - a3 * 2.2);
    // The eye itself goes to infinity in clip space (w = 0): only place eye-anchored things while visible.
    const eyeOk = a3 < 0.45;
    if (eyeOk) {
      [0, 1, 2].forEach((i) => {
        camAxes.set(i * 2, tv.set(0, 0, 0).applyMatrix4(inv).applyMatrix4(disp));
        camAxes.set(i * 2 + 1, tv.copy(AX[i]).multiplyScalar(0.5).applyMatrix4(inv).applyMatrix4(disp));
      });
      camAxes.done();
    }
    camAxes.mat.opacity = camO;
    camAxes.ls.visible = camO > 0.01;
    if (eyeOk) tagAt(camTag, tv.set(0, -0.2, 0).applyMatrix4(inv), camO);
    else setO(camTag, 0);
    const far = DISP_FAR + (cam.far - DISP_FAR) * ease(a3);
    const cs = frustumCorners(pose, ASPECT, far);
    BOX_EDGES.forEach((ci, k) => frustum.set(k, tv.copy(cs[ci]).applyMatrix4(disp)));
    for (let i = 0; i < 4; i++) {
      // Apex lines run eye → near corner; they collapse onto the near face in clip space.
      frustum.set(BOX_EDGES.length + i * 2, eyeOk ? tv.copy(eyeNow).applyMatrix4(disp) : tv.copy(cs[i]).applyMatrix4(disp));
      frustum.set(BOX_EDGES.length + i * 2 + 1, tv.copy(cs[i]).applyMatrix4(disp));
    }
    frustum.done();
    frustum.mat.opacity = S.cam * (0.55 + 0.4 * a3);
    frustum.ls.visible = S.cam > 0.01;
    const zr = api === 'opengl' ? ['z = −1', 'z = +1'] : ['z = 0', 'z = 1'];
    nearTag.element.textContent = a3 > 0.5 ? `near · ${zr[0]}` : `near = ${cam.near}`;
    farTag.element.textContent = a3 > 0.5 ? `far · ${zr[1]}` : `far = ${cam.far}${far < cam.far ? ' →' : ''}`;
    yTag.element.textContent = api === 'vulkan' ? '+y ↓ (Vulkan)' : '+y ↑';
    tagAt(nearTag, cs[1], S.cam * clamp01(0.5 + a3));
    tagAt(farTag, cs[4], S.cam * clamp01(0.4 + a3));
    tagAt(yTag, cs[7], S.cam * a3);
    // The vertex.
    const vp = tv.copy(p0).applyMatrix4(full);
    vSprite.position.copy(vp);
    vSprite.scale.setScalar(0.09 + 0.03 * pulse);
    vLabel.position.copy(vp).add(new Vector3(0, -0.16, 0));
    posLine.set(0, new Vector3().applyMatrix4(full));
    posLine.set(1, vp);
    posLine.done();
    posLine.mat.opacity = S.obj * (1 - clamp01(s - 1)) * 0.9;
    if (eyeOk) {
      ray.set(0, eyeNow.clone().applyMatrix4(disp));
      ray.set(1, vp);
      ray.done();
    }
    ray.mat.opacity = S.cam * clamp01(1 - a3 * 2.2) * 0.85;
    // The normal (world space, shown when s ≈ 1).
    const nm = new Matrix3().getNormalMatrix(M);
    const nw = n0.clone().applyMatrix3(nm).normalize();
    arrow.position.copy(vp);
    arrow.setDirection(nw);
    arrow.visible = S.nrm > 0.01;
    arrow.scale.setScalar(Math.max(0.01, S.nrm));
    nLabel.position.copy(vp).addScaledVector(nw, 0.75);
    setO(nLabel, S.nrm);
  });

  const observer = (step: number, animate: boolean) => {
    // Close on the model; from the side for view space (camera + frustum); from the front for the NDC box.
    const target = step === 2 ? new Vector3(3.0, 1.7, 3.2) : step === 3 ? new Vector3(1.1, 0.7, 3.2) : new Vector3(2.2, 1.2, 2.6);
    gsap.killTweensOf(ms.camera.position);
    if (animate) gsap.to(ms.camera.position, { x: target.x, y: target.y, z: target.z, duration: dur(1.4), ease: 'power2.inOut' });
    else ms.camera.position.copy(target);
  };
  return { ms, S, vertexAt: (p) => p.clone().applyMatrix4(full), observer };
}

/* ------------------------------------------------------------------ */
/* Real data                                                           */
/* ------------------------------------------------------------------ */
function dataVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const api = ctx.state.api;
  const tri = ctx.derived.showcaseTriangle(api);
  const vIdx = ctx.derived.triangleVertices(tri)[0];
  const p = ctx.derived.position(vIdx);
  const n = ctx.derived.normal(vIdx);
  const mats = matrices(api, SHOWCASE_ROT_Y, ASPECT, undefined, SHOWCASE_ROT_X);
  const st = runVertex(api, p, mats, 160, 100);
  const nm = new Matrix3().getNormalMatrix(mats.model);
  const nWorld = new Vector3(...n).applyMatrix3(nm).normalize();
  const cam = DEFAULT_CAMERA;
  const V = buildScene(host, ctx, { model: (a) => modelMatrix(a * SHOWCASE_ROT_Y, a * SHOWCASE_ROT_X), cam }, { shift: -0.17, vIdx });
  const { ms, S } = V;

  /* ---------- Equation panels ---------- */
  const op = (s: string) => h('span.vs-op', { text: s });
  const named = (name: string, el: HTMLElement, cls = '') => h(`div.vs-named${cls ? '.' + cls : ''}`, {}, [h('div.vs-name', { html: name }), el]);
  const mul = (mName: string, mEl: HTMLElement, a: { n: string; v: number[]; c: string }, b: { n: string; v: number[]; c: string }) =>
    h('div.vs-eq', {}, [named(mName, mEl, 'mat'), op('×'), named(a.n, colEl(a.v, 3, a.c)), op('='), named(b.n, colEl(b.v, 3, b.c + '.hot'))]);
  const vec = (name: string, v: readonly number[], c: string) => ({ n: name, v: [...v], c });
  const zView = st.view[2];
  const pe = mats.proj.elements;
  const projNote: Record<ApiId, L> = {
    opengl: L(`OpenGL: z<sub>clip</sub> = ${num(pe[10], 3)}·z + ${num(pe[14], 3)} → efter division z ∈ [−1, 1].`, `OpenGL: z<sub>clip</sub> = ${num(pe[10], 3)}·z + ${num(pe[14], 3)} → after the divide z ∈ [−1, 1].`),
    vulkan: L(`Vulkan: rad 2 är negerad (${num(pe[5], 3)}) – +y pekar <b>nedåt</b>, modellen står på huvudet i lådan; z ∈ [0, 1].`, `Vulkan: row 2 is negated (${num(pe[5], 3)}) – +y points <b>down</b>, the model is upside down in the box; z ∈ [0, 1].`),
    d3d12: L(`D3D12 (som XMMatrixPerspectiveFovRH): z<sub>clip</sub> = ${num(pe[10], 3)}·z + ${num(pe[14], 3)} → z ∈ [0, 1], +y uppåt.`, `D3D12 (like XMMatrixPerspectiveFovRH): z<sub>clip</sub> = ${num(pe[10], 3)}·z + ${num(pe[14], 3)} → z ∈ [0, 1], +y up.`),
  };
  const outName = api === 'd3d12' ? 'SV_Position' : 'gl_Position';
  const defs: { title: Text; stats: HTMLElement[]; body: HTMLElement; note: Text }[] = [
    {
      title: L(`Objektrymd · vertex ${vIdx}`, `Object space · vertex ${vIdx}`),
      stats: [stat(vecText(p), 'p_obj', 'c-pos')],
      body: h('div.vs-eq', {}, [named('aPos', colEl(p, 3, 'c-pos')), op('→'), named('p<sub>obj</sub>', colEl([...p, 1], 3, 'c-pos.hot')), h('div.vs-side', {}, [h('div.vs-name', { text: 'aNormal' }), colEl(n, 3, 'c-nrm')])]),
      note: L(
        'Positionen som den står i vertexbufferten, relativt modellens eget origo. Med <b>w = 1</b> blir den en punkt, så förflyttningar påverkar den.',
        "The position exactly as stored in the vertex buffer, relative to the model's own origin. With <b>w = 1</b> it is a point, so translations affect it.",
      ),
    },
    {
      title: L('uModel · objekt → värld', 'uModel · object → world'),
      stats: [stat(vecText(st.world), 'p_world', 'c-g')],
      body: mul('uModel', matrixEl(mats.model, 3), vec('p<sub>obj</sub>', [...p, 1], 'c-pos'), vec('p<sub>world</sub>', st.world, 'c-g')),
      note: L(
        `Modellmatrisen roterar ${SHOWCASE_ROT_Y} rad kring Y och ${SHOWCASE_ROT_X} rad kring X. Ingen translation – modellen centrerades vid inläsningen.`,
        `The model matrix rotates ${SHOWCASE_ROT_Y} rad around Y and ${SHOWCASE_ROT_X} rad around X. No translation – the model was centered on import.`,
      ),
    },
    {
      title: L('uView · värld → kamera', 'uView · world → view'),
      stats: [stat(vecText(st.view), 'p_view', 'c-a'), stat(num(-zView, 2).trim(), t(L('framför kameran', 'in front of camera')))],
      body: mul('uView', matrixEl(mats.view, 3), vec('p<sub>world</sub>', st.world, 'c-g'), vec('p<sub>view</sub>', st.view, 'c-a')),
      note: L(
        `Kameran står i (${cam.eye.join(', ')}). Hela världen flyttas så att kameran hamnar i origo och tittar längs <b>−Z</b>.`,
        `The camera sits at (${cam.eye.join(', ')}). The whole world moves so the camera ends up at the origin looking down <b>−Z</b>.`,
      ),
    },
    {
      title: L(`uProj · kamera → clip (${outName})`, `uProj · view → clip (${outName})`),
      stats: [stat(vecText(st.clip), outName, 'glow-magenta'), stat(num(st.clip[3], 3).trim(), 'w = −z_view')],
      body: mul('uProj', matrixEl(mats.proj, 3), vec('p<sub>view</sub>', st.view, 'c-a'), vec(outName, st.clip, 'glow-magenta')),
      note: L(
        `fov ${cam.fovY}°, aspect ${ASPECT}, near ${cam.near}, far ${cam.far}. Sista raden ger w = −z<sub>view</sub>. Lådan visar resultatet efter GPU:ns division med w – frustumet blir NDC. ${projNote[api].sv}`,
        `fov ${cam.fovY}°, aspect ${ASPECT}, near ${cam.near}, far ${cam.far}. The last row gives w = −z<sub>view</sub>. The box shows the result after the GPU divides by w – the frustum becomes NDC. ${projNote[api].en}`,
      ),
    },
    {
      title: L('Normalen · normalmatris', 'The normal · normal matrix'),
      stats: [stat(vecText([nWorld.x, nWorld.y, nWorld.z]), 'n_world', 'c-nrm')],
      body: h('div.vs-eq', {}, [
        named('N = (M<sub>3×3</sub><sup>−1</sup>)<sup>T</sup>', mat3El(nm), 'mat'),
        op('×'),
        named('n<sub>obj</sub>', colEl(n, 3, 'c-nrm')),
        op('='),
        named('n<sub>world</sub>', colEl([nWorld.x, nWorld.y, nWorld.z], 3, 'c-nrm.hot')),
      ]),
      note: L(
        'Normaler är riktningar (w = 0) och transformeras med invers-transponatet så de förblir vinkelräta. Här är M en ren rotation, så N = M<sub>3×3</sub>. Resultatet blir en varying till fragment shadern.',
        'Normals are directions (w = 0) and are transformed with the inverse transpose so they stay perpendicular. Here M is a pure rotation, so N = M<sub>3×3</sub>. The result becomes a varying for the fragment shader.',
      ),
    },
  ];
  const panels = defs.map((d) => ms.panel(t(d.title), [h('div.stat-row', {}, d.stats), h('div.vs-eq-wrap', {}, [d.body]), h('div.vs-note', { html: t(d.note) })], { className: 'vs-panel' }));
  const chainRows = [
    { k: 'object', v: [...p, 1] },
    { k: 'world', v: st.world },
    { k: 'view', v: st.view },
    { k: 'clip', v: st.clip },
    { k: 'normal', v: [nWorld.x, nWorld.y, nWorld.z] },
  ].map((r) => h('div.vs-chain-row', {}, [h('span.vs-chain-k', { text: r.k }), h('span.vs-chain-v.mono', { text: r.v.map((x) => num(x, 3)).join(' ') })]));
  const chain = ms.panel(t(L(`Vertex ${vIdx} genom VS`, `Vertex ${vIdx} through the VS`)), [h('div.vs-chain', {}, chainRows)], { className: 'vs-chain-panel' });
  const showPanels = stepPanels([...panels.map((el, i) => ({ el, steps: [i] })), { el: chain, steps: [0, 1, 2, 3, 4] }]);

  const targets = [
    { s: 0, cam: 0, nrm: 0, obj: 1, fly: 1 },
    { s: 1, cam: 0, nrm: 0, obj: 0.35, fly: 1 },
    { s: 2, cam: 1, nrm: 0, obj: 0, fly: 1 },
    { s: 3, cam: 1, nrm: 0, obj: 0, fly: 1 },
    { s: 1, cam: 0, nrm: 1, obj: 0.25, fly: 1 },
  ];
  let last = -1;
  return {
    show(step, animate) {
      const fwd = animate && step > last;
      last = step;
      gsap.killTweensOf(S);
      killStageTweens(ms);
      showPanels(step, fwd);
      chainRows.forEach((r, i) => {
        r.classList.toggle('on', i <= step);
        r.classList.toggle('cur', i === step);
      });
      const tg = targets[step];
      if (fwd && step === 2) {
        // Show the camera in the world first, then move the world into view space.
        gsap.to(S, { cam: 1, obj: 0, duration: dur(0.6) });
        gsap.to(S, { s: 2, duration: dur(1.8), delay: dur(1.1), ease: 'power1.inOut' });
      } else if (fwd) gsap.to(S, { ...tg, duration: dur(step === 3 ? 2.2 : 1.6), ease: 'power2.inOut' });
      else Object.assign(S, tg);
      V.observer(step, fwd);
      ms.setLayer('normals', step === 4 ? 0.55 : 0, secs(fwd, 0.6));
      ms.setLayer('wire', step === 3 ? 0.3 : 0.1, secs(fwd, 0.6));
      ms.uniform('uDiffuseW', step === 4 ? 0.6 : step === 3 ? 0.8 : 1, secs(fwd, 0.6));
      ms.uniform('uSpecW', step === 3 ? 0.25 : 1, secs(fwd, 0.6));
    },
    destroy() {
      gsap.killTweensOf(S);
      gsap.killTweensOf(ms.camera.position);
      ms.destroy();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Concept: a little world – the model, a floor and two crates         */
/* ------------------------------------------------------------------ */
function conceptVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const api = ctx.state.api;
  const MW = { t: new Vector3(0.35, 0, -0.5), ry: 0.9, s: 0.85 };
  const CAM: Camera = { eye: [1.75, 1.15, 2.3], target: [0.2, -0.2, -0.5], up: [0, 1, 0], fovY: 48, near: 0.8, far: 4.4 };
  const grid: Vector3[] = [];
  for (let i = -3; i <= 3; i++) grid.push(new Vector3(i * 0.5, -1, -2.2), new Vector3(i * 0.5, -1, 1.0));
  for (let k = 0; k <= 6; k++) {
    const z = -2.2 + (k * 3.2) / 6;
    grid.push(new Vector3(-1.5, -1, z), new Vector3(1.5, -1, z));
  }
  const crate = (c: Vector3, s: number) => {
    const out: Vector3[] = [];
    const cs = [-1, 1];
    const corner = (i: number) => new Vector3(cs[i & 1], cs[(i >> 1) & 1], cs[(i >> 2) & 1]).multiplyScalar(s).add(c);
    for (let i = 0; i < 8; i++) for (let b = 0; b < 3; b++) if (!(i & (1 << b))) out.push(corner(i), corner(i | (1 << b)));
    return out;
  };
  const tri = ctx.derived.showcaseTriangle(api);
  const vIdx = ctx.derived.triangleVertices(tri)[0];
  const V = buildScene(
    host,
    ctx,
    {
      model: (a) =>
        new Matrix4().compose(MW.t.clone().multiplyScalar(a), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), MW.ry * a), new Vector3(1, 1, 1).multiplyScalar(1 + (MW.s - 1) * a)),
      cam: CAM,
      startEye: new Vector3(5, 3.2, -2.6),
      props: [
        { pts: grid, color: COLORS.violet, opacity: 0.5 },
        { pts: [...crate(new Vector3(-1.0, -0.75, -1.4), 0.25), ...crate(new Vector3(1.05, -0.8, 0.35), 0.2)], color: COLORS.amber, opacity: 0.85 },
      ],
    },
    { shift: 0, vIdx },
  );
  const { ms, S } = V;

  const chips = ['object', 'world', 'view', 'clip'].map((k, i) =>
    h('span.vsc-chip', {}, [h('b', { text: k }), i < 3 ? h('span.vsc-m', { text: ['× uModel', '× uView', '× uProj'][i] }) : null]),
  );
  const optional = h('div.vsc-opt', {}, [
    h('span.vsc-node.on', { text: 'VS' }),
    h('span.vsc-arrow', { text: '→' }),
    h('span.vsc-node', { text: api === 'd3d12' ? 'Hull · Domain' : 'TCS · TES' }),
    h('span.vsc-arrow', { text: '→' }),
    h('span.vsc-node', { text: 'GS' }),
    h('span.vsc-arrow', { text: '→' }),
    h('span.vsc-node.raster', { text: 'clip / raster' }),
    h('span.vsc-sep'),
    h('span.vsc-node.mesh', { text: api === 'd3d12' ? 'Amplification → Mesh' : api === 'vulkan' ? 'Task → Mesh (VK_EXT_mesh_shader)' : 'Task → Mesh (GL_NV_mesh_shader)' }),
  ]);
  const hud = ms.panel(t(L('Rymderna', 'The spaces')), [h('div.vsc-chips', {}, chips), optional], { side: 'top', className: 'vsc-hud' });
  const capPanel = ms.panel(t(L('Vad händer', 'What happens')), [h('p.vsc-cap')], { side: 'bottom' });
  const cap = capPanel.querySelector('.vsc-cap')!;

  const captions: Text[] = [
    L('Objektrymd: modellen kring sitt eget origo, med sina egna axlar.', 'Object space: the model around its own origin, with its own axes.'),
    L('Modellmatrisen flyttar, roterar och skalar in modellen i världen bland allt annat.', 'The model matrix moves, rotates and scales the model into the world among everything else.'),
    L('Kameran flyger på plats – sedan flyttas hela världen så att kameran hamnar i origo och tittar längs −Z.', 'The camera flies into position – then the whole world moves so the camera sits at the origin looking down −Z.'),
    L(
      `Projektionen trycker ihop frustumet till en låda: nära saker blir stora, långt borta små. ${api === 'opengl' ? 'z ∈ [−1, 1]' : 'z ∈ [0, 1]'}${api === 'vulkan' ? ', och +y pekar nedåt – bilden står på huvudet i NDC.' : '.'}`,
      `The projection squashes the frustum into a box: near things get big, far things small. ${api === 'opengl' ? 'z ∈ [−1, 1]' : 'z ∈ [0, 1]'}${api === 'vulkan' ? ', and +y points down – the image is upside down in NDC.' : '.'}`,
    ),
    L(
      'Normalerna följer med modellens rotation. Efter VS kan valfria steg ta vid: tessellering och geometry shader – eller mesh shaders som ersätter hela IA + VS.',
      "The normals follow the model's rotation. After the VS optional stages may run: tessellation and geometry shader – or mesh shaders, which replace IA + VS altogether.",
    ),
  ];
  const targets = [
    { s: 0, fly: 0, nrm: 0, cam: 0, obj: 1 },
    { s: 1, fly: 0, nrm: 0, cam: 0, obj: 0.35 },
    { s: 2, fly: 1, nrm: 0, cam: 1, obj: 0 },
    { s: 3, fly: 1, nrm: 0, cam: 1, obj: 0 },
    { s: 1, fly: 1, nrm: 1, cam: 0, obj: 0.25 },
  ];
  let last = -1;
  return {
    show(step, animate) {
      const fwd = animate && step > last;
      last = step;
      cap.innerHTML = t(captions[step]);
      if (fwd) gsap.fromTo(cap, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: dur(0.4) });
      chips.forEach((c, i) => {
        c.classList.toggle('on', step === 4 ? i === 1 : i <= step);
        c.classList.toggle('cur', step === 4 ? i === 1 : i === step);
      });
      hud.dataset.step = String(step);
      gsap.killTweensOf(S);
      killStageTweens(ms);
      const tg = targets[step];
      if (fwd && step === 2) {
        S.fly = 0;
        gsap.to(S, { cam: 1, obj: 0, duration: dur(0.4) });
        gsap.to(S, { fly: 1, duration: dur(1.6), ease: 'power2.inOut' });
        gsap.to(S, { s: 2, duration: dur(1.8), delay: dur(1.7), ease: 'power1.inOut' });
      } else if (fwd) gsap.to(S, { ...tg, duration: dur(step === 3 ? 2.2 : 1.6), ease: 'power1.inOut' });
      else Object.assign(S, tg);
      V.observer(step, fwd);
      ms.setLayer('normals', step === 4 ? 0.6 : 0, secs(fwd, 0.6));
      ms.setLayer('wire', step === 3 ? 0.3 : 0.12, secs(fwd, 0.6));
      ms.uniform('uSpecW', step === 3 ? 0.25 : 1, secs(fwd, 0.6));
    },
    destroy() {
      gsap.killTweensOf(S);
      gsap.killTweensOf(ms.camera.position);
      ms.destroy();
    },
  };
}

/* ------------------------------------------------------------------ */
/* API panels                                                          */
/* ------------------------------------------------------------------ */
function apis(): Record<ApiId, ApiPanelSpec> {
  const c = DEFAULT_CAMERA;
  const ry = SHOWCASE_ROT_Y;
  const rx = SHOWCASE_ROT_X;
  const eye = c.eye.map((x) => (Number.isInteger(x) ? String(x) : x + 'f')).join(', ');
  const glsl = `#version 460 core
layout(location = 0) in vec3 aPos;      // object space
layout(location = 1) in vec3 aNormal;

layout(location = 0) uniform mat4 uModel;
layout(location = 1) uniform mat4 uView;
layout(location = 2) uniform mat4 uProj;
layout(location = 3) uniform mat3 uNormalMatrix;

out vec3 vNormal;                       // → fragment shader

void main() {
    // object → world → view → clip (read right to left)
    gl_Position = uProj * uView * uModel * vec4(aPos, 1.0);
    vNormal = uNormalMatrix * aNormal;  // world-space normal
}`;
  const glslHi = [[2, 13], [4, 13], [5, 13], [6, 12, 13], [3, 7, 9, 14]];
  const vkGlsl = `#version 460
layout(location = 0) in vec3 aPos;      // object space
layout(location = 1) in vec3 aNormal;

layout(set = 0, binding = 0) uniform Camera {
    mat4 uView;
    mat4 uProj;                         // y already flipped
};
layout(push_constant) uniform Push {
    mat4 uModel;
    mat4 uNormalMatrix;
};
layout(location = 0) out vec3 vNormal;

void main() {
    gl_Position = uProj * uView * uModel * vec4(aPos, 1.0);
    vNormal = mat3(uNormalMatrix) * aNormal;
}`;
  const vkHi = [[2, 15], [9, 15], [6, 15], [7, 15], [3, 10, 12, 16]];
  const hlsl = `cbuffer Camera : register(b0) { float4x4 uView; float4x4 uProj; };
cbuffer Object : register(b1) { float4x4 uModel; float4x4 uNormalMatrix; };

struct VSIn  { float3 pos : POSITION;    float3 nrm : NORMAL; };
struct VSOut { float4 pos : SV_Position; float3 nrm : NORMAL; };

VSOut main(VSIn v)
{
    VSOut o;
    float4 world = mul(uModel, float4(v.pos, 1.0));  // object → world
    float4 view  = mul(uView, world);                // world → view
    o.pos = mul(uProj, view);                        // view → clip
    o.nrm = mul((float3x3)uNormalMatrix, v.nrm);
    return o;
}`;
  const hlslHi = [[4], [2, 10], [1, 11], [1, 5, 12], [2, 13]];
  return {
    opengl: {
      note: L(
        'Vertex shadern körs en gång per (unik) vertex. Den enda obligatoriska utdatan är gl_Position i clip space; resten blir varyings som interpoleras.',
        'The vertex shader runs once per (unique) vertex. Its only mandatory output is gl_Position in clip space; everything else becomes varyings to interpolate.',
      ),
      code: [
        { lang: 'glsl', src: glsl, highlight: glslHi },
        {
          lang: 'cpp',
          title: L('C++ (glm)', 'C++ (glm)'),
          src: `glm::mat4 model = glm::rotate(glm::mat4(1), ${ry}f, {0, 1, 0})
               * glm::rotate(glm::mat4(1), ${rx}f, {1, 0, 0});
glm::mat4 view  = glm::lookAt(glm::vec3(${eye}),
                              glm::vec3(0), glm::vec3(0, 1, 0));
// OpenGL clip space: z in [-w, w]
glm::mat4 proj  = glm::perspective(glm::radians(${c.fovY}.0f), ${ASPECT}f, ${c.near}f, ${c.far}.0f);
glm::mat3 nrm   = glm::transpose(glm::inverse(glm::mat3(model)));

glProgramUniformMatrix4fv(prog, 0, 1, GL_FALSE, glm::value_ptr(model));
glProgramUniformMatrix4fv(prog, 1, 1, GL_FALSE, glm::value_ptr(view));
glProgramUniformMatrix4fv(prog, 2, 1, GL_FALSE, glm::value_ptr(proj));
glProgramUniformMatrix3fv(prog, 3, 1, GL_FALSE, glm::value_ptr(nrm));`,
          highlight: [[], [1, 2, 9], [3, 4, 10], [5, 6, 11], [7, 12]],
        },
      ],
      terms: [
        { term: 'gl_Position', desc: L('Inbyggd utdata: vertexens position i clip space (x, y, z, w).', 'Built-in output: the vertex position in clip space (x, y, z, w).') },
        { term: 'normal matrix', desc: L('transpose(inverse(mat3(M))) – håller normaler vinkelräta.', 'transpose(inverse(mat3(M))) – keeps normals perpendicular.') },
        { term: 'varying', desc: L('Utdata som interpoleras över triangeln till fragment shadern.', 'Output interpolated across the triangle for the fragment shader.') },
      ],
      you: L('skriver shadern och matriserna', 'write the shader and the matrices'),
      driver: L('kompilerar GLSL till GPU-kod', 'compiles GLSL to GPU code'),
    },
    vulkan: {
      note: L(
        'Samma GLSL, men kompilerad i förväg till SPIR-V. Matriser kommer via uniform buffer (descriptor set) och push constants. Projektionen flippar y.',
        'Same GLSL, but compiled ahead of time to SPIR-V. Matrices arrive via a uniform buffer (descriptor set) and push constants. The projection flips y.',
      ),
      code: [
        { lang: 'glsl', src: vkGlsl, highlight: vkHi },
        {
          lang: 'cpp',
          title: L('C++ (glm)', 'C++ (glm)'),
          src: `#define GLM_FORCE_DEPTH_ZERO_TO_ONE      // Vulkan: z in [0, w]
glm::mat4 model = glm::rotate(glm::mat4(1), ${ry}f, {0, 1, 0})
               * glm::rotate(glm::mat4(1), ${rx}f, {1, 0, 0});
glm::mat4 view  = glm::lookAt(glm::vec3(${eye}),
                              glm::vec3(0), glm::vec3(0, 1, 0));
glm::mat4 proj  = glm::perspective(glm::radians(${c.fovY}.0f), ${ASPECT}f, ${c.near}f, ${c.far}.0f);
proj[1][1] *= -1.0f;                     // +y points down in Vulkan

Push push{ model, glm::transpose(glm::inverse(model)) };
vkCmdPushConstants(cmd, pipelineLayout, VK_SHADER_STAGE_VERTEX_BIT,
                   0, sizeof(Push), &push);`,
          highlight: [[], [2, 3, 9, 10], [4, 5], [1, 6, 7], [9]],
        },
      ],
      terms: [
        { term: 'SPIR-V', desc: L('Binärt mellanformat som Vulkan-drivrutinen tar emot.', 'Binary intermediate format the Vulkan driver consumes.') },
        { term: 'push constants', desc: L('Små, snabba uniforms (≥ 128 B) direkt i kommandobufferten.', 'Small, fast uniforms (≥ 128 B) right in the command buffer.') },
        { term: 'proj[1][1] *= −1', desc: L('Vulkans clip space har +y nedåt.', 'Vulkan clip space has +y pointing down.') },
      ],
      you: L('skriver shadern, matriserna och y-flippen', 'write the shader, the matrices and the y flip'),
      driver: L('översätter SPIR-V till GPU-kod', 'translates SPIR-V to GPU code'),
    },
    d3d12: {
      note: L(
        'HLSL kompileras med DXC till DXIL (SM 6.x). Utdata med semantiken SV_Position är clip space-positionen. Matriser kommer via constant buffers.',
        'HLSL is compiled by DXC to DXIL (SM 6.x). The output with the SV_Position semantic is the clip-space position. Matrices arrive via constant buffers.',
      ),
      code: [
        { lang: 'hlsl', src: hlsl, highlight: hlslHi },
        {
          lang: 'cpp',
          title: L('C++ (DirectXMath)', 'C++ (DirectXMath)'),
          src: `// Row-vector math, stored without transpose → mul(M, v) in HLSL
XMMATRIX model = XMMatrixRotationX(${rx}f) * XMMatrixRotationY(${ry}f);
XMMATRIX view  = XMMatrixLookAtRH(XMVectorSet(${eye}, 1),
                                  XMVectorZero(), XMVectorSet(0, 1, 0, 0));
// D3D clip space: z in [0, w]
XMMATRIX proj  = XMMatrixPerspectiveFovRH(XMConvertToRadians(${c.fovY}),
                                          ${ASPECT}f, ${c.near}f, ${c.far}.0f);
XMMATRIX nrm   = XMMatrixTranspose(XMMatrixInverse(nullptr, model));

memcpy(cameraCB, &view, 64);  memcpy(cameraCB + 64, &proj, 64);
cmd->SetGraphicsRootConstantBufferView(0, cameraCBAddress);`,
          highlight: [[1], [2], [3, 4, 9], [5, 6, 7, 9, 10], [8]],
        },
      ],
      terms: [
        { term: 'SV_Position', desc: L('System value-semantik: clip space-position ut från VS.', 'System-value semantic: the clip-space position out of the VS.') },
        { term: 'DXIL', desc: L('D3D12:s shader-bytekod, från DXC.', 'D3D12 shader bytecode, produced by DXC.') },
        { term: 'mul(M, v)', desc: L('Kolumnvektor-ordning; mul(v, M) om matriserna transponeras.', 'Column-vector order; mul(v, M) if matrices are transposed.') },
      ],
      you: L('skriver HLSL och constant buffers', 'write HLSL and constant buffers'),
      driver: L('översätter DXIL till GPU-kod', 'translates DXIL to GPU code'),
    },
  };
}

export default standardSlide({
  id: 'vertex-shader',
  group: 'gpu-prog',
  short: L('Vertex shader', 'Vertex shader'),
  title: L('Vertex shader – från objekt till clip space', 'Vertex shader – from object to clip space'),
  lead: L(
    'Ditt första program på GPU:n. Det körs en gång per vertex och har ett obligatoriskt jobb: räkna ut var vertexen hamnar i <b>clip space</b>.',
    'Your first program on the GPU. It runs once per vertex and has one mandatory job: work out where the vertex ends up in <b>clip space</b>.',
  ),
  bullets: [
    L('Indata är attributen från input assemblern: positionen i <b>objektrymd</b> (modellens egna koordinater) och normalen.', 'The inputs are the attributes from the input assembler: the position in <b>object space</b> (the model\'s own coordinates) and the normal.'),
    L('<code>uModel</code> placerar modellen i <b>världen</b>: rotation, skala och förflyttning.', '<code>uModel</code> places the model in the <b>world</b>: rotation, scale and translation.'),
    L('<code>uView</code> flyttar hela världen så att kameran hamnar i origo och tittar längs −Z – <b>kamerarymd</b>.', '<code>uView</code> moves the whole world so the camera sits at the origin looking down −Z – <b>view space</b>.'),
    L('<code>uProj</code> ger <b>clip space</b>: x, y, z skalas efter fov och djupintervall, och w = −z<sub>view</sub> förbereder perspektivdivisionen.', '<code>uProj</code> gives <b>clip space</b>: x, y, z are scaled by fov and depth range, and w = −z<sub>view</sub> prepares the perspective divide.'),
    L(
      'Normalen transformeras med normalmatrisen och skickas vidare. Efter VS kan valfria steg köras: <b>tessellering</b>, <b>geometry shader</b> – eller <b>mesh/amplification shaders</b> (D3D12 Ultimate, VK_EXT_mesh_shader) som ersätter IA + VS.',
      'The normal is transformed by the normal matrix and passed on. Optional stages may follow the VS: <b>tessellation</b>, the <b>geometry shader</b> – or <b>mesh/amplification shaders</b> (D3D12 Ultimate, VK_EXT_mesh_shader) that replace IA + VS.',
    ),
  ],
  api: apis,
  data: dataVisual,
  concept: conceptVisual,
});
