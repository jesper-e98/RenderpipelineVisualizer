import gsap from 'gsap';
import {
  AdditiveBlending,
  BackSide,
  BufferGeometry,
  CanvasTexture,
  Color,
  FrontSide,
  Group,
  Line,
  LineBasicMaterial,
  LineLoop,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  ShaderMaterial,
  Sprite,
  SpriteMaterial,
  Vector3,
} from 'three';
import '../styles/slides/viewport-culling.css';
import { dur, h, num } from '../core/dom';
import { L, type Text } from '../core/i18n';
import type { ApiId } from '../core/state';
import { meshToGeometry } from '../model/normalize';
import { LIGHT_DIR, shade } from '../pipeline/shade';
import { ndcToWindow, type V3 } from '../pipeline/transform';
import { SHOWCASE_ROT_X, SHOWCASE_ROT_Y } from '../core/derived';
import type { StageView } from '../views/ThreeStage';
import { COLORS, disposeScene, label, makeScene, starfield } from '../views/three-helpers';
import { card, stat } from '../views/widgets';
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

interface CullData {
  /** Triangles in canvas space (origin top-left) of the VW × VH window, back to front. */
  tris: { p: number[]; front: boolean; z: number; color: string }[];
  front: number;
  back: number;
  sampled: number;
  stride: number;
}

/** Project the mesh once (no rasterization) and classify every triangle as front/back facing. */
function cullData(ctx: SlideContext): CullData {
  const api = ctx.state.api;
  const mesh = ctx.state.mesh;
  const r = ctx.derived.render(api, 160, 100);
  const e = r.matrices.mvp.elements;
  const me = r.matrices.model.elements;
  const n = mesh.vertexCount;
  const sx = new Float32Array(n);
  const sy = new Float32Array(n);
  const sz = new Float32Array(n);
  const ok = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const x = mesh.positions[i * 3];
    const y = mesh.positions[i * 3 + 1];
    const z = mesh.positions[i * 3 + 2];
    const cw = e[3] * x + e[7] * y + e[11] * z + e[15];
    if (cw <= 1e-6) continue;
    const ndc: V3 = [(e[0] * x + e[4] * y + e[8] * z + e[12]) / cw, (e[1] * x + e[5] * y + e[9] * z + e[13]) / cw, (e[2] * x + e[6] * y + e[10] * z + e[14]) / cw];
    const { canvas } = ndcToWindow(api, ndc, VW, VH);
    sx[i] = canvas[0];
    sy[i] = canvas[1];
    sz[i] = canvas[2];
    ok[i] = 1;
  }
  const stride = Math.max(1, Math.ceil(mesh.triangleCount / 20000));
  const tris: CullData['tris'] = [];
  let front = 0;
  let back = 0;
  for (let t = 0; t < mesh.triangleCount; t += stride) {
    const a = mesh.indices[t * 3];
    const b = mesh.indices[t * 3 + 1];
    const c = mesh.indices[t * 3 + 2];
    if (!ok[a] || !ok[b] || !ok[c]) continue;
    // Same test as the software rasterizer: negative area in y-down canvas space = CCW on screen = front.
    const area = (sx[b] - sx[a]) * (sy[c] - sy[a]) - (sy[b] - sy[a]) * (sx[c] - sx[a]);
    const isFront = area < 0;
    if (isFront) front++;
    else back++;
    // Flat world-space face normal → the app's Blinn–Phong color.
    const ax = mesh.positions[a * 3], ay = mesh.positions[a * 3 + 1], az = mesh.positions[a * 3 + 2];
    const ux = mesh.positions[b * 3] - ax, uy = mesh.positions[b * 3 + 1] - ay, uz = mesh.positions[b * 3 + 2] - az;
    const vx = mesh.positions[c * 3] - ax, vy = mesh.positions[c * 3 + 1] - ay, vz = mesh.positions[c * 3 + 2] - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const wx = me[0] * nx + me[4] * ny + me[8] * nz;
    const wy = me[1] * nx + me[5] * ny + me[9] * nz;
    const wz = me[2] * nx + me[6] * ny + me[10] * nz;
    [nx, ny, nz] = [wx, wy, wz];
    let color: string;
    if (isFront) {
      const s = shade([nx, ny, nz]).color;
      color = `rgb(${Math.round(s[0] * 255)},${Math.round(s[1] * 255)},${Math.round(s[2] * 255)})`;
    } else {
      // Back faces: lit from the inside (flip the normal), tinted red.
      const d = Math.max(0, -(nx * LIGHT_DIR[0] + ny * LIGHT_DIR[1] + nz * LIGHT_DIR[2]) / (Math.hypot(nx, ny, nz) || 1));
      color = `rgb(${Math.round(90 + 150 * d)},${Math.round(25 + 50 * d)},${Math.round(45 + 60 * d)})`;
    }
    tris.push({ p: [sx[a], sy[a], sx[b], sy[b], sx[c], sy[c]], front: isFront, z: (sz[a] + sz[b] + sz[c]) / 3, color });
  }
  tris.sort((p, q) => q.z - p.z); // painter's order: far first
  return { tris, front, back, sampled: Math.ceil(mesh.triangleCount / stride), stride };
}

/* ------------------------------------------------------------------ */
/* Real data                                                           */
/* ------------------------------------------------------------------ */
function dataVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const api = ctx.state.api;
  const r = ctx.derived.render(api, 160, 100);
  const st = r.stats;
  const tri = ctx.derived.showcaseTriangle(api);
  const verts = ctx.derived.triangleVertices(tri);
  const e = r.matrices.mvp.elements;
  const ndc = verts.map((v) => {
    const [x, y, z] = ctx.derived.position(v);
    const w = e[3] * x + e[7] * y + e[11] * z + e[15];
    return [(e[0] * x + e[4] * y + e[8] * z + e[12]) / w, (e[1] * x + e[5] * y + e[9] * z + e[13]) / w, (e[2] * x + e[6] * y + e[10] * z + e[14]) / w] as V3;
  });
  const win = ndc.map((p) => ndcToWindow(api, p, VW, VH));
  const cd = cullData(ctx);
  const yUp = api === 'opengl';

  // Signed area in the API's own window space.
  const wpts = win.map((w) => [w.window[0], w.window[1]] as [number, number]);
  const sum = shoelace(wpts);
  const apiArea = api === 'vulkan' ? -sum : sum; // Vulkan's spec formula has a leading minus
  const ccw = api === 'd3d12' ? sum < 0 : apiArea > 0; // visually counter-clockwise on screen
  const isFront = ccw; // all three APIs are configured "counter-clockwise = front" here

  /* ---------- Canvas: base layers + animated overlay ---------- */
  const canvasHost = h('div.vc-canvas-host');
  const base = h('canvas.vc-canvas');
  const over = h('canvas.vc-canvas');
  const cap = h('div.vc-cap');
  canvasHost.append(base, over, cap);
  const bg = base.getContext('2d')!;
  const og = over.getContext('2d')!;
  let frontLayer: HTMLCanvasElement | null = null;
  let backLayer: HTMLCanvasElement | null = null;
  let W = 1;
  let H = 1;
  let dpr = 1;
  const frame = () => {
    const padX = 54;
    const padY = 30;
    const s = Math.min((W - padX * 2) / VW, (H - padY * 2) / VH);
    return { s, ox: (W - VW * s) / 2, oy: (H - VH * s) / 2 + 4 };
  };
  const buildLayers = () => {
    const F = frame();
    const mk = (front: boolean) => {
      const c = document.createElement('canvas');
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
      const g = c.getContext('2d')!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.lineJoin = 'round';
      for (const tr of cd.tris) {
        if (tr.front !== front) continue;
        const p = tr.p;
        g.beginPath();
        g.moveTo(F.ox + p[0] * F.s, F.oy + p[1] * F.s);
        g.lineTo(F.ox + p[2] * F.s, F.oy + p[3] * F.s);
        g.lineTo(F.ox + p[4] * F.s, F.oy + p[5] * F.s);
        g.closePath();
        g.fillStyle = tr.color;
        g.fill();
        g.strokeStyle = front ? 'rgba(56,225,255,0.18)' : 'rgba(255,90,110,0.35)';
        g.lineWidth = 0.5;
        g.stroke();
      }
      return c;
    };
    frontLayer = mk(true);
    backLayer = mk(false);
  };
  const resize = () => {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.max(1, canvasHost.clientWidth);
    H = Math.max(1, canvasHost.clientHeight);
    for (const c of [base, over]) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    buildLayers();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(canvasHost);

  // Animated parameters: how much of each layer is visible, etc.
  const A = { front: 0.25, back: 0.25, peel: 0, wire: 1, wind: 0, wrong: 0 };
  let step = 0;

  const drawBase = () => {
    const F = frame();
    bg.setTransform(1, 0, 0, 1, 0, 0);
    bg.clearRect(0, 0, base.width, base.height);
    bg.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Window.
    bg.fillStyle = 'rgba(4,6,16,0.8)';
    bg.fillRect(F.ox, F.oy, VW * F.s, VH * F.s);
    // Pixel-ish grid every 120 px.
    bg.strokeStyle = 'rgba(140,160,255,0.07)';
    bg.lineWidth = 1;
    bg.beginPath();
    for (let x = 0; x <= VW; x += 120) {
      bg.moveTo(F.ox + x * F.s + 0.5, F.oy);
      bg.lineTo(F.ox + x * F.s + 0.5, F.oy + VH * F.s);
    }
    for (let y = 0; y <= VH; y += 120) {
      bg.moveTo(F.ox, F.oy + y * F.s + 0.5);
      bg.lineTo(F.ox + VW * F.s, F.oy + y * F.s + 0.5);
    }
    bg.stroke();
    // Layers: back faces first, front on top.
    if (backLayer && frontLayer) {
      const pe = ease(A.peel);
      bg.save();
      bg.setTransform(1, 0, 0, 1, 0, 0);
      if (A.back > 0.001) {
        bg.globalAlpha = A.back * (1 - pe);
        const k = 1 + pe * 0.08;
        bg.translate((W * dpr) / 2, (H * dpr) / 2 + pe * 30 * dpr);
        bg.scale(k, k);
        bg.translate((-W * dpr) / 2, (-H * dpr) / 2);
        bg.drawImage(backLayer, 0, 0);
        bg.setTransform(1, 0, 0, 1, 0, 0);
      }
      if (A.front > 0.001) {
        bg.globalAlpha = A.front;
        bg.drawImage(frontLayer, 0, 0);
      }
      bg.restore();
    }
    bg.save();
    bg.shadowColor = 'rgba(92,240,143,0.9)';
    bg.shadowBlur = 12;
    bg.strokeStyle = '#5cf08f';
    bg.lineWidth = 1.5;
    bg.strokeRect(F.ox, F.oy, VW * F.s, VH * F.s);
    bg.restore();
    // Origin + axes per API.
    const ox = F.ox;
    const oy = yUp ? F.oy + VH * F.s : F.oy;
    const dirY = yUp ? -1 : 1;
    bg.save();
    bg.strokeStyle = '#ffb547';
    bg.fillStyle = '#ffb547';
    bg.shadowColor = '#ffb547';
    bg.shadowBlur = 10;
    bg.lineWidth = 2;
    const arrow = (x0: number, y0: number, x1: number, y1: number) => {
      bg.beginPath();
      bg.moveTo(x0, y0);
      bg.lineTo(x1, y1);
      bg.stroke();
      const a = Math.atan2(y1 - y0, x1 - x0);
      bg.beginPath();
      bg.moveTo(x1, y1);
      bg.lineTo(x1 - 8 * Math.cos(a - 0.4), y1 - 8 * Math.sin(a - 0.4));
      bg.lineTo(x1 - 8 * Math.cos(a + 0.4), y1 - 8 * Math.sin(a + 0.4));
      bg.closePath();
      bg.fill();
    };
    arrow(ox, oy, ox + 70, oy);
    arrow(ox, oy, ox, oy + dirY * 60);
    bg.beginPath();
    bg.arc(ox, oy, 4.5, 0, Math.PI * 2);
    bg.fill();
    bg.restore();
    bg.font = '600 11px "JetBrains Mono", monospace';
    bg.fillStyle = '#ffb547';
    bg.textAlign = 'right';
    bg.fillText('(0, 0)', ox - 6, oy + (yUp ? 4 : 10));
    bg.textAlign = 'left';
    bg.fillText('x', ox + 74, oy + 4);
    bg.fillText('y', ox - 4, oy + dirY * 72 + 4);
    bg.fillStyle = '#9aa3c7';
    bg.textAlign = 'right';
    const farX = F.ox + VW * F.s;
    const farY = yUp ? F.oy : F.oy + VH * F.s;
    bg.fillText(`(${VW}, ${VH})`, farX + 2, farY + (yUp ? -8 : 16));
  };

  const drawOverlay = (time: number) => {
    const F = frame();
    og.setTransform(1, 0, 0, 1, 0, 0);
    og.clearRect(0, 0, over.width, over.height);
    og.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (step > 1 && A.wind < 0.01) return;
    const real = win.map((w) => [F.ox + w.canvas[0] * F.s, F.oy + w.canvas[1] * F.s] as [number, number]);
    const hot = step <= 1 ? 1 : A.wind;
    // The real triangle is tiny at this scale: mark it and show it magnified in an inset.
    const xs = real.map((p) => p[0]);
    const ys = real.map((p) => p[1]);
    const bcx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const bcy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const iw = Math.min(190, VW * F.s * 0.42);
    const ih = Math.min(130, VH * F.s * 0.42);
    const ix = F.ox + VW * F.s - iw - 10;
    const iy = F.oy + (yUp ? VH * F.s - ih - 10 : 10);
    const k = Math.min((iw - 70) / Math.max(1, Math.max(...xs) - Math.min(...xs)), (ih - 44) / Math.max(1, Math.max(...ys) - Math.min(...ys)));
    const P = real.map(([x, y]) => [ix + iw / 2 + (x - bcx) * k, iy + ih / 2 + (y - bcy) * k] as [number, number]);
    og.save();
    og.globalAlpha = hot;
    og.strokeStyle = 'rgba(255,63,210,0.9)';
    og.lineWidth = 1;
    og.strokeRect(bcx - 9, bcy - 9, 18, 18);
    og.setLineDash([4, 4]);
    og.beginPath();
    og.moveTo(bcx + (ix + iw / 2 > bcx ? 9 : -9), bcy);
    og.lineTo(ix + iw / 2 > bcx ? ix : ix + iw, iy + ih / 2);
    og.stroke();
    og.setLineDash([]);
    og.fillStyle = 'rgba(5,6,13,0.88)';
    og.fillRect(ix, iy, iw, ih);
    og.strokeStyle = 'rgba(255,63,210,0.6)';
    og.strokeRect(ix + 0.5, iy + 0.5, iw, ih);
    og.font = '600 10px "JetBrains Mono", monospace';
    og.fillStyle = '#9aa3c7';
    og.textAlign = 'left';
    og.fillText(`#${tri} × ${k.toFixed(0)}`, ix + 6, iy + 13);
    og.restore();
    og.save();
    og.globalAlpha = hot;
    og.shadowColor = '#ff3fd2';
    og.shadowBlur = 14;
    og.beginPath();
    P.forEach(([x, y], i) => (i ? og.lineTo(x, y) : og.moveTo(x, y)));
    og.closePath();
    og.fillStyle = 'rgba(255,63,210,0.25)';
    og.fill();
    og.strokeStyle = '#ff3fd2';
    og.lineWidth = 2;
    og.stroke();
    og.restore();
    // Winding: a glowing comet running v0 → v1 → v2 → v0.
    if (step >= 1 && A.wind > 0.01) {
      const per = P.map((p, i) => Math.hypot(P[(i + 1) % 3][0] - p[0], P[(i + 1) % 3][1] - p[1]));
      const total = per[0] + per[1] + per[2];
      const at = (u: number): [number, number] => {
        let d = (((u % 1) + 1) % 1) * total;
        for (let i = 0; i < 3; i++) {
          if (d <= per[i]) {
            const k = d / per[i];
            const a = P[i];
            const b = P[(i + 1) % 3];
            return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
          }
          d -= per[i];
        }
        return P[0];
      };
      const u = time * 0.35;
      og.save();
      for (let k = 0; k < 22; k++) {
        const [x, y] = at(u - k * 0.008);
        og.globalAlpha = A.wind * (1 - k / 22);
        og.fillStyle = isFront ? '#38e1ff' : '#ff5a6e';
        og.shadowColor = og.fillStyle;
        og.shadowBlur = 12;
        og.beginPath();
        og.arc(x, y, 3.6 - k * 0.12, 0, Math.PI * 2);
        og.fill();
      }
      // Curved arrow around the centroid.
      const cx = (P[0][0] + P[1][0] + P[2][0]) / 3;
      const cy = (P[0][1] + P[1][1] + P[2][1]) / 3;
      const rr = 13;
      const a0 = time * 2 * (ccw ? -1 : 1);
      og.globalAlpha = A.wind;
      og.strokeStyle = '#fff';
      og.shadowColor = '#fff';
      og.lineWidth = 1.8;
      og.beginPath();
      og.arc(cx, cy, rr, a0, a0 + (ccw ? -4.6 : 4.6), ccw);
      og.stroke();
      const ae = a0 + (ccw ? -4.6 : 4.6);
      const tx = cx + rr * Math.cos(ae);
      const ty = cy + rr * Math.sin(ae);
      const dir = ae + (ccw ? -Math.PI / 2 : Math.PI / 2);
      og.fillStyle = '#fff';
      og.beginPath();
      og.moveTo(tx + 6 * Math.cos(dir), ty + 6 * Math.sin(dir));
      og.lineTo(tx + 5 * Math.cos(dir + 2.2), ty + 5 * Math.sin(dir + 2.2));
      og.lineTo(tx + 5 * Math.cos(dir - 2.2), ty + 5 * Math.sin(dir - 2.2));
      og.closePath();
      og.fill();
      og.restore();
    }
    // Vertex dots + window coordinates.
    og.font = '600 10.5px "JetBrains Mono", monospace';
    P.forEach(([x, y], kk) => {
      const k = kk;
      og.save();
      og.globalAlpha = hot;
      og.fillStyle = VCOL[k];
      og.shadowColor = VCOL[k];
      og.shadowBlur = 10;
      og.beginPath();
      og.arc(x, y, 4, 0, Math.PI * 2);
      og.fill();
      og.restore();
      if (step === 0 || step === 1) {
        const txt = `v${k} ${win[k].window[0].toFixed(0)},${win[k].window[1].toFixed(0)}`;
        const cx = (P[0][0] + P[1][0] + P[2][0]) / 3;
        const cy = (P[0][1] + P[1][1] + P[2][1]) / 3;
        const dx = x - cx;
        const dy = y - cy;
        const l = Math.hypot(dx, dy) || 1;
        const lx = x + (dx / l) * 10;
        const ly = Math.max(iy + 26, Math.min(iy + ih - 8, y + (dy / l) * 14));
        const tw = og.measureText(txt).width;
        const bx = Math.max(ix + 3, Math.min(ix + iw - tw - 6, dx < 0 ? lx - tw - 6 : lx));
        og.fillStyle = 'rgba(5,6,13,0.82)';
        og.fillRect(bx - 3, ly - 9, tw + 6, 15);
        og.fillStyle = VCOL[k];
        og.textAlign = 'left';
        og.fillText(txt, bx + 1, ly + 2);
      }
    });
  };

  let raf = 0;
  const loop = (now: number) => {
    drawBase();
    drawOverlay(now / 1000);
    raf = requestAnimationFrame(loop);
  };
  resize();
  raf = requestAnimationFrame(loop);

  /* ---------- Cards ---------- */
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
  const vName = ['v0', 'v1', 'v2'];
  const wTable = h('table.vc-table', {}, [
    h('thead', {}, [h('tr', {}, [h('th', { text: '' }), h('th', { text: 'NDC (x, y, z)' }), h('th', { text: 'window (x, y)' }), h('th', { text: 'depth' })])]),
    h(
      'tbody',
      {},
      ndc.map((p, k) =>
        h('tr', {}, [
          h('td', {}, [h('span.vc-v', { text: vName[k], style: { color: VCOL[k] } })]),
          h('td.mono', { text: p.map((x) => num(x, 3)).join(' ') }),
          h('td.mono.hot', { text: `${win[k].window[0].toFixed(1)}, ${win[k].window[1].toFixed(1)}` }),
          h('td.mono', { text: win[k].window[2].toFixed(4) }),
        ]),
      ),
    ),
  ]);
  const card0 = card(t(L(`Viewport ${VW} × ${VH}`, `Viewport ${VW} × ${VH}`)), [
    h('div.vc-formula', { html: formula[api] }),
    wTable,
    h('div.vc-note', { html: t(origin[api]) + ' ' + t(L('Djupintervallet [0, 1] gäller alla tre här.', 'The depth range [0, 1] applies to all three here.')) }),
  ]);

  const areaFormula: Record<ApiId, string> = {
    opengl: `a = ½ Σ (x<sub>i</sub>·y<sub>i+1</sub> − x<sub>i+1</sub>·y<sub>i</sub>)  <span class="hint">${t(L('(fönster, y upp)', '(window, y up)'))}</span>`,
    vulkan: `a = −½ Σ (x<sub>i</sub>·y<sub>i+1</sub> − x<sub>i+1</sub>·y<sub>i</sub>)  <span class="hint">${t(L('(framebuffer, y ned)', '(framebuffer, y down)'))}</span>`,
    d3d12: `a = ½ Σ (x<sub>i</sub>·y<sub>i+1</sub> − x<sub>i+1</sub>·y<sub>i</sub>)  <span class="hint">${t(L('(render target, y ned)', '(render target, y down)'))}</span>`,
  };
  const areaVal = api === 'd3d12' ? sum : apiArea;
  const card1 = card(t(L(`Varvriktning – triangel #${tri}`, `Winding – triangle #${tri}`)), [
    h('div.vc-formula', { html: areaFormula[api] }),
    h('div.stat-row', {}, [
      stat(Math.round(areaVal).toLocaleString(), t(L('a (px²)', 'a (px²)')), areaVal >= 0 ? 'glow-cyan' : 'glow-magenta'),
      stat(ccw ? 'CCW' : 'CW', t(L('på skärmen', 'on screen')), 'glow-amber'),
      stat(isFront ? 'front' : 'back', t(L('med vår inställning', 'with our setting')), isFront ? 'glow-cyan' : 'glow-magenta'),
    ]),
    h('div.vc-note', {
      html: t(
        api === 'opengl'
          ? L('Positiv area i fönsterkoordinater = moturs (CCW). Med <code>glFrontFace(GL_CCW)</code> är den en framsida.', 'Positive area in window coordinates = counter-clockwise (CCW). With <code>glFrontFace(GL_CCW)</code> it is a front face.')
          : api === 'vulkan'
            ? L('Vulkans formel har ett minustecken eftersom y pekar nedåt: positiv a = moturs på skärmen → framsida med <code>VK_FRONT_FACE_COUNTER_CLOCKWISE</code>.', 'Vulkan\'s formula has a minus sign because y points down: positive a = counter-clockwise on screen → front face with <code>VK_FRONT_FACE_COUNTER_CLOCKWISE</code>.')
            : L('Med y nedåt ger moturs (CCW) på skärmen negativ shoelace-summa. <code>FrontCounterClockwise = TRUE</code> gör den till framsida.', 'With y down, counter-clockwise (CCW) on screen gives a negative shoelace sum. <code>FrontCounterClockwise = TRUE</code> makes it a front face.'),
      ),
    }),
  ]);

  const kept = st.trianglesIn - st.culled - st.clippedAway;
  const pct = Math.round((st.culled / Math.max(1, st.trianglesIn)) * 100);
  const card2 = card(t(L('Back-face culling – hela modellen', 'Back-face culling – the whole model')), [
    h('div.stat-row', {}, [
      stat(st.trianglesIn.toLocaleString(), t(L('trianglar in', 'triangles in'))),
      stat(kept.toLocaleString(), t(L('framsidor kvar', 'front faces kept')), 'glow-cyan'),
      stat(st.culled.toLocaleString(), t(L('bortcullade', 'culled')), 'glow-magenta'),
      stat(`${pct} %`, t(L('sparat', 'saved')), 'glow-amber'),
    ]),
    h('div.vc-note', {
      html: t(
        L(
          `Siffrorna kommer från mjukvarurenderingen (160 × 100). Bakåtvända trianglar (<span class="r">rött</span>) kastas <b>före</b> rasteriseringen – de genererar aldrig ett enda fragment. För en sluten modell är det ungefär hälften.`,
          `Numbers from the software render (160 × 100). Back-facing triangles (<span class="r">red</span>) are discarded <b>before</b> rasterization – they never generate a single fragment. For a closed model that is roughly half.`,
        ),
      ),
    }),
  ]);

  const conv: { api: ApiId; name: string; code: string }[] = [
    { api: 'opengl', name: 'OpenGL', code: 'glFrontFace(GL_CCW); glCullFace(GL_BACK);' },
    { api: 'vulkan', name: 'Vulkan', code: 'frontFace = VK_FRONT_FACE_COUNTER_CLOCKWISE; cullMode = VK_CULL_MODE_BACK_BIT;' },
    { api: 'd3d12', name: 'D3D12', code: 'FrontCounterClockwise = TRUE; CullMode = D3D12_CULL_MODE_BACK;' },
  ];
  const card3 = card(t(L('Vad är "fram"? Konventionen per API', 'What is "front"? The convention per API')), [
    h(
      'div.vc-conv',
      {},
      conv.map((c) => h(`div.vc-conv-row${c.api === api ? '.cur' : ''}`, {}, [h('span.vc-conv-name', { text: c.name }), h('code', { text: c.code })])),
    ),
    h('div.vc-note', {
      html: t(
        L(
          `Fel inställning (t.ex. D3D12:s standard <code>FrontCounterClockwise = FALSE</code>, eller Vulkan utan y-flipp i projektionen) cullar i stället de <b>${kept.toLocaleString()}</b> synliga framsidorna – kvar blir modellens insida (bilden).`,
          `The wrong setting (e.g. D3D12's default <code>FrontCounterClockwise = FALSE</code>, or Vulkan without the y flip in the projection) culls the <b>${kept.toLocaleString()}</b> visible front faces instead – what remains is the inside of the model (picture).`,
        ),
      ),
    }),
  ]);

  const cards = [card0, card1, card2, card3];
  const side = h('div.vc-side.v-scroll', {}, cards);
  host.append(h('div.vc-data', {}, [canvasHost, side]));

  const caps: Text[] = [
    L(`fönster ${VW} × ${VH} · origo ${yUp ? 'nere till vänster' : 'uppe till vänster'}`, `window ${VW} × ${VH} · origin ${yUp ? 'bottom left' : 'top left'}`),
    L(`triangel #${tri}: v0 → v1 → v2 ${ccw ? 'moturs' : 'medurs'}`, `triangle #${tri}: v0 → v1 → v2 ${ccw ? 'counter-clockwise' : 'clockwise'}`),
    L(`<span class="r">baksidor</span> ${cd.back.toLocaleString()} · <span class="c">framsidor</span> ${cd.front.toLocaleString()}`, `<span class="r">back faces</span> ${cd.back.toLocaleString()} · <span class="c">front faces</span> ${cd.front.toLocaleString()}`),
    L('fel front face: framsidorna cullas, insidan syns', 'wrong front face: the front faces are culled, the inside shows'),
  ];
  const targets = [
    { front: 0.22, back: 0.22, peel: 0, wind: 0, wrong: 0 },
    { front: 0.22, back: 0.22, peel: 0, wind: 1, wrong: 0 },
    { front: 1, back: 1, peel: 1, wind: 0, wrong: 0 },
    { front: 0, back: 1, peel: 0, wind: 0, wrong: 1 },
  ];
  let last = -1;
  return {
    show(s, animate) {
      const fwd = animate && s > last;
      last = s;
      step = s;
      cap.innerHTML = t(caps[s]);
      cards.forEach((c, i) => (c.style.display = i === s ? '' : 'none'));
      gsap.killTweensOf(A);
      if (fwd && s === 2) {
        // First show both halves (back faces through translucent front faces), then peel the back faces away.
        Object.assign(A, { front: 0.5, back: 1, peel: 0, wind: 0 });
        gsap.to(A, { front: 1, duration: dur(1.0), delay: dur(1.6) });
        gsap.to(A, { peel: 1, duration: dur(1.4), delay: dur(1.0), ease: 'power2.in' });
      } else if (fwd) gsap.to(A, { ...targets[s], duration: dur(0.9), ease: 'power2.inOut' });
      else Object.assign(A, targets[s]);
      if (fwd) gsap.fromTo(cards[s], { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: dur(0.45), ease: 'power2.out' });
    },
    destroy() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      gsap.killTweensOf(A);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Concept: viewport stretch, winding arrows, back faces peel away     */
/* ------------------------------------------------------------------ */
const FRONT_VS = /* glsl */ `
varying vec3 vN;
void main() {
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const FRONT_FS = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uLight;
uniform float uAlpha;
varying vec3 vN;
void main() {
  vec3 n = normalize(vN);
  float d = max(dot(n, uLight), 0.0);
  float rim = pow(1.0 - abs(n.z), 3.0);
  vec3 c = uColor * (0.14 + 0.86 * d) + rim * 0.25 * vec3(0.2, 0.9, 1.0);
  gl_FragColor = vec4(c, uAlpha);
}`;
const BACK_VS = /* glsl */ `
uniform float uPeel;
varying vec3 vN;
void main() {
  vN = normalize(mat3(modelMatrix) * normal);
  vec3 p = position + normal * uPeel * 0.35;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
const BACK_FS = /* glsl */ `
uniform vec3 uLight;
uniform float uAlpha;
varying vec3 vN;
void main() {
  vec3 n = -normalize(vN);
  float d = max(dot(n, uLight), 0.0);
  vec3 c = vec3(1.0, 0.25, 0.35) * (0.25 + 0.9 * d);
  gl_FragColor = vec4(c, uAlpha);
}`;

function conceptVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const api = ctx.state.api;
  const mesh = ctx.state.mesh;
  const { scene, camera } = makeScene();
  const tex = glowTexture();
  const stars = starfield(600);
  scene.add(stars);
  camera.position.set(0, 0.5, 5.4);
  camera.lookAt(0, 0.05, 0);
  const yUp = api === 'opengl';

  /* ---- Step 0: NDC square → window rectangle ---- */
  const vpGroup = new Group();
  vpGroup.position.y = 0.35;
  vpGroup.scale.setScalar(0.9);
  scene.add(vpGroup);
  const rect = new Group();
  vpGroup.add(rect);
  const plane = new Mesh(new PlaneGeometry(2, 2), new MeshBasicMaterial({ color: hdr(COLORS.violet, 0.35), transparent: true, opacity: 0.25, depthWrite: false }));
  const border = new LineLoop(
    new BufferGeometry().setFromPoints([new Vector3(-1, -1, 0), new Vector3(1, -1, 0), new Vector3(1, 1, 0), new Vector3(-1, 1, 0)]),
    new LineBasicMaterial({ color: hdr(COLORS.green, 2), transparent: true }),
  );
  const gridPts: Vector3[] = [];
  for (let i = 1; i < 16; i++) gridPts.push(new Vector3(-1 + i / 8, -1, 0), new Vector3(-1 + i / 8, 1, 0));
  for (let j = 1; j < 10; j++) gridPts.push(new Vector3(-1, -1 + j / 5, 0), new Vector3(1, -1 + j / 5, 0));
  const grid = new LineSegments(new BufferGeometry().setFromPoints(gridPts), new LineBasicMaterial({ color: hdr(COLORS.cyan, 0.8), transparent: true, opacity: 0 }));
  rect.add(plane, border, grid);
  const originDot = new Sprite(new SpriteMaterial({ map: tex, color: hdr(COLORS.amber, 3), transparent: true, depthTest: false }));
  originDot.scale.setScalar(0.22);
  const axisX = new Line(new BufferGeometry().setFromPoints([new Vector3(), new Vector3(0.7, 0, 0)]), new LineBasicMaterial({ color: hdr(COLORS.amber, 2.2), transparent: true }));
  const axisY = new Line(new BufferGeometry().setFromPoints([new Vector3(), new Vector3(0, 0.55, 0)]), new LineBasicMaterial({ color: hdr(COLORS.amber, 2.2), transparent: true }));
  const originGroup = new Group();
  originGroup.add(originDot, axisX, axisY);
  vpGroup.add(originGroup);
  const ndcTag = label('NDC  [−1, 1]²', 'vc-tag');
  const winTag = label(`${VW} × ${VH}`, 'vc-tag green');
  const oTag = label('(0, 0)', 'vc-tag amber');
  const yTag = label(yUp ? '+y ↑' : '+y ↓', 'vc-tag amber');
  vpGroup.add(ndcTag, winTag, oTag, yTag);

  /* ---- Step 1: winding of one triangle ---- */
  const wGroup = new Group();
  wGroup.position.y = 0.3;
  scene.add(wGroup);
  const triPts = [new Vector3(-1.05, -0.7, 0), new Vector3(1.05, -0.7, 0), new Vector3(0, 0.95, 0)]; // CCW seen from +Z
  const triFill = new Mesh(new BufferGeometry().setFromPoints(triPts), new MeshBasicMaterial({ color: hdr(COLORS.cyan, 0.6), transparent: true, opacity: 0.25, side: FrontSide, depthWrite: false, blending: AdditiveBlending }));
  const triBack = new Mesh(new BufferGeometry().setFromPoints(triPts), new MeshBasicMaterial({ color: hdr(COLORS.red, 0.7), transparent: true, opacity: 0.3, side: BackSide, depthWrite: false, blending: AdditiveBlending }));
  const triEdge = new LineLoop(new BufferGeometry().setFromPoints(triPts), new LineBasicMaterial({ color: hdr(COLORS.white, 1.6), transparent: true }));
  const flip = new Group();
  flip.add(triFill, triBack, triEdge);
  wGroup.add(flip);
  const vTags = triPts.map((p, i) => {
    const lb = label(`v${i}`, 'vc-tag');
    lb.element.style.color = VCOL[i];
    lb.position.copy(p).multiplyScalar(1.18);
    flip.add(lb);
    return lb;
  });
  const comet = Array.from({ length: 18 }, (_, k) => {
    const sp = new Sprite(new SpriteMaterial({ map: tex, color: hdr(COLORS.cyan, 3), transparent: true, depthTest: false, blending: AdditiveBlending }));
    sp.scale.setScalar(0.2 * (1 - k / 22));
    flip.add(sp);
    return sp;
  });
  const windTag = label('', 'vc-tag big');
  windTag.position.set(0, -1.0, 0);
  wGroup.add(windTag);

  /* ---- Steps 2–3: the model, front vs back faces ---- */
  const mGroup = new Group();
  mGroup.position.y = 0.3;
  mGroup.scale.setScalar(1.35);
  scene.add(mGroup);
  const geo = meshToGeometry(mesh);
  const light = new Vector3(...LIGHT_DIR);
  const frontMat = new ShaderMaterial({
    vertexShader: FRONT_VS,
    fragmentShader: FRONT_FS,
    uniforms: { uColor: { value: new Color(0.95, 0.55, 0.25) }, uLight: { value: light }, uAlpha: { value: 1 } },
    transparent: true,
    side: FrontSide,
  });
  const backMat = new ShaderMaterial({
    vertexShader: BACK_VS,
    fragmentShader: BACK_FS,
    uniforms: { uLight: { value: light }, uAlpha: { value: 1 }, uPeel: { value: 0 } },
    transparent: true,
    side: BackSide,
    depthWrite: false,
  });
  const backMesh = new Mesh(geo, backMat);
  const frontMesh = new Mesh(geo, frontMat);
  backMesh.renderOrder = 1;
  frontMesh.renderOrder = 2;
  const spin = new Group();
  spin.rotation.set(SHOWCASE_ROT_X, SHOWCASE_ROT_Y, 0, 'YXZ');
  spin.add(backMesh, frontMesh);
  mGroup.add(spin);
  const apiTag = label('', 'vc-tag big');
  apiTag.position.set(0, 1.12, 0);
  mGroup.add(apiTag);

  const P = { vp: 0, stretch: 0, wind: 0, flip: 0, model: 0, front: 0.35, back: 1, peel: 0 };
  const W2 = 1.6 * 1.05;
  const H2 = 1.05;
  const view: StageView = {
    scene,
    camera,
    bloom: 0.8,
    bloomThreshold: 0.86,
    orbit: true,
    onFrame: (time) => {
      stars.tick(time);
      // Viewport.
      const sx = 1 + (W2 - 1) * ease(P.stretch);
      const sy = 1 + (H2 - 1) * ease(P.stretch);
      rect.scale.set(sx, sy, 1);
      vpGroup.visible = P.vp > 0.01;
      (plane.material as MeshBasicMaterial).opacity = 0.22 * P.vp;
      (border.material as LineBasicMaterial).opacity = P.vp;
      (grid.material as LineBasicMaterial).opacity = 0.22 * P.vp * ease(P.stretch);
      // Origin: center of NDC → API corner of the window.
      const corner = new Vector3(-sx, yUp ? -sy : sy, 0.01);
      originGroup.position.copy(new Vector3(0, 0, 0.01).lerp(corner, ease(P.stretch)));
      axisY.scale.y = yUp ? 1 : -1;
      [axisX, axisY].forEach((a) => ((a.material as LineBasicMaterial).opacity = P.vp * ease(P.stretch)));
      (originDot.material as SpriteMaterial).opacity = P.vp;
      ndcTag.position.set(0, sy + 0.12, 0);
      ndcTag.element.style.opacity = String(P.vp * (1 - ease(P.stretch)));
      winTag.position.set(sx - 0.25, -sy - 0.13, 0);
      winTag.element.style.opacity = String(P.vp * ease(P.stretch));
      oTag.position.copy(originGroup.position).add(new Vector3(-0.22, yUp ? -0.1 : 0.1, 0));
      oTag.element.style.opacity = String(P.vp * ease(P.stretch));
      yTag.position.copy(originGroup.position).add(new Vector3(0.12, yUp ? 0.62 : -0.62, 0));
      yTag.element.style.opacity = String(P.vp * ease(P.stretch));
      // Winding.
      wGroup.visible = P.wind > 0.01;
      flip.rotation.y = Math.PI * ease(P.flip);
      (triEdge.material as LineBasicMaterial).opacity = P.wind;
      (triFill.material as MeshBasicMaterial).opacity = 0.28 * P.wind;
      (triBack.material as MeshBasicMaterial).opacity = 0.32 * P.wind;
      vTags.forEach((lb) => (lb.element.style.opacity = String(P.wind)));
      const per = triPts.map((p, i) => p.distanceTo(triPts[(i + 1) % 3]));
      const total = per[0] + per[1] + per[2];
      const at = (u: number) => {
        let d = (((u % 1) + 1) % 1) * total;
        for (let i = 0; i < 3; i++) {
          if (d <= per[i]) return triPts[i].clone().lerp(triPts[(i + 1) % 3], d / per[i]);
          d -= per[i];
        }
        return triPts[0].clone();
      };
      const facingBack = ease(P.flip) > 0.5;
      comet.forEach((sp, k) => {
        sp.position.copy(at(time * 0.32 - k * 0.012)).setZ(0.02);
        (sp.material as SpriteMaterial).opacity = P.wind * (1 - k / 18);
        (sp.material as SpriteMaterial).color.copy(facingBack ? hdr(COLORS.red, 3) : hdr(COLORS.cyan, 3));
      });
      windTag.element.textContent = facingBack ? t(L('medurs (CW) → baksida', 'clockwise (CW) → back face')) : t(L('moturs (CCW) → framsida', 'counter-clockwise (CCW) → front face'));
      windTag.element.style.color = facingBack ? '#ff5a6e' : '#38e1ff';
      windTag.element.style.opacity = String(P.wind);
      // Model.
      mGroup.visible = P.model > 0.01;
      spin.rotation.y = SHOWCASE_ROT_Y + time * 0.3;
      frontMat.uniforms.uAlpha.value = P.front * P.model;
      frontMat.depthWrite = P.front > 0.95;
      backMat.uniforms.uAlpha.value = P.back * P.model * (1 - ease(P.peel));
      backMat.uniforms.uPeel.value = ease(P.peel);
      backMat.depthWrite = P.front < 0.05;
      apiTag.element.style.opacity = String(P.model);
    },
  };
  const stageHost = h('div.v-fill');
  const caption = h('div.vcc-caption');
  host.append(stageHost, caption);
  ctx.stage.attach(stageHost, view);

  const frontSetting: Record<ApiId, string> = {
    opengl: 'glFrontFace(GL_CCW) · glCullFace(GL_BACK)',
    vulkan: 'VK_FRONT_FACE_COUNTER_CLOCKWISE · VK_CULL_MODE_BACK_BIT',
    d3d12: 'FrontCounterClockwise = TRUE · D3D12_CULL_MODE_BACK',
  };
  const captions: Text[] = [
    L(
      `Viewport-transformen sträcker NDC-kvadraten till fönstret: ${VW} × ${VH} pixlar. ${yUp ? 'OpenGL: origo nere till vänster.' : api === 'vulkan' ? 'Vulkan: origo uppe till vänster, y nedåt.' : 'D3D12: origo uppe till vänster, y vänds.'}`,
      `The viewport transform stretches the NDC square onto the window: ${VW} × ${VH} pixels. ${yUp ? 'OpenGL: origin at the bottom left.' : api === 'vulkan' ? 'Vulkan: origin at the top left, y down.' : 'D3D12: origin at the top left, y is flipped.'}`,
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
    { vp: 1, stretch: 1, wind: 0, flip: 0, model: 0, front: 0.35, back: 1, peel: 0 },
    { vp: 0, stretch: 1, wind: 1, flip: 1, model: 0, front: 0.35, back: 1, peel: 0 },
    { vp: 0, stretch: 1, wind: 0, flip: 1, model: 1, front: 1, back: 1, peel: 1 },
    { vp: 0, stretch: 1, wind: 0, flip: 1, model: 1, front: 0, back: 1, peel: 0 },
  ];
  let last = -1;
  return {
    show(step, animate) {
      const fwd = animate && step > last;
      last = step;
      caption.innerHTML = t(captions[step]);
      apiTag.element.textContent = step === 3 ? t(L('fel: framsidor cullas', 'wrong: front faces culled')) : t(L('baksidor cullas', 'back faces culled'));
      apiTag.element.style.color = step === 3 ? '#ff5a6e' : '#38e1ff';
      gsap.killTweensOf(P);
      const tg = targets[step];
      if (fwd && step === 0) {
        Object.assign(P, { ...tg, stretch: 0, vp: 0 });
        gsap.to(P, { vp: 1, duration: dur(0.5) });
        gsap.to(P, { stretch: 1, duration: dur(1.6), delay: dur(0.8), ease: 'power2.inOut' });
      } else if (fwd && step === 1) {
        Object.assign(P, { vp: 0, wind: 0, flip: 0 });
        gsap.to(P, { wind: 1, duration: dur(0.6) });
        gsap.to(P, { flip: 1, duration: dur(1.4), delay: dur(3.2), ease: 'power2.inOut' });
      } else if (fwd && step === 2) {
        Object.assign(P, { wind: 0, model: 0, front: 0.35, back: 1, peel: 0 });
        gsap.to(P, { model: 1, duration: dur(0.7) });
        gsap.to(P, { peel: 1, duration: dur(1.6), delay: dur(1.8), ease: 'power2.in' });
        gsap.to(P, { front: 1, duration: dur(0.8), delay: dur(3.2) });
      } else if (fwd) gsap.to(P, { ...tg, duration: dur(1.2), ease: 'power2.inOut' });
      else Object.assign(P, tg);
      if (fwd) gsap.fromTo(caption, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: dur(0.4) });
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
