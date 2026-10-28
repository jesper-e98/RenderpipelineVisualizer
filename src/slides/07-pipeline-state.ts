import gsap from 'gsap';
import { dur, h, reducedMotion } from '../core/dom';
import { L, type Text } from '../core/i18n';
import type { ApiId } from '../core/state';
import { card, stat } from '../views/widgets';
import '../styles/slides/pipeline-state.css';
import { standardSlide } from './standard';
import type { ApiPanelSpec, SlideContext, Visual } from './types';

/** The viewport every API-level slide assumes (also used by the descriptors and commands slides). */
const VIEWPORT = { w: 1920, h: 1080 };

type Kind = 'baked' | 'dynamic' | 'global' | 'fb' | 'cmd';

interface StateRow {
  what: Text;
  value: Text;
  spell: Record<ApiId, string>;
  kind: Record<ApiId, Kind>;
}

/** The pipeline state this app really uses, spelled out in each API. */
function stateRows(ctx: SlideContext): StateRow[] {
  const lay = ctx.derived.layout;
  const sems = lay.attributes.map((a) => a.semantic).join(', ');
  const idx = ctx.state.mesh.indices.length;
  const B: Record<ApiId, Kind> = { opengl: 'global', vulkan: 'baked', d3d12: 'baked' };
  return [
    {
      what: L('Shaders', 'Shaders'),
      value: 'shade VS + FS',
      spell: { opengl: 'glUseProgram(prog)', vulkan: 'stageCount = 2, pStages = { vert, frag }', d3d12: 'VS = shade_vs.cso, PS = shade_ps.cso' },
      kind: B,
    },
    {
      what: L('Vertexindata', 'Vertex input'),
      value: `${lay.attributes.length} attr · stride ${lay.stride} B`,
      spell: {
        opengl: 'glBindVertexArray(vao)   // VAO holds the format',
        vulkan: `pVertexInputState: 1 binding, ${lay.attributes.length} attributes`,
        d3d12: `InputLayout = { ${sems} }`,
      },
      kind: B,
    },
    {
      what: L('Topologi', 'Topology'),
      value: L('triangellista', 'triangle list'),
      spell: {
        opengl: `glDrawElements(GL_TRIANGLES, ${idx}, …)`,
        vulkan: 'topology = VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST',
        d3d12: 'PrimitiveTopologyType = D3D12_PRIMITIVE_TOPOLOGY_TYPE_TRIANGLE',
      },
      kind: { opengl: 'cmd', vulkan: 'baked', d3d12: 'baked' },
    },
    {
      what: L('Culling', 'Culling'),
      value: L('baksidor bort', 'cull back faces'),
      spell: { opengl: 'glEnable(GL_CULL_FACE); glCullFace(GL_BACK)', vulkan: 'cullMode = VK_CULL_MODE_BACK_BIT', d3d12: 'CullMode = D3D12_CULL_MODE_BACK' },
      kind: B,
    },
    {
      what: L('Framsida', 'Front face'),
      value: L('moturs (CCW)', 'counter-clockwise'),
      spell: { opengl: 'glFrontFace(GL_CCW)', vulkan: 'frontFace = VK_FRONT_FACE_COUNTER_CLOCKWISE', d3d12: 'FrontCounterClockwise = TRUE' },
      kind: B,
    },
    {
      what: L('Djuptest', 'Depth test'),
      value: 'on · LESS',
      spell: {
        opengl: 'glEnable(GL_DEPTH_TEST); glDepthFunc(GL_LESS)',
        vulkan: 'depthTestEnable = VK_TRUE, depthCompareOp = VK_COMPARE_OP_LESS',
        d3d12: 'DepthEnable = TRUE, DepthFunc = D3D12_COMPARISON_FUNC_LESS',
      },
      kind: B,
    },
    {
      what: L('Djupskrivning', 'Depth write'),
      value: 'on',
      spell: { opengl: 'glDepthMask(GL_TRUE)', vulkan: 'depthWriteEnable = VK_TRUE', d3d12: 'DepthWriteMask = D3D12_DEPTH_WRITE_MASK_ALL' },
      kind: B,
    },
    {
      what: L('Blending', 'Blending'),
      value: 'off · RGBA write',
      spell: {
        opengl: 'glDisable(GL_BLEND); glColorMask(1, 1, 1, 1)',
        vulkan: 'blendEnable = VK_FALSE, colorWriteMask = R|G|B|A',
        d3d12: 'BlendEnable = FALSE, RenderTargetWriteMask = ALL',
      },
      kind: B,
    },
    {
      what: L('Färgformat', 'Color format'),
      value: 'RGBA8 sRGB',
      spell: {
        opengl: 'FBO: GL_SRGB8_ALPHA8 + glEnable(GL_FRAMEBUFFER_SRGB)',
        vulkan: 'pColorAttachmentFormats = { VK_FORMAT_R8G8B8A8_SRGB }',
        d3d12: 'NumRenderTargets = 1, RTVFormats[0] = DXGI_FORMAT_R8G8B8A8_UNORM_SRGB',
      },
      kind: { opengl: 'fb', vulkan: 'baked', d3d12: 'baked' },
    },
    {
      what: L('Djupformat', 'Depth format'),
      value: 'D32 float',
      spell: { opengl: 'FBO: GL_DEPTH_COMPONENT32F', vulkan: 'depthAttachmentFormat = VK_FORMAT_D32_SFLOAT', d3d12: 'DSVFormat = DXGI_FORMAT_D32_FLOAT' },
      kind: { opengl: 'fb', vulkan: 'baked', d3d12: 'baked' },
    },
    {
      what: L('Multisampling', 'Multisampling'),
      value: '1 sample',
      spell: { opengl: 'FBO: samples = 0 (no MSAA)', vulkan: 'rasterizationSamples = VK_SAMPLE_COUNT_1_BIT', d3d12: 'SampleDesc = { 1, 0 }, SampleMask = UINT_MAX' },
      kind: { opengl: 'fb', vulkan: 'baked', d3d12: 'baked' },
    },
    {
      what: L('Resurslayout', 'Resource layout'),
      value: 'UBO/CBV @ 0',
      spell: { opengl: 'layout(binding = 0) uniform Transforms', vulkan: 'layout = pipelineLayout   // set 0: 1 UBO', d3d12: 'pRootSignature = rootSig   // b0: root CBV' },
      kind: B,
    },
    {
      what: L('Viewport / scissor', 'Viewport / scissor'),
      value: `${VIEWPORT.w} × ${VIEWPORT.h}`,
      spell: {
        opengl: `glViewport(0, 0, ${VIEWPORT.w}, ${VIEWPORT.h})`,
        vulkan: 'VK_DYNAMIC_STATE_VIEWPORT, _SCISSOR → vkCmdSetViewport',
        d3d12: 'RSSetViewports / RSSetScissorRects (command list)',
      },
      kind: { opengl: 'global', vulkan: 'dynamic', d3d12: 'cmd' },
    },
  ];
}

const KIND_LABEL: Record<Kind, Text> = {
  baked: L('bakad', 'baked'),
  dynamic: L('dynamisk', 'dynamic'),
  global: L('global', 'global'),
  fb: L('framebuffer', 'framebuffer'),
  cmd: L('per anrop', 'per call'),
};

/* ------------------------------------------------------------------ */
/* Real data: the state object table                                   */
/* ------------------------------------------------------------------ */
function dataVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const api = ctx.state.api;
  const rows = stateRows(ctx);
  const r = ctx.derived.render(api, 160, 100);
  const st = r.stats;
  const spellHead: Record<ApiId, string> = {
    opengl: t(L('OpenGL-anrop', 'OpenGL call')),
    vulkan: 'VkGraphicsPipelineCreateInfo',
    d3d12: 'D3D12_GRAPHICS_PIPELINE_STATE_DESC',
  };
  const trs = rows.map((row) =>
    h('tr', { dataset: { kind: row.kind[api] } }, [
      h('td.ps-what', { text: t(row.what) }),
      h('td.ps-val', { text: t(row.value) }),
      h('td.ps-spell.c3', { text: row.spell[api] }),
      h('td.c4', {}, [h(`span.ps-kind.k-${row.kind[api]}`, { text: t(KIND_LABEL[row.kind[api]]) })]),
    ]),
  );
  const table = h('table.ps-table', {}, [
    h('thead', {}, [
      h('tr', {}, [
        h('th', { text: t(L('State', 'State')) }),
        h('th', { text: t(L('Den här appen', 'This app')) }),
        h('th.c3', { text: spellHead[api] }),
        h('th.c4', { text: api === 'opengl' ? t(L('lagras', 'lives in')) : t(L('bakad?', 'baked?')) }),
      ]),
    ]),
    h('tbody', {}, trs),
  ]);
  const tableCard = h('div.card.ps-tablecard', {}, [
    h('h4', {
      text: api === 'opengl' ? t(L('OpenGL-kontextens state för draw-anropet', 'OpenGL context state for the draw call')) : api === 'vulkan' ? 'VkPipeline · vkCreateGraphicsPipelines' : 'ID3D12PipelineState · CreateGraphicsPipelineState',
    }),
    h('div.v-scroll.ps-scroll', {}, [table]),
  ]);

  const calls = rows.reduce((n, row) => n + (row.kind.opengl === 'global' ? row.spell.opengl.split(';').length : 0), 0);
  const baked = rows.filter((row) => row.kind[api] === 'baked').length;
  const notes: Text[] = [
    L(
      `Effekt i en testrendering 160×100: culling tog bort ${st.culled} av ${st.trianglesIn} trianglar, djuptestet stoppade ${st.depthRejected} fragment.`,
      `Effect in a 160×100 test render: culling removed ${st.culled} of ${st.trianglesIn} triangles, the depth test rejected ${st.depthRejected} fragments.`,
    ),
    api === 'opengl'
      ? L(`${calls} separata state-anrop före draw. Inget kontrolleras förrän <code>glDrawElements</code>.`, `${calls} separate state calls before the draw. Nothing is checked until <code>glDrawElements</code>.`)
      : L(`Alla ${rows.length} rader fylls i en enda struct och skickas i <b>ett</b> anrop.`, `All ${rows.length} rows are filled into one struct and sent in <b>one</b> call.`),
    api === 'opengl'
      ? L('Allt är global kontext-state: varje draw ser den kombination som råkar gälla just då.', 'Everything is global context state: each draw sees whatever combination is current at that moment.')
      : L(`${baked} av ${rows.length} bakas in och kan inte ändras – ett nytt värde kräver en ny pipeline.`, `${baked} of ${rows.length} are baked in and immutable – a new value needs a new pipeline.`),
    api === 'opengl'
      ? L('Drivrutinen hashar state vid draw och kan behöva kompilera en ny shadervariant – ett hack på flera ms.', 'The driver hashes state at draw time and may need to compile a new shader variant – a hitch of several ms.')
      : api === 'vulkan'
        ? L('Skapas vid laddning med en <code>VkPipelineCache</code> (spara till disk). Per draw: bara <code>vkCmdBindPipeline</code>.', 'Created at load time with a <code>VkPipelineCache</code> (saved to disk). Per draw: just <code>vkCmdBindPipeline</code>.')
        : L('Skapas vid laddning; <code>ID3D12PipelineLibrary</code> eller <code>GetCachedBlob</code> sparar den. Per draw: bara <code>SetPipelineState</code>.', 'Created at load time; <code>ID3D12PipelineLibrary</code> or <code>GetCachedBlob</code> saves it. Per draw: just <code>SetPipelineState</code>.'),
  ];
  const note = h('p.ps-note');
  const side = h('div.ps-side', {}, [
    stat(`${st.culled}`, t(L('trianglar cullade', 'triangles culled')), 'glow-cyan'),
    stat(`${st.depthRejected}`, t(L('fragment djup-avvisade', 'fragments depth-rejected')), 'glow-magenta'),
    stat(api === 'opengl' ? `${calls}` : '1', api === 'opengl' ? t(L('state-anrop / draw', 'state calls / draw')) : t(L('bind / draw', 'bind / draw')), 'glow-amber'),
    card(t(L('Notera', 'Note')), [note], 'ps-notecard'),
  ]);
  const root = h('div.ps-data', { dataset: { api } }, [tableCard, side]);
  host.append(root);
  const c3 = Array.from(root.querySelectorAll<HTMLElement>('.c3'));
  const c4 = Array.from(root.querySelectorAll<HTMLElement>('.c4'));

  return {
    show(step, animate) {
      root.dataset.step = String(step);
      note.innerHTML = t(notes[step]);
      const vis3 = step >= 1;
      const vis4 = step >= 2;
      const set = (els: HTMLElement[], vis: boolean, fresh: boolean) => {
        if (animate && fresh && vis) gsap.fromTo(els, { opacity: 0, x: -10 }, { opacity: 1, x: 0, stagger: 0.03, duration: dur(0.3) });
        else gsap.set(els, { opacity: vis ? 1 : 0, x: 0 });
      };
      set(c3, vis3, step === 1);
      set(c4, vis4, step === 2);
      trs.forEach((tr) => tr.classList.toggle('dim', step === 3 && api !== 'opengl' && tr.dataset.kind === 'baked'));
      if (animate) gsap.fromTo(note, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: dur(0.35) });
    },
    destroy() {
      gsap.killTweensOf([...c3, ...c4, note]);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Concept: a panel of switches vs one sealed, pre-baked block          */
/* ------------------------------------------------------------------ */
const SWITCHES: { name: string; call: string; on: boolean }[] = [
  { name: 'DEPTH_TEST', call: 'glEnable(GL_DEPTH_TEST)', on: true },
  { name: 'DepthFunc', call: 'glDepthFunc(GL_LESS)', on: true },
  { name: 'CULL_FACE', call: 'glEnable(GL_CULL_FACE)', on: true },
  { name: 'CullFace', call: 'glCullFace(GL_BACK)', on: true },
  { name: 'FrontFace', call: 'glFrontFace(GL_CCW)', on: true },
  { name: 'BLEND', call: 'glDisable(GL_BLEND)', on: false },
  { name: 'Program', call: 'glUseProgram(prog)', on: true },
  { name: 'VAO', call: 'glBindVertexArray(vao)', on: true },
];
const CHIPS = ['shaders', 'vertex input', 'topology', 'raster · cull', 'depth LESS', 'blend off', 'formats', 'layout'];

function conceptVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const api = ctx.state.api;
  const motion = !reducedMotion();

  // Left: OpenGL state machine.
  const swRows = SWITCHES.map((s) =>
    h('div.psc-sw', {}, [h('span.psc-toggle', {}, [h('span.psc-knob')]), h('span.psc-lbl', {}, [h('span.psc-name', { text: s.name }), h('code.psc-call', { text: s.call })])]),
  );
  const bars = Array.from({ length: 22 }, (_, i) => h(`span.psc-bar${i === 15 ? '.spike' : ''}`, { style: { height: `${i === 15 ? 92 : 22 + ((i * 37) % 19)}%` } }));
  const left = h('div.psc-pane.gl', {}, [
    h('div.psc-head', {}, [h('b', { text: 'OpenGL' }), h('span', { text: t(L('global state-maskin', 'global state machine')) })]),
    h('div.psc-switches', {}, swRows),
    h('div.psc-draw', {}, [
      h('span.psc-drawcall', { text: 'glDrawElements' }),
      h('span.psc-validate', { text: t(L('validera all state…', 'validate all state…')) }),
      h('span.psc-warn', { text: t(L('⚠ ny shadervariant', '⚠ new shader variant')) }),
    ]),
    h('div.psc-frames', {}, [h('span.psc-frames-l', { text: t(L('frame-tid', 'frame time')) }), ...bars]),
    h('div.psc-scan'),
  ]);

  // Right: the pipeline object.
  const objName = api === 'vulkan' ? 'VkPipeline' : api === 'd3d12' ? 'ID3D12PipelineState' : 'VkPipeline / ID3D12PipelineState';
  const cacheName = api === 'vulkan' ? 'VkPipelineCache' : api === 'd3d12' ? 'ID3D12PipelineLibrary' : 'pipeline cache';
  const chipEls = CHIPS.map((c) => h('div.psc-chip', { text: c }));
  const block = h('div.psc-block', {}, [h('div.psc-block-name', { text: objName }), h('div.psc-lock', { text: t(L('oföränderlig', 'immutable')) }), h('div.psc-shine')]);
  const dyn = ['viewport', 'scissor'].map((d) => h('div.psc-dyn', {}, [h('span.psc-dyn-dot'), d]));
  const cache = h('div.psc-cache', {}, [h('div.psc-disk'), h('span', { text: cacheName })]);
  const ghost = h('div.psc-ghost');
  const bind = h('div.psc-bind', { text: api === 'd3d12' ? 'SetPipelineState' : 'vkCmdBindPipeline' });
  const area = h('div.psc-area', {}, [block, ...chipEls, ...dyn, cache, ghost, bind]);
  const right = h('div.psc-pane.pso', {}, [
    h('div.psc-head', {}, [h('b', { text: api === 'opengl' ? 'Vulkan / D3D12' : api === 'vulkan' ? 'Vulkan' : 'Direct3D 12' }), h('span', { text: t(L('förbakat pipeline-objekt', 'pre-baked pipeline object')) })]),
    area,
  ]);
  (api === 'opengl' ? left : right).classList.add('mine');

  const caption = h('div.pack-caption.psc-caption');
  host.append(h('div.psc-root', {}, [left, right]), caption);

  const captions = [
    L('Samma frågor måste besvaras för varje draw: vilka shaders, vilken topologi, culling, djup, blending, format…', 'The same questions must be answered for every draw: which shaders, which topology, culling, depth, blending, formats…'),
    L('OpenGL: brytare som slås om en i taget. Först vid draw-anropet ser drivrutinen hela kombinationen – och kan behöva kompilera om (spiken i frame-tiden).', 'OpenGL: switches flipped one at a time. Only at the draw call does the driver see the whole combination – and it may have to recompile (the spike in frame time).'),
    L('Vulkan/D3D12: allt förseglas i ett oföränderligt objekt i förväg. Drivrutinen kompilerar en gång; varje draw binder bara blocket.', 'Vulkan/D3D12: everything is sealed into one immutable object up front. The driver compiles once; each draw just binds the block.'),
    L('Lite state får vara dynamisk (viewport, scissor). Färdiga pipelines sparas i en cache så nästa start går snabbt.', 'A little state may stay dynamic (viewport, scissor). Finished pipelines are saved in a cache so the next launch is fast.'),
  ];

  // Chip positions: scattered (fractions of the area) or packed in the block (2 × 4 grid).
  const SCATTER = [[0.06, 0.08], [0.55, 0.04], [0.3, 0.26], [0.72, 0.3], [0.08, 0.5], [0.48, 0.55], [0.18, 0.76], [0.66, 0.78]];
  const ROT = [-8, 6, -4, 9, 5, -7, 7, -5];
  let step = 0;

  const layout = (animate: boolean) => {
    const W = area.clientWidth;
    const H = area.clientHeight;
    if (!W || !H) return;
    const packed = step >= 2;
    const bw = step >= 3 ? Math.min(W * 0.56, 270) : Math.min(W * 0.62, 300);
    const bh = Math.min(H * 0.72, 190);
    const bx = step >= 3 ? 8 : (W - bw) / 2;
    const by = 6;
    const cw = (bw - 30) / 2;
    const ch = (bh - 44) / 4;
    gsap.set(block, { x: bx, y: by, width: bw, height: bh });
    chipEls.forEach((c, i) => {
      const p = packed
        ? { x: bx + 10 + (i % 2) * (cw + 10), y: by + 30 + Math.floor(i / 2) * ch, width: cw, rotation: 0 }
        : { x: SCATTER[i][0] * (W - 120), y: SCATTER[i][1] * (H - 30), width: 118, rotation: ROT[i] };
      if (animate) gsap.to(c, { ...p, duration: dur(0.9), delay: packed ? i * 0.06 : 0, ease: 'power3.inOut' });
      else gsap.set(c, p);
    });
    const dynOn = step >= 3;
    dyn.forEach((d, i) => {
      const p = { x: bx + bw + 14, y: by + 30 + i * 34, opacity: dynOn ? 1 : 0 };
      if (animate) gsap.to(d, { ...p, duration: dur(0.5), delay: dynOn ? 0.5 + i * 0.12 : 0 });
      else gsap.set(d, p);
    });
    const cx = bx + bw + 14;
    gsap.set(cache, { x: cx, y: by + 30 + 2 * 34 + 6, opacity: dynOn ? 1 : 0 });
    gsap.set(bind, { x: bx + bw / 2, xPercent: -50, y: by + bh + 10, opacity: packed ? 1 : 0 });
    if (animate && dynOn && motion) {
      gsap.fromTo(ghost, { x: bx + bw * 0.25, y: by + bh * 0.25, width: bw * 0.5, height: bh * 0.5, opacity: 0.8 }, { x: cx + 2, y: by + 30 + 2 * 34 + 12, width: 22, height: 18, opacity: 0, duration: dur(1), delay: 0.8, ease: 'power2.in' });
    } else gsap.set(ghost, { opacity: 0 });
  };

  const apply = (animate: boolean) => {
    const root = left.parentElement!;
    root.dataset.step = String(step);
    left.classList.toggle('active', step === 1);
    right.classList.toggle('active', step >= 2);
    const flip = step >= 1;
    swRows.forEach((r, i) => {
      const on = flip && SWITCHES[i].on;
      r.classList.toggle('set', flip);
      r.classList.toggle('on', on);
      const knob = r.querySelector<HTMLElement>('.psc-knob')!;
      const call = r.querySelector<HTMLElement>('.psc-call')!;
      const name = r.querySelector<HTMLElement>('.psc-name')!;
      if (animate && flip) {
        gsap.fromTo(knob, { x: 0 }, { x: on ? 14 : 0, duration: dur(0.25), delay: i * 0.18, ease: 'back.out(2)' });
        gsap.fromTo(call, { opacity: 0, x: -6 }, { opacity: 1, x: 0, duration: dur(0.25), delay: i * 0.18 });
        gsap.to(name, { opacity: 0, duration: dur(0.2), delay: i * 0.18 });
      } else {
        gsap.set(knob, { x: on ? 14 : 0 });
        gsap.set(call, { opacity: flip ? 1 : 0, x: 0 });
        gsap.set(name, { opacity: flip ? 0 : 1 });
      }
    });
    block.classList.toggle('sealed', step >= 2);
    if (animate && step === 2) gsap.fromTo(block, { scale: 1.06 }, { scale: 1, duration: dur(0.6), delay: 0.7, ease: 'power2.out' });
    else gsap.set(block, { scale: 1 });
    layout(animate);
    caption.innerHTML = t(captions[step]);
  };

  const ro = new ResizeObserver(() => layout(false));
  ro.observe(area);

  return {
    show(s, animate) {
      step = s;
      apply(animate);
    },
    destroy() {
      ro.disconnect();
      gsap.killTweensOf([block, ghost, ...chipEls, ...dyn, ...swRows.flatMap((r) => Array.from(r.children))]);
      gsap.killTweensOf(left.querySelectorAll('*'));
    },
  };
}

/* ------------------------------------------------------------------ */
/* API panels                                                          */
/* ------------------------------------------------------------------ */
function apis(ctx: SlideContext): Record<ApiId, ApiPanelSpec> {
  const lay = ctx.derived.layout;
  const idx = ctx.state.mesh.indices.length;
  const idxType = lay.indexType === 'uint16' ? 'GL_UNSIGNED_SHORT' : 'GL_UNSIGNED_INT';
  const sems = lay.attributes.map((a) => a.semantic).join(', ');
  return {
    opengl: {
      note: L(
        'OpenGL har ingen pipeline-objekt: state är globala inställningar i kontexten som ändras en i taget. Drivrutinen validerar kombinationen först när du ritar.',
        'OpenGL has no pipeline object: state is global settings in the context, changed one at a time. The driver validates the combination only when you draw.',
      ),
      code: [
        {
          lang: 'cpp',
          src: `glUseProgram(prog);                    // shaders (+ uniform blocks)
glBindVertexArray(vao);                // vertex input format + buffers
glEnable(GL_DEPTH_TEST);
glDepthFunc(GL_LESS);
glDepthMask(GL_TRUE);
glEnable(GL_CULL_FACE);
glCullFace(GL_BACK);
glFrontFace(GL_CCW);
glDisable(GL_BLEND);
glEnable(GL_FRAMEBUFFER_SRGB);         // RGBA8 sRGB render target
glViewport(0, 0, ${VIEWPORT.w}, ${VIEWPORT.h});
// Nothing has been checked yet. Here the driver validates the
// whole combination – and may compile a new shader variant:
glDrawElements(GL_TRIANGLES, ${idx}, ${idxType}, nullptr);`,
          highlight: [[1, 2, 3, 6, 9], [3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14], [12, 13, 14], [11]],
        },
      ],
      terms: [
        { term: ctx.t(L('state-maskin', 'state machine')), desc: L('Globala inställningar som gäller tills någon ändrar dem.', 'Global settings that stay in effect until someone changes them.') },
        { term: 'glEnable / glDisable', desc: L('Slår på/av en fast funktion, t.ex. GL_DEPTH_TEST.', 'Turns a fixed function on/off, e.g. GL_DEPTH_TEST.') },
        { term: ctx.t(L('shadervariant', 'shader variant')), desc: L('Drivrutinen bakar ibland in state i maskinkoden och måste kompilera om när den ändras.', 'Drivers sometimes bake state into the machine code and must recompile when it changes.') },
      ],
      you: L('ställer in varje state separat', 'set every state separately'),
      driver: L('validerar vid draw, kompilerar varianter', 'validates at draw, compiles variants'),
    },
    vulkan: {
      note: L(
        'I Vulkan beskrivs nästan all state i en VkGraphicsPipelineCreateInfo och bakas in i en oföränderlig VkPipeline. Med dynamic rendering anges bara attachment-formaten (VkPipelineRenderingCreateInfo), ingen render pass.',
        'In Vulkan almost all state is described in one VkGraphicsPipelineCreateInfo and baked into an immutable VkPipeline. With dynamic rendering you only give the attachment formats (VkPipelineRenderingCreateInfo), no render pass.',
      ),
      code: [
        {
          lang: 'cpp',
          src: `VkPipelineRasterizationStateCreateInfo rs{ VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO };
rs.polygonMode = VK_POLYGON_MODE_FILL;   rs.lineWidth = 1.0f;
rs.cullMode    = VK_CULL_MODE_BACK_BIT;
rs.frontFace   = VK_FRONT_FACE_COUNTER_CLOCKWISE;
VkPipelineDepthStencilStateCreateInfo ds{ VK_STRUCTURE_TYPE_PIPELINE_DEPTH_STENCIL_STATE_CREATE_INFO };
ds.depthTestEnable  = VK_TRUE;  ds.depthWriteEnable = VK_TRUE;
ds.depthCompareOp   = VK_COMPARE_OP_LESS;
VkPipelineColorBlendAttachmentState att{ .blendEnable = VK_FALSE, .colorWriteMask = 0xF };
VkDynamicState dyn[] = { VK_DYNAMIC_STATE_VIEWPORT, VK_DYNAMIC_STATE_SCISSOR };
VkFormat colorFmt = VK_FORMAT_R8G8B8A8_SRGB;
VkPipelineRenderingCreateInfo rendering{ VK_STRUCTURE_TYPE_PIPELINE_RENDERING_CREATE_INFO };
rendering.colorAttachmentCount    = 1;
rendering.pColorAttachmentFormats = &colorFmt;
rendering.depthAttachmentFormat   = VK_FORMAT_D32_SFLOAT;
VkGraphicsPipelineCreateInfo pci{ VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO };
pci.pNext = &rendering;          pci.stageCount = 2;  pci.pStages = stages;
pci.pVertexInputState = &vi;     pci.pInputAssemblyState = &ia;  // TRIANGLE_LIST
pci.pViewportState = &vp;        pci.pRasterizationState = &rs;
pci.pMultisampleState = &ms;     pci.pDepthStencilState = &ds;   // 1 sample
pci.pColorBlendState = &cb;      pci.pDynamicState = &dynInfo;   // dyn[]
pci.layout = pipelineLayout;     // descriptor set layouts (next slide)
vkCreateGraphicsPipelines(device, pipelineCache, 1, &pci, nullptr, &pipeline);`,
          highlight: [[15, 16, 17, 18, 19, 20, 21], [1, 2, 3, 4, 5, 6, 7, 8], [10, 11, 12, 13, 14, 22], [9, 20, 22]],
        },
      ],
      terms: [
        { term: 'VkPipeline', desc: L('Oföränderligt objekt med shaders + all fast-funktions-state.', 'Immutable object with shaders + all fixed-function state.') },
        { term: 'VkDynamicState', desc: L('State som undantas från bakningen och sätts med vkCmdSet*.', 'State left out of the bake and set with vkCmdSet*.') },
        { term: 'VkPipelineRenderingCreateInfo', desc: L('Dynamic rendering (1.3): attachment-format istället för VkRenderPass.', 'Dynamic rendering (1.3): attachment formats instead of a VkRenderPass.') },
        { term: 'VkPipelineCache', desc: L('Återanvänder kompilerad maskinkod, kan sparas till disk.', 'Reuses compiled machine code, can be saved to disk.') },
      ],
      you: L('beskriver all state i förväg', 'describe all state up front'),
      driver: L('kompilerar en gång, binder billigt', 'compiles once, binds cheaply'),
    },
    d3d12: {
      note: L(
        'I D3D12 fylls en D3D12_GRAPHICS_PIPELINE_STATE_DESC och CreateGraphicsPipelineState skapar ett PSO. Viewport, scissor och exakt topologi sätts på command listen.',
        'In D3D12 you fill a D3D12_GRAPHICS_PIPELINE_STATE_DESC and CreateGraphicsPipelineState creates a PSO. Viewport, scissor and the exact topology are set on the command list.',
      ),
      code: [
        {
          lang: 'cpp',
          src: `D3D12_GRAPHICS_PIPELINE_STATE_DESC d = {};
d.pRootSignature = rootSig.Get();                  // b0: Transforms
d.VS = { vs.data(), vs.size() };                   // DXIL bytecode
d.PS = { ps.data(), ps.size() };
d.InputLayout = { elements, ${lay.attributes.length} };                    // ${sems}
d.PrimitiveTopologyType = D3D12_PRIMITIVE_TOPOLOGY_TYPE_TRIANGLE;
d.RasterizerState = CD3DX12_RASTERIZER_DESC(D3D12_DEFAULT);  // SOLID
d.RasterizerState.CullMode = D3D12_CULL_MODE_BACK;
d.RasterizerState.FrontCounterClockwise = TRUE;    // CCW = front
d.DepthStencilState.DepthEnable    = TRUE;
d.DepthStencilState.DepthWriteMask = D3D12_DEPTH_WRITE_MASK_ALL;
d.DepthStencilState.DepthFunc      = D3D12_COMPARISON_FUNC_LESS;
d.BlendState = CD3DX12_BLEND_DESC(D3D12_DEFAULT);  // BlendEnable = FALSE
d.SampleMask = UINT_MAX;
d.NumRenderTargets = 1;
d.RTVFormats[0] = DXGI_FORMAT_R8G8B8A8_UNORM_SRGB;
d.DSVFormat     = DXGI_FORMAT_D32_FLOAT;
d.SampleDesc    = { 1, 0 };
device->CreateGraphicsPipelineState(&d, IID_PPV_ARGS(&pso));
// not in the PSO: RSSetViewports, RSSetScissorRects, IASetPrimitiveTopology`,
          highlight: [[1, 2, 3, 4, 5, 6], [7, 8, 9, 10, 11, 12, 13], [14, 15, 16, 17, 18, 19], [19, 20]],
        },
      ],
      terms: [
        { term: 'PSO', desc: L('Pipeline State Object – shaders + all fast-funktions-state i ett.', 'Pipeline State Object – shaders + all fixed-function state in one.') },
        { term: 'PrimitiveTopologyType', desc: L('Bara typen (triangel) bakas; listan/stripen väljs med IASetPrimitiveTopology.', 'Only the type (triangle) is baked; list vs strip is chosen with IASetPrimitiveTopology.') },
        { term: 'ID3D12PipelineLibrary', desc: L('Cache för PSO:er mellan körningar.', 'Cache for PSOs between runs.') },
      ],
      you: L('fyller desc:en i förväg', 'fill in the desc up front'),
      driver: L('kompilerar en gång, binder billigt', 'compiles once, binds cheaply'),
    },
  };
}

export default standardSlide({
  id: 'pipeline-state',
  group: 'api',
  short: L('Pipeline state', 'Pipeline state'),
  title: L('Pipeline state – hur ska det ritas?', 'Pipeline state – how should it be drawn?'),
  lead: L(
    'Shaders räcker inte. GPU:n måste också veta hur vertices ska läsas, vilka trianglar som ska bort, hur djup och färg skrivs och till vilka format.',
    'Shaders are not enough. The GPU also needs to know how to read vertices, which triangles to drop, how depth and color are written and in which formats.',
  ),
  bullets: [
    L('Den här appen: triangellista, <b>cull back</b>, framsida <b>moturs</b>, djuptest <code>LESS</code> + skrivning, <b>ingen blending</b>, RGBA8 sRGB-färg + D32-djup.', 'This app: triangle list, <b>cull back</b>, front face <b>counter-clockwise</b>, depth test <code>LESS</code> + write, <b>no blending</b>, RGBA8 sRGB color + D32 depth.'),
    L('<b>OpenGL</b> är en global state-maskin: <code>glEnable</code>, <code>glDepthFunc</code>, <code>glCullFace</code>… Drivrutinen ser kombinationen först vid draw och kan behöva kompilera om – <i>hitches</i>.', '<b>OpenGL</b> is a global state machine: <code>glEnable</code>, <code>glDepthFunc</code>, <code>glCullFace</code>… The driver sees the combination only at draw time and may have to recompile – <i>hitches</i>.'),
    L('<b>Vulkan</b> och <b>D3D12</b> bakar allt i ett oföränderligt objekt – <code>VkPipeline</code> / <code>ID3D12PipelineState</code> – som skapas i förväg.', '<b>Vulkan</b> and <b>D3D12</b> bake everything into one immutable object – <code>VkPipeline</code> / <code>ID3D12PipelineState</code> – created up front.'),
    L('Lite state är <b>dynamisk</b> (viewport, scissor). Pipelines cachas (<code>VkPipelineCache</code>, <code>ID3D12PipelineLibrary</code>) så de inte kompileras om vid nästa start.', 'Some state is <b>dynamic</b> (viewport, scissor). Pipelines are cached (<code>VkPipelineCache</code>, <code>ID3D12PipelineLibrary</code>) so they are not recompiled on the next launch.'),
  ],
  api: apis,
  data: dataVisual,
  concept: conceptVisual,
});
