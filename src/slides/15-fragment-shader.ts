import { dur, h } from '../core/dom';
import { L } from '../core/i18n';
import type { ApiId } from '../core/state';
import { AMBIENT, BASE_COLOR, LIGHT_DIR, SHININESS, VIEW_DIR, dot, normalize, shade } from '../pipeline/shade';
import type { V3 } from '../pipeline/transform';
import { PixelCanvas, animateProgress } from '../views/PixelCanvas';
import { centerFragment, fragCoord, fragCoordName, zoomShowcase } from './14-rasterization';
import { standardSlide } from './standard';
import type { ApiPanelSpec, SlideContext, Visual } from './types';
import '../styles/slides/fragment-shader.css';

const f3 = (v: number, d = 3) => (Math.abs(v) < 0.5 * 10 ** -d ? 0 : v).toFixed(d);
const vec = (v: readonly number[], d = 3) => `(${v.map((x) => f3(x, d)).join(', ')})`;
const rgb = (c: readonly number[]) => `rgb(${c.map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255)).join(',')})`;
const HALF: V3 = normalize([LIGHT_DIR[0] + VIEW_DIR[0], LIGHT_DIR[1] + VIEW_DIR[1], LIGHT_DIR[2] + VIEW_DIR[2]]);

/** A glowing arrow in CSS pixels. */
function arrow(g: CanvasRenderingContext2D, x: number, y: number, dx: number, dy: number, color: string, label: string) {
  const x2 = x + dx;
  const y2 = y + dy;
  const a = Math.atan2(dy, dx);
  g.save();
  g.strokeStyle = color;
  g.fillStyle = color;
  g.shadowColor = color;
  g.shadowBlur = 12;
  g.lineWidth = 2.5;
  g.beginPath();
  g.moveTo(x, y);
  g.lineTo(x2, y2);
  g.stroke();
  g.beginPath();
  g.moveTo(x2, y2);
  g.lineTo(x2 - 10 * Math.cos(a - 0.4), y2 - 10 * Math.sin(a - 0.4));
  g.lineTo(x2 - 10 * Math.cos(a + 0.4), y2 - 10 * Math.sin(a + 0.4));
  g.closePath();
  g.fill();
  g.shadowBlur = 0;
  g.font = '700 13px "JetBrains Mono", monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const lx = x2 + Math.cos(a) * 14;
  const ly = y2 + Math.sin(a) * 14;
  g.fillStyle = 'rgba(5,6,13,0.75)';
  g.fillRect(lx - 9, ly - 9, 18, 18);
  g.fillStyle = color;
  g.fillText(label, lx, ly);
  g.restore();
}

/* ------------------------------------------------------------------ */
/* Real data                                                           */
/* ------------------------------------------------------------------ */
function dataVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const api = ctx.state.api;
  const z = zoomShowcase(ctx);
  const canvasHost = h('div.fs-canvas');
  const side = h('div.fs-side');
  const root = h('div.fs-root', {}, [canvasHost, side]);
  host.append(root);
  const frag = z ? centerFragment(z) : null;
  if (!z || !frag) {
    canvasHost.append(h('div.v-center.hint', { text: t(L('Ingen synlig triangel.', 'No visible triangle.')) }));
    return { show() {}, destroy() {} };
  }
  const pc = new PixelCanvas(canvasHost, z.cols, z.rows, 14);
  const IW = 160;
  const IH = 100;
  const image = ctx.derived.render(api, IW, IH);
  const view = image.matrices.view.elements;
  // World direction → on-screen direction (view rotation, then flip y for canvas).
  const screenDir = (v: V3): [number, number] => {
    const x = view[0] * v[0] + view[4] * v[1] + view[8] * v[2];
    const y = view[1] * v[0] + view[5] * v[1] + view[9] * v[2];
    return [x, -y];
  };
  const raw = frag.attrs as V3;
  const terms = shade(raw);
  const nh = Math.max(dot(terms.n, HALF), 0);
  const shaded = z.frags.map((f) => shade(f.attrs as V3).color);
  const [fx, fy] = fragCoord(api, frag.x + z.x0, frag.y + z.y0, z.fullH);
  const out8 = terms.color.map((c) => Math.round(c * 255));
  const { stats } = image;

  let step = 0;
  let fill = 1;
  let cancel: (() => void) | null = null;

  const drawCrop = () => {
    pc.clear();
    pc.grid(0.08);
    z.frags.forEach((f, i) => {
      if (step >= 2) pc.fillCell(f.x, f.y, rgb(shaded[i]), 0.04);
      else pc.fillCell(f.x, f.y, f === frag ? rgb(step === 1 ? terms.color : [0.6, 0.65, 1]) : 'rgba(110,130,220,0.22)', 0.08);
    });
    pc.triangle(z.verts.map((v) => [v.x, v.y] as [number, number]), 'rgba(56,225,255,0.7)', undefined, 1.5, 8);
    const [cx, cy] = pc.px(frag.x + 0.5, frag.y + 0.5);
    const g = pc.ctx;
    g.save();
    g.strokeStyle = '#fff';
    g.shadowColor = '#fff';
    g.shadowBlur = 14;
    g.lineWidth = 2;
    g.strokeRect(cx - pc.cell / 2 - 2, cy - pc.cell / 2 - 2, pc.cell + 4, pc.cell + 4);
    g.restore();
    const len = Math.min(pc.width, pc.height) * 0.28;
    const draw = (v: V3, color: string, label: string) => {
      const [dx, dy] = screenDir(v);
      const l = Math.hypot(dx, dy) || 1;
      // Keep the on-screen length proportional to how much the vector faces sideways.
      const s = (len * Math.max(0.25, Math.min(1, l))) / l;
      arrow(g, cx, cy, dx * s, dy * s, color, label);
    };
    draw(terms.n, '#ff3fd2', 'N');
    if (step >= 1) {
      draw(LIGHT_DIR, '#ffb547', 'L');
      draw(HALF, '#38e1ff', 'H');
    }
  };

  const drawImage = () => {
    pc.clear();
    pc.grid(0.05);
    const rows = Math.floor(fill * IH);
    const px = new Uint8ClampedArray(image.color);
    for (let y = rows; y < IH; y++)
      for (let x = 0; x < IW; x++) {
        const p = (y * IW + x) * 4;
        px[p] = 6;
        px[p + 1] = 8;
        px[p + 2] = 20;
      }
    pc.image(px);
    if (fill < 1) {
      const [lx, ly] = pc.px(0, rows);
      const g = pc.ctx;
      const grad = g.createLinearGradient(0, ly - 18, 0, ly + 4);
      grad.addColorStop(0, 'rgba(255,63,210,0)');
      grad.addColorStop(1, 'rgba(255,63,210,0.55)');
      g.fillStyle = grad;
      g.fillRect(lx, ly - 18, IW * pc.cell, 20);
      g.fillStyle = '#fff';
      g.shadowColor = '#ff3fd2';
      g.shadowBlur = 16;
      g.fillRect(lx, ly - 1, IW * pc.cell, 2);
      g.shadowBlur = 0;
    }
  };

  const bar = (label: string, v: number, color: string, text = f3(v)) =>
    `<div class="fs-bar"><span>${label}</span><i><em style="width:${Math.min(100, v * 100)}%;background:${color};box-shadow:0 0 10px ${color}"></em></i><b>${text}</b></div>`;
  const row = (k: string, v: string, cls = '') => `<div class="fs-row"><span>${k}</span><b class="${cls}">${v}</b></div>`;

  const updateSide = () => {
    const io = `${fragCoordName(api)} = (${f3(fx, 1)}, ${f3(fy, 1)})`;
    if (step === 0) {
      side.innerHTML = `<h4>${t(L('Indata till ett fragment', 'Inputs of one fragment'))}</h4>
        <div class="fs-code">${io}</div>
        ${row('vNormal', vec(raw), 'c-nrm')}
        ${row('|vNormal|', f3(Math.hypot(...raw)), Math.abs(Math.hypot(...raw) - 1) > 0.001 ? 'glow-amber' : '')}
        ${row('n = normalize', vec(terms.n), 'c-nrm')}
        ${row('b0 b1 b2', frag.bary.map((b) => f3(b, 2)).join(' '))}
        <p class="fs-note">${t(L('Interpolerade normaler blir kortare än 1 mellan hörnen – därför normaliserar shadern igen.', 'Interpolated normals get shorter than 1 between the corners – that is why the shader normalizes again.'))}</p>`;
    } else if (step === 1) {
      side.innerHTML = `<h4>${t(L('Blinn–Phong, steg för steg', 'Blinn–Phong, step by step'))}</h4>
        ${row('L', vec(LIGHT_DIR), 'glow-amber')}
        ${row('H', vec(HALF), 'glow-cyan')}
        ${bar('N·L', terms.diffuse, '#ffb547')}
        ${bar('N·H', nh, '#38e1ff')}
        ${bar(`(N·H)<sup>${SHININESS}</sup>`, terms.specular, '#ffffff', terms.specular < 0.001 ? terms.specular.toExponential(1) : f3(terms.specular))}
        ${bar('ambient', AMBIENT, '#9b7bff', AMBIENT.toFixed(2))}
        <p class="fs-note">${t(L('V antas vara +Z (riktad betraktare), som i appens shader.', 'V is taken as +Z (directional viewer), as in the app\'s shader.'))}</p>`;
    } else if (step === 2) {
      const ch = ['R', 'G', 'B'];
      const lines = [0, 1, 2]
        .map((i) => `<div class="fs-eq"><span>${ch[i]}</span>${f3(BASE_COLOR[i], 2)}·(${AMBIENT.toFixed(2)}+${f3(terms.diffuse)}) + ${f3(terms.specular)}·0.8 = <b>${f3(terms.color[i])}</b></div>`)
        .join('');
      side.innerHTML = `<h4>${t(L('Utdata', 'Output'))}</h4>
        ${lines}
        <div class="fs-swatch" style="background:${rgb(terms.color)};box-shadow:0 0 28px ${rgb(terms.color)}"></div>
        ${row(api === 'd3d12' ? 'SV_Target0' : 'outColor (location 0)', vec([...terms.color, 1], 2))}
        ${row(t(L('lagras som RGBA8', 'stored as RGBA8')), `${out8.join(', ')}, 255`, 'glow-amber')}
        ${row(t(L('fragment i triangeln', 'fragments in triangle')), String(z.frags.length))}`;
    } else {
      side.innerHTML = `<h4>${t(L(`Hela bilden @ ${IW}×${IH}`, `Whole image @ ${IW}×${IH}`))}</h4>
        <div class="fs-big glow-magenta">${stats.written.toLocaleString()}</div><div class="fs-cap">${t(L('shader-anrop som skrev en pixel', 'shader invocations that wrote a pixel'))}</div>
        ${row(t(L('fragment från rasteriseraren', 'fragments from the rasterizer')), stats.fragments.toLocaleString())}
        ${row(t(L('bortsorterade av djuptest', 'rejected by depth test')), stats.depthRejected.toLocaleString(), 'rz-neg')}
        ${row(t(L('≈ vid 1920×1080', '≈ at 1920×1080')), Math.round((stats.written * 1920 * 1080) / (IW * IH)).toLocaleString())}
        <p class="fs-note">${t(L('Med <i>early-Z</i> testas djupet före shadern, så skymda fragment aldrig behöver skuggas.', 'With <i>early-Z</i>, depth is tested before the shader, so hidden fragments never need shading.'))}</p>`;
    }
  };

  const redraw = () => {
    if (step === 3) drawImage();
    else drawCrop();
  };
  pc.onResize(redraw);

  return {
    show(s, animate) {
      cancel?.();
      cancel = null;
      step = s;
      fill = 1;
      const cols = s === 3 ? IW : z.cols;
      if (pc.cols !== cols) {
        pc.cols = cols;
        pc.rows = s === 3 ? IH : z.rows;
        pc.resize();
      }
      if (animate && s === 3) {
        fill = 0;
        cancel = animateProgress(dur(2.2), (p) => {
          fill = p;
          redraw();
        });
      }
      redraw();
      updateSide();
      if (animate) side.animate([{ opacity: 0, transform: 'translateX(10px)' }, { opacity: 1, transform: 'none' }], { duration: dur(0.4) * 1000, easing: 'ease-out' });
    },
    destroy() {
      cancel?.();
      pc.destroy();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Concept: an orbiting light painting a sphere of fragments           */
/* ------------------------------------------------------------------ */
function conceptVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const canvas = h('canvas.v-fill');
  const caption = h('div.fs-caption');
  host.append(canvas, caption);
  const g = canvas.getContext('2d')!;
  let W = 0;
  let H = 0;
  let cx = 0;
  let cy = 0;
  let R = 100;
  let cell = 10;
  let cells: { x: number; y: number; n: V3; d: number }[] = [];
  const resize = () => {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    W = host.clientWidth;
    H = host.clientHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    R = Math.max(40, Math.min(W * 0.26, (H - 70) * 0.44));
    cx = W / 2;
    cy = (H - 50) / 2 + 6;
    cell = Math.max(6, Math.round(R / 11));
    cells = [];
    const n = Math.ceil(R / cell);
    for (let j = -n; j < n; j++)
      for (let i = -n; i < n; i++) {
        const x = (i + 0.5) * cell;
        const y = (j + 0.5) * cell;
        const r2 = (x * x + y * y) / (R * R);
        if (r2 > 1) continue;
        const nz = Math.sqrt(1 - r2);
        cells.push({ x: cx + i * cell, y: cy + j * cell, n: [x / R, -y / R, nz], d: Math.hypot(i + 0.5 + 3, j + 0.5 + 4) });
      }
  };
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();

  let step = 0;
  let t0 = performance.now();
  let raf = 0;
  const pick = () => cells.reduce((a, c) => (Math.hypot(c.n[0] - 0.3, c.n[1] - 0.22) < Math.hypot(a.n[0] - 0.3, a.n[1] - 0.22) ? c : a), cells[0]);

  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    const tt = Math.max(0, (now - t0) / 1000); // rAF time can precede t0
    g.clearRect(0, 0, W, H);
    if (!cells.length) return;
    const a = step === 0 ? 2.3 : tt * 0.7 + 2.3;
    const Ld = normalize([Math.cos(a), 0.55, Math.sin(a) * 0.9 + 0.35]);
    const Hd = normalize([Ld[0], Ld[1], Ld[2] + 1]);
    const lightX = cx + Ld[0] * R * 1.75;
    const lightY = cy - Ld[1] * R * 1.45;
    const front = Ld[2] > -0.1;
    const sel = pick();

    // Light source glow (drawn behind the sphere when it is behind it).
    const drawLight = () => {
      const s = 10 + 6 * Math.max(0, Ld[2]);
      const grad = g.createRadialGradient(lightX, lightY, 0, lightX, lightY, s * 4);
      grad.addColorStop(0, 'rgba(255,240,200,1)');
      grad.addColorStop(0.25, 'rgba(255,181,71,0.65)');
      grad.addColorStop(1, 'rgba(255,181,71,0)');
      g.fillStyle = grad;
      g.beginPath();
      g.arc(lightX, lightY, s * 4, 0, Math.PI * 2);
      g.fill();
    };
    if (step >= 1 && !front) drawLight();

    // Rays painting fragments (step 2): a wave of rays sweeps over the cells, cell by cell.
    const paintT = step === 2 ? (tt % 5.5) / 4 : 2;
    cells.forEach((c) => {
      let col: V3 | null = null;
      if (step === 1 || step >= 3 || (step === 2 && c.d / (R / cell + 6) < paintT)) {
        const diff = Math.max(dot(c.n, Ld), 0);
        const spec = diff > 0 ? Math.pow(Math.max(dot(c.n, Hd), 0), SHININESS) : 0;
        col = [0, 1, 2].map((k) => Math.min(1, BASE_COLOR[k] * (AMBIENT + diff) + spec * 0.8)) as V3;
      }
      g.fillStyle = col ? rgb(col) : 'rgba(110,130,220,0.16)';
      g.fillRect(c.x + 1, c.y + 1, cell - 2, cell - 2);
      if (step === 0 && !col) {
        // Tiny normal "hedgehog".
        g.strokeStyle = 'rgba(255,63,210,0.45)';
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(c.x + cell / 2, c.y + cell / 2);
        g.lineTo(c.x + cell / 2 + c.n[0] * cell * 0.9, c.y + cell / 2 - c.n[1] * cell * 0.9);
        g.stroke();
      }
    });
    if (step === 2) {
      // Rays from the light to the cells on the painting front.
      g.save();
      g.globalCompositeOperation = 'lighter';
      const front2 = cells.filter((c) => Math.abs(c.d / (R / cell + 6) - paintT) < 0.03);
      front2.slice(0, 40).forEach((c) => {
        const grad = g.createLinearGradient(lightX, lightY, c.x + cell / 2, c.y + cell / 2);
        grad.addColorStop(0, 'rgba(255,220,150,0.5)');
        grad.addColorStop(1, 'rgba(255,181,71,0.05)');
        g.strokeStyle = grad;
        g.lineWidth = 1.5;
        g.beginPath();
        g.moveTo(lightX, lightY);
        g.lineTo(c.x + cell / 2, c.y + cell / 2);
        g.stroke();
      });
      g.restore();
    }
    if (step >= 1 && front) drawLight();

    // The followed fragment and its vectors.
    if (step <= 1) {
      const px = sel.x + cell / 2;
      const py = sel.y + cell / 2;
      g.save();
      g.strokeStyle = '#fff';
      g.shadowColor = '#fff';
      g.shadowBlur = 12;
      g.lineWidth = 2;
      g.strokeRect(sel.x - 1, sel.y - 1, cell + 2, cell + 2);
      g.restore();
      const len = R * 0.75;
      arrow(g, px, py, sel.n[0] * len, -sel.n[1] * len, '#ff3fd2', 'N');
      if (step === 1) {
        arrow(g, px, py, Ld[0] * len, -Ld[1] * len, '#ffb547', 'L');
        arrow(g, px, py, Hd[0] * len, -Hd[1] * len, '#38e1ff', 'H');
        const nl = Math.max(dot(sel.n, Ld), 0);
        const sp = nl > 0 ? Math.pow(Math.max(dot(sel.n, Hd), 0), SHININESS) : 0;
        const tx = Math.min(W - 170, cx + R + 30);
        g.save();
        g.fillStyle = 'rgba(5,6,13,0.8)';
        g.strokeStyle = 'rgba(140,160,255,0.3)';
        g.fillRect(tx, cy - 48, 150, 82);
        g.strokeRect(tx + 0.5, cy - 47.5, 150, 82);
        g.font = '600 12px "JetBrains Mono", monospace';
        g.fillStyle = '#ffb547';
        g.fillText(`N·L  = ${nl.toFixed(3)}`, tx + 10, cy - 28);
        g.fillStyle = '#38e1ff';
        g.fillText(`spec = ${sp.toFixed(3)}`, tx + 10, cy - 8);
        const col = [0, 1, 2].map((k) => Math.min(1, BASE_COLOR[k] * (AMBIENT + nl) + sp * 0.8));
        g.fillStyle = rgb(col);
        g.fillRect(tx + 10, cy + 6, 130, 18);
        g.restore();
      }
    }
    if (step === 3) {
      g.save();
      g.font = '600 12px "JetBrains Mono", monospace';
      g.fillStyle = 'rgba(232,235,255,0.75)';
      g.textAlign = 'center';
      g.fillText(`${cells.length} ${t(L('fragment · samma program · parallellt', 'fragments · same program · in parallel'))}`, cx, cy + R + 22);
      g.restore();
    }
  };
  raf = requestAnimationFrame(frame);

  const captions = [
    L('Varje ruta är ett fragment med sin egen interpolerade normal <b style="color:var(--magenta)">N</b>.', 'Each square is a fragment with its own interpolated normal <b style="color:var(--magenta)">N</b>.'),
    L('Ljuset kretsar. Ljusstyrkan följer <b style="color:var(--amber)">N·L</b>; högdagern följer <b style="color:var(--cyan)">N·H</b> upphöjt till 48.', 'The light orbits. Brightness follows <b style="color:var(--amber)">N·L</b>; the highlight follows <b style="color:var(--cyan)">N·H</b> raised to 48.'),
    L('Shadern körs en gång per fragment och "målar" det med sin färg.', 'The shader runs once per fragment and "paints" it with its color.'),
    L('Alla fragment kör <b>samma program</b> samtidigt, i tusentals trådar på GPU:n.', 'All fragments run <b>the same program</b> at once, in thousands of GPU threads.'),
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
function apis(): Record<ApiId, ApiPanelSpec> {
  const ld = `normalize(0.5, 0.8, 0.6)`;
  const bc = `(${BASE_COLOR.join(', ')})`;
  const sh = SHININESS.toFixed(1);
  const am = AMBIENT.toFixed(2);
  const glsl = (vk: boolean) => `#version 460
layout(location = 0) in  vec3 vNormal;   // interpolated, world space
layout(location = 0) out vec4 outColor;  // → color attachment 0

layout(${vk ? 'set = 0, binding = 0' : 'binding = 0'}, std140) uniform Light {
    vec3 lightDir;    // ${ld}
    vec3 baseColor;   // ${bc}
};

void main() {
    vec3  n    = normalize(vNormal);
    float diff = max(dot(n, lightDir), 0.0);           // N·L
    vec3  h    = normalize(lightDir + vec3(0, 0, 1));  // V = +Z
    float spec = diff > 0.0 ? pow(max(dot(n, h), 0.0), ${sh}) : 0.0;
    vec3  c    = baseColor * (${am} + diff) + spec * 0.8;
    outColor   = vec4(min(c, vec3(1.0)), 1.0);
}`;
  const hlsl = `cbuffer Light : register(b0) {
    float3 lightDir;    // ${ld}
    float3 baseColor;   // ${bc}
};
struct PSIn {
    float4 pos    : SV_Position;  // pixel center (x+0.5, y+0.5)
    float3 normal : NORMAL;       // interpolated, world space
};

float4 main(PSIn i) : SV_Target {  // → render target 0
    float3 n    = normalize(i.normal);
    float  diff = max(dot(n, lightDir), 0.0);           // N·L
    float3 h    = normalize(lightDir + float3(0, 0, 1)); // V = +Z
    float  spec = diff > 0 ? pow(max(dot(n, h), 0.0), ${sh}) : 0.0;
    float3 c    = baseColor * (${am} + diff) + spec * 0.8;
    return float4(min(c, 1.0), 1.0);
}`;
  const glHl = [[2, 11], [5, 6, 7, 12, 13, 14], [3, 15, 16], [10]];
  const hlHl = [[6, 7, 11], [1, 2, 3, 12, 13, 14], [10, 15, 16], [10]];
  return {
    opengl: {
      note: L(
        'Fragment shadern körs en gång per fragment. Den läser interpolerade varyings och uniforms och skriver en färg till varje utgång (location = färg-attachment).',
        'The fragment shader runs once per fragment. It reads interpolated varyings and uniforms and writes a color to each output (location = color attachment).',
      ),
      code: [
        { lang: 'glsl', title: L('Fragment shader', 'Fragment shader'), src: glsl(false), highlight: glHl },
        {
          lang: 'cpp',
          title: L('Koppla in', 'Hook up'),
          src: `GLuint fs = glCreateShader(GL_FRAGMENT_SHADER);
glShaderSource(fs, 1, &src, nullptr);
glCompileShader(fs);
glAttachShader(program, fs);
glLinkProgram(program);
glBindBufferBase(GL_UNIFORM_BUFFER, 0, lightUbo);  // binding = 0
glUseProgram(program);`,
          highlight: [[1, 2, 3], [6], [4, 5], [7]],
        },
      ],
      terms: [
        { term: 'varying / in', desc: L('Värde från vertex shadern, interpolerat perspektivkorrekt per fragment.', 'Value from the vertex shader, interpolated perspective-correctly per fragment.') },
        { term: 'gl_FragCoord', desc: L('Fragmentets fönsterposition och djup; origo nere till vänster i OpenGL.', 'The fragment\'s window position and depth; origin bottom-left in OpenGL.') },
        { term: 'discard', desc: L('Avbryter fragmentet så att inget skrivs (t.ex. alpha-test).', 'Kills the fragment so nothing is written (e.g. alpha test).') },
      ],
      you: L('skriver shadern', 'write the shader'),
      driver: L('kompilerar GLSL åt GPU:n', 'compiles the GLSL for the GPU'),
    },
    vulkan: {
      note: L(
        'Samma GLSL, men kompilerad i förväg till SPIR-V (glslc / glslangValidator). Resurser adresseras med set och binding från descriptor set layouten.',
        'Same GLSL, but compiled ahead of time to SPIR-V (glslc / glslangValidator). Resources are addressed by set and binding from the descriptor set layout.',
      ),
      code: [
        { lang: 'glsl', title: L('Fragment shader', 'Fragment shader'), src: glsl(true), highlight: glHl },
        {
          lang: 'cpp',
          title: L('Koppla in', 'Hook up'),
          src: `// glslc -fshader-stage=frag light.frag -o light.frag.spv
VkPipelineShaderStageCreateInfo fsStage{
    VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO};
fsStage.stage  = VK_SHADER_STAGE_FRAGMENT_BIT;
fsStage.module = fragModule;   // vkCreateShaderModule(SPIR-V)
fsStage.pName  = "main";
// location 0 → VkPipelineRenderingCreateInfo::pColorAttachmentFormats[0]`,
          highlight: [[1, 5], [4], [7], [2, 3, 6]],
        },
      ],
      terms: [
        { term: 'SPIR-V', desc: L('Binärt mellanformat som Vulkan-drivrutinen kompilerar vidare till GPU-kod.', 'Binary intermediate format that the Vulkan driver compiles further into GPU code.') },
        { term: 'set / binding', desc: L('Var en uniform buffer finns: descriptor set nr och plats i setet.', 'Where a uniform buffer lives: descriptor set number and slot in the set.') },
        { term: 'gl_FragCoord', desc: L('I Vulkan ligger origo uppe till vänster (OriginUpperLeft i SPIR-V).', 'In Vulkan the origin is top-left (OriginUpperLeft in SPIR-V).') },
      ],
      you: L('skriver och kompilerar shadern', 'write and compile the shader'),
      driver: L('SPIR-V → GPU-kod', 'SPIR-V → GPU code'),
    },
    d3d12: {
      note: L(
        'I D3D heter det pixel shader. HLSL kompileras med dxc till DXIL (ps_6_x), och SV_Target anger vilket render target färgen hamnar i.',
        'In D3D it is called the pixel shader. HLSL is compiled with dxc to DXIL (ps_6_x), and SV_Target says which render target the color goes to.',
      ),
      code: [
        { lang: 'hlsl', title: L('Pixel shader', 'Pixel shader'), src: hlsl, highlight: hlHl },
        {
          lang: 'cpp',
          title: L('Koppla in', 'Hook up'),
          src: `// dxc -T ps_6_6 -E main light.hlsl -Fo light.ps.cso
pso.PS = { psBlob->GetBufferPointer(), psBlob->GetBufferSize() };
pso.NumRenderTargets = 1;
pso.RTVFormats[0]    = DXGI_FORMAT_R8G8B8A8_UNORM;  // SV_Target0
// b0 = root CBV: cmd->SetGraphicsRootConstantBufferView(0, cbAddr);`,
          highlight: [[1, 2], [5], [3, 4], [2]],
        },
      ],
      terms: [
        { term: 'SV_Position', desc: L('Pixelcentrum i fönsterkoordinater (x+0.5, y+0.5), origo uppe till vänster.', 'Pixel center in window coordinates (x+0.5, y+0.5), origin top-left.') },
        { term: 'SV_Target', desc: L('Utdata till render target 0..7 (SV_Target0 … SV_Target7).', 'Output to render target 0..7 (SV_Target0 … SV_Target7).') },
        { term: 'DXIL', desc: L('D3D12:s shader-bytekod (LLVM-baserad), från dxc.', 'D3D12\'s shader bytecode (LLVM-based), from dxc.') },
      ],
      you: L('skriver och kompilerar shadern', 'write and compile the shader'),
      driver: L('DXIL → GPU-kod', 'DXIL → GPU code'),
    },
  };
}

export default standardSlide({
  id: 'fragment-shader',
  group: 'gpu-prog',
  short: L('Fragment shader', 'Fragment shader'),
  title: L('Fragment shader – en färg per fragment', 'Fragment shader – one color per fragment'),
  lead: L(
    'Fragment shadern (i D3D: <i>pixel shader</i>) är ditt program som körs för varje fragment. Den får interpolerade värden och räknar ut fragmentets färg – här med Blinn–Phong.',
    'The fragment shader (in D3D: <i>pixel shader</i>) is your program that runs for every fragment. It receives interpolated values and computes the fragment\'s color – here with Blinn–Phong.',
  ),
  bullets: [
    L(
      'Indata: pixelpositionen och de <b>interpolerade</b> varyings från vertex shadern – här världsnormalen. Den är inte längre exakt 1 lång och normaliseras om.',
      'Input: the pixel position and the <b>interpolated</b> varyings from the vertex shader – here the world normal. It is no longer exactly unit length, so it is normalized again.',
    ),
    L(
      '<b>Diffust</b> ljus = max(N·L, 0). <b>Spekulärt</b> (Blinn–Phong) = (N·H)<sup>48</sup>, där H ligger mitt emellan ljus och betraktare. Plus lite <b>ambient</b>.',
      '<b>Diffuse</b> light = max(N·L, 0). <b>Specular</b> (Blinn–Phong) = (N·H)<sup>48</sup>, where H is halfway between light and viewer. Plus a little <b>ambient</b>.',
    ),
    L(
      'Färg = bas · (ambient + diffust) + spekulärt · 0.8, klampad till [0, 1]. Den skrivs till utgång 0 och lagras som 8 bitar per kanal.',
      'Color = base · (ambient + diffuse) + specular · 0.8, clamped to [0, 1]. It is written to output 0 and stored as 8 bits per channel.',
    ),
    L(
      'Samma program körs för <b>alla</b> fragment, massivt parallellt. Fragment som djuptestet ändå skulle kasta kan sorteras bort före shadern (<i>early-Z</i>).',
      'The same program runs for <b>every</b> fragment, massively in parallel. Fragments the depth test would discard anyway can be culled before the shader (<i>early-Z</i>).',
    ),
  ],
  api: apis,
  data: dataVisual,
  concept: conceptVisual,
});
