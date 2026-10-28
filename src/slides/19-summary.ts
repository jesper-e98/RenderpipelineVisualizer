import gsap from 'gsap';
import { dur, h } from '../core/dom';
import { L, type Text } from '../core/i18n';
import { API_LIST, type ApiId } from '../core/state';
import { formatBytes } from '../pipeline/layout';
import { PixelCanvas } from '../views/PixelCanvas';
import { stat } from '../views/widgets';
import { standardSlide } from './standard';
import type { SlideContext, Visual } from './types';
import '../styles/slides/summary.css';

type Row = { k: Text; v: Record<ApiId, Text> };

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

function journeyStrip(ctx: SlideContext): { el: HTMLElement; chips: HTMLElement[] } {
  const chips = JOURNEY.map((j) =>
    h('button.j-chip', { dataset: { group: j.group }, text: ctx.t(j.label), on: { click: () => goTo(j.id) } }),
  );
  const el = h('div.journey', {}, [h('div.j-track', {}, [h('div.j-packet')]), ...chips]);
  return { el, chips };
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

function dataVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const api = ctx.state.api;
  const mesh = ctx.state.mesh;
  const r = ctx.derived.render(api, 240, 150);
  const l = ctx.derived.layout;
  const journey = journeyStrip(ctx);

  const imgHost = h('div.sum-img');
  const pc = new PixelCanvas(imgHost, r.width, r.height, 6);
  const draw = () => {
    pc.clear();
    pc.image(r.color);
  };
  pc.onResize(draw);
  draw();

  const stats = h('div.stat-row', {}, [
    stat(formatBytes(mesh.fileSize), t(L('fil', 'file'))),
    stat(formatBytes(l.vertexBytes + l.indexBytes), t(L('GPU-buffertar', 'GPU buffers')), 'glow-cyan'),
    stat(mesh.vertexCount.toLocaleString(), t(L('vertex shader-anrop (minst)', 'vertex shader runs (min)'))),
    stat(r.stats.culled.toLocaleString(), t(L('trianglar bortsorterade', 'triangles culled')), 'glow-magenta'),
    stat(r.stats.fragments.toLocaleString(), t(L(`fragment @ ${r.width}×${r.height}`, `fragments @ ${r.width}×${r.height}`))),
    stat(r.stats.written.toLocaleString(), t(L('pixlar skrivna', 'pixels written')), 'glow-amber'),
  ]);
  const page0 = h('div.sum-page', {}, [journey.el, h('div.sum-row', {}, [imgHost, stats])]);
  const page1 = h('div.sum-page.v-scroll', {}, [compareTable(ctx)]);
  const page2 = h('div.sum-page', {}, [journey.el.cloneNode(true) as HTMLElement, resourcesList(ctx)]);
  page2.querySelectorAll<HTMLElement>('.j-chip').forEach((c, i) => c.addEventListener('click', () => goTo(JOURNEY[i].id)));
  const pages = [page0, page1, page2];
  host.append(h('div.v-fill.sum', {}, pages));

  return {
    show(step, animate) {
      pages.forEach((p, i) => (p.style.display = i === step ? '' : 'none'));
      if (!animate) return;
      gsap.fromTo(pages[step], { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: dur(0.5) });
      if (step === 0) gsap.from(journey.chips, { opacity: 0, y: 10, stagger: 0.06, duration: dur(0.35) });
      if (step === 1) gsap.from(pages[1].querySelectorAll('tbody tr'), { opacity: 0, x: -16, stagger: 0.05, duration: dur(0.35) });
    },
    destroy() {
      pc.destroy();
    },
  };
}

function conceptVisual(host: HTMLElement, ctx: SlideContext): Visual {
  // A glowing loop of all stages with packets circling it – the frame loop that never ends.
  const wrap = h('div.v-fill.loop');
  const ring = h('div.loop-ring');
  const n = JOURNEY.length;
  const nodes = JOURNEY.map((j, i) => {
    const el = h('button.loop-node', { dataset: { group: j.group }, text: ctx.t(j.label), on: { click: () => goTo(j.id) } });
    el.style.setProperty('--a', `${(i / n) * 360}deg`);
    return el;
  });
  const packets = Array.from({ length: 3 }, (_, i) => {
    const p = h('div.loop-packet');
    p.style.animationDelay = `${-i * 2}s`;
    return p;
  });
  const center = h('div.loop-center', {}, [
    h('div.loop-fps', { text: '60' }),
    h('div.hint', { text: ctx.t(L('bilder per sekund – hela resan, varje bildruta', 'frames per second – the whole journey, every frame')) }),
  ]);
  ring.append(...nodes, ...packets);
  wrap.append(ring, center);
  const table = h('div.v-fill.v-scroll.pad', {}, [compareTable(ctx)]);
  const res = h('div.v-fill.v-center', {}, [resourcesList(ctx)]);
  host.append(wrap, table, res);
  const pages = [wrap, table, res];
  return {
    show(step, animate) {
      pages.forEach((p, i) => (p.style.display = i === step ? '' : 'none'));
      if (animate && step === 0) gsap.from(nodes, { scale: 0, opacity: 0, stagger: 0.05, duration: dur(0.5), ease: 'back.out(2)' });
      if (animate && step > 0) gsap.fromTo(pages[step], { opacity: 0 }, { opacity: 1, duration: dur(0.4) });
    },
    destroy() {},
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
