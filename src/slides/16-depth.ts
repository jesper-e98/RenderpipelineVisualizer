import { dur, h, s } from '../core/dom';
import { L } from '../core/i18n';
import type { ApiId } from '../core/state';
import type { RenderResult } from '../pipeline/raster';
import { DEFAULT_CAMERA } from '../pipeline/transform';
import { PixelCanvas, heat } from '../views/PixelCanvas';
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
  // Crop for the side-by-side comparison: the area any of the three images draws into.
  let bx0 = W;
  let by0 = H;
  let bx1 = 0;
  let by1 = 0;
  for (let p = 0; p < W * H; p++) {
    if (r.overdraw[p] === 0 && offNoCull.overdraw[p] === 0) continue;
    const x = p % W;
    const y = Math.floor(p / W);
    bx0 = Math.min(bx0, x);
    by0 = Math.min(by0, y);
    bx1 = Math.max(bx1, x);
    by1 = Math.max(by1, y);
  }
  if (bx1 < bx0) [bx0, by0, bx1, by1] = [0, 0, W - 1, H - 1];
  bx0 = Math.max(0, bx0 - 3);
  by0 = Math.max(0, by0 - 3);
  bx1 = Math.min(W - 1, bx1 + 3);
  by1 = Math.min(H - 1, by1 + 3);
  const CW = bx1 - bx0 + 1;
  const CH = by1 - by0 + 1;
  const crop = (rgba: Uint8ClampedArray) => {
    const out = new Uint8ClampedArray(CW * CH * 4);
    for (let y = 0; y < CH; y++) out.set(rgba.subarray(((by0 + y) * W + bx0) * 4, ((by0 + y) * W + bx0 + CW) * 4), y * CW * 4);
    return out;
  };
  const crops = [r, off, offNoCull].map((im) => crop(im.color));

  const canvasHost = h('div.dp-canvas');
  const chartHost = h('div.dp-chart');
  const side = h('div.dp-side');
  const root = h('div.dp-root', {}, [h('div.dp-main', {}, [canvasHost, chartHost]), side]);
  host.append(root);
  const GAP = Math.max(3, Math.round(CW * 0.05));
  const LABEL_ROWS = Math.max(3, Math.round(CH * 0.14));
  const pc = new PixelCanvas(canvasHost, W, H, 12);
  let step = 0;
  let hover: [number, number] | null = null;
  let wipe = 1;
  let anim: Animation | null = null;
  let raf = 0;

  const draw = () => {
    pc.clear();
    if (step === 0 || step === 1) {
      pc.grid(0.05);
      if (step === 1 && wipe < 1) {
        blit(pc, depthRgba, W, H, 0, 0);
        const cut = Math.floor(wipe * W);
        const part = new Uint8ClampedArray(W * H * 4);
        for (let y = 0; y < H; y++) part.set(odRgba.subarray((y * W) * 4, (y * W + cut) * 4), y * W * 4);
        const tmp = document.createElement('canvas');
        tmp.width = W;
        tmp.height = H;
        tmp.getContext('2d')!.putImageData(new ImageData(part, W, H), 0, 0);
        pc.ctx.save();
        pc.ctx.imageSmoothingEnabled = false;
        pc.ctx.beginPath();
        pc.ctx.rect(pc.ox, pc.oy, cut * pc.cell, H * pc.cell);
        pc.ctx.clip();
        pc.ctx.drawImage(tmp, pc.ox, pc.oy, W * pc.cell, H * pc.cell);
        pc.ctx.restore();
        const [lx] = pc.px(cut, 0);
        pc.ctx.fillStyle = '#fff';
        pc.ctx.shadowColor = '#ff3fd2';
        pc.ctx.shadowBlur = 14;
        pc.ctx.fillRect(lx - 1, pc.oy, 2, H * pc.cell);
        pc.ctx.shadowBlur = 0;
      } else blit(pc, step === 0 ? depthRgba : odRgba, W, H, 0, 0);
      if (hover) {
        const [px, py] = pc.px(hover[0], hover[1]);
        pc.ctx.strokeStyle = '#fff';
        pc.ctx.lineWidth = 1.5;
        pc.ctx.strokeRect(px - 2, py - 2, pc.cell + 4, pc.cell + 4);
      }
    } else if (step === 2) {
      const names = [
        t(L('djuptest PÅ', 'depth test ON')),
        t(L('djuptest AV', 'depth test OFF')),
        t(L('AV + ingen culling', 'OFF + no culling')),
      ];
      crops.forEach((im, i) => {
        const x = i * (CW + GAP);
        blit(pc, im, CW, CH, x, LABEL_ROWS);
        const [px, py] = pc.px(x, LABEL_ROWS);
        const col = i === 0 ? '#5cf08f' : '#ff5a6e';
        pc.ctx.save();
        pc.ctx.strokeStyle = col;
        pc.ctx.shadowColor = col;
        pc.ctx.shadowBlur = 10;
        pc.ctx.lineWidth = 1.5;
        pc.ctx.strokeRect(px + 0.5, py + 0.5, CW * pc.cell - 1, CH * pc.cell - 1);
        pc.ctx.restore();
        pc.text(names[i], x + CW / 2, LABEL_ROWS / 2, col, 12, 'center');
      });
    }
  };
  pc.onResize(draw);

  // Precision chart (step 3).
  const buildChart = () => {
    const VW = 560;
    const VH = 300;
    const m = { l: 54, r: 16, t: 16, b: 40 };
    const X = (z: number) => m.l + ((z - NEAR) / (FAR - NEAR)) * (VW - m.l - m.r);
    const Y = (d: number) => VH - m.b - d * (VH - m.t - m.b);
    const path = (fn: (z: number) => number) => {
      let d = '';
      for (let i = 0; i <= 120; i++) {
        const z = NEAR + ((FAR - NEAR) * i) / 120;
        d += `${i ? 'L' : 'M'}${X(z).toFixed(1)},${Y(fn(z)).toFixed(1)}`;
      }
      return d;
    };
    const z0 = distOf(dmin);
    const z1 = distOf(dmax);
    const svg = s('svg', { viewBox: `0 0 ${VW} ${VH}`, class: 'dp-svg', preserveAspectRatio: 'xMidYMid meet' }, [
      s('rect', { x: X(z0), y: m.t, width: Math.max(2, X(z1) - X(z0)), height: VH - m.t - m.b, class: 'dp-band' }),
      ...[0, 0.25, 0.5, 0.75, 1].map((d) => s('line', { x1: m.l, x2: VW - m.r, y1: Y(d), y2: Y(d), class: 'dp-gridline' })),
      ...[0, 0.25, 0.5, 0.75, 1].map((d) => s('text', { x: m.l - 8, y: Y(d) + 4, 'text-anchor': 'end', class: 'dp-tick' }, [d.toFixed(2)])),
      ...[NEAR, 2, 4, 6, 8, FAR].map((z) => s('text', { x: X(z), y: VH - m.b + 16, 'text-anchor': 'middle', class: 'dp-tick' }, [String(z)])),
      s('text', { x: (m.l + VW - m.r) / 2, y: VH - 6, 'text-anchor': 'middle', class: 'dp-axis' }, [t(L('avstånd från kameran (view space)', 'distance from camera (view space)'))]),
      s('text', { x: 14, y: VH / 2 - 10, transform: `rotate(-90 14 ${VH / 2 - 10})`, 'text-anchor': 'middle', class: 'dp-axis' }, [t(L('lagrat djup d', 'stored depth d'))]),
      s('path', { d: path(depthOf), class: 'dp-curve std' }),
      s('path', { d: path((z) => 1 - depthOf(z)), class: 'dp-curve rev' }),
      s('text', { x: X(5.2), y: Y(depthOf(5.2)) + 24, class: 'dp-lbl std' }, [t(L('standard: d = 0 nära → 1 långt bort', 'standard: d = 0 near → 1 far'))]),
      s('text', { x: X(5.2), y: Y(1 - depthOf(5.2)) - 14, class: 'dp-lbl rev' }, ['reversed-Z: 1 − d']),
      s('text', { x: X(z1) + 6, y: Y(0.55), class: 'dp-lbl band' }, [t(L('modellen', 'the model'))]),
    ]);
    chartHost.replaceChildren(svg);
  };

  // Precision numbers for the model's depth range.
  const slope = (z: number) => (FAR * NEAR) / (z * z * (FAR - NEAR)); // |dd/dz|
  const zFar = distOf(dmax);
  const prec = [
    { name: 'D24 UNORM', steps: Math.round((dmax - dmin) * (2 ** 24 - 1)), dz: 2 ** -24 / slope(zFar) },
    { name: 'D32F', steps: floatsBetween(dmin, dmax), dz: ulp(dmax) / slope(zFar) },
    { name: 'D32F rev-Z', steps: floatsBetween(1 - dmax, 1 - dmin), dz: ulp(1 - dmax) / slope(zFar) },
  ];

  const row = (k: string, v: string, cls = '') => `<div class="dp-row"><span>${k}</span><b class="${cls}">${v}</b></div>`;
  const legend = (a: string, b: string) => `<div class="dp-legend"><i></i><div><span>${a}</span><span>${b}</span></div></div>`;
  const updateSide = () => {
    const hp = hover ? hover[1] * W + hover[0] : -1;
    if (step === 0) {
      const d = hp >= 0 ? r.depth[hp] : NaN;
      const ndc = api === 'opengl' ? 2 * d - 1 : d;
      side.innerHTML = `<h4>${t(L('Djupbufferten', 'The depth buffer'))} · ${W}×${H}</h4>
        ${legend(`${dmin.toFixed(4)} ${t(L('nära', 'near'))}`, `${dmax.toFixed(4)} ${t(L('långt', 'far'))}`)}
        ${row(t(L('rensad till', 'cleared to')), '1.0')}
        ${row(t(L('modellen använder', 'model uses')), `${((dmax - dmin) * 100).toFixed(1)} % ${t(L('av intervallet', 'of the range'))}`, 'glow-amber')}
        ${
          hp >= 0
            ? `<div class="dp-probe">${row(`pixel (${hover![0]}, ${hover![1]})`, '')}
               ${row('d', d >= 1 ? '1.0 (clear)' : d.toFixed(5), 'glow-cyan')}
               ${d < 1 ? row(api === 'opengl' ? 'NDC z = 2d − 1' : 'NDC z = d', ndc.toFixed(5)) : ''}
               ${d < 1 ? row(t(L('avstånd', 'distance')), distOf(d).toFixed(3)) : ''}</div>`
            : `<p class="dp-note">${t(L('Peka i bilden för att läsa ett djupvärde.', 'Point at the image to read a depth value.'))}</p>`
        }
        <p class="dp-note">${t(
          api === 'opengl'
            ? L('OpenGL: NDC z ∈ [−1, 1] mappas av glDepthRange till [0, 1] innan det lagras.', 'OpenGL: NDC z ∈ [−1, 1] is mapped by glDepthRange to [0, 1] before it is stored.')
            : L(`${api === 'vulkan' ? 'Vulkan' : 'D3D12'}: NDC z ∈ [0, 1] lagras direkt (viewportens minDepth/maxDepth = 0/1).`, `${api === 'vulkan' ? 'Vulkan' : 'D3D12'}: NDC z ∈ [0, 1] is stored directly (viewport minDepth/maxDepth = 0/1).`),
        )}</p>`;
    } else if (step === 1) {
      const st = r.stats;
      const pct = st.fragments ? (st.depthRejected / st.fragments) * 100 : 0;
      side.innerHTML = `<h4>${t(L('Djuptestet i siffror', 'The depth test in numbers'))}</h4>
        ${row(t(L('fragment testade', 'fragments tested')), st.fragments.toLocaleString())}
        ${row(t(L('klarade testet → skrivna', 'passed → written')), st.written.toLocaleString(), 'c-idx')}
        ${row(t(L('kastade (z ≥ lagrat)', 'rejected (z ≥ stored)')), st.depthRejected.toLocaleString(), 'dp-neg')}
        <div class="dp-split"><i style="width:${100 - pct}%"></i><em style="width:${pct}%"></em></div>
        <h4 style="margin-top:12px">${t(L('Överritning', 'Overdraw'))}</h4>
        ${legend('1×', `${maxO}×`)}
        ${odHist.map((n, o) => (o === 0 || !n ? '' : row(`${o}× ${t(L('fragment', 'fragments'))}`, `${n} px`))).join('')}
        ${hp >= 0 ? row(`pixel (${hover![0]}, ${hover![1]})`, `${r.overdraw[hp]}×`, 'glow-cyan') : ''}`;
    } else if (step === 2) {
      side.innerHTML = `<h4>${t(L('Utan djuptest', 'Without a depth test'))}</h4>
        <p class="dp-note" style="margin-top:0">${t(L('Utan test vinner det fragment som ritas <b>sist</b>, oavsett avstånd.', 'Without the test, the fragment drawn <b>last</b> wins, whatever its distance.'))}</p>
        ${row(t(L('fel pixlar, AV', 'wrong pixels, OFF')), `${diffOff} px`, diffOff ? 'dp-neg' : 'c-idx')}
        ${row(t(L('fel pixlar, AV + ingen cull', 'wrong, OFF + no cull')), `${diffNoCull} px`, 'dp-neg')}
        <p class="dp-note">${t(
          diffOff < 10
            ? L('Den här modellen är (nästan) konvex: back-face culling räcker för att dölja baksidan. Stäng av culling också så syns felet.', 'This model is (almost) convex: back-face culling alone hides the far side. Turn culling off too and the error shows.')
            : L('Delar som borde vara skymda ritas ovanpå det som ligger närmare – vilket som hamnar överst beror bara på ritordningen.', 'Parts that should be hidden are drawn over what is closer – which one ends up on top depends only on draw order.'),
        )}</p>`;
    } else {
      side.innerHTML = `<h4>${t(L('Precision i modellens djup', 'Precision across the model'))}</h4>
        <table class="dp-table"><thead><tr><th></th><th>${t(L('steg', 'steps'))}</th><th>Δz @ ${zFar.toFixed(2)}</th></tr></thead><tbody>
        ${prec.map((p, i) => `<tr class="${i === 2 ? 'best' : ''}"><td>${p.name}</td><td>${p.steps.toLocaleString()}</td><td>${fmtSci(p.dz)}</td></tr>`).join('')}
        </tbody></table>
        ${row('near / far', `${NEAR} / ${FAR}`)}
        <p class="dp-note">${t(L('Standardkurvan är brant nära kameran: nästan alla värden går åt till första biten. Reversed-Z (1 = nära) med float-djup lägger floatens täta värden nära 0 – alltså långt bort, där de behövs.', 'The standard curve is steep near the camera: almost all values are spent on the first stretch. Reversed-Z (1 = near) with float depth puts the float\'s dense values near 0 – i.e. far away, where they are needed.'))}</p>`;
    }
  };

  pc.canvas.addEventListener('mousemove', (e) => {
    if (step > 1) return;
    const b = pc.canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - b.left - pc.ox) / pc.cell);
    const y = Math.floor((e.clientY - b.top - pc.oy) / pc.cell);
    const nh: [number, number] | null = x >= 0 && y >= 0 && x < W && y < H ? [x, y] : null;
    if (nh?.[0] === hover?.[0] && nh?.[1] === hover?.[1]) return;
    hover = nh;
    draw();
    updateSide();
  });
  pc.canvas.addEventListener('mouseleave', () => {
    hover = null;
    draw();
    updateSide();
  });

  return {
    show(st, animate) {
      cancelAnimationFrame(raf);
      anim?.cancel();
      step = st;
      hover = null;
      wipe = 1;
      const cols = st === 2 ? CW * 3 + GAP * 2 : W;
      const rows = st === 2 ? CH + LABEL_ROWS : H;
      if (pc.cols !== cols || pc.rows !== rows) {
        pc.cols = cols;
        pc.rows = rows;
        pc.resize();
      }
      canvasHost.style.display = st === 3 ? 'none' : '';
      chartHost.style.display = st === 3 ? '' : 'none';
      if (st === 3) buildChart();
      if (animate && st === 1) {
        const start = performance.now();
        const tick = () => {
          wipe = Math.min(1, (performance.now() - start) / (dur(1.2) * 1000));
          draw();
          if (wipe < 1) raf = requestAnimationFrame(tick);
        };
        wipe = 0;
        raf = requestAnimationFrame(tick);
      }
      draw();
      updateSide();
      if (animate) {
        anim = root.animate([{ opacity: 0.3 }, { opacity: 1 }], { duration: dur(0.4) * 1000 });
        if (st === 3) chartHost.querySelectorAll('.dp-curve').forEach((p) => p.animate([{ strokeDashoffset: 1400 }, { strokeDashoffset: 0 }], { duration: dur(1.2) * 1000, easing: 'ease-out' }));
      }
    },
    destroy() {
      cancelAnimationFrame(raf);
      anim?.cancel();
      pc.destroy();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Concept: fragments arriving at one pixel in random order            */
/* ------------------------------------------------------------------ */
function conceptVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const canvas = h('canvas.v-fill');
  const caption = h('div.dp-caption');
  host.append(canvas, caption);
  const g = canvas.getContext('2d')!;
  let W = 0;
  let H = 0;
  const resize = () => {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    W = host.clientWidth;
    H = host.clientHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();

  const layers = [
    { d: 0.32, color: '#38e1ff', rgb: [56, 225, 255] },
    { d: 0.56, color: '#ff3fd2', rgb: [255, 63, 210] },
    { d: 0.8, color: '#ffb547', rgb: [255, 181, 71] },
  ];
  const orderFor = (cycle: number) => {
    const perms = [[1, 2, 0], [2, 0, 1], [0, 2, 1], [2, 1, 0], [1, 0, 2]];
    return perms[cycle % perms.length];
  };
  let step = 0;
  let t0 = performance.now();
  let raf = 0;
  const FRAG = 1.5;
  const CYCLE = FRAG * 3 + 1.4;

  const box = (x: number, y: number, sz: number, fill: string, title: string, depth: string, glow: string) => {
    g.save();
    g.fillStyle = fill;
    g.shadowColor = glow;
    g.shadowBlur = 24;
    g.fillRect(x, y, sz, sz);
    g.shadowBlur = 0;
    g.strokeStyle = 'rgba(255,255,255,0.55)';
    g.lineWidth = 1.5;
    g.strokeRect(x + 0.5, y + 0.5, sz, sz);
    g.font = '600 11px Inter, sans-serif';
    g.fillStyle = '#9aa3c7';
    g.textAlign = 'center';
    g.fillText(title, x + sz / 2, y - 9);
    g.font = '700 13px "JetBrains Mono", monospace';
    g.fillStyle = '#e8ebff';
    g.fillText(depth, x + sz / 2, y + sz + 18);
    g.restore();
  };

  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    const tt = Math.max(0, (now - t0) / 1000); // rAF time can precede t0
    g.clearRect(0, 0, W, H);
    const cy = (H - 56) / 2 + 4;
    const eyeX = W * 0.07;
    const rayEnd = W * 0.66;
    const planeX = (d: number) => W * 0.17 + d * W * 0.42;

    if (step === 3) {
      drawPrecision(tt);
      return;
    }
    // Eye and the ray through the pixel.
    g.save();
    g.strokeStyle = 'rgba(255,255,255,0.25)';
    g.setLineDash([4, 6]);
    g.beginPath();
    g.moveTo(eyeX, cy);
    g.lineTo(rayEnd, cy);
    g.stroke();
    g.restore();
    g.save();
    g.fillStyle = '#e8ebff';
    g.shadowColor = '#fff';
    g.shadowBlur = 12;
    g.beginPath();
    g.ellipse(eyeX, cy, 13, 8, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#05060d';
    g.beginPath();
    g.arc(eyeX + 3, cy, 4, 0, Math.PI * 2);
    g.fill();
    g.restore();
    // Depth axis.
    g.save();
    g.font = '600 11px "JetBrains Mono", monospace';
    g.fillStyle = '#646d94';
    g.textAlign = 'center';
    const ph = Math.min(150, H * 0.42);
    [0, 0.5, 1].forEach((d) => g.fillText(`z = ${d}`, planeX(d), cy + ph / 2 + 22));
    g.restore();

    // Surfaces as glass planes in perspective.
    layers.forEach((l) => {
      const x = planeX(l.d);
      g.save();
      g.beginPath();
      g.moveTo(x - 22, cy - ph / 2 + 14);
      g.lineTo(x + 22, cy - ph / 2 - 10);
      g.lineTo(x + 22, cy + ph / 2 - 26);
      g.lineTo(x - 22, cy + ph / 2);
      g.closePath();
      g.fillStyle = `rgba(${l.rgb.join(',')},0.16)`;
      g.strokeStyle = l.color;
      g.shadowColor = l.color;
      g.shadowBlur = 14;
      g.lineWidth = 1.5;
      g.fill();
      g.stroke();
      g.restore();
    });

    const sz = Math.min(64, H * 0.17);
    const boxX = W * 0.78;
    const boxes = step === 2 ? [{ y: cy - sz - 34, test: true }, { y: cy + 34, test: false }] : [{ y: cy - sz / 2, test: true }];
    const cycle = Math.floor(tt / CYCLE);
    const ct = tt % CYCLE;
    const order = orderFor(cycle);
    boxes.forEach((b) => {
      // Replay the cycle up to now to know the box's state.
      let depth = 1;
      let col = 'rgba(10,14,40,0.95)';
      let glow = 'rgba(0,0,0,0)';
      order.forEach((li, k) => {
        if (step === 0) return;
        const l = layers[li];
        const tk = ct - k * FRAG;
        if (tk < FRAG * 0.6) return;
        if (!b.test || l.d < depth) {
          depth = l.d;
          col = l.color;
          glow = l.color;
        }
      });
      box(boxX, b.y, sz, col, step === 2 ? (b.test ? t(L('djuptest: LESS', 'depth test: LESS')) : t(L('djuptest: AV', 'depth test: OFF'))) : t(L('pixel + djupbuffert', 'pixel + depth buffer')), `z = ${depth.toFixed(2)}`, glow);
      if (step === 0) return;
      // The fragment currently in flight.
      const k = Math.floor(ct / FRAG);
      if (k > 2) {
        // Cycle done: verdict.
        if (step === 2) {
          const correct = layers[0].color;
          g.save();
          g.font = '700 12px Inter, sans-serif';
          g.textAlign = 'left';
          const ok = col === correct;
          g.fillStyle = ok ? '#5cf08f' : '#ff5a6e';
          g.fillText(ok ? '✓' : t(L('✗ fel', '✗ wrong')), boxX + sz + 12, b.y + sz / 2 + 4);
          g.restore();
        }
        return;
      }
      const l = layers[order[k]];
      const tk = (ct - k * FRAG) / FRAG;
      const sx = planeX(l.d);
      const sy = cy;
      const ex = boxX + sz / 2;
      const ey = b.y + sz / 2;
      const p = Math.min(1, tk / 0.55);
      const e = 1 - Math.pow(1 - p, 3);
      const x = sx + (ex - sx) * e;
      const y = sy + (ey - sy) * e - Math.sin(e * Math.PI) * 40;
      // Compare depth against what was stored before this fragment.
      let stored = 1;
      for (let j = 0; j < k; j++) {
        const lj = layers[order[j]];
        if (!b.test || lj.d < stored) stored = lj.d;
      }
      const pass = !b.test || l.d < stored;
      const after = tk > 0.55;
      g.save();
      const alpha = after && !pass ? Math.max(0, 1 - (tk - 0.55) / 0.3) : after ? Math.max(0, 1 - (tk - 0.55) / 0.15) : 1;
      g.globalAlpha = alpha;
      const fy = after && !pass ? y + (tk - 0.55) * 120 : y;
      g.fillStyle = l.color;
      g.shadowColor = l.color;
      g.shadowBlur = 18;
      g.fillRect(x - 9, fy - 9, 18, 18);
      g.shadowBlur = 0;
      g.font = '700 11px "JetBrains Mono", monospace';
      g.fillStyle = '#e8ebff';
      g.textAlign = 'center';
      g.fillText(l.d.toFixed(2), x, fy - 15);
      g.restore();
      if (tk > 0.45 && tk < 0.95) {
        g.save();
        g.font = '700 12px "JetBrains Mono", monospace';
        g.textAlign = 'left';
        g.fillStyle = pass ? '#5cf08f' : '#ff5a6e';
        const txt = b.test ? `${l.d.toFixed(2)} < ${stored.toFixed(2)} ${pass ? '✓' : '✗'}` : t(L('skriv över', 'overwrite'));
        g.fillText(txt, boxX + sz + 12, b.y + sz / 2 + 4);
        g.restore();
      }
    });
  };

  // Step 3: where representable depth values land along the view ray.
  const drawPrecision = (tt: number) => {
    const n = 0.5;
    const f = 10;
    const x0 = W * 0.08;
    const x1 = W * 0.92;
    const X = (z: number) => x0 + ((z - n) / (f - n)) * (x1 - x0);
    const rows = [
      { y: H * 0.26, name: t(L('standard (16 jämna steg i d)', 'standard (16 even steps in d)')), color: '#ffb547', zs: Array.from({ length: 17 }, (_, k) => (f * n) / (f - (k / 16) * (f - n))) },
      {
        y: H * 0.56,
        name: t(L('reversed-Z + float (värden täta nära 0)', 'reversed-Z + float (values dense near 0)')),
        color: '#38e1ff',
        zs: (() => {
          const out: number[] = [];
          for (let e = -6; e <= -1; e++) for (let m = 8; m < 16; m += 2) out.push((m / 8) * 2 ** e);
          out.push(1);
          return out.map((dr) => (f * n) / (n + dr * (f - n)));
        })(),
      },
    ];
    rows.forEach((r, i) => {
      g.save();
      g.strokeStyle = 'rgba(255,255,255,0.2)';
      g.beginPath();
      g.moveTo(x0, r.y);
      g.lineTo(x1, r.y);
      g.stroke();
      g.font = '600 12px Inter, sans-serif';
      g.fillStyle = r.color;
      g.fillText(r.name, x0, r.y - 30);
      r.zs.forEach((z, k) => {
        const pulse = 0.6 + 0.4 * Math.sin(tt * 3 - k * 0.4 - i);
        g.strokeStyle = r.color;
        g.globalAlpha = pulse;
        g.shadowColor = r.color;
        g.shadowBlur = 8;
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(X(z), r.y - 14);
        g.lineTo(X(z), r.y + 14);
        g.stroke();
      });
      g.restore();
    });
    g.save();
    g.font = '600 11px "JetBrains Mono", monospace';
    g.fillStyle = '#646d94';
    g.fillText(t(L('nära', 'near')), x0, H * 0.56 + 36);
    g.textAlign = 'right';
    g.fillText(t(L('långt bort', 'far')), x1, H * 0.56 + 36);
    g.restore();
  };
  raf = requestAnimationFrame(frame);

  const captions = [
    L('Djupbufferten minns, per pixel, det närmaste djupet hittills. Den rensas till 1.0 (längst bort).', 'The depth buffer remembers, per pixel, the nearest depth so far. It is cleared to 1.0 (farthest).'),
    L('Fragment kommer i den ordning trianglarna ritas – inte sorterade. Närmare än det lagrade? Skriv färg och djup. Annars kastas det.', 'Fragments arrive in the order triangles are drawn – not sorted. Closer than what is stored? Write color and depth. Otherwise it is discarded.'),
    L('Utan djuptest vinner den som ritas sist. Resultatet beror på ordningen – oftast fel.', 'Without a depth test, whoever is drawn last wins. The result depends on order – usually wrong.'),
    L('Djupet är inte linjärt. Med standard-Z hamnar nästan alla värden nära kameran; reversed-Z + float sprider dem jämnare.', 'Depth is not linear. With standard Z almost all values end up near the camera; reversed-Z + float spreads them more evenly.'),
  ];
  return {
    show(st, animate) {
      step = st;
      t0 = performance.now();
      caption.innerHTML = t(captions[st]);
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
