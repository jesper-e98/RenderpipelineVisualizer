import gsap from 'gsap';
import {
  AdditiveBlending,
  BackSide,
  BufferGeometry,
  Color,
  FrontSide,
  Group,
  Line,
  LineBasicMaterial,
  LineLoop,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  Sprite,
  SpriteMaterial,
  Vector3,
} from 'three';
import type { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import '../styles/slides/viewport-culling.css';
import { dur, h, num } from '../core/dom';
import { L, type Text } from '../core/i18n';
import type { ApiId } from '../core/state';
import { ndcToWindow, type V3 } from '../pipeline/transform';
import { createModelStage, glowTexture, secs, type ModelStage } from '../views/ModelStage';
import type { PipelineMaterial } from '../views/pipelineMaterial';
import { COLORS, label } from '../views/three-helpers';
import { stat } from '../views/widgets';
import { standardSlide } from './standard';
import type { ApiPanelSpec, SlideContext, Visual } from './types';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
/** A 16:10 viewport – the same aspect (1.6) as the projection every data slide uses. */
const VW = 1920;
const VH = 1200;
const hdr = (hex: number, k: number) => new Color(hex).multiplyScalar(k);
const ease = (x: number) => x * x * (3 - 2 * x);
const VCOL = ['#38e1ff', '#ff3fd2', '#ffb547'];

/** ½ Σ (x_i·y_{i+1} − x_{i+1}·y_i) – the shoelace formula. */
const shoelace = (p: [number, number][]) => {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const [x0, y0] = p[i];
    const [x1, y1] = p[(i + 1) % p.length];
    s += x0 * y1 - x1 * y0;
  }
  return s / 2;
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

/** The showcase triangle through the viewport transform, and its winding. */
function windingData(ctx: SlideContext) {
  const api = ctx.state.api;
  const r = ctx.derived.render(api, 160, 100);
  const tri = ctx.derived.showcaseTriangle(api);
  const verts = ctx.derived.triangleVertices(tri);
  const e = r.matrices.mvp.elements;
  const ndc = verts.map((v) => {
    const [x, y, z] = ctx.derived.position(v);
    const w = e[3] * x + e[7] * y + e[11] * z + e[15];
    return [(e[0] * x + e[4] * y + e[8] * z + e[12]) / w, (e[1] * x + e[5] * y + e[9] * z + e[13]) / w, (e[2] * x + e[6] * y + e[10] * z + e[14]) / w] as V3;
  });
  const win = ndc.map((p) => ndcToWindow(api, p, VW, VH));
  const wpts = win.map((w) => [w.window[0], w.window[1]] as [number, number]);
  const sum = shoelace(wpts);
  const apiArea = api === 'vulkan' ? -sum : sum; // Vulkan's spec formula has a leading minus
  const ccw = api === 'd3d12' ? sum < 0 : apiArea > 0; // visually counter-clockwise on screen
  return { r, tri, verts, ndc, win, sum, apiArea, ccw, isFront: ccw };
}

/* ------------------------------------------------------------------ */
/* The 3D scene shared by both modes                                   */
/* ------------------------------------------------------------------ */
const PW = 3.0; // window plane, world units (aspect 1.6)
const PH = PW / 1.6;
const PLANE_POS = new Vector3(-0.5, 0.22, -1.6);

interface VcScene {
  ms: ModelStage;
  /** vp: window shown · stretch: NDC square → window · land: vertices fly to their pixels · wind: winding inset ·
   *  flip: inset turned around · cull: back faces peel away · wrong: front faces peel away (wrong setting) · xray: front faces see-through. */
  P: { vp: number; stretch: number; land: number; wind: number; flip: number; cull: number; wrong: number; xray: number; spin: number };
  /** Repeat the back-face peel while the culling step is shown. */
  loop: { on: boolean; t0: number; now: number };
  observer(step: number, animate: boolean): void;
  land(animate: boolean): void;
  noLand(): void;
}

function buildScene(host: HTMLElement, ctx: SlideContext, concept: boolean): VcScene {
  const { t } = ctx;
  const api = ctx.state.api;
  const mesh = ctx.state.mesh;
  const W = windingData(ctx);
  const yUp = api === 'opengl';
  const ms = createModelStage(host, ctx, {
    shift: concept ? 0 : -0.17,
    autoRotate: 0,
    bloom: 0.5,
    bloomThreshold: 0.9,
    eye: [1.7, 1.15, 3.3],
    layers: { solid: 0, wire: 0 },
  });
  const tex = glowTexture();
  const P = { vp: 1, stretch: 1, land: 1, wind: 0, flip: 0, cull: 0, wrong: 0, xray: 0, spin: 0 };
  const loop = { on: false, t0: 0, now: 0 };

  /* ---------- Front and back faces as two meshes of the real model ---------- */
  const geo = ms.layers.solid.geometry;
  const frontM = ms.material.clone() as PipelineMaterial;
  frontM.side = FrontSide;
  const backM = ms.material.clone() as PipelineMaterial;
  backM.side = BackSide;
  backM.uniforms.uFlipFacing.value = 1; // three.js flips the winding for BackSide
  backM.uniforms.uBackTint.value = 0.75;
  backM.transparent = true;
  backM.depthWrite = false;
  const front = new Mesh(geo, frontM);
  const back = new Mesh(geo, backM);
  back.renderOrder = 1;
  front.renderOrder = 2;
  ms.pivot.add(back, front);

  /* ---------- The window (framebuffer) plane behind the model ---------- */
  const win = new Group();
  win.position.copy(PLANE_POS);
  win.rotation.y = 0.28;
  ms.scene.add(win);
  const stretchG = new Group(); // scaled from the NDC square to the window aspect
  win.add(stretchG);
  const img = W.r; // reuse the 160 × 100 render's matrices; a coarse image for the plane
  const small = ctx.derived.render(api, 64, 40);
  const screen = ms.screenPlane(small.color, small.width, small.height, PW);
  stretchG.add(screen.mesh);
  const border = new LineLoop(
    new BufferGeometry().setFromPoints([new Vector3(-PW / 2, -PH / 2, 0.01), new Vector3(PW / 2, -PH / 2, 0.01), new Vector3(PW / 2, PH / 2, 0.01), new Vector3(-PW / 2, PH / 2, 0.01)]),
    new LineBasicMaterial({ color: hdr(COLORS.green, 2.2), transparent: true }),
  );
  stretchG.add(border);
  const gridPts: Vector3[] = [];
  for (let i = 1; i < 16; i++) gridPts.push(new Vector3(-PW / 2 + (i * PW) / 16, -PH / 2, 0.005), new Vector3(-PW / 2 + (i * PW) / 16, PH / 2, 0.005));
  for (let j = 1; j < 10; j++) gridPts.push(new Vector3(-PW / 2, -PH / 2 + (j * PH) / 10, 0.005), new Vector3(PW / 2, -PH / 2 + (j * PH) / 10, 0.005));
  const grid = new LineSegments(new BufferGeometry().setFromPoints(gridPts), new LineBasicMaterial({ color: hdr(COLORS.cyan, 0.8), transparent: true, opacity: 0.12, depthWrite: false }));
  stretchG.add(grid);
  // Origin marker + axes (the API's window convention).
  const origin = new Group();
  win.add(origin);
  const oDot = new Sprite(new SpriteMaterial({ map: tex, color: hdr(COLORS.amber, 2.4), transparent: true, depthTest: false, blending: AdditiveBlending }));
  oDot.scale.setScalar(0.18);
  const axX = new Line(new BufferGeometry().setFromPoints([new Vector3(), new Vector3(0.55, 0, 0)]), new LineBasicMaterial({ color: hdr(COLORS.amber, 2), transparent: true }));
  const axY = new Line(new BufferGeometry().setFromPoints([new Vector3(), new Vector3(0, yUp ? 0.45 : -0.45, 0)]), new LineBasicMaterial({ color: hdr(COLORS.amber, 2), transparent: true }));
  origin.add(oDot, axX, axY);
  const oTag = label('(0, 0)', 'vc-tag amber');
  const farTag = label(`(${VW}, ${VH})`, 'vc-tag green');
  const ndcTag = label('NDC  [−1, 1]²', 'vc-tag');
  const yTag = label(yUp ? '+y ↑' : '+y ↓', 'vc-tag amber');
  win.add(oTag, farTag, ndcTag, yTag);

  // Canvas (y down) → plane local.
  const toPlane = (xc: number, yc: number, z = 0.02) => new Vector3((xc / VW - 0.5) * PW, (0.5 - yc / VH) * PH, z);

  /* ---------- Vertices fly to their pixels ---------- */
  const COUNT = Math.min(1400, mesh.vertexCount);
  const stream = ms.particles(COUNT, COLORS.cyan, 0.026, 'world');
  ms.pivot.updateMatrixWorld(true);
  win.updateMatrixWorld(true);
  {
    const from = ms.samplePositions(COUNT);
    const to = new Float32Array(COUNT * 3);
    const e = img.matrices.mvp.elements;
    const v = new Vector3();
    for (let i = 0; i < COUNT; i++) {
      const x = from[i * 3];
      const y = from[i * 3 + 1];
      const z = from[i * 3 + 2];
      const w = e[3] * x + e[7] * y + e[11] * z + e[15];
      const ndc: V3 = [(e[0] * x + e[4] * y + e[8] * z + e[12]) / w, (e[1] * x + e[5] * y + e[9] * z + e[13]) / w, (e[2] * x + e[6] * y + e[10] * z + e[14]) / w];
      const c = ndcToWindow(api, ndc, VW, VH).canvas;
      toPlane(c[0], c[1], 0.03).applyMatrix4(win.matrixWorld).toArray(to, i * 3);
      v.fromArray(from, i * 3).applyMatrix4(ms.pivot.matrixWorld).toArray(from, i * 3);
    }
    stream.setTargets(from, to);
  }
  (stream.points.material as unknown as { uniforms: { uArc: { value: number } } }).uniforms.uArc.value = 0.12;

  /* ---------- The showcase triangle: on the model, on the window, magnified ---------- */
  const tri = W.tri;
  const real = W.win.map((w) => toPlane(w.canvas[0], w.canvas[1], 0.03));
  const rc = real[0].clone().add(real[1]).add(real[2]).multiplyScalar(1 / 3);
  const marker = new LineLoop(
    new BufferGeometry().setFromPoints([new Vector3(-0.06, -0.06, 0), new Vector3(0.06, -0.06, 0), new Vector3(0.06, 0.06, 0), new Vector3(-0.06, 0.06, 0)]),
    new LineBasicMaterial({ color: hdr(COLORS.magenta, 2.4), transparent: true, depthTest: false }),
  );
  marker.position.copy(rc);
  win.add(marker);
  // The magnified copy floats in free space at the top left, facing the viewer.
  const inset = new Group();
  const insetC = concept ? new Vector3(-1.25, 1.05, 0.5) : new Vector3(-0.3, 1.08, 0.7);
  inset.position.copy(insetC);
  inset.rotation.y = concept ? 0.25 : 0.1;
  inset.scale.setScalar(concept ? 0.9 : 0.72);
  ms.scene.add(inset);
  const span = Math.max(1e-6, ...real.map((p) => p.distanceTo(rc)));
  const K = 0.42 / span;
  const flipG = new Group();
  inset.add(flipG);
  const ip = real.map((p) => p.clone().sub(rc).multiplyScalar(K).setZ(0));
  const insetFill = new Mesh(new BufferGeometry().setFromPoints(ip), new MeshBasicMaterial({ color: hdr(COLORS.cyan, 0.7), transparent: true, opacity: 0.25, side: FrontSide, depthWrite: false, blending: AdditiveBlending }));
  const insetBack = new Mesh(new BufferGeometry().setFromPoints(ip), new MeshBasicMaterial({ color: hdr(COLORS.red, 0.8), transparent: true, opacity: 0.3, side: BackSide, depthWrite: false, blending: AdditiveBlending }));
  // Make the fill's front side the screen-CCW side.
  if (!W.ccw) {
    insetFill.material.side = BackSide;
    insetBack.material.side = FrontSide;
  }
  const insetEdge = new LineLoop(new BufferGeometry().setFromPoints(ip), new LineBasicMaterial({ color: hdr(COLORS.white, 1.6), transparent: true }));
  flipG.add(insetFill, insetBack, insetEdge);
  win.updateMatrixWorld(true);
  const link = new Line(new BufferGeometry().setFromPoints([rc.clone().applyMatrix4(win.matrixWorld), insetC]), new LineBasicMaterial({ color: hdr(COLORS.magenta, 1.4), transparent: true, opacity: 0.6 }));
  ms.scene.add(link);
  const vTags: CSS2DObject[] = ip.map((p, k) => {
    const lb = label(`v${k} ${W.win[k].window[0].toFixed(0)}, ${W.win[k].window[1].toFixed(0)}`, 'vc-tag');
    lb.element.style.color = VCOL[k];
    lb.position.copy(p).multiplyScalar(1.35);
    flipG.add(lb);
    return lb;
  });
  const insetTag = label(`#${tri} × ${Math.round(K / (PW / VW))}`, 'vc-tag');
  insetTag.position.set(0, 0.62, 0);
  inset.add(insetTag);
  const comet = Array.from({ length: 18 }, (_, k) => {
    const sp = new Sprite(new SpriteMaterial({ map: tex, color: hdr(COLORS.cyan, 2.4), transparent: true, depthTest: false, blending: AdditiveBlending }));
    sp.scale.setScalar(0.09 * (1 - k / 22));
    flipG.add(sp);
    return sp;
  });
  const windTag = label('', 'vc-tag big');
  windTag.position.set(0, -0.66, 0);
  inset.add(windTag);
  const per = ip.map((p, i) => p.distanceTo(ip[(i + 1) % 3]));
  const total = per[0] + per[1] + per[2] || 1;
  const along = (u: number) => {
    let d = (((u % 1) + 1) % 1) * total;
    for (let i = 0; i < 3; i++) {
      if (d <= per[i]) return ip[i].clone().lerp(ip[(i + 1) % 3], d / Math.max(1e-9, per[i]));
      d -= per[i];
    }
    return ip[0].clone();
  };
  // On the model: the triangle itself.
  ms.material.uniforms.uHighlightColor.value.set(COLORS.magenta);
  frontM.uniforms.uHighlightColor.value.set(COLORS.magenta);

  const setO = (lb: CSS2DObject, o: number) => {
    lb.element.style.opacity = String(o);
    lb.visible = o > 0.01;
  };
  ms.onFrame((time) => {
    // Window: NDC square → window rectangle, origin from the center to the API's corner.
    const st = ease(P.stretch);
    const sx = 1 / 1.6 + (1 - 1 / 1.6) * st;
    stretchG.scale.set(sx, 1, 1);
    win.visible = P.vp > 0.01;
    (border.material as LineBasicMaterial).opacity = P.vp;
    (grid.material as LineBasicMaterial).opacity = 0.12 * P.vp * st;
    (screen.mesh.material as unknown as { opacity: number; uniforms: { uReveal: { value: number } } }).uniforms.uReveal.value = P.land * P.vp;
    const corner = new Vector3((-PW / 2) * sx, yUp ? -PH / 2 : PH / 2, 0.03);
    origin.position.copy(new Vector3(0, 0, 0.03).lerp(corner, st));
    origin.visible = P.vp > 0.01;
    [axX, axY].forEach((a) => ((a.material as LineBasicMaterial).opacity = P.vp * st));
    oTag.position.copy(origin.position).add(new Vector3(-0.22, yUp ? -0.1 : 0.1, 0));
    setO(oTag, P.vp * st);
    farTag.position.set((PW / 2) * sx - 0.2, yUp ? PH / 2 + 0.1 : -PH / 2 - 0.1, 0);
    setO(farTag, P.vp * st);
    ndcTag.position.set(0, PH / 2 + 0.12, 0);
    setO(ndcTag, P.vp * (1 - st));
    yTag.position.copy(origin.position).add(new Vector3(0.14, yUp ? 0.55 : -0.55, 0));
    setO(yTag, P.vp * st);
    // Winding inset.
    const wind = P.wind;
    inset.visible = link.visible = marker.visible = wind > 0.01;
    flipG.rotation.y = Math.PI * ease(P.flip);
    (insetEdge.material as LineBasicMaterial).opacity = wind;
    insetFill.material.opacity = 0.3 * wind;
    insetBack.material.opacity = 0.35 * wind;
    (link.material as LineBasicMaterial).opacity = 0.6 * wind;
    (marker.material as LineBasicMaterial).opacity = wind;
    vTags.forEach((lb) => setO(lb, wind));
    setO(insetTag, wind);
    const facingBack = ease(P.flip) > 0.5;
    const cw = W.ccw === facingBack;
    comet.forEach((sp, k) => {
      sp.position.copy(along(time * 0.32 - k * 0.012)).setZ(0.02);
      (sp.material as SpriteMaterial).opacity = wind * (1 - k / 18);
      (sp.material as SpriteMaterial).color.copy(cw ? hdr(COLORS.red, 2.4) : hdr(COLORS.cyan, 2.4));
    });
    windTag.element.textContent = cw ? t(L('medurs (CW) → baksida', 'clockwise (CW) → back face')) : t(L('moturs (CCW) → framsida', 'counter-clockwise (CCW) → front face'));
    windTag.element.style.color = cw ? '#ff5a6e' : '#38e1ff';
    setO(windTag, wind);
    frontM.uniforms.uHighlightTri.value = wind > 0.01 ? tri : -10;
    // Culling: back faces peel away from the viewer; with the wrong setting the front faces go.
    loop.now = time;
    if (loop.on) {
      // see-through → back faces peel off → solid again → hold, then around again.
      const u = (time - loop.t0) % 5.2;
      P.xray = u < 0.6 ? u / 0.6 : u < 2.4 ? 1 : u < 3.2 ? 1 - (u - 2.4) / 0.8 : 0;
      P.cull = u < 0.8 ? 0 : u < 2.4 ? (u - 0.8) / 1.6 : 1;
    }
    const cull = ease(P.cull);
    const wrong = ease(P.wrong);
    frontM.transparent = P.xray > 0.001 || wrong > 0.001;
    frontM.depthWrite = !frontM.transparent;
    frontM.uniforms.uOpacity.value = (1 - 0.68 * P.xray) * (1 - wrong);
    frontM.uniforms.uExplode.value = wrong * 0.7;
    front.visible = frontM.uniforms.uOpacity.value > 0.01;
    backM.uniforms.uOpacity.value = (P.xray > 0.001 || wrong > 0.001 ? 1 : 0) * (1 - cull);
    backM.uniforms.uExplode.value = cull * 0.8;
    back.visible = backM.uniforms.uOpacity.value > 0.01;
    // With the wrong setting the inside is opaque (it is all that's drawn).
    backM.depthWrite = wrong > 0.5;
    backM.uniforms.uBackTint.value = 0.75;
    ms.pivot.rotation.y = ms.pivot.userData.baseY + P.spin * Math.sin(time * 0.5) * 0.6;
  });
  ms.pivot.userData.baseY = ms.pivot.rotation.y;

  const observer = (step: number, animate: boolean) => {
    const target = step === 1 ? new Vector3(0.9, 0.75, 3.7) : step >= 2 ? new Vector3(1.2, 1.0, 3.0) : new Vector3(1.4, 1.0, 3.6);
    gsap.killTweensOf(ms.camera.position);
    if (animate) gsap.to(ms.camera.position, { x: target.x, y: target.y, z: target.z, duration: dur(1.2), ease: 'power2.inOut' });
    else ms.camera.position.copy(target);
  };
  const land = (animate: boolean) => {
    stream.points.visible = true;
    stream.progress(0, 0);
    if (animate) {
      stream.progress(1, 2.4);
      P.land = 0;
      gsap.to(P, { land: 1, duration: dur(1.6), delay: dur(1.2) });
    } else stream.progress(1, 0);
  };
  return { ms, P, loop, observer, land, noLand: () => (stream.points.visible = false) };
}

/* ------------------------------------------------------------------ */
/* Real data                                                           */
/* ------------------------------------------------------------------ */
function dataVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const api = ctx.state.api;
  const W = windingData(ctx);
  const st = W.r.stats;
  const S = buildScene(host, ctx, false);
  const { ms, P } = S;
  const yUp = api === 'opengl';

  const formula: Record<ApiId, string> = {
    opengl: `x<sub>w</sub> = (x + 1)·w/2 + x<sub>0</sub>  ·  y<sub>w</sub> = (y + 1)·h/2 + y<sub>0</sub>  ·  z<sub>w</sub> = (z + 1)/2 · (f − n) + n`,
    vulkan: `x<sub>f</sub> = (x + 1)·width/2 + x  ·  y<sub>f</sub> = (y + 1)·height/2 + y  ·  z<sub>f</sub> = minDepth + z·(maxDepth − minDepth)`,
    d3d12: `x = (x + 1)·Width/2 + TopLeftX  ·  y = (1 − y)·Height/2 + TopLeftY  ·  z = MinDepth + z·(MaxDepth − MinDepth)`,
  };
  const origin: Record<ApiId, Text> = {
    opengl: L('Origo nere till vänster, +y uppåt.', 'Origin at the bottom left, +y up.'),
    vulkan: L('Origo uppe till vänster, +y nedåt – NDC-y pekar redan nedåt, så ingen flipp behövs.', 'Origin at the top left, +y down – NDC y already points down, so no flip is needed.'),
    d3d12: L('Origo uppe till vänster, +y nedåt – viewport-transformen vänder y (1 − y).', 'Origin at the top left, +y down – the viewport transform flips y (1 − y).'),
  };
  const wTable = h('table.vc-table', {}, [
    h('thead', {}, [h('tr', {}, [h('th', { text: '' }), h('th', { text: 'NDC (x, y, z)' }), h('th', { text: 'window (x, y)' }), h('th', { text: 'depth' })])]),
    h(
      'tbody',
      {},
      W.ndc.map((p, k) =>
        h('tr', {}, [
          h('td', {}, [h('span.vc-v', { text: `v${k}`, style: { color: VCOL[k] } })]),
          h('td.mono', { text: p.map((x) => num(x, 3)).join(' ') }),
          h('td.mono.hot', { text: `${W.win[k].window[0].toFixed(1)}, ${W.win[k].window[1].toFixed(1)}` }),
          h('td.mono', { text: W.win[k].window[2].toFixed(4) }),
        ]),
      ),
    ),
  ]);
  const p0 = ms.panel(t(L(`Viewport ${VW} × ${VH}`, `Viewport ${VW} × ${VH}`)), [
    h('div.stat-row', {}, [stat(`${VW} × ${VH}`, t(L('fönster (px)', 'window (px)')), 'glow-cyan'), stat(yUp ? t(L('nere vänster', 'bottom left')) : t(L('uppe vänster', 'top left')), t(L('origo', 'origin')), 'glow-amber')]),
    h('div.vc-formula', { html: formula[api] }),
    h('div.vc-sub', { text: t(L(`Triangel #${W.tri}:`, `Triangle #${W.tri}:`)) }),
    wTable,
    h('div.vc-note', { html: t(origin[api]) + ' ' + t(L('Djupintervallet [0, 1] gäller alla tre här.', 'The depth range [0, 1] applies to all three here.')) }),
  ]);

  const areaFormula: Record<ApiId, string> = {
    opengl: `a = ½ Σ (x<sub>i</sub>·y<sub>i+1</sub> − x<sub>i+1</sub>·y<sub>i</sub>)  <span class="hint">${t(L('(fönster, y upp)', '(window, y up)'))}</span>`,
    vulkan: `a = −½ Σ (x<sub>i</sub>·y<sub>i+1</sub> − x<sub>i+1</sub>·y<sub>i</sub>)  <span class="hint">${t(L('(framebuffer, y ned)', '(framebuffer, y down)'))}</span>`,
    d3d12: `a = ½ Σ (x<sub>i</sub>·y<sub>i+1</sub> − x<sub>i+1</sub>·y<sub>i</sub>)  <span class="hint">${t(L('(render target, y ned)', '(render target, y down)'))}</span>`,
  };
  const areaVal = api === 'd3d12' ? W.sum : W.apiArea;
  const p1 = ms.panel(t(L(`Varvriktning – triangel #${W.tri}`, `Winding – triangle #${W.tri}`)), [
    h('div.stat-row', {}, [
      stat(Math.round(areaVal).toLocaleString(), t(L('a (px²)', 'a (px²)')), areaVal >= 0 ? 'glow-cyan' : 'glow-magenta'),
      stat(W.ccw ? 'CCW' : 'CW', t(L('på skärmen', 'on screen')), 'glow-amber'),
      stat(W.isFront ? 'front' : 'back', t(L('med vår inställning', 'with our setting')), W.isFront ? 'glow-cyan' : 'glow-magenta'),
    ]),
    h('div.vc-formula', { html: areaFormula[api] }),
    h('div.vc-note', {
      html: t(
        api === 'opengl'
          ? L('Positiv area i fönsterkoordinater = moturs (CCW). Med <code>glFrontFace(GL_CCW)</code> är den en framsida.', 'Positive area in window coordinates = counter-clockwise (CCW). With <code>glFrontFace(GL_CCW)</code> it is a front face.')
          : api === 'vulkan'
            ? L('Vulkans formel har ett minustecken eftersom y pekar nedåt: positiv a = moturs på skärmen → framsida med <code>VK_FRONT_FACE_COUNTER_CLOCKWISE</code>.', "Vulkan's formula has a minus sign because y points down: positive a = counter-clockwise on screen → front face with <code>VK_FRONT_FACE_COUNTER_CLOCKWISE</code>.")
            : L('Med y nedåt ger moturs (CCW) på skärmen negativ shoelace-summa. <code>FrontCounterClockwise = TRUE</code> gör den till framsida.', 'With y down, counter-clockwise (CCW) on screen gives a negative shoelace sum. <code>FrontCounterClockwise = TRUE</code> makes it a front face.'),
      ),
    }),
  ]);

  const kept = st.trianglesIn - st.culled - st.clippedAway;
  const pct = Math.round((st.culled / Math.max(1, st.trianglesIn)) * 100);
  const p2 = ms.panel(t(L('Back-face culling – hela modellen', 'Back-face culling – the whole model')), [
    h('div.stat-row', {}, [
      stat(kept.toLocaleString(), t(L('framsidor kvar', 'front faces kept')), 'glow-cyan'),
      stat(st.culled.toLocaleString(), t(L('bortcullade', 'culled')), 'glow-magenta'),
      stat(`${pct} %`, t(L('sparat', 'saved')), 'glow-amber'),
    ]),
    h('div.vc-note', {
      html: t(
        L(
          `Av ${st.trianglesIn.toLocaleString()} trianglar (mjukvarurenderingen, 160 × 100). <span class="r">Baksidorna</span> skalas bort <b>före</b> rasteriseringen – de genererar aldrig ett enda fragment. För en sluten modell är det ungefär hälften.`,
          `Of ${st.trianglesIn.toLocaleString()} triangles (software render, 160 × 100). The <span class="r">back faces</span> are peeled away <b>before</b> rasterization – they never generate a single fragment. For a closed model that is roughly half.`,
        ),
      ),
    }),
  ]);
  const conv: { api: ApiId; name: string; code: string }[] = [
    { api: 'opengl', name: 'OpenGL', code: 'glFrontFace(GL_CCW); glCullFace(GL_BACK);' },
    { api: 'vulkan', name: 'Vulkan', code: 'frontFace = VK_FRONT_FACE_COUNTER_CLOCKWISE; cullMode = VK_CULL_MODE_BACK_BIT;' },
    { api: 'd3d12', name: 'D3D12', code: 'FrontCounterClockwise = TRUE; CullMode = D3D12_CULL_MODE_BACK;' },
  ];
  const p3 = ms.panel(t(L('Vad är "fram"? Konventionen per API', 'What is "front"? The convention per API')), [
    h('div.stat-row', {}, [stat(kept.toLocaleString(), t(L('synliga sidor cullas', 'visible faces culled')), 'glow-magenta'), stat(st.culled.toLocaleString(), t(L('insidan ritas', 'inside drawn')), 'glow-amber')]),
    h('div.vc-conv', {}, conv.map((c) => h(`div.vc-conv-row${c.api === api ? '.cur' : ''}`, {}, [h('span.vc-conv-name', { text: c.name }), h('code', { text: c.code })]))),
    h('div.vc-note', {
      html: t(
        L(
          'Fel inställning (t.ex. D3D12:s standard <code>FrontCounterClockwise = FALSE</code>, eller Vulkan utan y-flipp i projektionen) cullar i stället framsidorna – kvar blir modellens insida.',
          "The wrong setting (e.g. D3D12's default <code>FrontCounterClockwise = FALSE</code>, or Vulkan without the y flip in the projection) culls the front faces instead – what remains is the inside of the model.",
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
  const targets = [
    { vp: 1, stretch: 1, wind: 0, flip: 0, cull: 0, wrong: 0, xray: 0, spin: 0 },
    { vp: 1, stretch: 1, wind: 1, flip: 0, cull: 0, wrong: 0, xray: 0, spin: 0 },
    { vp: 0.35, stretch: 1, wind: 0, flip: 0, cull: 1, wrong: 0, xray: 0, spin: 0 },
    { vp: 0.35, stretch: 1, wind: 0, flip: 0, cull: 0, wrong: 1, xray: 0, spin: 0 },
  ];
  let last = -1;
  return {
    show(step, animate) {
      const fwd = animate && step > last;
      last = step;
      showPanels(step, fwd);
      gsap.killTweensOf(P);
      const tg = targets[step];
      S.loop.on = step === 2;
      S.loop.t0 = S.loop.now;
      if (step === 2) {
        // Back faces shown through see-through front faces, then peeled away – on repeat.
        if (fwd) gsap.to(P, { vp: tg.vp, wind: 0, wrong: 0, duration: dur(0.9) });
        else Object.assign(P, tg, { land: 1 });
      } else if (fwd) gsap.to(P, { ...tg, duration: dur(step === 3 ? 1.6 : 0.9), ease: 'power2.inOut' });
      else Object.assign(P, tg, { land: 1 });
      if (step === 0) S.land(fwd);
      else S.noLand();
      S.observer(step, fwd);
      ms.uniform('uDiffuseW', 1, secs(fwd, 0.3));
    },
    destroy() {
      gsap.killTweensOf(P);
      gsap.killTweensOf(ms.camera.position);
      ms.destroy();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Concept: viewport stretch, winding flip, back faces peel away       */
/* ------------------------------------------------------------------ */
function conceptVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const api = ctx.state.api;
  const yUp = api === 'opengl';
  const S = buildScene(host, ctx, true);
  const { ms, P } = S;
  const capPanel = ms.panel(t(L('Vad händer', 'What happens')), [h('p.vcc-cap')], { side: 'bottom' });
  const cap = capPanel.querySelector('.vcc-cap')!;
  const frontSetting: Record<ApiId, string> = {
    opengl: 'glFrontFace(GL_CCW) · glCullFace(GL_BACK)',
    vulkan: 'VK_FRONT_FACE_COUNTER_CLOCKWISE · VK_CULL_MODE_BACK_BIT',
    d3d12: 'FrontCounterClockwise = TRUE · D3D12_CULL_MODE_BACK',
  };
  const captions: Text[] = [
    L(
      `Viewport-transformen sträcker NDC-kvadraten till fönstret: ${VW} × ${VH} pixlar, och varje vertex landar på sin pixel. ${yUp ? 'OpenGL: origo nere till vänster.' : api === 'vulkan' ? 'Vulkan: origo uppe till vänster, y nedåt.' : 'D3D12: origo uppe till vänster, y vänds.'}`,
      `The viewport transform stretches the NDC square onto the window: ${VW} × ${VH} pixels, and every vertex lands on its pixel. ${yUp ? 'OpenGL: origin at the bottom left.' : api === 'vulkan' ? 'Vulkan: origin at the top left, y down.' : 'D3D12: origin at the top left, y is flipped.'}`,
    ),
    L(
      'Ordningen v0 → v1 → v2 på skärmen avgör sidan: moturs = framsida. Vänd triangeln – samma ordning blir medurs, och vi ser baksidan.',
      'The order v0 → v1 → v2 on screen decides the side: counter-clockwise = front. Turn the triangle around – the same order becomes clockwise, and we see its back.',
    ),
    L(
      'I en sluten modell vänder ungefär hälften av trianglarna bort från kameran. <span class="r">Baksidorna</span> skalas bort innan rasteriseringen – ingen märker skillnad.',
      'In a closed model about half the triangles face away from the camera. The <span class="r">back faces</span> are peeled away before rasterization – nobody can tell the difference.',
    ),
    L(
      `Fel front face-inställning cullar framsidorna i stället – kvar blir insidan. Rätt här: <code>${frontSetting[api]}</code>.`,
      `The wrong front-face setting culls the front faces instead – the inside remains. Correct here: <code>${frontSetting[api]}</code>.`,
    ),
  ];
  const targets = [
    { vp: 1, stretch: 1, wind: 0, flip: 0, cull: 0, wrong: 0, xray: 0, spin: 0 },
    { vp: 1, stretch: 1, wind: 1, flip: 1, cull: 0, wrong: 0, xray: 0, spin: 0 },
    { vp: 0.5, stretch: 1, wind: 0, flip: 1, cull: 1, wrong: 0, xray: 0, spin: 1 },
    { vp: 0.5, stretch: 1, wind: 0, flip: 1, cull: 0, wrong: 1, xray: 0, spin: 1 },
  ];
  let last = -1;
  return {
    show(step, animate) {
      const fwd = animate && step > last;
      last = step;
      cap.innerHTML = t(captions[step]);
      if (fwd) gsap.fromTo(cap, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: dur(0.4) });
      gsap.killTweensOf(P);
      const tg = targets[step];
      S.loop.on = step === 2;
      S.loop.t0 = S.loop.now;
      if (fwd && step === 0) {
        Object.assign(P, { ...tg, stretch: 0, vp: 0, land: 0 });
        gsap.to(P, { vp: 1, duration: dur(0.5) });
        gsap.to(P, { stretch: 1, duration: dur(1.6), delay: dur(0.7), ease: 'power2.inOut', onComplete: () => S.land(true) });
      } else if (fwd && step === 1) {
        Object.assign(P, { wind: 0, flip: 0 });
        gsap.to(P, { wind: 1, duration: dur(0.6) });
        gsap.to(P, { flip: 1, duration: dur(1.4), delay: dur(3.0), ease: 'power2.inOut' });
      } else if (step === 2) {
        if (fwd) gsap.to(P, { vp: tg.vp, wind: 0, wrong: 0, spin: 1, duration: dur(0.9) });
        else Object.assign(P, tg, { land: 1 });
      } else if (fwd) gsap.to(P, { ...tg, duration: dur(1.4), ease: 'power2.inOut' });
      else {
        Object.assign(P, tg, { land: 1 });
        if (step === 0) S.land(false);
      }
      if (step !== 0) S.noLand();
      else if (fwd) S.noLand();
      S.observer(step, fwd);
    },
    destroy() {
      gsap.killTweensOf(P);
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
  const line = L(`Här: ${st.culled} av ${st.trianglesIn} trianglar cullas.`, `Here: ${st.culled} of ${st.trianglesIn} triangles are culled.`);
  return {
    opengl: {
      note: L(
        `glViewport anger rektangeln med origo nere till vänster; glDepthRange mappar NDC z [−1, 1] till fönsterdjup [0, 1]. Culling slås på separat. ${line.sv}`,
        `glViewport sets the rectangle with its origin at the bottom left; glDepthRange maps NDC z [−1, 1] to window depth [0, 1]. Culling is enabled separately. ${line.en}`,
      ),
      code: [
        {
          lang: 'cpp',
          src: `glViewport(0, 0, ${VW}, ${VH});          // x, y = lower-left corner
glDepthRange(0.0, 1.0);                 // z_w = (z_ndc + 1) / 2
glEnable(GL_SCISSOR_TEST);
glScissor(0, 0, ${VW}, ${VH});

glEnable(GL_CULL_FACE);
glFrontFace(GL_CCW);                    // CCW in window space = front (default)
glCullFace(GL_BACK);                    // discard back faces (default)

glDrawElements(GL_TRIANGLES, count, GL_UNSIGNED_SHORT, nullptr);`,
          highlight: [[1, 2, 3, 4], [7], [6, 8, 10], [7, 8]],
        },
      ],
      terms: [
        { term: 'glViewport', desc: L('NDC → fönster: x, y, bredd, höjd (origo nere till vänster).', 'NDC → window: x, y, width, height (origin bottom left).') },
        { term: 'GL_CCW', desc: L('Moturs i fönsterkoordinater räknas som framsida.', 'Counter-clockwise in window coordinates counts as front.') },
        { term: 'scissor', desc: L('Pixlar utanför rektangeln kastas.', 'Pixels outside the rectangle are discarded.') },
      ],
      you: L('anger viewport och culling', 'set viewport and culling'),
      driver: L('GPU:n mappar, testar arean och kastar', 'the GPU maps, tests the area and discards'),
    },
    vulkan: {
      note: L(
        `VkViewport har origo uppe till vänster och NDC-y pekar redan nedåt. Eftersom projektionen flippar y ser modellen rätt ut, och moturs på skärmen = framsida. ${line.sv}`,
        `VkViewport has its origin at the top left and NDC y already points down. Because the projection flips y the model appears upright, and counter-clockwise on screen = front. ${line.en}`,
      ),
      code: [
        {
          lang: 'cpp',
          src: `VkViewport vp{ .x = 0.0f, .y = 0.0f,
               .width = ${VW}.0f, .height = ${VH}.0f,
               .minDepth = 0.0f, .maxDepth = 1.0f };
VkRect2D scissor{ {0, 0}, {${VW}, ${VH}} };
vkCmdSetViewport(cmd, 0, 1, &vp);       // dynamic state
vkCmdSetScissor(cmd, 0, 1, &scissor);
// Alternative to the y flip in the projection: a negative height
// VkViewport{ 0, ${VH}, ${VW}, -${VH}, 0, 1 }

VkPipelineRasterizationStateCreateInfo rs{
    .sType = VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO,
    .polygonMode = VK_POLYGON_MODE_FILL,
    .cullMode = VK_CULL_MODE_BACK_BIT,
    .frontFace = VK_FRONT_FACE_COUNTER_CLOCKWISE,  // projection flips Y
    .lineWidth = 1.0f,
};`,
          highlight: [[1, 2, 3, 4, 5, 6], [7, 8, 14], [13], [13, 14]],
        },
      ],
      terms: [
        { term: 'VkViewport', desc: L('x, y, width, height, minDepth, maxDepth – origo uppe till vänster.', 'x, y, width, height, minDepth, maxDepth – origin top left.') },
        { term: 'vkCmdSetCullMode', desc: L('Core i 1.3: cullMode/frontFace kan vara dynamiskt tillstånd.', 'Core in 1.3: cullMode/frontFace can be dynamic state.') },
        { term: 'negative viewport height', desc: L('Flippar y i viewporten i stället för i projektionen (core sedan 1.1).', 'Flips y in the viewport instead of the projection (core since 1.1).') },
      ],
      you: L('anger viewport, scissor och cull-läge', 'set viewport, scissor and cull mode'),
      driver: L('GPU:n mappar, testar arean och kastar', 'the GPU maps, tests the area and discards'),
    },
    d3d12: {
      note: L(
        `D3D12_VIEWPORT har origo uppe till vänster; viewport-transformen vänder y. D3D:s standard är medurs = framsida, så högerhänt innehåll behöver FrontCounterClockwise = TRUE. ${line.sv}`,
        `D3D12_VIEWPORT has its origin at the top left; the viewport transform flips y. D3D's default is clockwise = front, so right-handed content needs FrontCounterClockwise = TRUE. ${line.en}`,
      ),
      code: [
        {
          lang: 'cpp',
          src: `// TopLeftX, TopLeftY, Width, Height, MinDepth, MaxDepth
D3D12_VIEWPORT vp{ 0.0f, 0.0f, ${VW}.0f, ${VH}.0f, 0.0f, 1.0f };
D3D12_RECT scissor{ 0, 0, ${VW}, ${VH} };   // left, top, right, bottom
cmd->RSSetViewports(1, &vp);
cmd->RSSetScissorRects(1, &scissor);

D3D12_RASTERIZER_DESC rs = {};
rs.FillMode = D3D12_FILL_MODE_SOLID;
rs.CullMode = D3D12_CULL_MODE_BACK;
rs.FrontCounterClockwise = TRUE;        // right-handed, CCW content
rs.DepthClipEnable = TRUE;
psoDesc.RasterizerState = rs;`,
          highlight: [[1, 2, 3, 4, 5], [10], [9, 12], [9, 10]],
        },
      ],
      terms: [
        { term: 'RSSetViewports', desc: L('Sätter viewport(s) på kommandolistan.', 'Sets the viewport(s) on the command list.') },
        { term: 'FrontCounterClockwise', desc: L('FALSE (standard) = medurs är framsida.', 'FALSE (default) = clockwise is front.') },
        { term: 'RSSetScissorRects', desc: L('Krävs i D3D12 – annars är scissor-rektangeln tom.', 'Required in D3D12 – otherwise the scissor rect is empty.') },
      ],
      you: L('anger viewport, scissor och PSO-rasterizer', 'set viewport, scissor and the PSO rasterizer'),
      driver: L('GPU:n mappar, testar arean och kastar', 'the GPU maps, tests the area and discards'),
    },
  };
}

export default standardSlide({
  id: 'viewport-culling',
  group: 'gpu-fixed',
  short: L('Viewport & culling', 'Viewport & culling'),
  title: L('Viewport & culling', 'Viewport & culling'),
  lead: L(
    'NDC-koordinater blir pixelkoordinater, och trianglar som vänder baksidan mot kameran sorteras bort innan de kostar något.',
    'NDC coordinates become pixel coordinates, and triangles that turn their back to the camera are thrown out before they cost anything.',
  ),
  bullets: [
    L(
      '<b>Viewport-transformen</b> skalar NDC [−1, 1] till fönstret i pixlar och z till djupintervallet. OpenGL har origo nere till vänster, Vulkan och D3D12 uppe till vänster.',
      'The <b>viewport transform</b> scales NDC [−1, 1] to the window in pixels and z to the depth range. OpenGL has its origin at the bottom left, Vulkan and D3D12 at the top left.',
    ),
    L(
      'Triangelns <b>tecknade area</b> i fönstret avslöjar varvriktningen: moturs (CCW) eller medurs (CW) på skärmen.',
      'The triangle\'s <b>signed area</b> in the window reveals its winding: counter-clockwise (CCW) or clockwise (CW) on screen.',
    ),
    L(
      '<b>Back-face culling</b>: trianglar som vänder baksidan till kastas innan rasteriseringen – ofta ungefär hälften av en sluten modell.',
      '<b>Back-face culling</b>: triangles facing away are discarded before rasterization – often about half of a closed model.',
    ),
    L(
      'Vad som är "fram" är en inställning: <code>glFrontFace</code>, <code>VkFrontFace</code>, <code>FrontCounterClockwise</code>. Fel värde visar modellens insida.',
      'What counts as "front" is a setting: <code>glFrontFace</code>, <code>VkFrontFace</code>, <code>FrontCounterClockwise</code>. The wrong value shows the inside of the model.',
    ),
  ],
  api: apis,
  data: dataVisual,
  concept: conceptVisual,
});
