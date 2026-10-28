import gsap from 'gsap';
import { dur, h, reducedMotion, s } from '../core/dom';
import { L, type Text } from '../core/i18n';
import type { ApiId } from '../core/state';
import type { VertexAttribute, VertexLayout } from '../pipeline/layout';
import { memoryView } from '../views/widgets';
import { standardSlide } from './standard';
import type { ApiPanelSpec, CodeSnippet, SlideContext, Visual } from './types';
import '../styles/slides/input-layout.css';

const CLS = { position: 'pos', normal: 'nrm', uv: 'uv' } as const;
const HEX = { position: '#38e1ff', normal: '#ff3fd2', uv: '#ffb547' } as const;
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

/** How the attribute is identified in this API. */
function slotName(api: ApiId, a: VertexAttribute): string {
  return api === 'd3d12' ? `${a.semantic} · index 0` : `location ${a.location}`;
}

function attrValues(ctx: SlideContext, a: VertexAttribute, v: number): number[] {
  const m = ctx.state.mesh;
  const src = a.name === 'position' ? m.positions : a.name === 'normal' ? m.normals : m.uvs!;
  return Array.from(src.subarray(v * a.components, v * a.components + a.components));
}
const fmtVals = (vals: number[]) => `(${vals.map((x) => (Math.abs(x) < 5e-5 ? 0 : x).toFixed(3)).join(', ')})`;

/* ------------------------------------------------------------------ */
/* Real data: the buffer's bytes wired into the vertex shader inputs   */
/* ------------------------------------------------------------------ */
function dataVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const api = ctx.state.api;
  const l = ctx.derived.layout;
  const rows = Math.min(3, ctx.state.mesh.vertexCount);
  const mem = memoryView(l, rows);
  mem.el.classList.add('il-mem');

  // Braces above vertex 0: one per attribute.
  const braces = h('div.il-braces');
  const strideTag = h('div.il-stride', {}, [h('b', { text: `stride = ${l.stride} B` }), h('span', { text: ` · binding 0 · ${api === 'd3d12' ? 'PER_VERTEX_DATA' : api === 'vulkan' ? 'VK_VERTEX_INPUT_RATE_VERTEX' : 'divisor 0'}` })]);
  const bufHead = h('div.il-buf-head', {}, [
    h('span.il-k', { text: t(L('vertexbuffert', 'vertex buffer')) }),
    h('span.il-raw-note', { text: t(L('– bara bytes, ingen betydelse än', '– just bytes, no meaning yet')) }),
  ]);
  bufHead.append(strideTag);
  const memWrap = h('div.il-memwrap', {}, [braces, mem.el]);

  // Shader input "sockets".
  const sockets = l.attributes.map((a) => {
    const decl = h('div.il-decl.mono', { text: shaderDecl(api, a) });
    const vals = h('div.il-vals.mono', { text: `= ${fmtVals(attrValues(ctx, a, 0))}` });
    const el = h(`div.il-socket.${CLS[a.name]}`, {}, [
      h('div.il-sock-head', {}, [h('span.il-plug'), h('b', { text: slotName(api, a) }), h('span.il-off.mono', { text: `+${a.offset}` })]),
      h('div.il-fmt.mono', { text: a.formats[api] }),
      h('div.il-sub', { text: `offset ${a.offset} B · ${a.components * 4} B` }),
      decl,
      vals,
    ]);
    return { el, decl, vals };
  });
  const shaderBox = h('div.il-shader', {}, [
    h('div.il-shader-title', { text: t(api === 'd3d12' ? L('Vertex shader (HLSL) · indata', 'Vertex shader (HLSL) · inputs') : L('Vertex shader (GLSL) · indata', 'Vertex shader (GLSL) · inputs')) }),
    h('div.il-sockets', { style: { gridTemplateColumns: `repeat(${sockets.length}, minmax(0, 1fr))` } }, sockets.map((x) => x.el)),
  ]);

  const svg = s('svg', { class: 'il-wires' });
  const root = h('div.il-root', {}, [bufHead, memWrap, shaderBox, svg]);
  host.append(root);

  const row0 = mem.rows[0];
  const cellsOf = (r: HTMLElement) => Array.from(r.querySelectorAll<HTMLElement>('.mem-cell'));
  const braceEls = l.attributes.map((a) => {
    const b = h(`div.il-brace.${CLS[a.name]}`, {}, [h('span', { text: `${a.name} · +${a.offset}` })]);
    braces.append(b);
    return b;
  });
  const wires: { path: SVGPathElement; glow: SVGPathElement; dots: SVGCircleElement[] }[] = [];
  let step = 0;

  const rel = (el: Element) => {
    const r = el.getBoundingClientRect();
    const o = root.getBoundingClientRect();
    return { x: r.left - o.left, y: r.top - o.top, w: r.width, h: r.height };
  };

  const layoutWires = () => {
    const cells = cellsOf(row0);
    const W = root.clientWidth;
    const H = root.clientHeight;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.replaceChildren();
    wires.length = 0;
    // braces
    l.attributes.forEach((a, i) => {
      const c0 = rel(cells[a.offset]);
      const c1 = rel(cells[a.offset + a.components * 4 - 1]);
      const m0 = rel(memWrap);
      Object.assign(braceEls[i].style, { left: `${c0.x - m0.x}px`, width: `${c1.x + c1.w - c0.x}px` });
    });
    // wires leave from under the last row, below each attribute's columns
    const lastCells = cellsOf(mem.rows[mem.rows.length - 1]);
    l.attributes.forEach((a, i) => {
      const c0 = rel(lastCells[a.offset]);
      const c1 = rel(lastCells[a.offset + a.components * 4 - 1]);
      const sx = (c0.x + c1.x + c1.w) / 2;
      const sy = c0.y + c0.h + 2;
      const sock = rel(sockets[i].el);
      const ex = sock.x + 22;
      const ey = sock.y + 2;
      const my = (sy + ey) / 2;
      const d = `M${sx},${sy} C${sx},${my} ${ex},${my} ${ex},${ey}`;
      const glow = s('path', { d, class: 'il-wire-glow' });
      const path = s('path', { d, class: 'il-wire' });
      glow.style.stroke = HEX[a.name];
      path.style.stroke = HEX[a.name];
      const dots = [0, 1, 2].map(() => {
        const c = s('circle', { r: 3, class: 'il-dot' });
        c.style.fill = HEX[a.name];
        c.style.color = HEX[a.name];
        return c;
      });
      svg.append(glow, path, ...dots);
      wires.push({ path, glow, dots });
    });
    applyWires(false);
  };

  let raf = 0;
  const t0 = performance.now();
  const tick = () => {
    const time = (performance.now() - t0) / 1000;
    if (step >= 3 && !reducedMotion()) {
      for (const w of wires) {
        const len = w.path.getTotalLength();
        w.dots.forEach((c, k) => {
          const p = w.path.getPointAtLength(((time * 0.6 + k / 3) % 1) * len);
          c.setAttribute('cx', String(p.x));
          c.setAttribute('cy', String(p.y));
        });
      }
    }
    raf = requestAnimationFrame(tick);
  };

  const applyWires = (animate: boolean) => {
    for (const w of wires) {
      const len = w.path.getTotalLength();
      const on = step >= 3;
      w.path.style.strokeDasharray = `${len}`;
      w.glow.style.strokeDasharray = `${len}`;
      w.dots.forEach((c) => (c.style.display = on && !reducedMotion() ? '' : 'none'));
      if (animate && on) {
        gsap.fromTo([w.path, w.glow], { strokeDashoffset: len }, { strokeDashoffset: 0, duration: dur(0.9), ease: 'power2.inOut' });
      } else {
        gsap.set([w.path, w.glow], { strokeDashoffset: on ? 0 : len });
      }
    }
  };

  const ro = new ResizeObserver(() => layoutWires());
  ro.observe(root);
  raf = requestAnimationFrame(tick);

  return {
    show(st, animate) {
      step = st;
      mem.el.classList.toggle('raw', step < 2);
      bufHead.classList.toggle('raw', step < 2);
      mem.rows.forEach((r, i) => r.classList.toggle('il-row-on', step >= 1 && i === 0));
      strideTag.classList.toggle('on', step >= 1);
      braces.classList.toggle('on', step >= 2);
      shaderBox.classList.toggle('on', step >= 2);
      shaderBox.classList.toggle('bound', step >= 3);
      sockets.forEach((x) => {
        x.decl.classList.toggle('on', step >= 3);
        x.vals.classList.toggle('on', step >= 3);
      });
      layoutWires();
      applyWires(animate);
      if (!animate) return;
      if (step === 1) gsap.fromTo(strideTag, { opacity: 0, x: -10 }, { opacity: 1, x: 0, duration: dur(0.4) });
      if (step === 2) {
        gsap.fromTo(braceEls, { opacity: 0, y: 6 }, { opacity: 1, y: 0, stagger: 0.12, duration: dur(0.35) });
        gsap.fromTo(sockets.map((x) => x.el), { opacity: 0 }, { opacity: 1, stagger: 0.12, duration: dur(0.4) });
        gsap.fromTo(cellsOf(row0), { opacity: 0.3 }, { opacity: 1, stagger: 0.012, duration: dur(0.2) });
      }
      if (step === 3) gsap.fromTo(sockets.map((x) => x.decl), { opacity: 0 }, { opacity: 1, stagger: 0.15, duration: dur(0.4), delay: dur(0.5) });
    },
    destroy() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      gsap.killTweensOf([strideTag, ...braceEls, ...sockets.map((x) => x.el), ...sockets.map((x) => x.decl)]);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Concept: cables plug buffer columns into shader input sockets       */
/* ------------------------------------------------------------------ */
function conceptVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const api = ctx.state.api;
  const l = ctx.derived.layout;
  const VW = 940;
  const VH = 322;
  const N = Math.min(7, ctx.state.mesh.vertexCount);
  const TX = 40;
  const TW = 380;
  const TY = 62;
  const RH = 34;
  const u = TW / l.stride;
  const svg = s('svg', { class: 'il-concept', viewBox: `0 0 ${VW} ${VH}`, preserveAspectRatio: 'xMidYMid meet' });
  const defs = s('defs', {}, [
    s('filter', { id: 'il-glow', x: '-50%', y: '-50%', width: '200%', height: '200%' }, [
      s('feGaussianBlur', { stdDeviation: 4, result: 'b' }),
      s('feMerge', {}, [s('feMergeNode', { in: 'b' }), s('feMergeNode', { in: 'SourceGraphic' })]),
    ]),
  ]);
  svg.append(defs);
  const caption = h('div.il-caption');
  host.append(svg, caption);

  // --- the buffer: N rows (vertices) × stride bytes ---
  const tableG = s('g');
  svg.append(tableG);
  tableG.append(s('text', { x: TX, y: TY - 34, class: 'il-c-title' }, [t(L('VERTEXBUFFERT', 'VERTEX BUFFER'))]));
  const colHeads: SVGGElement[] = [];
  const cellRects: { r: SVGRectElement; a: VertexAttribute }[] = [];
  for (let v = 0; v < N; v++) {
    tableG.append(s('text', { x: TX - 10, y: TY + v * RH + RH / 2 + 4, 'text-anchor': 'end', class: 'il-c-idx' }, [String(v)]));
    for (const a of l.attributes) {
      const r = s('rect', { x: TX + a.offset * u + 2, y: TY + v * RH + 3, width: a.components * 4 * u - 4, height: RH - 6, rx: 6, class: 'il-c-cell' });
      tableG.append(r);
      cellRects.push({ r, a });
      // byte ticks inside the cell
      for (let b = 1; b < a.components * 4; b++) {
        tableG.append(s('line', { x1: TX + (a.offset + b) * u, x2: TX + (a.offset + b) * u, y1: TY + v * RH + 10, y2: TY + v * RH + RH - 10, class: 'il-c-tick' }));
      }
    }
  }
  l.attributes.forEach((a) => {
    const g = s('g', { class: 'il-c-head' }, [
      s('text', { x: TX + (a.offset + a.components * 2) * u, y: TY - 18, 'text-anchor': 'middle', fill: HEX[a.name] }, [a.name]),
      s('text', { x: TX + (a.offset + a.components * 2) * u, y: TY - 5, 'text-anchor': 'middle', class: 'il-c-sub' }, [`+${a.offset} · ${a.components}×f32`]),
    ]);
    tableG.append(g);
    colHeads.push(g);
  });
  // read head (one vertex = one stride)
  const head = s('rect', { x: TX - 4, y: TY, width: TW + 8, height: RH, rx: 8, class: 'il-c-head-rect' });
  const strideLbl = s('text', { x: TX + TW + 14, y: TY + RH / 2 + 4, class: 'il-c-stride' }, [`stride ${l.stride} B ↓`]);
  svg.append(head, strideLbl);

  // --- the vertex shader chip with one socket per attribute ---
  const CX = 640;
  const CY = 24;
  const CWd = 260;
  const CHt = 288;
  const chip = s('rect', { x: CX, y: CY, width: CWd, height: CHt, rx: 18, class: 'il-c-chip' });
  const chipTitle = s('text', { x: CX + CWd / 2, y: CY + 30, 'text-anchor': 'middle', class: 'il-c-chip-title' }, ['VERTEX SHADER']);
  const counter = s('text', { x: CX + CWd / 2, y: CY + 50, 'text-anchor': 'middle', class: 'il-c-counter' }, ['']);
  svg.append(chip, chipTitle, counter);
  const sockY = (i: number) => CY + 92 + i * ((CHt - 140) / Math.max(1, l.attributes.length - 1));
  const sockets = l.attributes.map((a, i) => {
    const y = l.attributes.length === 1 ? CY + CHt / 2 : sockY(i);
    const ring = s('circle', { cx: CX, cy: y, r: 11, class: 'il-c-sock' });
    ring.style.stroke = HEX[a.name];
    const core = s('circle', { cx: CX, cy: y, r: 5, class: 'il-c-core' });
    core.style.fill = HEX[a.name];
    const name = s('text', { x: CX + 22, y: y - 4, class: 'il-c-sname' }, [slotName(api, a)]);
    const decl = s('text', { x: CX + 22, y: y + 12, class: 'il-c-decl' }, [api === 'd3d12' ? `${HLSL_TYPE(a)} : ${hlslSemantic(a)}` : `in ${GLSL_TYPE(a)} ${GLSL_NAME[a.name]}`]);
    const val = s('text', { x: CX + 22, y: y + 27, class: 'il-c-val' }, ['']);
    svg.append(ring, core, name, decl, val);
    return { y, ring, core, name, decl, val, a };
  });
  // cables (paths updated every frame as the head moves)
  const cables = l.attributes.map((a) => {
    const glow = s('path', { class: 'il-c-cable-glow' });
    const p = s('path', { class: 'il-c-cable' });
    glow.style.stroke = HEX[a.name];
    p.style.stroke = HEX[a.name];
    const plug = s('circle', { r: 6, class: 'il-c-plug' });
    plug.style.fill = HEX[a.name];
    const pulses = [0, 1].map(() => {
      const c = s('circle', { r: 4, class: 'il-c-pulse' });
      c.style.fill = '#fff';
      c.style.filter = `drop-shadow(0 0 6px ${HEX[a.name]})`;
      return c;
    });
    svg.insertBefore(glow, head);
    svg.insertBefore(p, head);
    svg.append(plug, ...pulses);
    return { glow, p, plug, pulses, a };
  });

  let step = 0;
  const st = { row: 0, reach: 0, color: 0 };
  let raf = 0;
  const t0 = performance.now();
  let last = t0;
  let rowClock = 0;
  const still = reducedMotion();

  const update = (time: number) => {
    const rowY = TY + st.row * RH;
    head.setAttribute('y', String(rowY));
    strideLbl.setAttribute('y', String(rowY + RH / 2 + 4));
    const vi = Math.round(st.row) % N;
    cellRects.forEach(({ r, a }) => {
      r.style.fill = st.color > 0 ? `color-mix(in srgb, ${HEX[a.name]} ${Math.round(st.color * 26)}%, rgba(255,255,255,0.05))` : '';
      r.style.stroke = st.color > 0 ? HEX[a.name] : '';
      r.style.strokeOpacity = String(0.25 + st.color * 0.55);
    });
    cables.forEach((c, i) => {
      const s0 = sockets[i];
      const sx = TX + (c.a.offset + c.a.components * 2) * u;
      const sy = rowY + RH / 2;
      const ex = CX - 12;
      const ey = s0.y;
      // grow the cable from the cell toward the socket
      const k = st.reach;
      const x2 = sx + (ex - sx) * k;
      const y2 = sy + (ey - sy) * k;
      const d = `M${sx},${sy} C${sx + 140 * k},${sy} ${x2 - 120 * k},${y2} ${x2},${y2}`;
      c.p.setAttribute('d', d);
      c.glow.setAttribute('d', d);
      c.plug.setAttribute('cx', String(x2));
      c.plug.setAttribute('cy', String(y2));
      c.plug.style.opacity = k > 0.02 ? '1' : '0';
      c.p.style.opacity = c.glow.style.opacity = k > 0.02 ? '1' : '0';
      const flowing = step >= 3 && k > 0.98;
      c.pulses.forEach((p, j) => {
        p.style.display = flowing && !still ? '' : 'none';
        if (!flowing || still) return;
        const len = c.p.getTotalLength();
        const pt = c.p.getPointAtLength(((time * 0.9 + j * 0.5) % 1) * len);
        p.setAttribute('cx', String(pt.x));
        p.setAttribute('cy', String(pt.y));
      });
      s0.ring.classList.toggle('on', k > 0.98);
      s0.val.textContent = step >= 3 ? `= ${fmtVals(attrValues(ctx, c.a, vi))}` : '';
    });
    counter.textContent = step >= 3 ? `${api === 'd3d12' ? 'SV_VertexID' : api === 'vulkan' ? 'gl_VertexIndex' : 'gl_VertexID'} = ${vi}` : '';
  };

  const frame = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (step >= 1 && !still) {
      rowClock += dt;
      const period = step >= 3 ? 1.1 : 0.8;
      const idx = Math.floor(rowClock / period) % N;
      const k = Math.min(1, (rowClock % period) / (period * 0.3));
      const e = k * k * (3 - 2 * k);
      st.row = idx === 0 ? 0 : idx - 1 + e;
    } else if (step < 1) st.row = 0;
    update((now - t0) / 1000);
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  const captions: Text[] = [
    L('För GPU:n är bufferten en lång remsa bytes. Var börjar en vertex? Vad betyder bytesen?', 'To the GPU the buffer is one long strip of bytes. Where does a vertex start? What do the bytes mean?'),
    L(`Bindingen säger var bufferten finns och hur långt det är till nästa vertex: <b>stride = ${l.stride} B</b>, en vertex per steg.`, `The binding says where the buffer is and how far it is to the next vertex: <b>stride = ${l.stride} B</b>, one vertex per step.`),
    L('Attributen delar upp vertexen i kolumner – offset och format – och kopplar varje kolumn till en ingång.', 'The attributes split the vertex into columns – offset and format – and plug each column into an input.'),
    api === 'd3d12'
      ? L('HLSL matchar på semantik: POSITION, NORMAL, TEXCOORD0. Nu strömmar en vertex per shaderanrop in.', 'HLSL matches by semantic: POSITION, NORMAL, TEXCOORD0. Now one vertex streams in per shader invocation.')
      : L('GLSL matchar på location: <code>layout(location = N)</code>. Nu strömmar en vertex per shaderanrop in.', 'GLSL matches by location: <code>layout(location = N)</code>. Now one vertex streams in per shader invocation.'),
  ];

  let tween: gsap.core.Tween | null = null;
  return {
    show(stp, animate) {
      step = stp;
      tween?.kill();
      const target = { reach: step >= 2 ? 1 : 0, color: step >= 2 ? 1 : 0 };
      if (animate) tween = gsap.to(st, { ...target, duration: dur(1.1), ease: 'power3.inOut' });
      else Object.assign(st, target);
      if (step < 1) rowClock = 0;
      head.style.opacity = strideLbl.style.opacity = step >= 1 ? '1' : '0';
      colHeads.forEach((g) => (g.style.opacity = step >= 2 ? '1' : '0'));
      chip.classList.toggle('on', step >= 3);
      sockets.forEach((x) => {
        x.decl.style.opacity = step >= 3 ? '1' : '0';
        x.name.style.opacity = step >= 2 ? '1' : '0.35';
      });
      caption.innerHTML = t(captions[step]);
      if (animate) gsap.fromTo(caption, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: dur(0.4) });
      update((performance.now() - t0) / 1000);
    },
    destroy() {
      cancelAnimationFrame(raf);
      tween?.kill();
      gsap.killTweensOf(caption);
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
  data: dataVisual,
  concept: conceptVisual,
});
