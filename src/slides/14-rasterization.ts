import { dur, h } from '../core/dom';
import { L } from '../core/i18n';
import type { ApiId } from '../core/state';
import { rasterizeTriangle, signedArea, type Fragment, type ScreenVertex } from '../pipeline/raster';
import { PixelCanvas, animateProgress } from '../views/PixelCanvas';
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
/* Real data                                                           */
/* ------------------------------------------------------------------ */
function dataVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const api = ctx.state.api;
  const z = zoomShowcase(ctx);
  const canvasHost = h('div.rz-canvas');
  const side = h('div.rz-side');
  const root = h('div.rz-root', {}, [canvasHost, side]);
  host.append(root);
  if (!z) {
    canvasHost.append(h('div.v-center.hint', { text: t(L('Ingen synlig triangel.', 'No visible triangle.')) }));
    return { show() {}, destroy() {} };
  }
  const pc = new PixelCanvas(canvasHost, z.cols, z.rows, 14);
  const V = z.verts;
  const sign = z.area < 0 ? -1 : 1;
  const absArea = Math.abs(z.area);
  const minX = Math.max(0, Math.floor(Math.min(V[0].x, V[1].x, V[2].x)));
  const maxX = Math.min(z.cols - 1, Math.ceil(Math.max(V[0].x, V[1].x, V[2].x)));
  const minY = Math.max(0, Math.floor(Math.min(V[0].y, V[1].y, V[2].y)));
  const maxY = Math.min(z.rows - 1, Math.ceil(Math.max(V[0].y, V[1].y, V[2].y)));
  const bbW = maxX - minX + 1;
  const bbCount = bbW * (maxY - minY + 1);
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

  // Whole mesh at 128×80: every triangle's fragments in submission order.
  const W = 128;
  const H = 80;
  const full = ctx.derived.render(api, W, H);
  const mf: { x: number; y: number; z: number; tri: number }[] = [];
  let rasterized = 0;
  for (const info of full.triangles) {
    if (!info.screen.length) continue;
    rasterized++;
    for (const s of info.screen) for (const f of rasterizeTriangle(s, W, H, info.index)) mf.push({ x: f.x, y: f.y, z: f.z, tri: f.tri });
  }
  const coveredPx = new Set(mf.map((f) => f.y * W + f.x)).size;
  const tiles = new Set(mf.map((f) => `${f.x >> 3},${f.y >> 3}`)).size;
  const showcaseFull = full.triangles[z.tri]?.screen[0];
  const perPixel = new Uint16Array(W * H);
  for (const f of mf) perPixel[f.y * W + f.x]++;
  // Step 2 default probe: the fragment where perspective correction matters most.
  let perspProbe = center;
  let maxDiff = -1;
  for (const f of z.frags) {
    const w = [0, 1, 2].map((i) => {
      const px = f.x + 0.5;
      const py = f.y + 0.5;
      const e = [edgeFn(V[1], V[2], px, py), edgeFn(V[2], V[0], px, py), edgeFn(V[0], V[1], px, py)][i];
      return (e * sign) / absArea;
    });
    const d = Math.abs(w[0] - f.bary[0]) + Math.abs(w[1] - f.bary[1]) + Math.abs(w[2] - f.bary[2]);
    if (d > maxDiff) {
      maxDiff = d;
      perspProbe = f;
    }
  }

  let step = 0;
  let sweep = 1; // 0..1 progress of the step-1 scan
  let fill = 1; // 0..1 progress of the step-2/3 reveal
  let hover: [number, number] | null = null;
  let owner = new Int32Array(W * H).fill(-1);
  let cancel: (() => void) | null = null;

  const drawTriangle = (pts: Tri, glow = 16) => {
    const p = pts.map((v) => [v.x, v.y] as [number, number]);
    pc.triangle(p, '#38e1ff', 'rgba(56,225,255,0.05)', 2, glow);
  };

  const drawCrop = () => {
    pc.clear();
    pc.grid(0.1);
    const { ctx: g } = pc;
    // Bounding box.
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

    drawTriangle(V, step === 2 ? 6 : 16);
    // Top-left edges: solid & bright; the others are exclusive (dashed overlay).
    if (step >= 1) {
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
    V.forEach((v, i) => pc.dot(v.x, v.y, step === 2 ? VCOL[i] : '#ffffff', 5));
    V.forEach((v, i) => {
      const cx = (V[0].x + V[1].x + V[2].x) / 3;
      const cy = (V[0].y + V[1].y + V[2].y) / 3;
      const dx = v.x - cx;
      const dy = v.y - cy;
      const l = Math.hypot(dx, dy) || 1;
      pc.text(`v${i}`, v.x + (dx / l) * 1.6, v.y + (dy / l) * 1.3, step === 2 ? VCOL[i] : '#e8ebff', 12, 'center');
    });

    // Pixel under the scan / mouse.
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

  const drawFull = () => {
    pc.clear();
    pc.grid(0.08);
    const n = Math.floor(fill * mf.length);
    const zb = new Float32Array(W * H).fill(2);
    owner = new Int32Array(W * H).fill(-1);
    for (let i = 0; i < n; i++) {
      const f = mf[i];
      const p = f.y * W + f.x;
      if (f.z < zb[p]) {
        zb[p] = f.z;
        owner[p] = f.tri;
      }
    }
    for (let p = 0; p < W * H; p++) {
      if (owner[p] < 0) continue;
      pc.fillCell(p % W, Math.floor(p / W), `hsl(${triHue(owner[p])},85%,${owner[p] === z.tri ? 78 : 58}%)`, 0.04);
    }
    // 8×8 tiles.
    const { ctx: g } = pc;
    g.save();
    g.strokeStyle = 'rgba(255,181,71,0.35)';
    g.lineWidth = 1;
    for (let x = 0; x <= W; x += 8) {
      const [px, py] = pc.px(x, 0);
      g.beginPath();
      g.moveTo(Math.round(px) + 0.5, py);
      g.lineTo(Math.round(px) + 0.5, py + H * pc.cell);
      g.stroke();
    }
    for (let y = 0; y <= H; y += 8) {
      const [px, py] = pc.px(0, y);
      g.beginPath();
      g.moveTo(px, Math.round(py) + 0.5);
      g.lineTo(px + W * pc.cell, Math.round(py) + 0.5);
      g.stroke();
    }
    g.restore();
    if (showcaseFull && fill >= 1) pc.triangle(showcaseFull.map((v) => [v.x, v.y] as [number, number]), '#ffffff', undefined, 1.5, 10);
    if (hover) {
      const [px, py] = pc.px(hover[0], hover[1]);
      g.strokeStyle = '#fff';
      g.lineWidth = 1.5;
      g.strokeRect(px - 1, py - 1, pc.cell + 2, pc.cell + 2);
    }
  };

  const currentProbe = (): [number, number] | null => {
    if (hover) return hover;
    if (step === 2) return perspProbe ? [perspProbe.x, perspProbe.y] : null;
    if (step === 1 && sweep < 1) {
      const i = Math.min(bbCount - 1, Math.floor(sweep * bbCount));
      return [minX + (i % bbW), minY + Math.floor(i / bbW)];
    }
    return center ? [center.x, center.y] : null;
  };

  const row = (k: string, v: string, cls = '') => `<div class="rz-row"><span>${k}</span><b class="${cls}">${v}</b></div>`;
  const coordName = fragCoordName(api);
  const updateSide = () => {
    const probe = currentProbe();
    let html = '';
    if (step === 0) {
      const vrows = V.map((v, i) => {
        const wy = api === 'opengl' ? z.fullH - (v.y + z.y0) : v.y + z.y0;
        return `<tr><td style="color:${VCOL[i]}">v${i}</td><td>${f2(v.x + z.x0, 1)}</td><td>${f2(wy, 1)}</td><td>${f2(v.z, 3)}</td></tr>`;
      }).join('');
      html = `<h4>${t(L('Triangel i fönsterkoordinater', 'Triangle in window coordinates'))}</h4>
        <table class="rz-table"><thead><tr><th></th><th>x</th><th>y${api === 'opengl' ? ' ↑' : ' ↓'}</th><th>z</th></tr></thead><tbody>${vrows}</tbody></table>
        ${row(t(L('Render target', 'Render target')), `${z.fullW}×${z.fullH}`)}
        ${row(t(L('Utsnitt (zoom)', 'Crop (zoomed)')), `${z.cols}×${z.rows} @ (${z.x0}, ${z.y0})`)}
        ${row(t(L('Area ×2', 'Area ×2')), f2(absArea, 1))}
        ${row(t(L('Varv på skärmen', 'Winding on screen')), z.area < 0 ? 'CCW → front' : 'CW', 'c-idx')}
        ${row('bounding box', `${bbW}×${maxY - minY + 1} = ${bbCount} px`, 'glow-amber')}
        <p class="rz-note">${t(api === 'opengl' ? L('OpenGL: fönstrets origo är nere till vänster, y uppåt.', 'OpenGL: window origin is bottom-left, y up.') : L(`${api === 'vulkan' ? 'Vulkan' : 'D3D12'}: fönstrets origo är uppe till vänster, y nedåt.`, `${api === 'vulkan' ? 'Vulkan' : 'D3D12'}: window origin is top-left, y down.`))}</p>`;
    } else if (step === 1 && probe) {
      const [x, y] = probe;
      const w = edges(x, y);
      const inBox = x >= minX && x <= maxX && y >= minY && y <= maxY;
      const inside = covered.has(y * z.cols + x);
      const [fx, fy] = fc(x, y);
      const tested = Math.min(bbCount, Math.floor(sweep * bbCount));
      let hits = 0;
      for (let i = 0; i < tested; i++) if (covered.has((minY + Math.floor(i / bbW)) * z.cols + minX + (i % bbW))) hits++;
      html = `<h4>${t(L('Pixel under test', 'Pixel under test'))}</h4>
        ${row(coordName, `(${f2(fx, 1)}, ${f2(fy, 1)})`)}
        ${w.map((v, i) => row(`w${i} = E(v${(i + 1) % 3}→v${(i + 2) % 3})`, f2(v, 2), v >= 0 ? 'c-idx' : 'rz-neg')).join('')}
        <div class="rz-verdict ${inside ? 'in' : 'out'}">${inside ? t(L('alla ≥ 0 → fragment', 'all ≥ 0 → fragment')) : inBox ? t(L('någon < 0 → utanför', 'one < 0 → outside')) : t(L('utanför bounding box', 'outside bounding box'))}</div>
        ${row(t(L('testade', 'tested')), `${tested} / ${bbCount}`)}
        ${row(t(L('täckta', 'covered')), String(hits), 'glow-cyan')}
        <p class="rz-note">${t(L('Streckade kanter är <i>inte</i> top-left: ett pixelcentrum exakt på dem räknas inte.', 'Dashed edges are <i>not</i> top-left: a pixel center exactly on them is not covered.'))}</p>`;
    } else if (step === 2 && probe) {
      const [x, y] = probe;
      const f = covered.get(y * z.cols + x);
      if (f) {
        const w = edges(x, y);
        const lin = w.map((v) => v / absArea);
        html = `<h4>${t(L('Barycentriska vikter', 'Barycentric weights'))}</h4>
          ${row(coordName, fc(x, y).map((v) => f2(v, 1)).join(', '))}
          <div class="rz-bary"><span></span><span>${t(L('linjär', 'linear'))}</span><span>${t(L('persp.', 'persp.'))}</span>
          ${[0, 1, 2].map((i) => `<span style="color:${VCOL[i]}">b${i}</span><span>${f2(lin[i], 3)}</span><b>${f2(f.bary[i], 3)}</b>`).join('')}</div>
          <div class="rz-swatch" style="background:rgb(${f.bary.map((b) => Math.round(b * 255)).join(',')})"></div>
          ${row(t(L('1/w per hörn', '1/w per vertex')), V.map((v) => f2(v.invW, 3)).join(' '))}
          ${row(t(L('2×2-quads', '2×2 quads')), String(quads.size))}
          ${row(t(L('helper-trådar', 'helper lanes')), String(helperLanes), 'c-violet')}`;
      } else {
        html = `<h4>${t(L('Barycentriska vikter', 'Barycentric weights'))}</h4><p class="rz-note">${t(L('Peka på en täckt pixel.', 'Point at a covered pixel.'))}</p>
          ${row(t(L('2×2-quads', '2×2 quads')), String(quads.size))}${row(t(L('helper-trådar', 'helper lanes')), String(helperLanes), 'c-violet')}`;
      }
    } else if (step === 3) {
      const hp = hover ? hover[1] * W + hover[0] : -1;
      const est = Math.round((full.stats.fragments * 1920 * 1080) / (W * H));
      html = `<h4>${t(L(`Hela meshen @ ${W}×${H}`, `Whole mesh @ ${W}×${H}`))}</h4>
        <div class="rz-big glow-cyan">${full.stats.fragments.toLocaleString()}</div><div class="rz-cap">${t(L('fragment genererade', 'fragments generated'))}</div>
        ${row(t(L('≈ vid 1920×1080', '≈ at 1920×1080')), est.toLocaleString())}
        ${row(t(L('trianglar rasteriserade', 'triangles rasterized')), rasterized.toLocaleString())}
        ${row(t(L('pixlar täckta', 'pixels covered')), `${coveredPx} / ${W * H}`)}
        ${row(t(L('överritning (snitt)', 'overdraw (avg)')), coveredPx ? (full.stats.fragments / coveredPx).toFixed(2) + '×' : '–')}
        ${row(t(L('8×8-tiles berörda', '8×8 tiles touched')), `${tiles} / ${(W / 8) * (H / 8)}`, 'glow-amber')}
        ${hp >= 0 && owner[hp] >= 0 ? row(t(L(`pixel (${hover![0]}, ${hover![1]})`, `pixel (${hover![0]}, ${hover![1]})`)), `#${owner[hp]} · ${perPixel[hp]} frag`, 'c-violet') : ''}
        <p class="rz-note">${t(L('Färg = vilken triangel som ligger närmast i pixeln. Vit kontur = vår triangel.', 'Color = which triangle is nearest in that pixel. White outline = our triangle.'))}</p>`;
    }
    side.innerHTML = html;
  };

  const redraw = () => {
    if (step === 3) drawFull();
    else drawCrop();
    updateSide();
  };
  pc.onResize(redraw);

  pc.canvas.addEventListener('mousemove', (e) => {
    if (step === 0) return;
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

  return {
    show(s, animate) {
      cancel?.();
      cancel = null;
      step = s;
      hover = null;
      const cols = s === 3 ? W : z.cols;
      const rows = s === 3 ? H : z.rows;
      if (pc.cols !== cols) {
        pc.cols = cols;
        pc.rows = rows;
        pc.resize();
      }
      sweep = 1;
      fill = 1;
      canvasHost.classList.toggle('hoverable', s >= 1);
      if (animate && (s === 1 || s === 2 || s === 3)) {
        const secs = s === 1 ? Math.min(5, Math.max(2.4, bbCount / 160)) : s === 2 ? 1.2 : 1.8;
        cancel = animateProgress(dur(secs), (p) => {
          if (s === 1) sweep = p;
          else fill = p;
          redraw();
        });
        if (s === 1) sweep = 0;
        else fill = 0;
      }
      redraw();
      if (animate) root.animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: dur(0.35) * 1000 });
    },
    destroy() {
      cancel?.();
      pc.destroy();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Concept: a big glowing triangle and a scanning beam                 */
/* ------------------------------------------------------------------ */
function conceptVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const canvas = h('canvas.v-fill');
  const caption = h('div.rz-caption');
  host.append(canvas, caption);
  const g = canvas.getContext('2d')!;
  let W = 0;
  let H = 0;
  const COLS = 40;
  const ROWS = 22;
  let cell = 10;
  let ox = 0;
  let oy = 0;
  const resize = () => {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    W = host.clientWidth;
    H = host.clientHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    cell = Math.max(2, Math.min((W - 30) / COLS, (H - 70) / ROWS));
    ox = (W - cell * COLS) / 2;
    oy = Math.max(10, (H - 60 - cell * ROWS) / 2);
  };
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();

  const A = { x: 5.3, y: 20.2 };
  const B = { x: 35.6, y: 16.4 };
  const C = { x: 15.8, y: 2.1 };
  const area = (B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x);
  const ef = (a: { x: number; y: number }, b: { x: number; y: number }, px: number, py: number) => (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x);
  const bary = (px: number, py: number) => [ef(B, C, px, py) / area, ef(C, A, px, py) / area, ef(A, B, px, py) / area];
  const inside = (px: number, py: number) => bary(px, py).every((b) => b >= 0);
  const bx0 = Math.floor(Math.min(A.x, B.x, C.x));
  const bx1 = Math.ceil(Math.max(A.x, B.x, C.x));
  const by0 = Math.floor(Math.min(A.y, B.y, C.y));
  const by1 = Math.ceil(Math.max(A.y, B.y, C.y));
  // Tiles of 8×8 cells handed out "in parallel" in a shuffled order.
  const tileOrder: [number, number][] = [];
  for (let ty = 0; ty < ROWS; ty += 8) for (let tx = 0; tx < COLS; tx += 8) tileOrder.push([tx, ty]);
  tileOrder.sort((a, b) => ((a[0] * 7 + a[1] * 13) % 11) - ((b[0] * 7 + b[1] * 13) % 11));

  let step = 0;
  let t0 = performance.now();
  let raf = 0;
  const P = (x: number, y: number): [number, number] => [ox + x * cell, oy + y * cell];

  const drawTri = (alpha: number, fill: boolean) => {
    g.save();
    g.beginPath();
    [A, B, C].forEach((v, i) => {
      const [x, y] = P(v.x, v.y);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    });
    g.closePath();
    if (fill) {
      const grad = g.createLinearGradient(...P(A.x, A.y), ...P(B.x, C.y));
      grad.addColorStop(0, `rgba(56,225,255,${0.12 * alpha})`);
      grad.addColorStop(1, `rgba(255,63,210,${0.12 * alpha})`);
      g.fillStyle = grad;
      g.fill();
    }
    g.shadowColor = '#38e1ff';
    g.shadowBlur = 24;
    g.strokeStyle = `rgba(120,240,255,${alpha})`;
    g.lineWidth = 2.5;
    g.stroke();
    g.restore();
  };

  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    const tt = Math.max(0, (now - t0) / 1000); // rAF time can precede t0
    g.clearRect(0, 0, W, H);
    // Grid.
    g.fillStyle = 'rgba(4,6,16,0.6)';
    g.fillRect(ox, oy, COLS * cell, ROWS * cell);
    g.strokeStyle = 'rgba(140,160,255,0.09)';
    g.lineWidth = 1;
    g.beginPath();
    for (let x = 0; x <= COLS; x++) {
      g.moveTo(Math.round(ox + x * cell) + 0.5, oy);
      g.lineTo(Math.round(ox + x * cell) + 0.5, oy + ROWS * cell);
    }
    for (let y = 0; y <= ROWS; y++) {
      g.moveTo(ox, Math.round(oy + y * cell) + 0.5);
      g.lineTo(ox + COLS * cell, Math.round(oy + y * cell) + 0.5);
    }
    g.stroke();

    const cellFill = (x: number, y: number, c: string, inset = 0.08) => {
      const [px, py] = P(x, y);
      g.fillStyle = c;
      g.fillRect(px + cell * inset, py + cell * inset, cell * (1 - 2 * inset), cell * (1 - 2 * inset));
    };

    if (step === 0) {
      const pulse = 0.75 + 0.25 * Math.sin(tt * 2.5);
      const [x0, y0] = P(bx0, by0);
      g.save();
      g.setLineDash([7, 6]);
      g.lineDashOffset = -tt * 20;
      g.strokeStyle = 'rgba(255,181,71,0.8)';
      g.lineWidth = 1.5;
      g.strokeRect(x0, y0, (bx1 - bx0) * cell, (by1 - by0) * cell);
      g.restore();
      drawTri(pulse, true);
    }

    if (step === 1) {
      // A beam scans the bounding box row by row; pixels inside light up and slowly cool down.
      const rowTime = 0.16;
      const nRows = by1 - by0;
      const cycle = nRows * rowTime + 1.6;
      const ct = tt % cycle;
      const scanRow = ct / rowTime;
      for (let y = by0; y < by1; y++) {
        for (let x = bx0; x < bx1; x++) {
          const ry = y - by0;
          const tHit = (ry + (x - bx0) / (bx1 - bx0)) * rowTime;
          if (ct < tHit) continue;
          const age = ct - tHit;
          if (inside(x + 0.5, y + 0.5)) {
            const k = Math.min(1, age / 0.6);
            const fade = ct > cycle - 0.5 ? (cycle - ct) / 0.5 : 1;
            g.globalAlpha = fade;
            cellFill(x, y, `rgb(${Math.round(255 - 199 * k)},${Math.round(255 - 30 * k)},255)`);
            g.globalAlpha = 1;
          } else if (age < 0.4) cellFill(x, y, `rgba(255,90,110,${0.35 * (1 - age / 0.4)})`, 0.3);
        }
      }
      if (scanRow < nRows) {
        const ry = Math.floor(scanRow);
        const fx = bx0 + (scanRow - ry) * (bx1 - bx0);
        const [lx, ly] = P(bx0, by0 + ry);
        const grad = g.createLinearGradient(0, ly - cell * 1.5, 0, ly + cell * 2.5);
        grad.addColorStop(0, 'rgba(56,225,255,0)');
        grad.addColorStop(0.5, 'rgba(56,225,255,0.22)');
        grad.addColorStop(1, 'rgba(56,225,255,0)');
        g.fillStyle = grad;
        g.fillRect(lx - cell, ly - cell * 1.5, (bx1 - bx0 + 2) * cell, cell * 4);
        const [hx, hy] = P(fx, by0 + ry + 0.5);
        g.save();
        g.shadowColor = '#fff';
        g.shadowBlur = 25;
        g.fillStyle = '#fff';
        g.beginPath();
        g.arc(hx, hy, cell * 0.28, 0, Math.PI * 2);
        g.fill();
        g.restore();
      }
      drawTri(0.9, false);
    }

    if (step === 2) {
      for (let y = by0; y < by1; y++)
        for (let x = bx0; x < bx1; x++) {
          if (!inside(x + 0.5, y + 0.5)) continue;
          const b = bary(x + 0.5, y + 0.5);
          const wave = 0.85 + 0.15 * Math.sin(tt * 3 - (x + y) * 0.35);
          cellFill(x, y, `rgb(${Math.round(b[0] * 255 * wave)},${Math.round(b[1] * 255 * wave)},${Math.round(b[2] * 255 * wave)})`, 0.05);
        }
      // A wandering 2×2 quad.
      const qi = Math.floor(tt / 0.7);
      const qx = bx0 + ((qi * 7) % (bx1 - bx0 - 2)) & ~1;
      const qy = by0 + ((qi * 5) % (by1 - by0 - 2)) & ~1;
      const [px, py] = P(qx, qy);
      g.save();
      g.strokeStyle = '#fff';
      g.shadowColor = '#fff';
      g.shadowBlur = 12;
      g.lineWidth = 2;
      g.strokeRect(px, py, cell * 2, cell * 2);
      g.restore();
      drawTri(0.6, false);
      [A, B, C].forEach((v, i) => {
        const [x, y] = P(v.x, v.y);
        g.save();
        g.shadowColor = VCOL[i];
        g.shadowBlur = 18;
        g.fillStyle = VCOL[i];
        g.beginPath();
        g.arc(x, y, 7, 0, Math.PI * 2);
        g.fill();
        g.restore();
      });
    }

    if (step === 3) {
      // Tiles are processed in parallel; each tile fills its covered pixels.
      const per = 0.45;
      const cycle = tileOrder.length * per * 0.5 + 2;
      const ct = tt % cycle;
      tileOrder.forEach(([tx, ty], i) => {
        const start = (i % 3) * 0.15 + Math.floor(i / 3) * per;
        const k = Math.max(0, Math.min(1, (ct - start) / per));
        if (k <= 0) return;
        const [px, py] = P(tx, ty);
        const tw = Math.min(8, COLS - tx);
        const th = Math.min(8, ROWS - ty);
        g.fillStyle = `rgba(255,181,71,${0.08 * (1 - k) + 0.02})`;
        g.fillRect(px, py, tw * cell, th * cell);
        for (let y = ty; y < ty + th; y++)
          for (let x = tx; x < tx + tw; x++) {
            if (!inside(x + 0.5, y + 0.5)) continue;
            if ((y - ty) * tw + (x - tx) > k * tw * th) continue;
            const b = bary(x + 0.5, y + 0.5);
            cellFill(x, y, `rgba(${Math.round(b[0] * 255)},${Math.round(b[1] * 255)},${Math.round(b[2] * 255)},0.85)`, 0.05);
          }
        g.strokeStyle = `rgba(255,181,71,${0.25 + 0.5 * (1 - k)})`;
        g.lineWidth = 1.5;
        g.strokeRect(px + 0.5, py + 0.5, tw * cell - 1, th * cell - 1);
      });
      drawTri(0.7, false);
      // MSAA inset: one edge pixel with the standard 4× sample pattern.
      const S = Math.min(130, H * 0.32);
      const ix = W - S - 18;
      const iy = 18;
      const ex = 34;
      const ey = 15; // a pixel on edge B→C (2 of 4 samples inside)
      g.save();
      g.fillStyle = 'rgba(5,6,13,0.85)';
      g.strokeStyle = 'rgba(255,255,255,0.6)';
      g.lineWidth = 1.5;
      g.fillRect(ix, iy, S, S);
      g.strokeRect(ix, iy, S, S);
      const pts = [[-2, -6], [6, -2], [-6, 2], [2, 6]];
      let cov = 0;
      g.beginPath();
      // The edge B→C through the inset.
      const toI = (x: number, y: number): [number, number] => [ix + (x - ex) * S, iy + (y - ey) * S];
      const e0 = toI(B.x, B.y);
      const e1 = toI(C.x, C.y);
      g.save();
      g.beginPath();
      g.rect(ix, iy, S, S);
      g.clip();
      g.beginPath();
      g.moveTo(...e0);
      g.lineTo(...e1);
      g.strokeStyle = '#38e1ff';
      g.shadowColor = '#38e1ff';
      g.shadowBlur = 10;
      g.lineWidth = 2;
      g.stroke();
      g.restore();
      pts.forEach(([sx, sy]) => {
        const px = ex + 0.5 + sx / 16;
        const py = ey + 0.5 + sy / 16;
        const isIn = inside(px, py);
        if (isIn) cov++;
        const [x, y] = toI(px, py);
        g.fillStyle = isIn ? '#5cf08f' : 'rgba(255,90,110,0.9)';
        g.shadowColor = g.fillStyle;
        g.shadowBlur = 10;
        g.beginPath();
        g.arc(x, y, 5, 0, Math.PI * 2);
        g.fill();
      });
      g.shadowBlur = 0;
      g.fillStyle = '#e8ebff';
      g.font = '600 11px "JetBrains Mono", monospace';
      g.fillText(`MSAA 4× · ${cov}/4`, ix + 6, iy + S - 8);
      g.restore();
      const [mx, my] = P(ex, ey);
      g.strokeStyle = 'rgba(255,255,255,0.7)';
      g.strokeRect(mx, my, cell, cell);
    }
  };
  raf = requestAnimationFrame(frame);

  const captions = [
    L('Tre hörn i pixelkoordinater. Bara pixlarna i den streckade <b>bounding boxen</b> kan täckas.', 'Three corners in pixel coordinates. Only pixels inside the dashed <b>bounding box</b> can be covered.'),
    L('Strålen testar varje pixelcentrum mot triangelns tre kanter. Inuti → pixeln tänds och blir ett <b>fragment</b>.', 'The beam tests every pixel center against the triangle\'s three edges. Inside → the pixel lights up and becomes a <b>fragment</b>.'),
    L('Varje fragment får vikter (b0, b1, b2) – här visade som rött, grönt och blått. Fragment körs i <b>2×2-quads</b>.', 'Each fragment gets weights (b0, b1, b2) – shown here as red, green and blue. Fragments run in <b>2×2 quads</b>.'),
    L('Riktiga GPU:er delar skärmen i <b>tiles</b> som rasteriseras parallellt. Med <b>MSAA</b> testas flera sample-punkter per pixel.', 'Real GPUs split the screen into <b>tiles</b> rasterized in parallel. With <b>MSAA</b>, several sample points are tested per pixel.'),
  ];
  return {
    show(s, animate) {
      step = s;
      t0 = performance.now();
      caption.innerHTML = t(captions[s]);
      if (animate) caption.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: dur(0.4) * 1000, easing: 'ease-out' });
    },
    destroy() {
      cancelAnimationFrame(raf);
      ro.disconnect();
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
