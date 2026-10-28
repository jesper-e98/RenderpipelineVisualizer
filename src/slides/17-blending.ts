import gsap from 'gsap';
import { dur, h } from '../core/dom';
import { L } from '../core/i18n';
import type { ApiId } from '../core/state';
import { PixelCanvas, animateProgress } from '../views/PixelCanvas';
import { standardSlide } from './standard';
import type { ApiPanelSpec, SlideContext, Visual } from './types';
import '../styles/slides/blending.css';

type C3 = [number, number, number];
interface Glass {
  name: string;
  rgb: C3;
  a: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  css: string;
}

const f3 = (v: number) => v.toFixed(3);
const css = (c: readonly number[]) => `rgb(${c.map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255)).join(',')})`;
const vec = (c: readonly number[]) => `(${c.map(f3).join(', ')})`;

/** Is (x, y) inside a rounded rectangle? */
function inGlass(g: Glass, x: number, y: number, dx = 0): boolean {
  const px = x + 0.5 - dx;
  const py = y + 0.5;
  if (px < g.x0 || px > g.x1 || py < g.y0 || py > g.y1) return false;
  const r = 2.5;
  const cx = Math.min(Math.max(px, g.x0 + r), g.x1 - r);
  const cy = Math.min(Math.max(py, g.y0 + r), g.y1 - r);
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

type Mode = 'over' | 'add';
const blendPx = (src: C3, a: number, dst: C3, mode: Mode): C3 =>
  [0, 1, 2].map((i) => Math.min(1, mode === 'over' ? src[i] * a + dst[i] * (1 - a) : src[i] * a + dst[i])) as C3;

/* ------------------------------------------------------------------ */
/* Real data                                                           */
/* ------------------------------------------------------------------ */
function dataVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const api = ctx.state.api;
  const W = 160;
  const H = 100;
  const r = ctx.derived.render(api, W, H);
  const base = r.color;
  // Model bounding box from the depth buffer.
  let bx0 = W;
  let by0 = H;
  let bx1 = 0;
  let by1 = 0;
  for (let p = 0; p < W * H; p++) {
    if (r.depth[p] >= 1) continue;
    const x = p % W;
    const y = Math.floor(p / W);
    bx0 = Math.min(bx0, x);
    by0 = Math.min(by0, y);
    bx1 = Math.max(bx1, x + 1);
    by1 = Math.max(by1, y + 1);
  }
  if (bx1 <= bx0) [bx0, by0, bx1, by1] = [50, 25, 110, 75];
  const bw = bx1 - bx0;
  const bh = by1 - by0;
  const A: Glass = { name: 'A', rgb: [0.22, 0.88, 1.0], a: 0.45, x0: bx0 + 0.42 * bw, y0: by0 - 0.12 * bh, x1: bx1 + 0.18 * bw, y1: by0 + 0.72 * bh, css: '#38e1ff' };
  const B: Glass = { name: 'B', rgb: [1.0, 0.25, 0.82], a: 0.5, x0: bx0 - 0.18 * bw, y0: by0 + 0.3 * bh, x1: bx0 + 0.66 * bw, y1: by1 + 0.12 * bh, css: '#ff3fd2' };
  const dstAt = (p: number): C3 => [base[p * 4] / 255, base[p * 4 + 1] / 255, base[p * 4 + 2] / 255];

  /** Composite a list of glass panes, in order, over the rendered image. */
  const composite = (panes: Glass[], mode: Mode, dx = 0) => {
    const out = new Uint8ClampedArray(base);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const p = y * W + x;
        let c = dstAt(p);
        let hit = false;
        for (const g of panes) {
          if (!inGlass(g, x, y, g === A ? dx : -dx)) continue;
          c = blendPx(g.rgb, g.a, c, mode);
          hit = true;
        }
        if (!hit) continue;
        out[p * 4] = Math.round(c[0] * 255);
        out[p * 4 + 1] = Math.round(c[1] * 255);
        out[p * 4 + 2] = Math.round(c[2] * 255);
      }
    return out;
  };
  // Pixels to follow: on the model under A, and on the model under A ∩ B.
  const nearestModel = (tx: number, ty: number, need: Glass[]) => {
    let best = -1;
    let bd = Infinity;
    for (let p = 0; p < W * H; p++) {
      if (r.depth[p] >= 1) continue;
      const x = p % W;
      const y = Math.floor(p / W);
      if (!need.every((g) => inGlass(g, x, y))) continue;
      const d = (x - tx) ** 2 + (y - ty) ** 2;
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best >= 0 ? best : Math.floor(ty) * W + Math.floor(tx);
  };
  const probeA = nearestModel(bx0 + 0.72 * bw, by0 + 0.45 * bh, [A]);
  const probeAB = nearestModel((Math.max(A.x0, B.x0) + Math.min(A.x1, B.x1)) / 2, (Math.max(A.y0, B.y0) + Math.min(A.y1, B.y1)) / 2, [A, B]);

  // Step-2/3 crop: region covering the model and both panes.
  const cx0 = Math.max(0, Math.floor(Math.min(B.x0, bx0) - 2));
  const cy0 = Math.max(0, Math.floor(Math.min(A.y0, by0) - 2));
  const cx1 = Math.min(W, Math.ceil(Math.max(A.x1, bx1) + 2));
  const cy1 = Math.min(H, Math.ceil(Math.max(B.y1, by1) + 2));
  const CW = cx1 - cx0;
  const CH = cy1 - cy0;
  const GAP = Math.max(3, Math.round(CW * 0.06));
  const LBL = Math.max(3, Math.round(CH * 0.13));

  const imgAB = composite([A, B], 'over');
  const imgBA = composite([B, A], 'over');
  const imgAdd = composite([A, B], 'add');
  const imgAddBA = composite([B, A], 'add');

  const canvasHost = h('div.bl-canvas');
  const side = h('div.bl-side');
  const root = h('div.bl-root', {}, [canvasHost, side]);
  host.append(root);
  const pc = new PixelCanvas(canvasHost, W, H, 12);
  let step = 0;
  let slide = 0; // 0..1: pane A sliding in
  let hover: number | null = null;
  let cancel: (() => void) | null = null;

  const blitCrop = (img: Uint8ClampedArray, atX: number, atY: number) => {
    const tmp = document.createElement('canvas');
    tmp.width = W;
    tmp.height = H;
    tmp.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img), W, H), 0, 0);
    const [x, y] = pc.px(atX, atY);
    pc.ctx.save();
    pc.ctx.imageSmoothingEnabled = false;
    pc.ctx.drawImage(tmp, cx0, cy0, CW, CH, x, y, CW * pc.cell, CH * pc.cell);
    pc.ctx.restore();
  };
  const rim = (g: Glass, ox: number, oy: number, dx = 0) => {
    const [x0, y0] = pc.px(g.x0 + ox + dx, g.y0 + oy);
    const [x1, y1] = pc.px(g.x1 + ox + dx, g.y1 + oy);
    const c = pc.ctx;
    c.save();
    c.strokeStyle = g.css;
    c.shadowColor = g.css;
    c.shadowBlur = 12;
    c.lineWidth = 1.5;
    c.beginPath();
    c.roundRect(x0, y0, x1 - x0, y1 - y0, 2.5 * pc.cell);
    c.stroke();
    c.restore();
  };
  const mark = (p: number, ox: number, oy: number) => {
    const [x, y] = pc.px((p % W) + ox, Math.floor(p / W) + oy);
    const c = pc.ctx;
    c.save();
    c.strokeStyle = '#fff';
    c.shadowColor = '#fff';
    c.shadowBlur = 10;
    c.lineWidth = 2;
    c.strokeRect(x - 2, y - 2, pc.cell + 4, pc.cell + 4);
    c.restore();
  };

  const draw = () => {
    pc.clear();
    pc.grid(0.04);
    if (step <= 1) {
      const dx = step === 0 ? 0 : (1 - slide) * (W - A.x0 + 4);
      pc.image(step === 0 ? base : composite([A], 'over', dx));
      if (step === 1) rim(A, 0, 0, dx);
      mark(hover ?? probeA, 0, 0);
    } else {
      const pair = step === 2 ? [imgAB, imgBA] : [imgAdd, imgAddBA];
      const names = step === 2 ? [t(L('först A, sedan B', 'A first, then B')), t(L('först B, sedan A', 'B first, then A'))] : [t(L('additiv: A, sedan B', 'additive: A, then B')), t(L('additiv: B, sedan A', 'additive: B, then A'))];
      pair.forEach((img, i) => {
        const ox = i * (CW + GAP);
        blitCrop(img, ox, LBL);
        const order = i === 0 ? [A, B] : [B, A];
        order.forEach((g) => rim(g, ox - cx0, LBL - cy0));
        pc.text(names[i], ox + CW / 2, LBL / 2, '#e8ebff', 12, 'center');
        mark(hover ?? probeAB, ox - cx0, LBL - cy0);
      });
    }
  };
  pc.onResize(draw);

  const sw = (c: readonly number[], label: string, a?: number) =>
    `<div class="bl-sw"><i style="background:${css(c)}${a !== undefined ? `;opacity:${0.35 + a * 0.65}` : ''}"></i><span>${label}</span><b>${vec(c)}${a !== undefined ? ` α=${a}` : ''}</b></div>`;
  const row = (k: string, v: string, cls = '') => `<div class="bl-row"><span>${k}</span><b class="${cls}">${v}</b></div>`;

  const updateSide = () => {
    const p = hover ?? (step <= 1 ? probeA : probeAB);
    const px = p % W;
    const py = Math.floor(p / W);
    const dst = dstAt(p);
    const head = `<div class="bl-px">pixel (${px}, ${py})${r.depth[p] < 1 ? '' : ` · ${t(L('bakgrund', 'background'))}`}</div>`;
    if (step === 0) {
      side.innerHTML = `<h4>${t(L('Ogenomskinligt pass', 'Opaque pass'))}</h4>${head}
        ${sw(dst, 'dst')}
        <div class="bl-eq">blend = off → <b>out = src</b></div>
        <p class="bl-note">${t(L('Fragmentets färg ersätter det som låg i render targeten. Ingen läsning av dst behövs – snabbast.', 'The fragment\'s color replaces what was in the render target. No read of dst is needed – fastest.'))}</p>`;
    } else if (step === 1) {
      const inside = inGlass(A, px, py);
      const out = inside ? blendPx(A.rgb, A.a, dst, 'over') : dst;
      side.innerHTML = `<h4>${t(L('Alfablandning', 'Alpha blending'))}</h4>${head}
        ${sw(A.rgb, 'src', A.a)}
        ${sw(dst, 'dst')}
        <div class="bl-eq">out = src·α + dst·(1 − α)</div>
        ${inside ? [0, 1, 2].map((i) => `<div class="bl-ch"><span>${'RGB'[i]}</span>${f3(A.rgb[i])}·${A.a} + ${f3(dst[i])}·${(1 - A.a).toFixed(2)} = <b>${f3(out[i])}</b></div>`).join('') : `<p class="bl-note">${t(L('Pixeln ligger utanför glaset – dst lämnas orörd.', 'The pixel is outside the glass – dst is left untouched.'))}</p>`}
        ${sw(out, 'out')}
        ${row(t(L('lagras (RGBA8)', 'stored (RGBA8)')), out.map((c) => Math.round(c * 255)).join(', '), 'glow-cyan')}`;
    } else {
      const mode: Mode = step === 2 ? 'over' : 'add';
      const apply = (order: Glass[]) => order.reduce<C3>((c, g) => (inGlass(g, px, py) ? blendPx(g.rgb, g.a, c, mode) : c), dst);
      const ab = apply([A, B]);
      const ba = apply([B, A]);
      const same = ab.every((v, i) => Math.round(v * 255) === Math.round(ba[i] * 255));
      side.innerHTML = `<h4>${step === 2 ? t(L('Ordningen spelar roll', 'Order matters')) : t(L('Additiv blandning', 'Additive blending'))}</h4>${head}
        <div class="bl-eq">${step === 2 ? 'out = src·α + dst·(1 − α)' : 'out = src·α + dst'}</div>
        ${sw(A.rgb, 'A', A.a)}${sw(B.rgb, 'B', B.a)}${sw(dst, 'dst')}
        ${sw(ab, t(L('A→B', 'A→B')))}
        ${sw(ba, t(L('B→A', 'B→A')))}
        <div class="bl-verdict ${same ? 'ok' : 'bad'}">${same ? t(L('samma resultat – ordningsoberoende', 'same result – order independent')) : t(L('olika resultat – sortera bakifrån och fram!', 'different results – sort back to front!'))}</div>
        <p class="bl-note">${step === 2 ? t(L('Rita ogenomskinligt först, sedan genomskinligt sorterat bakifrån och fram med depth write av.', 'Draw opaque first, then transparent sorted back to front with depth write off.')) : t(L('(SRC_ALPHA, ONE) adderar ljus – bra för partiklar och glöd. Summan klampas till 1 i ett UNORM-mål.', '(SRC_ALPHA, ONE) adds light – good for particles and glow. The sum is clamped to 1 in a UNORM target.'))}</p>`;
    }
  };

  pc.canvas.addEventListener('mousemove', (e) => {
    const b = pc.canvas.getBoundingClientRect();
    let cx = (e.clientX - b.left - pc.ox) / pc.cell;
    let cy = (e.clientY - b.top - pc.oy) / pc.cell;
    if (step >= 2) {
      cy -= LBL;
      if (cx >= CW + GAP) cx -= CW + GAP;
      if (cx < 0 || cx >= CW || cy < 0 || cy >= CH) return;
      cx += cx0;
      cy += cy0;
    }
    const x = Math.floor(cx);
    const y = Math.floor(cy);
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const np = y * W + x;
    if (np === hover) return;
    hover = np;
    draw();
    updateSide();
  });
  pc.canvas.addEventListener('mouseleave', () => {
    hover = null;
    draw();
    updateSide();
  });

  return {
    show(s, animate) {
      cancel?.();
      cancel = null;
      step = s;
      hover = null;
      slide = 1;
      const cols = s >= 2 ? CW * 2 + GAP : W;
      const rows = s >= 2 ? CH + LBL : H;
      if (pc.cols !== cols || pc.rows !== rows) {
        pc.cols = cols;
        pc.rows = rows;
        pc.resize();
      }
      if (animate && s === 1) {
        slide = 0;
        cancel = animateProgress(dur(1.1), (p) => {
          slide = 1 - Math.pow(1 - p, 3);
          draw();
        });
      }
      draw();
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
/* Concept: colored glass sliding over a scene                         */
/* ------------------------------------------------------------------ */
function conceptVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const scene = h('div.blc-scene');
  const object = h('div.blc-object');
  const panes = [
    { el: h('div.blc-pane.cyan', {}, [h('span', { text: 'A · α 0.5' })]), rgb: [56, 225, 255] },
    { el: h('div.blc-pane.magenta', {}, [h('span', { text: 'B · α 0.5' })]), rgb: [255, 63, 210] },
  ];
  const opaque = h('div.blc-pane.opaque', {}, [h('span', { text: 'α 1.0' })]);
  const readout = h('div.blc-readout');
  const caption = h('div.bl-caption');
  scene.append(object, opaque, ...panes.map((p) => p.el), readout);
  host.append(scene, caption);
  let tl: gsap.core.Timeline | null = null;

  const objRgb = [255, 140, 64];
  const over = (src: number[], a: number, dst: number[]) => src.map((s, i) => Math.round(s * a + dst[i] * (1 - a)));
  const add = (src: number[], a: number, dst: number[]) => src.map((s, i) => Math.min(255, Math.round(s * a + dst[i])));
  const chip = (c: number[], label: string) => `<div><i style="background:rgb(${c.join(',')})"></i>${label} <b>(${c.join(', ')})</b></div>`;

  const captions = [
    L('Ogenomskinligt (α = 1): det nya fragmentet ersätter helt det som låg under.', 'Opaque (α = 1): the new fragment completely replaces what was underneath.'),
    L('Genomskinligt glas: <code>src·α + dst·(1−α)</code> – lite av båda.', 'Transparent glass: <code>src·α + dst·(1−α)</code> – a bit of both.'),
    L('Byt ordning på glasen – överlappet får en annan färg. Därför sorteras genomskinligt bakifrån och fram.', 'Swap the order of the panes – the overlap changes color. That is why transparency is sorted back to front.'),
    L('Additivt (<code>src·α + dst</code>): ljuset summeras och blir ljusare – och ordningen spelar ingen roll.', 'Additive (<code>src·α + dst</code>): light adds up and gets brighter – and order does not matter.'),
  ];

  const layout = (step: number, animate: boolean) => {
    tl?.kill();
    tl = gsap.timeline();
    const d = (s: number) => (animate ? dur(s) : 0);
    scene.dataset.step = String(step);
    gsap.set([opaque, ...panes.map((p) => p.el)], { clearProps: 'zIndex' });
    tl.to(opaque, { xPercent: step === 0 ? 0 : 140, opacity: step === 0 ? 1 : 0, duration: d(0.7), ease: 'power3.inOut' }, 0);
    tl.to(panes[0].el, { xPercent: step >= 1 ? 0 : 160, opacity: step >= 1 ? 1 : 0, duration: d(0.8), ease: 'power3.out' }, 0);
    tl.to(panes[1].el, { xPercent: step >= 2 ? 0 : -160, opacity: step >= 2 ? 1 : 0, duration: d(0.8), ease: 'power3.out' }, 0.1);
    panes.forEach((p) => (p.el.style.mixBlendMode = step === 3 ? 'plus-lighter' : 'normal'));
    const bg = [12, 16, 40];
    if (step === 0) readout.innerHTML = chip(objRgb, 'dst') + chip([155, 123, 255], 'src α=1') + chip([155, 123, 255], 'out');
    else if (step === 1) readout.innerHTML = chip(objRgb, 'dst') + chip(panes[0].rgb, 'src α=0.5') + chip(over(panes[0].rgb, 0.5, objRgb), 'out');
    else if (step === 2) {
      const ab = over(panes[1].rgb, 0.5, over(panes[0].rgb, 0.5, objRgb));
      const ba = over(panes[0].rgb, 0.5, over(panes[1].rgb, 0.5, objRgb));
      readout.innerHTML = chip(ab, 'A → B') + chip(ba, 'B → A');
      // Keep swapping which pane is on top.
      const swap = gsap.timeline({ repeat: -1, delay: d(0.9) });
      swap.call(() => {
        panes[0].el.style.zIndex = '3';
        panes[1].el.style.zIndex = '4';
        readout.dataset.on = '0';
      });
      swap.to({}, { duration: 2.2 });
      swap.call(() => {
        panes[0].el.style.zIndex = '4';
        panes[1].el.style.zIndex = '3';
        readout.dataset.on = '1';
      });
      swap.to({}, { duration: 2.2 });
      tl.add(swap, 0);
    } else {
      const both = add(panes[1].rgb, 0.5, add(panes[0].rgb, 0.5, objRgb));
      readout.innerHTML = chip(both, 'A+B') + chip(add(panes[0].rgb, 0.5, bg), t(L('A på bakgrund', 'A on background')));
    }
    caption.innerHTML = t(captions[step]);
    if (animate) caption.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: dur(0.4) * 1000, easing: 'ease-out' });
  };

  return {
    show: layout,
    destroy() {
      tl?.kill();
    },
  };
}

/* ------------------------------------------------------------------ */
/* API panels                                                          */
/* ------------------------------------------------------------------ */
function apis(): Record<ApiId, ApiPanelSpec> {
  const gl = `// 1. opaque pass: no blending, depth writes on
glDisable(GL_BLEND);
glDepthMask(GL_TRUE);
drawOpaque();

// 2. transparent pass: blend, keep depth test, no depth writes
glEnable(GL_BLEND);
glBlendEquation(GL_FUNC_ADD);
glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);  // src·α + dst·(1−α)
glDepthMask(GL_FALSE);
drawTransparentSortedBackToFront();

// additive glow / particles
glBlendFunc(GL_SRC_ALPHA, GL_ONE);                  // src·α + dst`;
  const vk = `VkPipelineColorBlendAttachmentState blend{};  // opaque: blendEnable = VK_FALSE
blend.blendEnable         = VK_TRUE;
blend.srcColorBlendFactor = VK_BLEND_FACTOR_SRC_ALPHA;
blend.dstColorBlendFactor = VK_BLEND_FACTOR_ONE_MINUS_SRC_ALPHA;
blend.colorBlendOp        = VK_BLEND_OP_ADD;
blend.srcAlphaBlendFactor = VK_BLEND_FACTOR_ONE;
blend.dstAlphaBlendFactor = VK_BLEND_FACTOR_ONE_MINUS_SRC_ALPHA;
blend.alphaBlendOp        = VK_BLEND_OP_ADD;
blend.colorWriteMask = VK_COLOR_COMPONENT_R_BIT | VK_COLOR_COMPONENT_G_BIT |
                       VK_COLOR_COMPONENT_B_BIT | VK_COLOR_COMPONENT_A_BIT;

VkPipelineColorBlendStateCreateInfo cb{
    VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO};
cb.attachmentCount = 1;          // one entry per color attachment
cb.pAttachments    = &blend;
ds.depthWriteEnable = VK_FALSE;  // transparent pipeline
// additive: dstColorBlendFactor = VK_BLEND_FACTOR_ONE`;
  const dx = `D3D12_RENDER_TARGET_BLEND_DESC rt{};   // opaque: BlendEnable = FALSE
rt.BlendEnable    = TRUE;
rt.SrcBlend       = D3D12_BLEND_SRC_ALPHA;
rt.DestBlend      = D3D12_BLEND_INV_SRC_ALPHA;
rt.BlendOp        = D3D12_BLEND_OP_ADD;
rt.SrcBlendAlpha  = D3D12_BLEND_ONE;
rt.DestBlendAlpha = D3D12_BLEND_INV_SRC_ALPHA;
rt.BlendOpAlpha   = D3D12_BLEND_OP_ADD;
rt.LogicOp        = D3D12_LOGIC_OP_NOOP;
rt.RenderTargetWriteMask = D3D12_COLOR_WRITE_ENABLE_ALL;

pso.BlendState.AlphaToCoverageEnable  = FALSE;
pso.BlendState.IndependentBlendEnable = FALSE;  // RenderTarget[0] for all
pso.BlendState.RenderTarget[0]        = rt;
pso.DepthStencilState.DepthWriteMask  = D3D12_DEPTH_WRITE_MASK_ZERO;
// additive: rt.DestBlend = D3D12_BLEND_ONE`;
  return {
    opengl: {
      note: L(
        'Blandningen sker i output merger efter djuptestet: GPU:n läser pixeln som redan finns (dst), kombinerar med fragmentet (src) och skriver tillbaka. I OpenGL är det globalt tillstånd.',
        'Blending happens in the output merger after the depth test: the GPU reads the pixel already there (dst), combines it with the fragment (src) and writes it back. In OpenGL it is global state.',
      ),
      code: [{ lang: 'cpp', src: gl, highlight: [[1, 2, 3, 4], [6, 7, 8, 9], [10, 11], [13, 14]] }],
      terms: [
        { term: 'src / dst', desc: L('src = fragmentets färg från shadern, dst = det som redan ligger i render targeten.', 'src = the fragment color from the shader, dst = what is already in the render target.') },
        { term: 'GL_ONE_MINUS_SRC_ALPHA', desc: L('Faktorn (1 − α) för dst.', 'The factor (1 − α) applied to dst.') },
        { term: 'glBlendFunci', desc: L('Olika blandning per färg-attachment (GL 4.0+).', 'Different blending per color attachment (GL 4.0+).') },
        { term: 'premultiplied alpha', desc: L('Färgen redan multiplicerad med α: (ONE, ONE_MINUS_SRC_ALPHA) – filtrerar korrekt.', 'Color already multiplied by α: (ONE, ONE_MINUS_SRC_ALPHA) – filters correctly.') },
      ],
      you: L('väljer faktorer och ritordning', 'choose factors and draw order'),
      driver: L('ROP-enheten läser och skriver dst', 'the ROP unit reads and writes dst'),
    },
    vulkan: {
      note: L(
        'I Vulkan bakas blandningen in i pipelinen, en VkPipelineColorBlendAttachmentState per färg-attachment. Ogenomskinligt och genomskinligt blir två pipelines.',
        'In Vulkan blending is baked into the pipeline, one VkPipelineColorBlendAttachmentState per color attachment. Opaque and transparent become two pipelines.',
      ),
      code: [{ lang: 'cpp', src: vk, highlight: [[1], [2, 3, 4, 5, 6, 7, 8, 9, 10], [16], [17]] }],
      terms: [
        { term: 'src / dst', desc: L('src = fragmentets färg, dst = befintligt värde i attachmenten.', 'src = fragment color, dst = existing value in the attachment.') },
        { term: 'colorWriteMask', desc: L('Vilka kanaler som skrivs alls.', 'Which channels get written at all.') },
        { term: 'blendConstants', desc: L('Konstant färg för VK_BLEND_FACTOR_CONSTANT_COLOR (kan vara dynamisk).', 'Constant color for VK_BLEND_FACTOR_CONSTANT_COLOR (can be dynamic).') },
      ],
      you: L('väljer faktorer och ritordning', 'choose factors and draw order'),
      driver: L('ROP-enheten läser och skriver dst', 'the ROP unit reads and writes dst'),
    },
    d3d12: {
      note: L(
        'I D3D12 heter steget <i>Output Merger</i>. Blandningen ligger i PSO:ns D3D12_BLEND_DESC med en D3D12_RENDER_TARGET_BLEND_DESC per render target (upp till 8).',
        'In D3D12 the stage is the <i>Output Merger</i>. Blending lives in the PSO\'s D3D12_BLEND_DESC with one D3D12_RENDER_TARGET_BLEND_DESC per render target (up to 8).',
      ),
      code: [{ lang: 'cpp', src: dx, highlight: [[1], [2, 3, 4, 5, 6, 7, 8, 10], [15], [16]] }],
      terms: [
        { term: 'D3D12_BLEND_INV_SRC_ALPHA', desc: L('Faktorn (1 − α).', 'The factor (1 − α).') },
        { term: 'IndependentBlendEnable', desc: L('TRUE = egen blandning per render target, annars gäller RenderTarget[0] för alla.', 'TRUE = separate blending per render target, otherwise RenderTarget[0] applies to all.') },
        { term: 'AlphaToCoverage', desc: L('α styr MSAA-täckningen istället – för t.ex. lövverk utan sortering.', 'α drives MSAA coverage instead – e.g. for foliage without sorting.') },
      ],
      you: L('väljer faktorer och ritordning', 'choose factors and draw order'),
      driver: L('ROP-enheten läser och skriver dst', 'the ROP unit reads and writes dst'),
    },
  };
}

export default standardSlide({
  id: 'blending',
  group: 'gpu-fixed',
  short: L('Blending', 'Blending'),
  title: L('Blending – output merger', 'Blending – output merger'),
  lead: L(
    'Sista steget innan pixeln skrivs: färgen från shadern (<b>src</b>) kombineras med det som redan ligger i render targeten (<b>dst</b>).',
    'The last step before the pixel is written: the color from the shader (<b>src</b>) is combined with what is already in the render target (<b>dst</b>).',
  ),
  bullets: [
    L(
      '<b>Ogenomskinliga</b> objekt använder ingen blending: fragmentet skriver bara över dst. Det är snabbast och ordningen löses av djuptestet.',
      '<b>Opaque</b> objects use no blending: the fragment simply overwrites dst. It is the fastest, and the depth test sorts out order.',
    ),
    L(
      '<b>Alfablandning</b>: out = src·α + dst·(1 − α). Hårdvaran läser dst, räknar per kanal och skriver tillbaka.',
      '<b>Alpha blending</b>: out = src·α + dst·(1 − α). The hardware reads dst, computes per channel and writes back.',
    ),
    L(
      'Ordningen spelar roll: A över B ≠ B över A. Genomskinligt ritas därför <b>sist, sorterat bakifrån och fram</b>, med djuptest på men depth write av.',
      'Order matters: A over B ≠ B over A. Transparency is therefore drawn <b>last, sorted back to front</b>, with depth test on but depth writes off.',
    ),
    L(
      '<b>Additiv</b> blending (src·α + dst) summerar ljus – bra för partiklar och glöd, och oberoende av ordning.',
      '<b>Additive</b> blending (src·α + dst) sums light – good for particles and glow, and independent of order.',
    ),
  ],
  api: apis,
  data: dataVisual,
  concept: conceptVisual,
});
