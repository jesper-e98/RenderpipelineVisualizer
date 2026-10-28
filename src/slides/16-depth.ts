import { DoubleSide, Group, Mesh, MeshBasicMaterial, Raycaster, Vector3, type ShaderMaterial } from 'three';
import { h, s } from '../core/dom';
import { L } from '../core/i18n';
import type { ApiId } from '../core/state';
import type { RenderResult } from '../pipeline/raster';
import { DEFAULT_CAMERA } from '../pipeline/transform';
import { createModelStage, secs, type ModelStage } from '../views/ModelStage';
import { PixelCanvas, heat } from '../views/PixelCanvas';
import { COLORS, label } from '../views/three-helpers';
import { stat } from '../views/widgets';
import { RIG_EYE, VIEW_FORWARD, VIRTUAL_EYE, glowDot, linImage, lineSet, projectionRig, viewRayPoint } from './14-rasterization';
import { standardSlide } from './standard';
import type { ApiPanelSpec, SlideContext, Visual } from './types';
import '../styles/slides/depth.css';

const NEAR = DEFAULT_CAMERA.near;
const FAR = DEFAULT_CAMERA.far;
/** Stored depth (0..1, every API after the viewport transform) → view-space distance. */
const distOf = (d: number) => (FAR * NEAR) / (FAR - d * (FAR - NEAR));
const depthOf = (z: number) => (FAR * (z - NEAR)) / (z * (FAR - NEAR));
const BG: [number, number, number] = [10, 14, 40];

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
const bitsOf = (x: number) => ((f32[0] = x), u32[0]);
/** Number of distinct float32 values in [a, b] (a, b ≥ 0). */
const floatsBetween = (a: number, b: number) => bitsOf(b) - bitsOf(a) + 1;
const ulp = (x: number) => Math.pow(2, Math.floor(Math.log2(Math.max(x, 1e-38))) - 23);
const fmtSci = (x: number) => (x >= 0.01 && x < 1000 ? x.toFixed(4) : x.toExponential(2));

/** Blit an RGBA image (w×h) into a PixelCanvas at a cell offset. */
function blit(pc: PixelCanvas, rgba: Uint8ClampedArray, w: number, hh: number, cx: number, cy: number) {
  const tmp = document.createElement('canvas');
  tmp.width = w;
  tmp.height = hh;
  tmp.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, hh), 0, 0);
  const [x, y] = pc.px(cx, cy);
  pc.ctx.save();
  pc.ctx.imageSmoothingEnabled = false;
  pc.ctx.drawImage(tmp, x, y, w * pc.cell, hh * pc.cell);
  pc.ctx.restore();
}

function depthImage(r: RenderResult, dmin: number, dmax: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(r.width * r.height * 4);
  for (let p = 0; p < r.width * r.height; p++) {
    const d = r.depth[p];
    const c = d >= 1 ? BG : heat(((d - dmin) / Math.max(1e-9, dmax - dmin)) * 0.88);
    out.set([c[0], c[1], c[2], 255], p * 4);
  }
  return out;
}

/**
 * Make the model material's "depth" view mode show the stored depth d of the CPU pipeline's
 * camera (not the slide camera), colored exactly like depthImage(): heat((d − dmin)/(dmax − dmin)·0.88).
 */
function virtualDepth(mat: ShaderMaterial, pivotMatrix: import('three').Matrix4, dmin: number, dmax: number) {
  const u = mat.uniforms as Record<string, { value: unknown }>;
  u.uPivot = { value: pivotMatrix };
  u.uVEye = { value: VIRTUAL_EYE.clone() };
  u.uVFwd = { value: VIEW_FORWARD.clone() };
  const A = FAR / (FAR - NEAR);
  mat.vertexShader = mat.vertexShader
    .replace('uniform float uExplode;', 'uniform float uExplode;\nuniform mat4 uPivot;\nuniform vec3 uVEye;\nuniform vec3 uVFwd;')
    .replace('vViewZ = -mv.z;', `float vz = max(dot((uPivot * vec4(p, 1.0)).xyz - uVEye, uVFwd), 0.01);\n  vViewZ = ${A.toFixed(6)} * (1.0 - ${NEAR.toFixed(4)} / vz);`);
  (u.uDepthRange.value as import('three').Vector2).set(dmin, dmin + (dmax - dmin) / 0.88);
  mat.needsUpdate = true;
}

/** Hits of a world-space ray with the model (both faces), in submission (triangle) order. */
function rayLayers(ms: ModelStage, origin: Vector3, dir: Vector3) {
  ms.pivot.updateMatrix();
  const probe = new Mesh(ms.layers.solid.geometry, new MeshBasicMaterial({ side: DoubleSide }));
  probe.matrixWorld.copy(ms.pivot.matrix);
  const rc = new Raycaster(origin, dir, 0, 20);
  const hits = rc.intersectObject(probe, false);
  probe.material.dispose();
  const fwdDot = dir.dot(VIEW_FORWARD);
  return hits
    .map((hh) => {
      const n = hh.face!.normal.clone().applyQuaternion(ms.pivot.quaternion);
      const zv = hh.distance * fwdDot;
      return { tri: hh.faceIndex ?? 0, point: hh.point, dist: hh.distance, zv, d: depthOf(zv), front: n.dot(dir) < 0 };
    })
    .sort((a, b) => a.tri - b.tri);
}

/** Stored-depth ticks along a ray: 16 even steps in d (standard) and reversed-Z float values. */
function precisionTicks(group: Group, origin: Vector3, dir: Vector3, side: Vector3, zMax: number) {
  const fwdDot = dir.dot(VIEW_FORWARD);
  const at = (zv: number) => origin.clone().addScaledVector(dir, zv / fwdDot);
  const std: Vector3[] = [];
  const rev: Vector3[] = [];
  const tick = 0.1;
  for (let k = 0; k <= 16; k++) {
    const zv = distOf(k / 16);
    if (zv > zMax) break;
    const p = at(zv).addScaledVector(side, 0.12);
    std.push(p.clone().addScaledVector(side, -tick), p.clone().addScaledVector(side, tick));
  }
  // Reversed-Z: d' = 1 − d; float32 values are dense near d' = 0 (= far away).
  for (let e = -7; e <= -1; e++)
    for (let m = 8; m < 16; m += 2) {
      const dr = (m / 8) * 2 ** e;
      const zv = distOf(1 - dr);
      if (zv > zMax || zv < NEAR) continue;
      const p = at(zv).addScaledVector(side, -0.12);
      rev.push(p.clone().addScaledVector(side, -tick), p.clone().addScaledVector(side, tick));
    }
  const a = lineSet(group, std, COLORS.amber, 1);
  const b = lineSet(group, rev, COLORS.cyan, 1);
  const la = label(LBL.std, 'amber');
  la.position.copy(at(NEAR + 0.05).addScaledVector(side, 0.32));
  const lb = label(LBL.rev, 'cyan');
  lb.position.copy(at(Math.min(zMax, 4.2)).addScaledVector(side, -0.34));
  group.add(la, lb);
  return { a, b, la, lb };
}
const LBL = { std: 'D24: 1/16 steps', rev: 'rev-Z float' };

/* ------------------------------------------------------------------ */
/* Real data                                                           */
/* ------------------------------------------------------------------ */
function dataVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const api = ctx.state.api;
  const W = 160;
  const H = 100;
  const r = ctx.derived.render(api, W, H);
  const off = ctx.derived.render(api, W, H, { depthTest: false });
  const offNoCull = ctx.derived.render(api, W, H, { depthTest: false, cullBack: false });
  let dmin = 1;
  let dmax = 0;
  let maxO = 0;
  for (let p = 0; p < W * H; p++) {
    if (r.depth[p] < 1) {
      dmin = Math.min(dmin, r.depth[p]);
      dmax = Math.max(dmax, r.depth[p]);
    }
    maxO = Math.max(maxO, r.overdraw[p]);
  }
  if (dmax < dmin) [dmin, dmax] = [0, 1];
  const depthRgba = depthImage(r, dmin, dmax);
  const odRgba = new Uint8ClampedArray(W * H * 4);
  const odHist = new Array(maxO + 1).fill(0);
  for (let p = 0; p < W * H; p++) {
    const o = r.overdraw[p];
    odHist[o]++;
    const c = o === 0 ? BG : heat(0.85 - (0.85 * (o - 1)) / Math.max(1, maxO - 1));
    odRgba.set([c[0], c[1], c[2], 255], p * 4);
  }
  const diff = (a: RenderResult) => {
    let n = 0;
    for (let p = 0; p < W * H; p++) if (a.color[p * 4] !== r.color[p * 4] || a.color[p * 4 + 1] !== r.color[p * 4 + 1] || a.color[p * 4 + 2] !== r.color[p * 4 + 2]) n++;
    return n;
  };
  const diffOff = diff(off);
  const diffNoCull = diff(offNoCull);
  // The pixel with the most layers (closest to the model's center on ties): we follow its view ray.
  let probe = -1;
  let cx = 0;
  let cy = 0;
  let cn = 0;
  for (let p = 0; p < W * H; p++)
    if (r.depth[p] < 1) {
      cx += p % W;
      cy += Math.floor(p / W);
      cn++;
    }
  cx /= Math.max(1, cn);
  cy /= Math.max(1, cn);
  let best = -Infinity;
  for (let p = 0; p < W * H; p++) {
    if (r.depth[p] >= 1) continue;
    const score = r.overdraw[p] * 1000 - Math.hypot((p % W) - cx, Math.floor(p / W) - cy);
    if (score > best) {
      best = score;
      probe = p;
    }
  }
  const px = probe % W;
  const py = Math.floor(probe / W);

  const ms = createModelStage(host, ctx, { autoRotate: 0, shift: -0.12, eye: RIG_EYE, bloom: 0.35, bloomThreshold: 0.93 });
  virtualDepth(ms.material, ms.pivot.matrix, dmin, dmax);
  const rig = projectionRig(ms, 1.6);
  const lin = { depth: linImage(depthRgba), od: linImage(odRgba), on: linImage(r.color), off: linImage(off.color), offNoCull: linImage(offNoCull.color) };
  const screen = ms.screenPlane(lin.depth, W, H, rig.w);
  screen.mesh.position.copy(rig.group.position);
  screen.mesh.quaternion.copy(rig.group.quaternion);
  screen.mesh.translateZ(0.002);
  const fbLabel = label('', 'cyan');
  fbLabel.position.set(0, rig.h / 2 + 0.1, 0);
  rig.group.add(fbLabel);

  // The view ray through the probe pixel, and where it meets the model.
  const dir = viewRayPoint(px + 0.5, py + 0.5, W, H, 1).sub(VIRTUAL_EYE).normalize();
  const fwdDot = dir.dot(VIEW_FORWARD);
  const at = (zv: number) => VIRTUAL_EYE.clone().addScaledVector(dir, zv / fwdDot);
  const layers = rayLayers(ms, VIRTUAL_EYE, dir);
  const front = layers.filter((l) => l.front);
  const zEnd = Math.max(...layers.map((l) => l.zv), distOf(dmax)) + 0.5;
  const ray = lineSet(ms.scene, [at(rig.dist), at(zEnd)], COLORS.white, 0.55);
  const rayNear = lineSet(ms.scene, [at(NEAR), at(rig.dist)], COLORS.white, 0.2);
  const pixMark = glowDot(rig.group, rig.local(px + 0.5, py + 0.5, W, H, 0.01), COLORS.white, 0.1);
  const dots = layers.map((l, i) => {
    const d = glowDot(ms.scene, l.point, l.front ? COLORS.cyan : 0x6b7090, l.front ? 0.16 : 0.1);
    const lb = label(l.front ? `d ${l.d.toFixed(4)}` : t(L('baksida · cullad', 'back face · culled')), l.front ? 'cyan' : '');
    lb.position.set(0.0, 0.09 + (i % 4) * 0.1, 0);
    d.add(lb);
    return { ...l, mesh: d, lb };
  });
  const stored = label('', 'big');
  stored.position.copy(rig.local(px + 0.5, py + 0.5, W, H, 0.02)).add(new Vector3(0, -0.12, 0));
  rig.group.add(stored);
  const badge = label('', 'big');
  badge.position.set(0, 1.15, 0);
  ms.scene.add(badge);
  // Precision ticks (step 3), drawn beside the ray.
  const side = new Vector3().crossVectors(dir, new Vector3(0, 1, 0)).normalize();
  const ticks = new Group();
  ms.scene.add(ticks);
  LBL.std = t(L('D24: 16 jämna steg i d', 'D24: 16 even steps in d'));
  LBL.rev = t(L('reversed-Z float', 'reversed-Z float'));
  precisionTicks(ticks, VIRTUAL_EYE, dir, side, zEnd);

  /* ---------- Panels ---------- */
  const numbers = ms.panel('', []);
  const numHead = numbers.querySelector('.ms-head span')!;
  const numBody = numbers.querySelector('.ms-body')!;
  // 2D panel: the three images side by side (step 2) or the precision chart (step 3).
  const canvasHost = h('div.dp-cmp');
  const chartHost = h('div.dp-chart');
  const extra = ms.panel('', [canvasHost, chartHost]);
  const extraHead = extra.querySelector('.ms-head span')!;
  let bx0 = W;
  let by0 = H;
  let bx1 = 0;
  let by1 = 0;
  for (let p = 0; p < W * H; p++) {
    if (r.overdraw[p] === 0 && offNoCull.overdraw[p] === 0) continue;
    bx0 = Math.min(bx0, p % W);
    by0 = Math.min(by0, Math.floor(p / W));
    bx1 = Math.max(bx1, p % W);
    by1 = Math.max(by1, Math.floor(p / W));
  }
  if (bx1 < bx0) [bx0, by0, bx1, by1] = [0, 0, W - 1, H - 1];
  bx0 = Math.max(0, bx0 - 2);
  by0 = Math.max(0, by0 - 2);
  bx1 = Math.min(W - 1, bx1 + 2);
  by1 = Math.min(H - 1, by1 + 2);
  const CW = bx1 - bx0 + 1;
  const CH = by1 - by0 + 1;
  const crop = (rgba: Uint8ClampedArray) => {
    const out = new Uint8ClampedArray(CW * CH * 4);
    for (let y = 0; y < CH; y++) out.set(rgba.subarray(((by0 + y) * W + bx0) * 4, ((by0 + y) * W + bx0 + CW) * 4), y * CW * 4);
    return out;
  };
  const crops = [r, off, offNoCull].map((im) => crop(im.color));
  const GAP = Math.max(3, Math.round(CW * 0.06));
  const LABEL_ROWS = Math.max(3, Math.round(CH * 0.2));
  const pc = new PixelCanvas(canvasHost, CW * 3 + GAP * 2, CH + LABEL_ROWS, 4);
  let step = 0;
  let phase = 0; // step 2: 0 = test ON, 1 = OFF, 2 = OFF + no culling
  const names = () => [t(L('djuptest PÅ', 'depth test ON')), t(L('AV', 'OFF')), t(L('AV + ingen cull', 'OFF + no cull'))];
  const drawCmp = () => {
    pc.clear();
    crops.forEach((im, i) => {
      const x = i * (CW + GAP);
      blit(pc, im, CW, CH, x, LABEL_ROWS);
      const [qx, qy] = pc.px(x, LABEL_ROWS);
      const col = i === 0 ? '#5cf08f' : '#ff5a6e';
      pc.ctx.save();
      pc.ctx.strokeStyle = i === phase ? '#ffffff' : col;
      pc.ctx.shadowColor = col;
      pc.ctx.shadowBlur = i === phase ? 16 : 6;
      pc.ctx.lineWidth = i === phase ? 2.5 : 1;
      pc.ctx.strokeRect(qx + 0.5, qy + 0.5, CW * pc.cell - 1, CH * pc.cell - 1);
      pc.ctx.restore();
      pc.text(names()[i], x + CW / 2, LABEL_ROWS / 2, i === phase ? '#ffffff' : col, 10, 'center');
    });
  };
  pc.onResize(() => step === 2 && drawCmp());

  const buildChart = () => {
    const VW = 560;
    const VH = 300;
    const m = { l: 54, r: 16, t: 16, b: 40 };
    const X = (zz: number) => m.l + ((zz - NEAR) / (FAR - NEAR)) * (VW - m.l - m.r);
    const Y = (d: number) => VH - m.b - d * (VH - m.t - m.b);
    const path = (fn: (zz: number) => number) => {
      let d = '';
      for (let i = 0; i <= 120; i++) {
        const zz = NEAR + ((FAR - NEAR) * i) / 120;
        d += `${i ? 'L' : 'M'}${X(zz).toFixed(1)},${Y(fn(zz)).toFixed(1)}`;
      }
      return d;
    };
    const z0 = distOf(dmin);
    const z1 = distOf(dmax);
    const svg = s('svg', { viewBox: `0 0 ${VW} ${VH}`, class: 'dp-svg', preserveAspectRatio: 'xMidYMid meet' }, [
      s('rect', { x: X(z0), y: m.t, width: Math.max(2, X(z1) - X(z0)), height: VH - m.t - m.b, class: 'dp-band' }),
      ...[0, 0.25, 0.5, 0.75, 1].map((d) => s('line', { x1: m.l, x2: VW - m.r, y1: Y(d), y2: Y(d), class: 'dp-gridline' })),
      ...[0, 0.25, 0.5, 0.75, 1].map((d) => s('text', { x: m.l - 8, y: Y(d) + 4, 'text-anchor': 'end', class: 'dp-tick' }, [d.toFixed(2)])),
      ...[NEAR, 2, 4, 6, 8, FAR].map((zz) => s('text', { x: X(zz), y: VH - m.b + 16, 'text-anchor': 'middle', class: 'dp-tick' }, [String(zz)])),
      s('text', { x: (m.l + VW - m.r) / 2, y: VH - 6, 'text-anchor': 'middle', class: 'dp-axis' }, [t(L('avstånd från kameran (view space)', 'distance from camera (view space)'))]),
      s('text', { x: 14, y: VH / 2 - 10, transform: `rotate(-90 14 ${VH / 2 - 10})`, 'text-anchor': 'middle', class: 'dp-axis' }, [t(L('lagrat djup d', 'stored depth d'))]),
      s('path', { d: path(depthOf), class: 'dp-curve std' }),
      s('path', { d: path((zz) => 1 - depthOf(zz)), class: 'dp-curve rev' }),
      s('text', { x: X(5.2), y: Y(depthOf(5.2)) + 24, class: 'dp-lbl std' }, [t(L('standard: d = 0 nära → 1 långt bort', 'standard: d = 0 near → 1 far'))]),
      s('text', { x: X(5.2), y: Y(1 - depthOf(5.2)) - 14, class: 'dp-lbl rev' }, ['reversed-Z: 1 − d']),
      s('text', { x: X(z1) + 6, y: Y(0.55), class: 'dp-lbl band' }, [t(L('modellen', 'the model'))]),
    ]);
    chartHost.replaceChildren(svg);
  };
  const slope = (zz: number) => (FAR * NEAR) / (zz * zz * (FAR - NEAR));
  const zFar = distOf(dmax);
  const prec = [
    { name: 'D24 UNORM', steps: Math.round((dmax - dmin) * (2 ** 24 - 1)), dz: 2 ** -24 / slope(zFar) },
    { name: 'D32F', steps: floatsBetween(dmin, dmax), dz: ulp(dmax) / slope(zFar) },
    { name: 'D32F rev-Z', steps: floatsBetween(1 - dmax, 1 - dmin), dz: ulp(1 - dmax) / slope(zFar) },
  ];

  const row = (k: string, v: string, cls = '') => `<div class="dp-row"><span>${k}</span><b class="${cls}">${v}</b></div>`;
  const legend = (a: string, b: string) => `<div class="dp-legend"><i></i><div><span>${a}</span><span>${b}</span></div></div>`;
  const statRow = (items: [string, string, string?][]) => `<div class="stat-row">${items.map(([v, k, c]) => stat(v, k, c ?? '').outerHTML).join('')}</div>`;
  const pd = r.depth[probe];
  const titles = [
    L(`Djupbufferten · ${W}×${H}`, `The depth buffer · ${W}×${H}`),
    L('Djuptestet i siffror', 'The depth test in numbers'),
    L('Utan djuptest', 'Without a depth test'),
    L('Precision i modellens djup', 'Precision across the model'),
  ];
  const updateSide = () => {
    numHead.textContent = t(titles[step]);
    let html = '';
    if (step === 0) {
      html = `${statRow([[`${dmin.toFixed(3)}–${dmax.toFixed(3)}`, t(L('modellens d', 'model d')), 'glow-cyan'], [`${((dmax - dmin) * 100).toFixed(1)} %`, t(L('av [0, 1]', 'of [0, 1]')), 'glow-amber']])}
        ${legend(`${dmin.toFixed(4)} ${t(L('nära', 'near'))}`, `${dmax.toFixed(4)} ${t(L('långt', 'far'))}`)}
        ${row(t(L('rensad till', 'cleared to')), '1.0')}
        ${row(`pixel (${px}, ${py}): d`, pd.toFixed(5), 'glow-cyan')}
        ${row(api === 'opengl' ? 'NDC z = 2d − 1' : 'NDC z = d', (api === 'opengl' ? 2 * pd - 1 : pd).toFixed(5))}
        ${row(t(L('avstånd', 'distance')), distOf(pd).toFixed(3))}
        <p class="dp-note">${t(
          api === 'opengl'
            ? L('Modellen och planet visar samma djup (heat map). OpenGL: NDC z ∈ [−1, 1] mappas av glDepthRange till [0, 1].', 'The model and the plane show the same depth (heat map). OpenGL: NDC z ∈ [−1, 1] is mapped by glDepthRange to [0, 1].')
            : L(`Modellen och planet visar samma djup (heat map). ${api === 'vulkan' ? 'Vulkan' : 'D3D12'}: NDC z ∈ [0, 1] lagras direkt.`, `The model and the plane show the same depth (heat map). ${api === 'vulkan' ? 'Vulkan' : 'D3D12'}: NDC z ∈ [0, 1] is stored directly.`),
        )}</p>`;
    } else if (step === 1) {
      const st = r.stats;
      const pct = st.fragments ? (st.depthRejected / st.fragments) * 100 : 0;
      html = `${statRow([[st.written.toLocaleString(), t(L('skrivna', 'written')), 'c-idx'], [st.depthRejected.toLocaleString(), t(L('kastade', 'rejected')), 'dp-neg'], [`${maxO}×`, t(L('max överritning', 'max overdraw'))]])}
        <div class="dp-split"><i style="width:${100 - pct}%"></i><em style="width:${pct}%"></em></div>
        ${row(t(L(`pixel (${px}, ${py}): fragment`, `pixel (${px}, ${py}): fragments`)), `${r.overdraw[probe]} · ${front.length} ${t(L('framsidor på strålen', 'front faces on the ray'))}`)}
        ${legend('1×', `${maxO}×`)}
        ${odHist.map((n, o) => (o === 0 || !n ? '' : row(`${o}× ${t(L('fragment', 'fragments'))}`, `${n} px`))).join('')}
        <p class="dp-note">${t(L('Lagren längs strålen kommer i ritordning (triangelindex). LESS: närmare än det lagrade → skriv, annars kasta. Planet visar överritningen.', 'The layers along the ray arrive in draw order (triangle index). LESS: closer than what is stored → write, otherwise discard. The plane shows the overdraw.'))}</p>`;
    } else if (step === 2) {
      html = `${statRow([[`${diffOff} px`, t(L('fel, AV', 'wrong, OFF')), diffOff ? 'dp-neg' : 'c-idx'], [`${diffNoCull} px`, t(L('fel, AV + ingen cull', 'wrong, OFF + no cull')), 'dp-neg']])}
        <p class="dp-note" style="margin-top:0">${t(L('Modellen ritas live med djuptestet av och på. Utan test vinner det fragment som ritas <b>sist</b>, oavsett avstånd.', 'The model is drawn live with the depth test off and on. Without the test, the fragment drawn <b>last</b> wins, whatever its distance.'))}</p>
        <p class="dp-note">${t(
          diffOff < 10
            ? L('Modellen är (nästan) konvex: back-face culling räcker för att dölja baksidan. Stäng av culling också så syns felet.', 'This model is (almost) convex: back-face culling alone hides the far side. Turn culling off too and the error shows.')
            : L('Delar som borde vara skymda hamnar ovanpå – vilket som syns beror bara på ritordningen.', 'Parts that should be hidden end up on top – which one shows depends only on draw order.'),
        )}</p>`;
    } else {
      html = `${statRow([[prec[0].steps.toLocaleString(), t(L('D24-steg över modellen', 'D24 steps across the model')), 'glow-amber'], [fmtSci(prec[2].dz), t(L(`Δz rev-Z @ ${zFar.toFixed(2)}`, `Δz rev-Z @ ${zFar.toFixed(2)}`)), 'glow-cyan']])}
        <table class="dp-table"><thead><tr><th></th><th>${t(L('steg', 'steps'))}</th><th>Δz @ ${zFar.toFixed(2)}</th></tr></thead><tbody>
        ${prec.map((p, i) => `<tr class="${i === 2 ? 'best' : ''}"><td>${p.name}</td><td>${p.steps.toLocaleString()}</td><td>${fmtSci(p.dz)}</td></tr>`).join('')}
        </tbody></table>
        ${row('near / far', `${NEAR} / ${FAR}`)}
        <p class="dp-note">${t(L('Strecken längs strålen: gula = 16 jämna steg i lagrat d – de trängs nära kameran. Cyan = reversed-Z med float – täta långt bort, där de behövs.', 'The ticks along the ray: amber = 16 even steps in stored d – they crowd near the camera. Cyan = reversed-Z with float – dense far away, where they are needed.'))}</p>`;
    }
    numBody.innerHTML = html;
  };

  // Step 1: the layers arrive one by one and are tested against the stored depth.
  const seq = { k: 0 };
  let seqTween: ReturnType<ModelStage['tween']> | null = null;
  const applySeq = () => {
    const k = Math.floor(seq.k);
    let depth = 1;
    dots.forEach((d, i) => {
      if (step !== 1) {
        d.mesh.visible = step === 0 || step === 3 ? d.front : true;
        d.lb.visible = step === 0 && d.front;
        (d.mesh.material as ShaderMaterial).uniforms.uColor.value.set(d.front ? COLORS.cyan : 0x6b7090);
        return;
      }
      d.mesh.visible = i <= k;
      d.lb.visible = i <= k && d.front;
      if (i > k) return;
      let col = 0x6b7090;
      if (d.front) {
        const pass = d.d < depth;
        if (pass) depth = d.d;
        col = pass ? COLORS.green : COLORS.red;
        d.lb.element.textContent = `#${d.tri} d ${d.d.toFixed(4)} ${pass ? '<' : '≥'} ${t(L('lagrat', 'stored'))} → ${pass ? t(L('skriv', 'write')) : t(L('kasta', 'discard'))}`;
      } else d.lb.element.textContent = `#${d.tri} ${t(L('baksida · cullad', 'back face · culled'))}`;
      (d.mesh.material as ShaderMaterial).uniforms.uColor.value.set(col);
    });
    stored.element.textContent = step === 1 ? `${t(L('djupbuffert', 'depth buffer'))}: ${depth >= 1 ? '1.0 (clear)' : depth.toFixed(4)}` : '';
  };

  let phaseT = 0;
  const applyPhase = () => {
    const p = phase;
    ms.state({ depthTest: p === 0, cull: p === 2 ? 'none' : 'back' });
    screen.setImage([lin.on, lin.off, lin.offNoCull][p]);
    badge.element.textContent = [t(L('djuptest: PÅ', 'depth test: ON')), t(L('djuptest: AV', 'depth test: OFF')), t(L('djuptest: AV + ingen culling', 'depth test: OFF + no culling'))][p];
    badge.element.className = `three-label big ${p === 0 ? 'green' : 'red'}`;
    drawCmp();
  };
  ms.onFrame((time) => {
    if (step !== 2) return;
    const p = Math.floor((time - phaseT) / 2.8) % 3;
    if (p !== phase) {
      phase = p;
      applyPhase();
    }
  });
  let now = 0;
  ms.onFrame((time) => (now = time));

  return {
    show(st, animate) {
      seqTween?.kill();
      step = st;
      // Model look per step.
      ms.setMode(st === 0 || st === 3 ? 'depth' : 'shaded', 1, secs(animate, 0.6));
      if (st !== 2) ms.state({ depthTest: true, cull: 'back' });
      screen.setImage(st === 1 ? lin.od : st === 2 ? lin.on : lin.depth);
      fbLabel.element.textContent = st === 1 ? t(L('överritning per pixel', 'overdraw per pixel')) : st === 2 ? t(L('färgbuffert', 'color buffer')) : t(L(`djupbuffert · ${W}×${H}`, `depth buffer · ${W}×${H}`));
      screen.reveal(st === 0 && animate ? 0 : 1, 0);
      if (st === 0 && animate) screen.reveal(1, secs(animate, 1.4));
      ticks.visible = st === 3;
      ray.visible = rayNear.visible = pixMark.visible = true;
      badge.visible = st === 2;
      stored.visible = st === 1;
      canvasHost.style.display = st === 2 ? '' : 'none';
      chartHost.style.display = st === 3 ? '' : 'none';
      extra.style.display = st >= 2 ? '' : 'none';
      extraHead.textContent = st === 2 ? t(L('PÅ · AV · AV + ingen cull', 'ON · OFF · OFF + no cull')) : t(L('Lagrat djup mot avstånd', 'Stored depth vs distance'));
      if (st === 3) {
        buildChart();
        if (animate) chartHost.querySelectorAll('.dp-curve').forEach((p) => p.animate([{ strokeDashoffset: 1400 }, { strokeDashoffset: 0 }], { duration: secs(animate, 1.2) * 1000, easing: 'ease-out' }));
      }
      if (st === 2) {
        phase = 0;
        phaseT = now;
        applyPhase();
      }
      seq.k = st === 1 && animate ? -1 : dots.length;
      applySeq();
      if (st === 1 && animate) seqTween = ms.tween(seq, { k: dots.length - 0.01, duration: secs(animate, Math.min(7, 1 + dots.length * 0.9)), ease: 'none', onUpdate: applySeq });
      updateSide();
    },
    destroy() {
      seqTween?.kill();
      pc.destroy();
      ms.destroy();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Concept: three copies of the model at different depths arrive in   */
/* random order – with and without the depth test                      */
/* ------------------------------------------------------------------ */
function conceptVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const ms = createModelStage(host, ctx, { autoRotate: 0, eye: [1.15, 1.25, 4.5], bloom: 0.4, bloomThreshold: 0.93, layers: { solid: 0 } });
  const dists = [2.5, 3.3, 4.1];
  const sideV = new Vector3(1, 0, 0);
  const upV = new Vector3().crossVectors(VIEW_FORWARD.clone().negate(), sideV).normalize();
  const tints = [[0.22, 0.88, 1.0], [1.0, 0.35, 0.85], [1.0, 0.72, 0.3]];
  const css = ['#38e1ff', '#ff3fd2', '#ffb547'];
  const offsets = [-0.36, 0, 0.36];
  const zs = dists.map((d) => depthOf(d));
  const copies = dists.map((d, k) => {
    const mat = ms.material.clone() as typeof ms.material;
    // The stage's own model is hidden (opacity 0); the copies are opaque.
    mat.uniforms.uOpacity.value = 1;
    mat.transparent = false;
    const g = new Group();
    g.position.copy(VIRTUAL_EYE).addScaledVector(VIEW_FORWARD, d).addScaledVector(sideV, offsets[k]).addScaledVector(upV, (1 - k) * 0.06);
    g.scale.setScalar(0.56);
    g.rotation.set(0.25, 0.65 + k * 0.7, 0);
    const m = new Mesh(ms.layers.solid.geometry, mat);
    g.add(m);
    ms.scene.add(g);
    mat.uniforms.uBaseColor.value.setRGB(tints[k][0], tints[k][1], tints[k][2]);
    g.updateMatrix();
    virtualDepth(mat, g.matrix, depthOf(dists[0] - 0.5), depthOf(dists[2] + 0.5));
    const lb = label(`z ${zs[k].toFixed(2)}`, ['cyan', 'magenta', 'amber'][k]);
    lb.position.set(0, 1.25, 0);
    g.add(lb);
    return { g, m, mat, lb };
  });
  // The ray through the overlap.
  const target = copies[1].g.position.clone();
  const dir = target.clone().sub(VIRTUAL_EYE).normalize();
  const fwdDot = dir.dot(VIEW_FORWARD);
  const at = (zv: number) => VIRTUAL_EYE.clone().addScaledVector(dir, zv / fwdDot);
  lineSet(ms.scene, [at(NEAR), at(dists[2] + 0.9)], COLORS.white, 0.4);
  const hitAt = copies.map((c) => {
    const tt = c.g.position.clone().sub(VIRTUAL_EYE).dot(dir) - 0.4;
    return VIRTUAL_EYE.clone().addScaledVector(dir, tt);
  });
  const dots = hitAt.map((p, k) => glowDot(ms.scene, p, [COLORS.cyan, COLORS.magenta, COLORS.amber][k], 0.16));
  const pixel = glowDot(ms.scene, at(1.2), COLORS.white, 0.2);
  const pixLabel = label('', 'big');
  pixLabel.position.copy(at(1.2)).add(new Vector3(0, 0.22, 0));
  ms.scene.add(pixLabel);
  const ticks = new Group();
  ms.scene.add(ticks);
  LBL.std = t(L('16 jämna steg i d', '16 even steps in d'));
  LBL.rev = t(L('reversed-Z float', 'reversed-Z float'));
  precisionTicks(ticks, VIRTUAL_EYE, dir, new Vector3().crossVectors(dir, new Vector3(0, 1, 0)).normalize(), dists[2] + 0.9);

  const caption = ms.panel(t(L('Vad händer', 'What happens')), [h('p.dp-capt')], { side: 'bottom' });
  const text = caption.querySelector('.dp-capt')!;
  const captions = [
    L('Tre objekt på olika djup. Djupbufferten sparar, per pixel, det närmaste djupet hittills – färgen här är djupet. Den rensas till 1.0.', 'Three objects at different depths. The depth buffer stores, per pixel, the nearest depth so far – the color here is the depth. It is cleared to 1.0.'),
    L('De ritas i slumpvis ordning. Djuptest (LESS): närmare än det lagrade → skriv, annars kasta. Resultatet blir alltid rätt.', 'They are drawn in random order. Depth test (LESS): closer than what is stored → write, otherwise discard. The result is always right.'),
    L('Utan djuptest vinner den som ritas <b>sist</b> – ett objekt längre bort kan hamna framför.', 'Without a depth test, whoever is drawn <b>last</b> wins – an object farther away can end up in front.'),
    L('Djupet är inte linjärt: de gula strecken (16 jämna steg i d) trängs nära kameran. Reversed-Z + float (cyan) är tätare långt bort.', 'Depth is not linear: the amber ticks (16 even steps in d) crowd near the camera. Reversed-Z + float (cyan) is denser far away.'),
  ];
  const perms = [[1, 2, 0], [2, 0, 1], [2, 1, 0], [0, 2, 1], [1, 0, 2]];
  const FRAG = 1.2;
  const CYCLE = FRAG * 3 + 1.5;
  let step = 0;
  let t0 = 0;
  let now = 0;
  let lastCycle = -1;
  ms.onFrame((time, dt) => {
    now = time;
    copies.forEach((c, k) => (c.g.rotation.y += dt * (0.25 + k * 0.05)));
    if (step !== 1 && step !== 2) return;
    const tt = time - t0;
    const cyc = Math.floor(tt / CYCLE);
    const order = perms[cyc % perms.length];
    const ct = tt % CYCLE;
    if (cyc !== lastCycle) {
      lastCycle = cyc;
      order.forEach((ci, k) => (copies[ci].m.renderOrder = k));
    }
    let nearest = -1;
    let lastDrawn = -1;
    let drawn = 0;
    order.forEach((ci, k) => {
      const local = (ct - k * FRAG) / 0.45;
      const sc = Math.max(0, Math.min(1, local));
      copies[ci].g.scale.setScalar(0.56 * (sc < 1 ? sc * (1 + Math.sin(sc * Math.PI) * 0.25) : 1));
      copies[ci].g.visible = sc > 0;
      dots[ci].visible = sc > 0;
      if (sc > 0) {
        drawn++;
        lastDrawn = ci;
        if (nearest < 0 || zs[ci] < zs[nearest]) nearest = ci;
      }
    });
    if (step === 1) {
      pixLabel.element.textContent = nearest < 0 ? `${t(L('djupbuffert', 'depth buffer'))} 1.00` : `${t(L('djupbuffert', 'depth buffer'))} ${zs[nearest].toFixed(2)}${drawn === 3 ? ' ✓' : ''}`;
      pixLabel.element.style.color = nearest < 0 ? '' : css[nearest];
    } else {
      pixLabel.element.textContent = lastDrawn < 0 ? '–' : `${t(L('sist ritad vinner', 'last drawn wins'))}${drawn === 3 ? (lastDrawn === 0 ? ' ✓' : ' ✗') : ''}`;
      pixLabel.element.style.color = lastDrawn < 0 ? '' : css[lastDrawn];
    }
  });

  return {
    show(st, animate) {
      step = st;
      t0 = now;
      lastCycle = -1;
      text.innerHTML = t(captions[st]);
      if (animate) caption.animate([{ opacity: 0.3 }, { opacity: 1 }], { duration: secs(animate, 0.4) * 1000 });
      copies.forEach((c, k) => {
        c.mat.depthTest = c.mat.depthWrite = st !== 2;
        c.mat.uniforms.uMode.value = 3;
        c.mat.uniforms.uModeMix.value = st === 0 || st === 3 ? 1 : 0;
        c.m.renderOrder = k;
        c.g.visible = true;
        c.g.scale.setScalar(0.56);
        c.lb.visible = st !== 3;
        dots[k].visible = st >= 1;
      });
      pixel.visible = pixLabel.visible = st === 1 || st === 2;
      ticks.visible = st === 3;
    },
    destroy() {
      ms.destroy();
    },
  };
}

/* ------------------------------------------------------------------ */
/* API panels                                                          */
/* ------------------------------------------------------------------ */
function apis(): Record<ApiId, ApiPanelSpec> {
  const gl = `GLuint depthTex;
glCreateTextures(GL_TEXTURE_2D, 1, &depthTex);
glTextureStorage2D(depthTex, 1, GL_DEPTH_COMPONENT32F, w, h);
glNamedFramebufferTexture(fbo, GL_DEPTH_ATTACHMENT, depthTex, 0);

glEnable(GL_DEPTH_TEST);
glDepthFunc(GL_LESS);          // pass if z < stored
glDepthMask(GL_TRUE);          // write z on pass
glClearDepth(1.0);
glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);

// reversed-Z: glClipControl(GL_LOWER_LEFT, GL_ZERO_TO_ONE);
//             glClearDepth(0.0); glDepthFunc(GL_GREATER);`;
  const vk = `VkPipelineDepthStencilStateCreateInfo ds{
    VK_STRUCTURE_TYPE_PIPELINE_DEPTH_STENCIL_STATE_CREATE_INFO};
ds.depthTestEnable  = VK_TRUE;
ds.depthWriteEnable = VK_TRUE;
ds.depthCompareOp   = VK_COMPARE_OP_LESS;  // reversed-Z: GREATER
pipelineRendering.depthAttachmentFormat = VK_FORMAT_D32_SFLOAT;

VkRenderingAttachmentInfo depth{VK_STRUCTURE_TYPE_RENDERING_ATTACHMENT_INFO};
depth.imageView   = depthView;   // image in DEPTH_ATTACHMENT_OPTIMAL
depth.imageLayout = VK_IMAGE_LAYOUT_DEPTH_ATTACHMENT_OPTIMAL;
depth.loadOp      = VK_ATTACHMENT_LOAD_OP_CLEAR;
depth.storeOp     = VK_ATTACHMENT_STORE_OP_DONT_CARE;
depth.clearValue.depthStencil = { 1.0f, 0 };
renderingInfo.pDepthAttachment = &depth;
vkCmdBeginRendering(cmd, &renderingInfo);`;
  const dx = `D3D12_DESCRIPTOR_HEAP_DESC hd{ D3D12_DESCRIPTOR_HEAP_TYPE_DSV, 1 };
device->CreateDescriptorHeap(&hd, IID_PPV_ARGS(&dsvHeap));
D3D12_CLEAR_VALUE clear{ DXGI_FORMAT_D32_FLOAT };
clear.DepthStencil = { 1.0f, 0 };   // optimized clear value
// CreateCommittedResource(... ALLOW_DEPTH_STENCIL, DEPTH_WRITE, &clear ...)
device->CreateDepthStencilView(depthTex.Get(), nullptr, dsv);

pso.DepthStencilState.DepthEnable    = TRUE;
pso.DepthStencilState.DepthWriteMask = D3D12_DEPTH_WRITE_MASK_ALL;
pso.DepthStencilState.DepthFunc      = D3D12_COMPARISON_FUNC_LESS;
pso.DSVFormat = DXGI_FORMAT_D32_FLOAT;

cmd->ClearDepthStencilView(dsv, D3D12_CLEAR_FLAG_DEPTH, 1.0f, 0, 0, nullptr);
cmd->OMSetRenderTargets(1, &rtv, FALSE, &dsv);`;
  return {
    opengl: {
      note: L(
        'Djuptestet är fast funktion efter fragment shadern (eller före, med early-Z). I OpenGL: en djup-attachment på framebuffern och några globala tillstånd.',
        'The depth test is fixed function after the fragment shader (or before it, with early-Z). In OpenGL: a depth attachment on the framebuffer and a few global states.',
      ),
      code: [{ lang: 'cpp', src: gl, highlight: [[1, 2, 3, 4, 9, 10], [6, 7, 8], [6], [3, 12, 13]] }],
      terms: [
        { term: 'GL_LESS', desc: L('Fragmentet klarar testet om dess z är mindre än det lagrade.', 'The fragment passes if its z is less than the stored value.') },
        { term: 'glDepthMask', desc: L('Om djupet skrivs vid godkänt test (av för genomskinligt).', 'Whether depth is written on pass (off for transparency).') },
        { term: 'glClipControl', desc: L('GL 4.5: välj NDC z ∈ [0, 1] – krävs för bra reversed-Z i OpenGL.', 'GL 4.5: choose NDC z ∈ [0, 1] – needed for good reversed-Z in OpenGL.') },
        { term: 'early-Z', desc: L('Hårdvaran testar djupet före shadern när shadern inte skriver gl_FragDepth eller kör discard.', 'Hardware tests depth before the shader when the shader does not write gl_FragDepth or use discard.') },
      ],
      you: L('skapar djupbuffert, väljer jämförelse', 'create depth buffer, choose compare op'),
      driver: L('GPU:n testar varje fragment', 'the GPU tests every fragment'),
    },
    vulkan: {
      note: L(
        'I Vulkan är djuptestet pipeline-tillstånd, och djupbilden kopplas in som attachment i VkRenderingInfo (dynamic rendering) med clear-värde.',
        'In Vulkan the depth test is pipeline state, and the depth image is attached in VkRenderingInfo (dynamic rendering) with a clear value.',
      ),
      code: [{ lang: 'cpp', src: vk, highlight: [[6, 8, 9, 10, 11, 13, 14, 15], [1, 2, 3, 4, 5], [3], [5, 6]] }],
      terms: [
        { term: 'VK_FORMAT_D32_SFLOAT', desc: L('32-bitars float-djup; bäst för reversed-Z.', '32-bit float depth; best for reversed-Z.') },
        { term: 'STORE_OP_DONT_CARE', desc: L('Djupet behövs inte efter passet – sparar bandbredd (särskilt på tile-GPU:er).', 'Depth is not needed after the pass – saves bandwidth (especially on tilers).') },
        { term: 'early fragment tests', desc: L('Kan tvingas med layout(early_fragment_tests) in; i GLSL.', 'Can be forced with layout(early_fragment_tests) in; in GLSL.') },
      ],
      you: L('skapar djupbild, barriärer, pipeline-state', 'create depth image, barriers, pipeline state'),
      driver: L('GPU:n testar varje fragment', 'the GPU tests every fragment'),
    },
    d3d12: {
      note: L(
        'I D3D12 behöver djupbufferten en DSV i en egen descriptor heap. Testet ligger i PSO:ns DepthStencilState, och bufferten rensas med ClearDepthStencilView.',
        'In D3D12 the depth buffer needs a DSV in its own descriptor heap. The test lives in the PSO\'s DepthStencilState, and the buffer is cleared with ClearDepthStencilView.',
      ),
      code: [{ lang: 'cpp', src: dx, highlight: [[1, 2, 3, 4, 5, 6, 13, 14], [8, 9, 10, 11], [8], [3, 11]] }],
      terms: [
        { term: 'DSV', desc: L('Depth Stencil View – deskriptorn som låter OM-steget skriva djupet.', 'Depth Stencil View – the descriptor that lets the OM stage write depth.') },
        { term: 'optimized clear value', desc: L('Clear-värdet anges när resursen skapas; att rensa till samma värde är snabbast.', 'The clear value given at resource creation; clearing to the same value is fastest.') },
        { term: 'DXGI_FORMAT_D32_FLOAT', desc: L('32-bitars float-djup; D24_UNORM_S8_UINT om du även vill ha stencil.', '32-bit float depth; D24_UNORM_S8_UINT if you also need stencil.') },
      ],
      you: L('skapar heap, DSV, PSO-state', 'create heap, DSV, PSO state'),
      driver: L('GPU:n testar varje fragment', 'the GPU tests every fragment'),
    },
  };
}

export default standardSlide({
  id: 'depth',
  group: 'gpu-fixed',
  short: L('Djuptest', 'Depth test'),
  title: L('Djuptest – vad ligger närmast?', 'Depth test – what is closest?'),
  lead: L(
    'Trianglar ritas i den ordning de skickas, inte bakifrån och fram. <b>Djupbufferten</b> sparar närmaste djupet per pixel så att skymda fragment kan kastas.',
    'Triangles are drawn in submission order, not back to front. The <b>depth buffer</b> stores the nearest depth per pixel so hidden fragments can be thrown away.',
  ),
  bullets: [
    L(
      'Djupbufferten är en bild med ett tal per pixel: djupet d ∈ [0, 1]. Den rensas till <b>1.0</b> (längst bort) varje frame.',
      'The depth buffer is an image with one number per pixel: the depth d ∈ [0, 1]. It is cleared to <b>1.0</b> (farthest) every frame.',
    ),
    L(
      'Varje fragment jämförs mot det lagrade värdet (<code>LESS</code>): närmare → färg och djup skrivs; annars kastas det. <b>Överritning</b> = flera fragment på samma pixel.',
      'Every fragment is compared with the stored value (<code>LESS</code>): closer → color and depth are written; otherwise it is discarded. <b>Overdraw</b> = several fragments on one pixel.',
    ),
    L(
      'Utan djuptest vinner det fragment som ritas <b>sist</b> – bakre delar kan hamna framför främre.',
      'Without a depth test, the fragment drawn <b>last</b> wins – rear parts can end up in front.',
    ),
    L(
      'Djupet är <b>icke-linjärt</b> (∝ 1/z): precisionen tar slut långt bort. <b>Reversed-Z</b> (nära = 1, <code>GREATER</code>) med float-djup jämnar ut felet.',
      'Depth is <b>non-linear</b> (∝ 1/z): precision runs out far away. <b>Reversed-Z</b> (near = 1, <code>GREATER</code>) with float depth evens out the error.',
    ),
  ],
  api: apis,
  data: dataVisual,
  concept: conceptVisual,
});
