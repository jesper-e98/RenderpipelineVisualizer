import gsap from 'gsap';
import { dur, h } from '../core/dom';
import { L } from '../core/i18n';
import type { ApiId } from '../core/state';
import { formatBytes } from '../pipeline/layout';
import { card, indexView, memoryView, stat } from '../views/widgets';
import { standardSlide } from './standard';
import type { ApiPanelSpec, SlideContext, Visual } from './types';

/* ------------------------------------------------------------------ */
/* Real data: the interleaved vertex buffer of the loaded model        */
/* ------------------------------------------------------------------ */
function dataVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const mesh = ctx.state.mesh;
  const layout = ctx.derived.layout;
  const api = ctx.state.api;

  // Step 0: a single vertex, byte by byte.
  const v0 = memoryView(layout, 1);
  const fields = layout.attributes.map((a) =>
    h('tr', {}, [
      h(`td.${{ position: 'c-pos', normal: 'c-nrm', uv: 'c-uv' }[a.name]}`, { text: a.name }),
      h('td.mono', { text: String(a.offset) }),
      h('td.mono', { text: String(a.components * 4) }),
      h('td.mono', { text: a.formats[api] }),
    ]),
  );
  const values = layout.attributes.map((a) => {
    const src = a.name === 'position' ? mesh.positions : a.name === 'normal' ? mesh.normals : mesh.uvs!;
    const vals = Array.from(src.subarray(0, a.components), (x) => x.toFixed(4));
    return h('div.mono', {}, [h(`span.${{ position: 'c-pos', normal: 'c-nrm', uv: 'c-uv' }[a.name]}`, { text: a.name.padEnd(9) }), vals.join('  ')]);
  });
  const vertexCard = card(t(L('Vertex 0 – en enda vertex i minnet', 'Vertex 0 – a single vertex in memory')), [
    h('div', { style: { margin: '4px 0 10px' } }, values),
    v0.el,
    h('table.layout-table', {}, [
      h('thead', {}, [h('tr', {}, [h('th', { text: 'attribute' }), h('th', { text: 'offset' }), h('th', { text: 'bytes' }), h('th', { text: 'format' })])]),
      h('tbody', {}, fields),
    ]),
  ]);

  // Step 1: many vertices back to back.
  const many = memoryView(layout, 18);
  const manyCard = card(
    t(L(`Vertexbuffert – ${mesh.vertexCount.toLocaleString()} vertices × ${layout.stride} B`, `Vertex buffer – ${mesh.vertexCount.toLocaleString()} vertices × ${layout.stride} B`)),
    [h('div.v-scroll', { style: { maxHeight: '220px' } }, [many.el]), h('div.hint', { text: '…' })],
  );

  // Step 2: the index buffer and what it saves.
  const idxBytes = layout.indexType === 'uint16' ? 2 : 4;
  const noIndex = mesh.triangleCount * 3 * layout.stride;
  const withIndex = layout.vertexBytes + layout.indexBytes;
  const indexCard = card(t(L('Indexbuffert', 'Index buffer')), [
    indexView(mesh.indices, 36),
    h('div.stat-row', { style: { marginTop: '12px' } }, [
      stat(layout.indexType, t(L('indextyp', 'index type')), 'c-idx'),
      stat(formatBytes(noIndex), t(L('utan index', 'without indices'))),
      stat(formatBytes(withIndex), t(L(`med index (${idxBytes} B/index)`, `with indices (${idxBytes} B/index)`)), 'glow-cyan'),
      stat(`${Math.round((1 - withIndex / noIndex) * 100)} %`, t(L('sparat minne', 'memory saved')), 'glow-magenta'),
    ]),
  ]);

  const statsRow = h('div.stat-row', {}, [
    stat(`${layout.stride} B`, 'stride', 'glow-cyan'),
    stat(formatBytes(layout.vertexBytes), 'vertex buffer'),
    stat(formatBytes(layout.indexBytes), 'index buffer'),
  ]);
  const grid = h('div.v-grid.v-scroll', { style: { alignContent: 'start', height: '100%' } }, [statsRow, vertexCard, manyCard, indexCard]);
  host.append(grid);
  const parts = [vertexCard, manyCard, indexCard];

  return {
    show(step, animate) {
      parts.forEach((p, i) => {
        p.style.display = i <= step ? '' : 'none';
      });
      if (!animate) return;
      const target = parts[step];
      gsap.fromTo(target, { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: dur(0.5), ease: 'power2.out' });
      if (step === 0) gsap.from(v0.el.querySelectorAll('.mem-cell'), { opacity: 0, scale: 0.4, stagger: 0.015, duration: dur(0.3) });
      if (step === 1) gsap.from(many.rows, { opacity: 0, x: -30, stagger: 0.04, duration: dur(0.35) });
      target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    },
    destroy() {},
  };
}

/* ------------------------------------------------------------------ */
/* Concept: separate arrays (SoA) get packed into one strip (AoS)      */
/* ------------------------------------------------------------------ */
function conceptVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const N = 4;
  const kinds = [
    { k: 'P', cls: 'pos', label: 'position' },
    { k: 'N', cls: 'nrm', label: 'normal' },
    { k: 'T', cls: 'uv', label: 'uv' },
  ];
  const stageEl = h('div.v-fill.pack-stage');
  const caption = h('div.pack-caption');
  host.append(stageEl, caption);
  const blocks: { el: HTMLElement; kind: number; v: number }[] = [];
  for (let kind = 0; kind < 3; kind++) {
    for (let v = 0; v < N; v++) {
      const el = h(`div.pack-block.mem-cell.${kinds[kind].cls}`, { text: `${kinds[kind].k}${v}` });
      stageEl.append(el);
      blocks.push({ el, kind, v });
    }
  }
  const rowLabels = kinds.map((k) => h(`div.pack-label.c-${k.cls}`, { text: k.label + '[]' }));
  rowLabels.forEach((l) => stageEl.append(l));
  const idxRow = h('div.pack-index', {}, [0, 1, 2, 2, 1, 3].map((i, k) => h(`span.mem-cell.idx${k === 2 ? '.gap' : ''}`, { text: String(i) })));
  stageEl.append(idxRow);

  const place = (step: number, animate: boolean) => {
    const W = stageEl.clientWidth;
    const H = stageEl.clientHeight;
    const bw = Math.min(64, (W - 40) / (N * 3 + 1));
    const bh = 38;
    blocks.forEach(({ el, kind, v }) => {
      let x: number;
      let y: number;
      if (step === 0) {
        x = W / 2 - (N * (bw + 10)) / 2 + v * (bw + 10) + 50;
        y = H * 0.22 + kind * (bh + 18);
      } else {
        const slot = v * 3 + kind;
        x = W / 2 - (N * 3 * (bw + 2)) / 2 + slot * (bw + 2) + (v * 6 - 9);
        y = H * 0.42;
      }
      const props = { x, y, width: bw, height: bh };
      if (animate) gsap.to(el, { ...props, duration: dur(0.9), ease: 'power3.inOut', delay: step === 1 ? (v * 3 + kind) * 0.04 : 0 });
      else gsap.set(el, props);
    });
    rowLabels.forEach((l, kind) => {
      const props = { x: W / 2 - (N * (bw + 10)) / 2 - 80, y: H * 0.22 + kind * (bh + 18) + 10, opacity: step === 0 ? 1 : 0 };
      if (animate) gsap.to(l, { ...props, duration: dur(0.5) });
      else gsap.set(l, props);
    });
    gsap.set(idxRow, { x: W / 2 - 120, y: H * 0.68 });
    if (animate && step === 2) gsap.fromTo(idxRow.children, { opacity: 0, y: 14 }, { opacity: 1, y: 0, stagger: 0.08, duration: dur(0.4) });
    else gsap.set(idxRow.children, { opacity: step >= 2 ? 1 : 0 });
    caption.innerHTML = [
      t(L('Tre separata arrayer: alla positioner, alla normaler, alla UV:n (<i>struct of arrays</i>).', 'Three separate arrays: all positions, all normals, all UVs (<i>struct of arrays</i>).')),
      t(L('Interleaved: varje vertex ligger samlad – P N T, P N T … (<i>array of structs</i>). Bra för cachen: en vertex = en sammanhängande bit minne.', 'Interleaved: each vertex is packed together – P N T, P N T … (<i>array of structs</i>). Cache friendly: one vertex = one contiguous chunk of memory.')),
      t(L('Två trianglar delar två hörn. Indexbufferten pekar ut vertices istället för att kopiera dem: <code>0 1 2 · 2 1 3</code>.', 'Two triangles share two corners. The index buffer points at vertices instead of copying them: <code>0 1 2 · 2 1 3</code>.')),
    ][step];
  };
  const ro = new ResizeObserver(() => place(current, false));
  let current = 0;
  ro.observe(stageEl);
  return {
    show(step, animate) {
      current = step;
      place(step, animate);
    },
    destroy() {
      ro.disconnect();
    },
  };
}

/* ------------------------------------------------------------------ */
/* API panels                                                          */
/* ------------------------------------------------------------------ */
function apis(ctx: SlideContext): Record<ApiId, ApiPanelSpec> {
  const l = ctx.derived.layout;
  const m = ctx.state.mesh;
  const hasUv = !!m.uvs;
  const struct = `struct Vertex {            // ${l.stride} bytes
    float position[3];     // offset 0
    float normal[3];       // offset 12${hasUv ? '\n    float uv[2];           // offset 24' : ''}
};
static_assert(sizeof(Vertex) == ${l.stride});

// ${m.vertexCount} vertices × ${l.stride} B = ${l.vertexBytes} B
std::vector<Vertex>   vertices = loadMesh("${m.name}");
// ${m.triangleCount} triangles × 3 = ${m.indices.length} indices
std::vector<${l.indexType}_t> indices  = loadIndices("${m.name}");`;
  const marks = hasUv ? [[1, 2, 3, 4, 5, 6], [8, 9], [10, 11]] : [[1, 2, 3, 4, 5], [7, 8], [9, 10]];
  const idxNote = L(
    `${m.vertexCount <= 0xffff ? 'Färre än 65 536 vertices, så 16-bitars index räcker.' : 'Fler än 65 535 vertices – 32-bitars index krävs.'}`,
    `${m.vertexCount <= 0xffff ? 'Fewer than 65,536 vertices, so 16-bit indices are enough.' : 'More than 65,535 vertices – 32-bit indices are required.'}`,
  );
  return {
    opengl: {
      note: L(
        'Layouten är ren C++ – OpenGL bryr sig först när du beskriver den med glVertexAttribPointer (stride + offset). ' + idxNote.sv,
        'The layout is plain C++ – OpenGL only cares once you describe it with glVertexAttribPointer (stride + offset). ' + idxNote.en,
      ),
      code: [{ lang: 'cpp', src: struct, highlight: marks }],
      terms: [
        { term: 'stride', desc: L('Antal bytes från en vertex till nästa.', 'Bytes from one vertex to the next.') },
        { term: 'offset', desc: L('Var i vertexen ett attribut börjar.', 'Where inside a vertex an attribute starts.') },
        { term: 'GL_UNSIGNED_SHORT', desc: L('16-bitars index i glDrawElements.', '16-bit indices in glDrawElements.') },
      ],
      you: L('definierar structen', 'define the struct'),
    },
    vulkan: {
      note: L(
        'Samma struct. I Vulkan blir stride och offsets VkVertexInputBindingDescription och VkVertexInputAttributeDescription, bakade in i pipelinen. ' + idxNote.sv,
        'Same struct. In Vulkan, stride and offsets become VkVertexInputBindingDescription and VkVertexInputAttributeDescription, baked into the pipeline. ' + idxNote.en,
      ),
      code: [{ lang: 'cpp', src: struct, highlight: marks }],
      terms: [
        { term: 'binding', desc: L('En buffert-slot med en stride.', 'A buffer slot with one stride.') },
        { term: 'VK_INDEX_TYPE_UINT16', desc: L('Indextyp i vkCmdBindIndexBuffer.', 'Index type in vkCmdBindIndexBuffer.') },
      ],
      you: L('definierar structen', 'define the struct'),
    },
    d3d12: {
      note: L(
        'Samma struct. I D3D12 blir offsets AlignedByteOffset i D3D12_INPUT_ELEMENT_DESC, och stride anges i vertexbuffer-vyn. ' + idxNote.sv,
        'Same struct. In D3D12, offsets become AlignedByteOffset in D3D12_INPUT_ELEMENT_DESC, and the stride goes in the vertex buffer view. ' + idxNote.en,
      ),
      code: [{ lang: 'cpp', src: struct, highlight: marks }],
      terms: [
        { term: 'StrideInBytes', desc: L('Fält i D3D12_VERTEX_BUFFER_VIEW.', 'Field in D3D12_VERTEX_BUFFER_VIEW.') },
        { term: 'DXGI_FORMAT_R16_UINT', desc: L('16-bitars index i D3D12_INDEX_BUFFER_VIEW.', '16-bit indices in D3D12_INDEX_BUFFER_VIEW.') },
      ],
      you: L('definierar structen', 'define the struct'),
    },
  };
}

export default standardSlide({
  id: 'layout',
  group: 'cpu',
  short: L('Vertexlayout', 'Vertex layout'),
  title: L('Vertexlayout – hur en vertex ser ut i minnet', 'Vertex layout – what a vertex looks like in memory'),
  lead: L(
    'GPU:n vill ha platta, tätt packade arrayer av siffror. Applikationen bestämmer exakt hur varje vertex ser ut byte för byte.',
    'The GPU wants flat, tightly packed arrays of numbers. The application decides exactly what each vertex looks like, byte by byte.',
  ),
  bullets: [
    L('En vertex = position (3 × float), normal (3 × float) och ev. UV (2 × float). Varje float är 4 bytes, <i>little-endian</i>.', 'A vertex = position (3 × float), normal (3 × float) and optionally UV (2 × float). Each float is 4 bytes, <i>little-endian</i>.'),
    L('Vertices läggs efter varandra – <b>interleaved</b>. Avståndet mellan två vertices kallas <code>stride</code>.', 'Vertices are laid out back to back – <b>interleaved</b>. The distance between two vertices is the <code>stride</code>.'),
    L('Hörn som delas av flera trianglar lagras en gång. En <b>indexbuffert</b> säger vilka tre vertices som bildar varje triangel.', 'Corners shared by several triangles are stored once. An <b>index buffer</b> says which three vertices form each triangle.'),
  ],
  api: apis,
  data: dataVisual,
  concept: conceptVisual,
});
