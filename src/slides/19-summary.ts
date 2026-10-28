import gsap from 'gsap';
import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, Group, Line, LineBasicMaterial, Points, PointsMaterial, Sprite, SpriteMaterial, Vector3 } from 'three';
import { dur, h } from '../core/dom';
import { L, type Text } from '../core/i18n';
import { API_LIST, type ApiId } from '../core/state';
import { formatBytes } from '../pipeline/layout';
import { createModelStage, glowTexture, type ModelStage } from '../views/ModelStage';
import { COLORS, label } from '../views/three-helpers';
import { stat } from '../views/widgets';
import { standardSlide } from './standard';
import type { SlideContext, Visual } from './types';
import '../styles/slides/summary.css';

type Row = { k: Text; v: Record<ApiId, Text> };

/** An HDR color so it rises above the bloom threshold. */
const hdr = (hex: number, k: number) => new Color(hex).multiplyScalar(k);

const ROWS: Row[] = [
  {
    k: L('Abstraktionsnivå', 'Abstraction level'),
    v: {
      opengl: L('Hög – drivrutinen gör mycket åt dig', 'High – the driver does a lot for you'),
      vulkan: L('Låg – explicit kontroll över nästan allt', 'Low – explicit control over almost everything'),
      d3d12: L('Låg – explicit, men lite mer hjälp än Vulkan', 'Low – explicit, with a bit more help than Vulkan'),
    },
  },
  {
    k: L('Shaderspråk → IR', 'Shader language → IR'),
    v: {
      opengl: L('GLSL, kompileras av drivrutinen vid körning (ev. SPIR-V)', 'GLSL, compiled by the driver at runtime (optionally SPIR-V)'),
      vulkan: L('GLSL / HLSL / Slang → SPIR-V offline', 'GLSL / HLSL / Slang → SPIR-V offline'),
      d3d12: L('HLSL → DXIL med dxc offline', 'HLSL → DXIL with dxc offline'),
    },
  },
  {
    k: L('Pipeline-tillstånd', 'Pipeline state'),
    v: {
      opengl: L('Global tillståndsmaskin, valideras vid varje draw', 'Global state machine, validated at every draw'),
      vulkan: L('VkPipeline – bakas i förväg (plus dynamiska tillstånd)', 'VkPipeline – baked up front (plus dynamic state)'),
      d3d12: L('PSO + root signature – bakas i förväg', 'PSO + root signature – baked up front'),
    },
  },
  {
    k: L('Minne', 'Memory'),
    v: {
      opengl: L('Drivrutinen väljer var buffertar hamnar', 'The driver decides where buffers live'),
      vulkan: L('Du väljer minnestyp och allokerar (ofta med VMA)', 'You pick memory types and allocate (often with VMA)'),
      d3d12: L('Heaps: UPLOAD / DEFAULT / READBACK (ofta med D3D12MA)', 'Heaps: UPLOAD / DEFAULT / READBACK (often with D3D12MA)'),
    },
  },
  {
    k: L('Kommandon', 'Commands'),
    v: {
      opengl: L('Implicit kommandoström i drivrutinen', 'Implicit command stream inside the driver'),
      vulkan: L('Command buffers, spelas in på valfri tråd', 'Command buffers, recorded on any thread'),
      d3d12: L('Command lists + allocators, spelas in på valfri tråd', 'Command lists + allocators, recorded on any thread'),
    },
  },
  {
    k: L('Synkronisering', 'Synchronization'),
    v: {
      opengl: L('Implicit (glFenceSync finns vid behov)', 'Implicit (glFenceSync when you need it)'),
      vulkan: L('Explicit: barriers, semaforer, fences', 'Explicit: barriers, semaphores, fences'),
      d3d12: L('Explicit: resource barriers och fences', 'Explicit: resource barriers and fences'),
    },
  },
  {
    k: L('Clip space-djup / Y', 'Clip-space depth / Y'),
    v: {
      opengl: L('z ∈ [−1, 1], y upp, fönsterorigo nere till vänster', 'z ∈ [−1, 1], y up, window origin bottom-left'),
      vulkan: L('z ∈ [0, 1], y ned i NDC', 'z ∈ [0, 1], y down in NDC'),
      d3d12: L('z ∈ [0, 1], y upp, fönsterorigo uppe till vänster', 'z ∈ [0, 1], y up, window origin top-left'),
    },
  },
  {
    k: L('Plattformar', 'Platforms'),
    v: {
      opengl: L('Windows, Linux, (macOS fast på 4.1), WebGL-släkting', 'Windows, Linux, (macOS frozen at 4.1), WebGL relative'),
      vulkan: L('Windows, Linux, Android, (macOS via MoltenVK)', 'Windows, Linux, Android, (macOS via MoltenVK)'),
      d3d12: L('Windows, Xbox', 'Windows, Xbox'),
    },
  },
  {
    k: L('"Hello triangle", ungefär', '"Hello triangle", roughly'),
    v: {
      opengl: L('~100 rader', '~100 lines'),
      vulkan: L('~800–1000 rader', '~800–1000 lines'),
      d3d12: L('~400–600 rader', '~400–600 lines'),
    },
  },
];

const JOURNEY: { id: string; label: Text; group: string }[] = [
  { id: 'parse', label: L('Fil', 'File'), group: 'cpu' },
  { id: 'buffers', label: L('Buffertar', 'Buffers'), group: 'api' },
  { id: 'descriptors', label: L('Uniforms', 'Uniforms'), group: 'api' },
  { id: 'commands', label: L('Draw', 'Draw'), group: 'api' },
  { id: 'vertex-shader', label: L('Vertex', 'Vertex'), group: 'gpu-prog' },
  { id: 'clipping', label: L('Clip', 'Clip'), group: 'gpu-fixed' },
  { id: 'rasterization', label: L('Raster', 'Raster'), group: 'gpu-fixed' },
  { id: 'fragment-shader', label: L('Fragment', 'Fragment'), group: 'gpu-prog' },
  { id: 'depth', label: L('Djup', 'Depth'), group: 'gpu-fixed' },
  { id: 'present', label: L('Skärm', 'Screen'), group: 'gpu-fixed' },
];

const RESOURCES = [
  { name: 'LearnOpenGL', url: 'https://learnopengl.com' },
  { name: 'Vulkan Tutorial', url: 'https://vulkan-tutorial.com' },
  { name: 'Vulkan Guide', url: 'https://docs.vulkan.org/guide/latest/' },
  { name: 'DirectX-Graphics-Samples', url: 'https://github.com/microsoft/DirectX-Graphics-Samples' },
  { name: 'A trip through the Graphics Pipeline', url: 'https://fgiesen.wordpress.com/2011/07/09/a-trip-through-the-graphics-pipeline-2011-index/' },
];

/** Jump to another slide by id (the engine follows hash changes). */
function goTo(id: string) {
  location.hash = `#/${id}/1`;
}

function compareTable(ctx: SlideContext): HTMLElement {
  const api = ctx.state.api;
  return h('table.compare', {}, [
    h('thead', {}, [
      h('tr', {}, [h('th'), ...API_LIST.map((a) => h(`th.${a.id}${a.id === api ? '.cur' : ''}`, { text: `${a.label} ${a.version}` }))]),
    ]),
    h('tbody', {}, ROWS.map((r) => h('tr', {}, [h('th', { text: ctx.t(r.k) }), ...API_LIST.map((a) => h(`td${a.id === api ? '.cur' : ''}`, { text: ctx.t(r.v[a.id]) }))]))),
  ]);
}

function resourcesList(ctx: SlideContext): HTMLElement {
  return h('div.resources', {}, [
    h('h4', { text: ctx.t(L('Läs vidare', 'Further reading')) }),
    ...RESOURCES.map((r) => h('a', { text: r.name, attrs: { href: r.url, target: '_blank', rel: 'noopener' } })),
  ]);
}

/* ------------------------------------------------------------------ */
/* The model in the middle, the journey orbiting around it             */
/* ------------------------------------------------------------------ */
const GROUP_COLOR: Record<string, number> = { cpu: COLORS.cyan, api: COLORS.violet, 'gpu-prog': COLORS.magenta, 'gpu-fixed': COLORS.amber };
const RING_R = 1.62;
const PERIOD = 1.5; // seconds per stage for the travelling packet

/** Shows only the panels of the current step (so the XR panel reads the right stats). */
function stepPanels(list: { el: HTMLElement; steps: number[] }[]) {
  const slots = list.map((p) => p.el.parentElement!);
  return (step: number, animate: boolean) => {
    list.forEach((p, i) => {
      const on = p.steps.includes(step);
      if (!on) p.el.remove();
      else if (!p.el.isConnected) {
        slots[i].append(p.el);
        if (animate) gsap.fromTo(p.el, { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: dur(0.45), ease: 'power2.out' });
      }
    });
    list.forEach((p, i) => p.el.isConnected && slots[i].append(p.el));
  };
}

interface SumScene {
  ms: ModelStage;
  /** Slide the model sideways (fraction of the view width) to make room for wide panels. */
  shiftTo(x: number, animate: boolean): void;
  nodes: HTMLElement[];
}

function buildScene(host: HTMLElement, ctx: SlideContext, concept: boolean): SumScene {
  const { t } = ctx;
  const ms = createModelStage(host, ctx, {
    autoRotate: 0.25,
    bloom: 0.6,
    bloomThreshold: 0.88,
    eye: [0, 1.25, 4.1],
    layers: { solid: 1, wire: 0 },
  });
  const tex = glowTexture();
  // The ring: tilted, slowly turning, one glowing node per stage.
  const ring = new Group();
  ring.rotation.x = 0.2;
  ring.position.y = -0.05;
  ms.pivot.scale.setScalar(1.12);
  ms.scene.add(ring);
  const spin = new Group();
  ring.add(spin);
  const n = JOURNEY.length;
  const angle = (i: number) => (i / n) * Math.PI * 2;
  const at = (a: number, r = RING_R) => new Vector3(Math.sin(a) * r, 0, Math.cos(a) * r);
  const circle: Vector3[] = [];
  for (let k = 0; k <= 128; k++) circle.push(at((k / 128) * Math.PI * 2));
  const track = new Line(new BufferGeometry().setFromPoints(circle), new LineBasicMaterial({ color: hdr(COLORS.violet, 1.2), transparent: true, opacity: 0.45 }));
  spin.add(track);
  const nodes = JOURNEY.map((j, i) => {
    const sp = new Sprite(new SpriteMaterial({ map: tex, color: hdr(GROUP_COLOR[j.group], 1.8), transparent: true, depthWrite: false, blending: AdditiveBlending }));
    sp.position.copy(at(angle(i)));
    sp.scale.setScalar(0.22);
    spin.add(sp);
    const lb = label(t(j.label), 'sum-node');
    lb.element.dataset.group = j.group;
    lb.element.addEventListener('click', () => goTo(j.id));
    lb.element.title = t(L('Gå till steget', 'Go to the stage'));
    lb.position.copy(at(angle(i), RING_R + 0.02)).add(new Vector3(0, 0.2, 0));
    spin.add(lb);
    return { sp, lb, base: hdr(GROUP_COLOR[j.group], 1.8) };
  });
  // Particles circling the loop (+ a bright packet that "does" each stage to the model).
  const NP = 520;
  const pPos = new Float32Array(NP * 3);
  const pCol = new Float32Array(NP * 3);
  const seeds = Array.from({ length: NP }, () => ({ a: Math.random() * Math.PI * 2, r: RING_R + (Math.random() - 0.5) * 0.16, y: (Math.random() - 0.5) * 0.12, v: 0.25 + Math.random() * 0.35 }));
  const pg = new BufferGeometry();
  pg.setAttribute('position', new BufferAttribute(pPos, 3));
  pg.setAttribute('color', new BufferAttribute(pCol, 3));
  const parts = new Points(pg, new PointsMaterial({ size: 0.035, map: tex, vertexColors: true, transparent: true, depthWrite: false, blending: AdditiveBlending }));
  parts.frustumCulled = false;
  spin.add(parts);
  const packets = Array.from({ length: concept ? 3 : 1 }, () => {
    const sp = new Sprite(new SpriteMaterial({ map: tex, color: hdr(COLORS.white, 1.6), transparent: true, depthWrite: false, blending: AdditiveBlending }));
    sp.scale.setScalar(0.15);
    spin.add(sp);
    return sp;
  });
  const fps = concept ? label(t(L('60 bilder per sekund – hela resan, varje bildruta', '60 frames per second – the whole journey, every frame')), 'sum-fps') : null;
  if (fps) {
    fps.position.set(0, -1.42, 0);
    ms.scene.add(fps);
  }

  // What each stage does to the model.
  const look = (k: number) => {
    const id = JOURNEY[k].id;
    const s = 0.5;
    const L2 = (solid: number, wire: number, points: number, normals = 0) => {
      ms.setLayer('solid', solid, s);
      ms.setLayer('wire', wire, s);
      ms.setLayer('points', points, s);
      ms.setLayer('normals', normals, s);
    };
    if (id === 'parse') return L2(0, 0, 0.9), ms.setMode('shaded', 0, s);
    if (id === 'buffers') return L2(0, 0.25, 0.8), ms.setMode('shaded', 0, s);
    if (id === 'descriptors') return L2(0.35, 0.3, 0), ms.setMode('ghost', 1, s);
    if (id === 'commands') return L2(1, 0.25, 0), ms.setMode('ghost', 1, s), ms.drawTriangles(0, 0), ms.drawTriangles(ctx.state.mesh.triangleCount, PERIOD * 0.8);
    if (id === 'vertex-shader') return L2(1, 0.15, 0, 0.5), ms.setMode('normals', 0.8, s);
    if (id === 'clipping') return L2(1, 0.2, 0), ms.setMode('ghost', 0.7, s);
    if (id === 'rasterization') return L2(1, 0, 0), ms.setMode('triangleId', 0.9, s);
    if (id === 'fragment-shader') return L2(1, 0, 0), ms.sweep('shaded', 'triangleId', PERIOD * 0.9);
    if (id === 'depth') return L2(1, 0, 0), ms.setMode('depth', 0.9, s);
    return L2(1, 0, 0), ms.setMode('shaded', 0, s);
  };
  let cur = -1;
  let shift = 0;
  let w = 1;
  let hh = 1;
  const ro = new ResizeObserver(() => {
    w = Math.max(1, host.clientWidth);
    hh = Math.max(1, host.clientHeight);
    applyShift();
  });
  ro.observe(host);
  const sh = { x: 0 };
  const applyShift = () => {
    if (Math.abs(sh.x) < 1e-4) ms.camera.clearViewOffset();
    else ms.camera.setViewOffset(w, hh, -sh.x * w, 0, w, hh);
    ms.camera.updateProjectionMatrix();
  };
  ms.onFrame((time) => {
    spin.rotation.y = time * 0.08;
    // The packet travels from stage to stage.
    const u = (time / PERIOD + n - 1) % n; // start at the finished image, then around from the file
    packets.forEach((p, i) => p.position.copy(at(angle(u + (i * n) / packets.length))));
    const k = Math.floor(u) % n;
    if (k !== cur) {
      cur = k;
      look(k);
    }
    nodes.forEach((nd, i) => {
      const d = Math.min(Math.abs(u - i), n - Math.abs(u - i));
      const f = Math.max(0, 1 - d * 1.6);
      nd.sp.scale.setScalar(0.16 + 0.16 * f);
      (nd.sp.material as SpriteMaterial).color.copy(nd.base).multiplyScalar(1 + f * 0.5);
      nd.lb.element.classList.toggle('on', i === k);
    });
    for (let i = 0; i < NP; i++) {
      const s = seeds[i];
      const a = s.a + time * s.v;
      pPos[i * 3] = Math.sin(a) * s.r;
      pPos[i * 3 + 1] = s.y + Math.sin(a * 3 + i) * 0.02;
      pPos[i * 3 + 2] = Math.cos(a) * s.r;
      const g = JOURNEY[Math.floor(((((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2)) * n) % n].group;
      const c = hdr(GROUP_COLOR[g], 1.3);
      pCol[i * 3] = c.r;
      pCol[i * 3 + 1] = c.g;
      pCol[i * 3 + 2] = c.b;
    }
    pg.attributes.position.needsUpdate = true;
    pg.attributes.color.needsUpdate = true;
    if (Math.abs(sh.x - shift) > 1e-4 || sh.x !== 0) applyShift();
    shift = sh.x;
  });
  const destroy0 = ms.destroy.bind(ms);
  ms.destroy = () => {
    ro.disconnect();
    gsap.killTweensOf(sh);
    destroy0();
  };
  return {
    ms,
    nodes: nodes.map((nd) => nd.lb.element),
    shiftTo(x, animate) {
      gsap.killTweensOf(sh);
      if (animate) gsap.to(sh, { x, duration: dur(0.9), ease: 'power2.inOut' });
      else {
        sh.x = x;
        applyShift();
      }
    },
  };
}

function dataVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const api = ctx.state.api;
  const mesh = ctx.state.mesh;
  const r = ctx.derived.render(api, 240, 150);
  const l = ctx.derived.layout;
  const S = buildScene(host, ctx, false);
  const { ms } = S;
  const statsPanel = ms.panel(t(L(`${mesh.name} – hela resan i siffror`, `${mesh.name} – the whole journey in numbers`)), [
    h('div.stat-row', {}, [
      stat(formatBytes(mesh.fileSize), t(L('fil', 'file'))),
      stat(formatBytes(l.vertexBytes + l.indexBytes), t(L('GPU-buffertar', 'GPU buffers')), 'glow-cyan'),
      stat(mesh.vertexCount.toLocaleString(), t(L('VS-anrop (minst)', 'VS runs (min)'))),
      stat(r.stats.culled.toLocaleString(), t(L('trianglar bortsorterade', 'triangles culled')), 'glow-magenta'),
      stat(r.stats.fragments.toLocaleString(), t(L(`fragment @ ${r.width}×${r.height}`, `fragments @ ${r.width}×${r.height}`))),
      stat(r.stats.written.toLocaleString(), t(L('pixlar skrivna', 'pixels written')), 'glow-amber'),
    ]),
  ], { side: 'bottom', className: 'sum-stats' });
  const tablePanel = ms.panel(t(L('Vad skiljer API:erna åt', 'How the APIs differ')), [compareTable(ctx)], { className: 'sum-table' });
  const resPanel = ms.panel(t(L('Nästa steg', 'Next steps')), [resourcesList(ctx)], { className: 'sum-res' });
  const showPanels = stepPanels([
    { el: statsPanel, steps: [0] },
    { el: tablePanel, steps: [1] },
    { el: resPanel, steps: [2] },
  ]);
  let last = -1;
  return {
    show(step, animate) {
      const fwd = animate && step > last;
      last = step;
      showPanels(step, animate);
      S.shiftTo(step === 1 ? -0.27 : step === 2 ? -0.16 : 0, animate);
      if (animate && step === 0) gsap.from(S.nodes, { opacity: 0, scale: 0.4, stagger: 0.06, duration: dur(0.4), ease: 'back.out(2)' });
      if (fwd && step === 1) gsap.from(tablePanel.querySelectorAll('tbody tr'), { opacity: 0, x: 16, stagger: 0.05, duration: dur(0.35) });
    },
    destroy() {
      ms.destroy();
    },
  };
}

function conceptVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const S = buildScene(host, ctx, true);
  const { ms } = S;
  const tablePanel = ms.panel(t(L('Vad skiljer API:erna åt', 'How the APIs differ')), [compareTable(ctx)], { className: 'sum-table' });
  const resPanel = ms.panel(t(L('Läs vidare', 'Further reading')), [resourcesList(ctx)], { className: 'sum-res' });
  const showPanels = stepPanels([
    { el: tablePanel, steps: [1] },
    { el: resPanel, steps: [2] },
  ]);
  let last = -1;
  return {
    show(step, animate) {
      const fwd = animate && step > last;
      last = step;
      showPanels(step, animate);
      S.shiftTo(step === 1 ? -0.27 : step === 2 ? -0.16 : 0, animate);
      if (fwd && step === 0) gsap.from(S.nodes, { opacity: 0, scale: 0.4, stagger: 0.06, duration: dur(0.4), ease: 'back.out(2)' });
    },
    destroy() {
      ms.destroy();
    },
  };
}

export default standardSlide({
  id: 'summary',
  group: 'cpu',
  short: L('Sammanfattning', 'Summary'),
  title: L('Hela resan – och vad som skiljer API:erna åt', 'The whole journey – and how the APIs differ'),
  lead: L(
    'Samma tekanna, samma pixlar – oavsett API. Det som skiljer är vem som ansvarar för vad: du eller drivrutinen.',
    'Same teapot, same pixels – whatever the API. What differs is who is responsible for what: you or the driver.',
  ),
  bullets: [
    L(
      '<b>Resan:</b> fil → arrayer på CPU:n → buffertar i VRAM → vertex shader → clipping → rasterisering → fragment shader → djuptest → skärm. Klicka på ett steg för att gå dit.',
      '<b>The journey:</b> file → arrays on the CPU → buffers in VRAM → vertex shader → clipping → rasterization → fragment shader → depth test → screen. Click a stage to jump there.',
    ),
    L(
      '<b>OpenGL</b> gömmer minne, synk och kommandon i drivrutinen. <b>Vulkan</b> och <b>DirectX 12</b> lägger allt det på dig – mer kod, men förutsägbar prestanda och äkta flertrådad inspelning.',
      '<b>OpenGL</b> hides memory, sync and commands inside the driver. <b>Vulkan</b> and <b>DirectX 12</b> hand all of that to you – more code, but predictable performance and true multithreaded recording.',
    ),
    L(
      '<b>Nästa steg:</b> skriv din egen "hello triangle" i det API du är nyfiken på, och ladda in en egen modell här för att se hur siffrorna ändras.',
      '<b>Next step:</b> write your own "hello triangle" in the API you are curious about, and load your own model here to see how the numbers change.',
    ),
  ],
  apiPanel: 'none',
  data: dataVisual,
  concept: conceptVisual,
});
