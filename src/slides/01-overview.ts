import gsap from 'gsap';
import { dur, h, reducedMotion, s } from '../core/dom';
import { L, type Text } from '../core/i18n';
import type { ApiId } from '../core/state';
import { formatBytes } from '../pipeline/layout';
import { flowDiagram, type FlowEdge, type FlowNode } from '../views/Flow';
import { SLIDES } from './index';
import { standardSlide } from './standard';
import type { ApiPanelSpec, CodeSnippet, SlideContext, StageGroup, Visual } from './types';
import '../styles/slides/overview.css';

/* ------------------------------------------------------------------ */
/* Shared stage table                                                  */
/* ------------------------------------------------------------------ */
const GROUP_COLOR: Record<StageGroup, string> = {
  cpu: 'var(--g-cpu)',
  api: 'var(--g-api)',
  'gpu-prog': 'var(--g-gpu-prog)',
  'gpu-fixed': 'var(--g-gpu-fixed)',
};
const GROUP_HEX: Record<StageGroup, string> = { cpu: '#38e1ff', api: '#9b7bff', 'gpu-prog': '#ff3fd2', 'gpu-fixed': '#ffb547' };

interface Stage {
  id: string; // node id
  slide: string; // slide id to jump to
  group: StageGroup;
  label: Text;
}

/** One lane per step: what happens on the CPU, in the API/driver, and in the two halves of the GPU. */
const LANES: { title: Text; color: string; stages: Stage[] }[] = [
  {
    title: L('1 · Applikation (CPU)', '1 · Application (CPU)'),
    color: '#38e1ff',
    stages: [
      { id: 'file', slide: 'parse', group: 'cpu', label: L('Fil på disk', 'File on disk') },
      { id: 'parse', slide: 'parse', group: 'cpu', label: L('Parsning', 'Parsing') },
      { id: 'layout', slide: 'layout', group: 'cpu', label: L('Vertexlayout', 'Vertex layout') },
    ],
  },
  {
    title: L('2 · API + drivrutin', '2 · API + driver'),
    color: '#9b7bff',
    stages: [
      { id: 'buffers', slide: 'buffers', group: 'api', label: L('Buffertar', 'Buffers') },
      { id: 'input-layout', slide: 'input-layout', group: 'api', label: L('Input layout', 'Input layout') },
      { id: 'shaders', slide: 'shaders', group: 'api', label: L('Shaders', 'Shaders') },
      { id: 'pipeline-state', slide: 'pipeline-state', group: 'api', label: L('Pipeline state', 'Pipeline state') },
      { id: 'descriptors', slide: 'descriptors', group: 'api', label: L('Uniforms', 'Uniforms') },
      { id: 'commands', slide: 'commands', group: 'api', label: L('Kommandon', 'Commands') },
    ],
  },
  {
    title: L('3 · GPU – geometri', '3 · GPU – geometry'),
    color: '#ff3fd2',
    stages: [
      { id: 'input-assembly', slide: 'input-assembly', group: 'gpu-fixed', label: L('Input assembly', 'Input assembly') },
      { id: 'vertex-shader', slide: 'vertex-shader', group: 'gpu-prog', label: L('Vertex shader', 'Vertex shader') },
      { id: 'clipping', slide: 'clipping', group: 'gpu-fixed', label: L('Clipping', 'Clipping') },
      { id: 'viewport-culling', slide: 'viewport-culling', group: 'gpu-fixed', label: L('Viewport & culling', 'Viewport & culling') },
    ],
  },
  {
    title: L('4 · GPU – pixlar → skärm', '4 · GPU – pixels → screen'),
    color: '#ffb547',
    stages: [
      { id: 'rasterization', slide: 'rasterization', group: 'gpu-fixed', label: L('Rasterisering', 'Rasterization') },
      { id: 'fragment-shader', slide: 'fragment-shader', group: 'gpu-prog', label: L('Fragment shader', 'Fragment shader') },
      { id: 'depth', slide: 'depth', group: 'gpu-fixed', label: L('Djuptest', 'Depth test') },
      { id: 'blending', slide: 'blending', group: 'gpu-fixed', label: L('Blending', 'Blending') },
      { id: 'present', slide: 'present', group: 'gpu-fixed', label: L('Present', 'Present') },
    ],
  },
];

/** Jump to another slide by id (index looked up at click time so the order can change). */
function goTo(slideId: string) {
  const i = SLIDES.findIndex((x) => x.id === slideId);
  if (i >= 0) window.dispatchEvent(new CustomEvent('rpv:go', { detail: i }));
}

const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(1)}k` : n.toLocaleString('en-US'));

const RW = 160;
const RH = 100;

/** Per-node annotations computed from the loaded mesh and a coarse software render. */
function annotations(ctx: SlideContext): Record<string, string> {
  const m = ctx.state.mesh;
  const l = ctx.derived.layout;
  const api = ctx.state.api;
  const st = ctx.derived.render(api, RW, RH).stats;
  const per: Record<ApiId, { sh: string; pso: string; desc: string; draw: string; present: string }> = {
    opengl: { sh: 'GLSL → driver', pso: 'GL state machine', desc: 'uniform / UBO', draw: 'glDrawElements', present: 'SwapBuffers' },
    vulkan: { sh: 'GLSL → SPIR-V', pso: 'VkPipeline', desc: 'descriptor set', draw: 'vkCmdDrawIndexed', present: 'vkQueuePresentKHR' },
    d3d12: { sh: 'HLSL → DXIL', pso: 'ID3D12PipelineState', desc: 'root signature', draw: 'DrawIndexedInstanced', present: 'IDXGISwapChain::Present' },
  };
  const p = per[api];
  return {
    file: `${m.format === 'builtin' ? 'OBJ' : m.format} · ${formatBytes(m.fileSize)}`,
    parse: `${k(m.vertexCount)} v · ${k(m.triangleCount)} tris`,
    layout: `stride ${l.stride} B`,
    buffers: `VB+IB ${formatBytes(l.vertexBytes + l.indexBytes)}`,
    'input-layout': `${l.attributes.length} attributes`,
    shaders: p.sh,
    'pipeline-state': p.pso,
    descriptors: p.desc,
    commands: p.draw,
    'input-assembly': `${k(st.trianglesIn)} triangles`,
    'vertex-shader': `${k(m.vertexCount)} invocations`,
    clipping: `${k(st.clippedAway)} out · ${k(st.clipped)} cut`,
    'viewport-culling': `${k(st.culled)} back-faces`,
    rasterization: `${k(st.fragments)} fragments`,
    'fragment-shader': `≤ ${k(st.fragments)} runs`,
    depth: `${k(st.depthRejected)} rejected`,
    blending: `${k(st.written)} written`,
    present: p.present,
  };
}

/** The coarse software render as an <img>-ready data URL. */
function renderImage(ctx: SlideContext): string {
  const r = ctx.derived.render(ctx.state.api, RW, RH);
  const c = document.createElement('canvas');
  c.width = RW;
  c.height = RH;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(r.color), RW, RH), 0, 0);
  return c.toDataURL();
}

/* ------------------------------------------------------------------ */
/* Real data: the whole pipeline as lanes, annotated with real numbers */
/* ------------------------------------------------------------------ */
function dataVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const notes = annotations(ctx);
  const VW = 1080;
  const VH = 384;
  const laneTop = [4, 98, 192, 286];
  const laneH = 90;
  const nodeY = (lane: number) => laneTop[lane] + 54;
  const slotX = (i: number) => 92 + i * 174;

  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  LANES.forEach((lane, li) => {
    lane.stages.forEach((st, si) => {
      nodes.push({ id: st.id, x: slotX(si), y: nodeY(li), w: 158, h: 46, label: t(st.label), sub: notes[st.id], color: GROUP_COLOR[st.group], step: li });
      if (si > 0) edges.push({ from: lane.stages[si - 1].id, to: st.id, step: li, live: true });
    });
    if (li > 0) {
      const prev = LANES[li - 1].stages;
      edges.push({ from: prev[prev.length - 1].id, to: lane.stages[0].id, dir: 'v', step: li, live: true });
    }
  });

  const wrap = h('div.v-fill.ov-data');
  host.append(wrap);
  const flow = flowDiagram(wrap, nodes, edges, [VW, VH]);
  const svg = flow.svg;

  // Lane backdrops, drawn behind everything.
  const lanes = LANES.map((lane, li) => {
    const g = s('g', { class: 'ov-lane' }, [
      s('rect', { x: 6, y: laneTop[li], width: VW - 12, height: laneH, rx: 14, fill: lane.color, 'fill-opacity': 0.045, stroke: lane.color, 'stroke-opacity': 0.25 }),
      s('text', { x: 20, y: laneTop[li] + 19, fill: lane.color, class: 'ov-lane-title' }, [t(lane.title)]),
    ]);
    svg.insertBefore(g, svg.firstChild!.nextSibling);
    return g;
  });

  // The final image (real software render of the loaded mesh at 160×100).
  const imgW = 144;
  const imgH = (imgW * RH) / RW;
  const ix = slotX(5) - imgW / 2 + 4;
  const iy = laneTop[3] + laneH - imgH - 6;
  const screen = s('g', { class: 'ov-screen' }, [
    s('rect', { x: ix - 5, y: iy - 5, width: imgW + 10, height: imgH + 10, rx: 8, class: 'ov-screen-frame' }),
    s('image', { href: renderImage(ctx), x: ix, y: iy, width: imgW, height: imgH, preserveAspectRatio: 'none', style: 'image-rendering: pixelated' }),
    s('text', { x: ix + imgW / 2, y: iy - 12, 'text-anchor': 'middle', class: 'ov-screen-label' }, [`${RW}×${RH} · ${t(L('verklig CPU-rendering', 'real CPU render'))}`]),
  ]);
  const presentNode = nodes.find((n) => n.id === 'present')!;
  const link = s('path', {
    d: `M${presentNode.x + 78},${presentNode.y} L${ix - 8},${presentNode.y}`,
    class: 'edge live',
    'marker-end': 'url(#arrow)',
  });
  const screenG = s('g', {}, [link, screen]);
  svg.append(screenG);

  // Clickable nodes → jump to that slide.
  for (const lane of LANES) {
    for (const st of lane.stages) {
      const g = flow.node(st.id);
      if (!g) continue;
      g.classList.add('ov-click');
      g.dataset.lane = String(LANES.indexOf(lane));
      const title = s('title', {}, [`${t(L('Gå till', 'Go to'))}: ${t(st.label)}`]);
      g.prepend(title);
      g.addEventListener('click', () => goTo(st.slide));
    }
  }
  const edgeGroups = Array.from(svg.querySelectorAll<SVGGElement>('g.edge-g'));

  return {
    show(step, animate) {
      flow.show(step, animate);
      lanes.forEach((g, i) => {
        g.classList.toggle('cur', i === step);
        gsap.to(g, { opacity: i <= step ? 1 : 0.18, duration: animate ? dur(0.4) : 0 });
      });
      // Dim earlier lanes a little so the current one pops.
      LANES.forEach((lane, li) =>
        lane.stages.forEach((st) => flow.node(st.id)?.classList.toggle('dim', li < step)),
      );
      // Packets only on the current lane and the edge leading into it.
      edges.forEach((e, i) => {
        const on = (e.step ?? 0) === step;
        edgeGroups[i]?.querySelectorAll('circle').forEach((c) => ((c as SVGElement).style.display = on ? '' : 'none'));
        edgeGroups[i]?.classList.toggle('dim', !on);
      });
      const showScreen = step >= 3;
      if (animate && showScreen) gsap.fromTo(screenG, { opacity: 0, x: -20 }, { opacity: 1, x: 0, duration: dur(0.7), delay: dur(0.4), ease: 'power2.out' });
      else gsap.set(screenG, { opacity: showScreen ? 1 : 0, x: 0 });
      if (animate) {
        const cur = LANES[step].stages.map((st) => flow.node(st.id)).filter(Boolean) as SVGGElement[];
        gsap.fromTo(cur, { opacity: 0, y: 10 }, { opacity: 1, y: 0, stagger: 0.08, duration: dur(0.4), ease: 'power2.out' });
      }
    },
    destroy() {
      gsap.killTweensOf([screenG, ...lanes]);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Concept: a glowing conveyor – text → floats → buffers → triangles → */
/* pixels → screen                                                     */
/* ------------------------------------------------------------------ */
interface Packet {
  x: number; // px along the track
  v: number; // px / s
  seed: number;
  culled: boolean;
  dead: boolean;
  fall: number;
}

function conceptVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const wrap = h('div.v-fill.ov-concept');
  const canvas = h('canvas.ov-canvas');
  const overlay = h('div.ov-overlay');
  const caption = h('div.ov-caption');
  wrap.append(canvas, overlay, caption);
  host.append(wrap);
  const g2 = canvas.getContext('2d')!;

  // The final picture comes from the real software render, revealed block by block.
  const r = ctx.derived.render(ctx.state.api, RW, RH);
  const img = document.createElement('canvas');
  img.width = RW;
  img.height = RH;
  img.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(r.color), RW, RH), 0, 0);
  const BX = 16;
  const BY = 10;
  const revealed = new Uint8Array(BX * BY);
  let revealCount = 0;
  const revealOne = () => {
    if (revealCount >= revealed.length) return;
    let i = Math.floor(Math.random() * revealed.length);
    while (revealed[i]) i = (i + 1) % revealed.length;
    revealed[i] = 1;
    revealCount++;
  };

  // Glow sprites (cheaper than shadowBlur on every packet).
  const sprite = (hex: string) => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const x = c.getContext('2d')!;
    const gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, hex + 'ff');
    gr.addColorStop(0.25, hex + '88');
    gr.addColorStop(1, hex + '00');
    x.fillStyle = gr;
    x.fillRect(0, 0, 64, 64);
    return c;
  };
  const ZONE_HEX = ['#38e1ff', '#9b7bff', '#ff3fd2', '#ffb547'];
  const glows = ZONE_HEX.map(sprite);
  const redGlow = sprite('#ff5a6e');

  // Geometry (CSS px), recomputed on resize.
  let W = 0;
  let H = 0;
  let trackY = 0;
  let zones: { x0: number; x1: number }[] = [];
  let screenRect = { x: 0, y: 0, w: 0, h: 0 };
  let x0 = 0;
  const captionEls: HTMLElement[] = [];

  LANES.forEach((lane, li) => {
    const list = h('div.ov-zone-cap', {}, [
      h('div.ov-zone-title', { text: t(lane.title), style: { color: lane.color } }),
      ...lane.stages.map((st) =>
        h('button.ov-stage', { text: t(st.label), style: { color: GROUP_HEX[st.group] }, on: { click: () => goTo(st.slide) } }),
      ),
    ]);
    list.dataset.lane = String(li);
    overlay.append(list);
    captionEls.push(list);
  });
  const screenLabel = h('div.ov-screen-cap', { text: t(L('Skärm', 'Screen')) });
  overlay.append(screenLabel);

  const layout = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = wrap.clientWidth;
    H = wrap.clientHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    g2.setTransform(dpr, 0, 0, dpr, 0, 0);
    const pad = 18;
    const sw = Math.min(W * 0.17, 190);
    const sh = (sw * RH) / RW;
    trackY = Math.round(H * 0.3);
    const right = W - pad - sw - 26;
    x0 = pad + 14;
    const zw = (right - x0 - 3 * 12) / 4;
    zones = [0, 1, 2, 3].map((i) => ({ x0: x0 + i * (zw + 12), x1: x0 + i * (zw + 12) + zw }));
    screenRect = { x: W - pad - sw, y: trackY - sh / 2, w: sw, h: sh };
    captionEls.forEach((el, i) => {
      Object.assign(el.style, { left: `${zones[i].x0}px`, width: `${zw}px`, top: `${trackY + 52}px` });
    });
    Object.assign(screenLabel.style, { left: `${screenRect.x}px`, width: `${sw}px`, top: `${screenRect.y + sh + 10}px` });
  };

  let step = 0;
  const packets: Packet[] = [];
  let spawnAcc = 0;
  const spawn = (x = x0 - 10) => packets.push({ x, v: 70 + Math.random() * 40, seed: Math.random(), culled: Math.random() < 0.22, dead: false, fall: 0 });
  const endX = () => (step >= 3 ? screenRect.x + screenRect.w / 2 : zones[step].x1 - 6);

  // Pre-seed so a static frame (reduced motion / jump) already shows a full stream.
  const seed = () => {
    packets.length = 0;
    const e = endX();
    for (let x = x0; x < e; x += 34 + Math.random() * 18) spawn(x);
  };

  const zoneOf = (x: number) => {
    for (let i = 0; i < 4; i++) if (x < zones[i].x1 + 6) return i;
    return 4;
  };
  const glyphs = ['v', 'f', 'vn', '0.5', '1/2', '−.7', 'vt', '3.1'];

  const drawPacket = (p: Packet, time: number) => {
    const zi = zoneOf(p.x);
    const y = trackY + p.fall;
    const alpha = p.dead ? 0 : Math.max(0, 1 - p.fall / 60);
    if (alpha <= 0) return;
    g2.globalAlpha = alpha;
    const glow = p.culled && zi === 2 && p.x > (zones[2].x0 + zones[2].x1) / 2 ? redGlow : glows[Math.min(zi, 3)];
    g2.drawImage(glow, p.x - 18, y - 18, 36, 36);
    g2.fillStyle = '#fff';
    g2.strokeStyle = ZONE_HEX[Math.min(zi, 3)];
    g2.lineWidth = 1.6;
    if (zi === 0) {
      const z = zones[0];
      const f = (p.x - z.x0) / (z.x1 - z.x0);
      if (f < 0.45) {
        g2.font = '600 12px JetBrains Mono, monospace';
        g2.textAlign = 'center';
        g2.fillStyle = '#bff4ff';
        g2.fillText(glyphs[Math.floor(p.seed * glyphs.length)], p.x, y + 4);
      } else {
        g2.fillStyle = '#bff4ff';
        for (let k2 = 0; k2 < 3; k2++) {
          g2.beginPath();
          g2.arc(p.x - 6 + k2 * 6, y, 2.2, 0, Math.PI * 2);
          g2.fill();
        }
      }
    } else if (zi === 1) {
      g2.fillStyle = 'rgba(155,123,255,0.35)';
      g2.fillRect(p.x - 7, y - 7, 14, 14);
      g2.strokeRect(p.x - 7, y - 7, 14, 14);
      g2.beginPath();
      g2.moveTo(p.x - 7, y);
      g2.lineTo(p.x + 7, y);
      g2.stroke();
    } else if (zi === 2) {
      const a = time * 1.6 + p.seed * 6;
      const red = p.culled && p.x > (zones[2].x0 + zones[2].x1) / 2;
      g2.strokeStyle = red ? '#ff5a6e' : '#ff3fd2';
      g2.beginPath();
      for (let k2 = 0; k2 < 3; k2++) {
        const ang = a + (k2 * Math.PI * 2) / 3;
        const px = p.x + Math.cos(ang) * 9;
        const py = y + Math.sin(ang) * 9 * 0.8;
        if (k2) g2.lineTo(px, py);
        else g2.moveTo(px, py);
      }
      g2.closePath();
      g2.stroke();
    } else {
      // pixel shards
      const spread = zi === 3 ? Math.min(1, (p.x - zones[3].x0) / (zones[3].x1 - zones[3].x0)) : 1;
      g2.fillStyle = '#ffd08a';
      for (let k2 = 0; k2 < 6; k2++) {
        const ang = p.seed * 10 + k2;
        const d = 3 + spread * 9;
        g2.fillRect(p.x + Math.cos(ang) * d - 2, y + Math.sin(ang) * d - 2, 4, 4);
      }
    }
    g2.globalAlpha = 1;
  };

  const draw = (time: number) => {
    g2.clearRect(0, 0, W, H);
    // Track
    const e = endX();
    const grad = g2.createLinearGradient(x0, 0, screenRect.x, 0);
    ZONE_HEX.forEach((c, i) => grad.addColorStop(i / 3, c));
    g2.lineCap = 'round';
    g2.strokeStyle = 'rgba(140,160,255,0.12)';
    g2.lineWidth = 6;
    g2.beginPath();
    g2.moveTo(x0, trackY);
    g2.lineTo(screenRect.x - 8, trackY);
    g2.stroke();
    g2.save();
    g2.strokeStyle = grad;
    g2.lineWidth = 3;
    g2.shadowColor = 'rgba(155,123,255,0.9)';
    g2.shadowBlur = 12;
    g2.setLineDash([10, 8]);
    g2.lineDashOffset = -time * 40;
    g2.beginPath();
    g2.moveTo(x0, trackY);
    g2.lineTo(Math.min(e, screenRect.x - 8), trackY);
    g2.stroke();
    g2.restore();

    // Zones ("machines")
    zones.forEach((z, i) => {
      const on = i <= step;
      const cur = i === step;
      const c = ZONE_HEX[i];
      g2.save();
      g2.globalAlpha = on ? 1 : 0.25;
      g2.fillStyle = c + (cur ? '1f' : '10');
      g2.strokeStyle = c + (cur ? 'dd' : '66');
      g2.lineWidth = cur ? 2 : 1.2;
      if (cur) {
        g2.shadowColor = c;
        g2.shadowBlur = 18 + Math.sin(time * 3) * 6;
      }
      const ry = trackY - 34;
      g2.beginPath();
      g2.roundRect(z.x0, ry, z.x1 - z.x0, 68, 14);
      g2.fill();
      g2.stroke();
      g2.restore();
      // sub-stage ticks along the track
      const n = LANES[i].stages.length;
      LANES[i].stages.forEach((st, si) => {
        const tx = z.x0 + ((si + 0.5) / n) * (z.x1 - z.x0);
        g2.fillStyle = GROUP_HEX[st.group];
        g2.globalAlpha = on ? 0.9 : 0.25;
        g2.beginPath();
        g2.arc(tx, trackY + 26, 3, 0, Math.PI * 2);
        g2.fill();
        g2.globalAlpha = 1;
      });
    });

    // Screen
    const sr = screenRect;
    g2.save();
    g2.fillStyle = '#04060f';
    g2.strokeStyle = step >= 3 ? '#ffb547' : 'rgba(140,160,255,0.3)';
    g2.lineWidth = 2;
    if (step >= 3) {
      g2.shadowColor = '#ffb547';
      g2.shadowBlur = 20;
    }
    g2.beginPath();
    g2.roundRect(sr.x - 6, sr.y - 6, sr.w + 12, sr.h + 12, 10);
    g2.fill();
    g2.stroke();
    g2.restore();
    if (step >= 3) {
      g2.imageSmoothingEnabled = false;
      const bw = RW / BX;
      const bh = RH / BY;
      for (let by = 0; by < BY; by++) {
        for (let bx = 0; bx < BX; bx++) {
          if (!revealed[by * BX + bx]) continue;
          g2.drawImage(img, bx * bw, by * bh, bw, bh, sr.x + (bx * sr.w) / BX, sr.y + (by * sr.h) / BY, sr.w / BX + 0.5, sr.h / BY + 0.5);
        }
      }
      // scanline shimmer
      const sy = sr.y + ((time * 60) % sr.h);
      g2.fillStyle = 'rgba(255,255,255,0.06)';
      g2.fillRect(sr.x, sy, sr.w, 2);
    } else {
      g2.fillStyle = 'rgba(154,163,199,0.4)';
      g2.font = '11px JetBrains Mono, monospace';
      g2.textAlign = 'center';
      g2.fillText('no signal', sr.x + sr.w / 2, sr.y + sr.h / 2 + 4);
    }

    for (const p of packets) drawPacket(p, time);
  };

  let raf = 0;
  let last = performance.now();
  const start = last;
  const still = reducedMotion();
  const frame = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!still) {
      spawnAcc += dt;
      if (spawnAcc > 0.42) {
        spawnAcc = 0;
        spawn();
      }
      const e = endX();
      for (const p of packets) {
        p.x += p.v * dt * (p.x < zones[0].x0 ? 1.4 : 1);
        if (p.culled && zoneOf(p.x) === 2 && p.x > (zones[2].x0 + zones[2].x1) / 2 + 10) p.fall += dt * 90;
        if (p.x >= e) {
          p.dead = true;
          if (step >= 3) revealOne();
        }
        if (p.fall > 60) p.dead = true;
      }
      for (let i = packets.length - 1; i >= 0; i--) if (packets[i].dead) packets.splice(i, 1);
    }
    draw((now - start) / 1000);
    raf = requestAnimationFrame(frame);
  };

  const ro = new ResizeObserver(() => {
    layout();
    draw((performance.now() - start) / 1000);
  });
  ro.observe(wrap);
  layout();
  raf = requestAnimationFrame(frame);

  const captions = [
    L('Text och bytes från filen blir siffror i CPU-minnet.', 'Text and bytes from the file become numbers in CPU memory.'),
    L('API:t och drivrutinen packar siffrorna i GPU-buffertar och spelar in kommandon.', 'The API and driver pack the numbers into GPU buffers and record commands.'),
    L('GPU:n gör om vertices till trianglar på skärmen – de som vänder bort eller hamnar utanför slängs (röda).', 'The GPU turns vertices into triangles on screen – those facing away or outside are discarded (red).'),
    L('Trianglarna splittras i pixlar som färgas, djuptestas och landar i bilden som visas.', 'Triangles shatter into pixels that are shaded, depth tested and land in the image that is shown.'),
  ];

  return {
    show(st, animate) {
      step = st;
      layout();
      if (!animate) seed();
      if (step >= 3 && (!animate || still)) {
        revealed.fill(1);
        revealCount = revealed.length;
      } else if (step < 3) {
        revealed.fill(0);
        revealCount = 0;
      }
      captionEls.forEach((el, i) => {
        el.classList.toggle('on', i <= step);
        el.classList.toggle('cur', i === step);
      });
      screenLabel.classList.toggle('on', step >= 3);
      caption.innerHTML = t(captions[step]);
      if (animate) {
        gsap.fromTo(caption, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: dur(0.4) });
        gsap.fromTo(captionEls[step], { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: dur(0.45), ease: 'power2.out' });
      } else {
        gsap.set([caption, ...captionEls], { opacity: '', y: 0 });
      }
    },
    destroy() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      gsap.killTweensOf([caption, ...captionEls]);
    },
  };
}

/* ------------------------------------------------------------------ */
/* API panels: one frame of each API                                   */
/* ------------------------------------------------------------------ */
type Line = [string, ...number[]];
/** Build a snippet where each line lists the steps (0-based) at which it is highlighted. */
function snippet(lang: CodeSnippet['lang'], lines: Line[], steps: number, title?: Text): CodeSnippet {
  const highlight = Array.from({ length: steps }, (_, st) => lines.flatMap(([, ...on], i) => (on.includes(st) ? [i + 1] : [])));
  return { lang, title, src: lines.map((l) => l[0]).join('\n'), highlight };
}

function apis(ctx: SlideContext): Record<ApiId, ApiPanelSpec> {
  const m = ctx.state.mesh;
  const l = ctx.derived.layout;
  const n = m.indices.length;
  const file = `${m.name}.${m.format === 'builtin' ? 'obj' : m.format.toLowerCase()}`;
  const u16 = l.indexType === 'uint16';
  const STEPS = 4;
  return {
    opengl: {
      note: L(
        'I OpenGL ser en frame enkel ut: du sätter state och anropar glDrawElements. Drivrutinen spelar in kommandobuffertar, synkar och köar arbetet åt dig i bakgrunden – SwapBuffers visar bilden.',
        'In OpenGL a frame looks simple: you set state and call glDrawElements. The driver records command buffers, synchronizes and queues the work for you behind the scenes – SwapBuffers shows the image.',
      ),
      code: [
        snippet('cpp', [
          ['// once, at startup'],
          [`Mesh mesh = loadMesh("${file}");          // CPU: parse`, 0],
          ['GLuint vbo = uploadBuffer(mesh.vertices);  // glNamedBufferStorage', 1],
          ['GLuint ibo = uploadBuffer(mesh.indices);', 1],
          ['GLuint vao = makeVertexArray(vbo, ibo);    // input layout', 1],
          ['GLuint prog = linkProgram(vsGlsl, fsGlsl); // driver compiles', 1],
          ['// every frame'],
          ['while (!glfwWindowShouldClose(window)) {'],
          ['    glViewport(0, 0, width, height);', 2],
          ['    glClearColor(0.03f, 0.04f, 0.08f, 1.0f);', 3],
          ['    glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);', 3],
          ['    glUseProgram(prog);', 1],
          ['    glBindVertexArray(vao);', 1],
          ['    glUniformMatrix4fv(0, 1, GL_FALSE, &mvp[0][0]);', 1],
          [`    glDrawElements(GL_TRIANGLES, ${n}, ${u16 ? 'GL_UNSIGNED_SHORT' : 'GL_UNSIGNED_INT'}, nullptr);`, 1, 2, 3],
          ['    glfwSwapBuffers(window);   // SwapBuffers: present', 3],
          ['    glfwPollEvents();'],
          ['}'],
        ], STEPS, L('En frame', 'One frame')),
      ],
      terms: [
        { term: 'draw call', desc: L('Ett anrop som startar pipelinen för en mängd vertices.', 'One call that runs the pipeline over a set of vertices.') },
        { term: 'SwapBuffers', desc: L('Byter back- och frontbuffert så att bilden visas.', 'Swaps back and front buffer so the image is shown.') },
        { term: 'implicit sync', desc: L('Drivrutinen ser till att GPU:n inte läser data du ändrar.', 'The driver makes sure the GPU never reads data you are changing.') },
      ],
      you: L('sätter state och ritar', 'set state and draw'),
      driver: L('kommandobuffertar, minne, synk', 'command buffers, memory, sync'),
    },
    vulkan: {
      note: L(
        'I Vulkan är allt explicit: vänta på din egen fence, hämta en swapchain-bild, spela in en command buffer, skicka den med vkQueueSubmit2 och presentera med vkQueuePresentKHR. Ingenting händer på GPU:n förrän submit.',
        'In Vulkan everything is explicit: wait on your own fence, acquire a swapchain image, record a command buffer, submit it with vkQueueSubmit2 and present with vkQueuePresentKHR. Nothing happens on the GPU until submit.',
      ),
      code: [
        snippet('cpp', [
          [`Mesh mesh = loadMesh("${file}");   // CPU: parse`, 0],
          ['createBuffers(mesh);   // vkCreateBuffer, staging copy', 1],
          ['createPipeline();      // SPIR-V + vertex input → VkPipeline', 1],
          ['while (!glfwWindowShouldClose(window)) {'],
          ['  vkWaitForFences(dev, 1, &inFlight[f], VK_TRUE, UINT64_MAX);', 1],
          ['  vkResetFences(dev, 1, &inFlight[f]);', 1],
          ['  vkAcquireNextImageKHR(dev, swapchain, UINT64_MAX, acquired[f], VK_NULL_HANDLE, &img);', 3],
          ['  vkResetCommandBuffer(cmd[f], 0);', 1],
          ['  vkBeginCommandBuffer(cmd[f], &beginInfo);', 1],
          ['  // vkCmdPipelineBarrier2: UNDEFINED → COLOR_ATTACHMENT_OPTIMAL', 3],
          ['  vkCmdBeginRendering(cmd[f], &renderingInfo);   // loadOp = CLEAR', 3],
          ['  vkCmdBindPipeline(cmd[f], VK_PIPELINE_BIND_POINT_GRAPHICS, pipeline);', 1],
          ['  vkCmdSetViewport(cmd[f], 0, 1, &viewport);', 2],
          ['  vkCmdBindVertexBuffers(cmd[f], 0, 1, &vertexBuffer, &zeroOffset);', 1],
          [`  vkCmdBindIndexBuffer(cmd[f], indexBuffer, 0, ${u16 ? 'VK_INDEX_TYPE_UINT16' : 'VK_INDEX_TYPE_UINT32'});`, 1],
          [`  vkCmdDrawIndexed(cmd[f], ${n}, 1, 0, 0, 0);`, 1, 2],
          ['  vkCmdEndRendering(cmd[f]);', 3],
          ['  // vkCmdPipelineBarrier2: COLOR_ATTACHMENT_OPTIMAL → PRESENT_SRC_KHR', 3],
          ['  vkEndCommandBuffer(cmd[f]);', 1],
          ['  vkQueueSubmit2(queue, 1, &submitInfo, inFlight[f]);   // GPU starts', 2, 3],
          ['  vkQueuePresentKHR(queue, &presentInfo);', 3],
          ['  f = (f + 1) % MAX_FRAMES_IN_FLIGHT;'],
          ['}'],
        ], STEPS, L('En frame', 'One frame')),
      ],
      terms: [
        { term: 'VkFence', desc: L('CPU väntar på att GPU:n är klar med en tidigare frame.', 'The CPU waits until the GPU is done with an earlier frame.') },
        { term: 'VkSemaphore', desc: L('GPU–GPU-synk: bild hämtad → rendera → presentera.', 'GPU–GPU sync: image acquired → render → present.') },
        { term: 'command buffer', desc: L('Inspelad lista med kommandon som skickas med submit.', 'Recorded list of commands, sent with submit.') },
        { term: 'frames in flight', desc: L('CPU spelar in frame N+1 medan GPU:n ritar frame N.', 'The CPU records frame N+1 while the GPU draws frame N.') },
      ],
      you: L('synk, inspelning, submit, present', 'sync, recording, submit, present'),
      driver: L('översätter kommandon till hårdvaran', 'translates commands for the hardware'),
    },
    d3d12: {
      note: L(
        'D3D12 liknar Vulkan: vänta på fencen för den här back-bufferten, återställ allocator och command list, spela in, ExecuteCommandLists, Present – och Signal så att du vet när GPU:n är klar.',
        'D3D12 is similar to Vulkan: wait on the fence for this back buffer, reset allocator and command list, record, ExecuteCommandLists, Present – and Signal so you know when the GPU is done.',
      ),
      code: [
        snippet('cpp', [
          [`Mesh mesh = LoadMesh(L"${file}");    // CPU: parse`, 0],
          ['CreateBuffers(mesh);     // UPLOAD → DEFAULT heap copy', 1],
          ['CreatePipelineState();   // DXIL + input layout → PSO', 1],
          ['while (running) {'],
          ['  if (fence->GetCompletedValue() < frameFence[frame]) {', 1],
          ['    fence->SetEventOnCompletion(frameFence[frame], fenceEvent);', 1],
          ['    WaitForSingleObject(fenceEvent, INFINITE);', 1],
          ['  }'],
          ['  alloc[frame]->Reset();', 1],
          ['  list->Reset(alloc[frame].Get(), pso.Get());', 1],
          ['  list->SetGraphicsRootSignature(rootSig.Get());', 1],
          ['  list->ResourceBarrier(1, &toRenderTarget);   // PRESENT → RENDER_TARGET', 3],
          ['  list->ClearRenderTargetView(rtv[frame], clearColor, 0, nullptr);', 3],
          ['  list->OMSetRenderTargets(1, &rtv[frame], FALSE, &dsv);', 3],
          ['  list->RSSetViewports(1, &viewport);', 2],
          ['  list->IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);', 1, 2],
          ['  list->IASetVertexBuffers(0, 1, &vbv);', 1],
          ['  list->IASetIndexBuffer(&ibv);', 1],
          [`  list->DrawIndexedInstanced(${n}, 1, 0, 0, 0);`, 1, 2],
          ['  list->ResourceBarrier(1, &toPresent);        // RENDER_TARGET → PRESENT', 3],
          ['  list->Close();', 1],
          ['  queue->ExecuteCommandLists(1, CommandListCast(list.GetAddressOf()));', 2, 3],
          ['  swapChain->Present(1, 0);', 3],
          ['  queue->Signal(fence.Get(), ++fenceCounter);', 1],
          ['  frameFence[frame] = fenceCounter;'],
          ['  frame = swapChain->GetCurrentBackBufferIndex();'],
          ['}'],
        ], STEPS, L('En frame', 'One frame')),
      ],
      terms: [
        { term: 'ID3D12Fence', desc: L('Ett 64-bitars värde som GPU:n sätter med Signal; CPU:n väntar på det.', 'A 64-bit value the GPU sets with Signal; the CPU waits on it.') },
        { term: 'command allocator', desc: L('Minnet bakom en command list – får bara återställas när GPU:n är klar.', 'The memory behind a command list – may only be reset once the GPU is done.') },
        { term: 'ExecuteCommandLists', desc: L('Skickar inspelade listor till GPU-kön.', 'Sends recorded lists to the GPU queue.') },
        { term: 'Present', desc: L('Lämnar back-bufferten till DXGI för visning.', 'Hands the back buffer to DXGI for display.') },
      ],
      you: L('fences, barriärer, inspelning', 'fences, barriers, recording'),
      driver: L('översätter till hårdvarukommandon', 'translates to hardware commands'),
    },
  };
}

export default standardSlide({
  id: 'overview',
  group: 'cpu',
  short: L('Översikt', 'Overview'),
  title: L('Översikt – hela pipelinen', 'Overview – the whole pipeline'),
  lead: L(
    'Hela resan på en bild: från en fil på disken till pixlar på skärmen. Varje ruta är en egen bild i presentationen – klicka för att hoppa dit.',
    'The whole journey at a glance: from a file on disk to pixels on screen. Every box is its own slide – click one to jump there.',
  ),
  bullets: [
    L(
      '<b>Applikationen (CPU)</b> läser filen, tolkar texten eller binärdatan och packar vertices och index tätt i minnet.',
      '<b>The application (CPU)</b> reads the file, parses the text or binary data and packs vertices and indices tightly in memory.',
    ),
    L(
      '<b>API + drivrutin</b>: buffertar laddas upp till VRAM, shaders och pipeline-state skapas, och kommandon spelas in och skickas till GPU:n.',
      '<b>API + driver</b>: buffers are uploaded to VRAM, shaders and pipeline state are created, and commands are recorded and submitted to the GPU.',
    ),
    L(
      '<b>GPU – geometri</b>: input assembly, vertex shader, clipping, viewport och culling. <span class="c-nrm">Programmerbara</span> steg varvas med <span class="c-uv">fasta</span>.',
      '<b>GPU – geometry</b>: input assembly, vertex shader, clipping, viewport and culling. <span class="c-nrm">Programmable</span> stages alternate with <span class="c-uv">fixed-function</span> ones.',
    ),
    L(
      '<b>GPU – pixlar</b>: rasterisering, fragment shader, djuptest och blending skriver till en swapchain-bild som sedan <i>presenteras</i> på skärmen.',
      '<b>GPU – pixels</b>: rasterization, fragment shader, depth test and blending write into a swapchain image that is then <i>presented</i> on screen.',
    ),
  ],
  api: apis,
  data: dataVisual,
  concept: conceptVisual,
});
