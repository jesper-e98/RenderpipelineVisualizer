import { AdditiveBlending, Color, DoubleSide, Group, Mesh, MeshBasicMaterial, NormalBlending, SRGBColorSpace, Shape, ShapeGeometry, Vector3 } from 'three';
import { SHOWCASE_ROT_X } from '../core/derived';
import { h } from '../core/dom';
import { L } from '../core/i18n';
import type { ApiId } from '../core/state';
import { DEFAULT_CAMERA } from '../pipeline/transform';
import { createModelStage, secs } from '../views/ModelStage';
import { PixelCanvas } from '../views/PixelCanvas';
import { COLORS, label } from '../views/three-helpers';
import { stat } from '../views/widgets';
import { glowDot, lineSet, projectionRig, viewRayPoint, type Rig } from './14-rasterization';
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
const NEAR = DEFAULT_CAMERA.near;
const FAR = DEFAULT_CAMERA.far;
const distOf = (d: number) => (FAR * NEAR) / (FAR - d * (FAR - NEAR));

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

/** A glass pane in 3D: the 2D rounded rect `g` (160×100 canvas units) placed on a plane in front of the camera. */
function glassPane(rig: Rig, g: Glass, W: number, H: number) {
  const group = new Group();
  rig.group.add(group);
  const a = rig.local(g.x0, g.y1, W, H);
  const b = rig.local(g.x1, g.y0, W, H);
  const r = (2.5 / W) * rig.w;
  const sh = new Shape();
  sh.moveTo(a.x + r, a.y);
  sh.lineTo(b.x - r, a.y);
  sh.quadraticCurveTo(b.x, a.y, b.x, a.y + r);
  sh.lineTo(b.x, b.y - r);
  sh.quadraticCurveTo(b.x, b.y, b.x - r, b.y);
  sh.lineTo(a.x + r, b.y);
  sh.quadraticCurveTo(a.x, b.y, a.x, b.y - r);
  sh.lineTo(a.x, a.y + r);
  sh.quadraticCurveTo(a.x, a.y, a.x + r, a.y);
  const color = new Color().setRGB(g.rgb[0], g.rgb[1], g.rgb[2], SRGBColorSpace);
  const mat = new MeshBasicMaterial({ color, transparent: true, opacity: g.a, depthWrite: false, side: DoubleSide, blending: NormalBlending });
  const mesh = new Mesh(new ShapeGeometry(sh, 6), mat);
  const pts = sh.getPoints(6).map((p) => new Vector3(p.x, p.y, 0.002));
  const rim = lineSet(group, pts.flatMap((p, i) => [p, pts[(i + 1) % pts.length]]), color.getHex(), 0.95);
  group.add(mesh);
  const lb = label(`${g.name} · α ${g.a}`, g.name === 'A' ? 'cyan' : 'magenta');
  lb.position.set(b.x - 0.12, b.y + 0.06, 0);
  group.add(lb);
  return { group, mesh, mat, rim, lb };
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
  const probeBg = (() => {
    // The darkest pixel under both panes: additive results stay below 1 (no clamping) there.
    let best = -1;
    let bd = Infinity;
    for (let p = 0; p < W * H; p++) {
      const x = p % W;
      const y = Math.floor(p / W);
      if (!inGlass(A, x, y) || !inGlass(B, x, y)) continue;
      const d = base[p * 4] + base[p * 4 + 1] + base[p * 4 + 2];
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best;
  })();
  const probeAB = nearestModel((Math.max(A.x0, B.x0) + Math.min(A.x1, B.x1)) / 2, (Math.max(A.y0, B.y0) + Math.min(A.y1, B.y1)) / 2, [A, B]);

  // 2D crop: region covering the model and both panes.
  const cx0 = Math.max(0, Math.floor(Math.min(B.x0, bx0) - 2));
  const cy0 = Math.max(0, Math.floor(Math.min(A.y0, by0) - 2));
  const cx1 = Math.min(W, Math.ceil(Math.max(A.x1, bx1) + 2));
  const cy1 = Math.min(H, Math.ceil(Math.max(B.y1, by1) + 2));
  const CW = cx1 - cx0;
  const CH = cy1 - cy0;
  const imgA = composite([A], 'over');
  const imgAB = composite([A, B], 'over');
  const imgBA = composite([B, A], 'over');
  const imgAdd = composite([A, B], 'add');
  const imgAddBA = composite([B, A], 'add');

  /* ---------- 3D ---------- */
  const ms = createModelStage(host, ctx, { autoRotate: 0, shift: -0.14, eye: [1.7, 1.25, 4.4], bloom: 0.4, bloomThreshold: 0.85 });
  // A sits closer to the camera than B; both in front of the model.
  const rigA = projectionRig(ms, 1.55, { frustum: false, back: 0 });
  const rigB = projectionRig(ms, 1.95, { frustum: false, back: 0 });
  [rigA, rigB].forEach((rg) => (rg.border.visible = rg.back.visible = false));
  const paneA = glassPane(rigA, A, W, H);
  const paneB = glassPane(rigB, B, W, H);
  // The probe pixel's view ray: through the panes to the model surface.
  const rayLine = lineSet(ms.scene, [], COLORS.white, 0.5);
  const dotA = glowDot(ms.scene, new Vector3(), COLORS.cyan, 0.13);
  const dotB = glowDot(ms.scene, new Vector3(), COLORS.magenta, 0.13);
  const dotD = glowDot(ms.scene, new Vector3(), COLORS.amber, 0.15);
  const lbA = label('src A', 'cyan');
  const lbB = label('src B', 'magenta');
  const lbD = label('dst', 'amber');
  lbA.position.set(0, 0.09, 0);
  lbB.position.set(0, 0.09, 0);
  lbD.position.set(0, 0.1, 0);
  dotA.add(lbA);
  dotB.add(lbB);
  dotD.add(lbD);
  const badge = label('', 'big');
  badge.position.set(0, 1.25, 0.4);
  ms.scene.add(badge);
  const placeProbe = (p: number) => {
    const x = (p % W) + 0.5;
    const y = Math.floor(p / W) + 0.5;
    const zd = r.depth[p] < 1 ? distOf(r.depth[p]) : 4.6;
    setRay(viewRayPoint(x, y, W, H, 0.9), viewRayPoint(x, y, W, H, zd));
    dotA.position.copy(viewRayPoint(x, y, W, H, rigA.dist));
    dotB.position.copy(viewRayPoint(x, y, W, H, rigB.dist));
    dotD.position.copy(viewRayPoint(x, y, W, H, zd));
    lbD.element.textContent = r.depth[p] < 1 ? 'dst' : t(L('dst (bakgrund)', 'dst (background)'));
  };
  const setRay = (a: Vector3, b: Vector3) => {
    const pos = rayLine.geometry.attributes.position;
    pos.setXYZ(0, a.x, a.y, a.z);
    pos.setXYZ(1, b.x, b.y, b.z);
    pos.needsUpdate = true;
    rayLine.geometry.setDrawRange(0, 2);
  };

  /* ---------- Panels ---------- */
  const numbers = ms.panel('', []);
  const numHead = numbers.querySelector('.ms-head span')!;
  const numBody = numbers.querySelector('.ms-body')!;
  const canvasHost = h('div.bl-zoom');
  ms.panel(t(L(`Render target · utsnitt ${CW}×${CH}`, `Render target · crop ${CW}×${CH}`)), [canvasHost]);
  const pc = new PixelCanvas(canvasHost, CW, CH, 6);
  let step = 0;
  let order = 0; // steps 2–3: 0 = A then B, 1 = B then A
  const slide = { p: 1 }; // step 1: pane A sliding in
  let hover: number | null = null;

  const currentImg = () => {
    if (step === 0) return base;
    if (step === 1) return slide.p >= 1 ? imgA : composite([A], 'over', (1 - slide.p) * (W - A.x0 + 4));
    if (step === 2) return order === 0 ? imgAB : imgBA;
    return order === 0 ? imgAdd : imgAddBA;
  };
  const probeNow = () => hover ?? (step <= 1 ? probeA : step === 3 && probeBg >= 0 ? probeBg : probeAB);
  const draw = () => {
    pc.clear();
    pc.grid(0.04);
    const img = currentImg();
    const tmp = document.createElement('canvas');
    tmp.width = W;
    tmp.height = H;
    tmp.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img), W, H), 0, 0);
    const [x, y] = pc.px(0, 0);
    pc.ctx.save();
    pc.ctx.imageSmoothingEnabled = false;
    pc.ctx.drawImage(tmp, cx0, cy0, CW, CH, x, y, CW * pc.cell, CH * pc.cell);
    pc.ctx.restore();
    const p = probeNow();
    const [mx, my] = pc.px((p % W) - cx0, Math.floor(p / W) - cy0);
    pc.ctx.save();
    pc.ctx.strokeStyle = '#fff';
    pc.ctx.shadowColor = '#fff';
    pc.ctx.shadowBlur = 10;
    pc.ctx.lineWidth = 2;
    pc.ctx.strokeRect(mx - 2, my - 2, pc.cell + 4, pc.cell + 4);
    pc.ctx.restore();
  };
  pc.onResize(draw);

  const sw = (c: readonly number[], lbl: string, a?: number) =>
    `<div class="bl-sw"><i style="background:${css(c)}${a !== undefined ? `;opacity:${0.35 + a * 0.65}` : ''}"></i><span>${lbl}${a !== undefined ? ` <em>α ${a}</em>` : ''}</span><b>${vec(c)}</b></div>`;
  const statRow = (items: [string, string, string?][]) => `<div class="stat-row">${items.map(([v, k, c]) => stat(v, k, c ?? '').outerHTML).join('')}</div>`;
  const titles = [L('Ogenomskinligt pass', 'Opaque pass'), L('Alfablandning', 'Alpha blending'), L('Ordningen spelar roll', 'Order matters'), L('Additiv blandning', 'Additive blending')];
  const updateSide = () => {
    const p = probeNow();
    const px = p % W;
    const py = Math.floor(p / W);
    const dst = dstAt(p);
    numHead.textContent = t(titles[step]);
    const head = `<div class="bl-px">pixel (${px}, ${py})${r.depth[p] < 1 ? '' : ` · ${t(L('bakgrund', 'background'))}`}</div>`;
    const out8 = (c: readonly number[]) => c.map((v) => Math.round(v * 255)).join(', ');
    let html = '';
    if (step === 0) {
      html = `${statRow([['off', t(L('blending', 'blending'))], [out8(dst), 'out = src (RGBA8)', 'glow-amber']])}${head}
        ${sw(dst, 'src → out')}
        <div class="bl-eq">blend = off → <b>out = src</b></div>
        <p class="bl-note">${t(L('Varje fragment skriver bara över det som låg i render targeten – modellen "målas" över bakgrunden. Ingen läsning av dst behövs, och djuptestet löser ordningen.', 'Each fragment simply overwrites what was in the render target – the model is "painted" over the background. No read of dst is needed, and the depth test sorts out order.'))}</p>`;
    } else if (step === 1) {
      const inside = inGlass(A, px, py);
      const out = inside ? blendPx(A.rgb, A.a, dst, 'over') : dst;
      html = `${statRow([[String(A.a), 'α (A)', 'glow-cyan'], [out8(out), t(L('lagras (RGBA8)', 'stored (RGBA8)')), 'glow-amber']])}${head}
        ${sw(A.rgb, 'src', A.a)}
        ${sw(dst, 'dst')}
        <div class="bl-eq">out = src·α + dst·(1 − α)</div>
        ${inside ? [0, 1, 2].map((i) => `<div class="bl-ch"><span>${'RGB'[i]}</span>${f3(A.rgb[i])}·${A.a} + ${f3(dst[i])}·${(1 - A.a).toFixed(2)} = <b>${f3(out[i])}</b></div>`).join('') : `<p class="bl-note">${t(L('Pixeln ligger utanför glaset – dst lämnas orörd.', 'The pixel is outside the glass – dst is left untouched.'))}</p>`}
        ${sw(out, 'out')}`;
    } else {
      const mode: Mode = step === 2 ? 'over' : 'add';
      const apply = (ord: Glass[]) => ord.reduce<C3>((c, g) => (inGlass(g, px, py) ? blendPx(g.rgb, g.a, c, mode) : c), dst);
      const ab = apply([A, B]);
      const ba = apply([B, A]);
      const same = ab.every((v, i) => Math.round(v * 255) === Math.round(ba[i] * 255));
      html = `${statRow([[order === 0 ? 'A → B' : 'B → A', t(L('ritordning nu', 'draw order now')), order === 0 ? 'glow-cyan' : 'glow-magenta'], [same ? '=' : '≠', 'A→B vs B→A', same ? 'c-idx' : 'dp-neg']])}${head}
        <div class="bl-eq">${step === 2 ? 'out = src·α + dst·(1 − α)' : 'out = src·α + dst'}</div>
        ${sw(A.rgb, 'A', A.a)}${sw(B.rgb, 'B', B.a)}${sw(dst, 'dst')}
        <div class="bl-pair ${order === 0 ? 'on0' : 'on1'}">${sw(ab, 'A→B')}${sw(ba, 'B→A')}</div>
        <div class="bl-verdict ${same ? 'ok' : 'bad'}">${same ? t(L('samma resultat – ordningsoberoende', 'same result – order independent')) : t(L('olika resultat – sortera bakifrån och fram!', 'different results – sort back to front!'))}</div>
        <p class="bl-note">${step === 2 ? t(L('B ligger längre bort – rätt ordning är B först, sedan A. Rita ogenomskinligt först, sedan genomskinligt sorterat bakifrån och fram, med depth write av.', 'B is farther away – the right order is B first, then A. Draw opaque first, then transparent sorted back to front, with depth writes off.')) : t(L('(SRC_ALPHA, ONE) adderar ljus – bra för partiklar och glöd. Summan klampas till 1 i ett UNORM-mål.', '(SRC_ALPHA, ONE) adds light – good for particles and glow. The sum is clamped to 1 in a UNORM target.'))}</p>`;
    }
    numBody.innerHTML = html;
  };

  pc.canvas.addEventListener('mousemove', (e) => {
    const b = pc.canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - b.left - pc.ox) / pc.cell) + cx0;
    const y = Math.floor((e.clientY - b.top - pc.oy) / pc.cell) + cy0;
    if (x < cx0 || y < cy0 || x >= cx1 || y >= cy1) return;
    const np = y * W + x;
    if (np === hover) return;
    hover = np;
    placeProbe(np);
    draw();
    updateSide();
  });
  pc.canvas.addEventListener('mouseleave', () => {
    hover = null;
    placeProbe(probeNow());
    draw();
    updateSide();
  });

  const applyOrder = () => {
    paneA.mesh.renderOrder = paneA.rim.renderOrder = order === 0 ? 1 : 2;
    paneB.mesh.renderOrder = paneB.rim.renderOrder = order === 0 ? 2 : 1;
    badge.element.textContent = `${t(L('ritordning', 'draw order'))}: ${order === 0 ? 'A → B' : 'B → A'}${step === 2 ? (order === 1 ? ' ✓' : ' ✗') : ''}`;
    badge.element.style.color = order === 0 ? 'var(--cyan)' : 'var(--magenta)';
    draw();
    updateSide();
  };
  let phaseT = 0;
  let now = 0;
  ms.onFrame((time) => {
    now = time;
    if (step < 2) return;
    const o = Math.floor((time - phaseT) / 2.6) % 2;
    if (o !== order) {
      order = o;
      applyOrder();
    }
  });
  const slideOffset = () => (1 - slide.p) * rigA.w * 0.9;

  return {
    show(s, animate) {
      step = s;
      hover = null;
      order = 0;
      phaseT = now;
      paneA.group.visible = s >= 1;
      paneB.group.visible = s >= 2;
      dotA.visible = s >= 1;
      dotB.visible = s >= 2;
      badge.visible = s >= 2;
      const blending = s === 3 ? AdditiveBlending : NormalBlending;
      [paneA.mat, paneB.mat].forEach((m) => {
        m.blending = blending;
        m.needsUpdate = true;
      });
      if (s === 0) ms.sweep('shaded', 'ghost', secs(animate, 1.8));
      else ms.setMode('shaded', 0, 0);
      slide.p = s === 1 && animate ? 0 : 1;
      paneA.group.position.x = slideOffset();
      if (s === 1 && animate)
        ms.tween(slide, {
          p: 1,
          duration: secs(animate, 1.2),
          ease: 'power3.out',
          onUpdate: () => {
            paneA.group.position.x = slideOffset();
            draw();
          },
        });
      placeProbe(probeNow());
      applyOrder();
    },
    destroy() {
      pc.destroy();
      ms.destroy();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Concept: glass copies of the model overlapping, swapping order      */
/* ------------------------------------------------------------------ */
function conceptVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const ms = createModelStage(host, ctx, { autoRotate: 0, eye: [1.3, 1.1, 4.0], bloom: 0.55, bloomThreshold: 0.85 });
  const mk = (tint: C3, pos: [number, number, number], glass: boolean) => {
    const mat = ms.material.clone() as typeof ms.material;
    mat.uniforms.uBaseColor.value.setRGB(...tint, SRGBColorSpace);
    if (glass) {
      mat.transparent = true;
      mat.depthWrite = false;
      mat.uniforms.uOpacity.value = 0.5;
    }
    const g = new Group();
    g.position.set(...pos);
    g.scale.setScalar(0.62);
    const m = new Mesh(ms.layers.solid.geometry, mat);
    g.add(m);
    ms.scene.add(g);
    return { g, m, mat, home: new Vector3(...pos) };
  };
  const opaque = mk([0.61, 0.48, 1.0], [0.55, 0.05, 0.85], false);
  const ga = mk([0.22, 0.88, 1.0], [0.5, 0.12, 0.8], true);
  const gb = mk([1.0, 0.25, 0.82], [-0.45, -0.08, 1.05], true);
  const la = label('A · α 0.5', 'cyan');
  la.position.set(0.2, 1.25, 0);
  ga.g.add(la);
  const lb = label('B · α 0.5', 'magenta');
  lb.position.set(-0.2, -1.25, 0);
  gb.g.add(lb);
  const lo = label('α 1.0', 'violet');
  lo.position.set(0, 1.25, 0);
  opaque.g.add(lo);
  const badge = label('', 'big');
  badge.position.set(0, 1.3, 0.5);
  ms.scene.add(badge);

  const readout = h('div.blc-readout3');
  const readPanel = ms.panel(t(L('Pixel i överlappet', 'Pixel in the overlap')), [readout]);
  const caption = ms.panel(t(L('Vad händer', 'What happens')), [h('p.bl-capt')], { side: 'bottom' });
  const text = caption.querySelector('.bl-capt')!;
  const captions = [
    L('Ogenomskinligt (α = 1): den lila kopian ersätter helt det som låg under.', 'Opaque (α = 1): the purple copy completely replaces what was underneath.'),
    L('Genomskinligt glas: <code>src·α + dst·(1−α)</code> – lite av båda.', 'Transparent glass: <code>src·α + dst·(1−α)</code> – a bit of both.'),
    L('Två glas som byter ritordning – överlappet får en annan färg. Därför sorteras genomskinligt bakifrån och fram.', 'Two glasses swapping draw order – the overlap changes color. That is why transparency is sorted back to front.'),
    L('Additivt (<code>src·α + dst</code>): ljuset summeras och blir ljusare – och ordningen spelar ingen roll.', 'Additive (<code>src·α + dst</code>): light adds up and gets brighter – and order does not matter.'),
  ];
  const objRgb = [255, 140, 64];
  const cyan = [56, 225, 255];
  const mag = [255, 63, 210];
  const over = (src: number[], a: number, dst: number[]) => src.map((v, i) => Math.round(v * a + dst[i] * (1 - a)));
  const add = (src: number[], a: number, dst: number[]) => src.map((v, i) => Math.min(255, Math.round(v * a + dst[i])));
  const chip = (c: number[], lbl: string, on = false) => `<div class="${on ? 'on' : ''}"><i style="background:rgb(${c.join(',')})"></i>${lbl} <b>(${c.join(', ')})</b></div>`;

  let step = 0;
  let order = 0;
  let phaseT = 0;
  let now = 0;
  const apply = () => {
    ga.m.renderOrder = order === 0 ? 1 : 2;
    gb.m.renderOrder = order === 0 ? 2 : 1;
    if (step >= 2) {
      badge.element.textContent = `${t(L('ritordning', 'draw order'))}: ${order === 0 ? 'A → B' : 'B → A'}`;
      badge.element.style.color = order === 0 ? 'var(--cyan)' : 'var(--magenta)';
    }
    const bg = [12, 16, 40];
    if (step === 0) readout.innerHTML = chip(objRgb, 'dst') + chip([155, 123, 255], 'src α=1') + chip([155, 123, 255], 'out', true);
    else if (step === 1) readout.innerHTML = chip(objRgb, 'dst') + chip(cyan, 'src α=0.5') + chip(over(cyan, 0.5, objRgb), 'out', true);
    else if (step === 2) readout.innerHTML = chip(over(mag, 0.5, over(cyan, 0.5, objRgb)), 'A → B', order === 0) + chip(over(cyan, 0.5, over(mag, 0.5, objRgb)), 'B → A', order === 1);
    else
      readout.innerHTML =
        chip(add(mag, 0.5, add(cyan, 0.5, bg)), t(L('A, sedan B', 'A, then B')), order === 0) +
        chip(add(cyan, 0.5, add(mag, 0.5, bg)), t(L('B, sedan A', 'B, then A')), order === 1) +
        chip(add(mag, 0.5, add(cyan, 0.5, objRgb)), t(L('på objektet (klampat)', 'on the object (clamped)')));
  };
  ms.onFrame((time, dt) => {
    now = time;
    ms.pivot.rotation.y += dt * 0.25;
    [opaque, ga, gb].forEach((c) => c.g.rotation.set(SHOWCASE_ROT_X, ms.pivot.rotation.y + 0.8, 0));
    if (step < 2) return;
    const o = Math.floor((time - phaseT) / 2.2) % 2;
    if (o !== order) {
      order = o;
      apply();
    }
  });

  return {
    show(s, animate) {
      step = s;
      order = 0;
      phaseT = now;
      text.innerHTML = t(captions[s]);
      if (animate) caption.animate([{ opacity: 0.3 }, { opacity: 1 }], { duration: secs(animate, 0.4) * 1000 });
      const slideIn = (c: { g: Group; home: Vector3 }, on: boolean, from: number) => {
        const x = on ? c.home.x : c.home.x + from;
        c.g.visible = true;
        if (!animate) {
          c.g.position.x = x;
          c.g.visible = on;
        } else ms.tween(c.g.position, { x, duration: secs(animate, 0.9), ease: 'power3.out', onComplete: () => void (c.g.visible = on) });
      };
      slideIn(opaque, s === 0, 2.4);
      slideIn(ga, s >= 1, 2.4);
      slideIn(gb, s >= 2, -2.4);
      [ga.mat, gb.mat].forEach((m) => {
        m.blending = s === 3 ? AdditiveBlending : NormalBlending;
        m.needsUpdate = true;
      });
      badge.visible = s >= 2;
      readPanel.style.display = '';
      apply();
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
        'I D3D12 heter steget Output Merger (OM). Blandningen ligger i PSO:ns D3D12_BLEND_DESC med en D3D12_RENDER_TARGET_BLEND_DESC per render target (upp till 8).',
        'In D3D12 the stage is the Output Merger (OM). Blending lives in the PSO\'s D3D12_BLEND_DESC with one D3D12_RENDER_TARGET_BLEND_DESC per render target (up to 8).',
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
