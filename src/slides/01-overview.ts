import gsap from 'gsap';
import { AdditiveBlending, BackSide, Box3, CanvasTexture, Mesh, MeshBasicMaterial, PlaneGeometry, Vector3, type ShaderMaterial } from 'three';
import { dur, h } from '../core/dom';
import { L, type Text } from '../core/i18n';
import type { ApiId } from '../core/state';
import type { MeshData } from '../model/types';
import { formatBytes } from '../pipeline/layout';
import { createModelStage, secs, type ModelStage, type Particles } from '../views/ModelStage';
import { COLORS, label } from '../views/three-helpers';
import { stat } from '../views/widgets';
import { SLIDES } from './index';
import { standardSlide } from './standard';
import type { ApiPanelSpec, CodeSnippet, SlideContext, StageGroup, Visual } from './types';
import '../styles/slides/overview.css';

/* ------------------------------------------------------------------ */
/* Shared stage table                                                  */
/* ------------------------------------------------------------------ */
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

/* ------------------------------------------------------------------ */
/* The file's first lines as a glowing page in 3D                      */
/* ------------------------------------------------------------------ */
function lineColor(m: MeshData, line: string): string {
  const l = line.trimStart();
  if (m.sourceIsBinary) return '#9fdcff';
  if (l.startsWith('#')) return '#6f78a8';
  if (l.startsWith('vn ') || l.startsWith('facet')) return '#ff3fd2';
  if (l.startsWith('vt ')) return '#ffb547';
  if (l.startsWith('v ') || l.startsWith('vertex')) return '#38e1ff';
  if (l.startsWith('f ')) return '#5cf08f';
  return '#cfd6ff';
}

/** A plane showing the file's text; `sample` gives positions on lit glyph pixels (local space). */
function textPage(m: MeshData, width: number) {
  const CW = 1024;
  const CH = 512;
  const c = document.createElement('canvas');
  c.width = CW;
  c.height = CH;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  const lines = m.sourcePreview.slice(0, 18);
  const lh = Math.min(27, (CH - 24) / Math.max(1, lines.length));
  g.font = `600 ${Math.round(lh * 0.8)}px JetBrains Mono, ui-monospace, monospace`;
  g.textBaseline = 'top';
  lines.forEach((line, i) => {
    g.fillStyle = lineColor(m, line);
    g.fillText(line.slice(0, 66), 20, 12 + i * lh);
  });
  const lit: number[] = [];
  const img = g.getImageData(0, 0, CW, CH).data;
  for (let y = 0; y < CH; y += 2) for (let x = 0; x < CW; x += 2) if (img[(y * CW + x) * 4 + 3] > 120) lit.push(x, y);
  const tex = new CanvasTexture(c);
  const H = (width * CH) / CW;
  const mat = new MeshBasicMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false, blending: AdditiveBlending });
  const mesh = new Mesh(new PlaneGeometry(width, H), mat);
  return {
    mesh,
    mat,
    tex,
    /** n positions on glyph pixels, in the plane's local space. */
    sample(n: number): Float32Array {
      const out = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const k = lit.length ? Math.floor(Math.random() * (lit.length / 2)) * 2 : 0;
        const px = lit[k] ?? Math.random() * CW;
        const py = lit[k + 1] ?? Math.random() * CH;
        out[i * 3] = (px / CW - 0.5) * width;
        out[i * 3 + 1] = (0.5 - py / CH) * H;
        out[i * 3 + 2] = 0;
      }
      return out;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Both modes: the loaded model travels through the pipeline in 3D     */
/** Pull the camera back on narrow views so `halfWidth` world units (around the origin) stay in frame. */
function fitWidth(ms: ModelStage, halfWidth: number): void {
  const base = ms.camera.position.length();
  const prev = ms.view.onResize;
  ms.view.onResize = (w, hh) => {
    prev?.(w, hh);
    const tanH = Math.tan((ms.camera.fov * Math.PI) / 360);
    const need = halfWidth / (tanH * Math.max(0.3, w / hh)) + 0.6;
    ms.camera.position.setLength(Math.max(base, Math.min(12, need)));
  };
}

/* ------------------------------------------------------------------ */
function journeyVisual(host: HTMLElement, ctx: SlideContext, concept: boolean): Visual {
  const { t } = ctx;
  const m = ctx.state.mesh;
  const api = ctx.state.api;
  const l = ctx.derived.layout;
  const notes = annotations(ctx);
  const st = ctx.derived.render(api, RW, RH).stats;
  const ms = createModelStage(host, ctx, {
    eye: [0, 1.0, 4.3],
    autoRotate: 0,
    bloom: concept ? 0.6 : 0.55,
    bloomThreshold: concept ? 0.88 : 0.82,
    layers: { solid: 0, wire: 0, points: 0, normals: 0 },
  });
  ms.overlay.classList.add('ov-ms');
  fitWidth(ms, 2.25);
  const u = ms.material.uniforms;
  const world = new Vector3();

  /* ---- 3D props ---- */
  // Step 0: the file's text, in front of where the model will be.
  const page = textPage(m, 2.9);
  page.mesh.position.set(0, 0.1, 0.45);
  page.mesh.lookAt(ms.camera.position);
  ms.scene.add(page.mesh);
  // Step 1: system RAM → VRAM.
  const RX = -1.8;
  const ram = ms.box(t(L('RAM · CPU', 'RAM · CPU')), [RX, 0.15, 0], [0.7, 0.7, 0.7], COLORS.cyan);
  // VRAM box: snug around the model as it sits in the scene.
  ms.pivot.updateMatrixWorld(true);
  const bb = new Box3().setFromObject(ms.layers.solid, true);
  const bc = bb.getCenter(new Vector3());
  const bs = bb.getSize(new Vector3()).multiplyScalar(1.06).addScalar(0.1);
  if (concept) bs.x = bs.z = Math.max(bs.x, bs.z);
  const vram = ms.box(t(L('VRAM · GPU', 'VRAM · GPU')), [bc.x, bc.y, bc.z], [bs.x, bs.y, bs.z], COLORS.violet);
  [ram, vram].forEach((b) => b.traverse((o) => {
    const mm = (o as Mesh).material as MeshBasicMaterial | undefined;
    if (o instanceof Mesh && mm) mm.opacity = 0.035;
  }));
  const drawName = { opengl: 'glDrawElements', vulkan: 'vkCmdDrawIndexed', d3d12: 'DrawIndexedInstanced' }[api];
  const drawLbl = label(`${drawName}(${m.indices.length.toLocaleString('en-US')})`, 'amber');
  drawLbl.position.set(bc.x, bc.y + bs.y / 2 + 0.5, bc.z);
  ms.scene.add(drawLbl);
  // Step 3: the real software render as a framebuffer.
  const SW = 64;
  const SH = 40;
  const screen = ms.screenPlane(ctx.derived.render(api, SW, SH).color, SW, SH, 1.2);
  screen.mesh.position.set(-1.62, 0.55, 0.3);
  screen.mesh.lookAt(ms.camera.position);
  const screenLbl = label(`${SW}×${SH} · ${t(L('swapchain-bild', 'swapchain image'))}`, 'amber');
  screenLbl.position.set(-1.62, 0.55 + (1.2 * SH) / SW / 2 + 0.16, 0.3);
  // Step 2: the faces that point away, drawn on their own in red (they are culled).
  const backMat = ms.material.clone() as typeof ms.material;
  backMat.uniforms = { ...ms.material.uniforms, uBackTint: { value: 0.85 }, uOpacity: { value: 1 }, uModeMix: { value: 0 } };
  backMat.side = BackSide;
  // three.js flips the winding for BackSide, so gl_FrontFacing is true here: tint unconditionally.
  backMat.fragmentShader = backMat.fragmentShader
    .replace('if (!gl_FrontFacing) n = -n;', 'n = -n;')
    .replace('if (!gl_FrontFacing) c = mix(', 'c = mix(');
  backMat.transparent = false;
  const back = new Mesh(ms.layers.solid.geometry, backMat);
  back.renderOrder = -1;
  back.visible = false;
  ms.pivot.add(back);
  ms.scene.add(screenLbl);

  // Particle flights (world space, targets recomputed from the model's current pose).
  const N = Math.min(2400, Math.max(700, m.vertexCount));
  const textFlow = ms.particles(N, COLORS.cyan, 0.028, 'world');
  const busFlow = ms.particles(N, COLORS.violet, 0.03, 'world');
  ms.pivot.updateMatrixWorld(true);
  page.mesh.updateMatrixWorld(true);
  const textFrom = page.sample(N);
  for (let i = 0; i < N; i++) world.fromArray(textFrom, i * 3).applyMatrix4(page.mesh.matrixWorld).toArray(textFrom, i * 3);
  const ramFrom = new Float32Array(N * 3);
  const side = Math.ceil(Math.cbrt(N));
  for (let i = 0; i < N; i++) {
    // Packed, in buffer order: a dense lattice inside the RAM box.
    ramFrom[i * 3] = RX + ((i % side) / (side - 1 || 1) - 0.5) * 0.52;
    ramFrom[i * 3 + 1] = 0.15 + ((Math.floor(i / side) % side) / (side - 1 || 1) - 0.5) * 0.52;
    ramFrom[i * 3 + 2] = ((Math.floor(i / (side * side)) % side) / (side - 1 || 1) - 0.5) * 0.52;
  }
  const home = ms.samplePositions(N);
  const homeWorld = () => {
    ms.pivot.updateMatrixWorld(true);
    const out = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) world.fromArray(home, i * 3).applyMatrix4(ms.pivot.matrixWorld).toArray(out, i * 3);
    return out;
  };

  /* ---- panels ---- */
  const fmt = m.format === 'builtin' ? 'OBJ' : m.format;
  const stats: HTMLElement[][] = [
    [stat(formatBytes(m.fileSize), `${fmt} · ${t(L('på disk', 'on disk'))}`, 'glow-amber'), stat(k(m.vertexCount), 'vertices', 'glow-cyan'), stat(k(m.triangleCount), t(L('trianglar', 'triangles')), 'glow-magenta')],
    [stat(formatBytes(l.vertexBytes + l.indexBytes), 'VB + IB', 'glow-cyan'), stat(`${l.stride} B`, 'stride'), stat(k(m.indices.length), t(L('index i draw', 'indices drawn')), 'glow-amber')],
    [stat(k(st.trianglesIn), t(L('trianglar in', 'triangles in'))), stat(k(st.culled), t(L('bortvända · culled', 'back-faces culled')), 'glow-magenta'), stat(k(st.clippedAway + st.clipped), t(L('klippta', 'clipped')))],
    [stat(k(st.fragments), 'fragments', 'glow-amber'), stat(k(st.written), t(L('pixlar skrivna', 'pixels written')), 'glow-cyan'), stat(k(st.depthRejected), t(L('djup-avvisade', 'depth-rejected')))],
  ];
  const hints: Text[] = [
    L(`Parsat från ${fmt}, packat ${l.stride} B per vertex i RAM.`, `Parsed from ${fmt}, packed ${l.stride} B per vertex in RAM.`),
    L(`Uppladdat till VRAM; ett ${drawName} ritar allt.`, `Uploaded to VRAM; one ${drawName} draws it all.`),
    L(`Räknat av CPU-rastreraren vid ${RW}×${RH} – röda ytor vänder bort och slängs.`, `Counted by the CPU rasterizer at ${RW}×${RH} – red faces point away and are discarded.`),
    L(`Vid ${RW}×${RH}; bilden till vänster är den verkliga renderingen.`, `At ${RW}×${RH}; the image on the left is the real render.`),
  ];
  const captions: Text[] = [
    L('Text och bytes från filen blir siffror i CPU-minnet – tecknen blir punkter som bildar modellen.', 'Text and bytes from the file become numbers in CPU memory – the characters turn into points that form the model.'),
    L('API:t och drivrutinen flyttar siffrorna från RAM till GPU:ns VRAM, där de bildar modellen igen. Sedan spelas ett draw-kommando in.', 'The API and driver move the numbers from RAM into the GPU\'s VRAM, where they form the model again. Then a draw command is recorded.'),
    L('GPU:n transformerar varje vertex och sätter ihop trianglar. De som vänder bort (röda) eller hamnar utanför slängs.', 'The GPU transforms every vertex and assembles triangles. Those facing away (red) or outside the view are discarded.'),
    L('Trianglarna blir pixlar som färgas, djuptestas och hamnar i swapchain-bilden som visas på skärmen.', 'Triangles become pixels that are shaded, depth tested and land in the swapchain image shown on screen.'),
  ];
  const info = ms.panel(t(LANES[0].title), [], { side: 'right', className: 'ov-info' });
  const infoTitle = info.querySelector('.ms-head span')!;
  const infoBody = info.querySelector('.ms-body')!;

  const laneEls = LANES.map((lane) => {
    const chips = lane.stages.map((sg) =>
      h('button.ov-chip', { attrs: { type: 'button', title: `${t(L('Gå till', 'Go to'))}: ${t(sg.label)}` }, style: { color: GROUP_HEX[sg.group] }, on: { click: () => goTo(sg.slide) } }, [
        h('span', { text: t(sg.label) }),
        concept ? null : h('small', { text: notes[sg.id] }),
      ]),
    );
    const el = ms.panel(t(lane.title), [h('div.ov-chips', {}, chips)], { side: 'bottom', className: 'ov-lane-panel', collapsed: true });
    el.style.setProperty('--lane', lane.color);
    return el;
  });

  /* ---- animation state ---- */
  let step = -1;
  let flying = false;
  const timers: gsap.core.Tween[] = [];
  const later = (animate: boolean, s: number, fn: () => void) => {
    if (!animate) fn();
    else timers.push(gsap.delayedCall(dur(s), fn));
  };
  const fly = (p: Particles, from: Float32Array, animate: boolean, s: number, after: () => void) => {
    p.setTargets(from, homeWorld());
    p.points.visible = true;
    p.progress(0, 0);
    if (!animate) {
      p.points.visible = false;
      after();
      return;
    }
    flying = true;
    p.progress(1, s);
    later(true, s + 0.1, () => {
      flying = false;
      p.points.visible = false;
      after();
    });
  };
  const pmat = (p: Particles) => (p.points.material as ShaderMaterial).uniforms.uProgress;

  ms.onFrame((time, dt) => {
    if (concept && !flying) ms.pivot.rotation.y += dt * 0.2;
    if (step === 2) u.uExplode.value = 0.05 + 0.035 * Math.sin(time * 1.8);
  });

  return {
    show(stp, animate) {
      step = stp;
      const S = (s: number) => secs(animate, s);
      timers.splice(0).forEach((x) => x.kill());
      gsap.killTweensOf([...Object.values(u), ...Object.values(ms.layers).map((x) => x.material), page.mat, pmat(textFlow), pmat(busFlow)]);
      flying = false;
      u.uSweep.value = 100;

      // Panels
      infoTitle.textContent = t(LANES[step].title);
      infoBody.replaceChildren(
        ...(concept ? [h('p.ov-cap', { html: t(captions[step]) })] : [h('div.stat-row', {}, stats[step]), h('div.hint.ov-hint', { text: t(hints[step]) })]),
      );
      info.style.setProperty('--lane', LANES[step].color);
      laneEls.forEach((el, i) => {
        el.classList.toggle('collapsed', i !== step);
        el.classList.toggle('cur', i === step);
        el.classList.toggle('done', i < step);
      });
      if (animate) gsap.fromTo(info, { opacity: 0, y: -8 }, { opacity: 1, y: 0, duration: dur(0.4) });

      // Reset everything that differs between steps.
      page.mesh.visible = step === 0;
      ram.visible = step === 1;
      vram.visible = step === 1;
      drawLbl.visible = step === 1;
      screen.mesh.visible = step === 3;
      screenLbl.visible = step === 3;
      textFlow.points.visible = false;
      busFlow.points.visible = false;
      back.visible = step === 2;
      ms.material.depthWrite = step !== 2;
      ms.material.needsUpdate = true;
      ms.setMode(step === 2 ? 'triangleId' : 'shaded', 0.35, S(0.6));
      if (step !== 2) ms.explode(0, S(0.5));
      ms.highlightTriangle(null);

      if (step === 0) {
        // Text → numbers → points that assemble into the model.
        ms.setLayer('solid', 0, S(0.4));
        ms.setLayer('wire', 0, S(0.4));
        ms.setLayer('points', 0, 0);
        page.mat.opacity = animate ? 0.9 : 0.14;
        if (animate) ms.tween(page.mat, { opacity: 0.14, duration: dur(2.6), delay: dur(0.5), ease: 'power1.in' });
        fly(textFlow, textFrom, animate, 2.8, () => {
          ms.setLayer('points', 0.85, S(0.5));
          ms.setLayer('wire', 0.12, S(0.8));
        });
      } else if (step === 1) {
        // RAM → VRAM: the packed data streams across and forms the model again.
        ms.setLayer('solid', 0, S(0.3));
        ms.setLayer('wire', 0, S(0.3));
        ms.setLayer('points', 0, S(0.3));
        fly(busFlow, ramFrom, animate, 2.6, () => {
          ms.setMode('ghost', 1, 0);
          ms.setLayer('points', 0.6, S(0.4));
          ms.setLayer('wire', 0.22, S(0.6));
          ms.setLayer('solid', 1, S(0.8));
        });
      } else if (step === 2) {
        // Geometry: vertices transformed (gently pulsing apart), triangles assembled, back-faces culled (red).
        ms.setLayer('solid', 0.45, S(0.6));
        ms.setLayer('wire', 0.3, S(0.6));
        ms.setLayer('points', 0.9, S(0.6));
        ms.highlightTriangle(ctx.derived.showcaseTriangle(api), COLORS.green);
      } else {
        // Pixels: the triangles are filled in and the real framebuffer appears.
        ms.setLayer('solid', 1, S(0.4));
        ms.setLayer('wire', 0, S(0.8));
        ms.setLayer('points', 0, S(0.8));
        if (animate) ms.sweep('shaded', 'ghost', 1.6);
        screen.reveal(0, 0);
        screen.reveal(1, S(2.2));
      }
    },
    destroy() {
      timers.forEach((x) => x.kill());
      gsap.killTweensOf(info);
      page.tex.dispose();
      backMat.dispose();
      ms.destroy();
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
  data: (host, ctx) => journeyVisual(host, ctx, false),
  concept: (host, ctx) => journeyVisual(host, ctx, true),
});
