import { BoxGeometry, DataTexture, DoubleSide, EdgesGeometry, Group, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, NearestFilter, PlaneGeometry, RGBAFormat, ShaderMaterial, Vector3 } from 'three';
import { SHOWCASE_ROT_X, SHOWCASE_ROT_Y } from '../core/derived';
import { h, s } from '../core/dom';
import { L } from '../core/i18n';
import type { ApiId } from '../core/state';
import { renderMesh } from '../pipeline/raster';
import { createModelStage, secs, type ModelStage } from '../views/ModelStage';
import { COLORS, label } from '../views/three-helpers';
import { stat } from '../views/widgets';
import { glowDot, lineSet, loopPts, setLines } from './14-rasterization';
import { standardSlide } from './standard';
import type { ApiPanelSpec, SlideContext, Visual } from './types';
import '../styles/slides/present.css';

const REFRESH_MS = 1000 / 60;
const toSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

function encodeSrgb(rgba: Uint8ClampedArray): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) lut[i] = Math.round(toSrgb(i / 255) * 255);
  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    out[i] = lut[rgba[i]];
    out[i + 1] = lut[rgba[i + 1]];
    out[i + 2] = lut[rgba[i + 2]];
    out[i + 3] = 255;
  }
  return out;
}

/** Per-API swapchain facts shown in the data view. */
const SWAP: Record<ApiId, { count: number; format: string; srgb: string; modes: [string, string, string] }> = {
  opengl: {
    count: 2,
    format: 'GL_SRGB8_ALPHA8',
    srgb: 'glEnable(GL_FRAMEBUFFER_SRGB)',
    modes: ['SwapInterval(1)', 'SwapInterval(-1) *', 'SwapInterval(0)'],
  },
  vulkan: {
    count: 3,
    format: 'VK_FORMAT_B8G8R8A8_SRGB',
    srgb: 'VK_COLOR_SPACE_SRGB_NONLINEAR_KHR',
    modes: ['PRESENT_MODE_FIFO_KHR', 'PRESENT_MODE_MAILBOX_KHR', 'PRESENT_MODE_IMMEDIATE_KHR'],
  },
  d3d12: {
    count: 2,
    format: 'DXGI_FORMAT_R8G8B8A8_UNORM',
    srgb: 'RTV: R8G8B8A8_UNORM_SRGB',
    modes: ['Present(1, 0)', 'Present(0, 0)', 'Present(0, ALLOW_TEARING)'],
  },
};

/** An RGBA image (rows top-down, values as displayed) as a texture the 3D view shows unchanged. */
function imageTexture(rgba: Uint8ClampedArray, w: number, hh: number): DataTexture {
  const data = new Uint8Array(w * hh * 4);
  for (let y = 0; y < hh; y++) data.set(rgba.subarray((hh - 1 - y) * w * 4, (hh - y) * w * 4), y * w * 4);
  const tex = new DataTexture(data, w, hh, RGBAFormat);
  tex.magFilter = NearestFilter;
  tex.minFilter = NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

const DECODE = /* glsl */ `
vec3 dec(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
`;
// The images are sRGB-encoded bytes; decode so the view's own sRGB output shows them unchanged.
const SCREEN_FRAG = DECODE + /* glsl */ `
uniform sampler2D uA;
uniform sampler2D uB;
uniform float uSplitX;
uniform float uSplitY;
uniform float uScan;
uniform float uTear;
uniform float uFlash;
uniform vec2 uGrid;
varying vec2 vUv;
void main() {
  float row = 1.0 - vUv.y;
  bool useB = vUv.x > uSplitX || row > uSplitY;
  vec3 c = dec(useB ? texture2D(uB, vUv).rgb : texture2D(uA, vUv).rgb);
  vec2 f = fract(vUv * uGrid);
  c *= 0.9 + 0.1 * step(0.12, min(f.x, f.y));
  if (uScan >= 0.0) {
    float d = row - uScan;
    c += vec3(0.55, 0.92, 1.0) * (smoothstep(0.012, 0.0, abs(d)) * 1.1 + smoothstep(-0.12, 0.0, d) * step(d, 0.0) * 0.12);
  }
  c += vec3(1.0, 0.35, 0.43) * smoothstep(0.008, 0.0, abs(row - uSplitY)) * uTear * 1.4;
  c += vec3(0.75, 0.95, 1.0) * smoothstep(0.006, 0.0, abs(vUv.x - uSplitX)) * step(uSplitX, 1.0);
  c += vec3(0.22, 0.88, 1.0) * uFlash * 0.25;
  gl_FragColor = vec4(c, 1.0);
}
`;
const CARD_FRAG = DECODE + /* glsl */ `
uniform sampler2D uTex;
uniform float uReveal;
uniform float uDim;
uniform vec3 uEdge;
varying vec2 vUv;
void main() {
  float row = 1.0 - vUv.y;
  vec3 c = dec(texture2D(uTex, vUv).rgb);
  if (row > uReveal) c = vec3(0.02, 0.03, 0.08);
  c += uEdge * smoothstep(0.02, 0.0, abs(row - uReveal)) * step(uReveal, 0.999) * 1.4;
  gl_FragColor = vec4(c * uDim, 1.0);
}
`;
const VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';

type Mode = 'fifo' | 'mailbox' | 'immediate';
interface Frame {
  k: number;
  start: number;
  end: number;
  /** When it reaches the screen (in refreshes; fractional for IMMEDIATE). */
  shown: number;
  late: boolean;
}

/**
 * When each frame is drawn and shown, in units of display refreshes. `work(k)` = render time
 * of frame k in refreshes. A frame needs a free swapchain image to start; FIFO/MAILBOX flip at
 * vblank (MAILBOX: the newest finished frame wins), IMMEDIATE flips as soon as a frame is done.
 */
function schedule(work: (k: number) => number, images: number, mode: Mode, total = 80): Frame[] {
  const out: Frame[] = [];
  for (let k = 0; k < total; k++) {
    const prev = out[k - 1];
    let start = prev ? prev.end : 0;
    // Frame k renders into image k % images, which is free once frame k − images + 1 is on screen.
    // MAILBOX never waits: the queued image is simply replaced.
    const j = k - images + 1;
    if (mode !== 'mailbox' && j >= 0 && j < k) start = Math.max(start, out[j].shown);
    const end = start + work(k);
    let shown = mode === 'immediate' ? end : Math.ceil(end - 1e-9);
    if (mode === 'fifo' && prev) shown = Math.max(shown, prev.shown + 1);
    out.push({ k, start, end, shown, late: work(k) > 1 });
  }
  // MAILBOX: of several frames finishing before the same vblank, only the newest is shown.
  if (mode === 'mailbox') for (let i = 0; i < out.length - 1; i++) if (out[i + 1].shown === out[i].shown) out[i].shown = -1;
  return out;
}

interface PresentScene {
  /** Swapchain images in 3D. */
  cards: { group: Group; mat: ShaderMaterial; border: LineSegments; label: ReturnType<typeof label> }[];
  screenMat: ShaderMaterial;
  monitor: Group;
  status: ReturnType<typeof label>;
  modeLabel: ReturnType<typeof label>;
  stream: ReturnType<ModelStage['particles']>;
  /** Run the swapchain simulation (null = stop). */
  run(opts: { work: (k: number) => number; mode: Mode; period: number; swap?: boolean } | null): void;
  /** Called each time the frame on screen changes. */
  onFlip: ((front: number, refresh: number, repeated: boolean) => void) | null;
}

/** Monitor + swapchain cards + the model rendering into them. Shared by both modes. */
function presentScene(ms: ModelStage, ctx: SlideContext, frames: Uint8ClampedArray[], FW: number, FH: number, images: number, names: (i: number, role: string) => string): PresentScene {
  const { t } = ctx;
  const texes = frames.map((f) => imageTexture(f, FW, FH));
  // The model, smaller, on the left: it is what gets rendered.
  ms.pivot.position.set(-1.45, 0.25, 0.2);
  ms.pivot.scale.setScalar(0.42);
  // Monitor on the right.
  const SW = 1.5;
  const SH = SW / 1.6;
  const monitor = new Group();
  monitor.position.set(0.85, 0.3, 0);
  monitor.rotation.y = -0.12;
  ms.scene.add(monitor);
  const bezelGeo = new BoxGeometry(SW + 0.12, SH + 0.12, 0.08);
  const bezel = new Mesh(bezelGeo, new MeshBasicMaterial({ color: 0x0b0e1f }));
  bezel.position.z = -0.045;
  monitor.add(bezel);
  const bezelEdges = new LineSegments(new EdgesGeometry(bezelGeo), new LineBasicMaterial({ color: 0x5a6aa8, transparent: true, opacity: 0.8 }));
  bezelEdges.position.z = -0.045;
  monitor.add(bezelEdges);
  const neck = new Mesh(new BoxGeometry(0.12, 0.32, 0.05), new MeshBasicMaterial({ color: 0x1a2040 }));
  neck.position.set(0, -SH / 2 - 0.2, -0.06);
  const foot = new Mesh(new BoxGeometry(0.62, 0.04, 0.3), new MeshBasicMaterial({ color: 0x1a2040 }));
  foot.position.set(0, -SH / 2 - 0.37, -0.06);
  monitor.add(neck, foot);
  const screenMat = new ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: SCREEN_FRAG,
    uniforms: {
      uA: { value: texes[0] },
      uB: { value: texes[0] },
      uSplitX: { value: 2 },
      uSplitY: { value: 2 },
      uScan: { value: -1 },
      uTear: { value: 0 },
      uFlash: { value: 0 },
      uGrid: { value: [FW, FH] },
    },
  });
  const screen = new Mesh(new PlaneGeometry(SW, SH), screenMat);
  monitor.add(screen);
  const hz = label('60 Hz · 16.67 ms', 'amber');
  hz.position.set(SW / 2 - 0.3, -SH / 2 - 0.12, 0);
  monitor.add(hz);
  const status = label('', 'big');
  status.position.set(0, SH / 2 + 0.14, 0);
  monitor.add(status);
  const modeLabel = label('', 'big');
  modeLabel.position.set(-SW / 2 + 0.35, -SH / 2 - 0.12, 0);
  monitor.add(modeLabel);

  // Swapchain images: a column between the model and the monitor.
  const CWd = 0.56;
  const CHd = CWd / 1.6;
  const cards = Array.from({ length: images }, (_, i) => {
    const group = new Group();
    group.position.set(-0.4, 0.78 - i * (CHd + 0.2), 0.25);
    group.rotation.y = 0.12;
    ms.scene.add(group);
    const mat = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: CARD_FRAG,
      side: DoubleSide,
      uniforms: { uTex: { value: texes[i % texes.length] }, uReveal: { value: 1 }, uDim: { value: 1 }, uEdge: { value: [1, 0.71, 0.28] } },
    });
    group.add(new Mesh(new PlaneGeometry(CWd, CHd), mat));
    const c = [new Vector3(-CWd / 2 - 0.02, -CHd / 2 - 0.02, 0.002), new Vector3(CWd / 2 + 0.02, -CHd / 2 - 0.02, 0.002), new Vector3(CWd / 2 + 0.02, CHd / 2 + 0.02, 0.002), new Vector3(-CWd / 2 - 0.02, CHd / 2 + 0.02, 0.002)];
    const border = lineSet(group, loopPts(c), COLORS.cyan, 0.9);
    const lb = label(names(i, ''), '');
    lb.position.set(0, CHd / 2 + 0.09, 0);
    group.add(lb);
    return { group, mat, border, label: lb };
  });
  const beam = lineSet(ms.scene, [], COLORS.cyan, 0.7);
  const stream = ms.particles(260, COLORS.amber, 0.03, 'world');
  stream.points.visible = false;
  const modelCenter = new Vector3(-1.45, 0.25, 0.2);
  const streamFrom = ms.samplePositions(260);
  for (let i = 0; i < 260; i++) {
    streamFrom[i * 3] = streamFrom[i * 3] * 0.42 + modelCenter.x;
    streamFrom[i * 3 + 1] = streamFrom[i * 3 + 1] * 0.42 + modelCenter.y;
    streamFrom[i * 3 + 2] = streamFrom[i * 3 + 2] * 0.42 + modelCenter.z;
  }
  const streamTo = new Float32Array(260 * 3);
  const aimStream = (card: number) => {
    const g = cards[card].group;
    for (let i = 0; i < 260; i++) {
      const p = new Vector3((Math.random() - 0.5) * CWd, (Math.random() - 0.5) * CHd, 0).applyEuler(g.rotation).add(g.position);
      p.toArray(streamTo, i * 3);
    }
    stream.setTargets(streamFrom, streamTo);
  };

  let sim: { work: (k: number) => number; mode: Mode; period: number; swap?: boolean; frames: Frame[]; t0: number } | null = null;
  let now = 0;
  let lastFront = -2;
  let lastDrawing = -2;
  let lastRefresh = -1;
  let flipAt = -10;
  const scene: PresentScene = {
    cards,
    screenMat,
    monitor,
    status,
    modeLabel,
    stream,
    onFlip: null,
    run(o) {
      lastFront = lastDrawing = -2;
      lastRefresh = -1;
      sim = o ? { ...o, frames: schedule(o.work, images, o.mode), t0: now } : null;
      const swap = !!o && o.swap !== false;
      stream.points.visible = swap;
      cards.forEach((c) => (c.group.visible = swap));
      beam.visible = swap;
      screenMat.uniforms.uScan.value = o ? 0 : -1;
      screenMat.uniforms.uSplitY.value = 2;
      screenMat.uniforms.uTear.value = 0;
    },
  };
  ms.onFrame((time) => {
    now = time;
    screenMat.uniforms.uFlash.value = Math.max(0, 1 - (time - flipAt) / 0.35);
    if (!sim) return;
    const tr = (time - sim.t0) / sim.period; // time in refreshes
    const fr = sim.frames;
    const horizon = fr[fr.length - 1].start;
    const T = tr % Math.max(1, Math.floor(horizon));
    const refresh = Math.floor(T);
    const scan = T - refresh;
    screenMat.uniforms.uScan.value = scan;
    // Front: the newest frame that has reached the screen.
    let front = -1;
    let prevFront = -1;
    for (const f of fr) if (f.shown >= 0 && f.shown <= T) {
      prevFront = front;
      front = f.k;
    }
    const drawing = fr.find((f) => f.start <= T && T < f.end);
    // IMMEDIATE: a flip during this refresh tears the image at the flip position.
    if (sim.mode === 'immediate' && front >= 0) {
      const f = fr[front];
      const inThis = f.shown > refresh && f.shown <= T;
      screenMat.uniforms.uA.value = texes[(inThis && prevFront >= 0 ? prevFront : front) % texes.length];
      screenMat.uniforms.uB.value = texes[front % texes.length];
      screenMat.uniforms.uSplitY.value = inThis ? f.shown - refresh : 2;
      screenMat.uniforms.uTear.value = inThis ? 1 : 0;
    } else if (front >= 0) {
      screenMat.uniforms.uA.value = texes[front % texes.length];
      screenMat.uniforms.uSplitY.value = 2;
      screenMat.uniforms.uTear.value = 0;
    }
    if (refresh !== lastRefresh) {
      const repeated = front === lastFront && lastRefresh >= 0;
      lastRefresh = refresh;
      if (front !== lastFront) flipAt = time;
      scene.onFlip?.(front, refresh, repeated);
      status.element.textContent =
        front < 0 || sim.swap === false ? `vblank ${refresh}` : repeated ? t(L(`vblank ${refresh} · samma bild igen!`, `vblank ${refresh} · same image again!`)) : t(L(`vblank ${refresh} · bild #${front}`, `vblank ${refresh} · image #${front}`));
      status.element.style.color = repeated ? 'var(--red)' : '';
      lastFront = front;
    }
    if (sim.swap === false) return;
    // Cards: which image holds which frame, and its role.
    cards.forEach((c, i) => {
      let role = 'free';
      let reveal = 1;
      let k = -1;
      for (const f of fr) {
        if (f.k % images !== i || f.start > T) continue;
        k = f.k;
        if (f.end > T) {
          role = 'draw';
          reveal = (T - f.start) / Math.max(1e-6, f.end - f.start);
        } else if (f.k === front) role = 'front';
        else if (f.shown > T || (sim!.mode === 'mailbox' && f.shown < 0 && f.k > front)) role = 'queued';
        else role = 'free';
      }
      if (k >= 0) c.mat.uniforms.uTex.value = texes[k % texes.length];
      c.mat.uniforms.uReveal.value = role === 'draw' ? reveal : k >= 0 ? 1 : 0;
      c.mat.uniforms.uDim.value = role === 'free' ? 0.45 : 1;
      const col = role === 'front' ? COLORS.cyan : role === 'draw' ? COLORS.amber : role === 'queued' ? COLORS.violet : 0x4a5276;
      (c.border.material as LineBasicMaterial).color.set(col);
      c.label.element.textContent = names(i, role);
      c.label.element.style.color = `#${col.toString(16).padStart(6, '0')}`;
      if (role === 'front') setLines(beam, [c.group.position.clone().add(new Vector3(CWd / 2 + 0.03, 0, 0)), monitor.position.clone().add(new Vector3(-SW / 2, 0, 0.02))]);
    });
    // The model shows the frame being drawn; particles fly into that image.
    if (drawing && drawing.k !== lastDrawing) {
      lastDrawing = drawing.k;
      ms.pivot.rotation.y = SHOWCASE_ROT_Y + (drawing.k % texes.length) * 0.45;
      aimStream(drawing.k % images);
      stream.progress(0, 0);
      stream.progress(1, Math.max(0.3, (drawing.end - drawing.start) * sim.period));
    }
    stream.points.visible = !!drawing;
  });
  return scene;
}

/* ------------------------------------------------------------------ */
/* Real data                                                           */
/* ------------------------------------------------------------------ */
function dataVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const api = ctx.state.api;
  const sw = SWAP[api];
  const IW = 320;
  const IH = 200;
  const final = ctx.derived.render(api, IW, IH);
  const srgb = encodeSrgb(final.color);
  // Three consecutive "frames" (the model keeps turning) for the swap and present-mode views.
  const FW = 160;
  const FH = 100;
  const frames = [0, 1, 2].map((k) => encodeSrgb(ctx.derived.render(api, FW, FH, { rotY: SHOWCASE_ROT_Y + k * 0.45 }).color));

  const ms = createModelStage(host, ctx, { autoRotate: 0, shift: -0.17, eye: [-0.1, 0.75, 5.3], bloom: 0.4, bloomThreshold: 0.88, orbit: true });
  const names = (i: number, role: string) =>
    `${api === 'opengl' ? (role === 'front' ? 'FRONT' : 'BACK') : `#${i}`}${role ? ' · ' + t(role === 'front' ? L('visas', 'on screen') : role === 'draw' ? L('ritas i', 'being drawn') : role === 'queued' ? L('i kö', 'queued') : L('ledig', 'free')) : ''}`;
  const pres = presentScene(ms, ctx, frames, FW, FH, sw.count, names);
  // Step 0: the finished image, linear vs sRGB.
  const linTex = imageTexture(final.color, IW, IH);
  const srgbTex = imageTexture(srgb, IW, IH);

  let probe = (IH >> 1) * IW + (IW >> 1);
  for (let best = Infinity, p = 0; p < IW * IH; p++) {
    if (final.depth[p] >= 1) continue;
    const d = Math.abs(final.color[p * 4] / 255 - 0.42) + Math.abs(final.color[p * 4 + 2] / 255 - 0.1);
    if (d < best) {
      best = d;
      probe = p;
    }
  }
  const lin = [0, 1, 2].map((i) => final.color[probe * 4 + i]);
  const probeDot = glowDot(pres.monitor, new Vector3(((probe % IW) / IW - 0.5) * 1.5, (0.5 - Math.floor(probe / IW) / IH) * (1.5 / 1.6), 0.01), COLORS.white, 0.07);

  /* ---------- Panels ---------- */
  const numbers = ms.panel('', []);
  const numHead = numbers.querySelector('.ms-head span')!;
  const numBody = numbers.querySelector('.ms-body')!;
  const timeline = h('div.pr-timeline3');
  const modes = h('div.pr-modes3');
  const extra = ms.panel('', [timeline, modes]);
  const extraHead = extra.querySelector('.ms-head span')!;
  let step = 0;
  let measured: number | null = null;
  let timer = 0;
  let raf = 0;
  let front = 0;
  let modeIdx = 0;

  const row = (k: string, v: string, cls = '') => `<div class="pr-row"><span>${k}</span><b class="${cls}">${v}</b></div>`;
  const mb = (bytes: number) => (bytes >= 1 << 20 ? `${(bytes / (1 << 20)).toFixed(1)} MiB` : `${(bytes / 1024).toFixed(0)} KiB`);
  const statRow = (items: [string, string, string?][]) => `<div class="stat-row">${items.map(([v, k, c]) => stat(v, k, c ?? '').outerHTML).join('')}</div>`;
  const thumbs = () =>
    Array.from({ length: sw.count }, (_, i) => {
      const role = i === front % sw.count ? 'front' : 'back';
      return `<div class="pr-thumb ${role}"><canvas data-i="${i}" width="${FW}" height="${FH}"></canvas><span>${names(i, role === 'front' ? 'front' : '')}</span></div>`;
    }).join('');
  const paintThumbs = () =>
    numBody.querySelectorAll<HTMLCanvasElement>('.pr-thumb canvas').forEach((c) => {
      const i = Number(c.dataset.i);
      c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(frames[i % frames.length]), FW, FH), 0, 0);
    });
  const titles = [L('Färdig back buffer', 'Finished back buffer'), L('Swapchain', 'Swapchain'), L('Tajming med vsync', 'Timing with vsync'), L('Presentationslägen', 'Present modes')];
  const updateSide = () => {
    numHead.textContent = t(titles[step]);
    let html = '';
    if (step === 0) {
      html = `${statRow([[`${IW}×${IH}`, t(L('upplösning', 'resolution'))], [mb(IW * IH * 4), 'RGBA8'], [mb(1920 * 1080 * 4), '@ 1920×1080']])}
        ${row(t(L('format', 'format')), sw.format.replace('VK_FORMAT_', '').replace('DXGI_FORMAT_', '').replace('GL_', ''), 'glow-cyan')}
        <div class="pr-srgb">${['R', 'G', 'B'].map((c, i) => `<div><span>${c}</span>${(lin[i] / 255).toFixed(3)} → <b>${toSrgb(lin[i] / 255).toFixed(3)}</b></div>`).join('')}</div>
        <p class="pr-note">${t(L('Shadern räknar i <b>linjärt</b> ljus. Skärmen förväntar sig <b>sRGB</b>-kodade värden (≈ gamma 2.2). Ett sRGB-format kodar automatiskt vid skrivning. Utan det blir bilden för mörk (vänster halva på skärmen). Den vita pricken är pixeln i tabellen.', 'The shader computes in <b>linear</b> light. The display expects <b>sRGB</b>-encoded values (≈ gamma 2.2). An sRGB format encodes automatically on write. Without it the image is too dark (left half of the screen). The white dot is the pixel in the table.'))}</p>
        <p class="pr-note">${sw.srgb}</p>`;
    } else if (step === 1) {
      html = `${statRow([[String(sw.count), t(L('bilder i swapchainen', 'swapchain images')), 'glow-cyan'], [`#${front}`, t(L('visas nu', 'on screen now'))]])}
        <div class="pr-thumbs">${thumbs()}</div>
        <p class="pr-note">${t(
          api === 'opengl'
            ? L('Standard-framebuffern är dubbelbuffrad: du ritar i BACK medan FRONT visas. SwapBuffers byter roller vid vblank.', 'The default framebuffer is double-buffered: you draw into BACK while FRONT is shown. SwapBuffers swaps the roles at vblank.')
            : api === 'vulkan'
              ? L('vkAcquireNextImageKHR ger index till nästa lediga bild; vkQueuePresentKHR lämnar tillbaka den för visning.', 'vkAcquireNextImageKHR hands out the index of the next free image; vkQueuePresentKHR gives it back for display.')
              : L('GetCurrentBackBufferIndex() säger vilken buffert du ska rita i; Present() vänder (flip) till nästa.', 'GetCurrentBackBufferIndex() says which buffer to draw into; Present() flips to the next one.'),
        )} ${t(L('(Slow motion: en uppdatering ≈ 2 s.)', '(Slow motion: one refresh ≈ 2 s.)'))}</p>`;
    } else if (step === 2) {
      const n = measured === null ? null : Math.max(1, Math.ceil(measured / REFRESH_MS));
      html = `${statRow([[measured === null ? '…' : `${measured.toFixed(1)} ms`, t(L('denna frame (CPU, JS)', 'this frame (CPU, JS)')), 'glow-cyan'], [n === null ? '…' : `${(60 / n).toFixed(n === 1 ? 0 : 1)} fps`, t(L('med vsync', 'with vsync')), n === 1 ? 'c-idx' : 'pr-neg']])}
        ${row(t(L('uppdatering', 'refresh')), `60 Hz = ${REFRESH_MS.toFixed(2)} ms`, 'glow-amber')}
        ${n === null ? '' : row(t(L('vsync-intervall per frame', 'vsync intervals per frame')), String(n))}
        <p class="pr-note">${t(L('Mjukvaru-renderingen av modellen mättes nyss. Med vsync (FIFO) visas en ny bild bara vid vertical blank. Missar en frame sin deadline visas den förra igen – bildfrekvensen hoppar till 30, 20 … fps. En GPU ritar den här bilden på en bråkdel av en millisekund.', 'The software render of the model was just measured. With vsync (FIFO) a new image is shown only at vertical blank. If a frame misses its deadline the previous one is shown again – the frame rate drops to 30, 20 … fps. A GPU draws this image in a fraction of a millisecond.'))}</p>`;
    } else {
      const modeNames = ['FIFO', 'MAILBOX', 'IMMEDIATE'];
      html = `${statRow([[modeNames[modeIdx], t(L('läge nu', 'mode now')), modeIdx === 2 ? 'pr-neg' : 'glow-cyan'], [sw.modes[modeIdx].replace('PRESENT_MODE_', '').replace('_KHR', ''), api === 'opengl' ? 'glfwSwapInterval' : api === 'vulkan' ? 'presentMode' : 'Present()']])}
        ${[
          [L('vänta på vblank, kö', 'wait for vblank, queue'), 'FIFO', 'c-idx'],
          [L('vblank, nyaste vinner', 'vblank, newest wins'), 'MAILBOX', 'glow-cyan'],
          [L('direkt – kan riva', 'immediately – may tear'), 'IMMEDIATE', 'pr-neg'],
        ]
          .map(([d, n, c], i) => `<div class="pr-mode${i === modeIdx ? ' on' : ''}"><b class="${c}">${n}</b><code>${sw.modes[i]}</code><span>${t(d as L)}</span></div>`)
          .join('')}
        <p class="pr-note">${t(
          api === 'opengl'
            ? L('* Negativt intervall = <i>adaptive vsync</i> (EXT_swap_control_tear) – riva bara när en frame är sen. OpenGL har inget riktigt MAILBOX.', '* A negative interval = <i>adaptive vsync</i> (EXT_swap_control_tear) – tear only when a frame is late. OpenGL has no true MAILBOX.')
            : api === 'vulkan'
              ? L('FIFO är det enda läge som alltid finns. Kolla vkGetPhysicalDeviceSurfacePresentModesKHR för resten.', 'FIFO is the only mode guaranteed to exist. Check vkGetPhysicalDeviceSurfacePresentModesKHR for the rest.')
              : L('Tearing kräver DXGI_SWAP_CHAIN_FLAG_ALLOW_TEARING på swapchainen och stöd enligt CheckFeatureSupport.', 'Tearing needs DXGI_SWAP_CHAIN_FLAG_ALLOW_TEARING on the swapchain and support per CheckFeatureSupport.'),
        )}</p>`;
    }
    numBody.innerHTML = html;
    if (step === 1) paintThumbs();
  };

  // Timeline (step 2): double-buffered FIFO, frames start when the previous one is flipped on.
  const buildTimeline = () => {
    const X = measured ?? 0;
    const per = Math.max(1, Math.ceil(X / REFRESH_MS));
    const intervals = Math.min(24, Math.max(6, per * 3));
    const total = intervals * REFRESH_MS;
    const VW = 620;
    const VH = 230;
    const m = { l: 92, r: 26, t: 26, b: 30 };
    const T = (ms2: number) => m.l + (ms2 / total) * (VW - m.l - m.r);
    const rows = [
      { y: 56, name: t(L('Rendering', 'Rendering')) },
      { y: 112, name: 'Present' },
      { y: 168, name: t(L('Skärmen', 'Display')) },
    ];
    const els: SVGElement[] = [];
    rows.forEach((r) => els.push(s('text', { x: 10, y: r.y + 5, class: 'pr-tl-name' }, [r.name])));
    for (let i = 0; i <= intervals; i++) {
      const x = T(i * REFRESH_MS);
      els.push(s('line', { x1: x, x2: x, y1: m.t, y2: VH - m.b, class: 'pr-vsync' }));
      if (intervals <= 12 || i % Math.ceil(intervals / 12) === 0) els.push(s('text', { x, y: VH - 10, 'text-anchor': 'middle', class: 'pr-tl-tick' }, [`${(i * REFRESH_MS).toFixed(i ? 1 : 0)}`]));
    }
    els.push(s('text', { x: T(0) + 2, y: 16, class: 'pr-tl-tick' }, ['vsync ↓ ms']));
    const hues = ['#38e1ff', '#ff3fd2', '#ffb547', '#5cf08f', '#9b7bff'];
    let start = 0;
    let k = 0;
    let lastShown = -1;
    while (start < total && k < 40) {
      const end = start + Math.max(X, 0.4);
      const v = Math.max(Math.ceil(end / REFRESH_MS - 1e-9), lastShown + 1) * REFRESH_MS;
      const col = hues[k % hues.length];
      els.push(s('rect', { x: T(start), y: rows[0].y - 13, width: Math.max(2, T(Math.min(end, total)) - T(start)), height: 26, rx: 5, fill: col, class: 'pr-block' }));
      if (T(end) - T(start) > 26) els.push(s('text', { x: (T(start) + T(Math.min(end, total))) / 2, y: rows[0].y + 4, 'text-anchor': 'middle', class: 'pr-tl-lbl' }, [`#${k}`]));
      if (v < total) {
        els.push(s('line', { x1: T(Math.min(end, total)), y1: rows[0].y + 13, x2: T(v), y2: rows[1].y - 4, class: 'pr-arrow', stroke: col }));
        els.push(s('circle', { cx: T(v), cy: rows[1].y, r: 5, fill: col, class: 'pr-dot' }));
        const nextV = Math.max(v + REFRESH_MS, Math.ceil((v + Math.max(X, 0.4)) / REFRESH_MS - 1e-9) * REFRESH_MS);
        els.push(s('rect', { x: T(v), y: rows[2].y - 13, width: Math.max(2, T(Math.min(nextV, total)) - T(v)), height: 26, fill: col, opacity: 0.35, class: 'pr-block' }));
        els.push(s('text', { x: T(v) + 6, y: rows[2].y + 4, class: 'pr-tl-lbl' }, [`#${k}`]));
      }
      lastShown = Math.round(v / REFRESH_MS);
      start = v;
      k++;
    }
    const glow = s('line', { x1: T(0), x2: T(0), y1: m.t - 6, y2: VH - m.b, class: 'pr-playhead glow' });
    const playhead = s('line', { x1: T(0), x2: T(0), y1: m.t - 6, y2: VH - m.b, class: 'pr-playhead' });
    els.push(glow, playhead);
    timeline.replaceChildren(s('svg', { viewBox: `0 0 ${VW} ${VH}`, class: 'pr-tl-svg', preserveAspectRatio: 'xMidYMid meet' }, els));
    const t0 = performance.now();
    const tick = () => {
      const p = ((performance.now() - t0) / (total * 110)) % 1; // same slow motion as the 3D view
      const x = T(p * total);
      for (const l of [glow, playhead]) {
        l.setAttribute('x1', String(x));
        l.setAttribute('x2', String(x));
      }
      raf = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
  };

  // Present modes (step 3): small 2D previews; IMMEDIATE tears (top: old frame, below the tear: new).
  const buildModes = () => {
    const nm = ['FIFO', 'MAILBOX', 'IMMEDIATE'];
    modes.replaceChildren(
      ...nm.map((n, i) => {
        const c = h('canvas', { attrs: { width: FW, height: FH } });
        let img: Uint8ClampedArray;
        if (i < 2) img = frames[i === 0 ? 1 : 2];
        else {
          img = new Uint8ClampedArray(frames[2]);
          const tear = Math.round(FH * 0.46);
          img.set(frames[1].subarray(0, tear * FW * 4), 0);
        }
        c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img), FW, FH), 0, 0);
        return h(`div.pr-mini${i === 2 ? '.tear' : ''}${i === modeIdx ? '.on' : ''}`, {}, [h('div.pr-mini-screen', {}, [c, i === 2 ? h('div.pr-tearline') : null]), h('b', { text: n })]);
      }),
    );
  };

  const PERIOD = 1.9;
  pres.onFlip = (f) => {
    front = Math.max(0, f);
    if (step === 1) updateSide();
  };
  let modeTimer = 0;
  const runMode = (i: number) => {
    modeIdx = i;
    const mode: Mode = (['fifo', 'mailbox', 'immediate'] as Mode[])[i];
    pres.run({ work: (k) => (i === 1 ? 0.45 : 1.3 + (k % 2) * 0.1), mode, period: PERIOD });
    pres.modeLabel.element.textContent = ['FIFO', 'MAILBOX', 'IMMEDIATE'][i];
    pres.modeLabel.element.style.color = i === 2 ? 'var(--red)' : 'var(--cyan)';
    buildModes();
    updateSide();
  };

  return {
    show(st, animate) {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      clearInterval(modeTimer);
      step = st;
      front = 0;
      const sm = pres.screenMat.uniforms;
      probeDot.visible = st === 0;
      pres.modeLabel.element.textContent = '';
      pres.status.element.textContent = '';
      if (st === 0) {
        pres.run(null);
        sm.uA.value = linTex;
        sm.uB.value = srgbTex;
        sm.uGrid.value = [IW, IH];
        sm.uSplitX.value = animate ? 1 : 0.5;
        if (animate) ms.tween(sm.uSplitX, { value: 0.5, duration: secs(animate, 1.6), ease: 'power3.out' });
        pres.status.element.textContent = t(L('vänster: linjärt · höger: sRGB', 'left: linear · right: sRGB'));
        ms.pivot.rotation.y = SHOWCASE_ROT_Y;
      } else {
        sm.uSplitX.value = 2;
        sm.uGrid.value = [FW, FH];
      }
      if (st === 1) pres.run({ work: () => 0.7, mode: 'fifo', period: PERIOD });
      if (st === 2) {
        const run = () => pres.run({ work: () => Math.max(0.05, (measured ?? 8) / REFRESH_MS), mode: 'fifo', period: PERIOD });
        run();
        buildTimeline();
        if (measured === null) {
          timer = window.setTimeout(() => {
            // The 320×200 render is prepared in a worker, which also timed it; only time it here
            // (blocking) if it had to be computed on the main thread.
            const prepared = ctx.derived.render(api, 320, 200) as { ms?: number };
            if (prepared.ms !== undefined) measured = prepared.ms;
            else {
              const t0 = performance.now();
              renderMesh(ctx.state.mesh, api, 320, 200, { rotY: SHOWCASE_ROT_Y, rotX: SHOWCASE_ROT_X });
              measured = performance.now() - t0;
            }
            if (step === 2) {
              run();
              buildTimeline();
              updateSide();
            }
          }, 700); // after the step transition, so the blocking measurement does not stall it
        }
      }
      if (st === 3) {
        let i = 0;
        runMode(0);
        modeTimer = window.setInterval(() => runMode((i = (i + 1) % 3)), PERIOD * 4 * 1000);
      }
      timeline.style.display = st === 2 ? '' : 'none';
      modes.style.display = st === 3 ? '' : 'none';
      extra.style.display = st >= 2 ? '' : 'none';
      extraHead.textContent = st === 2 ? t(L('Tidslinje (FIFO, dubbelbuffring)', 'Timeline (FIFO, double buffering)')) : t(L('Så ser det ut', 'What it looks like'));
      updateSide();
    },
    destroy() {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      clearInterval(modeTimer);
      ms.destroy();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Concept: scan-out, buffer flips, a late frame, tearing              */
/* ------------------------------------------------------------------ */
function conceptVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const api = ctx.state.api;
  const FW = 160;
  const FH = 100;
  const frames = [0, 1, 2].map((k) => encodeSrgb(ctx.derived.render(api, FW, FH, { rotY: SHOWCASE_ROT_Y + k * 0.45 }).color));
  const ms = createModelStage(host, ctx, { autoRotate: 0, eye: [-0.1, 0.75, 4.8], bloom: 0.4, bloomThreshold: 0.88 });
  const names = (i: number, role: string) =>
    `${i === 0 ? 'A' : 'B'}${role ? ' · ' + t(role === 'front' ? L('front – visas', 'front – shown') : role === 'draw' ? L('back – ritas', 'back – drawn') : role === 'queued' ? L('klar', 'ready') : L('ledig', 'free')) : ''}`;
  const pres = presentScene(ms, ctx, frames, FW, FH, 2, names);
  const caption = ms.panel(t(L('Vad händer', 'What happens')), [h('p.pr-capt')], { side: 'bottom' });
  const text = caption.querySelector('.pr-capt')!;
  const captions = [
    L('Skärmen ritar om bilden uppifrån och ned, rad för rad, 60 gånger per sekund (här i slow motion).', 'The display redraws the image top to bottom, line by line, 60 times per second (here in slow motion).'),
    L('GPU:n ritar nästa bild i en <b>back buffer</b> (gul) medan skärmen visar <b>front buffern</b> (cyan). Vid vblank byter de plats.', 'The GPU draws the next image into a <b>back buffer</b> (amber) while the display shows the <b>front buffer</b> (cyan). At vblank they swap.'),
    L('Med vsync måste varje bild vara klar till nästa vblank. Bild 3 blir sen – den förra visas igen: <b>stutter</b>.', 'With vsync every image must be ready by the next vblank. Image 3 is late – the previous one is shown again: <b>stutter</b>.'),
    L('Utan vsync (IMMEDIATE) byts bilden mitt i uppritningen: ovanför linjen syns den gamla bilden, under den nya – <b>tearing</b>. FIFO väntar på vblank.', 'Without vsync (IMMEDIATE) the image is swapped mid-scan: above the line you see the old image, below it the new one – <b>tearing</b>. FIFO waits for vblank.'),
  ];
  const work = [0.55, 0.7, 0.6, 1.45, 0.5, 0.65, 0.8, 0.55];
  let modeTimer = 0;
  return {
    show(st, animate) {
      clearInterval(modeTimer);
      text.innerHTML = t(captions[st]);
      if (animate) caption.animate([{ opacity: 0.3 }, { opacity: 1 }], { duration: secs(animate, 0.4) * 1000 });
      pres.modeLabel.element.textContent = '';
      if (st === 0) {
        // One image, refreshed over and over: just the scan-out.
        pres.run({ work: () => 1e6, mode: 'fifo', period: 1.6, swap: false });
        pres.screenMat.uniforms.uA.value = pres.cards[0].mat.uniforms.uTex.value;
        ms.pivot.rotation.y = SHOWCASE_ROT_Y;
      } else if (st === 1) pres.run({ work: () => 0.6, mode: 'fifo', period: 1.6 });
      else if (st === 2) pres.run({ work: (k) => work[k % work.length], mode: 'fifo', period: 1.6 });
      else {
        let i = 0;
        const go = () => {
          const mode: Mode = i === 0 ? 'fifo' : 'immediate';
          pres.run({ work: (k) => 1.25 + (k % 3) * 0.15, mode, period: 1.6 });
          pres.modeLabel.element.textContent = i === 0 ? 'FIFO (vsync)' : 'IMMEDIATE';
          pres.modeLabel.element.style.color = i === 0 ? 'var(--cyan)' : 'var(--red)';
        };
        go();
        modeTimer = window.setInterval(() => {
          i = 1 - i;
          go();
        }, 1600 * 5);
      }
    },
    destroy() {
      clearInterval(modeTimer);
      ms.destroy();
    },
  };
}

/* ------------------------------------------------------------------ */
/* API panels                                                          */
/* ------------------------------------------------------------------ */
function apis(): Record<ApiId, ApiPanelSpec> {
  const gl = `// The default framebuffer is created with the window (WGL/GLX/EGL)
glfwWindowHint(GLFW_DOUBLEBUFFER, GLFW_TRUE);
glfwWindowHint(GLFW_SRGB_CAPABLE, GLFW_TRUE);
glfwSwapInterval(1);                // 1 = vsync, 0 = off, -1 = adaptive

while (!glfwWindowShouldClose(window)) {
    glEnable(GL_FRAMEBUFFER_SRGB);  // encode linear → sRGB on write
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    drawScene();                    // into the back buffer
    glfwSwapBuffers(window);        // SwapBuffers(hdc) / glXSwapBuffers
    glfwPollEvents();
}`;
  const vk = `VkSwapchainCreateInfoKHR sc{VK_STRUCTURE_TYPE_SWAPCHAIN_CREATE_INFO_KHR};
sc.surface          = surface;
sc.minImageCount    = caps.minImageCount + 1;         // e.g. 3
sc.imageFormat      = VK_FORMAT_B8G8R8A8_SRGB;
sc.imageColorSpace  = VK_COLOR_SPACE_SRGB_NONLINEAR_KHR;
sc.imageUsage       = VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT;
sc.presentMode      = VK_PRESENT_MODE_FIFO_KHR;       // vsync; MAILBOX, IMMEDIATE
vkCreateSwapchainKHR(device, &sc, nullptr, &swapchain);

vkAcquireNextImageKHR(device, swapchain, UINT64_MAX, acquired, VK_NULL_HANDLE, &idx);
// ... render into images[idx], then barrier (synchronization2):
//     COLOR_ATTACHMENT_OPTIMAL → VK_IMAGE_LAYOUT_PRESENT_SRC_KHR
VkPresentInfoKHR pi{VK_STRUCTURE_TYPE_PRESENT_INFO_KHR};
pi.waitSemaphoreCount = 1;  pi.pWaitSemaphores = &renderDone;
pi.swapchainCount     = 1;  pi.pSwapchains = &swapchain;  pi.pImageIndices = &idx;
vkQueuePresentKHR(queue, &pi);`;
  const dx = `DXGI_SWAP_CHAIN_DESC1 sd{};
sd.Width = w;  sd.Height = h;
sd.Format      = DXGI_FORMAT_R8G8B8A8_UNORM;   // RTV uses ..._UNORM_SRGB
sd.SampleDesc  = { 1, 0 };
sd.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
sd.BufferCount = 2;
sd.SwapEffect  = DXGI_SWAP_EFFECT_FLIP_DISCARD;
sd.Flags = DXGI_SWAP_CHAIN_FLAG_FRAME_LATENCY_WAITABLE_OBJECT;
factory->CreateSwapChainForHwnd(queue, hwnd, &sd, nullptr, nullptr, &sc1);
sc1.As(&swapChain);                            // IDXGISwapChain4
HANDLE waitable = swapChain->GetFrameLatencyWaitableObject();

WaitForSingleObjectEx(waitable, 1000, TRUE);   // limit queued frames
UINT i = swapChain->GetCurrentBackBufferIndex();
// ... render into backBuffers[i] (barrier RENDER_TARGET → PRESENT)
swapChain->Present(1, 0);                      // sync interval 1 = vsync`;
  return {
    opengl: {
      note: L(
        'OpenGL har ingen egen swapchain: standard-framebuffern och dess back buffer skapas av fönstersystemet (WGL, GLX, EGL – här via GLFW). Du byter med SwapBuffers.',
        'OpenGL has no swapchain object of its own: the default framebuffer and its back buffer are created by the window system (WGL, GLX, EGL – here via GLFW). You swap with SwapBuffers.',
      ),
      code: [{ lang: 'cpp', src: gl, highlight: [[3, 7], [2, 8, 9, 10], [4, 10], [4]] }],
      terms: [
        { term: 'front / back buffer', desc: L('Front visas på skärmen, back är den du ritar i.', 'Front is shown on screen, back is the one you draw into.') },
        { term: 'swap interval', desc: L('Antal vblanks att vänta per swap: 1 = vsync, 0 = direkt (tearing).', 'Number of vblanks to wait per swap: 1 = vsync, 0 = immediately (tearing).') },
        { term: 'GL_FRAMEBUFFER_SRGB', desc: L('Linjär → sRGB-kodning vid skrivning, om framebuffern är sRGB-kapabel.', 'Linear → sRGB encoding on write, if the framebuffer is sRGB-capable.') },
      ],
      you: L('anropar SwapBuffers', 'call SwapBuffers'),
      driver: L('fönstersystemet visar bilden', 'the window system shows the image'),
    },
    vulkan: {
      note: L(
        'I Vulkan är swapchainen ett eget objekt (VK_KHR_swapchain). Du hämtar en bild, ritar, byter layout till PRESENT_SRC_KHR och lämnar den till presentationsmotorn – synkat med semaforer.',
        'In Vulkan the swapchain is an explicit object (VK_KHR_swapchain). You acquire an image, render, transition it to PRESENT_SRC_KHR and hand it to the presentation engine – synchronized with semaphores.',
      ),
      code: [{ lang: 'cpp', src: vk, highlight: [[4, 5], [3, 10, 11, 12, 13, 14, 15, 16], [7, 16], [7]] }],
      terms: [
        { term: 'VkSwapchainKHR', desc: L('En kö av bilder som delas med skärmens presentationsmotor.', 'A queue of images shared with the display\'s presentation engine.') },
        { term: 'PRESENT_SRC_KHR', desc: L('Bildlayout som krävs innan en bild får presenteras.', 'Image layout required before an image may be presented.') },
        { term: 'FIFO / MAILBOX / IMMEDIATE', desc: L('Vsync med kö / vsync där nyaste ersätter köad bild / ingen väntan (tearing).', 'Vsync with a queue / vsync where the newest replaces the queued image / no wait (tearing).') },
        { term: 'semaphore', desc: L('GPU-signal: acquire → rendering → present, utan att CPU:n väntar.', 'GPU signal: acquire → rendering → present, without the CPU waiting.') },
      ],
      you: L('acquire, barriär, present, synk', 'acquire, barrier, present, sync'),
      driver: L('presentationsmotorn visar bilden', 'the presentation engine shows the image'),
    },
    d3d12: {
      note: L(
        'I D3D12 sköter DXGI presentationen. Flip-modellen (FLIP_DISCARD) byter buffertar utan kopiering; du ritar i GetCurrentBackBufferIndex() och anropar Present.',
        'In D3D12, DXGI handles presentation. The flip model (FLIP_DISCARD) swaps buffers without copying; you draw into GetCurrentBackBufferIndex() and call Present.',
      ),
      code: [{ lang: 'cpp', src: dx, highlight: [[3], [6, 7, 9, 10, 14, 15, 16], [8, 11, 13, 16], [16]] }],
      terms: [
        { term: 'IDXGISwapChain4', desc: L('Swapchain-gränssnittet; ger HDR-metadata, färgrymd m.m.', 'The swapchain interface; adds HDR metadata, color space etc.') },
        { term: 'FLIP_DISCARD', desc: L('Flip-modell: bufferten byts ut, innehållet efter Present är odefinierat.', 'Flip model: the buffer is flipped, its contents after Present are undefined.') },
        { term: 'Present(1, 0)', desc: L('SyncInterval 1 = vänta en vblank (vsync). 0 + ALLOW_TEARING = direkt.', 'SyncInterval 1 = wait one vblank (vsync). 0 + ALLOW_TEARING = immediately.') },
        { term: 'frame latency waitable', desc: L('Ett event som signaleras när en ny frame får börja – minskar input lag.', 'An event signaled when a new frame may start – reduces input lag.') },
      ],
      you: L('Present + väntan på latens', 'Present + latency wait'),
      driver: L('DXGI/DWM visar bilden', 'DXGI/DWM shows the image'),
    },
  };
}

export default standardSlide({
  id: 'present',
  group: 'gpu-fixed',
  short: L('Present', 'Present'),
  title: L('Present – bilden når skärmen', 'Present – the image reaches the screen'),
  lead: L(
    'Den färdiga bilden ligger i en <b>back buffer</b>. Present lämnar över den till skärmen, i takt med skärmens uppdatering.',
    'The finished image sits in a <b>back buffer</b>. Present hands it over to the display, in step with the display\'s refresh.',
  ),
  bullets: [
    L(
      'Bilden är klar. Shaders räknar i <b>linjärt</b> ljus, men skärmen vill ha <b>sRGB</b>: ett sRGB-format kodar om värdena när de skrivs.',
      'The image is done. Shaders compute in <b>linear</b> light, but the display wants <b>sRGB</b>: an sRGB format re-encodes the values as they are written.',
    ),
    L(
      '<b>Dubbel- eller trippelbuffring</b>: GPU:n ritar i back buffern medan skärmen visar front buffern. Vid present byter de roller.',
      '<b>Double or triple buffering</b>: the GPU draws into the back buffer while the display shows the front buffer. At present they swap roles.',
    ),
    L(
      'Skärmen uppdateras t.ex. <b>60 Hz = 16,67 ms</b>. Med <b>vsync</b> byts bilden bara vid vertical blank; en sen frame visas en uppdatering senare.',
      'The display refreshes at e.g. <b>60 Hz = 16.67 ms</b>. With <b>vsync</b> the image only changes at vertical blank; a late frame is shown one refresh later.',
    ),
    L(
      '<b>Presentationslägen</b>: FIFO (vsync), MAILBOX (låg latens utan tearing) och IMMEDIATE (ingen väntan – kan ge <b>tearing</b>).',
      '<b>Present modes</b>: FIFO (vsync), MAILBOX (low latency without tearing) and IMMEDIATE (no wait – may cause <b>tearing</b>).',
    ),
  ],
  api: apis,
  data: dataVisual,
  concept: conceptVisual,
});
