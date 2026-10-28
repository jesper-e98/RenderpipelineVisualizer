import gsap from 'gsap';
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  Group,
  LineBasicMaterial,
  LineLoop,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Points,
  PointsMaterial,
  Vector3,
  Vector4,
} from 'three';
import '../styles/slides/clipping.css';
import { SHOWCASE_ROT_X, SHOWCASE_ROT_Y } from '../core/derived';
import { dur, h, num } from '../core/dom';
import { L, type Text } from '../core/i18n';
import type { ApiId } from '../core/state';
import { clipPlanes, clipPolygon, clipTriangle, type ClipVertex } from '../pipeline/clip';
import { DEFAULT_CAMERA, modelMatrix, projectionMatrix, viewMatrix, type Camera, type V4 } from '../pipeline/transform';
import type { StageView } from '../views/ThreeStage';
import { COLORS, disposeScene, label, makeScene, starfield } from '../views/three-helpers';
import { card, stat } from '../views/widgets';
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

function glowTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.25, 'rgba(255,255,255,0.8)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  return new CanvasTexture(c);
}

const mulV4 = (m: Matrix4, x: number, y: number, z: number): V4 => {
  const e = m.elements;
  return [e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14], e[3] * x + e[7] * y + e[11] * z + e[15]];
};

/** A 2D canvas that tracks its host size (DPR aware) and redraws on resize. */
function autoCanvas(host: HTMLElement, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void) {
  const canvas = h('canvas.clip-canvas');
  host.append(canvas);
  const g = canvas.getContext('2d')!;
  let w = 1;
  let hh = 1;
  const redraw = () => {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, canvas.width, canvas.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(g, w, hh);
  };
  const ro = new ResizeObserver(() => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = Math.max(1, host.clientWidth);
    hh = Math.max(1, host.clientHeight);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(hh * dpr);
    redraw();
  });
  ro.observe(host);
  return { canvas, redraw, destroy: () => ro.disconnect() };
}

/* ------------------------------------------------------------------ */
/* Data: real clip coordinates + a "camera too close" case             */
/* ------------------------------------------------------------------ */
interface ZoomCase {
  sampled: number;
  stride: number;
  inside: number;
  clipped: number;
  outside: number;
  outTris: number;
  newVerts: number;
  crossNearFar: number;
  crossXYOnly: number;
  /** Triangles drawn in the canvas (NDC xy), only those with all w > 0. */
  before: { ndc: number[]; kind: 0 | 1 | 2 }[];
  /** Clipped polygons in NDC + which vertices are new. */
  after: { ndc: number[]; fresh: boolean[]; nearFar: boolean }[];
  example: { tri: number; nIn: number; nOut: number } | null;
  camDist: number;
}

const ZOOM = 0.42;
const DRAW_CAP = 8000;

function zoomCase(ctx: SlideContext): ZoomCase {
  const api = ctx.state.api;
  const mesh = ctx.state.mesh;
  const cam: Camera = { ...DEFAULT_CAMERA, eye: DEFAULT_CAMERA.eye.map((v) => v * ZOOM) as [number, number, number] };
  const mvp = projectionMatrix(api, cam, ASPECT).multiply(viewMatrix(cam)).multiply(modelMatrix(SHOWCASE_ROT_Y, SHOWCASE_ROT_X));
  const clip: V4[] = new Array(mesh.vertexCount);
  for (let i = 0; i < mesh.vertexCount; i++) clip[i] = mulV4(mvp, mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]);
  const planes = clipPlanes(api);
  const stride = Math.max(1, Math.ceil(mesh.triangleCount / 60000));
  const res: ZoomCase = {
    sampled: 0,
    stride,
    inside: 0,
    clipped: 0,
    outside: 0,
    outTris: 0,
    newVerts: 0,
    crossNearFar: 0,
    crossXYOnly: 0,
    before: [],
    after: [],
    example: null,
    camDist: new Vector3(...cam.eye).length(),
  };
  const drawStride = Math.max(1, Math.ceil(mesh.triangleCount / stride / DRAW_CAP));
  let bestScore = -1;
  for (let t = 0, k = 0; t < mesh.triangleCount; t += stride, k++) {
    res.sampled++;
    const ids = [mesh.indices[t * 3], mesh.indices[t * 3 + 1], mesh.indices[t * 3 + 2]];
    const tri = ids.map((v, j) => ({ pos: clip[v], attrs: [j === 0 ? 1 : 0, j === 1 ? 1 : 0, j === 2 ? 1 : 0] })) as [ClipVertex, ClipVertex, ClipVertex];
    const r = clipTriangle(api, tri);
    const draw = k % drawStride === 0;
    const allW = tri.every((v) => v.pos[3] > 1e-6);
    const ndcOf = (p: V4) => [p[0] / p[3], p[1] / p[3]];
    if (r.result === 'inside') {
      res.inside++;
      res.outTris++;
      if (draw) res.before.push({ ndc: tri.flatMap((v) => ndcOf(v.pos)), kind: 0 });
      continue;
    }
    if (r.result === 'outside') {
      res.outside++;
      if (draw && allW) res.before.push({ ndc: tri.flatMap((v) => ndcOf(v.pos)), kind: 2 });
      continue;
    }
    res.clipped++;
    res.outTris += r.triangles.length;
    const nf = [planes[4], planes[5]].some((pl) => tri.some((v) => pl.dist(v.pos) < 0));
    if (nf) res.crossNearFar++;
    else res.crossXYOnly++;
    const poly = clipPolygon(api, tri);
    const fresh = poly.map((v) => Math.max(...v.attrs) < 0.9999);
    res.newVerts += fresh.filter(Boolean).length;
    if (draw) {
      if (allW) res.before.push({ ndc: tri.flatMap((v) => ndcOf(v.pos)), kind: 1 });
      res.after.push({ ndc: poly.flatMap((v) => ndcOf(v.pos)), fresh, nearFar: nf });
    }
    // An example: a clipped triangle with many output vertices and a decent size on screen.
    if (allW) {
      const xs = poly.map((v) => v.pos[0] / v.pos[3]);
      const ys = poly.map((v) => v.pos[1] / v.pos[3]);
      const size = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
      const score = poly.length * 10 + Math.min(size, 0.5) * 20;
      if (score > bestScore) {
        bestScore = score;
        res.example = { tri: t, nIn: 3, nOut: poly.length };
      }
    }
  }
  return res;
}

function dataVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const api = ctx.state.api;
  const mesh = ctx.state.mesh;
  const r = ctx.derived.render(api, 160, 100);
  const st = r.stats;
  const tri = ctx.derived.showcaseTriangle(api);
  const verts = ctx.derived.triangleVertices(tri);
  const mvp = r.matrices.mvp;
  const sc = verts.map((v) => mulV4(mvp, ...ctx.derived.position(v)));
  const planes = clipPlanes(api);
  const zc = zoomCase(ctx);
  const yDown = api === 'vulkan';
  const zMin = api === 'opengl' ? -1 : 0;

  // Default-view NDC for all vertices (for the background mesh drawings), capped.
  const vStride = Math.max(1, Math.ceil(mesh.vertexCount / 6000));
  const allClip: V4[] = [];
  for (let i = 0; i < mesh.vertexCount; i += vStride) allClip.push(mulV4(mvp, mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]));
  const tStride = Math.max(1, Math.ceil(mesh.triangleCount / 12000));
  const meshNdc: number[] = [];
  for (let k = 0; k < mesh.triangleCount; k += tStride) {
    for (let j = 0; j < 3; j++) {
      const v = mesh.indices[k * 3 + j];
      const c = mulV4(mvp, mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]);
      meshNdc.push(c[0] / c[3], c[1] / c[3]);
    }
  }

  /* ---------- Canvas ---------- */
  const canvasHost = h('div.clip-canvas-host');
  const cap = h('div.clip-cap');
  canvasHost.append(cap);
  let step = 0;
  let fade = 1;
  const VCOL = ['#38e1ff', '#ff3fd2', '#ffb547'];

  const drawWedges = (g: CanvasRenderingContext2D, w: number, hh: number) => {
    // Two plots of homogeneous clip space: (x, w) and (z, w). Inside = between the lines.
    const pad = 26;
    const pw = (w - pad * 3) / 2;
    const ph = hh - pad * 2 - 18;
    const wMax = Math.max(...sc.map((p) => p[3]), ...allClip.map((p) => p[3])) * 1.12;
    const plots = [
      { title: 'x  vs  w', comp: 0, lo: (wv: number) => -wv, hi: (wv: number) => wv, range: [-wMax, wMax] },
      { title: 'z  vs  w', comp: 2, lo: (wv: number) => (api === 'opengl' ? -wv : 0), hi: (wv: number) => wv, range: [api === 'opengl' ? -wMax : -wMax * 0.35, wMax] },
    ];
    plots.forEach((pl, i) => {
      const ox = pad + i * (pw + pad);
      const oy = pad + 10;
      const X = (v: number) => ox + ((v - pl.range[0]) / (pl.range[1] - pl.range[0])) * pw;
      const Y = (wv: number) => oy + ph - (wv / wMax) * ph;
      g.fillStyle = 'rgba(4,6,16,0.7)';
      g.fillRect(ox, oy, pw, ph);
      g.strokeStyle = 'rgba(140,160,255,0.25)';
      g.strokeRect(ox + 0.5, oy + 0.5, pw, ph);
      // Inside region.
      g.beginPath();
      g.moveTo(X(pl.lo(0)), Y(0));
      g.lineTo(X(pl.lo(wMax)), Y(wMax));
      g.lineTo(X(pl.hi(wMax)), Y(wMax));
      g.lineTo(X(pl.hi(0)), Y(0));
      g.closePath();
      g.fillStyle = 'rgba(92,240,143,0.08)';
      g.fill();
      g.save();
      g.shadowColor = '#ffb547';
      g.shadowBlur = 8;
      g.strokeStyle = '#ffb547';
      g.lineWidth = 1.6;
      g.beginPath();
      g.moveTo(X(pl.lo(0)), Y(0));
      g.lineTo(X(pl.lo(wMax)), Y(wMax));
      g.moveTo(X(pl.hi(0)), Y(0));
      g.lineTo(X(pl.hi(wMax)), Y(wMax));
      g.stroke();
      g.restore();
      // Axes.
      g.strokeStyle = 'rgba(140,160,255,0.35)';
      g.beginPath();
      g.moveTo(X(0), oy);
      g.lineTo(X(0), oy + ph);
      g.stroke();
      g.font = '600 11px "JetBrains Mono", monospace';
      g.fillStyle = '#9aa3c7';
      g.textAlign = 'left';
      g.fillText(pl.title, ox + 6, oy - 8);
      g.fillStyle = '#ffb547';
      const loLabel = i === 0 ? 'x = −w' : api === 'opengl' ? 'z = −w' : 'z = 0';
      const hiLabel = i === 0 ? 'x = w' : 'z = w';
      g.textAlign = 'left';
      g.fillText(loLabel, X(pl.lo(wMax)) + 4, oy + 12);
      g.textAlign = 'right';
      g.fillText(hiLabel, X(pl.hi(wMax)) - 4, oy + 12);
      // Mesh vertices.
      g.fillStyle = 'rgba(155,123,255,0.45)';
      for (const p of allClip) g.fillRect(X(p[pl.comp]) - 1, Y(p[3]) - 1, 2, 2);
      // Showcase vertices.
      sc.forEach((p, k) => {
        g.save();
        g.shadowColor = VCOL[k];
        g.shadowBlur = 12;
        g.fillStyle = VCOL[k];
        g.beginPath();
        g.arc(X(p[pl.comp]), Y(p[3]), 4.5, 0, Math.PI * 2);
        g.fill();
        g.restore();
      });
      g.fillStyle = '#646d94';
      g.textAlign = 'center';
      g.fillText(i === 0 ? 'x →' : 'z →', ox + pw / 2, oy + ph + 14);
    });
  };

  const ndcFrame = (w: number, hh: number, extent: number) => {
    const vh = Math.min((hh - 40) / (2 * extent), (w - 20) / (2 * extent * ASPECT));
    const vw = vh * ASPECT;
    const cx = w / 2;
    const cy = hh / 2 + 6;
    return {
      X: (x: number) => cx + x * vw,
      Y: (y: number) => cy + (yDown ? y : -y) * vh,
      vw,
      vh,
      cx,
      cy,
    };
  };
  const poly = (g: CanvasRenderingContext2D, X: (x: number) => number, Y: (y: number) => number, pts: number[]) => {
    g.beginPath();
    for (let i = 0; i < pts.length; i += 2) {
      if (i === 0) g.moveTo(X(pts[i]), Y(pts[i + 1]));
      else g.lineTo(X(pts[i]), Y(pts[i + 1]));
    }
    g.closePath();
  };
  const viewportRect = (g: CanvasRenderingContext2D, F: ReturnType<typeof ndcFrame>, color: string) => {
    g.save();
    g.shadowColor = color;
    g.shadowBlur = 14;
    g.strokeStyle = color;
    g.lineWidth = 1.6;
    g.strokeRect(F.X(-1), Math.min(F.Y(-1), F.Y(1)), F.vw * 2, F.vh * 2);
    g.restore();
  };

  const drawZoom = (g: CanvasRenderingContext2D, w: number, hh: number, guard: boolean) => {
    const F = ndcFrame(w, hh, 1.7);
    g.save();
    g.beginPath();
    g.rect(0, 0, w, hh);
    g.clip();
    if (guard) {
      g.fillStyle = 'rgba(155,123,255,0.06)';
      g.fillRect(F.X(-1.6), Math.min(F.Y(-1.6), F.Y(1.6)), F.vw * 3.2, F.vh * 3.2);
      g.setLineDash([5, 5]);
      g.strokeStyle = 'rgba(155,123,255,0.7)';
      g.strokeRect(F.X(-1.6), Math.min(F.Y(-1.6), F.Y(1.6)), F.vw * 3.2, F.vh * 3.2);
      g.setLineDash([]);
    }
    // Before: original triangles (only those fully in front of the camera can be drawn).
    g.lineWidth = 0.7;
    for (const b of zc.before) {
      poly(g, F.X, F.Y, b.ndc);
      if (b.kind === 0) {
        g.fillStyle = 'rgba(56,225,255,0.16)';
        g.fill();
        g.strokeStyle = 'rgba(56,225,255,0.35)';
      } else {
        g.fillStyle = `rgba(255,90,110,${0.07 * fade + 0.02})`;
        g.fill();
        g.strokeStyle = `rgba(255,90,110,${0.4 * fade + 0.1})`;
      }
      g.stroke();
    }
    // After: clipped polygons.
    for (const a of zc.after) {
      poly(g, F.X, F.Y, a.ndc);
      const c = guard ? (a.nearFar ? '255,181,71' : '155,123,255') : '56,225,255';
      g.fillStyle = `rgba(${c},0.22)`;
      g.fill();
      g.strokeStyle = `rgba(${c},0.75)`;
      g.stroke();
    }
    // New vertices created on the planes.
    g.fillStyle = '#ffb547';
    let n = 0;
    for (const a of zc.after) {
      a.fresh.forEach((f, i) => {
        if (!f || n > 3000) return;
        n++;
        g.fillRect(F.X(a.ndc[i * 2]) - 1.2, F.Y(a.ndc[i * 2 + 1]) - 1.2, 2.4, 2.4);
      });
    }
    g.restore();
    viewportRect(g, F, '#5cf08f');
    g.font = '600 11px "JetBrains Mono", monospace';
    g.fillStyle = '#5cf08f';
    g.textAlign = 'left';
    g.fillText('NDC [−1, 1]²', F.X(-1) + 4, Math.min(F.Y(-1), F.Y(1)) - 6);
    if (guard) {
      g.fillStyle = '#9b7bff';
      g.fillText("guard band", F.X(-1.6) + 4, Math.min(F.Y(-1.6), F.Y(1.6)) + 14);
    }
  };

  const drawNdc = (g: CanvasRenderingContext2D, w: number, hh: number) => {
    const F = ndcFrame(w, hh, 1.12);
    g.fillStyle = 'rgba(4,6,16,0.75)';
    g.fillRect(F.X(-1), Math.min(F.Y(-1), F.Y(1)), F.vw * 2, F.vh * 2);
    g.lineWidth = 0.6;
    g.strokeStyle = 'rgba(155,123,255,0.28)';
    g.beginPath();
    for (let i = 0; i < meshNdc.length; i += 6) {
      g.moveTo(F.X(meshNdc[i]), F.Y(meshNdc[i + 1]));
      g.lineTo(F.X(meshNdc[i + 2]), F.Y(meshNdc[i + 3]));
      g.lineTo(F.X(meshNdc[i + 4]), F.Y(meshNdc[i + 5]));
      g.closePath();
    }
    g.stroke();
    viewportRect(g, F, '#5cf08f');
    // Axes labels.
    g.font = '600 11px "JetBrains Mono", monospace';
    g.fillStyle = '#9aa3c7';
    g.textAlign = 'left';
    g.fillText('(−1, −1)', F.X(-1) + 4, F.Y(-1) + (yDown ? 14 : -6));
    g.textAlign = 'right';
    g.fillText('(1, 1)', F.X(1) - 4, F.Y(1) + (yDown ? -6 : 14));
    g.textAlign = 'center';
    g.fillStyle = '#5cf08f';
    g.fillText(yDown ? '+y ↓' : '+y ↑', F.X(0), Math.min(F.Y(-1), F.Y(1)) - 6);
    // Showcase triangle.
    const nd = sc.map((p) => [p[0] / p[3], p[1] / p[3], p[2] / p[3]]);
    g.save();
    g.shadowColor = '#ff3fd2';
    g.shadowBlur = 16;
    poly(g, F.X, F.Y, nd.flatMap((p) => [p[0], p[1]]));
    g.fillStyle = 'rgba(255,63,210,0.35)';
    g.fill();
    g.strokeStyle = '#ff3fd2';
    g.lineWidth = 2;
    g.stroke();
    g.restore();
    nd.forEach((p, k) => {
      g.save();
      g.shadowColor = VCOL[k];
      g.shadowBlur = 10;
      g.fillStyle = VCOL[k];
      g.beginPath();
      g.arc(F.X(p[0]), F.Y(p[1]), 4, 0, Math.PI * 2);
      g.fill();
      g.restore();
    });
    // Depth bar with this API's NDC z range.
    const bx = Math.min(w - 26, F.X(1) + 22);
    const by0 = F.cy - F.vh;
    const by1 = F.cy + F.vh;
    const ZY = (z: number) => by0 + ((z - zMin) / (1 - zMin)) * (by1 - by0);
    const grad = g.createLinearGradient(0, by0, 0, by1);
    grad.addColorStop(0, 'rgba(255,250,220,0.85)');
    grad.addColorStop(1, 'rgba(110,70,255,0.6)');
    g.fillStyle = grad;
    g.fillRect(bx - 4, by0, 8, by1 - by0);
    g.fillStyle = '#9aa3c7';
    g.textAlign = 'right';
    g.fillText(`z ${zMin === -1 ? '−1' : '0'}`, bx - 8, by0 + 8);
    g.fillText('z 1', bx - 8, by1);
    nd.forEach((p, k) => {
      g.fillStyle = VCOL[k];
      g.fillRect(bx - 9, ZY(p[2]) - 1, 18, 2.5);
    });
  };

  const cv = autoCanvas(canvasHost, (g, w, hh) => {
    g.globalAlpha = 1;
    if (step === 0) drawWedges(g, w, hh);
    else if (step === 1) drawZoom(g, w, hh, false);
    else if (step === 2) drawNdc(g, w, hh);
    else drawZoom(g, w, hh, true);
  });

  /* ---------- Cards ---------- */
  const labels = PLANE_LABEL(api);
  const vName = ['v0', 'v1', 'v2'];
  const testTable = h('table.clip-table', {}, [
    h('thead', {}, [h('tr', {}, [h('th', { text: '' }), h('th', { text: 'clip (x, y, z, w)' }), ...labels.map((l, i) => h(`th${i === 4 ? '.api' : ''}`, { text: l }))])]),
    h(
      'tbody',
      {},
      sc.map((p, k) =>
        h('tr', {}, [
          h('td', {}, [h('span.clip-v', { text: vName[k], style: { color: VCOL[k] } })]),
          h('td.mono', { text: p.map((x) => num(x, 2)).join(' ') }),
          ...planes.map((pl) => {
            const d = pl.dist(p);
            return h(`td.mono.${d >= 0 ? 'ok' : 'bad'}`, { text: `${d >= 0 ? '✓' : '✗'}` , attrs: { title: num(d, 3) } });
          }),
        ]),
      ),
    ),
  ]);
  const inside = sc.every((p) => planes.every((pl) => pl.dist(p) >= 0));
  const card0 = card(t(L(`Triangel #${tri} i clip space`, `Triangle #${tri} in clip space`)), [
    testTable,
    h('div.clip-note', {
      html: t(
        L(
          `Testerna görs <b>före</b> divisionen, mot w. ${api === 'opengl' ? 'OpenGL' : api === 'vulkan' ? 'Vulkan' : 'D3D12'}: <code>${zRange(api)}</code>. ${inside ? 'Alla tre hörnen är innanför → triangeln passerar orörd.' : 'Minst ett hörn är utanför.'}`,
          `The tests happen <b>before</b> the divide, against w. ${api === 'opengl' ? 'OpenGL' : api === 'vulkan' ? 'Vulkan' : 'D3D12'}: <code>${zRange(api)}</code>. ${inside ? 'All three corners are inside → the triangle passes untouched.' : 'At least one corner is outside.'}`,
        ),
      ),
    }),
  ]);

  const ex = zc.example;
  const card1 = card(t(L('Klippning – hela modellen', 'Clipping – the whole model')), [
    h('div.clip-sub', { text: t(L('Standardkameran (samma bild som alla slides):', 'Default camera (the same frame every slide uses):')) }),
    h('div.stat-row', {}, [
      stat(st.trianglesIn.toLocaleString(), t(L('in', 'in'))),
      stat((st.trianglesIn - st.clipped - st.clippedAway).toLocaleString(), t(L('helt innanför', 'fully inside')), 'glow-cyan'),
      stat(st.clipped.toLocaleString(), t(L('klippta', 'clipped')), 'glow-amber'),
      stat(st.clippedAway.toLocaleString(), t(L('kastade', 'discarded')), 'glow-magenta'),
    ]),
    h('div.clip-sub', {
      text: t(
        L(
          `Kameran flyttad till ${zc.camDist.toFixed(2)} från mitten (bilden till vänster):`,
          `Camera moved to ${zc.camDist.toFixed(2)} from the center (picture on the left):`,
        ),
      ),
    }),
    h('div.stat-row', {}, [
      stat(zc.inside.toLocaleString(), t(L('innanför', 'inside')), 'glow-cyan'),
      stat(zc.clipped.toLocaleString(), t(L('klippta', 'clipped')), 'glow-amber'),
      stat(zc.outside.toLocaleString(), t(L('kastade', 'discarded')), 'glow-magenta'),
      stat(zc.outTris.toLocaleString(), t(L('trianglar ut', 'triangles out'))),
    ]),
    h('div.clip-note', {
      html: t(
        L(
          `${zc.newVerts.toLocaleString()} nya vertices skapades på planen (orange prickar).${ex ? ` T.ex. triangel #${ex.tri}: 3 → ${ex.nOut} hörn → ${ex.nOut - 2} trianglar (fan).` : ''}${zc.stride > 1 ? ` Var ${zc.stride}:e triangel testad.` : ''}`,
          `${zc.newVerts.toLocaleString()} new vertices were created on the planes (orange dots).${ex ? ` E.g. triangle #${ex.tri}: 3 → ${ex.nOut} corners → ${ex.nOut - 2} triangles (fan).` : ''}${zc.stride > 1 ? ` Every ${zc.stride}th triangle tested.` : ''}`,
        ),
      ),
    }),
  ]);

  const ndc = sc.map((p) => [p[0] / p[3], p[1] / p[3], p[2] / p[3]]);
  const divTable = h('table.clip-table.div', {}, [
    h('thead', {}, [h('tr', {}, [h('th', { text: '' }), h('th', { text: 'w' }), h('th', { text: 'x / w' }), h('th', { text: 'y / w' }), h('th.api', { text: 'z / w' })])]),
    h(
      'tbody',
      {},
      sc.map((p, k) =>
        h('tr', {}, [
          h('td', {}, [h('span.clip-v', { text: vName[k], style: { color: VCOL[k] } })]),
          h('td.mono.w', { text: num(p[3], 3) }),
          h('td.mono', { html: `${num(p[0], 3)} / ${num(p[3], 2)} = <b>${num(ndc[k][0], 3)}</b>` }),
          h('td.mono', { html: `${num(p[1], 3)} / ${num(p[3], 2)} = <b>${num(ndc[k][1], 3)}</b>` }),
          h('td.mono', { html: `<b>${num(ndc[k][2], 4)}</b>` }),
        ]),
      ),
    ),
  ]);
  const card2 = card(t(L('Perspektivdivision → NDC', 'Perspective divide → NDC')), [
    divTable,
    h('div.clip-note', {
      html: t(
        L(
          `Efter divisionen ligger allt synligt i <b>NDC</b>: x, y ∈ [−1, 1], z ∈ ${api === 'opengl' ? '[−1, 1]' : '[0, 1]'}.${api === 'vulkan' ? ' I Vulkan pekar +y nedåt.' : ''} z är inte linjärt i avstånd – precisionen samlas nära kameran.`,
          `After the divide everything visible lies in <b>NDC</b>: x, y ∈ [−1, 1], z ∈ ${api === 'opengl' ? '[−1, 1]' : '[0, 1]'}.${api === 'vulkan' ? ' In Vulkan +y points down.' : ''} z is not linear in distance – precision bunches up near the camera.`,
        ),
      ),
    }),
  ]);

  const card3 = card(t(L('Guard band – vad som verkligen klipps', 'Guard band – what really gets clipped')), [
    h('div.stat-row', {}, [
      stat(zc.crossXYOnly.toLocaleString(), t(L('bara x/y-plan', 'x/y planes only')), 'glow-violet'),
      stat(zc.crossNearFar.toLocaleString(), t(L('near/far-plan', 'near/far planes')), 'glow-amber'),
    ]),
    h('div.clip-note', {
      html: t(
        L(
          'Hårdvaran klipper sällan mot sidoplanen. Trianglar som bara sticker ut i x/y rasteriseras direkt inom ett stort <b>guard band</b>, och pixlar utanför viewporten/scissor kastas. Bara trianglar som korsar <b>near/far</b> (eller hamnar bakom kameran, w ≤ 0) behöver riktig geometrisk klippning.',
          'Hardware rarely clips against the side planes. Triangles that only stick out in x/y are rasterized directly within a large <b>guard band</b>, and pixels outside the viewport/scissor are discarded. Only triangles crossing <b>near/far</b> (or behind the camera, w ≤ 0) need real geometric clipping.',
        ),
      ),
    }),
  ]);

  const cards = [card0, card1, card2, card3];
  const side = h('div.clip-side.v-scroll', {}, cards);
  host.append(h('div.clip-data', {}, [canvasHost, side]));

  const caps: Text[] = [
    L('homogent clip space: innanför = mellan linjerna', 'homogeneous clip space: inside = between the lines'),
    L('<span class="r">före</span> · <span class="c">efter</span> klippning · kamera nära', '<span class="r">before</span> · <span class="c">after</span> clipping · camera close'),
    L('NDC efter division · djupintervall till höger', 'NDC after the divide · depth range on the right'),
    L('<span class="v">bara x/y</span> · <span class="a">near/far</span> · streckat = guard band', '<span class="v">x/y only</span> · <span class="a">near/far</span> · dashed = guard band'),
  ];
  let last = -1;
  return {
    show(s, animate) {
      const fwd = animate && s > last;
      last = s;
      step = s;
      cap.innerHTML = t(caps[s]);
      cards.forEach((c, i) => (c.style.display = i === s ? '' : 'none'));
      gsap.killTweensOf(canvasHost);
      const fs = { f: 1 };
      gsap.killTweensOf(fs);
      if (fwd && s === 1) {
        // Let the red "outside" parts fade out to show what clipping removes.
        fade = 1;
        cv.redraw();
        gsap.to(fs, { f: 0.25, duration: dur(1.6), delay: dur(0.6), ease: 'power2.inOut', onUpdate: () => ((fade = fs.f), cv.redraw()) });
      } else {
        fade = s === 1 ? 0.25 : 0.5;
        cv.redraw();
      }
      if (fwd) {
        gsap.fromTo(canvasHost, { opacity: 0.2 }, { opacity: 1, duration: dur(0.5) });
        gsap.fromTo(cards[s], { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: dur(0.45), ease: 'power2.out' });
      }
    },
    destroy() {
      gsap.killTweensOf(canvasHost);
      cv.destroy();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Concept: a 3D frustum slices triangles, then morphs into NDC        */
/* ------------------------------------------------------------------ */
function conceptVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const api = ctx.state.api;
  const { scene, camera } = makeScene();
  const tex = glowTexture();
  const stars = starfield(600);
  scene.add(stars);
  const root = new Group();
  scene.add(root);

  const CAM: Camera = { eye: [0, 0, 2.4], target: [0, 0, -1], up: [0, 1, 0], fovY: 50, near: 0.7, far: 5 };
  const CA = 1.4;
  const VP = projectionMatrix(api, CAM, CA).multiply(viewMatrix(CAM));
  const VPinv = VP.clone().invert();
  const zMin = api === 'opengl' ? -1 : 0;
  const BOX = 1.25;

  // World → NDC display position (the cube), x right / y up / depth into −Z.
  const toBox = (w: Vector3) => {
    const c = new Vector4(w.x, w.y, w.z, 1).applyMatrix4(VP);
    const ww = Math.max(1e-4, c.w);
    const nx = c.x / ww;
    const ny = c.y / ww;
    const nz = c.z / ww;
    const depthHalf = (BOX * (1 - zMin)) / 2;
    return new Vector3(nx * BOX * 1.15, ny * BOX, depthHalf - ((nz - zMin) / (1 - zMin)) * 2 * depthHalf);
  };
  const fromClip = (p: V4) => {
    const v = new Vector4(...p).applyMatrix4(VPinv);
    return new Vector3(v.x / v.w, v.y / v.w, v.z / v.w);
  };

  // Frustum corners (near 0–3, far 4–7) in world, and their cube targets.
  const eye = new Vector3(...CAM.eye);
  const tan = Math.tan((CAM.fovY * Math.PI) / 360);
  const corners: Vector3[] = [];
  for (const d of [CAM.near, CAM.far]) {
    for (const [sx, sy] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]) {
      corners.push(new Vector3(sx * d * tan * CA, sy * d * tan, eye.z - d));
    }
  }
  const cornerBox = corners.map(toBox);
  const EDGES = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];
  const frPos = new Float32Array(EDGES.length * 3);
  const frGeo = new BufferGeometry();
  frGeo.setAttribute('position', new BufferAttribute(frPos, 3));
  const frLines = new LineSegments(frGeo, new LineBasicMaterial({ color: hdr(COLORS.amber, 1.8), transparent: true, opacity: 0.95 }));
  frLines.frustumCulled = false;
  const faceIdx = [0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0];
  const facePos = new Float32Array(8 * 3);
  const faceGeo = new BufferGeometry();
  faceGeo.setAttribute('position', new BufferAttribute(facePos, 3));
  faceGeo.setIndex(faceIdx);
  const faces = new Mesh(faceGeo, new MeshBasicMaterial({ color: hdr(COLORS.amber, 0.5), transparent: true, opacity: 0.06, side: DoubleSide, depthWrite: false }));
  faces.frustumCulled = false;
  // Apex lines to the eye (fade out in NDC – the eye goes to infinity).
  const apexPos = new Float32Array(8 * 3);
  const apexGeo = new BufferGeometry();
  apexGeo.setAttribute('position', new BufferAttribute(apexPos, 3));
  const apex = new LineSegments(apexGeo, new LineBasicMaterial({ color: hdr(COLORS.amber, 1.2), transparent: true, opacity: 0.5 }));
  apex.frustumCulled = false;
  root.add(faces, frLines, apex);

  // Concept triangles: some cross planes, one is outside, one inside.
  const triDefs: [number, number, number][][] = [
    [[0.2, 0.1, -0.2], [2.6, 0.5, -0.6], [1.0, -0.6, 0.4]], // right plane
    [[-0.6, 0.3, 0.0], [-2.3, 1.8, -0.8], [0.1, 2.0, -0.4]], // left + top
    [[0.35, -0.3, 2.15], [-0.45, -0.55, 0.6], [0.55, 0.25, 0.9]], // near plane
    [[-0.5, -0.4, -3.6], [0.45, -0.2, -1.7], [-1.0, 0.35, -1.5]], // far plane
    [[2.7, -1.5, 0.3], [3.5, -0.6, -0.5], [3.1, -2.3, -1.0]], // fully outside
    [[-0.4, -0.95, -0.8], [0.65, -0.75, -1.25], [0.0, -0.2, -1.0]], // fully inside
  ];
  const planes = clipPlanes(api);
  interface TriVis {
    orig: Vector3[];
    origBox: Vector3[];
    inside: Vector3[];
    insideBox: Vector3[];
    fresh: boolean[];
    kind: 'inside' | 'outside' | 'clipped';
    nearFar: boolean;
    red: Mesh;
    redEdge: LineLoop;
    cyan: Mesh | null;
    cyanEdge: LineLoop | null;
    cyanPos: Float32Array | null;
    cyanEdgePos: Float32Array | null;
    fullNdc: LineLoop | null;
    dir: Vector3;
  }
  const tris: TriVis[] = triDefs.map((def) => {
    const orig = def.map((p) => new Vector3(...p));
    const cv = orig.map((p, j) => ({ pos: new Vector4(p.x, p.y, p.z, 1).applyMatrix4(VP).toArray() as V4, attrs: [j === 0 ? 1 : 0, j === 1 ? 1 : 0, j === 2 ? 1 : 0] })) as [
      ClipVertex,
      ClipVertex,
      ClipVertex,
    ];
    const r = clipTriangle(api, cv);
    const polyV = r.result === 'outside' ? [] : clipPolygon(api, cv);
    const inside = polyV.map((v) => fromClip(v.pos));
    const fresh = polyV.map((v) => Math.max(...v.attrs) < 0.9999);
    const nearFar = [planes[4], planes[5]].some((pl) => cv.some((v) => pl.dist(v.pos) < 0));
    const red = new Mesh(
      new BufferGeometry().setFromPoints(orig),
      new MeshBasicMaterial({ color: hdr(COLORS.red, 0.7), transparent: true, opacity: 0.22, side: DoubleSide, depthWrite: false }),
    );
    const redEdge = new LineLoop(new BufferGeometry().setFromPoints(orig), new LineBasicMaterial({ color: hdr(COLORS.red, 1.6), transparent: true, opacity: 0.7 }));
    const g = new Group();
    g.add(red, redEdge);
    root.add(g);
    let cyan: Mesh | null = null;
    let cyanEdge: LineLoop | null = null;
    let cyanPos: Float32Array | null = null;
    let cyanEdgePos: Float32Array | null = null;
    if (inside.length >= 3) {
      cyanPos = new Float32Array(inside.length * 3);
      const cg = new BufferGeometry();
      cg.setAttribute('position', new BufferAttribute(cyanPos, 3));
      const idx: number[] = [];
      for (let i = 1; i + 1 < inside.length; i++) idx.push(0, i, i + 1);
      cg.setIndex(idx);
      cyan = new Mesh(cg, new MeshBasicMaterial({ color: hdr(COLORS.cyan, 0.55), transparent: true, opacity: 0.32, side: DoubleSide, depthWrite: false }));
      cyanEdgePos = new Float32Array(inside.length * 3);
      const eg = new BufferGeometry();
      eg.setAttribute('position', new BufferAttribute(cyanEdgePos, 3));
      cyanEdge = new LineLoop(eg, new LineBasicMaterial({ color: hdr(COLORS.cyan, 1.6), transparent: true, opacity: 1 }));
      cyan.frustumCulled = cyanEdge.frustumCulled = false;
      root.add(cyan, cyanEdge);
    }
    // For the guard-band step: the full (unclipped) triangle in NDC for x/y-only cases.
    let fullNdc: LineLoop | null = null;
    if (r.result === 'clipped' && !nearFar) {
      fullNdc = new LineLoop(new BufferGeometry().setFromPoints(orig.map(toBox)), new LineBasicMaterial({ color: hdr(COLORS.violet, 2), transparent: true, opacity: 0 }));
      root.add(fullNdc);
    }
    const centroid = orig[0].clone().add(orig[1]).add(orig[2]).multiplyScalar(1 / 3);
    const dir = centroid.clone().sub(new Vector3(0, 0, eye.z - 2.5)).setZ(0).normalize();
    return { orig, origBox: orig.map(toBox), inside, insideBox: inside.map(toBox), fresh, kind: r.result, nearFar, red, redEdge, cyan, cyanEdge, cyanPos, cyanEdgePos, fullNdc, dir };
  });

  // New vertices on the planes (glowing dots).
  const freshList: { tri: TriVis; i: number }[] = [];
  tris.forEach((tr) => tr.fresh.forEach((f, i) => f && freshList.push({ tri: tr, i })));
  const fPos = new Float32Array(Math.max(1, freshList.length) * 3);
  const fGeo = new BufferGeometry();
  fGeo.setAttribute('position', new BufferAttribute(fPos, 3));
  const freshPts = new Points(fGeo, new PointsMaterial({ size: 0.22, map: tex, color: hdr(COLORS.amber, 3), transparent: true, opacity: 0, depthWrite: false, blending: AdditiveBlending }));
  freshPts.frustumCulled = false;
  root.add(freshPts);

  // Sparks along the cut edges.
  const cutEdges: [Vector3, Vector3][] = [];
  tris.forEach((tr) => {
    for (let i = 0; i < tr.inside.length; i++) {
      const j = (i + 1) % tr.inside.length;
      if (tr.fresh[i] && tr.fresh[j]) cutEdges.push([tr.inside[i], tr.inside[j]]);
    }
  });
  const NS = 420;
  const sPos = new Float32Array(NS * 3);
  const sCol = new Float32Array(NS * 3);
  const sGeo = new BufferGeometry();
  sGeo.setAttribute('position', new BufferAttribute(sPos, 3));
  sGeo.setAttribute('color', new BufferAttribute(sCol, 3));
  const sparks = new Points(sGeo, new PointsMaterial({ size: 0.07, map: tex, vertexColors: true, transparent: true, depthWrite: false, blending: AdditiveBlending }));
  sparks.frustumCulled = false;
  root.add(sparks);
  const spark = Array.from({ length: NS }, () => ({ p: new Vector3(), v: new Vector3(), born: -10, life: 1 }));
  const spawn = (s: (typeof spark)[number], now: number) => {
    if (!cutEdges.length) return;
    const [a, b] = cutEdges[Math.floor(Math.random() * cutEdges.length)];
    s.p.copy(a).lerp(b, Math.random());
    s.v.set(Math.random() - 0.5, Math.random() * 0.6 + 0.1, Math.random() - 0.5).multiplyScalar(1.4);
    s.born = now;
    s.life = 0.5 + Math.random() * 0.9;
  };

  // Labels.
  const nearTag = label('', 'clip-tag amber');
  const farTag = label('', 'clip-tag amber');
  const yTag = label('', 'clip-tag');
  const discardTag = label('', 'clip-tag magenta');
  const guardTag = label('guard band', 'clip-tag violet');
  root.add(nearTag, farTag, yTag, discardTag, guardTag);

  // Guard band rectangle (in NDC display).
  const gb = 1.8;
  const gbGeo = new BufferGeometry().setFromPoints([
    new Vector3(-gb * BOX * 1.15, -gb * BOX, 0),
    new Vector3(gb * BOX * 1.15, -gb * BOX, 0),
    new Vector3(gb * BOX * 1.15, gb * BOX, 0),
    new Vector3(-gb * BOX * 1.15, gb * BOX, 0),
  ]);
  const guard = new LineLoop(gbGeo, new LineBasicMaterial({ color: hdr(COLORS.violet, 1.6), transparent: true, opacity: 0 }));
  root.add(guard);

  camera.position.set(7.0, 2.9, 2.4);
  camera.lookAt(0, 0, 0);

  const P = { cut: 0, morph: 0, guard: 0, discard: 0 };
  const tmp = new Vector3();
  const setArr = (arr: Float32Array, i: number, v: Vector3) => arr.set([v.x, v.y, v.z], i * 3);
  let sparkOn = false;

  const view: StageView = {
    scene,
    camera,
    bloom: 0.85,
    bloomThreshold: 0.15,
    orbit: true,
    onFrame: (time, dt) => {
      stars.tick(time);
      const m = ease(P.morph);
      // Frustum → cube.
      EDGES.forEach((ci, k) => setArr(frPos, k, tmp.copy(corners[ci]).lerp(cornerBox[ci], m)));
      frGeo.attributes.position.needsUpdate = true;
      corners.forEach((c, i) => setArr(facePos, i, tmp.copy(c).lerp(cornerBox[i], m)));
      faceGeo.attributes.position.needsUpdate = true;
      for (let i = 0; i < 4; i++) {
        setArr(apexPos, i * 2, eye);
        setArr(apexPos, i * 2 + 1, tmp.copy(corners[i]).lerp(cornerBox[i], m));
      }
      apexGeo.attributes.position.needsUpdate = true;
      (apex.material as LineBasicMaterial).opacity = 0.45 * (1 - m);
      (faces.material as MeshBasicMaterial).opacity = 0.05 + 0.04 * Math.sin(time * 2) * (1 - m) + 0.03 * m;
      // Triangles.
      tris.forEach((tr) => {
        // Outside parts drift away and fade once cut.
        const off = tr.dir.clone().multiplyScalar(ease(P.cut) * 0.5);
        const redA = tr.kind === 'inside' ? 0 : (1 - ease(P.cut)) * (1 - m);
        (tr.red.material as MeshBasicMaterial).opacity = tr.kind === 'outside' ? 0.3 * (1 - ease(P.discard)) * (1 - m) : 0.3 * redA;
        (tr.redEdge.material as LineBasicMaterial).opacity = tr.kind === 'outside' ? 0.75 * (1 - ease(P.discard)) * (1 - m) : 0.75 * redA;
        tr.red.parent!.position.copy(tr.kind === 'outside' ? tr.dir.clone().multiplyScalar(ease(P.discard) * 0.8) : off);
        if (tr.cyanPos && tr.cyanEdgePos && tr.cyan && tr.cyanEdge) {
          tr.inside.forEach((v, i) => {
            tmp.copy(v).lerp(tr.insideBox[i], m);
            setArr(tr.cyanPos!, i, tmp);
            setArr(tr.cyanEdgePos!, i, tmp);
          });
          tr.cyan.geometry.attributes.position.needsUpdate = true;
          tr.cyanEdge.geometry.attributes.position.needsUpdate = true;
          const g = tr.kind === 'clipped' && !tr.nearFar ? 1 - 0.7 * P.guard : 1;
          (tr.cyan.material as MeshBasicMaterial).opacity = 0.42 * g;
          (tr.cyanEdge.material as LineBasicMaterial).opacity = g;
        }
        if (tr.fullNdc) (tr.fullNdc.material as LineBasicMaterial).opacity = P.guard;
      });
      freshList.forEach((f, k) => setArr(fPos, k, tmp.copy(f.tri.inside[f.i]).lerp(f.tri.insideBox[f.i], m)));
      fGeo.attributes.position.needsUpdate = true;
      (freshPts.material as PointsMaterial).opacity = clamp01(P.cut * 2) * (0.75 + 0.25 * Math.sin(time * 6));
      // Sparks.
      for (let i = 0; i < NS; i++) {
        const s = spark[i];
        let age = time - s.born;
        if (sparkOn && age > s.life && Math.random() < dt * (P.cut < 1 ? 30 : 0.15)) {
          spawn(s, time);
          age = 0;
        }
        const k = clamp01(1 - age / s.life);
        const pp = tmp.copy(s.p).addScaledVector(s.v, age).add(new Vector3(0, -0.6 * age * age, 0));
        setArr(sPos, i, pp);
        const c = hdr(COLORS.amber, 2.5 * k).lerp(hdr(COLORS.white, 2.5 * k), k * k * 0.6);
        sCol.set([c.r, c.g, c.b], i * 3);
      }
      sGeo.attributes.position.needsUpdate = true;
      sGeo.attributes.color.needsUpdate = true;
      (sparks.material as PointsMaterial).opacity = 1 - m;
      (guard.material as LineBasicMaterial).opacity = P.guard * 0.9;
      // Labels.
      const zr = api === 'opengl' ? ['−1', '+1'] : ['0', '1'];
      nearTag.element.textContent = m > 0.5 ? `near · z = ${zr[0]}` : `near · ${api === 'opengl' ? '−w ≤ z' : '0 ≤ z'}`;
      farTag.element.textContent = m > 0.5 ? `far · z = ${zr[1]}` : 'far · z ≤ w';
      nearTag.position.copy(corners[1]).lerp(cornerBox[1], m);
      farTag.position.copy(corners[6]).lerp(cornerBox[6], m);
      yTag.element.textContent = api === 'vulkan' ? '+y ↓ (Vulkan NDC)' : '+y ↑';
      yTag.position.copy(cornerBox[3]).add(new Vector3(0, 0.2, 0));
      yTag.element.style.opacity = String(m);
      discardTag.element.textContent = t(L('kastas helt', 'discarded'));
      discardTag.position.copy(tris[4].orig[0]).add(tris[4].dir.clone().multiplyScalar(ease(P.discard) * 0.8));
      discardTag.element.style.opacity = String(Math.sin(Math.PI * clamp01(P.discard)) * (1 - m));
      guardTag.position.set(-gb * BOX * 1.15, gb * BOX + 0.15, 0);
      guardTag.element.style.opacity = String(P.guard);
    },
  };
  const stageHost = h('div.v-fill');
  const caption = h('div.clipc-caption');
  const legend = h('div.clipc-legend');
  host.append(stageHost, legend, caption);
  ctx.stage.attach(stageHost, view);

  const captions: Text[] = [
    L(
      `Synvolymen – frustumet – avgränsas av sex plan. I clip space: −w ≤ x, y ≤ w och <b>${zRange(api)}</b>. <span class="r">Rött</span> ligger utanför.`,
      `The view volume – the frustum – is bounded by six planes. In clip space: −w ≤ x, y ≤ w and <b>${zRange(api)}</b>. <span class="r">Red</span> lies outside.`,
    ),
    L(
      'Trianglar som korsar ett plan klipps: delarna utanför skärs bort och <span class="a">nya vertices</span> skapas där kanterna korsar planet. Helt utanför → kastas.',
      'Triangles that cross a plane are clipped: the parts outside are cut away and <span class="a">new vertices</span> are created where edges cross the plane. Fully outside → discarded.',
    ),
    L(
      `Perspektivdivisionen (x/w, y/w, z/w) gör frustumet till NDC-lådan: x, y ∈ [−1, 1], z ∈ ${api === 'opengl' ? '[−1, 1]' : '[0, 1]'}.${api === 'vulkan' ? ' I Vulkan pekar +y nedåt.' : ''}`,
      `The perspective divide (x/w, y/w, z/w) turns the frustum into the NDC box: x, y ∈ [−1, 1], z ∈ ${api === 'opengl' ? '[−1, 1]' : '[0, 1]'}.${api === 'vulkan' ? ' In Vulkan +y points down.' : ''}`,
    ),
    L(
      'I praktiken: trianglar som bara sticker ut i x/y klipps inte – de rasteriseras inom ett <span class="v">guard band</span> och överflödiga pixlar kastas. Near/far klipps på riktigt.',
      'In practice: triangles that only stick out in x/y are not clipped – they are rasterized within a <span class="v">guard band</span> and extra pixels are discarded. Near/far are clipped for real.',
    ),
  ];
  const targets = [
    { cut: 0, morph: 0, guard: 0, discard: 0 },
    { cut: 1, morph: 0, guard: 0, discard: 1 },
    { cut: 1, morph: 1, guard: 0, discard: 1 },
    { cut: 1, morph: 1, guard: 1, discard: 1 },
  ];
  let last = -1;
  return {
    show(step, animate) {
      const fwd = animate && step > last;
      last = step;
      caption.innerHTML = t(captions[step]);
      legend.innerHTML = `<span class="r">■</span> ${t(L('utanför', 'outside'))} <span class="c">■</span> ${t(L('innanför', 'inside'))} <span class="a">●</span> ${t(L('ny vertex', 'new vertex'))}`;
      gsap.killTweensOf(P);
      sparkOn = step === 1;
      if (fwd) {
        if (step === 1) {
          gsap.to(P, { cut: 1, duration: dur(1.4), ease: 'power2.inOut' });
          gsap.to(P, { discard: 1, duration: dur(1.2), delay: dur(0.4) });
        } else gsap.to(P, { ...targets[step], duration: dur(step === 2 ? 2.2 : 1.2), ease: 'power2.inOut' });
        gsap.fromTo(caption, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: dur(0.4) });
      } else Object.assign(P, targets[step]);
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
