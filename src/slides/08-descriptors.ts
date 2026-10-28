import gsap from 'gsap';
import {
  BoxGeometry,
  BufferGeometry,
  EdgesGeometry,
  Euler,
  Float32BufferAttribute,
  GridHelper,
  Group,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  Vector3,
  Vector4,
} from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { dur, h, num, reducedMotion } from '../core/dom';
import { SHOWCASE_ROT_X, SHOWCASE_ROT_Y } from '../core/derived';
import { L, type Text } from '../core/i18n';
import { API_LIST, type ApiId } from '../core/state';
import { DEFAULT_CAMERA, matrices, modelMatrix, projectionMatrix, rows, runVertex, type V3 } from '../pipeline/transform';
import { createModelStage } from '../views/ModelStage';
import { COLORS, label } from '../views/three-helpers';
import { matrixEl, stat, vecEl } from '../views/widgets';
import '../styles/slides/descriptors.css';
import { standardSlide } from './standard';
import type { ApiPanelSpec, SlideContext, Visual } from './types';

/** Same 1920×1080 viewport as the pipeline-state and commands slides. */
const ASPECT = 1920 / 1080;
const UBO_SIZE = 256; // 4 × mat4 × 64 B
const FRAMES = 2; // frames in flight, as on the commands slide

const NAMES = ['model', 'view', 'proj', 'mvp'] as const;
const MCLS = ['m-model', 'm-view', 'm-proj', 'm-mvp'] as const;

function uboBytes(ms: Matrix4[]): Uint8Array {
  const f = new Float32Array(64);
  // three.js keeps elements column-major – exactly what std140 / HLSL column_major expect.
  ms.forEach((m, i) => f.set(m.elements, i * 16));
  const out = new Uint8Array(256);
  const dv = new DataView(out.buffer);
  f.forEach((x, i) => dv.setFloat32(i * 4, x, true)); // GPUs read little-endian
  return out;
}

/** Where the near and far planes land in NDC z for an API's projection. */
function zRange(api: ApiId): { near: number; far: number; p11: number; p22: number; p23: number } {
  const P = projectionMatrix(api, DEFAULT_CAMERA, ASPECT).elements;
  const ndcZ = (zView: number) => (P[10] * zView + P[14]) / (P[11] * zView + P[15]);
  return { near: ndcZ(-DEFAULT_CAMERA.near), far: ndcZ(-DEFAULT_CAMERA.far), p11: P[5], p22: P[10], p23: P[14] };
}

/* ------------------------------------------------------------------ */
/* The 3D scene: the real M, V and P applied to the model, step by step */
/* ------------------------------------------------------------------ */
const MHEX = [0x38e1ff, 0x9b7bff, 0xffb547, 0xff3fd2];
const DIRECTOR: V3 = [5.0, 2.3, 2.6];
const FRUSTUM_CUT = 4.6; // the far plane is at 10 – we draw the frustum up to here

/** Elementwise mix of two 4×4 matrices (identity → P is how the "squash" is animated). */
function mixMat(a: Matrix4, b: Matrix4, s: number, out = new Matrix4()): Matrix4 {
  for (let i = 0; i < 16; i++) out.elements[i] = a.elements[i] * (1 - s) + b.elements[i] * s;
  return out;
}

function lines(pts: number[]): LineSegments {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pts, 3));
  const l = new LineSegments(g, new LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1 }));
  l.frustumCulled = false;
  return l;
}

/** Wire box between two corners. */
function wireBox(a: V3, b: V3, color: number): LineSegments {
  const [x0, y0, z0] = a;
  const [x1, y1, z1] = b;
  const c = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const e = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];
  const l = lines(e.flatMap((i) => c[i]));
  (l.material as LineBasicMaterial).color.set(color);
  return l;
}

interface MvpHooks {
  /** Live matrices, called ~10× per second while they change. */
  matrices?: (m: { model: Matrix4; view: Matrix4; proj: Matrix4; mvp: Matrix4 }, active: number) => void;
}

function mvpScene(host: HTMLElement, ctx: SlideContext, concept: boolean, hooks: MvpHooks) {
  const { t } = ctx;
  const api = ctx.state.api;
  const motion = !reducedMotion();
  const real = matrices(api, SHOWCASE_ROT_Y, ASPECT, undefined, SHOWCASE_ROT_X);
  const ms = createModelStage(host, ctx, { shift: concept ? 0 : -0.15, autoRotate: 0, eye: DIRECTOR, bloom: 0.5, bloomThreshold: 0.85 });
  ms.overlay.classList.add('ds-ms');
  Object.values(ms.layers).forEach((o) => (o.frustumCulled = false));

  // Display group G → projection PX → view VX → { model pivot, world grid, camera gizmo }.
  const G = new Group();
  const PX = new Group();
  const VX = new Group();
  PX.matrixAutoUpdate = false;
  VX.matrixAutoUpdate = false;
  ms.scene.add(G);
  G.add(PX);
  PX.add(VX);
  VX.add(ms.pivot);
  const grid = new GridHelper(4, 8, 0x3a4a8a, 0x222a55);
  grid.position.y = -1.05;
  (grid.material as LineBasicMaterial).transparent = true;
  (grid.material as LineBasicMaterial).opacity = 0.55;
  grid.frustumCulled = false;
  VX.add(grid);

  // Object axes (rotate with the model) – x red, y green, z blue.
  const axes = lines([0, 0, 0, 1.3, 0, 0, 0, 0, 0, 0, 1.3, 0, 0, 0, 0, 0, 0, 1.3]);
  axes.geometry.setAttribute('color', new Float32BufferAttribute([1, 0.35, 0.4, 1, 0.35, 0.4, 0.36, 0.94, 0.56, 0.36, 0.94, 0.56, 0.3, 0.6, 1, 0.3, 0.6, 1], 3));
  (axes.material as LineBasicMaterial).vertexColors = true;
  ms.pivot.add(axes);
  const axisLabels = (['x', 'y', 'z'] as const).map((n, i) => {
    const l = label(n, i === 0 ? 'magenta' : i === 1 ? '' : 'cyan');
    l.position.set(i === 0 ? 1.42 : 0, i === 1 ? 1.42 : 0, i === 2 ? 1.42 : 0);
    ms.pivot.add(l);
    return l;
  });

  // The app's camera as a gizmo: a frustum from the near plane to a cut at 5.2 (far = 10).
  const cam = DEFAULT_CAMERA;
  const ty = Math.tan((cam.fovY * Math.PI) / 360);
  const corners = (z: number) => {
    const hy = z * ty;
    const hx = hy * ASPECT;
    return [[-hx, -hy, -z], [hx, -hy, -z], [hx, hy, -z], [-hx, hy, -z]];
  };
  const nc = corners(cam.near);
  const fc = corners(FRUSTUM_CUT);
  const fr: number[] = [];
  for (let i = 0; i < 4; i++) fr.push(...nc[i], ...nc[(i + 1) % 4], ...fc[i], ...fc[(i + 1) % 4], ...nc[i], ...fc[i]);
  const frustum = lines(fr);
  (frustum.material as LineBasicMaterial).color.set(COLORS.amber);
  const apex: number[] = [];
  for (let i = 0; i < 4; i++) apex.push(0, 0, 0, ...nc[i]);
  const camIcon = new Group();
  const apexLines = lines(apex);
  (apexLines.material as LineBasicMaterial).color.set(COLORS.amber);
  const body = wireBox([-0.14, -0.1, 0.02], [0.14, 0.1, 0.3], COLORS.amber);
  const camLabel = label(t(L('kameran', 'the camera')), 'amber');
  camLabel.position.set(0, 0.28, 0.1);
  camIcon.add(apexLines, body, camLabel);
  const gizmo = new Group();
  gizmo.matrixAutoUpdate = false;
  gizmo.matrix.copy(real.view).invert();
  gizmo.add(frustum, camIcon);
  VX.add(gizmo);

  // NDC box in display space (not projected): x, y ∈ [−1, 1], z ∈ [0 or −1, 1].
  const zMin = api === 'opengl' ? -1 : 0;
  const ndc = new Group();
  ndc.add(wireBox([-1, -1, zMin], [1, 1, 1], COLORS.cyan));
  const ndcLabels = [
    [t(L(`near → z = ${zMin}`, `near → z = ${zMin}`)), [1.05, -1.12, zMin]],
    [t(L('far → z = 1', 'far → z = 1')), [1.05, -1.12, 1]],
    [api === 'vulkan' ? t(L('y nedåt (Vulkan)', 'y down (Vulkan)')) : t(L('y uppåt', 'y up')), [-1.05, 0.2, 1]],
    ['NDC', [1, 1.15, zMin]],
  ] as const;
  ndcLabels.forEach(([txt, pos], i) => {
    const l = label(txt, i === 2 && api === 'vulkan' ? 'magenta' : i === 3 ? 'big cyan' : 'cyan');
    l.position.set(...(pos as V3));
    ndc.add(l);
  });
  // Where the model really lands in NDC z (sampled vertices through the real MVP).
  let zLo = Infinity;
  let zHi = -Infinity;
  {
    const smp = ms.samplePositions(Math.min(2000, ctx.state.mesh.vertexCount));
    const v4 = new Vector4();
    for (let i = 0; i < smp.length; i += 3) {
      v4.set(smp[i], smp[i + 1], smp[i + 2], 1).applyMatrix4(real.mvp);
      const zz = v4.z / v4.w;
      zLo = Math.min(zLo, zz);
      zHi = Math.max(zHi, zz);
    }
  }
  const zLabel = label(t(L(`modellen: z ${zLo.toFixed(2)} – ${zHi.toFixed(2)}`, `the model: z ${zLo.toFixed(2)} – ${zHi.toFixed(2)}`)), 'amber');
  zLabel.position.set(0, -0.72, (zLo + zHi) / 2);
  ndc.add(zLabel);
  const ndcLabelObjs = ndc.children.filter((c) => c instanceof CSS2DObject);
  G.add(ndc);
  const ndcMats = ndc.children.filter((c): c is LineSegments => c instanceof LineSegments).map((c) => c.material as LineBasicMaterial);

  // ---- The live transforms.
  const state = { rot: 1, view: 1, proj: 0 };
  const qView = new Quaternion().setFromRotationMatrix(real.view);
  const eye = new Vector3(...cam.eye);
  const I4 = new Matrix4();
  const tmp = new Matrix4();
  const cur = { model: new Matrix4(), view: new Matrix4(), proj: new Matrix4(), mvp: new Matrix4() };
  let active = 0;
  const apply = () => {
    ms.pivot.rotation.set(SHOWCASE_ROT_X * state.rot, SHOWCASE_ROT_Y * state.rot, 0);
    cur.model.copy(modelMatrix(SHOWCASE_ROT_Y * state.rot, SHOWCASE_ROT_X * state.rot));
    // V(s) = R(s) · T(−s·eye): the world slides so the camera ends up at the origin, looking down −z.
    const q = new Quaternion().slerp(qView, state.view);
    cur.view.makeRotationFromQuaternion(q).multiply(tmp.makeTranslation(-eye.x * state.view, -eye.y * state.view, -eye.z * state.view));
    VX.matrix.copy(cur.view);
    mixMat(I4, real.proj, state.proj, cur.proj);
    PX.matrix.copy(cur.proj);
    cur.mvp.copy(cur.proj).multiply(cur.view).multiply(cur.model);
    VX.matrixWorldNeedsUpdate = true;
    PX.matrixWorldNeedsUpdate = true;
  };
  apply();

  // Framing: the display group is scaled/moved so the interesting part stays centred.
  const frameAt = (c: V3, k: number, s: number) => {
    const p = { x: -c[0] * k, y: -c[1] * k, z: -c[2] * k };
    if (s > 0) {
      ms.tween(G.position, { ...p, duration: dur(s), ease: 'power2.inOut' });
      ms.tween(G.scale, { x: k, y: k, z: k, duration: dur(s), ease: 'power2.inOut' });
    } else {
      G.position.set(p.x, p.y, p.z);
      G.scale.setScalar(k);
    }
  };
  const ndcCenter: V3 = [0, 0, (zMin + 1) / 2];

  let frame = 0;
  ms.onFrame(() => {
    apply();
    const on = ndc.visible && state.proj > 0.85;
    ndcLabelObjs.forEach((l) => (l.visible = on));
    if (frame++ % 5 === 0) hooks.matrices?.(cur, active);
  });

  // ---- Steps 2–3: the uniform buffer as 16 glowing vec4 blocks, and the slot it plugs into.
  const ubo = new Group();
  const cells: Mesh[] = [];
  for (let i = 0; i < 16; i++) {
    const m = new Mesh(new BoxGeometry(0.12, 0.12, 0.12), new MeshBasicMaterial({ color: MHEX[i >> 2], transparent: true, opacity: 0.35 }));
    m.position.set(i * 0.15 + (i >> 2) * 0.05, 0, 0);
    ubo.add(m, new LineSegments(new EdgesGeometry(m.geometry), new LineBasicMaterial({ color: MHEX[i >> 2] })));
    ubo.children[ubo.children.length - 1].position.copy(m.position);
    cells.push(m);
  }
  NAMES.forEach((n, i) => {
    const l = label(concept ? ['M', 'V', 'P', 'MVP'][i] : n, i === 0 ? 'cyan' : i === 2 ? 'amber' : i === 3 ? 'magenta' : '');
    l.position.set(i * 0.65 + 0.22, 0.17, 0);
    ubo.add(l);
  });
  const uboLabel = label(`${UBO_SIZE} B`, 'big');
  uboLabel.position.set(2.62, 0, 0);
  ubo.add(uboLabel);
  ms.scene.add(ubo);
  const uboHome = new Vector3(-0.85, -0.98, 0.7);
  const slotName = concept ? 'slot 0' : api === 'opengl' ? 'binding point 0' : api === 'vulkan' ? 'set 0 · binding 0' : 'root param 0 → b0';
  const slotPos = new Vector3(-0.62, 1.08, -0.3);
  const slot = ms.box(slotName, [slotPos.x, slotPos.y, slotPos.z], [0.75, 0.32, 0.3], COLORS.green);
  const beam = ms.particles(260, COLORS.green, 0.035, 'world');
  {
    const from = new Float32Array(260 * 3);
    const to = ms.samplePositions(260);
    ms.pivot.updateMatrixWorld(true);
    const v = new Vector3();
    for (let i = 0; i < 260; i++) {
      from.set([slotPos.x + (Math.random() - 0.5) * 0.4, slotPos.y - 0.1, slotPos.z], i * 3);
      v.fromArray(to, i * 3).applyMatrix4(new Matrix4().makeRotationFromEuler(new Euler(SHOWCASE_ROT_X, SHOWCASE_ROT_Y, 0, 'YXZ'))).toArray(to, i * 3);
    }
    beam.setTargets(from, to);
  }

  let tl: gsap.core.Timeline | null = null;
  const stopLoop = () => {
    tl?.kill();
    tl = null;
  };
  const fade = (mats: { opacity: number }[], o: number, s: number) =>
    mats.forEach((m) => (s > 0 ? ms.tween(m, { opacity: o, duration: dur(s) }) : (m.opacity = o)));
  const showGizmo = (o: number, s: number, icon = o) => {
    fade([frustum.material as LineBasicMaterial], o, s);
    fade([apexLines.material as LineBasicMaterial, body.material as LineBasicMaterial], icon, s);
    camLabel.visible = icon > 0.5;
  };

  let step = 0;
  return {
    ms,
    show(s: number, animate: boolean) {
      const prev = step;
      step = s;
      stopLoop();
      gsap.killTweensOf(state);
      const inScene = s <= 1;
      grid.visible = inScene;
      axes.visible = s === 0;
      axisLabels.forEach((l) => (l.visible = s === 0));
      gizmo.visible = inScene;
      ndc.visible = s === 1;
      ubo.visible = s >= 2;
      slot.visible = s === 3;
      beam.points.visible = s === 3;
      ms.setMode('shaded', 0, 0);
      // Camera: a director's view on the transforms, the app's own camera for the buffer steps.
      const camTo = new Vector3(...(inScene ? DIRECTOR : cam.eye));
      if (animate && (prev <= 1) !== inScene) ms.tween(ms.camera.position, { x: camTo.x, y: camTo.y, z: camTo.z, duration: dur(1.2), ease: 'power2.inOut' });
      else ms.camera.position.copy(camTo);

      if (s === 0) {
        // Model matrix: identity → the showcase rotation; view: the world slides in front of the camera.
        ndcMats.forEach((m) => (m.opacity = 0));
        const play = (tl: gsap.core.Timeline) => {
          tl.call(() => {
            Object.assign(state, { rot: 0, view: 0, proj: 0 });
            active = 0;
            showGizmo(0, 0);
            frameAt([0, 0, 0], 1.35, 0);
          }, [], 0);
          tl.fromTo(state, { rot: 0 }, { rot: 1, duration: dur(1.8), ease: 'power2.inOut', immediateRender: false }, 0.5);
          tl.call(() => {
            active = 1;
            showGizmo(1, 0.6);
            frameAt([0, 0.35, 1.4], 0.62, 1.0);
          }, [], 3.0);
          tl.fromTo(state, { view: 0 }, { view: 1, duration: dur(2.2), ease: 'power2.inOut', immediateRender: false }, 4.3);
          tl.call(() => frameAt([0, 0, -2.3], 0.7, 2.2), [], 4.3);
          tl.call(() => (active = 3), [], 6.7);
          return 9.5;
        };
        if (motion && animate !== false) {
          tl = gsap.timeline({ repeat: -1 });
          tl.set({}, {}, play(tl));
        } else {
          Object.assign(state, { rot: 1, view: 1, proj: 0 });
          active = 3;
          showGizmo(1, 0);
          frameAt([0, 0, -2.3], 0.7, 0);
          if (motion) {
            tl = gsap.timeline({ repeat: -1, delay: 2 });
            tl.set({}, {}, play(tl));
          }
        }
      } else if (s === 1) {
        // Projection: the frustum (and everything in it) squashes into the NDC box.
        Object.assign(state, { rot: 1, view: 1 });
        active = 2;
        const squash = (tl: gsap.core.Timeline, at: number) => {
          tl.call(() => {
            showGizmo(1, 0.4, 0);
            frameAt(ndcCenter, 1.0, 2.0);
            fade(ndcMats, 0.9, 1.6);
          }, [], at);
          tl.fromTo(state, { proj: 0 }, { proj: 1, duration: dur(2.2), ease: 'power2.inOut', immediateRender: false }, at + 0.2);
          tl.call(() => (active = 3), [], at + 2.4);
        };
        if (motion) {
          tl = gsap.timeline({ repeat: -1 });
          tl.call(() => {
            if (animate || tl!.iteration() > 0) {
              state.proj = 0;
              active = 2;
              frameAt([0, 0, -2.3], 0.7, 0);
              fade(ndcMats, 0, 0);
              showGizmo(1, 0, 0);
            }
          }, [], 0);
          squash(tl, animate ? 0.6 : 0.01);
          tl.fromTo(state, { proj: 1 }, { proj: 0, duration: dur(1.4), ease: 'power2.inOut', immediateRender: false }, 6.5);
          tl.call(() => {
            frameAt([0, 0, -2.3], 0.7, 1.4);
            fade(ndcMats, 0, 1.0);
            active = 2;
          }, [], 6.5);
          tl.set({}, {}, 9.0);
          if (!animate) {
            state.proj = 1;
            frameAt(ndcCenter, 1.0, 0);
            fade(ndcMats, 0.9, 0);
            showGizmo(1, 0, 0);
            tl.seek(3.0, false);
          }
        } else {
          state.proj = 1;
          active = 3;
          frameAt(ndcCenter, 1.0, 0);
          fade(ndcMats, 0.9, 0);
          showGizmo(1, 0, 0);
        }
      } else {
        // Steps 2–3: back to the app's real view; the matrices go into a buffer.
        Object.assign(state, { rot: 1, view: 0, proj: 0 });
        active = 3;
        frameAt([0, 0, 0], 1, 0);
        showGizmo(0, 0);
        const uboAt = s === 2 ? uboHome : slotPos.clone().add(new Vector3(-0.26, -0.02, 0.12));
        const k = s === 2 ? 0.72 : 0.2;
        if (animate && prev === 2 && s === 3) {
          ms.tween(ubo.position, { x: uboAt.x, y: uboAt.y, z: uboAt.z, duration: dur(1.0), ease: 'power3.inOut' });
          ms.tween(ubo.scale, { x: k, y: k, z: k, duration: dur(1.0), ease: 'power3.inOut' });
        } else {
          ubo.position.copy(uboAt);
          ubo.scale.setScalar(k);
        }
        ubo.children.forEach((c) => {
          if (c instanceof CSS2DObject) c.visible = s === 2;
        });
        cells.forEach((c) => ((c.material as MeshBasicMaterial).opacity = s === 2 ? 0.35 : 0.8));
        if (motion) {
          tl = gsap.timeline({ repeat: -1 });
          if (s === 2) {
            // memcpy: the 16 vec4 rows are written in order, every frame.
            cells.forEach((c, i) => {
              tl!.to(c.material, { opacity: 1, duration: dur(0.08) }, 0.3 + i * 0.09);
              tl!.to(c.material, { opacity: 0.35, duration: dur(0.6) }, 0.4 + i * 0.09);
            });
            tl.set({}, {}, 3.2);
          } else {
            tl.call(() => beam.progress(0, 0), [], animate ? 1.0 : 0);
            tl.call(() => beam.progress(1, 1.6), [], (animate ? 1.0 : 0) + 0.05);
            tl.call(() => {
              ms.sweep('shaded', 'shaded', 0.9);
              ms.material.uniforms.uSweepColor.value.set(COLORS.green);
            }, [], (animate ? 1.0 : 0) + 1.5);
            tl.set({}, {}, (animate ? 1.0 : 0) + 2.8);
          }
        } else beam.progress(1, 0);
      }
      apply();
      hooks.matrices?.(cur, active);
    },
    destroy() {
      stopLoop();
      gsap.killTweensOf(state);
      ms.destroy();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Real data: the matrices live, their bytes and where they get bound   */
/* ------------------------------------------------------------------ */
function dataVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const api = ctx.state.api;
  const m = matrices(api, SHOWCASE_ROT_Y, ASPECT, undefined, SHOWCASE_ROT_X);
  const list = [m.model, m.view, m.proj, m.mvp];
  const cam = DEFAULT_CAMERA;

  // ---- Panel 1: the four matrices, live.
  const subs = [`rotY ${SHOWCASE_ROT_Y} · rotX ${SHOWCASE_ROT_X}`, `eye (${cam.eye.join(', ')})`, `fov ${cam.fovY}° · ${ASPECT.toFixed(3)} · ${cam.near}–${cam.far}`, 'proj × view × model'];
  const mEls = list.map((mm) => matrixEl(mm, 3));
  const mCells = mEls.map((el) => Array.from(el.children) as HTMLElement[]);
  const mCards = list.map((_, i) =>
    h(`div.ds-mcard.${MCLS[i]}`, {}, [h('div.ds-mh', {}, [h('b', { text: ['M', 'V', 'P', 'MVP'][i] }), ` ${NAMES[i]}`, h('span.ds-msub', { text: subs[i] })]), mEls[i]]),
  );
  const tri = ctx.derived.showcaseTriangle(api);
  const vi = ctx.derived.triangleVertices(tri)[0];
  const vs = runVertex(api, ctx.derived.position(vi), m, 1920, 1080);
  const z = zRange(api);
  const matStats = h('div.stat-row', {}, [
    stat(num(vs.ndc[2], 3), t(L(`NDC z, vertex ${vi}`, `NDC z, vertex ${vi}`)), 'glow-cyan'),
    stat(`[${num(z.near, 0)}, ${num(z.far, 0)}]`, t(L('z-intervall', 'z range')), 'glow-amber'),
  ]);
  const matPanel = h('div', {}, [h('div.ds-mats', {}, mCards), matStats]);

  // ---- Panel 1b: the projection per API, and one vertex through the MVP.
  const cmpRows = API_LIST.map((a) => {
    const zz = zRange(a.id);
    return h(`tr${a.id === api ? '.me' : ''}`, {}, [
      h('td', { text: a.label }),
      h(`td.mono${a.id === 'vulkan' ? '.neg' : ''}`, { text: num(zz.p11, 3) }),
      h('td.mono', { text: num(zz.p22, 3) }),
      h('td.mono', { text: `${num(zz.near, 0)} → ${num(zz.far, 0)}` }),
      h('td', { text: a.id === 'vulkan' ? 'y ↓' : 'y ↑' }),
    ]);
  });
  const projPanel = h('div', {}, [
    h('table.ds-cmp', {}, [h('thead', {}, [h('tr', {}, ['API', 'P[1][1]', 'P[2][2]', 'near → far', 'y'].map((x) => h('th', { text: x })))]), h('tbody', {}, cmpRows)]),
    h('div.ds-check', {}, [
      h('span.k', { text: `v${vi} object` }),
      vecEl(vs.object, 3, 'c-pos'),
      h('span.k', { text: 'MVP · p = clip' }),
      vecEl(vs.clip, 3),
      h('span.k', { text: 'clip / w = NDC' }),
      vecEl(vs.ndc, 3, 'glow-cyan'),
    ]),
  ]);

  // ---- Panel 2: the real bytes, 16 B (one vec4 column) per row.
  const bytes = uboBytes(list);
  const rowsEl: HTMLElement[] = [];
  for (let r = 0; r < 16; r++) {
    const mi = r >> 2;
    const cells: HTMLElement[] = [];
    for (let b = 0; b < 16; b++) {
      const c = h(`span.mem-cell.ds-b.${MCLS[mi]}`, { text: bytes[r * 16 + b].toString(16).padStart(2, '0') });
      if (b % 4 === 3) c.classList.add('w');
      cells.push(c);
    }
    rowsEl.push(h('div.mem-row', {}, [h('span.mem-addr', { text: '+0x' + (r * 16).toString(16).padStart(2, '0') }), ...cells]));
  }
  const first = Array.from(bytes.subarray(0, 4), (b) => b.toString(16).padStart(2, '0')).join(' ');
  const notes: Record<ApiId, Text> = {
    opengl: L('<b>std140</b>: mat4 = 4 kolumner × vec4 = 64 B, kolumnordning – <code>glNamedBufferSubData</code> kopierar som det är.', '<b>std140</b>: mat4 = 4 columns × vec4 = 64 B, column-major – <code>glNamedBufferSubData</code> copies it as is.'),
    vulkan: L('<b>std140</b>, 64 B per mat4. Per-frame-offset f × 256 måste vara en multipel av <code>minUniformBufferOffsetAlignment</code>.', '<b>std140</b>, 64 B per mat4. The per-frame offset f × 256 must be a multiple of <code>minUniformBufferOffsetAlignment</code>.'),
    d3d12: L('En CBV måste vara <b>256 B</b>-justerad – här exakt 256 B. HLSL läser <code>float4x4</code> som <code>column_major</code>.', 'A CBV must be <b>256-byte</b> aligned – here exactly 256 B. HLSL reads <code>float4x4</code> as <code>column_major</code>.'),
  };
  const bytePanel = h('div', {}, [
    h('div.stat-row', {}, [stat(`${UBO_SIZE} B`, api === 'd3d12' ? 'cbuffer' : 'uniform block', 'glow-cyan'), stat(`${FRAMES} × ${UBO_SIZE} B`, t(L('en kopia per frame', 'one copy per frame')), 'glow-magenta')]),
    h('div.ds-segs', {}, NAMES.map((n, i) => h(`span.ds-seg.${MCLS[i]}`, {}, [h('b', { text: n }), ` ${i * 64}–${i * 64 + 63}`]))),
    h('div.v-scroll.ds-dump', {}, [h('div.mem', {}, rowsEl)]),
    h('div.ds-dec', {}, [h('code', { text: `+0x00: ${first}` }), h('span', { text: ' → float32 LE → ' }), h('code.glow-cyan', { text: `model[0][0] = ${m.model.elements[0].toFixed(6)}` })]),
    h('p.ds-note', { html: t(notes[api]) }),
  ]);

  // ---- Panel 3: buffer → slot → shader.
  const chainFor: Record<ApiId, [string, string][]> = {
    opengl: [
      ['GL buffer (UBO)', `glNamedBufferSubData · ${UBO_SIZE} B`],
      ['glBindBufferBase', 'GL_UNIFORM_BUFFER, 0, ubo'],
      ['binding point 0', t(L('global tabell i kontexten', 'global table in the context'))],
      ['layout(binding = 0)', 'uniform Transforms { … }'],
    ],
    vulkan: [
      ['VkBuffer', `UNIFORM_BUFFER · ${FRAMES} × ${UBO_SIZE} B`],
      ['VkDescriptorSet', `binding 0 → { ubo, f × 256, ${UBO_SIZE} }`],
      ['vkCmdBindDescriptorSets', 'layout, firstSet = 0'],
      ['layout(set = 0, binding = 0)', 'uniform Transforms { … }'],
    ],
    d3d12: [
      ['ID3D12Resource', `UPLOAD heap · ${FRAMES} × ${UBO_SIZE} B`],
      [t(L('rotparameter 0', 'root parameter 0')), 'root CBV (2 DWORDs)'],
      ['SetGraphicsRootConstantBufferView', '0, gpuVA + f × 256'],
      ['register(b0)', 'cbuffer Transforms { … }'],
    ],
  };
  const alt: Record<ApiId, Text> = {
    opengl: L('Gamla sättet: <code>glGetUniformLocation</code> + <code>glUniformMatrix4fv(loc, 1, GL_FALSE, mvp)</code>.', 'The old way: <code>glGetUniformLocation</code> + <code>glUniformMatrix4fv(loc, 1, GL_FALSE, mvp)</code>.'),
    vulkan: L('Alternativ: <code>vkCmdPushConstants</code> – 128 B (mvp + model) direkt i kommandobufferten.', 'Alternative: <code>vkCmdPushConstants</code> – 128 B (mvp + model) straight into the command buffer.'),
    d3d12: L('Alternativ: en deskriptortabell i en CBV-heap, eller root constants (1 DWORD per 32 bitar, max 64).', 'Alternative: a descriptor table into a CBV heap, or root constants (1 DWORD per 32 bits, max 64).'),
  };
  const chainEls = chainFor[api].map(([a, b], i) => h(`div.ds-node${i === (api === 'opengl' ? 2 : 1) ? '.slot' : ''}`, {}, [h('div.t', { text: a.replace(/([a-z])([A-Z])/g, '$1​$2') }), h('div.s', { text: b })]));
  const bindPanel = h('div', {}, [
    h('div.stat-row', {}, [stat(api === 'd3d12' ? 'b0' : 'binding 0', t(L('slot i shadern', 'slot in the shader')), 'glow-green'), stat(api === 'vulkan' ? 'set 0' : api === 'd3d12' ? '2 DWORD' : 'global', api === 'vulkan' ? 'descriptor set' : api === 'd3d12' ? 'root CBV' : t(L('bindningstabell', 'binding table')), 'glow-amber')]),
    h('div.ds-chain', {}, chainEls),
    h('p.ds-note', { html: t(alt[api]) }),
  ]);

  const titles = [t(L('Matriserna – live', 'The matrices – live')), t(L('Projektionen per API', 'The projection per API')), `${api === 'd3d12' ? 'cbuffer Transforms : register(b0)' : 'uniform Transforms'} · ${t(L('verkliga bytes', 'real bytes'))}`, t(L('Från buffert till shader', 'From buffer to shader'))];
  const sc = mvpScene(host, ctx, false, {
    matrices: (cur, active) => {
      [cur.model, cur.view, cur.proj, cur.mvp].forEach((mm, i) => {
        const r = rows(mm).flat();
        mCells[i].forEach((c, k) => (c.textContent = num(r[k], 3)));
        mCards[i].classList.toggle('on', i === active);
      });
    },
  });
  const ms = sc.ms;
  const pMat = ms.panel(titles[0], [matPanel], { className: 'ds-p' });
  const pProj = ms.panel(titles[1], [projPanel], { className: 'ds-p' });
  const pBytes = ms.panel(titles[2], [bytePanel], { className: 'ds-p' });
  const pBind = ms.panel(titles[3], [bindPanel], { className: 'ds-p' });
  const pCells = mCells[2];

  return {
    show(step, animate) {
      pMat.style.display = step <= 1 ? '' : 'none';
      pProj.style.display = step === 1 ? '' : 'none';
      pBytes.style.display = step === 2 ? '' : 'none';
      pBind.style.display = step === 3 ? '' : 'none';
      mCards.forEach((c, i) => (c.style.display = step === 1 && i < 2 ? 'none' : ''));
      [5, 10, 11].forEach((i) => pCells[i].classList.toggle('hl', step === 1));
      pCells[5].classList.toggle('flip', step === 1 && api === 'vulkan');
      const shown = [pMat, pProj, pBytes, pBind].filter((p) => p.style.display !== 'none');
      if (animate) gsap.fromTo(shown, { opacity: 0, x: 14 }, { opacity: 1, x: 0, duration: dur(0.4) });
      if (animate && step === 2) gsap.fromTo(rowsEl, { opacity: 0, x: -10 }, { opacity: 1, x: 0, stagger: 0.04, duration: dur(0.25) });
      if (animate && step === 3) gsap.fromTo(chainEls, { opacity: 0, y: 8 }, { opacity: 1, y: 0, stagger: 0.12, duration: dur(0.35) });
      sc.show(step, animate);
    },
    destroy() {
      gsap.killTweensOf([pMat, pProj, pBytes, pBind, ...rowsEl, ...chainEls]);
      sc.destroy();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Concept: the same transforms, explained                              */
/* ------------------------------------------------------------------ */
function conceptVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const api = ctx.state.api;
  const captions = [
    L('<b>Model</b> vrider modellen på plats (axlarna följer med). <b>View</b> flyttar hela världen så att kameran hamnar i origo och tittar längs −z.', '<b>Model</b> turns the model into place (the axes follow). <b>View</b> moves the whole world so the camera ends up at the origin looking down −z.'),
    L('<b>Projection</b> klämmer ihop synfältet till en låda: OpenGL z ∈ [−1, 1], D3D12 och Vulkan z ∈ [0, 1] – och i Vulkan vänds y.', '<b>Projection</b> squashes the field of view into a box: OpenGL z ∈ [−1, 1], D3D12 and Vulkan z ∈ [0, 1] – and in Vulkan y is flipped.'),
    L('CPU:n packar matriserna byte för byte i en buffert med en fast layout – här skrivs de 16 vec4-raderna varje frame.', 'The CPU packs the matrices byte by byte into a buffer with a fixed layout – here the 16 vec4 rows are written every frame.'),
    L('Bufferten kopplas till en numrerad slot. Shadern läser från samma nummer – det är hela kontraktet.', 'The buffer is plugged into a numbered slot. The shader reads from the same number – that is the whole contract.'),
  ];
  const caption = h('p.ds-caption');
  const variants = h('div.dsc-variants', {}, API_LIST.map((a) => {
    const z = zRange(a.id);
    return h(`div.dsc-var${a.id === api ? '.me' : ''}`, {}, [
      h('span.n', { text: a.label }),
      h('span.bar', {}, [h('span.fill', { style: { left: `${((z.near + 1) / 2) * 100}%`, right: `${((1 - z.far) / 2) * 100}%` } })]),
      h('span.r', { text: a.id === 'opengl' ? '[−1, 1]' : '[0, 1]' }),
      h('span.y', { text: a.id === 'vulkan' ? 'y ↓' : 'y ↑' }),
    ]);
  }));
  const sc = mvpScene(host, ctx, true, {});
  const ms = sc.ms;
  ms.panel(t(L('Vad händer', 'What happens')), [caption], { side: 'bottom', className: 'ds-cap' });
  const varPanel = ms.panel(t(L('Djup per API', 'Depth per API')), [variants], { side: 'bottom', className: 'ds-var' });
  return {
    show(step, animate) {
      caption.innerHTML = t(captions[step]);
      varPanel.style.display = step === 1 ? '' : 'none';
      if (animate) gsap.fromTo(caption, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: dur(0.35) });
      sc.show(step, animate);
    },
    destroy() {
      gsap.killTweensOf(caption);
      sc.destroy();
    },
  };
}

/* ------------------------------------------------------------------ */
/* API panels                                                          */
/* ------------------------------------------------------------------ */
function apis(): Record<ApiId, ApiPanelSpec> {
  return {
    opengl: {
      note: L(
        'OpenGL: en uniform buffer (UBO) kopplas till en numrerad binding point med glBindBufferBase. Shaderns layout(binding = 0) läser därifrån. Enskilda uniforms kan också sättas med glUniform*.',
        'OpenGL: a uniform buffer (UBO) is attached to a numbered binding point with glBindBufferBase. The shader’s layout(binding = 0) reads from there. Single uniforms can also be set with glUniform*.',
      ),
      code: [
        {
          lang: 'cpp',
          src: `struct Transforms { float model[16], view[16], proj[16], mvp[16]; };  // 256 B
Transforms tr = computeTransforms(camera, aspect);   // MVP = P * V * M
GLuint ubo;
glCreateBuffers(1, &ubo);
glNamedBufferStorage(ubo, sizeof(Transforms), nullptr, GL_DYNAMIC_STORAGE_BIT);
// every frame: column-major floats = the std140 layout of the block
glNamedBufferSubData(ubo, 0, sizeof(Transforms), &tr);
glBindBufferBase(GL_UNIFORM_BUFFER, 0, ubo);          // binding point 0
// GLSL: layout(std140, binding = 0) uniform Transforms { ... };
// the old way, for a plain "uniform mat4 mvp;" (no block):
GLint loc = glGetUniformLocation(prog, "mvp");
glUniformMatrix4fv(loc, 1, GL_FALSE, tr.mvp);          // GL_FALSE = no transpose`,
          highlight: [[1, 2], [2], [1, 5, 6, 7], [8, 9, 11, 12]],
        },
      ],
      terms: [
        { term: 'UBO', desc: L('Uniform Buffer Object – en buffert med shaderkonstanter.', 'Uniform Buffer Object – a buffer of shader constants.') },
        { term: 'binding point', desc: L('Numrerad global slot som UBO:er kopplas till.', 'Numbered global slot that UBOs are attached to.') },
        { term: 'std140', desc: L('Fast minneslayout: vec4-justering, mat4 = 64 B.', 'Fixed memory layout: vec4 alignment, mat4 = 64 B.') },
      ],
      you: L('räknar matriser, fyller och binder UBO:n', 'compute matrices, fill and bind the UBO'),
      driver: L('versionerar bufferten bakom kulisserna', 'versions the buffer behind the scenes'),
    },
    vulkan: {
      note: L(
        'Vulkan: shadern deklarerar set + binding. Du beskriver det med en VkDescriptorSetLayout, allokerar ett descriptor set ur en pool, pekar det på bufferten och binder setet vid inspelning. Små data kan gå som push constants.',
        'Vulkan: the shader declares set + binding. You describe that with a VkDescriptorSetLayout, allocate a descriptor set from a pool, point it at the buffer and bind the set while recording. Small data can go as push constants.',
      ),
      code: [
        {
          lang: 'cpp',
          src: `VkDescriptorSetLayoutBinding b{ 0, VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, 1, VK_SHADER_STAGE_VERTEX_BIT };
VkDescriptorSetLayoutCreateInfo lci{ VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO };
lci.bindingCount = 1;  lci.pBindings = &b;
vkCreateDescriptorSetLayout(device, &lci, nullptr, &setLayout);
VkDescriptorPoolSize size{ VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, ${FRAMES} };
VkDescriptorPoolCreateInfo pci{ VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO };
pci.maxSets = ${FRAMES};  pci.poolSizeCount = 1;  pci.pPoolSizes = &size;
vkCreateDescriptorPool(device, &pci, nullptr, &pool);
VkDescriptorSetAllocateInfo ai{ VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO };
ai.descriptorPool = pool;  ai.descriptorSetCount = 1;  ai.pSetLayouts = &setLayout;
vkAllocateDescriptorSets(device, &ai, &set[f]);
VkDescriptorBufferInfo bi{ ubo, f * ${UBO_SIZE}, ${UBO_SIZE} };          // buffer, offset, range
VkWriteDescriptorSet w{ VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET };
w.dstSet = set[f];  w.dstBinding = 0;  w.descriptorCount = 1;
w.descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER;  w.pBufferInfo = &bi;
vkUpdateDescriptorSets(device, 1, &w, 0, nullptr);
// every frame, while recording frame f:
memcpy(mapped + f * ${UBO_SIZE}, &tr, ${UBO_SIZE});                // std140 bytes
vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, pipelineLayout,
                        0, 1, &set[f], 0, nullptr);               // firstSet = 0
// or push constants: 128 B always available = mvp + model
vkCmdPushConstants(cmd, pipelineLayout, VK_SHADER_STAGE_VERTEX_BIT, 0, 128, &pc);`,
          highlight: [[18], [18], [12, 18], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 19, 20, 21, 22]],
        },
      ],
      terms: [
        { term: 'VkDescriptorSetLayout', desc: L('Beskriver vilka bindings ett set har (typ, antal, steg).', 'Describes which bindings a set has (type, count, stages).') },
        { term: 'VkDescriptorSet', desc: L('Själva "tabellen" med pekare till resurser.', 'The actual "table" of pointers to resources.') },
        { term: 'push constants', desc: L('Små värden direkt i kommandobufferten, minst 128 B.', 'Small values directly in the command buffer, at least 128 B.') },
        { term: 'minUniformBufferOffsetAlignment', desc: L('Justeringskrav för offset i en UBO (högst 256).', 'Alignment requirement for UBO offsets (at most 256).') },
      ],
      you: L('layout, pool, set, uppdatering, bindning', 'layout, pool, set, update, bind'),
      driver: L('skriver deskriptorerna i GPU-format', 'writes descriptors in the GPU’s format'),
    },
    d3d12: {
      note: L(
        'D3D12: en rotsignatur listar shaderns parametrar. Här är parameter 0 en root CBV kopplad till register(b0) – du ger bara GPU-adressen. Alternativen är en deskriptortabell i en CBV-heap eller root constants.',
        'D3D12: a root signature lists the shader’s parameters. Here parameter 0 is a root CBV bound to register(b0) – you just pass the GPU address. The alternatives are a descriptor table into a CBV heap, or root constants.',
      ),
      code: [
        {
          lang: 'cpp',
          src: `CD3DX12_ROOT_PARAMETER1 param;
param.InitAsConstantBufferView(0);                 // root CBV → register(b0)
CD3DX12_VERSIONED_ROOT_SIGNATURE_DESC rsDesc;
rsDesc.Init_1_1(1, &param, 0, nullptr,
    D3D12_ROOT_SIGNATURE_FLAG_ALLOW_INPUT_ASSEMBLER_INPUT_LAYOUT);
ComPtr<ID3DBlob> blob, error;
D3DX12SerializeVersionedRootSignature(&rsDesc, D3D_ROOT_SIGNATURE_VERSION_1_1, &blob, &error);
device->CreateRootSignature(0, blob->GetBufferPointer(), blob->GetBufferSize(), IID_PPV_ARGS(&rootSig));
// upload heap: ${FRAMES} frames × ${UBO_SIZE} B (CBVs are 256-byte aligned)
auto heapProps = CD3DX12_HEAP_PROPERTIES(D3D12_HEAP_TYPE_UPLOAD);
auto bufDesc   = CD3DX12_RESOURCE_DESC::Buffer(${FRAMES} * ${UBO_SIZE});
device->CreateCommittedResource(&heapProps, D3D12_HEAP_FLAG_NONE, &bufDesc,
    D3D12_RESOURCE_STATE_GENERIC_READ, nullptr, IID_PPV_ARGS(&cb));
cb->Map(0, nullptr, reinterpret_cast<void**>(&mapped));   // stays mapped
// every frame f:
memcpy(mapped + f * ${UBO_SIZE}, &tr, ${UBO_SIZE});        // column_major floats
cmdList->SetGraphicsRootSignature(rootSig.Get());
cmdList->SetGraphicsRootConstantBufferView(0, cb->GetGPUVirtualAddress() + f * ${UBO_SIZE});
// alternatives: SetGraphicsRootDescriptorTable(0, cbvHeapGpuHandle)
//               SetGraphicsRoot32BitConstants(0, 16, &tr.mvp, 0)`,
          highlight: [[16], [16], [9, 10, 11, 12, 13, 16], [1, 2, 3, 4, 5, 17, 18, 19, 20]],
        },
      ],
      terms: [
        { term: 'root signature', desc: L('Listan över shaderns parametrar – högst 64 DWORDs.', 'The list of shader parameters – at most 64 DWORDs.') },
        { term: 'root CBV', desc: L('GPU-adress direkt i rotsignaturen, kostar 2 DWORDs.', 'GPU address directly in the root signature, costs 2 DWORDs.') },
        { term: 'CBV heap', desc: L('Shader-synlig deskriptor-heap för deskriptortabeller.', 'Shader-visible descriptor heap for descriptor tables.') },
        { term: 'row_major', desc: L('HLSL-modifierare – standard är column_major.', 'HLSL modifier – the default is column_major.') },
      ],
      you: L('rotsignatur, uppladdning, bindning', 'root signature, upload, bind'),
      driver: L('läser CBV-adressen vid draw', 'reads the CBV address at draw'),
    },
  };
}

export default standardSlide({
  id: 'descriptors',
  group: 'api',
  short: L('Uniforms', 'Uniforms'),
  title: L('Uniforms & deskriptorer', 'Uniforms & descriptors'),
  lead: L(
    'Vertexshadern behöver matriserna som placerar modellen på skärmen. De räknas ut på CPU:n, packas i en buffert och kopplas till en numrerad plats som shadern läser från.',
    'The vertex shader needs the matrices that put the model on screen. They are computed on the CPU, packed into a buffer and attached to a numbered slot the shader reads from.',
  ),
  bullets: [
    L('Fyra matriser: <b>model</b> (modellens rotation), <b>view</b> (kameran), <b>projection</b> (perspektivet) och <b>MVP</b> = P × V × M.', 'Four matrices: <b>model</b> (the model’s rotation), <b>view</b> (the camera), <b>projection</b> (perspective) and <b>MVP</b> = P × V × M.'),
    L('Projektionen beror på API:t: OpenGL ger z ∈ [−1, 1], D3D12 och Vulkan z ∈ [0, 1] – och i Vulkan pekar y nedåt, så y vänds i matrisen.', 'The projection depends on the API: OpenGL gives z ∈ [−1, 1], D3D12 and Vulkan z ∈ [0, 1] – and in Vulkan y points down, so y is flipped in the matrix.'),
    L('Bytes i en buffert: <b>std140</b>, 64 B per mat4, kolumnordning. D3D12 kräver att konstantbuffertar är <b>256 B-justerade</b>.', 'Bytes in a buffer: <b>std140</b>, 64 B per mat4, column-major. D3D12 requires constant buffers to be <b>256-byte aligned</b>.'),
    L('Bindning: GL <code>glBindBufferBase</code>, Vulkan <b>descriptor sets</b> (eller push constants), D3D12 en <b>rotsignatur</b> med root CBV eller deskriptortabell.', 'Binding: GL <code>glBindBufferBase</code>, Vulkan <b>descriptor sets</b> (or push constants), D3D12 a <b>root signature</b> with a root CBV or descriptor table.'),
  ],
  api: apis(),
  data: dataVisual,
  concept: conceptVisual,
});
