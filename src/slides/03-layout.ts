import { Vector3 } from 'three';
import { h } from '../core/dom';
import { L } from '../core/i18n';
import type { ApiId } from '../core/state';
import { formatBytes } from '../pipeline/layout';
import { createModelStage, secs } from '../views/ModelStage';
import { COLORS } from '../views/three-helpers';
import { indexView, memoryView, stat } from '../views/widgets';
import { standardSlide } from './standard';
import type { ApiPanelSpec, SlideContext, Visual } from './types';

const ATTR_CLS = { position: 'c-pos', normal: 'c-nrm', uv: 'c-uv' } as const;

/* ------------------------------------------------------------------ */
/* Real data: the model in 3D, with its vertex buffer on the side     */
/* ------------------------------------------------------------------ */
function dataVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const mesh = ctx.state.mesh;
  const layout = ctx.derived.layout;
  const api = ctx.state.api;
  const ms = createModelStage(host, ctx, { shift: -0.17, autoRotate: 0, layers: { solid: 0.25, wire: 0.25, points: 0.5 } });

  // The vertex we follow: first corner of the showcase triangle.
  const tri = ctx.derived.showcaseTriangle(api);
  const [va, vb, vc] = ctx.derived.triangleVertices(tri);
  const p = ctx.derived.position(va);
  const n = ctx.derived.normal(va);
  const uv = ctx.derived.uv(va);

  // Panel 1: one vertex, byte by byte.
  const one = memoryView(layout, 1);
  // Show the followed vertex's bytes rather than vertex 0's.
  const bytes = new Uint8Array(layout.vertexBuffer, va * layout.stride, layout.stride);
  one.rows[0].querySelectorAll('.mem-cell').forEach((c, i) => (c.textContent = bytes[i].toString(16).padStart(2, '0')));
  one.rows[0].querySelector('.mem-addr')!.textContent = `+${(va * layout.stride).toString(16)}`;
  const values = layout.attributes.map((a) => {
    const v = a.name === 'position' ? p : a.name === 'normal' ? n : uv ?? [];
    return h('div.mono', {}, [h(`span.${ATTR_CLS[a.name]}`, { text: a.name.padEnd(9) }), Array.from(v, (x) => x.toFixed(4)).join('  ')]);
  });
  const vertexPanel = ms.panel(t(L(`Vertex ${va} i minnet`, `Vertex ${va} in memory`)), [
    h('div', { style: { marginBottom: '8px' } }, values),
    h('div.v-scroll', {}, [one.el]),
    h('div.hint', { text: layout.attributes.map((a) => `${a.name} @${a.offset}`).join(' · ') + ` · stride ${layout.stride} B` }),
  ]);

  // Panel 2: many vertices back to back.
  const many = memoryView(layout, 12);
  const bufferPanel = ms.panel(t(L('Vertexbuffert', 'Vertex buffer')), [
    h('div.stat-row', {}, [stat(`${layout.stride} B`, 'stride', 'glow-cyan'), stat(formatBytes(layout.vertexBytes), `${mesh.vertexCount.toLocaleString()} vertices`)]),
    h('div.v-scroll', { style: { maxHeight: '150px', marginTop: '8px' } }, [many.el]),
  ]);

  // Panel 3: index buffer and what it saves.
  const noIndex = mesh.triangleCount * 3 * layout.stride;
  const withIndex = layout.vertexBytes + layout.indexBytes;
  const indexPanel = ms.panel(t(L('Indexbuffert', 'Index buffer')), [
    indexView(mesh.indices.subarray(tri * 3, tri * 3 + 12), 12),
    h('div.stat-row', { style: { marginTop: '8px' } }, [
      stat(layout.indexType, t(L('indextyp', 'index type')), 'c-idx'),
      stat(formatBytes(withIndex), t(L('med index', 'with indices')), 'glow-cyan'),
      stat(`−${Math.round((1 - withIndex / noIndex) * 100)} %`, t(L(`mot ${formatBytes(noIndex)}`, `vs ${formatBytes(noIndex)}`)), 'glow-magenta'),
    ]),
  ]);
  const panels = [vertexPanel, bufferPanel, indexPanel];

  // 3D helpers: normal arrow at the vertex, and a stream of vertices "being written" to memory.
  const arrow = ms.arrow(p, n, 0.45, COLORS.magenta, 'normal');
  const COUNT = Math.min(600, mesh.vertexCount);
  const stream = ms.particles(COUNT, COLORS.cyan, 0.035, 'world');
  // Start at the vertices as seen in the scene (model pose applied), end in a flat ribbon
  // under the model, in vertex order – the buffer.
  ms.pivot.updateMatrixWorld(true);
  const from = ms.samplePositions(COUNT);
  const v = new Vector3();
  for (let i = 0; i < COUNT; i++) {
    v.fromArray(from, i * 3).applyMatrix4(ms.pivot.matrixWorld).toArray(from, i * 3);
  }
  const to = new Float32Array(COUNT * 3);
  for (let i = 0; i < COUNT; i++) {
    to[i * 3] = -1.7 + (i / COUNT) * 2.9;
    to[i * 3 + 1] = -1.0 + ((i % 3) - 1) * 0.05;
    to[i * 3 + 2] = 0.4;
  }
  stream.setTargets(from, to);

  return {
    show(step, animate) {
      panels.forEach((el, i) => (el.style.display = i <= step ? '' : 'none'));
      panels.forEach((el, i) => el.classList.toggle('collapsed', i < step));
      arrow.visible = step === 0;
      ms.markVertices(step === 2 ? [va, vb, vc] : [va], step === 2 ? COLORS.green : COLORS.cyan, step === 2 ? [String(va), String(vb), String(vc)] : [`v${va}`]);
      ms.highlightTriangle(step === 2 ? tri : null, COLORS.green);
      ms.setLayer('solid', step === 2 ? 0.85 : 0.25, secs(animate, 0.6));
      ms.setLayer('points', step === 1 ? 0.15 : 0.5, secs(animate, 0.6));
      stream.points.visible = step === 1;
      if (step === 1) {
        stream.progress(0, 0);
        stream.progress(1, animate ? 2.4 : 0);
      }
    },
    destroy() {
      ms.destroy();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Concept: three separate arrays (SoA) fold into one model (AoS)      */
/* ------------------------------------------------------------------ */
function conceptVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const ms = createModelStage(host, ctx, { autoRotate: 0.25, bloom: 0.8, layers: { solid: 0, points: 0 } });
  const COUNT = Math.min(1500, ctx.state.mesh.vertexCount);
  const home = ms.samplePositions(COUNT);
  const offsets = [-1.6, 0, 1.6];
  const colors = [COLORS.cyan, COLORS.magenta, COLORS.amber];
  const clouds = offsets.map((dx, k) => {
    const pc = ms.particles(COUNT, colors[k], 0.03, 'world');
    const spread = new Float32Array(home);
    for (let i = 0; i < COUNT; i++) {
      // Each array laid out as a flat "column" of its own, scaled down.
      spread[i * 3] = home[i * 3] * 0.5 + dx;
      spread[i * 3 + 1] = home[i * 3 + 1] * 0.5 + 0.15;
      spread[i * 3 + 2] = home[i * 3 + 2] * 0.5;
    }
    pc.setTargets(spread, home);
    return pc;
  });
  const caption = ms.panel(t(L('Vad händer', 'What happens')), [h('p.pack-text')], { side: 'bottom' });
  const text = caption.querySelector('.pack-text')!;
  const captions = [
    L('Tre separata arrayer – alla positioner (cyan), alla normaler (magenta), alla UV:n (amber). <i>Struct of arrays.</i>', 'Three separate arrays – all positions (cyan), all normals (magenta), all UVs (amber). <i>Struct of arrays.</i>'),
    L('Interleaved: varje vertex samlas på ett ställe – P N T, P N T … <i>Array of structs</i>, en sammanhängande bit minne per vertex.', 'Interleaved: each vertex is packed in one place – P N T, P N T … <i>Array of structs</i>, one contiguous chunk of memory per vertex.'),
    L('Trianglar pekar ut sina hörn med index – delade hörn lagras bara en gång.', 'Triangles point at their corners by index – shared corners are stored only once.'),
  ];
  return {
    show(step, animate) {
      text.innerHTML = t(captions[step]);
      clouds.forEach((c) => {
        c.points.visible = step < 2;
        c.progress(step >= 1 ? 1 : 0, secs(animate, 1.8));
      });
      ms.setLayer('wire', step === 2 ? 0.35 : 0, secs(animate, 0.6));
      ms.setLayer('solid', step === 2 ? 1 : 0, secs(animate, 0.4));
      if (step === 2) {
        ms.drawTriangles(0, 0);
        ms.drawTriangles(ctx.state.mesh.triangleCount, animate ? 2.5 : 0);
      } else ms.drawTriangles(1e9, 0);
    },
    destroy() {
      ms.destroy();
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
