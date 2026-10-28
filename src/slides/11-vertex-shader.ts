import gsap from 'gsap';
import {
  AdditiveBlending,
  ArrowHelper,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  Group,
  Line,
  LineBasicMaterial,
  LineSegments,
  Matrix3,
  MeshBasicMaterial,
  Matrix4,
  Points,
  PointsMaterial,
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
import { BASE_COLOR } from '../pipeline/shade';
import { DEFAULT_CAMERA, matrices, modelMatrix, projectionMatrix, runVertex, viewMatrix, type Camera } from '../pipeline/transform';
import type { StageView } from '../views/ThreeStage';
import { COLORS, disposeScene, label, makeScene, shadedMesh, starfield, wireframe } from '../views/three-helpers';
import { matrixEl } from '../views/widgets';
import { standardSlide } from './standard';
import type { ApiPanelSpec, SlideContext, Visual } from './types';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
const ASPECT = 1.6; // the 160 × 100 software render every data slide shares
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const hdr = (hex: number, k: number) => new Color(hex).multiplyScalar(k);
const ease = (x: number) => x * x * (3 - 2 * x);

function glowTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.22, 'rgba(255,255,255,0.85)');
  gr.addColorStop(0.5, 'rgba(255,255,255,0.25)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  return new CanvasTexture(c);
}

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

/** RGB axes with labels. */
function axes(len: number, opacity: number, names: [string, string, string], tag: string) {
  const g = new Group();
  const cols = [COLORS.red, COLORS.green, COLORS.cyan];
  const dirs = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];
  const mats: LineBasicMaterial[] = [];
  const labels: CSS2DObject[] = [];
  dirs.forEach((d, i) => {
    const m = new LineBasicMaterial({ color: hdr(cols[i], 1.6), transparent: true, opacity });
    mats.push(m);
    g.add(new Line(new BufferGeometry().setFromPoints([new Vector3(), d.clone().multiplyScalar(len)]), m));
    const lb = label(names[i], 'vs-axis');
    lb.element.style.color = '#' + new Color(cols[i]).getHexString();
    lb.position.copy(d.clone().multiplyScalar(len * 1.08));
    g.add(lb);
    labels.push(lb);
  });
  const tagLabel = label(tag, 'vs-tag');
  tagLabel.position.set(len * 0.1, -len * 0.18, 0);
  g.add(tagLabel);
  labels.push(tagLabel);
  return {
    group: g,
    set(k: number) {
      mats.forEach((m) => (m.opacity = 0.12 + 0.88 * k));
      labels.forEach((l) => (l.element.style.opacity = String(0.15 + 0.85 * k)));
    },
  };
}

/** Frustum corners (near quad, far quad) in world space for a camera pose. */
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

/** 12 edges of a frustum / box given 8 corners (near 0–3, far 4–7) + 4 apex lines. */
const BOX_EDGES = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];

/* ------------------------------------------------------------------ */
/* Real data                                                           */
/* ------------------------------------------------------------------ */
function dataVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const api = ctx.state.api;
  const mesh = ctx.state.mesh;
  const tri = ctx.derived.showcaseTriangle(api);
  const vIdx = ctx.derived.triangleVertices(tri)[0];
  const p = ctx.derived.position(vIdx);
  const n = ctx.derived.normal(vIdx);
  const mats = matrices(api, SHOWCASE_ROT_Y, ASPECT, undefined, SHOWCASE_ROT_X);
  const st = runVertex(api, p, mats, 160, 100);
  const nm = new Matrix3().getNormalMatrix(mats.model);
  const nWorld = new Vector3(...n).applyMatrix3(nm).normalize();
  const cam = DEFAULT_CAMERA;

  /* ---------- 3D scene ---------- */
  const { scene, camera } = makeScene();
  camera.position.set(5.2, 2.5, 2.6);
  camera.lookAt(0, 0, 0);
  const tex = glowTexture();
  scene.add(starfield(500));
  const model = new Group();
  model.matrixAutoUpdate = false;
  const solid = shadedMesh(mesh, [BASE_COLOR[0] * 0.55, BASE_COLOR[1] * 0.55, BASE_COLOR[2] * 0.6]);
  const wire = wireframe(mesh, COLORS.violet, 0.12);
  model.add(solid, wire);
  const objAxes = axes(1.25, 1, ['x', 'y', 'z'], 'object');
  model.add(objAxes.group);
  scene.add(model);
  const worldAxes = axes(1.9, 1, ['X', 'Y', 'Z'], 'world');
  scene.add(worldAxes.group);

  // Camera gizmo: axes in camera orientation + frustum (far cut for display).
  const camGroup = new Group();
  const vInv = viewMatrix(cam).clone().invert();
  camGroup.matrixAutoUpdate = false;
  camGroup.matrix.copy(vInv);
  const camAxes = axes(0.55, 1, ['x', 'y', 'z'], 'camera');
  camGroup.add(camAxes.group);
  scene.add(camGroup);
  const DISP_FAR = 5.2;
  const corners = frustumCorners(cam, ASPECT, DISP_FAR);
  const eye = new Vector3(...cam.eye);
  const fPts: Vector3[] = BOX_EDGES.map((i) => corners[i]);
  for (let i = 0; i < 4; i++) fPts.push(eye, corners[i]);
  const frMat = new LineBasicMaterial({ color: hdr(COLORS.amber, 1.4), transparent: true, opacity: 0.2 });
  const frustum = new LineSegments(new BufferGeometry().setFromPoints(fPts), frMat);
  scene.add(frustum);
  const farLabel = label(`far = ${cam.far} →`, 'vs-tag');
  farLabel.position.copy(corners[5]);
  const nearLabel = label(`near = ${cam.near}`, 'vs-tag');
  nearLabel.position.copy(corners[1]);
  scene.add(farLabel, nearLabel);

  // The vertex.
  const vSprite = new Sprite(new SpriteMaterial({ map: tex, color: hdr(COLORS.cyan, 3), transparent: true, depthTest: false, blending: AdditiveBlending }));
  vSprite.renderOrder = 20;
  scene.add(vSprite);
  const vLabel = label(`v${vIdx}`, 'cyan big');
  scene.add(vLabel);
  // Object-space position vector (from model origin) and view ray (from eye).
  const posLineGeo = new BufferGeometry().setFromPoints([new Vector3(), new Vector3()]);
  const posLine = new Line(posLineGeo, new LineBasicMaterial({ color: hdr(COLORS.cyan, 1.6), transparent: true, opacity: 0 }));
  const rayGeo = new BufferGeometry().setFromPoints([new Vector3(), new Vector3()]);
  const ray = new Line(rayGeo, new LineBasicMaterial({ color: hdr(COLORS.amber, 2), transparent: true, opacity: 0, depthTest: false }));
  const nearDot = new Sprite(new SpriteMaterial({ map: tex, color: hdr(COLORS.amber, 3), transparent: true, opacity: 0, depthTest: false, blending: AdditiveBlending }));
  nearDot.scale.setScalar(0.12);
  posLine.frustumCulled = false;
  ray.frustumCulled = false;
  scene.add(posLine, ray, nearDot);
  const arrow = new ArrowHelper(nWorld, new Vector3(), 0.75, COLORS.magenta, 0.16, 0.09);
  (arrow.line.material as LineBasicMaterial).color = hdr(COLORS.magenta, 2.2);
  // Draw on top: from the observer's angle the vertex may sit on the far side of the model.
  for (const m of [arrow.line.material, arrow.cone.material] as (LineBasicMaterial | MeshBasicMaterial)[]) m.depthTest = false;
  arrow.line.renderOrder = arrow.cone.renderOrder = 21;
  scene.add(arrow);
  const nLabel = label('n', 'magenta');
  scene.add(nLabel);

  // Center the interesting region (model → camera) on the orbit pivot.
  const root = new Group();
  for (const c of [...scene.children]) if (!(c instanceof Points)) root.add(c);
  root.position.set(0, -0.35, -1.45);
  scene.add(root);

  const P = { rot: 0, obj: 1, world: 0, cam: 0, clip: 0, nrm: 0 };
  const objP = new Vector3(...p);
  const view: StageView = {
    scene,
    camera,
    bloom: 0.85,
    bloomThreshold: 0.8,
    orbit: true,
    onFrame: (time) => {
      const M = modelMatrix(P.rot * SHOWCASE_ROT_Y, P.rot * SHOWCASE_ROT_X);
      model.matrix.copy(M);
      model.matrixWorldNeedsUpdate = true;
      const wp = objP.clone().applyMatrix4(M);
      const pulse = 0.5 + 0.5 * Math.sin(time * 4);
      vSprite.position.copy(wp);
      vSprite.scale.setScalar(0.16 + 0.05 * pulse);
      vLabel.position.copy(wp).add(new Vector3(0, -0.17, 0));
      objAxes.set(P.obj);
      worldAxes.set(P.world);
      camAxes.set(P.cam);
      frMat.opacity = 0.1 + 0.65 * Math.max(P.cam * 0.6, P.clip);
      farLabel.element.style.opacity = nearLabel.element.style.opacity = String(Math.max(P.cam * 0.5, P.clip));
      posLineGeo.setFromPoints([new Vector3(), wp]);
      (posLine.material as LineBasicMaterial).opacity = P.obj * 0.9;
      rayGeo.setFromPoints([eye, wp]);
      (ray.material as LineBasicMaterial).opacity = Math.max(P.cam, P.clip) * 0.9;
      // Where the ray to the vertex crosses the near plane (the "projection").
      const dView = -st.view[2];
      nearDot.position.copy(eye.clone().lerp(wp, cam.near / dView));
      (nearDot.material as SpriteMaterial).opacity = P.clip * (0.7 + 0.3 * pulse);
      arrow.position.copy(wp);
      arrow.setDirection(new Vector3(...n).applyMatrix3(new Matrix3().getNormalMatrix(M)).normalize());
      arrow.visible = P.nrm > 0.01;
      arrow.scale.setScalar(Math.max(0.01, P.nrm));
      nLabel.position.copy(wp).addScaledVector(nWorld, 0.9);
      nLabel.element.style.opacity = String(P.nrm);
      (wire.material as LineBasicMaterial).opacity = 0.08 + 0.1 * P.obj;
    },
  };
  const stageHost = h('div.vs-3d');
  const hud = h('div.vs-hud');
  stageHost.append(hud);

  /* ---------- Equation cards ---------- */
  const op = (s: string) => h('span.vs-op', { text: s });
  const named = (name: string, el: HTMLElement, cls = '') => h(`div.vs-named${cls ? '.' + cls : ''}`, {}, [h('div.vs-name', { html: name }), el]);
  const mul = (mName: string, mEl: HTMLElement, a: { n: string; v: number[]; c: string }, b: { n: string; v: number[]; c: string }) =>
    h('div.vs-eq', {}, [named(mName, mEl, 'mat'), op('×'), named(a.n, colEl(a.v, 3, a.c)), op('='), named(b.n, colEl(b.v, 3, b.c + '.hot'))]);
  const vec = (name: string, v: readonly number[], c: string) => ({ n: name, v: [...v], c });
  const zView = st.view[2];
  const pe = mats.proj.elements;
  const projNote: Record<ApiId, L> = {
    opengl: L(
      `OpenGL: z<sub>clip</sub> = ${num(pe[10], 3)}·z + ${num(pe[14], 3)} → efter division hamnar z i [−1, 1].`,
      `OpenGL: z<sub>clip</sub> = ${num(pe[10], 3)}·z + ${num(pe[14], 3)} → after the divide z lands in [−1, 1].`,
    ),
    vulkan: L(
      `Vulkan: rad 2 är negerad (${num(pe[5], 3)}) eftersom +y pekar <b>nedåt</b> i Vulkans clip space; z hamnar i [0, 1].`,
      `Vulkan: row 2 is negated (${num(pe[5], 3)}) because +y points <b>down</b> in Vulkan clip space; z lands in [0, 1].`,
    ),
    d3d12: L(
      `D3D12 (som XMMatrixPerspectiveFovRH): z<sub>clip</sub> = ${num(pe[10], 3)}·z + ${num(pe[14], 3)} → z hamnar i [0, 1], +y uppåt.`,
      `D3D12 (like XMMatrixPerspectiveFovRH): z<sub>clip</sub> = ${num(pe[10], 3)}·z + ${num(pe[14], 3)} → z lands in [0, 1], +y up.`,
    ),
  };
  const outName = api === 'd3d12' ? 'SV_Position' : 'gl_Position';
  const cards: { title: Text; body: HTMLElement; note: Text }[] = [
    {
      title: L(`Objektrymd · vertex ${vIdx}`, `Object space · vertex ${vIdx}`),
      body: h('div.vs-eq', {}, [
        named('aPos', colEl(p, 3, 'c-pos')),
        op('→'),
        named('p<sub>obj</sub>', colEl([...p, 1], 3, 'c-pos.hot')),
        h('div.vs-side', {}, [h('div.vs-name', { text: 'aNormal' }), colEl(n, 3, 'c-nrm')]),
      ]),
      note: L(
        'Positionen som den står i vertexbufferten, relativt modellens eget origo. Med <b>w = 1</b> blir den en punkt, så förflyttningar i matriserna påverkar den.',
        'The position exactly as stored in the vertex buffer, relative to the model\'s own origin. With <b>w = 1</b> it is a point, so translations in the matrices affect it.',
      ),
    },
    {
      title: L('uModel · objekt → värld', 'uModel · object → world'),
      body: mul('uModel', matrixEl(mats.model, 3), vec('p<sub>obj</sub>', [...p, 1], 'c-pos'), vec('p<sub>world</sub>', st.world, 'c-g')),
      note: L(
        `Modellmatrisen roterar ${SHOWCASE_ROT_Y} rad kring Y och ${SHOWCASE_ROT_X} rad kring X. Ingen translation här – modellen är centrerad och normaliserad vid inläsningen.`,
        `The model matrix rotates ${SHOWCASE_ROT_Y} rad around Y and ${SHOWCASE_ROT_X} rad around X. No translation here – the model was centered and normalized on import.`,
      ),
    },
    {
      title: L('uView · värld → kamera', 'uView · world → view'),
      body: mul('uView', matrixEl(mats.view, 3), vec('p<sub>world</sub>', st.world, 'c-g'), vec('p<sub>view</sub>', st.view, 'c-a')),
      note: L(
        `Kameran står i (${cam.eye.join(', ')}) och tittar mot origo. I kamerarymd tittar kameran längs <b>−Z</b>: vertexen ligger ${num(-zView, 3)} enheter framför den (z = ${num(zView, 3)}).`,
        `The camera sits at (${cam.eye.join(', ')}) looking at the origin. In view space the camera looks down <b>−Z</b>: the vertex is ${num(-zView, 3)} units in front of it (z = ${num(zView, 3)}).`,
      ),
    },
    {
      title: L(`uProj · kamera → clip  (${outName})`, `uProj · view → clip  (${outName})`),
      body: mul('uProj', matrixEl(mats.proj, 3), vec('p<sub>view</sub>', st.view, 'c-a'), vec(outName, st.clip, 'glow-magenta')),
      note: L(
        `fov ${cam.fovY}°, aspect ${ASPECT}, near ${cam.near}, far ${cam.far}. Sista raden (0 0 −1 0) ger <b>w = −z<sub>view</sub> = ${num(st.clip[3], 3)}</b> – det perspektivdivisionen delar med. ${projNote[api].sv}`,
        `fov ${cam.fovY}°, aspect ${ASPECT}, near ${cam.near}, far ${cam.far}. The last row (0 0 −1 0) gives <b>w = −z<sub>view</sub> = ${num(st.clip[3], 3)}</b> – what the perspective divide divides by. ${projNote[api].en}`,
      ),
    },
    {
      title: L('Normalen · normalmatris', 'The normal · normal matrix'),
      body: h('div.vs-eq', {}, [
        named('N = (M<sub>3×3</sub><sup>−1</sup>)<sup>T</sup>', mat3El(nm), 'mat'),
        op('×'),
        named('n<sub>obj</sub>', colEl(n, 3, 'c-nrm')),
        op('='),
        named('n<sub>world</sub>', colEl([nWorld.x, nWorld.y, nWorld.z], 3, 'c-nrm.hot')),
      ]),
      note: L(
        'Normaler är riktningar (w = 0) och transformeras med invers-transponatet så de förblir vinkelräta även vid icke-uniform skalning. Här är M en ren rotation, så N = M<sub>3×3</sub>. Resultatet skickas vidare som varying till fragment shadern.',
        'Normals are directions (w = 0) and are transformed with the inverse transpose so they stay perpendicular even under non-uniform scale. Here M is a pure rotation, so N = M<sub>3×3</sub>. The result is passed on as a varying to the fragment shader.',
      ),
    },
  ];
  const cardEls = cards.map((c) =>
    h('div.card.vs-card', {}, [h('h4', { text: t(c.title) }), h('div.vs-eq-wrap', {}, [c.body]), h('div.vs-note', { html: t(c.note) })]),
  );
  // Summary chain of all spaces.
  const chainRows = [
    { k: 'object', v: [...p, 1] },
    { k: 'world', v: st.world },
    { k: 'view', v: st.view },
    { k: 'clip', v: st.clip },
    { k: 'normal', v: [nWorld.x, nWorld.y, nWorld.z] },
  ].map((r) => h('div.vs-chain-row', {}, [h('span.vs-chain-k', { text: r.k }), h('span.vs-chain-v.mono', { text: r.v.map((x) => num(x, 3)).join(' ') })]));
  const chain = h('div.vs-chain', {}, chainRows);
  const side = h('div.vs-side-panel.v-scroll', {}, [...cardEls, chain]);
  host.append(h('div.vs-data', {}, [stageHost, side]));
  ctx.stage.attach(stageHost, view);

  const huds: Text[] = [
    L('objektrymd – modellens egna axlar', 'object space – the model\'s own axes'),
    L('världsrymd – modellen roteras på plats', 'world space – the model is rotated into place'),
    L('kamerarymd – kameran i origo, tittar längs −Z', 'view space – camera at the origin, looking down −Z'),
    L('clip space – frustumet blir kuben efter division', 'clip space – the frustum becomes the cube after the divide'),
    L('normalen roteras med normalmatrisen', 'the normal is rotated by the normal matrix'),
  ];
  let last = -1;
  return {
    show(step, animate) {
      const fwd = animate && step > last;
      last = step;
      cardEls.forEach((c, i) => (c.style.display = i === step ? '' : 'none'));
      chainRows.forEach((r, i) => {
        r.classList.toggle('on', i <= step);
        r.classList.toggle('cur', i === step);
      });
      hud.innerHTML = t(huds[step]);
      const target = {
        rot: step >= 1 ? 1 : 0,
        obj: step === 0 ? 1 : step === 4 ? 0.3 : 0,
        world: step === 1 ? 1 : 0,
        cam: step === 2 ? 1 : 0,
        clip: step === 3 ? 1 : 0,
        nrm: step === 4 ? 1 : 0,
      };
      gsap.killTweensOf(P);
      if (fwd) {
        gsap.to(P, { ...target, duration: dur(step === 1 ? 1.6 : 0.8), ease: 'power2.inOut' });
        const c = cardEls[step];
        gsap.fromTo(c, { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: dur(0.45), ease: 'power2.out' });
        gsap.fromTo(c.querySelectorAll('.vs-col.hot span'), { opacity: 0, x: -10 }, { opacity: 1, x: 0, stagger: 0.12, delay: dur(0.3), duration: dur(0.3) });
      } else Object.assign(P, target);
    },
    destroy() {
      gsap.killTweensOf(P);
      if (ctx.stage.isAttachedTo(view)) ctx.stage.detach();
      disposeScene(scene);
      tex.dispose();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Concept: object → world → view → clip as one continuous morph       */
/* ------------------------------------------------------------------ */
function conceptVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const api = ctx.state.api;
  const mesh = ctx.state.mesh;
  const { scene, camera } = makeScene();
  const tex = glowTexture();
  const stars = starfield(600);
  scene.add(stars);

  // The concept world: the loaded model (as points), a floor grid and two crates.
  const MW = { t: new Vector3(0.35, 0, -0.5), ry: 0.9, s: 0.85 };
  const CAM: Camera = { eye: [1.75, 1.15, 2.3], target: [0.2, -0.2, -0.5], up: [0, 1, 0], fovY: 48, near: 0.8, far: 4.4 };
  const camDist = new Vector3(...CAM.eye).distanceTo(new Vector3(...CAM.target));
  const V = viewMatrix(CAM);
  const Pm = projectionMatrix(api, CAM, ASPECT);
  const vq = new Quaternion().setFromRotationMatrix(V);
  const vt = new Vector3().setFromMatrixPosition(V);
  const zMin = api === 'opengl' ? -1 : 0;
  const BOX = 1.15; // display half-size of the NDC cube

  const stride = Math.max(1, Math.floor(mesh.vertexCount / 2600));
  const objPts: Vector3[] = [];
  const objNrm: Vector3[] = [];
  for (let i = 0; i < mesh.vertexCount; i += stride) {
    objPts.push(new Vector3(mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]));
    objNrm.push(new Vector3(mesh.normals[i * 3], mesh.normals[i * 3 + 1], mesh.normals[i * 3 + 2]));
  }
  const ptsPos = new Float32Array(objPts.length * 3);
  const ptsGeo = new BufferGeometry();
  ptsGeo.setAttribute('position', new BufferAttribute(ptsPos, 3));
  const pts = new Points(ptsGeo, new PointsMaterial({ size: 0.085, map: tex, color: hdr(COLORS.cyan, 1.1), transparent: true, depthWrite: false, blending: AdditiveBlending }));
  pts.frustumCulled = false;
  scene.add(pts);

  // Line sets with world-space source points (pairs).
  const lineSet = (src: Vector3[], color: Color, opacity: number) => {
    const arr = new Float32Array(src.length * 3);
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(arr, 3));
    const mat = new LineBasicMaterial({ color, transparent: true, opacity });
    const ls = new LineSegments(g, mat);
    ls.frustumCulled = false;
    scene.add(ls);
    return { src, arr, g, mat };
  };
  const gridSrc: Vector3[] = [];
  for (let i = -3; i <= 3; i++) {
    gridSrc.push(new Vector3(i * 0.5, -1, -2.2), new Vector3(i * 0.5, -1, 1.0));
  }
  for (let k = 0; k <= 6; k++) {
    const z = -2.2 + (k * 3.2) / 6;
    gridSrc.push(new Vector3(-1.5, -1, z), new Vector3(1.5, -1, z));
  }
  const grid = lineSet(gridSrc, hdr(COLORS.violet, 1.1), 0.5);
  const crate = (c: Vector3, s: number) => {
    const out: Vector3[] = [];
    const cs = [-1, 1];
    const corner = (i: number) => new Vector3(cs[i & 1], cs[(i >> 1) & 1], cs[(i >> 2) & 1]).multiplyScalar(s).add(c);
    for (let i = 0; i < 8; i++) for (let b = 0; b < 3; b++) if (!(i & (1 << b))) out.push(corner(i), corner(i | (1 << b)));
    return out;
  };
  const crates = lineSet([...crate(new Vector3(-1.0, -0.75, -1.4), 0.25), ...crate(new Vector3(1.05, -0.8, 0.35), 0.2)], hdr(COLORS.amber, 1.3), 0.8);
  // Normal spikes (object space source: point + normal).
  const spikeN = Math.min(260, objPts.length);
  const spikeStep = Math.max(1, Math.floor(objPts.length / spikeN));
  const spikeIdx = Array.from({ length: spikeN }, (_, i) => i * spikeStep).filter((i) => i < objPts.length);
  const spikes = lineSet(new Array(spikeIdx.length * 2).fill(0).map(() => new Vector3()), hdr(COLORS.magenta, 1.15), 0);

  // Axes gizmos built as line sets so they morph with everything else.
  const axisSrc = (len: number) => [new Vector3(), new Vector3(len, 0, 0), new Vector3(), new Vector3(0, len, 0), new Vector3(), new Vector3(0, 0, len)];
  const axisColors = (k: number) => {
    const c = new Float32Array(18);
    [COLORS.red, COLORS.green, COLORS.cyan].forEach((hex, i) => {
      const col = hdr(hex, k);
      c.set([col.r, col.g, col.b, col.r, col.g, col.b], i * 6);
    });
    return c;
  };
  const axisSet = (len: number) => {
    const s = lineSet(axisSrc(len), new Color(1, 1, 1), 1);
    s.g.setAttribute('color', new BufferAttribute(axisColors(1.8), 3));
    s.mat.vertexColors = true;
    return s;
  };
  const objAxes = axisSet(0.9);
  const worldAxes = axisSet(1.6);
  const camAxes = axisSet(0.45);
  const frustum = lineSet(new Array(32).fill(0).map(() => new Vector3()), hdr(COLORS.amber, 1.6), 0.9);
  const objTag = label('object', 'vs-tag');
  const worldTag = label('world', 'vs-tag');
  const camTag = label('camera', 'vs-tag');
  const boxTagNear = label('', 'vs-tag amber');
  const boxTagFar = label('', 'vs-tag amber');
  const boxTagY = label('', 'vs-tag');
  scene.add(objTag, worldTag, camTag, boxTagNear, boxTagFar, boxTagY);

  // Observer camera.
  camera.position.set(5.6, 3.3, 5.4);
  const look = new Vector3(0.2, -0.1, 0.2);
  camera.lookAt(look);

  // Morph state: s = 0 object, 1 world, 2 view, 3 clip; fly = camera flight 0..1; nrm = normals.
  const S = { s: 0, fly: 1, nrm: 0, cam: 0 };
  const tmp = new Vector3();
  const qI = new Quaternion();
  const q = new Quaternion();
  const startEye = new Vector3(6, 4, -3);

  const modelAt = (a: number) => {
    const m = new Matrix4().compose(MW.t.clone().multiplyScalar(a), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), MW.ry * a), new Vector3(1, 1, 1).multiplyScalar(1 + (MW.s - 1) * a));
    return m;
  };
  /** World point → display point for the current s (stages ≥ 1). */
  const wIn = new Vector3();
  const boxP = new Vector3();
  const vx = new Vector3();
  const display = (w: Vector3, out: Vector3) => {
    const a2 = ease(clamp01(S.s - 1));
    const a3 = ease(clamp01(S.s - 2));
    wIn.copy(w); // `out` may alias `w`
    q.slerpQuaternions(qI, vq, a2);
    out.copy(wIn).applyQuaternion(q).addScaledVector(vt, a2); // world → (partial) view
    if (a3 > 0) {
      // Real projection with this API's conventions, then into a display cube.
      vx.copy(wIn).applyMatrix4(V);
      const c = [
        Pm.elements[0] * vx.x + Pm.elements[4] * vx.y + Pm.elements[8] * vx.z + Pm.elements[12],
        Pm.elements[1] * vx.x + Pm.elements[5] * vx.y + Pm.elements[9] * vx.z + Pm.elements[13],
        Pm.elements[2] * vx.x + Pm.elements[6] * vx.y + Pm.elements[10] * vx.z + Pm.elements[14],
        Pm.elements[3] * vx.x + Pm.elements[7] * vx.y + Pm.elements[11] * vx.z + Pm.elements[15],
      ];
      const wv = Math.max(1e-3, c[3]);
      const nx = Math.max(-1.6, Math.min(1.6, c[0] / wv));
      const ny = Math.max(-1.6, Math.min(1.6, c[1] / wv));
      const nz = Math.max(zMin - 0.3, Math.min(1.3, c[2] / wv));
      // Display: x right, y up, depth runs into the screen (−Z), box centered on the view target.
      // The box is as deep as this API's NDC z range: 2 for OpenGL, 1 for Vulkan / D3D12.
      const depthHalf = (BOX * (1 - zMin)) / 2;
      boxP.set(nx * BOX, ny * BOX, -camDist + depthHalf - ((nz - zMin) / (1 - zMin)) * 2 * depthHalf);
      out.lerp(boxP, a3);
    }
    out.z += camDist * a2; // keep the scene centered in front of the observer
    return out;
  };
  const camPose = () => {
    const e = startEye.clone().lerp(new Vector3(...CAM.eye), ease(S.fly));
    const c: Camera = { ...CAM, eye: [e.x, e.y, e.z] };
    return c;
  };

  const update = (time: number) => {
    const a1 = ease(clamp01(S.s));
    const M = modelAt(a1);
    // Points.
    for (let i = 0; i < objPts.length; i++) {
      tmp.copy(objPts[i]).applyMatrix4(M);
      display(tmp, tmp);
      ptsPos[i * 3] = tmp.x;
      ptsPos[i * 3 + 1] = tmp.y;
      ptsPos[i * 3 + 2] = tmp.z;
    }
    ptsGeo.attributes.position.needsUpdate = true;
    const upd = (set: ReturnType<typeof lineSet>, src: Vector3[], xf?: Matrix4) => {
      for (let i = 0; i < src.length; i++) {
        tmp.copy(src[i]);
        if (xf) tmp.applyMatrix4(xf);
        display(tmp, tmp);
        set.arr[i * 3] = tmp.x;
        set.arr[i * 3 + 1] = tmp.y;
        set.arr[i * 3 + 2] = tmp.z;
      }
      set.g.attributes.position.needsUpdate = true;
    };
    upd(grid, grid.src);
    upd(crates, crates.src);
    upd(objAxes, objAxes.src, M);
    upd(worldAxes, worldAxes.src);
    // Camera gizmo and frustum from the (possibly flying) camera pose.
    const pose = camPose();
    const inv = viewMatrix(pose).invert();
    upd(camAxes, camAxes.src, inv);
    const cs = frustumCorners(pose, ASPECT, pose.far);
    const fr: Vector3[] = BOX_EDGES.map((i) => cs[i]);
    const eye = new Vector3(...pose.eye);
    const a3 = clamp01(S.s - 2);
    for (let i = 0; i < 4; i++) fr.push(cs[i].clone().lerp(eye, 1 - a3), cs[i]); // apex lines collapse in clip space
    upd(frustum, fr);
    // Normal spikes.
    const nmat = new Matrix3().getNormalMatrix(M);
    const sp: Vector3[] = [];
    spikeIdx.forEach((k) => {
      const base = objPts[k].clone().applyMatrix4(M);
      sp.push(base, base.clone().addScaledVector(objNrm[k].clone().applyMatrix3(nmat).normalize(), 0.18));
    });
    upd(spikes, sp);
    spikes.mat.opacity = S.nrm * 0.75;
    // Visibility per stage.
    const a2 = clamp01(S.s - 1);
    objAxes.mat.opacity = 1 - 0.75 * clamp01(S.s - 0.5);
    worldAxes.mat.opacity = clamp01(S.s * 2) * (1 - 0.8 * a2) * (1 - a3);
    camAxes.mat.opacity = S.cam * (1 - a3);
    frustum.mat.opacity = S.cam * (0.5 + 0.5 * a3);
    grid.mat.opacity = 0.15 + 0.45 * clamp01(S.s);
    crates.mat.opacity = clamp01(S.s * 1.5) * 0.9;
    (pts.material as PointsMaterial).size = 0.08 + 0.012 * Math.sin(time * 3) * (1 - a3);
    // Tags.
    const tagAt = (lb: CSS2DObject, w: Vector3, o: number) => {
      display(w, lb.position);
      lb.element.style.opacity = String(o);
    };
    tagAt(objTag, new Vector3(0, -0.25, 0).applyMatrix4(M), 1 - 0.7 * clamp01(S.s - 0.5));
    tagAt(worldTag, new Vector3(1.7, 0.1, 0), clamp01(S.s * 2) * (1 - a2) * (1 - a3));
    tagAt(camTag, new Vector3(0, -0.22, 0).applyMatrix4(inv), S.cam * (1 - a3));
    const zr = api === 'opengl' ? ['z = −1', 'z = +1'] : ['z = 0', 'z = 1'];
    boxTagNear.element.textContent = `near · ${zr[0]}`;
    boxTagFar.element.textContent = `far · ${zr[1]}`;
    boxTagY.element.textContent = api === 'vulkan' ? '+y ↓ (Vulkan)' : '+y ↑';
    tagAt(boxTagNear, cs[1], a3);
    tagAt(boxTagFar, cs[6], a3);
    tagAt(boxTagY, cs[7], a3 * 0.9);
  };

  const view: StageView = {
    scene,
    camera,
    bloom: 1.0,
    bloomThreshold: 0.12,
    orbit: false,
    onFrame: (time) => {
      stars.tick(time);
      // Slow observer sway so the scene feels alive.
      const r = 6.2;
      const ang = 0.8 + Math.sin(time * 0.18) * 0.18;
      camera.position.set(Math.sin(ang) * r + look.x, 2.6, Math.cos(ang) * r + look.z);
      camera.lookAt(look);
      update(time);
    },
  };
  const stageHost = h('div.v-fill');
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
  const hud = h('div.vsc-hud', {}, [h('div.vsc-chips', {}, chips), optional]);
  const caption = h('div.vsc-caption');
  host.append(stageHost, hud, caption);
  ctx.stage.attach(stageHost, view);

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
      'The normals follow the model\'s rotation. After the VS optional stages may run: tessellation and geometry shader – or mesh shaders, which replace IA + VS altogether.',
    ),
  ];
  const targets = [
    { s: 0, fly: 0, nrm: 0, cam: 0 },
    { s: 1, fly: 0, nrm: 0, cam: 0 },
    { s: 2, fly: 1, nrm: 0, cam: 1 },
    { s: 3, fly: 1, nrm: 0, cam: 1 },
    { s: 1, fly: 1, nrm: 1, cam: 1 },
  ];
  let last = -1;
  return {
    show(step, animate) {
      const fwd = animate && step > last;
      last = step;
      caption.innerHTML = t(captions[step]);
      chips.forEach((c, i) => {
        c.classList.toggle('on', step === 4 ? i === 1 : i <= step);
        c.classList.toggle('cur', step === 4 ? i === 1 : i === step);
      });
      hud.dataset.step = String(step);
      gsap.killTweensOf(S);
      const tg = targets[step];
      if (fwd && step === 2) {
        // Fly the camera in first, then transform the world into view space.
        S.fly = 0;
        gsap.to(S, { cam: 1, duration: dur(0.4) });
        gsap.to(S, { fly: 1, duration: dur(1.6), ease: 'power2.inOut' });
        gsap.to(S, { s: 2, duration: dur(1.8), delay: dur(1.7), ease: 'power1.inOut' });
      } else if (fwd) {
        gsap.to(S, { ...tg, duration: dur(step === 3 ? 2.2 : 1.6), ease: 'power1.inOut' });
      } else Object.assign(S, tg);
      if (fwd) gsap.fromTo(caption, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: dur(0.4) });
    },
    destroy() {
      gsap.killTweensOf(S);
      if (ctx.stage.isAttachedTo(view)) ctx.stage.detach();
      disposeScene(scene);
      tex.dispose();
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
