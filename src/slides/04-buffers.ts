import gsap from 'gsap';
import { dur, h, reducedMotion, s } from '../core/dom';
import { L, type Text } from '../core/i18n';
import type { ApiId } from '../core/state';
import { formatBytes, type VertexLayout } from '../pipeline/layout';
import { stat } from '../views/widgets';
import { standardSlide } from './standard';
import type { ApiPanelSpec, CodeSnippet, SlideContext, Visual } from './types';
import '../styles/slides/buffers.css';

/* ------------------------------------------------------------------ */
/* Numbers                                                             */
/* ------------------------------------------------------------------ */
const PCIE_BYTES_PER_S = 25e9; // PCIe 4.0 x16: 31.5 GB/s raw, ≈25 GB/s in practice
const alignUp = (n: number, a: number) => Math.ceil(n / a) * a;

interface Alloc {
  vb: number;
  ib: number;
  exact: boolean; // false = driver internal, unknown
  rule: Text;
}

/** How much VRAM each buffer actually occupies, per API. */
function allocation(api: ApiId, l: VertexLayout): Alloc {
  if (api === 'd3d12') {
    return {
      vb: alignUp(l.vertexBytes, 65536),
      ib: alignUp(l.indexBytes, 65536),
      exact: true,
      rule: L('committed resource → egen heap, avrundas till 64 KiB (D3D12_DEFAULT_RESOURCE_PLACEMENT_ALIGNMENT)', 'committed resource → its own heap, rounded up to 64 KiB (D3D12_DEFAULT_RESOURCE_PLACEMENT_ALIGNMENT)'),
    };
  }
  if (api === 'vulkan') {
    return {
      vb: alignUp(l.vertexBytes, 256),
      ib: alignUp(l.indexBytes, 256),
      exact: false,
      rule: L('req.size / req.alignment – typiskt 16–256 B beroende på GPU (uppskattat med 256 B)', 'req.size / req.alignment – typically 16–256 B depending on the GPU (estimated with 256 B)'),
    };
  }
  return {
    vb: l.vertexBytes,
    ib: l.indexBytes,
    exact: false,
    rule: L('drivrutinen väljer minne och avrundning – inte synligt för dig', 'the driver chooses memory and rounding – not visible to you'),
  };
}

function fmtTime(sec: number): string {
  if (sec < 1e-6) return `${(sec * 1e9).toFixed(0)} ns`;
  if (sec < 1e-3) return `${(sec * 1e6).toFixed(1)} µs`;
  return `${(sec * 1e3).toFixed(2)} ms`;
}

const ATTR_CLS = { position: 'pos', normal: 'nrm', uv: 'uv' } as const;

/** First `n` bytes of the vertex buffer as colored hex cells. */
function firstBytes(l: VertexLayout, n: number): HTMLElement {
  const bytes = new Uint8Array(l.vertexBuffer, 0, Math.min(n, l.vertexBytes));
  const cls = (off: number) => {
    const o = off % l.stride;
    const a = [...l.attributes].reverse().find((x) => x.offset <= o)!;
    return ATTR_CLS[a.name];
  };
  return h('div.bf-hex', {}, Array.from(bytes, (b, i) => h(`span.mem-cell.${cls(i)}`, { text: b.toString(16).padStart(2, '0') })));
}

/* ------------------------------------------------------------------ */
/* Real data: RAM → PCIe → VRAM with this mesh's byte counts           */
/* ------------------------------------------------------------------ */
function dataVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const api = ctx.state.api;
  const l = ctx.derived.layout;
  const total = l.vertexBytes + l.indexBytes;
  const al = allocation(api, l);
  const seconds = total / PCIE_BYTES_PER_S;
  const maxBytes = Math.max(al.vb, al.ib, l.vertexBytes, l.indexBytes);
  const pct = (n: number) => `${Math.max(1.5, (100 * n) / maxBytes)}%`;

  const stagingName: Record<ApiId, Text> = {
    opengl: L('drivrutinens kopia', "driver's copy"),
    vulkan: L('staging-VkBuffer', 'staging VkBuffer'),
    d3d12: L('UPLOAD-heap-resurs', 'UPLOAD heap resource'),
  };
  const stagingFlags: Record<ApiId, string> = {
    opengl: t(L('görs inuti glNamedBufferStorage', 'made inside glNamedBufferStorage')),
    vulkan: 'HOST_VISIBLE | HOST_COHERENT',
    d3d12: 'D3D12_HEAP_TYPE_UPLOAD',
  };
  const vramFlags: Record<ApiId, string> = {
    opengl: t(L('drivrutinen väljer (oftast VRAM)', 'driver decides (usually VRAM)')),
    vulkan: 'DEVICE_LOCAL',
    d3d12: 'D3D12_HEAP_TYPE_DEFAULT',
  };
  const states: Record<ApiId, [string, string][]> = {
    opengl: [[t(L('implicit synk', 'implicit sync')), t(L('drivrutinen väntar in kopian före första draw', 'the driver waits for the copy before the first draw'))]],
    vulkan: [
      ['TRANSFER_WRITE → VERTEX_ATTRIBUTE_READ', 'VkBufferMemoryBarrier2'],
      ['TRANSFER_WRITE → INDEX_READ', 'VkBufferMemoryBarrier2'],
    ],
    d3d12: [
      ['COPY_DEST → VERTEX_AND_CONSTANT_BUFFER', 'ResourceBarrier'],
      ['COPY_DEST → INDEX_BUFFER', 'ResourceBarrier'],
    ],
  };

  const bar = (label: string, bytes: number, cls: string, alloc?: number) =>
    h(`div.bf-buf.${cls}`, {}, [
      h('div.bf-buf-head', {}, [h('span', { text: label }), h('b.mono', { text: formatBytes(bytes) })]),
      h('div.bf-track', {}, [
        alloc && alloc > bytes ? h('i.bf-pad', { style: { width: pct(alloc) } }) : null,
        h('i.bf-fill', { style: { width: pct(bytes) } }),
      ]),
      alloc !== undefined
        ? h('div.bf-buf-sub', { text: alloc > bytes ? `${t(L('allokerat', 'allocated'))} ${formatBytes(alloc)} · +${formatBytes(alloc - bytes)} padding${al.exact ? '' : ' (≈)'}` : t(L('ingen synlig avrundning', 'no visible rounding')) })
        : null,
    ]);

  // CPU RAM column
  const appVB = bar(`vertices · ${l.stride} B × ${ctx.state.mesh.vertexCount.toLocaleString('en-US')}`, l.vertexBytes, 'vb');
  const appIB = bar(`indices · ${l.indexType}`, l.indexBytes, 'ib');
  const staging = h('div.bf-staging', {}, [
    h('div.bf-tag', { text: t(stagingName[api]) }),
    h('div.bf-flags.mono', { text: stagingFlags[api] }),
    h('div.bf-track.st', {}, [h('i.bf-fill.st', { style: { width: '100%' } })]),
    h('div.bf-buf-sub', { text: `memcpy ${formatBytes(total)}` }),
  ]);
  const ram = h('div.bf-col.bf-ram', {}, [
    h('div.bf-col-title', {}, [h('span.bf-dot.cpu'), t(L('System-RAM · CPU', 'System RAM · CPU'))]),
    appVB,
    appIB,
    h('div.bf-hex-wrap', {}, [h('div.bf-hex-k', { text: t(L('första 16 bytes', 'first 16 bytes')) }), firstBytes(l, 16)]),
    staging,
  ]);

  // PCIe column
  const lanes = s('svg', { class: 'bf-lanes', viewBox: '0 0 200 160', preserveAspectRatio: 'none' });
  const laneEls: SVGPathElement[] = [];
  for (let i = 0; i < 8; i++) {
    const y = 20 + i * 17;
    const p = s('path', { d: `M0,${y} L200,${y}`, class: 'bf-lane' });
    laneEls.push(p);
    lanes.append(p);
  }
  const pcie = h('div.bf-col.bf-pcie', {}, [
    h('div.bf-col-title', {}, [t(api === 'opengl' ? L('PCIe · drivrutinens DMA', 'PCIe · driver DMA') : L('PCIe · kopiering', 'PCIe · copy'))]),
    h('div.bf-lane-host', {}, [lanes]),
    h('div.bf-speed', {}, [
      h('div.mono', { text: 'PCIe 4.0 ×16 ≈ 25 GB/s' }),
      h('div.bf-time.glow-amber', { text: `≈ ${fmtTime(seconds)}` }),
      h('div.bf-buf-sub', { text: t(L('teoretiskt; + några µs uppstart per kopia', 'theoretical; + a few µs setup per copy')) }),
    ]),
  ]);

  // VRAM column
  const vramVB = bar('vertex buffer', l.vertexBytes, 'vb', al.vb);
  const vramIB = bar('index buffer', l.indexBytes, 'ib', al.ib);
  const stateEls = states[api].map(([a, b]) => h('div.bf-state', {}, [h('span.mono', { text: a }), h('small', { text: b })]));
  const vram = h('div.bf-col.bf-vram', {}, [
    h('div.bf-col-title', {}, [h('span.bf-dot.gpu'), t(L('VRAM · GPU', 'VRAM · GPU')), h('span.bf-flags.mono', { text: vramFlags[api] })]),
    vramVB,
    vramIB,
    h('div.bf-rule', { text: t(al.rule) }),
    h('div.bf-states', {}, stateEls),
  ]);

  const statsRow = h('div.stat-row.bf-stats', {}, [
    stat(formatBytes(l.vertexBytes), 'vertex buffer', 'glow-cyan'),
    stat(formatBytes(l.indexBytes), `index buffer · ${l.indexType}`),
    stat(`${al.exact ? '' : '≈ '}${formatBytes(al.vb + al.ib)}`, t(L('i VRAM', 'in VRAM')), 'glow-magenta'),
    stat(`≈ ${fmtTime(seconds)}`, t(L('över PCIe', 'over PCIe')), 'glow-amber'),
  ]);
  const grid = h('div.bf-grid', {}, [ram, pcie, vram]);
  const root = h('div.bf-root', {}, [statsRow, grid]);
  host.append(root);

  const fills = [vramVB, vramIB].map((b) => b.querySelector<HTMLElement>('.bf-fill')!);
  const pads = [vramVB, vramIB].map((b) => b.querySelector<HTMLElement>('.bf-pad'));
  let tweens: gsap.core.Animation[] = [];

  return {
    show(step, animate) {
      tweens.forEach((tw) => tw.kill());
      tweens = [];
      const vis = (el: HTMLElement, on: boolean) => el.classList.toggle('off', !on);
      vis(vramVB, step >= 1);
      vis(vramIB, step >= 1);
      vram.classList.toggle('alloc', step >= 1);
      vis(staging, step >= 2);
      vis(pcie, step >= 3);
      pcie.classList.toggle('live', step === 3);
      vram.classList.toggle('ready', step >= 4);
      stateEls.forEach((e) => vis(e, step >= 4));
      ram.classList.toggle('cur', step === 0 || step === 2);
      vram.classList.toggle('cur', step === 1 || step >= 3);
      // VRAM contents: empty until the copy (step 3).
      fills.forEach((f) => (f.style.transform = `scaleX(${step >= 3 ? 1 : 0})`));
      pads.forEach((p) => p && (p.style.opacity = step >= 1 ? '1' : '0'));
      if (!animate) return;
      if (step === 1) tweens.push(gsap.fromTo([vramVB, vramIB], { opacity: 0, x: 20 }, { opacity: 1, x: 0, stagger: 0.12, duration: dur(0.5) }));
      if (step === 2) tweens.push(gsap.fromTo(staging.querySelector('.bf-fill'), { scaleX: 0 }, { scaleX: 1, duration: dur(1.1), ease: 'power2.inOut', transformOrigin: 'left' }));
      if (step === 3) {
        tweens.push(gsap.fromTo(fills, { scaleX: 0 }, { scaleX: 1, duration: dur(1.6), ease: 'power1.inOut', stagger: 0.25, delay: dur(0.3) }));
        tweens.push(gsap.fromTo(laneEls, { opacity: 0.2 }, { opacity: 1, duration: dur(0.25), stagger: { each: 0.04, repeat: 3, yoyo: true } }));
      }
      if (step === 4) tweens.push(gsap.fromTo(stateEls, { opacity: 0, y: 8 }, { opacity: 1, y: 0, stagger: 0.15, duration: dur(0.4) }));
    },
    destroy() {
      tweens.forEach((tw) => tw.kill());
    },
  };
}

/* ------------------------------------------------------------------ */
/* Concept: packets fly from system RAM across the PCIe bus into VRAM  */
/* ------------------------------------------------------------------ */
interface Pkt {
  t: number; // 0..1 along its route
  speed: number;
  lane: number;
  route: 0 | 1; // 0 = app → staging, 1 = staging → VRAM
  hue: number;
}

function conceptVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const api = ctx.state.api;
  const gl = api === 'opengl';
  const wrap = h('div.v-fill.bf-concept');
  const canvas = h('canvas.bf-canvas');
  const caption = h('div.bf-caption');
  wrap.append(canvas, caption);
  host.append(wrap);
  const g = canvas.getContext('2d')!;
  const apiColor = { opengl: '#5aa9e6', vulkan: '#ff4d64', d3d12: '#6cd04a' }[api];

  let W = 0;
  let H = 0;
  const R = { ram: { x: 0, y: 0, w: 0, h: 0 }, app: { x: 0, y: 0, w: 0, h: 0 }, stg: { x: 0, y: 0, w: 0, h: 0 }, gpu: { x: 0, y: 0, w: 0, h: 0 }, buf: { x: 0, y: 0, w: 0, h: 0 }, die: { x: 0, y: 0, w: 0, h: 0 }, bus: { x0: 0, x1: 0, y0: 0, y1: 0 } };
  const layout = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = wrap.clientWidth;
    H = wrap.clientHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const top = 30;
    const bottom = H - 62;
    const hh = bottom - top;
    const colW = Math.min(W * 0.3, 300);
    R.ram = { x: 16, y: top, w: colW, h: hh };
    R.gpu = { x: W - 16 - colW, y: top, w: colW, h: hh };
    R.app = { x: R.ram.x + 14, y: top + 34, w: colW - 28, h: hh * 0.3 };
    R.stg = { x: R.ram.x + 14, y: top + 34 + hh * 0.3 + 18, w: colW - 28, h: hh * 0.3 };
    R.buf = { x: R.gpu.x + 14, y: top + 34, w: colW - 28, h: hh * 0.38 };
    R.die = { x: R.gpu.x + colW * 0.28, y: R.buf.y + R.buf.h + 22, w: colW * 0.44, h: Math.max(30, bottom - (R.buf.y + R.buf.h + 22) - 12) };
    R.bus = { x0: R.ram.x + R.ram.w, x1: R.gpu.x, y0: R.stg.y + 6, y1: R.stg.y + R.stg.h - 6 };
  };

  let step = 0;
  const fill = { stg: 0, buf: 0, ready: 0, alloc: 0 };
  const pkts: Pkt[] = [];
  let spawnAcc = 0;
  const still = reducedMotion();

  const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
  const routePos = (p: Pkt): [number, number] => {
    if (p.route === 0) {
      // app array → staging (a short hop down inside RAM)
      const sx = R.app.x + R.app.w * (0.15 + 0.7 * p.hue);
      const sy = R.app.y + R.app.h * 0.6;
      const ex = R.stg.x + R.stg.w * (0.15 + 0.7 * p.hue);
      const ey = R.stg.y + R.stg.h * 0.5;
      const k = p.t;
      return [lerp(sx, ex, k) + Math.sin(k * Math.PI) * 24, lerp(sy, ey, k)];
    }
    const laneY = lerp(R.bus.y0, R.bus.y1, (p.lane + 0.5) / 8);
    const sx = R.stg.x + R.stg.w * 0.85;
    const ex = R.buf.x + R.buf.w * (0.1 + 0.8 * p.hue);
    const ey = R.buf.y + R.buf.h * 0.55;
    const k = p.t;
    if (k < 0.12) return [lerp(sx, R.bus.x0, k / 0.12), laneY];
    if (k < 0.82) return [lerp(R.bus.x0, R.bus.x1, (k - 0.12) / 0.7), laneY];
    const k2 = (k - 0.82) / 0.18;
    return [lerp(R.bus.x1, ex, k2), lerp(laneY, ey, k2 * k2)];
  };

  const box = (r: { x: number; y: number; w: number; h: number }, stroke: string, fillStyle: string, glow = 0, dash = false) => {
    g.save();
    g.beginPath();
    g.roundRect(r.x, r.y, r.w, r.h, 12);
    g.fillStyle = fillStyle;
    g.fill();
    if (glow) {
      g.shadowColor = stroke;
      g.shadowBlur = glow;
    }
    if (dash) g.setLineDash([6, 5]);
    g.strokeStyle = stroke;
    g.lineWidth = 1.5;
    g.stroke();
    g.restore();
  };
  const text = (s2: string, x: number, y: number, color: string, size = 11, align: CanvasTextAlign = 'left', weight = 600) => {
    g.fillStyle = color;
    g.font = `${weight} ${size}px Inter, system-ui, sans-serif`;
    g.textAlign = align;
    g.fillText(s2, x, y);
  };
  const cells = (r: { x: number; y: number; w: number; h: number }, level: number, colorA: string, colorB: string, time: number) => {
    const cols = Math.max(6, Math.floor(r.w / 16));
    const rows = Math.max(2, Math.floor((r.h - 26) / 14));
    const cw = (r.w - 16) / cols;
    const ch = (r.h - 28) / rows;
    const n = cols * rows;
    const lit = Math.round(n * level);
    for (let i = 0; i < n; i++) {
      const cx = r.x + 8 + (i % cols) * cw;
      const cy = r.y + 22 + Math.floor(i / cols) * ch;
      const on = i < lit;
      g.fillStyle = on ? ((i % 3) === 2 ? colorB : colorA) : 'rgba(140,160,255,0.08)';
      g.globalAlpha = on ? 0.55 + 0.35 * Math.sin(time * 3 + i * 0.7) ** 2 : 1;
      g.fillRect(cx + 1, cy + 1, cw - 3, ch - 3);
    }
    g.globalAlpha = 1;
  };

  const draw = (time: number) => {
    g.clearRect(0, 0, W, H);
    // --- RAM ---
    box(R.ram, 'rgba(56,225,255,0.55)', 'rgba(56,225,255,0.05)', step === 0 || step === 2 ? 16 : 0);
    text(t(L('SYSTEM-RAM (CPU)', 'SYSTEM RAM (CPU)')), R.ram.x + 14, R.ram.y + 20, '#38e1ff', 11, 'left', 800);
    // DIMM chips decoration along the bottom
    const chipY = R.ram.y + R.ram.h - 18;
    for (let i = 0; i < 8; i++) {
      g.fillStyle = 'rgba(56,225,255,0.12)';
      g.fillRect(R.ram.x + 14 + i * ((R.ram.w - 28) / 8), chipY, (R.ram.w - 28) / 8 - 4, 10);
    }
    box(R.app, 'rgba(56,225,255,0.4)', 'rgba(4,6,16,0.7)');
    text(t(L('dina arrayer: vertices + index', 'your arrays: vertices + indices')), R.app.x + 8, R.app.y + 14, '#9aa3c7', 10.5);
    cells(R.app, 1, '#38e1ff', '#5cf08f', time);
    if (step >= 2) {
      box(R.stg, gl ? 'rgba(155,123,255,0.7)' : apiColor, 'rgba(4,6,16,0.7)', step === 2 ? 14 : 0);
      text(gl ? t(L('drivrutinens staging-kopia', "driver's staging copy")) : api === 'vulkan' ? 'staging · HOST_VISIBLE' : 'staging · UPLOAD heap', R.stg.x + 8, R.stg.y + 14, gl ? '#9b7bff' : apiColor, 10.5);
      cells(R.stg, fill.stg, '#9fdcff', '#a8ffc6', time);
    }

    // --- PCIe bus ---
    const busOn = step >= 3;
    for (let i = 0; i < 8; i++) {
      const y = lerp(R.bus.y0, R.bus.y1, (i + 0.5) / 8);
      g.strokeStyle = busOn ? `rgba(255,181,71,${0.25 + 0.2 * Math.sin(time * 4 + i)})` : 'rgba(140,160,255,0.12)';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(R.bus.x0, y);
      g.lineTo(R.bus.x1, y);
      g.stroke();
    }
    const busMid = (R.bus.x0 + R.bus.x1) / 2;
    text('PCIe 4.0 ×16', busMid, R.bus.y0 - 12, busOn ? '#ffb547' : '#646d94', 11, 'center', 800);
    text(gl ? t(L('DMA styrd av drivrutinen', 'DMA driven by the driver')) : api === 'vulkan' ? 'vkCmdCopyBuffer' : 'CopyBufferRegion', busMid, R.bus.y1 + 20, busOn ? '#e8ebff' : '#646d94', 11, 'center', 600);

    // --- GPU ---
    box(R.gpu, 'rgba(255,63,210,0.55)', 'rgba(255,63,210,0.05)', step === 1 || step >= 3 ? 16 : 0);
    text(t(L('VRAM (GPU)', 'VRAM (GPU)')), R.gpu.x + 14, R.gpu.y + 20, '#ff3fd2', 11, 'left', 800);
    if (step >= 1) {
      const ready = fill.ready;
      box(R.buf, ready > 0.5 ? '#5cf08f' : 'rgba(255,63,210,0.8)', 'rgba(4,6,16,0.7)', ready > 0.5 ? 18 : 0, fill.buf < 0.02);
      text(gl ? 'GL buffer object' : api === 'vulkan' ? 'VkBuffer · DEVICE_LOCAL' : 'DEFAULT heap', R.buf.x + 8, R.buf.y + 14, ready > 0.5 ? '#5cf08f' : '#ff3fd2', 10.5);
      g.globalAlpha = fill.alloc;
      cells(R.buf, fill.buf, '#38e1ff', '#5cf08f', time);
      g.globalAlpha = 1;
    }
    // GPU die
    const d = R.die;
    box(d, step >= 4 ? '#5cf08f' : 'rgba(255,63,210,0.5)', 'rgba(20,10,30,0.9)', step >= 4 ? 10 + 6 * Math.sin(time * 4) : 0);
    text('GPU', d.x + d.w / 2, d.y + d.h / 2 + (step >= 4 ? -3 : 4), step >= 4 ? '#5cf08f' : '#ff3fd2', 13, 'center', 800);
    if (step >= 4) {
      // vertex fetch: arrows from the buffer down into the die
      const k = (time * 1.4) % 1;
      for (let i = 0; i < 3; i++) {
        const x = d.x + d.w * (0.25 + i * 0.25);
        const y = lerp(R.buf.y + R.buf.h, d.y, (k + i * 0.33) % 1);
        g.fillStyle = '#5cf08f';
        g.shadowColor = '#5cf08f';
        g.shadowBlur = 10;
        g.fillRect(x - 3, y - 3, 6, 6);
        g.shadowBlur = 0;
      }
      text(gl ? t(L('implicit synk ✓', 'implicit sync ✓')) : t(L('barriär ✓', 'barrier ✓')), d.x + d.w / 2, d.y + d.h / 2 + 13, '#5cf08f', 10.5, 'center');
    }

    // --- packets ---
    for (const p of pkts) {
      const [x, y] = routePos(p);
      const c = p.route === 0 ? (gl ? '#9b7bff' : apiColor) : '#ffb547';
      g.save();
      g.shadowColor = c;
      g.shadowBlur = 12;
      g.fillStyle = c;
      g.fillRect(x - 4, y - 4, 8, 8);
      g.restore();
    }
  };

  let raf = 0;
  let last = performance.now();
  const t0 = last;
  const frame = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!still) {
      spawnAcc += dt;
      const streaming = (step === 2 && fill.stg < 1) || (step === 3 && fill.buf < 1);
      if (streaming && spawnAcc > 0.05) {
        spawnAcc = 0;
        pkts.push({ t: 0, speed: step === 2 ? 1.4 : 0.9, lane: Math.floor(Math.random() * 8), route: step === 2 ? 0 : 1, hue: Math.random() });
      }
      for (const p of pkts) p.t += p.speed * dt;
      for (let i = pkts.length - 1; i >= 0; i--) {
        const p = pkts[i];
        if (p.t < 1) continue;
        pkts.splice(i, 1);
        if (p.route === 0) fill.stg = Math.min(1, fill.stg + 0.025);
        else fill.buf = Math.min(1, fill.buf + 0.02);
      }
    }
    draw((now - t0) / 1000);
    raf = requestAnimationFrame(frame);
  };
  const ro = new ResizeObserver(() => {
    layout();
    draw((performance.now() - t0) / 1000);
  });
  ro.observe(wrap);
  layout();
  raf = requestAnimationFrame(frame);

  const captions: Text[] = [
    L('Vertices och index ligger i vanligt RAM – på ett separat grafikkort når GPU:n dem bara över PCIe-bussen.', 'Vertices and indices sit in ordinary RAM – on a discrete graphics card the GPU can only reach them over the PCIe bus.'),
    gl
      ? L('glCreateBuffers + glNamedBufferStorage: drivrutinen reserverar minne åt dig, oftast i VRAM.', 'glCreateBuffers + glNamedBufferStorage: the driver reserves memory for you, usually in VRAM.')
      : L('Du reserverar själv en buffert i GPU-lokalt minne – med GPU:ns krav på storlek och alignment.', 'You reserve a buffer in GPU-local memory yourself – with the GPU\'s size and alignment requirements.'),
    gl
      ? L('Drivrutinen kopierar dina bytes till en egen staging-yta innan anropet returnerar.', 'The driver copies your bytes into its own staging area before the call returns.')
      : L('Map + memcpy: bytesen skrivs till en CPU-synlig staging-buffert.', 'Map + memcpy: the bytes are written into a CPU-visible staging buffer.'),
    gl
      ? L('I bakgrunden flyttar en DMA-motor datan över PCIe till VRAM.', 'In the background a DMA engine moves the data across PCIe into VRAM.')
      : L('En kopieringskommando (DMA) flyttar datan över PCIe in i VRAM.', 'A copy command (DMA) moves the data across PCIe into VRAM.'),
    gl
      ? L('Drivrutinen ser till att kopian är klar innan första draw-anropet läser bufferten.', 'The driver makes sure the copy has finished before the first draw reads the buffer.')
      : L('En barriär säger: kopian måste vara klar och synlig innan vertex-steget läser. Sedan kan staging-bufferten släppas.', 'A barrier says: the copy must be finished and visible before the vertex stage reads. Then the staging buffer can be freed.'),
  ];

  return {
    show(st, animate) {
      step = st;
      pkts.length = 0;
      const snap = !animate || still;
      fill.alloc = step >= 1 ? 1 : 0;
      fill.ready = step >= 4 ? 1 : 0;
      fill.stg = step >= 3 || (step === 2 && snap) ? 1 : 0;
      fill.buf = step >= 4 || (step === 3 && snap) ? 1 : 0;
      if (animate && step === 1) gsap.fromTo(fill, { alloc: 0 }, { alloc: 1, duration: dur(0.8) });
      caption.innerHTML = t(captions[step]);
      if (animate) gsap.fromTo(caption, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: dur(0.4) });
    },
    destroy() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      gsap.killTweensOf([fill, caption]);
    },
  };
}

/* ------------------------------------------------------------------ */
/* API panels                                                          */
/* ------------------------------------------------------------------ */
type Line = [string, ...number[]];
function snippet(lang: CodeSnippet['lang'], lines: Line[], steps: number, title?: Text): CodeSnippet {
  const highlight = Array.from({ length: steps }, (_, st) => lines.flatMap(([, ...on], i) => (on.includes(st) ? [i + 1] : [])));
  return { lang, title, src: lines.map((x) => x[0]).join('\n'), highlight };
}

function apis(ctx: SlideContext): Record<ApiId, ApiPanelSpec> {
  const l = ctx.derived.layout;
  const vb = l.vertexBytes;
  const ib = l.indexBytes;
  const S = 5;
  return {
    opengl: {
      note: L(
        'I OpenGL är uppladdning ett enda anrop. glNamedBufferStorage kopierar dina bytes innan den returnerar; drivrutinen väljer minnestyp, sköter staging, DMA-kopian och synkroniseringen åt dig.',
        'In OpenGL an upload is a single call. glNamedBufferStorage copies your bytes before it returns; the driver picks the memory type and handles staging, the DMA copy and synchronization for you.',
      ),
      code: [
        snippet('cpp', [
          [`// vertices (${vb} B) and indices (${ib} B) live in system RAM`, 0],
          ['GLuint vbo, ibo;'],
          ['glCreateBuffers(1, &vbo);', 1],
          [`glNamedBufferStorage(vbo, ${vb}, vertices.data(), 0); // flags 0: immutable, GPU-only`, 1, 2, 3],
          ['glCreateBuffers(1, &ibo);', 1],
          [`glNamedBufferStorage(ibo, ${ib}, indices.data(), 0);`, 1, 2, 3],
          ['// returns once your bytes are copied – vertices may be freed now', 2],
          ['// the driver places the buffer (usually VRAM) and DMAs it over PCIe', 3],
          ['// the first draw that reads vbo waits for that copy (implicit sync)', 4],
          [`glVertexArrayVertexBuffer(vao, 0, vbo, 0, ${l.stride});  // next slide`, 4],
          ['// GL 3.x style: glGenBuffers + glBindBuffer + glBufferData(…, GL_STATIC_DRAW)'],
        ], S, L('Uppladdning', 'Upload')),
      ],
      terms: [
        { term: 'glNamedBufferStorage', desc: L('Immutable storage (GL 4.4/4.5 DSA): storleken kan inte ändras – drivrutinen kan placera den optimalt.', 'Immutable storage (GL 4.4/4.5 DSA): the size can never change – the driver can place it optimally.') },
        { term: 'flags = 0', desc: L('Ingen GL_MAP_*/GL_DYNAMIC_STORAGE_BIT → CPU:n skriver aldrig igen → VRAM.', 'No GL_MAP_*/GL_DYNAMIC_STORAGE_BIT → the CPU never writes again → VRAM.') },
        { term: 'DMA', desc: L('Kopieringsmotor på GPU:n som flyttar data över PCIe utan CPU:n.', 'Copy engine on the GPU that moves data across PCIe without the CPU.') },
      ],
      you: L('ett anrop per buffert', 'one call per buffer'),
      driver: L('minnestyp, staging, kopia, synk', 'memory type, staging, copy, sync'),
    },
    vulkan: {
      note: L(
        'I Vulkan gör du allt själv: skapa bufferten, fråga efter minneskrav, välj minnestyp, allokera och bind. Data går via en HOST_VISIBLE staging-buffert, vkCmdCopyBuffer flyttar den till DEVICE_LOCAL, och en barriär gör den synlig för vertex input.',
        'In Vulkan you do everything: create the buffer, query memory requirements, choose a memory type, allocate and bind. Data goes through a HOST_VISIBLE staging buffer, vkCmdCopyBuffer moves it to DEVICE_LOCAL, and a barrier makes it visible to vertex input.',
      ),
      code: [
        snippet('cpp', [
          [`// vertices: std::vector<Vertex> in system RAM, ${vb} B`, 0],
          ['VkBufferCreateInfo bi{ VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO };', 1],
          [`bi.size  = ${vb};`, 1],
          ['bi.usage = VK_BUFFER_USAGE_VERTEX_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT;', 1],
          ['vkCreateBuffer(dev, &bi, nullptr, &vertexBuffer);', 1],
          ['VkMemoryRequirements req;   // size, alignment, memoryTypeBits', 1],
          ['vkGetBufferMemoryRequirements(dev, vertexBuffer, &req);', 1],
          ['VkMemoryAllocateInfo ai{ VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO };', 1],
          ['ai.allocationSize  = req.size;', 1],
          ['ai.memoryTypeIndex = findMemoryType(req.memoryTypeBits, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT);', 1],
          ['vkAllocateMemory(dev, &ai, nullptr, &vertexMemory);   // real apps: VMA', 1],
          ['vkBindBufferMemory(dev, vertexBuffer, vertexMemory, 0);', 1],
          ['// staging buffer: TRANSFER_SRC, HOST_VISIBLE | HOST_COHERENT (same steps)', 2],
          [`void* p;  vkMapMemory(dev, stagingMemory, 0, ${vb}, 0, &p);`, 2],
          [`memcpy(p, vertices.data(), ${vb});  vkUnmapMemory(dev, stagingMemory);`, 2],
          [`VkBufferCopy region{ 0, 0, ${vb} };   // srcOffset, dstOffset, size`, 3],
          ['vkCmdCopyBuffer(cmd, stagingBuffer, vertexBuffer, 1, &region);', 3],
          ['VkBufferMemoryBarrier2 b{ VK_STRUCTURE_TYPE_BUFFER_MEMORY_BARRIER_2 };', 4],
          ['b.srcStageMask = VK_PIPELINE_STAGE_2_COPY_BIT;  b.srcAccessMask = VK_ACCESS_2_TRANSFER_WRITE_BIT;', 4],
          ['b.dstStageMask = VK_PIPELINE_STAGE_2_VERTEX_ATTRIBUTE_INPUT_BIT;  b.dstAccessMask = VK_ACCESS_2_VERTEX_ATTRIBUTE_READ_BIT;', 4],
          ['b.srcQueueFamilyIndex = b.dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;', 4],
          ['b.buffer = vertexBuffer;  b.size = VK_WHOLE_SIZE;', 4],
          ['VkDependencyInfo dep{ VK_STRUCTURE_TYPE_DEPENDENCY_INFO, nullptr, 0, 0, nullptr, 1, &b };', 4],
          ['vkCmdPipelineBarrier2(cmd, &dep);   // then vkQueueSubmit2, wait, free staging', 4],
        ], S, L('Uppladdning', 'Upload')),
      ],
      terms: [
        { term: 'memory type', desc: L('Kombination av flaggor (DEVICE_LOCAL, HOST_VISIBLE, HOST_COHERENT …) i en minnes-heap.', 'A combination of flags (DEVICE_LOCAL, HOST_VISIBLE, HOST_COHERENT …) within a memory heap.') },
        { term: 'VMA', desc: L('Vulkan Memory Allocator: suballokerar ur stora block – maxMemoryAllocationCount är ofta bara 4096.', 'Vulkan Memory Allocator: sub-allocates from big blocks – maxMemoryAllocationCount is often only 4096.') },
        { term: 'staging buffer', desc: L('CPU-skrivbar mellanbuffert i system-RAM som GPU:n kopierar från.', 'CPU-writable intermediate buffer in system RAM that the GPU copies from.') },
        { term: 'ReBAR', desc: L('Med Resizable BAR finns DEVICE_LOCAL | HOST_VISIBLE – då kan CPU:n skriva direkt i VRAM.', 'With Resizable BAR there is DEVICE_LOCAL | HOST_VISIBLE – the CPU can then write straight into VRAM.') },
      ],
      you: L('allokering, staging, kopia, barriär', 'allocation, staging, copy, barrier'),
      driver: L('nästan inget – det är poängen', 'almost nothing – that is the point'),
    },
    d3d12: {
      note: L(
        'I D3D12 skapar du två resurser: en i DEFAULT-heapen (VRAM) och en i UPLOAD-heapen (CPU-skrivbar). Map + memcpy, CopyBufferRegion på en command list, och en ResourceBarrier från COPY_DEST till VERTEX_AND_CONSTANT_BUFFER.',
        'In D3D12 you create two resources: one in the DEFAULT heap (VRAM) and one in the UPLOAD heap (CPU-writable). Map + memcpy, CopyBufferRegion on a command list, and a ResourceBarrier from COPY_DEST to VERTEX_AND_CONSTANT_BUFFER.',
      ),
      code: [
        snippet('cpp', [
          [`// vertices: std::vector<Vertex> in system RAM, ${vb} B`, 0],
          [`auto desc = CD3DX12_RESOURCE_DESC::Buffer(${vb});`, 1],
          ['CD3DX12_HEAP_PROPERTIES vram(D3D12_HEAP_TYPE_DEFAULT), upload(D3D12_HEAP_TYPE_UPLOAD);', 1, 2],
          ['device->CreateCommittedResource(&vram, D3D12_HEAP_FLAG_NONE, &desc,', 1],
          [`    D3D12_RESOURCE_STATE_COMMON, nullptr, IID_PPV_ARGS(&vertexBuffer)); // ${formatBytes(alignUp(vb, 65536))} heap`, 1],
          ['device->CreateCommittedResource(&upload, D3D12_HEAP_FLAG_NONE, &desc,', 2],
          ['    D3D12_RESOURCE_STATE_GENERIC_READ, nullptr, IID_PPV_ARGS(&staging));', 2],
          ['void* p;  CD3DX12_RANGE noRead(0, 0);   // the CPU will not read', 2],
          ['staging->Map(0, &noRead, &p);', 2],
          [`memcpy(p, vertices.data(), ${vb});`, 2],
          ['staging->Unmap(0, nullptr);', 2],
          [`cmdList->CopyBufferRegion(vertexBuffer.Get(), 0, staging.Get(), 0, ${vb});`, 3],
          ['auto toVB = CD3DX12_RESOURCE_BARRIER::Transition(vertexBuffer.Get(),', 4],
          ['    D3D12_RESOURCE_STATE_COPY_DEST, D3D12_RESOURCE_STATE_VERTEX_AND_CONSTANT_BUFFER);', 4],
          ['cmdList->ResourceBarrier(1, &toVB);  // index buffer → D3D12_RESOURCE_STATE_INDEX_BUFFER', 4],
          ['cmdList->Close();', 3],
          ['queue->ExecuteCommandLists(1, CommandListCast(cmdList.GetAddressOf()));', 3],
          ['// Signal a fence and wait before releasing `staging`', 4],
        ], S, L('Uppladdning', 'Upload')),
      ],
      terms: [
        { term: 'D3D12_HEAP_TYPE_UPLOAD', desc: L('CPU-skrivbart (write-combined) system-RAM som GPU:n läser över PCIe.', 'CPU-writable (write-combined) system RAM that the GPU reads over PCIe.') },
        { term: 'D3D12_HEAP_TYPE_DEFAULT', desc: L('GPU-lokalt minne (VRAM); CPU:n kan inte mappa det.', 'GPU-local memory (VRAM); the CPU cannot map it.') },
        { term: '64 KiB', desc: L('Buffertar placeras alltid med 64 KiB alignment – många små committed resources slösar minne.', 'Buffers are always placed with 64 KiB alignment – many small committed resources waste memory.') },
        { term: 'COMMON → COPY_DEST', desc: L('Buffertar skapas i COMMON och befordras implicit till COPY_DEST vid kopian.', 'Buffers are created in COMMON and implicitly promoted to COPY_DEST by the copy.') },
        { term: 'enhanced barriers', desc: L('Agility SDK: ID3D12GraphicsCommandList7::Barrier med ACCESS_COPY_DEST → ACCESS_VERTEX_BUFFER.', 'Agility SDK: ID3D12GraphicsCommandList7::Barrier with ACCESS_COPY_DEST → ACCESS_VERTEX_BUFFER.') },
      ],
      you: L('heaps, kopia, barriär, fence', 'heaps, copy, barrier, fence'),
      driver: L('sidtabeller och residency', 'page tables and residency'),
    },
  };
}

export default standardSlide({
  id: 'buffers',
  group: 'api',
  short: L('Buffertar', 'Buffers'),
  title: L('Buffertar & uppladdning', 'Buffers & upload'),
  lead: L(
    'Vertices och index måste flyttas från system-RAM till grafikkortets eget minne. Här skiljer sig API:erna som mest: OpenGL gör det åt dig, Vulkan och D3D12 låter dig styra varje byte.',
    'Vertices and indices have to move from system RAM into the graphics card\'s own memory. This is where the APIs differ the most: OpenGL does it for you, Vulkan and D3D12 let you control every byte.',
  ),
  bullets: [
    L('Datan ligger i <b>system-RAM</b> som vanliga C++-arrayer. Ett separat grafikkort når den bara via PCIe-bussen.', 'The data sits in <b>system RAM</b> as ordinary C++ arrays. A discrete graphics card can only reach it over the PCIe bus.'),
    L('<b>Skapa bufferten</b> i GPU-minne. Minnet har krav på <i>alignment</i> – D3D12 avrundar committed buffers till 64 KiB, Vulkan rapporterar sina krav i <code>VkMemoryRequirements</code>.', '<b>Create the buffer</b> in GPU memory. Memory has <i>alignment</i> requirements – D3D12 rounds committed buffers up to 64 KiB, Vulkan reports its needs in <code>VkMemoryRequirements</code>.'),
    L('<b>Staging</b>: bytesen skrivs med <code>memcpy</code> till ett CPU-synligt minne (UPLOAD-heap / HOST_VISIBLE). I OpenGL gör drivrutinen den kopian.', '<b>Staging</b>: the bytes are written with <code>memcpy</code> into CPU-visible memory (UPLOAD heap / HOST_VISIBLE). In OpenGL the driver makes that copy.'),
    L('<b>Kopiering</b> över PCIe till VRAM med en DMA-motor: <code>vkCmdCopyBuffer</code> / <code>CopyBufferRegion</code>.', '<b>Copy</b> across PCIe into VRAM with a DMA engine: <code>vkCmdCopyBuffer</code> / <code>CopyBufferRegion</code>.'),
    L('<b>Barriär</b>: kopian måste vara klar och synlig innan vertex-steget läser. Explicit i Vulkan/D3D12, implicit i OpenGL.', '<b>Barrier</b>: the copy must be finished and visible before the vertex stage reads. Explicit in Vulkan/D3D12, implicit in OpenGL.'),
  ],
  api: apis,
  data: dataVisual,
  concept: conceptVisual,
});
