import gsap from 'gsap';
import type { Matrix4 } from 'three';
import { dur, h, num, reducedMotion, s } from '../core/dom';
import { SHOWCASE_ROT_X, SHOWCASE_ROT_Y } from '../core/derived';
import { L, type Text } from '../core/i18n';
import { API_LIST, type ApiId } from '../core/state';
import { DEFAULT_CAMERA, matrices, projectionMatrix, runVertex } from '../pipeline/transform';
import { card, matrixEl, vecEl } from '../views/widgets';
import '../styles/slides/descriptors.css';
import { standardSlide } from './standard';
import type { ApiPanelSpec, SlideContext, Visual } from './types';

/** Same 1920×1080 viewport as the pipeline-state and commands slides. */
const ASPECT = 1920 / 1080;
const UBO_SIZE = 256; // 4 × mat4 × 64 B
const FRAMES = 2; // frames in flight, as on the commands slide

const NAMES = ['model', 'view', 'proj', 'mvp'] as const;
const MCLS = ['m-model', 'm-view', 'm-proj', 'm-mvp'] as const;

function uboBytes(ms: Matrix4[]): Uint8Array {
  const f = new Float32Array(64);
  // three.js keeps elements column-major – exactly what std140 / HLSL column_major expect.
  ms.forEach((m, i) => f.set(m.elements, i * 16));
  const out = new Uint8Array(256);
  const dv = new DataView(out.buffer);
  f.forEach((x, i) => dv.setFloat32(i * 4, x, true)); // GPUs read little-endian
  return out;
}

/** Where the near and far planes land in NDC z for an API's projection. */
function zRange(api: ApiId): { near: number; far: number; p11: number; p22: number; p23: number } {
  const P = projectionMatrix(api, DEFAULT_CAMERA, ASPECT).elements;
  const ndcZ = (zView: number) => (P[10] * zView + P[14]) / (P[11] * zView + P[15]);
  return { near: ndcZ(-DEFAULT_CAMERA.near), far: ndcZ(-DEFAULT_CAMERA.far), p11: P[5], p22: P[10], p23: P[14] };
}

/* ------------------------------------------------------------------ */
/* Real data: the matrices, their bytes and where they get bound        */
/* ------------------------------------------------------------------ */
function dataVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const api = ctx.state.api;
  const m = matrices(api, SHOWCASE_ROT_Y, ASPECT, undefined, SHOWCASE_ROT_X);
  const list = [m.model, m.view, m.proj, m.mvp];
  const cam = DEFAULT_CAMERA;

  // ---- Steps 0–1: the four matrices.
  const subs = [
    `rotY ${SHOWCASE_ROT_Y} · rotX ${SHOWCASE_ROT_X}`,
    `eye (${cam.eye.join(', ')})`,
    `fov ${cam.fovY}° · ${ASPECT.toFixed(3)} · ${cam.near}–${cam.far}`,
    'proj × view × model',
  ];
  const mEls = list.map((mm) => matrixEl(mm, 3));
  const mCards = list.map((_, i) =>
    h(`div.card.ds-mcard.${MCLS[i]}`, {}, [h('h4', {}, [h('b', { text: ['M', 'V', 'P', 'MVP'][i] }), ` ${NAMES[i]}`]), mEls[i], h('div.ds-msub', { text: subs[i] })]),
  );
  const pCells = Array.from(mEls[2].children) as HTMLElement[];
  const mvpCells = Array.from(mEls[3].children) as HTMLElement[];

  // Vertex check: the showcase triangle's first vertex through the MVP.
  const tri = ctx.derived.showcaseTriangle(api);
  const vi = ctx.derived.triangleVertices(tri)[0];
  const vs = runVertex(api, ctx.derived.position(vi), m, 1920, 1080);
  const check = card(t(L(`Kontroll: vertex ${vi} genom MVP`, `Check: vertex ${vi} through the MVP`)), [
    h('div.ds-check', {}, [
      h('span.k', { text: 'object' }),
      vecEl(vs.object, 3, 'c-pos'),
      h('span.k', { text: 'MVP · p = clip' }),
      vecEl(vs.clip, 3),
      h('span.k', { text: 'clip / w = NDC' }),
      vecEl(vs.ndc, 3, 'glow-cyan'),
    ]),
  ]);

  // API comparison of the projection.
  const cmpRows = API_LIST.map((a) => {
    const z = zRange(a.id);
    return h(`tr${a.id === api ? '.me' : ''}`, {}, [
      h('td', { text: `${a.label}` }),
      h(`td.mono${a.id === 'vulkan' ? '.neg' : ''}`, { text: num(z.p11, 3) }),
      h('td.mono', { text: num(z.p22, 3) }),
      h('td.mono', { text: num(z.p23, 3) }),
      h('td.mono', { text: num(z.near, 2) }),
      h('td.mono', { text: num(z.far, 2) }),
      h('td', { text: a.id === 'opengl' ? 'z ∈ [−1, 1]' : a.id === 'vulkan' ? t(L('z ∈ [0, 1], y nedåt', 'z ∈ [0, 1], y down')) : 'z ∈ [0, 1]' }),
    ]);
  });
  const cmp = card(t(L('Projektionen skiljer sig per API', 'The projection differs per API')), [
    h('table.ds-cmp', {}, [
      h('thead', {}, [h('tr', {}, ['API', 'P[1][1]', 'P[2][2]', 'P[2][3]', 'near → z', 'far → z', 'NDC'].map((x) => h('th', { text: x })))]),
      h('tbody', {}, cmpRows),
    ]),
  ]);
  const matPanel = h('div.ds-panel.ds-mats', {}, [h('div.ds-mrow', {}, mCards), h('div.ds-under', {}, [check, cmp])]);

  // ---- Step 2: the real bytes of the uniform / constant buffer.
  const bytes = uboBytes(list);
  const rowsEl: HTMLElement[] = [];
  for (let r = 0; r < 8; r++) {
    const mi = r >> 1;
    const cells: HTMLElement[] = [];
    for (let b = 0; b < 32; b++) {
      const c = h(`span.mem-cell.ds-b.${MCLS[mi]}`, { text: bytes[r * 32 + b].toString(16).padStart(2, '0') });
      if (b % 4 === 3) c.classList.add('w');
      if (b === 15) c.classList.add('col');
      cells.push(c);
    }
    rowsEl.push(
      h('div.mem-row', {}, [
        h('span.mem-addr', { text: '+0x' + (r * 32).toString(16).padStart(3, '0') }),
        ...cells,
      ]),
    );
  }
  const first = Array.from(bytes.subarray(0, 4), (b) => b.toString(16).padStart(2, '0')).join(' ');
  const segs = h('div.ds-segs', {}, NAMES.map((n, i) => h(`div.ds-seg.${MCLS[i]}`, {}, [h('b', { text: n }), h('span', { text: `${i * 64}–${i * 64 + 63}` })])));
  const notes: Record<ApiId, Text> = {
    opengl: L(
      '<b>std140</b>: en mat4 = 4 kolumner × vec4 = 64 B, 16 B-justerad. Kolumnordning, så <code>glUniformMatrix4fv(…, GL_FALSE, …)</code> / rå kopiering fungerar direkt.',
      '<b>std140</b>: a mat4 = 4 columns × vec4 = 64 B, 16-byte aligned. Column-major, so <code>glUniformMatrix4fv(…, GL_FALSE, …)</code> / a raw copy works as is.',
    ),
    vulkan: L(
      'Uniform-block är <b>std140</b>: mat4 = 64 B i kolumnordning. Per-frame-offset (f × 256) måste vara en multipel av <code>minUniformBufferOffsetAlignment</code> (≤ 256).',
      'Uniform blocks are <b>std140</b>: mat4 = 64 B, column-major. Per-frame offsets (f × 256) must be a multiple of <code>minUniformBufferOffsetAlignment</code> (≤ 256).',
    ),
    d3d12: L(
      'En CBV måste ligga på och vara en multipel av <b>256 B</b> – här exakt 256 B. HLSL packar <code>float4x4</code> som <code>column_major</code> som standard; med <code>row_major</code> måste du transponera.',
      'A CBV must start at and be a multiple of <b>256 B</b> – here exactly 256 B. HLSL packs <code>float4x4</code> as <code>column_major</code> by default; with <code>row_major</code> you must transpose.',
    ),
  };
  const bytePanel = h('div.ds-panel.ds-bytes', {}, [
    card(`${api === 'd3d12' ? 'cbuffer Transforms : register(b0)' : 'uniform Transforms'} · ${UBO_SIZE} B · ${t(L('verkliga bytes', 'real bytes'))}`, [
      segs,
      h('div.v-scroll.ds-dump', {}, [h('div.mem', {}, rowsEl)]),
    ]),
    h('div.ds-bside', {}, [
      card(t(L('Avkodning', 'Decoding')), [
        h('div.ds-dec', {}, [h('code', { text: `+0x000: ${first}` }), h('div', { text: '↓ float32, little-endian' }), h('code.glow-cyan', { text: `model[0][0] = ${m.model.elements[0].toFixed(6)}` })]),
      ]),
      card(t(L('Regler', 'Rules')), [h('p.ds-note', { html: t(notes[api]) })]),
      card(t(L(`${FRAMES} frames i flykten`, `${FRAMES} frames in flight`)), [h('p.ds-note', { text: t(L(`En kopia per frame: ${FRAMES} × ${UBO_SIZE} B = ${FRAMES * UBO_SIZE} B, så CPU:n inte skriver över det GPU:n läser.`, `One copy per frame: ${FRAMES} × ${UBO_SIZE} B = ${FRAMES * UBO_SIZE} B, so the CPU never overwrites what the GPU is reading.`)) })]),
    ]),
  ]);

  // ---- Step 3: the binding chain.
  const chainFor: Record<ApiId, { main: [string, string][]; alt: [string, string][]; altTitle: Text }> = {
    opengl: {
      main: [
        ['GL buffer (UBO)', `glNamedBufferSubData · ${UBO_SIZE} B`],
        ['glBindBufferBase', 'GL_UNIFORM_BUFFER, 0, ubo'],
        ['binding point 0', t(L('global tabell i kontexten', 'global table in the context'))],
        ['layout(binding = 0)', 'uniform Transforms { … }'],
      ],
      alt: [
        ['uniform mat4 mvp;', t(L('utan block', 'without a block'))],
        ['glGetUniformLocation', 'prog, "mvp"'],
        ['glUniformMatrix4fv', 'loc, 1, GL_FALSE, mvp'],
      ],
      altTitle: L('Gamla sättet', 'The old way'),
    },
    vulkan: {
      main: [
        ['VkBuffer', `UNIFORM_BUFFER · ${FRAMES} × ${UBO_SIZE} B`],
        ['VkDescriptorSet', `binding 0 → { ubo, f × 256, ${UBO_SIZE} }`],
        ['vkCmdBindDescriptorSets', 'layout, firstSet = 0'],
        ['layout(set = 0, binding = 0)', 'uniform Transforms { … }'],
      ],
      alt: [
        ['vkCmdPushConstants', t(L('128 B: mvp + model', '128 B: mvp + model'))],
        ['VkPushConstantRange', 'VERTEX_BIT, 0, 128'],
        ['layout(push_constant)', 'uniform PC { mat4 mvp; mat4 model; }'],
      ],
      altTitle: L('Push constants (≥ 128 B garanterat)', 'Push constants (≥ 128 B guaranteed)'),
    },
    d3d12: {
      main: [
        ['ID3D12Resource', `UPLOAD heap · ${FRAMES} × ${UBO_SIZE} B`],
        [t(L('rotparameter 0', 'root parameter 0')), 'root CBV (2 DWORDs)'],
        ['SetGraphicsRootConstantBufferView', '0, gpuVA + f × 256'],
        ['register(b0)', 'cbuffer Transforms { … }'],
      ],
      alt: [
        ['CreateConstantBufferView', 'CBV → shader-visible heap'],
        [t(L('deskriptortabell', 'descriptor table')), 'SetGraphicsRootDescriptorTable'],
        ['register(b0)', t(L('samma shader', 'same shader'))],
      ],
      altTitle: L('Alternativ: deskriptortabell (eller root constants)', 'Alternative: descriptor table (or root constants)'),
    },
  };
  const ch = chainFor[api];
  const bindNote: Record<ApiId, Text> = {
    opengl: L(
      'Binding points är global kontext-state – alla program som läser <code>binding = 0</code> ser samma buffert tills någon binder om.',
      'Binding points are global context state – every program that reads <code>binding = 0</code> sees the same buffer until someone rebinds it.',
    ),
    vulkan: L(
      'Vanlig uppdelning: <code>set 0</code> per frame (kamera), <code>set 1</code> per material, <code>set 2</code> per objekt – bind bara det som ändras.',
      'A common split: <code>set 0</code> per frame (camera), <code>set 1</code> per material, <code>set 2</code> per object – bind only what changes.',
    ),
    d3d12: L(
      'Rotsignaturen är shaderns "funktionssignatur": högst 64 DWORDs – root CBV = 2, deskriptortabell = 1, root constant = 1 per 32 bitar.',
      'The root signature is the shader’s "function signature": at most 64 DWORDs – root CBV = 2, descriptor table = 1, root constant = 1 per 32 bits.',
    ),
  };
  const mkRow = (items: [string, string][], cls: string) =>
    h(`div.ds-chain.${cls}`, {}, items.flatMap(([a, b], i) => [i ? h('div.ds-wire', {}, [h('span')]) : null, h('div.ds-node', {}, [h('div.t', { text: a.replace(/([a-z])([A-Z])/g, '$1\u200b$2') }), h('div.s', { text: b })])]).filter(Boolean) as HTMLElement[]);
  const mainRow = mkRow(ch.main, 'main');
  const slotIdx = api === 'opengl' ? 2 : 1;
  mainRow.querySelectorAll('.ds-node')[slotIdx]?.classList.add('slot');
  const bindPanel = h('div.ds-panel.ds-bind', {}, [
    h('div.ds-bind-h', { text: t(L('Från buffert till shader – slot 0', 'From buffer to shader – slot 0')) }),
    mainRow,
    h('div.ds-bind-h.alt', { text: t(ch.altTitle) }),
    mkRow(ch.alt, 'alt'),
    h('p.ds-note.ds-bind-note', { html: t(bindNote[api]) }),
  ]);

  const panels = [matPanel, matPanel, bytePanel, bindPanel];
  const root = h('div.ds-data', { dataset: { api } }, [matPanel, bytePanel, bindPanel]);
  host.append(root);

  return {
    show(step, animate) {
      root.dataset.step = String(step);
      [matPanel, bytePanel, bindPanel].forEach((p) => p.classList.toggle('on', p === panels[step]));
      check.style.display = step === 0 ? '' : 'none';
      cmp.style.display = step === 1 ? '' : 'none';
      const hl = step === 1;
      [5, 10, 11].forEach((i) => pCells[i].classList.toggle('hl', hl));
      pCells[5].classList.toggle('flip', hl && api === 'vulkan');
      mvpCells.forEach((c) => c.classList.toggle('glow', step === 0));
      if (!animate) return;
      if (step === 0) {
        gsap.fromTo(mCards, { opacity: 0, y: 16 }, { opacity: 1, y: 0, stagger: 0.12, duration: dur(0.45) });
        gsap.fromTo(mvpCells, { opacity: 0 }, { opacity: 1, stagger: 0.03, delay: 0.5, duration: dur(0.2) });
      } else if (step === 1) {
        gsap.fromTo(cmp, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: dur(0.4) });
        gsap.fromTo([pCells[5], pCells[10], pCells[11]], { scale: 1.6 }, { scale: 1, duration: dur(0.5), ease: 'back.out(2)' });
      } else if (step === 2) {
        gsap.fromTo(bytePanel, { opacity: 0 }, { opacity: 1, duration: dur(0.3) });
        gsap.fromTo(rowsEl, { opacity: 0, x: -20 }, { opacity: 1, x: 0, stagger: 0.05, duration: dur(0.3) });
      } else {
        const nodes = bindPanel.querySelectorAll('.ds-node, .ds-wire');
        gsap.fromTo(nodes, { opacity: 0, y: 8 }, { opacity: 1, y: 0, stagger: 0.08, duration: dur(0.35) });
      }
    },
    destroy() {
      gsap.killTweensOf([...mCards, ...mvpCells, ...pCells, cmp, bytePanel, ...rowsEl]);
      gsap.killTweensOf(bindPanel.querySelectorAll('*'));
    },
  };
}

/* ------------------------------------------------------------------ */
/* Concept: matrix blocks travel into numbered slots wired to a shader  */
/* ------------------------------------------------------------------ */
function conceptVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const api = ctx.state.api;
  const motion = !reducedMotion();
  const stage = h('div.v-fill.dsc-stage');
  const caption = h('div.pack-caption.dsc-caption');
  host.append(stage, caption);

  const svg = s('svg', { class: 'dsc-wires' });
  stage.append(svg);
  const tiles = ['M', 'V', 'P', 'MVP'].map((n, i) => h(`div.dsc-tile.${MCLS[i]}`, {}, [h('b', { text: n }), h('small', { text: '64 B' })]));
  const ops = ['×', '×', '='].map((o) => h('div.dsc-op', { text: o }));
  const strip = h('div.dsc-strip', {}, [h('span.dsc-strip-l', { text: `${UBO_SIZE} B` })]);
  const align = h('div.dsc-align', { text: api === 'd3d12' ? t(L('256 B-gräns ✓', '256 B boundary ✓')) : 'std140 ✓' });
  const slotLabel = (i: number) => (api === 'd3d12' ? `root param ${i}` : `binding ${i}`);
  const rack = h('div.dsc-rack', { text: api === 'opengl' ? 'binding points' : api === 'vulkan' ? 'descriptor set 0' : 'root signature' });
  const slots = [0, 1, 2, 3].map((i) => h('div.dsc-slot', {}, [h('span.dsc-num', { text: String(i) }), h('span.dsc-sl', { text: slotLabel(i) })]));
  const decl = api === 'd3d12' ? 'cbuffer Transforms : register(b0)' : api === 'vulkan' ? 'layout(set = 0, binding = 0) uniform Transforms' : 'layout(std140, binding = 0) uniform Transforms';
  const shaderLines = [decl, '{ mat4 model, view, proj, mvp; };', api === 'd3d12' ? 'o.pos = mul(mvp, float4(p, 1));' : 'gl_Position = mvp * vec4(p, 1.0);'];
  const shader = h('div.dsc-shader', {}, [h('div.dsc-sh-h', { text: t(L('vertexshader', 'vertex shader')) }), ...shaderLines.map((l, i) => h(`code.dsc-line${i === 0 ? '.decl' : ''}`, { text: l }))]);
  const variants = h('div.dsc-variants', {}, API_LIST.map((a) => {
    const z = zRange(a.id);
    return h(`div.dsc-var${a.id === api ? '.me' : ''}`, {}, [
      h('span.n', { text: a.label }),
      h('span.bar', {}, [h('span.fill', { style: { left: `${((z.near + 1) / 2) * 100}%`, right: `${((1 - z.far) / 2) * 100}%` } })]),
      h('span.r', { text: a.id === 'opengl' ? '[−1, 1]' : '[0, 1]' }),
      h('span.y', { text: a.id === 'vulkan' ? 'y ↓' : 'y ↑' }),
    ]);
  }));
  stage.append(...tiles, ...ops, strip, align, rack, ...slots, shader, variants);

  let step = 0;
  let wirePaths: SVGPathElement[] = [];
  let feed: SVGPathElement | null = null;

  const captions = [
    L('CPU:n räknar ut modell-, vy- och projektionsmatrisen varje frame och multiplicerar ihop dem: MVP = P × V × M.', 'The CPU computes the model, view and projection matrices every frame and multiplies them: MVP = P × V × M.'),
    L('Projektionen ser olika ut per API: OpenGL mappar djup till [−1, 1], D3D12 och Vulkan till [0, 1] – och Vulkans y-axel pekar nedåt.', 'The projection differs per API: OpenGL maps depth to [−1, 1], D3D12 and Vulkan to [0, 1] – and Vulkan’s y axis points down.'),
    L('Matriserna packas byte för byte i en buffert med en fast layout som både CPU och shader är överens om.', 'The matrices are packed byte by byte into a buffer with a fixed layout that both CPU and shader agree on.'),
    L('Bufferten kopplas till en numrerad slot. Shadern läser från samma nummer – det är hela kontraktet.', 'The buffer is plugged into a numbered slot. The shader reads from the same number – that is the whole contract.'),
  ];

  const layout = (animate: boolean) => {
    const W = stage.clientWidth;
    const H = stage.clientHeight - 64;
    if (!W || H <= 0) return;
    const tw = 62;
    const th = 46;
    const tx0 = 20;
    const ty = 26;
    const slotX = W * 0.47;
    const slotW = Math.min(150, W * 0.16);
    const slotH = 30;
    const slotY0 = 30;
    const slotGap = Math.max(36, (H - 40) / 4);
    const shX = slotX + slotW + 40;
    const shW = W - shX - 14;
    const stripW = Math.min(280, W * 0.3);
    const stripX = step >= 3 ? slotX - stripW - 30 : 20;
    const stripY = step >= 3 ? slotY0 + (slotH - th) / 2 : H * 0.62;
    const segW = stripW / 4;
    const go = (el: Element, p: gsap.TweenVars, delay = 0) => (animate ? gsap.to(el, { ...p, duration: dur(0.8), delay, ease: 'power3.inOut' }) : gsap.set(el, p));

    tiles.forEach((tile, i) => {
      let p: gsap.TweenVars;
      if (step >= 2) p = { x: stripX + i * segW + 2, y: stripY, width: segW - 4, height: th, opacity: 1 };
      else if (i < 3) p = { x: tx0 + i * (tw + 30), y: ty, width: tw, height: th, opacity: 1 };
      else p = { x: tx0 + 3 * (tw + 30), y: ty, width: tw + 14, height: th, opacity: 1 };
      go(tile, p, step === 2 ? i * 0.1 : 0);
    });
    ops.forEach((o, i) => go(o, { x: tx0 + (i + 1) * (tw + 30) - 22, y: ty + 10, opacity: step >= 2 ? 0 : 1 }));
    go(strip, { x: stripX - 4, y: stripY - 4, width: stripW + 4, height: th + 8, opacity: step >= 2 ? 1 : 0 });
    go(align, { x: stripX, y: stripY + th + 10, opacity: step === 2 ? 1 : 0 });
    slots.forEach((sl, i) => gsap.set(sl, { x: slotX, y: slotY0 + i * slotGap, width: slotW, height: slotH }));
    gsap.set(rack, { x: slotX, y: slotY0 - 20, width: slotW });
    gsap.set(shader, { x: shX, y: slotY0 - 8, width: shW });
    gsap.set(variants, { x: tx0, y: ty + th + 26, width: Math.min(360, W * 0.42) });
    variants.style.opacity = step === 1 ? '1' : '0';

    // Wires: every slot to the shader, slot 0 to the declaration line.
    svg.setAttribute('viewBox', `0 0 ${W} ${stage.clientHeight}`);
    svg.replaceChildren();
    const declY = slotY0 - 8 + 8 + 18 + 8;
    wirePaths = slots.map((_, i) => {
      const y1 = slotY0 + i * slotGap + slotH / 2;
      const x1 = slotX + slotW;
      const y2 = i === 0 ? declY : slotY0 + i * slotGap + slotH / 2;
      const x2 = i === 0 ? shX : shX - 10;
      const p = s('path', { d: `M${x1},${y1} C${x1 + 24},${y1} ${x2 - 24},${y2} ${x2},${y2}`, class: `dsc-wire${i === 0 ? ' main' : ''}` });
      svg.append(p);
      return p;
    });
    const fx = stripX + stripW + 2;
    const fy = stripY + th / 2;
    feed = s('path', { d: `M${fx},${fy} L${slotX},${slotY0 + slotH / 2}`, class: 'dsc-wire feed' });
    svg.append(feed);
    const live = step >= 3;
    wirePaths[0].classList.toggle('live', live);
    feed.classList.toggle('live', live);
    feed.style.opacity = live ? '1' : '0';
    if (live && motion) {
      for (const path of [feed, wirePaths[0]]) {
        const id = `dsc-${Math.random().toString(36).slice(2, 8)}`;
        path.id = id;
        for (let k = 0; k < 3; k++) {
          const c = s('circle', { r: 3.4, class: 'dsc-packet' });
          const am = s('animateMotion', { dur: '1.5s', repeatCount: 'indefinite', begin: `${k * 0.5}s` });
          am.append(s('mpath', { href: `#${id}` }));
          c.append(am);
          svg.append(c);
        }
      }
    }
  };

  const apply = (animate: boolean) => {
    stage.dataset.step = String(step);
    slots[0].classList.toggle('lit', step >= 3);
    shader.classList.toggle('lit', step >= 3);
    layout(animate);
    if (animate && step === 0 && motion) {
      gsap.fromTo(tiles.slice(0, 3), { opacity: 0, y: -10 }, { opacity: 1, y: 26, stagger: 0.12, duration: dur(0.4) });
      gsap.fromTo(tiles[3], { opacity: 0, scale: 0.4 }, { opacity: 1, scale: 1, duration: dur(0.5), delay: 0.6, ease: 'back.out(2)' });
    }
    if (animate && step === 1) gsap.fromTo(variants.children, { opacity: 0, x: -12 }, { opacity: 1, x: 0, stagger: 0.12, duration: dur(0.35) });
    if (animate && step === 1) gsap.fromTo(tiles[2], { rotationY: 0 }, { rotationY: 360, duration: dur(0.9), ease: 'power2.inOut' });
    if (animate && step === 3) gsap.fromTo(slots[0], { scale: 1.15 }, { scale: 1, duration: dur(0.6), delay: 0.8, ease: 'back.out(3)' });
    caption.innerHTML = t(captions[step]);
  };

  const ro = new ResizeObserver(() => layout(false));
  ro.observe(stage);

  return {
    show(st, animate) {
      step = st;
      apply(animate);
    },
    destroy() {
      ro.disconnect();
      gsap.killTweensOf([...tiles, ...ops, strip, align, slots[0], ...Array.from(variants.children)]);
    },
  };
}

/* ------------------------------------------------------------------ */
/* API panels                                                          */
/* ------------------------------------------------------------------ */
function apis(): Record<ApiId, ApiPanelSpec> {
  return {
    opengl: {
      note: L(
        'OpenGL: en uniform buffer (UBO) kopplas till en numrerad binding point med glBindBufferBase. Shaderns layout(binding = 0) läser därifrån. Enskilda uniforms kan också sättas med glUniform*.',
        'OpenGL: a uniform buffer (UBO) is attached to a numbered binding point with glBindBufferBase. The shader’s layout(binding = 0) reads from there. Single uniforms can also be set with glUniform*.',
      ),
      code: [
        {
          lang: 'cpp',
          src: `struct Transforms { float model[16], view[16], proj[16], mvp[16]; };  // 256 B
Transforms tr = computeTransforms(camera, aspect);   // MVP = P * V * M
GLuint ubo;
glCreateBuffers(1, &ubo);
glNamedBufferStorage(ubo, sizeof(Transforms), nullptr, GL_DYNAMIC_STORAGE_BIT);
// every frame: column-major floats = the std140 layout of the block
glNamedBufferSubData(ubo, 0, sizeof(Transforms), &tr);
glBindBufferBase(GL_UNIFORM_BUFFER, 0, ubo);          // binding point 0
// GLSL: layout(std140, binding = 0) uniform Transforms { ... };
// the old way, for a plain "uniform mat4 mvp;" (no block):
GLint loc = glGetUniformLocation(prog, "mvp");
glUniformMatrix4fv(loc, 1, GL_FALSE, tr.mvp);          // GL_FALSE = no transpose`,
          highlight: [[1, 2], [2], [1, 5, 6, 7], [8, 9, 11, 12]],
        },
      ],
      terms: [
        { term: 'UBO', desc: L('Uniform Buffer Object – en buffert med shaderkonstanter.', 'Uniform Buffer Object – a buffer of shader constants.') },
        { term: 'binding point', desc: L('Numrerad global slot som UBO:er kopplas till.', 'Numbered global slot that UBOs are attached to.') },
        { term: 'std140', desc: L('Fast minneslayout: vec4-justering, mat4 = 64 B.', 'Fixed memory layout: vec4 alignment, mat4 = 64 B.') },
      ],
      you: L('räknar matriser, fyller och binder UBO:n', 'compute matrices, fill and bind the UBO'),
      driver: L('versionerar bufferten bakom kulisserna', 'versions the buffer behind the scenes'),
    },
    vulkan: {
      note: L(
        'Vulkan: shadern deklarerar set + binding. Du beskriver det med en VkDescriptorSetLayout, allokerar ett descriptor set ur en pool, pekar det på bufferten och binder setet vid inspelning. Små data kan gå som push constants.',
        'Vulkan: the shader declares set + binding. You describe that with a VkDescriptorSetLayout, allocate a descriptor set from a pool, point it at the buffer and bind the set while recording. Small data can go as push constants.',
      ),
      code: [
        {
          lang: 'cpp',
          src: `VkDescriptorSetLayoutBinding b{ 0, VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, 1, VK_SHADER_STAGE_VERTEX_BIT };
VkDescriptorSetLayoutCreateInfo lci{ VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO };
lci.bindingCount = 1;  lci.pBindings = &b;
vkCreateDescriptorSetLayout(device, &lci, nullptr, &setLayout);
VkDescriptorPoolSize size{ VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, ${FRAMES} };
VkDescriptorPoolCreateInfo pci{ VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO };
pci.maxSets = ${FRAMES};  pci.poolSizeCount = 1;  pci.pPoolSizes = &size;
vkCreateDescriptorPool(device, &pci, nullptr, &pool);
VkDescriptorSetAllocateInfo ai{ VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO };
ai.descriptorPool = pool;  ai.descriptorSetCount = 1;  ai.pSetLayouts = &setLayout;
vkAllocateDescriptorSets(device, &ai, &set[f]);
VkDescriptorBufferInfo bi{ ubo, f * ${UBO_SIZE}, ${UBO_SIZE} };          // buffer, offset, range
VkWriteDescriptorSet w{ VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET };
w.dstSet = set[f];  w.dstBinding = 0;  w.descriptorCount = 1;
w.descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER;  w.pBufferInfo = &bi;
vkUpdateDescriptorSets(device, 1, &w, 0, nullptr);
// every frame, while recording frame f:
memcpy(mapped + f * ${UBO_SIZE}, &tr, ${UBO_SIZE});                // std140 bytes
vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, pipelineLayout,
                        0, 1, &set[f], 0, nullptr);               // firstSet = 0
// or push constants: 128 B always available = mvp + model
vkCmdPushConstants(cmd, pipelineLayout, VK_SHADER_STAGE_VERTEX_BIT, 0, 128, &pc);`,
          highlight: [[18], [18], [12, 18], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 19, 20, 21, 22]],
        },
      ],
      terms: [
        { term: 'VkDescriptorSetLayout', desc: L('Beskriver vilka bindings ett set har (typ, antal, steg).', 'Describes which bindings a set has (type, count, stages).') },
        { term: 'VkDescriptorSet', desc: L('Själva "tabellen" med pekare till resurser.', 'The actual "table" of pointers to resources.') },
        { term: 'push constants', desc: L('Små värden direkt i kommandobufferten, minst 128 B.', 'Small values directly in the command buffer, at least 128 B.') },
        { term: 'minUniformBufferOffsetAlignment', desc: L('Justeringskrav för offset i en UBO (högst 256).', 'Alignment requirement for UBO offsets (at most 256).') },
      ],
      you: L('layout, pool, set, uppdatering, bindning', 'layout, pool, set, update, bind'),
      driver: L('skriver deskriptorerna i GPU-format', 'writes descriptors in the GPU’s format'),
    },
    d3d12: {
      note: L(
        'D3D12: en rotsignatur listar shaderns parametrar. Här är parameter 0 en root CBV kopplad till register(b0) – du ger bara GPU-adressen. Alternativen är en deskriptortabell i en CBV-heap eller root constants.',
        'D3D12: a root signature lists the shader’s parameters. Here parameter 0 is a root CBV bound to register(b0) – you just pass the GPU address. The alternatives are a descriptor table into a CBV heap, or root constants.',
      ),
      code: [
        {
          lang: 'cpp',
          src: `CD3DX12_ROOT_PARAMETER1 param;
param.InitAsConstantBufferView(0);                 // root CBV → register(b0)
CD3DX12_VERSIONED_ROOT_SIGNATURE_DESC rsDesc;
rsDesc.Init_1_1(1, &param, 0, nullptr,
    D3D12_ROOT_SIGNATURE_FLAG_ALLOW_INPUT_ASSEMBLER_INPUT_LAYOUT);
ComPtr<ID3DBlob> blob, error;
D3DX12SerializeVersionedRootSignature(&rsDesc, D3D_ROOT_SIGNATURE_VERSION_1_1, &blob, &error);
device->CreateRootSignature(0, blob->GetBufferPointer(), blob->GetBufferSize(), IID_PPV_ARGS(&rootSig));
// upload heap: ${FRAMES} frames × ${UBO_SIZE} B (CBVs are 256-byte aligned)
auto heapProps = CD3DX12_HEAP_PROPERTIES(D3D12_HEAP_TYPE_UPLOAD);
auto bufDesc   = CD3DX12_RESOURCE_DESC::Buffer(${FRAMES} * ${UBO_SIZE});
device->CreateCommittedResource(&heapProps, D3D12_HEAP_FLAG_NONE, &bufDesc,
    D3D12_RESOURCE_STATE_GENERIC_READ, nullptr, IID_PPV_ARGS(&cb));
cb->Map(0, nullptr, reinterpret_cast<void**>(&mapped));   // stays mapped
// every frame f:
memcpy(mapped + f * ${UBO_SIZE}, &tr, ${UBO_SIZE});        // column_major floats
cmdList->SetGraphicsRootSignature(rootSig.Get());
cmdList->SetGraphicsRootConstantBufferView(0, cb->GetGPUVirtualAddress() + f * ${UBO_SIZE});
// alternatives: SetGraphicsRootDescriptorTable(0, cbvHeapGpuHandle)
//               SetGraphicsRoot32BitConstants(0, 16, &tr.mvp, 0)`,
          highlight: [[16], [16], [9, 10, 11, 12, 13, 16], [1, 2, 3, 4, 5, 17, 18, 19, 20]],
        },
      ],
      terms: [
        { term: 'root signature', desc: L('Listan över shaderns parametrar – högst 64 DWORDs.', 'The list of shader parameters – at most 64 DWORDs.') },
        { term: 'root CBV', desc: L('GPU-adress direkt i rotsignaturen, kostar 2 DWORDs.', 'GPU address directly in the root signature, costs 2 DWORDs.') },
        { term: 'CBV heap', desc: L('Shader-synlig deskriptor-heap för deskriptortabeller.', 'Shader-visible descriptor heap for descriptor tables.') },
        { term: 'row_major', desc: L('HLSL-modifierare – standard är column_major.', 'HLSL modifier – the default is column_major.') },
      ],
      you: L('rotsignatur, uppladdning, bindning', 'root signature, upload, bind'),
      driver: L('läser CBV-adressen vid draw', 'reads the CBV address at draw'),
    },
  };
}

export default standardSlide({
  id: 'descriptors',
  group: 'api',
  short: L('Uniforms', 'Uniforms'),
  title: L('Uniforms & deskriptorer', 'Uniforms & descriptors'),
  lead: L(
    'Vertexshadern behöver matriserna som placerar modellen på skärmen. De räknas ut på CPU:n, packas i en buffert och kopplas till en numrerad plats som shadern läser från.',
    'The vertex shader needs the matrices that put the model on screen. They are computed on the CPU, packed into a buffer and attached to a numbered slot the shader reads from.',
  ),
  bullets: [
    L('Fyra matriser: <b>model</b> (modellens rotation), <b>view</b> (kameran), <b>projection</b> (perspektivet) och <b>MVP</b> = P × V × M.', 'Four matrices: <b>model</b> (the model’s rotation), <b>view</b> (the camera), <b>projection</b> (perspective) and <b>MVP</b> = P × V × M.'),
    L('Projektionen beror på API:t: OpenGL ger z ∈ [−1, 1], D3D12 och Vulkan z ∈ [0, 1] – och i Vulkan pekar y nedåt, så y vänds i matrisen.', 'The projection depends on the API: OpenGL gives z ∈ [−1, 1], D3D12 and Vulkan z ∈ [0, 1] – and in Vulkan y points down, so y is flipped in the matrix.'),
    L('Bytes i en buffert: <b>std140</b>, 64 B per mat4, kolumnordning. D3D12 kräver att konstantbuffertar är <b>256 B-justerade</b>.', 'Bytes in a buffer: <b>std140</b>, 64 B per mat4, column-major. D3D12 requires constant buffers to be <b>256-byte aligned</b>.'),
    L('Bindning: GL <code>glBindBufferBase</code>, Vulkan <b>descriptor sets</b> (eller push constants), D3D12 en <b>rotsignatur</b> med root CBV eller deskriptortabell.', 'Binding: GL <code>glBindBufferBase</code>, Vulkan <b>descriptor sets</b> (or push constants), D3D12 a <b>root signature</b> with a root CBV or descriptor table.'),
  ],
  api: apis(),
  data: dataVisual,
  concept: conceptVisual,
});
