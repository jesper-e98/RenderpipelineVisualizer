import gsap from 'gsap';
import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  Points,
  PointsMaterial,
  QuadraticBezierCurve3,
  Vector3,
  type ShaderMaterial,
} from 'three';
import { dur, h } from '../core/dom';
import { L, type Text } from '../core/i18n';
import type { ApiId } from '../core/state';
import { formatBytes, type VertexAttribute, type VertexLayout } from '../pipeline/layout';
import { createModelStage, glowTexture, secs, type ModelStage } from '../views/ModelStage';
import { COLORS, label } from '../views/three-helpers';
import { stat } from '../views/widgets';
import { standardSlide } from './standard';
import type { ApiPanelSpec, CodeSnippet, SlideContext, Visual } from './types';
import '../styles/slides/input-layout.css';

const CLS = { position: 'pos', normal: 'nrm', uv: 'uv' } as const;
const GLSL_NAME = { position: 'aPosition', normal: 'aNormal', uv: 'aUV' } as const;
const HLSL_NAME = { position: 'position', normal: 'normal  ', uv: 'uv      ' } as const;
const GLSL_TYPE = (a: VertexAttribute) => (a.components === 2 ? 'vec2' : 'vec3');
const HLSL_TYPE = (a: VertexAttribute) => (a.components === 2 ? 'float2' : 'float3');
const hlslSemantic = (a: VertexAttribute) => (a.semantic === 'TEXCOORD' ? 'TEXCOORD0' : a.semantic);

/** One line of shader source that declares this attribute. */
function shaderDecl(api: ApiId, a: VertexAttribute): string {
  if (api === 'd3d12') return `${HLSL_TYPE(a)} ${HLSL_NAME[a.name].trim()} : ${hlslSemantic(a)};`;
  return `layout(location = ${a.location}) in ${GLSL_TYPE(a)} ${GLSL_NAME[a.name]};`;
}

function attrValues(ctx: SlideContext, a: VertexAttribute, v: number): number[] {
  const m = ctx.state.mesh;
  const src = a.name === 'position' ? m.positions : a.name === 'normal' ? m.normals : m.uvs!;
  return Array.from(src.subarray(v * a.components, v * a.components + a.components));
}
const fmtVals = (vals: number[]) => `(${vals.map((x) => (Math.abs(x) < 5e-5 ? 0 : x).toFixed(3)).join(', ')})`;

/* ------------------------------------------------------------------ */
/* Both modes: attributes are plugged in one by one and appear on the  */
/* model – positions as points, normals as the hedgehog, UVs as colour */
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
const HEXN = { position: COLORS.cyan, normal: COLORS.magenta, uv: COLORS.amber } as const;

function inputVisual(host: HTMLElement, ctx: SlideContext, concept: boolean): Visual {
  const { t } = ctx;
  const api = ctx.state.api;
  const m = ctx.state.mesh;
  const l = ctx.derived.layout;
  const A = l.attributes;
  const ms = createModelStage(host, ctx, {
    shift: concept ? 0 : -0.17,
    eye: [0, 1.0, 4.6],
    autoRotate: 0,
    bloom: 0.55,
    bloomThreshold: 0.84,
    layers: { solid: 0, wire: 0, points: 0, normals: 0 },
  });
  ms.overlay.classList.add('il-ms');
  fitWidth(ms, 1.6);
  const u = ms.material.uniforms;
  const v = new Vector3();

  /* ---- the followed vertex ---- */
  const showcase = ctx.derived.triangleVertices(ctx.derived.showcaseTriangle(api))[0];
  const tour = Array.from({ length: Math.min(12, m.vertexCount) }, (_, i) => (showcase + Math.floor((i * m.vertexCount) / Math.min(12, m.vertexCount))) % m.vertexCount);
  let vi = showcase;

  /* ---- the vertex buffer as a strip of bytes under the model ---- */
  const RIB_Y = -1.32;
  const RIB_W = 2.7;
  const cw = RIB_W / l.stride;
  const cellGeo = new BoxGeometry(cw * 0.84, 0.15, 0.05);
  const gray = new Color(0x3a4166);
  const attrOf = (byte: number) => [...A].reverse().find((a) => a.offset <= byte)!;
  const ribbon = new Group();
  ribbon.position.set(0, RIB_Y, 0.35);
  const cells = Array.from({ length: l.stride }, (_, b) => {
    const mat = new MeshBasicMaterial({ color: gray.clone(), transparent: true, opacity: 0.9 });
    const c = new Mesh(cellGeo, mat);
    c.position.x = -RIB_W / 2 + (b + 0.5) * cw;
    ribbon.add(c);
    return { mat, attr: attrOf(b) };
  });
  // Faded neighbours on both sides: the next and previous vertex.
  for (let k = 1; k <= 6; k++) {
    for (const sgn of [-1, 1]) {
      const g = new Mesh(cellGeo, new MeshBasicMaterial({ color: gray, transparent: true, opacity: 0.3 * (1 - k / 7) }));
      g.position.x = sgn * (RIB_W / 2 + (k - 0.5) * cw);
      ribbon.add(g);
    }
  }
  // Stride bracket.
  const bracketGeo = new BufferGeometry();
  const bw = RIB_W / 2;
  bracketGeo.setAttribute('position', new BufferAttribute(new Float32Array([-bw, 0.12, 0, -bw, 0.2, 0, -bw, 0.2, 0, bw, 0.2, 0, bw, 0.2, 0, bw, 0.12, 0]), 3));
  const bracketMat = new LineBasicMaterial({ color: COLORS.violet, transparent: true, opacity: 0 });
  ribbon.add(new LineSegments(bracketGeo, bracketMat));
  const rate = api === 'd3d12' ? 'PER_VERTEX_DATA' : api === 'vulkan' ? 'INPUT_RATE_VERTEX' : 'divisor 0';
  const strideLbl = label(`stride = ${l.stride} B · binding 0 · ${rate}`, 'big');
  strideLbl.position.set(0, 0.36, 0);
  const rawLbl = label(t(L(`vertexbuffert · ${formatBytes(l.vertexBytes)} – bara bytes`, `vertex buffer · ${formatBytes(l.vertexBytes)} – just bytes`)), '');
  rawLbl.position.set(0, -0.24, 0);
  ribbon.add(strideLbl, rawLbl);
  const attrLbls = A.map((a) => {
    const lb = label(`${a.name} +${a.offset}`, a.name === 'position' ? 'cyan' : a.name === 'normal' ? 'magenta' : 'amber');
    lb.position.set(-RIB_W / 2 + (a.offset + a.components * 2) * cw, -0.24, 0);
    ribbon.add(lb);
    return lb;
  });
  ms.scene.add(ribbon);
  const colX = (a: VertexAttribute) => -RIB_W / 2 + (a.offset + a.components * 2) * cw;

  /* ---- step 0/1: the same bytes read without / with the right stride ---- */
  const NP = Math.min(2500, m.vertexCount);
  const floats = new Float32Array(l.vertexBuffer);
  const garbage = new Float32Array(NP * 3);
  const correct = new Float32Array(NP * 3);
  for (let i = 0; i < NP; i++) {
    const k = Math.floor((i * m.vertexCount) / NP);
    // Read as if the buffer were tightly packed float3 (stride 12): positions, normals and UVs get mixed up.
    for (let c = 0; c < 3; c++) {
      const f = floats[(k * 3 + c) % floats.length];
      garbage[i * 3 + c] = Number.isFinite(f) ? Math.max(-1.3, Math.min(1.3, f)) : 0;
    }
    correct.set(m.positions.subarray(k * 3, k * 3 + 3), i * 3);
  }
  const cloud = ms.particles(NP, 0x9aa3c7, 0.026, 'model');
  cloud.setTargets(garbage, correct);
  const cloudMat = cloud.points.material as ShaderMaterial;
  cloudMat.uniforms.uArc.value = 0.12;
  cloudMat.uniforms.uColor2.value.set(0xd6dcff);

  /* ---- connectors: buffer column → the followed vertex ---- */
  const SEG = 48;
  const conns = A.map((a) => {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(SEG * 3), 3));
    const cable = new Points(geo, new PointsMaterial({ color: HEXN[a.name], size: 0.05, map: glowTexture(), transparent: true, opacity: 0.85, blending: AdditiveBlending, depthWrite: false }));
    const pg = new BufferGeometry();
    pg.setAttribute('position', new BufferAttribute(new Float32Array(9), 3));
    const pulses = new Points(pg, new PointsMaterial({ color: 0xffffff, size: 0.11, map: glowTexture(), transparent: true, opacity: 0.95, blending: AdditiveBlending, depthWrite: false }));
    cable.frustumCulled = pulses.frustumCulled = false;
    ms.scene.add(cable, pulses);
    const tip = label(api === 'd3d12' ? `: ${hlslSemantic(a)}` : `location ${a.location}`, a.name === 'position' ? 'cyan' : a.name === 'normal' ? 'magenta' : 'amber');
    ms.scene.add(tip);
    return { a, cable, pulses, tip, k: { v: 0 }, curve: new QuadraticBezierCurve3() };
  });
  const endPoint = (a: VertexAttribute, out: Vector3) => {
    const p = new Vector3(...ctx.derived.position(vi));
    const n = new Vector3(...ctx.derived.normal(vi));
    if (a.name === 'normal') p.addScaledVector(n, 0.22);
    else if (a.name === 'uv') p.addScaledVector(n, 0.06);
    return out.copy(p).applyMatrix4(ms.pivot.matrixWorld);
  };
  const updateConns = (time: number, flowing: boolean) => {
    ms.pivot.updateMatrixWorld(true);
    ribbon.updateMatrixWorld(true);
    conns.forEach((cn, i) => {
      const start = new Vector3(colX(cn.a), 0.12, 0).applyMatrix4(ribbon.matrixWorld);
      const end = endPoint(cn.a, new Vector3());
      const mid = start.clone().lerp(end, 0.5);
      mid.x += (i - 1) * 0.35 - 0.25;
      mid.z += 0.45;
      cn.curve.v0.copy(start);
      cn.curve.v1.copy(mid);
      cn.curve.v2.copy(end);
      const arr = cn.cable.geometry.attributes.position.array as Float32Array;
      for (let s = 0; s < SEG; s++) cn.curve.getPoint(s / (SEG - 1), v).toArray(arr, s * 3);
      cn.cable.geometry.attributes.position.needsUpdate = true;
      const shown = Math.round(cn.k.v * SEG);
      cn.cable.geometry.setDrawRange(0, shown);
      cn.cable.visible = shown > 0;
      cn.curve.getPoint(0.62, cn.tip.position);
      cn.tip.visible = cn.k.v > 0.98 && step >= 3;
      cn.pulses.visible = flowing && cn.k.v > 0.98;
      if (cn.pulses.visible) {
        const pa = cn.pulses.geometry.attributes.position.array as Float32Array;
        for (let j = 0; j < 3; j++) cn.curve.getPoint((time * 0.55 + j / 3 + i * 0.13) % 1, v).toArray(pa, j * 3);
        cn.pulses.geometry.attributes.position.needsUpdate = true;
      }
    });
  };

  /* ---- panels ---- */
  const slot = (a: VertexAttribute) => (api === 'd3d12' ? `${hlslSemantic(a)}` : `location ${a.location}`);
  const keyStats: HTMLElement[][] = [
    [stat(formatBytes(l.vertexBytes), t(L('bara bytes', 'just bytes')), 'glow-amber'), stat(m.vertexCount.toLocaleString('en-US'), 'vertices')],
    [stat(`${l.stride} B`, 'stride', 'glow-cyan'), stat(api === 'd3d12' ? 'PER_VERTEX' : 'VERTEX', 'input rate')],
    [stat(String(A.length), t(L('attribut', 'attributes')), 'glow-magenta'), stat(A.map((a) => `+${a.offset}`).join(' '), 'offsets')],
    [stat(m.vertexCount.toLocaleString('en-US'), t(L('shaderanrop', 'shader invocations')), 'glow-cyan'), stat(api === 'd3d12' ? 'semantic' : 'location', t(L('matchas på', 'matched by')))],
  ];
  const keyPanel = ms.panel(t(L('Nyckeltal', 'Key numbers')), [h('div.stat-row.il-keys')], { side: 'right', className: 'il-key' });
  const keyRow = keyPanel.querySelector('.il-keys')!;
  let byteCells: HTMLElement[] = [];
  let rows: { el: HTMLElement; val: HTMLElement; a: VertexAttribute }[] = [];
  let declEl: HTMLElement | null = null;
  let bytesTitle: Element | null = null;
  let caption: Element | null = null;
  if (!concept) {
    const bytes = new Uint8Array(l.vertexBuffer, vi * l.stride, l.stride);
    byteCells = Array.from(bytes, (b, i) => h(`span.mem-cell.${CLS[attrOf(i).name]}`, { text: b.toString(16).padStart(2, '0') }));
    const bytesPanel = ms.panel(t(L(`Vertex ${vi} · ${l.stride} bytes`, `Vertex ${vi} · ${l.stride} bytes`)), [
      h('div.il-bytes.mem', { style: { gridTemplateColumns: `repeat(${Math.min(16, l.stride)}, minmax(0, 1fr))` } }, byteCells),
      h('div.hint.il-hint', { text: `0x${(vi * l.stride).toString(16)} = ${vi} × ${l.stride} B` }),
    ], { side: 'right', className: 'il-bytes-panel' });
    bytesTitle = bytesPanel.querySelector('.ms-head span');
    rows = A.map((a) => {
      const val = h('span.mono.il-val', { text: fmtVals(attrValues(ctx, a, vi)) });
      const el = h(`div.il-row.${CLS[a.name]}`, {}, [
        h('div.il-row-top', {}, [h('b.il-an', { text: a.name }), h('span.mono', { text: slot(a) }), h('span.mono.il-off', { text: `offset ${a.offset}` })]),
        h('div.il-row-bot', {}, [h('span.mono.il-fmt', { text: a.formats[api] }), val]),
      ]);
      return { el, val, a };
    });
    declEl = h('pre.il-decl-block', { text: A.map((a) => shaderDecl(api, a)).join('\n') });
    ms.panel(t(L('Attribut → shaderingångar', 'Attributes → shader inputs')), [
      h('div.il-rows', {}, rows.map((r) => r.el)),
      declEl,
    ], { side: 'right', className: 'il-attr-panel' });
  } else {
    const cap = ms.panel(t(L('Vad händer', 'What happens')), [h('p.il-cap')], { side: 'left' });
    caption = cap.querySelector('.il-cap');
  }
  const captions: Text[] = [
    L('För GPU:n är bufferten en remsa bytes. Läst utan beskrivning – här som tätt packade float3 – blir det bara ett moln av skräp.', 'To the GPU the buffer is a strip of bytes. Read without a description – here as tightly packed float3 – it is just a cloud of garbage.'),
    L(`Bindingen ger rätt steg mellan vertices: <b>stride = ${l.stride} B</b>. Nu börjar varje vertex på rätt ställe.`, `The binding gives the right step between vertices: <b>stride = ${l.stride} B</b>. Now every vertex starts in the right place.`),
    L('Varje attribut kopplas in med offset och format: positioner blir punkter, normaler blir piggar och UV:n färgar ytan.', 'Each attribute is plugged in with its offset and format: positions become points, normals become spikes and UVs colour the surface.'),
    api === 'd3d12'
      ? L('HLSL matchar på semantik (POSITION, NORMAL, TEXCOORD0). En vertex per shaderanrop strömmar in.', 'HLSL matches by semantic (POSITION, NORMAL, TEXCOORD0). One vertex per shader invocation streams in.')
      : L('GLSL matchar på <code>layout(location = N)</code>. En vertex per shaderanrop strömmar in.', 'GLSL matches by <code>layout(location = N)</code>. One vertex per shader invocation streams in.'),
  ];

  /* ---- state ---- */
  let step = -1;
  const timers: gsap.core.Tween[] = [];
  const later = (animate: boolean, s: number, fn: () => void) => {
    if (!animate) fn();
    else timers.push(gsap.delayedCall(dur(s), fn));
  };
  const setVertex = (i: number) => {
    vi = i;
    ms.markVertices([vi], COLORS.white, [`v${vi}`]);
    rows.forEach((r) => (r.val.textContent = fmtVals(attrValues(ctx, r.a, vi))));
  };
  setVertex(vi);
  const colorCells = (on: VertexAttribute[]) =>
    cells.forEach((c) => c.mat.color.set(on.includes(c.attr) ? HEXN[c.attr.name] : gray));
  let tourClock = 0;
  ms.onFrame((time, dt) => {
    if (concept && step === 3) {
      tourClock += dt;
      const k = Math.floor(tourClock / 1.4) % tour.length;
      if (tour[k] !== vi) setVertex(tour[k]);
    }
    updateConns(time, step >= 3);
  });
  const prog = cloudMat.uniforms.uProgress;

  return {
    show(stp, animate) {
      step = stp;
      const S = (s: number) => secs(animate, s);
      timers.splice(0).forEach((x) => x.kill());
      gsap.killTweensOf([...Object.values(u), ...Object.values(ms.layers).map((x) => x.material), prog, bracketMat, ...conns.map((c) => c.k)]);
      u.uSweep.value = 100;
      if (step < 3 || !concept) {
        tourClock = 0;
        setVertex(showcase);
      }

      // Panels
      keyRow.replaceChildren(...keyStats[step]);
      if (caption) caption.innerHTML = t(captions[step]);
      byteCells.forEach((c) => c.classList.toggle('raw', step < 2));
      rows.forEach((r) => r.el.classList.toggle('off', step < 2));
      declEl?.classList.toggle('off', step < 3);
      if (bytesTitle) bytesTitle.textContent = step === 0 ? t(L(`${l.stride} bytes – men var börjar en vertex?`, `${l.stride} bytes – but where does a vertex start?`)) : t(L(`Vertex ${vi} · ${l.stride} bytes`, `Vertex ${vi} · ${l.stride} bytes`));

      // Ribbon
      rawLbl.visible = step === 0;
      strideLbl.visible = step >= 1;
      attrLbls.forEach((lb) => (lb.visible = step >= 2));
      if (animate && step === 1) {
        bracketMat.opacity = 0;
        ms.tween(bracketMat, { opacity: 1, duration: dur(0.6) });
      } else bracketMat.opacity = step >= 1 ? 1 : 0;
      colorCells(step >= 2 && !(animate && step === 2) ? A : []);

      // Model
      ms.setMode('ghost', 1, 0);
      ms.setLayer('wire', 0, S(0.3));
      if (step <= 1) {
        cloud.points.visible = true;
        ms.setLayer('points', 0, S(0.3));
        ms.setLayer('normals', 0, S(0.3));
        ms.setLayer('solid', step === 0 ? 0.08 : 0.15, S(0.4));
        conns.forEach((c) => (c.k.v = 0));
        if (step === 0) cloud.progress(0, 0);
        else {
          cloud.progress(0, 0);
          cloud.progress(1, S(2.0));
        }
        return;
      }
      cloud.points.visible = false;
      if (step === 2) {
        // Plug the attributes in one at a time.
        conns.forEach((c) => (c.k.v = 0));
        const effects: Record<VertexAttribute['name'], () => void> = {
          position: () => ms.setLayer('points', 0.85, S(0.5)),
          normal: () => ms.setLayer('normals', 0.8, S(0.6)),
          uv: () => {
            ms.setLayer('solid', 1, S(0.3));
            if (animate) ms.sweep('uv', 'ghost', 1.4);
            else ms.setMode('uv', 1, 0);
          },
        };
        ms.setLayer('points', 0, 0);
        ms.setLayer('normals', 0, 0);
        ms.setLayer('solid', 0.15, 0);
        conns.forEach((c, i) => {
          later(animate, 0.2 + i * 1.3, () => {
            if (animate) colorCells(A.slice(0, i + 1));
            if (animate) ms.tween(c.k, { v: 1, duration: dur(0.8), ease: 'power2.inOut', onComplete: () => effects[c.a.name]() });
            else {
              c.k.v = 1;
              effects[c.a.name]();
            }
          });
        });
        if (!m.uvs) ms.setLayer('solid', 0.6, S(0.6));
      } else {
        // Shader matches: every input is wired up, the vertex shader runs per vertex.
        conns.forEach((c) => (c.k.v = 1));
        ms.setLayer('points', 0.45, S(0.5));
        ms.setLayer('normals', 0.35, S(0.5));
        ms.setLayer('solid', 1, S(0.4));
        if (animate) ms.sweep('shaded', 'uv', 1.4);
        else ms.setMode('shaded', 0, 0);
      }
    },
    destroy() {
      timers.forEach((x) => x.kill());
      ms.destroy();
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
  const l: VertexLayout = ctx.derived.layout;
  const A = l.attributes;
  const S = 4;
  const glsl = (version: string): Line[] => [[`#version ${version}`], ...A.map((a): Line => [shaderDecl('opengl', a), 3]), ['void main() { … }']];
  const pad = (x: string, n: number) => x.padEnd(n);
  return {
    opengl: {
      note: L(
        'I OpenGL lagras layouten i ett Vertex Array Object. Med DSA beskriver du en binding (buffert + stride) och sedan varje attribut: format, offset och vilken binding det läser från. Location-numret matchar layout(location = N) i GLSL.',
        'In OpenGL the layout is stored in a Vertex Array Object. With DSA you describe a binding (buffer + stride) and then each attribute: format, offset and which binding it reads from. The location number matches layout(location = N) in GLSL.',
      ),
      code: [
        snippet('cpp', [
          ['GLuint vao;'],
          ['glCreateVertexArrays(1, &vao);', 0],
          [`glVertexArrayVertexBuffer(vao, 0, vbo, 0, ${l.stride});  // binding 0, offset 0, stride`, 0, 1],
          ['glVertexArrayBindingDivisor(vao, 0, 0);          // 0 = per vertex (default)', 1],
          ['glVertexArrayElementBuffer(vao, ibo);', 0],
          ...A.flatMap((a): Line[] => [
            [`glEnableVertexArrayAttrib(vao, ${a.location});`, 2],
            [`glVertexArrayAttribFormat(vao, ${a.location}, ${a.formats.opengl}, GL_FALSE, ${a.offset});  // ${a.name}`, 2],
            [`glVertexArrayAttribBinding(vao, ${a.location}, 0);`, 2],
          ]),
          ['glBindVertexArray(vao);   // at draw time', 3],
        ], S, L('VAO (C++)', 'VAO (C++)')),
        snippet('glsl', glsl('460 core'), S, L('Vertex shader', 'Vertex shader')),
      ],
      terms: [
        { term: 'VAO', desc: L('Vertex Array Object: sparar bindings, attributformat och indexbuffert.', 'Vertex Array Object: stores bindings, attribute formats and the index buffer.') },
        { term: 'binding index', desc: L('En buffert-slot med egen stride; flera attribut kan läsa samma binding.', 'A buffer slot with its own stride; several attributes can read the same binding.') },
        { term: 'location', desc: L('Attributnumret som kopplar C++-sidan till layout(location = N) i shadern.', 'The attribute number linking the C++ side to layout(location = N) in the shader.') },
        { term: 'normalized', desc: L('GL_FALSE: floats läses som de är. GL_TRUE gör om heltal till 0..1.', 'GL_FALSE: floats are read as-is. GL_TRUE turns integers into 0..1.') },
      ],
      you: L('beskriver binding + attribut', 'describe binding + attributes'),
      driver: L('kompilerar in vertex fetch i shadern', 'compiles vertex fetch into the shader'),
    },
    vulkan: {
      note: L(
        'I Vulkan är layouten en del av pipelinen: VkVertexInputBindingDescription ger stride och input rate, VkVertexInputAttributeDescription ger location, format och offset. Allt bakas in i VkPipeline – bufferten binds först vid inspelning.',
        'In Vulkan the layout is part of the pipeline: VkVertexInputBindingDescription gives stride and input rate, VkVertexInputAttributeDescription gives location, format and offset. It is all baked into the VkPipeline – the buffer is only bound while recording.',
      ),
      code: [
        snippet('cpp', [
          ['VkVertexInputBindingDescription binding{};'],
          ['binding.binding   = 0;', 1],
          [`binding.stride    = ${l.stride};`, 1],
          ['binding.inputRate = VK_VERTEX_INPUT_RATE_VERTEX;', 1],
          ['VkVertexInputAttributeDescription attrs[] = {', 2],
          ['    // location, binding, format, offset', 2],
          ...A.map((a): Line => [`    { ${a.location}, 0, ${pad(a.formats.vulkan + ',', 28)} ${a.offset} },  // ${a.name}`, 2]),
          ['};'],
          ['VkPipelineVertexInputStateCreateInfo vi{ VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO };'],
          ['vi.vertexBindingDescriptionCount   = 1;', 1],
          ['vi.pVertexBindingDescriptions      = &binding;', 1],
          [`vi.vertexAttributeDescriptionCount = ${A.length};`, 2],
          ['vi.pVertexAttributeDescriptions    = attrs;', 2],
          ['pipelineInfo.pVertexInputState = &vi;   // baked into the VkPipeline', 3],
          ['VkDeviceSize offset = 0;   // at record time:', 0],
          ['vkCmdBindVertexBuffers(cmd, 0, 1, &vertexBuffer, &offset);', 0],
        ], S, L('Vertex input (C++)', 'Vertex input (C++)')),
        snippet('glsl', glsl('450'), S, L('Vertex shader', 'Vertex shader')),
      ],
      terms: [
        { term: 'binding', desc: L('Buffert-slot med stride och inputRate (VERTEX eller INSTANCE).', 'Buffer slot with a stride and inputRate (VERTEX or INSTANCE).') },
        { term: 'location', desc: L('Matchar layout(location = N) i GLSL / Location-dekorationen i SPIR-V.', 'Matches layout(location = N) in GLSL / the Location decoration in SPIR-V.') },
        { term: 'VK_FORMAT_R32G32B32_SFLOAT', desc: L('Tre 32-bitars float, 12 bytes.', 'Three 32-bit floats, 12 bytes.') },
        { term: 'vertexInputDynamicState', desc: L('VK_EXT_vertex_input_dynamic_state låter dig sätta layouten vid inspelning i stället.', 'VK_EXT_vertex_input_dynamic_state lets you set the layout at record time instead.') },
      ],
      you: L('beskriver binding + attribut i pipelinen', 'describe binding + attributes in the pipeline'),
    },
    d3d12: {
      note: L(
        'I D3D12 beskriver en array av D3D12_INPUT_ELEMENT_DESC varje attribut med semantiknamn, format, input slot och AlignedByteOffset; den bakas in i PSO:n. HLSL-shaderns semantik (: POSITION, : NORMAL, : TEXCOORD0) måste matcha. Stride anges i D3D12_VERTEX_BUFFER_VIEW.',
        'In D3D12 an array of D3D12_INPUT_ELEMENT_DESC describes each attribute with a semantic name, format, input slot and AlignedByteOffset; it is baked into the PSO. The HLSL shader\'s semantics (: POSITION, : NORMAL, : TEXCOORD0) must match. The stride goes in the D3D12_VERTEX_BUFFER_VIEW.',
      ),
      code: [
        snippet('cpp', [
          ['D3D12_INPUT_ELEMENT_DESC elements[] = {'],
          ['  // SemanticName, Index, Format, InputSlot, AlignedByteOffset, Class, StepRate', 2],
          ...A.map((a): Line => [`  { ${pad(`"${a.semantic}",`, 11)} 0, ${pad(a.formats.d3d12 + ',', 31)} 0, ${pad(a.offset + ',', 3)} D3D12_INPUT_CLASSIFICATION_PER_VERTEX_DATA, 0 },`, 2]),
          ['};'],
          ['psoDesc.InputLayout = { elements, _countof(elements) };   // baked into the PSO', 2, 3],
          ['D3D12_VERTEX_BUFFER_VIEW vbv{};'],
          ['vbv.BufferLocation = vertexBuffer->GetGPUVirtualAddress();', 0],
          [`vbv.SizeInBytes    = ${l.vertexBytes};`, 0],
          [`vbv.StrideInBytes  = ${l.stride};`, 1],
          ['cmdList->IASetVertexBuffers(0, 1, &vbv);   // input slot 0', 0, 1],
        ], S, L('Input layout (C++)', 'Input layout (C++)')),
        snippet('hlsl', [
          ['struct VSInput {'],
          ...A.map((a): Line => [`    ${HLSL_TYPE(a)} ${HLSL_NAME[a.name]} : ${hlslSemantic(a)};`, 3]),
          ['};'],
          ['VSOutput main(VSInput input) { … }'],
        ], S, L('Vertex shader', 'Vertex shader')),
      ],
      terms: [
        { term: 'semantic', desc: L('Namn + index (TEXCOORD + 0 = TEXCOORD0) som kopplar elementet till shaderns indata.', 'Name + index (TEXCOORD + 0 = TEXCOORD0) linking the element to the shader input.') },
        { term: 'AlignedByteOffset', desc: L('Offset inom vertexen; D3D12_APPEND_ALIGNED_ELEMENT räknar ut den åt dig.', 'Offset inside the vertex; D3D12_APPEND_ALIGNED_ELEMENT computes it for you.') },
        { term: 'InputSlot', desc: L('Vilken vertexbuffer-vy (0–31) elementet läser från.', 'Which vertex buffer view (0–31) the element reads from.') },
        { term: 'StrideInBytes', desc: L('Avståndet mellan vertices – i vyn, inte i input layouten.', 'Distance between vertices – in the view, not in the input layout.') },
      ],
      you: L('input layout i PSO + buffer view', 'input layout in the PSO + buffer view'),
    },
  };
}

export default standardSlide({
  id: 'input-layout',
  group: 'api',
  short: L('Input layout', 'Input layout'),
  title: L('Input layout – så läser GPU:n bufferten', 'Input layout – how the GPU reads the buffer'),
  lead: L(
    'Bufferten i VRAM är bara bytes. Input layouten är kontraktet som säger var varje vertex börjar, vad bytesen betyder och vilken shaderingång de ska till.',
    'The buffer in VRAM is just bytes. The input layout is the contract that says where each vertex starts, what the bytes mean and which shader input they go to.',
  ),
  bullets: [
    L('Bufferten är en remsa <b>bytes</b>. Utan beskrivning vet GPU:n varken var en vertex börjar eller vad den innehåller.', 'The buffer is a strip of <b>bytes</b>. Without a description the GPU knows neither where a vertex starts nor what it contains.'),
    L('<b>Binding</b>: vilken buffert, avståndet till nästa vertex (<code>stride</code>) och om datan stegas per vertex eller per instans.', '<b>Binding</b>: which buffer, the distance to the next vertex (<code>stride</code>) and whether data advances per vertex or per instance.'),
    L('<b>Attribut</b>: för varje indata – location eller semantik, format (t.ex. <code>R32G32B32_SFLOAT</code>) och <code>offset</code> inom vertexen.', '<b>Attributes</b>: for each input – location or semantic, format (e.g. <code>R32G32B32_SFLOAT</code>) and <code>offset</code> within the vertex.'),
    L('<b>Shadern</b> måste matcha: <code>layout(location = 0) in vec3</code> i GLSL/SPIR-V, <code>: POSITION</code> i HLSL. En miss ger skräpgeometri – inget felmeddelande.', '<b>The shader</b> must match: <code>layout(location = 0) in vec3</code> in GLSL/SPIR-V, <code>: POSITION</code> in HLSL. A mismatch gives garbage geometry – no error message.'),
  ],
  api: apis,
  data: (host, ctx) => inputVisual(host, ctx, false),
  concept: (host, ctx) => inputVisual(host, ctx, true),
});
