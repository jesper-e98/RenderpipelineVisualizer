import gsap from 'gsap';
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  Points,
  PointsMaterial,
  ShaderMaterial,
  Sprite,
  SpriteMaterial,
  Vector3,
} from 'three';
import type { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import '../styles/slides/input-assembly.css';
import { dur, h } from '../core/dom';
import { L, type Text } from '../core/i18n';
import type { ApiId } from '../core/state';
import { formatBytes } from '../pipeline/layout';
import { createModelStage, glowTexture, secs, type ModelStage } from '../views/ModelStage';
import { COLORS, label } from '../views/three-helpers';
import { stat } from '../views/widgets';
import { standardSlide } from './standard';
import type { ApiPanelSpec, SlideContext, Visual } from './types';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** An HDR color (components may exceed 1) so it rises above the bloom threshold. */
const hdr = (hex: number, k: number) => new Color(hex).multiplyScalar(k);
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const f = (x: number, d = 3) => (x < 0 ? '−' : ' ') + Math.abs(x).toFixed(d);
const hex32 = (n: number) => '0x' + (n >>> 0).toString(16).padStart(8, '0');

export interface CacheRun {
  size: number;
  /** Indices actually simulated (capped for huge meshes). */
  indices: number;
  triangles: number;
  misses: number;
  acmr: number;
  hitRate: number;
}

const SIM_CAP = 3_000_000;

/**
 * Classic post-transform vertex cache (FIFO, Hoppe 1999). A vertex is in the cache if it was one
 * of the last `size` vertices that missed. O(1) per index thanks to an insertion stamp per vertex.
 */
function simulateFifo(
  indices: Uint32Array,
  vertexCount: number,
  size: number,
  record?: { hits: Uint8Array; transforms: Uint16Array },
): CacheRun {
  const n = Math.min(indices.length - (indices.length % 3), SIM_CAP);
  const stamp = new Int32Array(vertexCount).fill(-1);
  let misses = 0;
  for (let i = 0; i < n; i++) {
    const v = indices[i];
    const s = stamp[v];
    if (s >= 0 && s >= misses - size) {
      if (record) record.hits[i] = 1;
    } else {
      stamp[v] = misses++;
      if (record && record.transforms[v] < 65535) record.transforms[v]++;
    }
  }
  const tris = n / 3;
  return { size, indices: n, triangles: tris, misses, acmr: misses / Math.max(1, tris), hitRate: 1 - misses / Math.max(1, n) };
}

interface IaData {
  tri: number;
  verts: [number, number, number];
  runs: CacheRun[];
  main: CacheRun;
  hits: Uint8Array;
  transforms: Uint16Array;
  unique: number;
}

const iaCache = new WeakMap<object, Map<ApiId, IaData>>();

/** Cache simulation + showcase info, computed once per mesh and API. */
function iaData(ctx: SlideContext): IaData {
  const mesh = ctx.state.mesh;
  let per = iaCache.get(mesh);
  if (!per) iaCache.set(mesh, (per = new Map()));
  const api = ctx.state.api;
  let d = per.get(api);
  if (d) return d;
  const tri = ctx.derived.showcaseTriangle(api);
  const verts = ctx.derived.triangleVertices(tri);
  const record = { hits: new Uint8Array(Math.min(mesh.indices.length, SIM_CAP)), transforms: new Uint16Array(mesh.vertexCount) };
  const main = simulateFifo(mesh.indices, mesh.vertexCount, 32, record);
  const runs = [8, 16].map((s) => simulateFifo(mesh.indices, mesh.vertexCount, s));
  runs.push(main);
  let unique = 0;
  for (let i = 0; i < record.transforms.length; i++) if (record.transforms[i] > 0) unique++;
  d = { tri, verts, runs, main, hits: record.hits, transforms: record.transforms, unique };
  per.set(api, d);
  return d;
}

/** Shows only the panels of the current step (so the XR panel reads the right stats). */
function stepPanels(list: { el: HTMLElement; steps: number[] }[]) {
  const slots = list.map((p) => p.el.parentElement!);
  return (step: number, animate: boolean) => {
    list.forEach((p, i) => {
      const on = p.steps.includes(step);
      if (!on) p.el.remove();
      else if (!p.el.isConnected || p.el.parentElement !== slots[i]) {
        slots[i].append(p.el);
        if (animate) gsap.fromTo(p.el, { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: dur(0.45), ease: 'power2.out' });
      }
    });
    // Keep the declared order inside each slot.
    list.forEach((p, i) => p.el.isConnected && slots[i].append(p.el));
  };
}

/** Kill running tweens on the ModelStage uniforms and layers so a jump snaps cleanly. */
function killStageTweens(ms: ModelStage) {
  Object.values(ms.material.uniforms).forEach((u) => gsap.killTweensOf(u));
  Object.values(ms.layers).forEach((l) => gsap.killTweensOf(l.material));
}

/* ---------- Per-vertex glow points: base color + flashes ---------- */
const FLASH_VERT = /* glsl */ `
attribute vec3 color;
attribute float aSize;
varying vec3 vC;
void main() {
  vC = color;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  mv.z += 0.03; // sit just in front of the surface
  gl_PointSize = aSize * 600.0 / max(-mv.z, 0.1);
  gl_Position = projectionMatrix * mv;
}`;
const FLASH_FRAG = /* glsl */ `
uniform float uAlpha;
varying vec3 vC;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.05, d) * uAlpha;
  gl_FragColor = vec4(vC * a, a);
}`;

interface FlashPoints {
  points: Points;
  setBase(fn: (v: number) => Color, k?: number): void;
  flash(v: number, color: Color, strength?: number): void;
  tick(dt: number): void;
  clear(): void;
  alpha(a: number): void;
}

function flashPoints(ms: ModelStage, baseSize: number, flashScale = 2.6): FlashPoints {
  const mesh = ms.ctx.state.mesh;
  const n = mesh.vertexCount;
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(mesh.positions, 3));
  const col = new Float32Array(n * 3);
  const size = new Float32Array(n).fill(baseSize);
  const base = new Float32Array(n * 3);
  const fl = new Float32Array(n);
  const flc = new Float32Array(n * 3);
  const cAttr = new BufferAttribute(col, 3);
  const sAttr = new BufferAttribute(size, 1);
  g.setAttribute('color', cAttr);
  g.setAttribute('aSize', sAttr);
  const mat = new ShaderMaterial({
    vertexShader: FLASH_VERT,
    fragmentShader: FLASH_FRAG,
    uniforms: { uAlpha: { value: 1 } },
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  const points = new Points(g, mat);
  points.frustumCulled = false;
  points.renderOrder = 5;
  ms.pivot.add(points);
  const active = new Set<number>();
  const write = (v: number) => {
    const k = fl[v];
    col[v * 3] = base[v * 3] + (flc[v * 3] - base[v * 3]) * k;
    col[v * 3 + 1] = base[v * 3 + 1] + (flc[v * 3 + 1] - base[v * 3 + 1]) * k;
    col[v * 3 + 2] = base[v * 3 + 2] + (flc[v * 3 + 2] - base[v * 3 + 2]) * k;
    size[v] = baseSize * (1 + flashScale * k);
  };
  return {
    points,
    setBase(fn, k = 1) {
      const dim = new Color(COLORS.cyan).multiplyScalar(0.45);
      for (let v = 0; v < n; v++) {
        const c = fn(v);
        base[v * 3] = dim.r + (c.r - dim.r) * k;
        base[v * 3 + 1] = dim.g + (c.g - dim.g) * k;
        base[v * 3 + 2] = dim.b + (c.b - dim.b) * k;
        write(v);
      }
      cAttr.needsUpdate = sAttr.needsUpdate = true;
    },
    flash(v, color, strength = 1) {
      fl[v] = Math.max(fl[v], strength);
      flc[v * 3] = color.r;
      flc[v * 3 + 1] = color.g;
      flc[v * 3 + 2] = color.b;
      active.add(v);
    },
    tick(dt) {
      if (!active.size) return;
      const k = Math.exp(-dt * 3.2);
      for (const v of active) {
        fl[v] *= k;
        if (fl[v] < 0.02) {
          fl[v] = 0;
          active.delete(v);
        }
        write(v);
      }
      cAttr.needsUpdate = sAttr.needsUpdate = true;
    },
    clear() {
      for (const v of active) {
        fl[v] = 0;
        write(v);
      }
      active.clear();
      cAttr.needsUpdate = sAttr.needsUpdate = true;
    },
    alpha(a) {
      // Dense meshes: additive dots would pile up to white.
      mat.uniforms.uAlpha.value = a * Math.max(0.3, Math.min(1, 6000 / n));
      points.visible = a > 0.001;
    },
  };
}

/** Small diagram of a 6-vertex triangle strip. */
function stripSvg(): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 220 90');
  svg.classList.add('ia-strip');
  const pts = [
    [15, 75],
    [50, 15],
    [85, 75],
    [120, 15],
    [155, 75],
    [190, 15],
  ];
  const tris = [
    [0, 1, 2],
    [2, 1, 3],
    [2, 3, 4],
    [4, 3, 5],
  ];
  tris.forEach((tr, i) => {
    const p = document.createElementNS(NS, 'polygon');
    p.setAttribute('points', tr.map((k) => pts[k].join(',')).join(' '));
    p.setAttribute('class', `t t${i % 2}`);
    svg.append(p);
  });
  pts.forEach(([x, y], i) => {
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', String(x));
    c.setAttribute('cy', String(y));
    c.setAttribute('r', '4');
    svg.append(c);
    const tx = document.createElementNS(NS, 'text');
    tx.setAttribute('x', String(x));
    tx.setAttribute('y', String(y + (y > 40 ? 13 : -6)));
    tx.textContent = String(i);
    svg.append(tx);
  });
  return svg;
}

/* ------------------------------------------------------------------ */
/* The 3D scene shared by both modes                                   */
/* ------------------------------------------------------------------ */
interface IaScene {
  ms: ModelStage;
  centroid(t: number): Vector3;
  /** Showcase triangle that snaps together (model space). */
  snap: { group: Group; set(k: number, pulse: number): void };
  cursor: Sprite;
  pts: FlashPoints;
  /** Strip walk: the triangles after the showcase one in index order. */
  walk: { group: Group; count: number; set(k: number, pulse: number): void; ids: number[][]; fresh: boolean[][] };
  pointSize: number;
}

function buildScene(host: HTMLElement, ctx: SlideContext, concept: boolean): IaScene {
  const mesh = ctx.state.mesh;
  const api = ctx.state.api;
  const ms = createModelStage(host, ctx, {
    shift: concept ? 0 : -0.17,
    autoRotate: 0,
    bloom: concept ? 0.7 : 0.45,
    bloomThreshold: 0.9,
    layers: { solid: 1, wire: 0.12 },
  });
  const tex = glowTexture();
  const P = mesh.positions;
  const centroid = (t: number) => {
    const a = mesh.indices[t * 3];
    const b = mesh.indices[t * 3 + 1];
    const c = mesh.indices[t * 3 + 2];
    return new Vector3((P[a * 3] + P[b * 3] + P[c * 3]) / 3, (P[a * 3 + 1] + P[b * 3 + 1] + P[c * 3 + 1]) / 3, (P[a * 3 + 2] + P[b * 3 + 2] + P[c * 3 + 2]) / 3);
  };
  const pos = (v: number) => new Vector3(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);

  // Showcase triangle: fill + glowing edges + three corner sprites; snaps together from its centroid.
  const tri = ctx.derived.showcaseTriangle(api);
  const verts = ctx.derived.triangleVertices(tri);
  const C = verts.map(pos);
  const cen = centroid(tri);
  const snapGroup = new Group();
  const triFill = new Mesh(
    new BufferGeometry().setFromPoints(C),
    new MeshBasicMaterial({ color: hdr(COLORS.magenta, 1.3), transparent: true, opacity: 0, side: DoubleSide, depthTest: false, blending: AdditiveBlending }),
  );
  const triEdge = new Line(new BufferGeometry().setFromPoints([...C, C[0]]), new LineBasicMaterial({ color: hdr(COLORS.magenta, 3), transparent: true, depthTest: false }));
  triFill.renderOrder = 10;
  triEdge.renderOrder = 11;
  const inner = new Group();
  inner.add(triFill, triEdge);
  snapGroup.add(inner);
  const corner = C.map((p) => {
    const sp = new Sprite(new SpriteMaterial({ map: tex, color: hdr(COLORS.cyan, 1.7), transparent: true, depthTest: false, blending: AdditiveBlending }));
    sp.position.copy(p);
    sp.renderOrder = 12;
    snapGroup.add(sp);
    return sp;
  });
  const cLabels: CSS2DObject[] = verts.map((v, k) => {
    const lb = label(`v${v}`, 'cyan');
    lb.position.copy(C[k].clone().sub(cen).multiplyScalar(1.4).add(C[k]).multiplyScalar(1.06));
    snapGroup.add(lb);
    return lb;
  });
  ms.pivot.add(snapGroup);
  const triScale = Math.max(0.02, ...C.map((p) => p.distanceTo(cen)));
  const snap = {
    group: snapGroup,
    set(k: number, pulse: number) {
      snapGroup.visible = k > 0.001;
      const s = 0.15 + 0.85 * k;
      inner.position.copy(cen.clone().multiplyScalar(1 - s));
      inner.scale.setScalar(s);
      (triEdge.material as LineBasicMaterial).opacity = k;
      (triFill.material as MeshBasicMaterial).opacity = k * (0.3 + 0.15 * pulse);
      corner.forEach((sp, i) => {
        sp.position.copy(cen.clone().lerp(C[i], s));
        sp.scale.setScalar(Math.min(0.11, Math.max(0.045, triScale * 0.6)) * (0.8 + 0.3 * pulse) * k);
      });
      cLabels.forEach((lb) => (lb.element.style.opacity = String(k)));
    },
  };

  // A glowing cursor that rides the triangle being assembled.
  const cursor = new Sprite(new SpriteMaterial({ map: tex, color: hdr(COLORS.amber, 3), transparent: true, depthTest: false, blending: AdditiveBlending }));
  cursor.scale.setScalar(0.14);
  cursor.renderOrder = 13;
  cursor.visible = false;
  ms.pivot.add(cursor);

  const pointSize = Math.max(0.012, Math.min(0.05, 0.9 / Math.sqrt(Math.max(1, mesh.vertexCount))));
  const pts = flashPoints(ms, pointSize, concept ? 5 : 2.6);
  pts.setBase(() => new Color(COLORS.cyan).multiplyScalar(0.45), 0);
  pts.alpha(0);

  // Strip walk: the next triangles in index order, each reusing what it can from the previous one.
  const NB = Math.max(1, Math.min(12, mesh.triangleCount - tri));
  const walkGroup = new Group();
  const ids: number[][] = [];
  const fresh: boolean[][] = [];
  const walkTris: { fill: Mesh; edge: Line; dots: Sprite[] }[] = [];
  for (let k = 0; k < NB; k++) {
    const id = ctx.derived.triangleVertices(tri + k);
    const prev = k ? ids[k - 1] : [];
    ids.push(id);
    fresh.push(id.map((v) => !prev.includes(v)));
    const pts3 = id.map(pos);
    const c = new Color(COLORS.amber).lerp(new Color(COLORS.violet), k / Math.max(1, NB - 1));
    const fill = new Mesh(
      new BufferGeometry().setFromPoints(pts3),
      new MeshBasicMaterial({ color: c.clone().multiplyScalar(1.3), transparent: true, opacity: 0, side: DoubleSide, depthTest: false, blending: AdditiveBlending }),
    );
    const edge = new Line(new BufferGeometry().setFromPoints([...pts3, pts3[0]]), new LineBasicMaterial({ color: c.clone().multiplyScalar(2.4), transparent: true, opacity: 0, depthTest: false }));
    fill.renderOrder = 8;
    edge.renderOrder = 9;
    const dots = pts3.map((p, j) => {
      const sp = new Sprite(
        new SpriteMaterial({ map: tex, color: fresh[k][j] ? hdr(COLORS.amber, 1.9) : hdr(COLORS.green, 1.6), transparent: true, opacity: 0, depthTest: false, blending: AdditiveBlending }),
      );
      sp.position.copy(p);
      sp.renderOrder = 12;
      walkGroup.add(sp);
      return sp;
    });
    walkGroup.add(fill, edge);
    walkTris.push({ fill, edge, dots });
  }
  ms.pivot.add(walkGroup);
  const dotSize = Math.min(0.085, Math.max(0.035, triScale * 0.5));
  const walk = {
    group: walkGroup,
    count: NB,
    ids,
    fresh,
    set(kk: number, pulse: number) {
      walkGroup.visible = kk > 0;
      walkTris.forEach((w, k) => {
        const local = clamp01(kk - k);
        const cur = local > 0 && local < 1;
        (w.fill.material as MeshBasicMaterial).opacity = local * (cur ? 0.55 : 0.28);
        (w.edge.material as LineBasicMaterial).opacity = local;
        w.dots.forEach((d, j) => {
          // Fresh corners flash when their triangle arrives; reused ones only glow while current.
          const o = cur ? 1 : local > 0 ? (fresh[k][j] ? 0.55 : 0) : 0;
          (d.material as SpriteMaterial).opacity = o;
          d.scale.setScalar(dotSize * (cur && fresh[k][j] ? 1.3 + 0.4 * pulse : 1));
        });
      });
    },
  };
  walk.set(0, 0);
  snap.set(0, 0);
  return { ms, centroid, snap, cursor, pts, walk, pointSize };
}

/* ------------------------------------------------------------------ */
/* Real data                                                           */
/* ------------------------------------------------------------------ */
function dataVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const mesh = ctx.state.mesh;
  const layout = ctx.derived.layout;
  const d = iaData(ctx);
  const { tri, verts } = d;
  const idxBytes = layout.indexType === 'uint16' ? 2 : 4;
  const S = buildScene(host, ctx, false);
  const { ms, snap, cursor, pts, walk } = S;
  const N = mesh.triangleCount;

  /* ---------- Step 0: index buffer → triangles ---------- */
  const from = Math.max(0, tri - 2);
  const to = Math.min(N - 1, tri + 2);
  const groups: HTMLElement[] = [];
  for (let k = from; k <= to; k++) {
    const ids = ctx.derived.triangleVertices(k);
    groups.push(
      h(`div.ia-tri${k === tri ? '.hot' : ''}`, {}, [h('div.ia-tri-n', { text: `#${k}` }), h('div.ia-tri-ix', {}, ids.map((v) => h('span.mem-cell.idx', { text: String(v) })))]),
    );
  }
  const ticker = h('div.ia-ticker.mono');
  const setTicker = (k: number) => {
    const ids = ctx.derived.triangleVertices(Math.min(N - 1, k));
    ticker.innerHTML = `<span class="hint">indices[${k * 3}…${k * 3 + 2}]</span> <b class="c-idx">${ids.join(' ')}</b> → <b class="glow-magenta">#${Math.min(N - 1, k)}</b>`;
  };
  const off = tri * 3 * idxBytes;
  const panel0 = ms.panel(t(L('Indexbuffert → trianglar', 'Index buffer → triangles')), [
    h('div.stat-row', {}, [
      stat(mesh.indices.length.toLocaleString(), t(L('index', 'indices')), 'c-idx'),
      stat(N.toLocaleString(), t(L('trianglar (÷ 3)', 'triangles (÷ 3)')), 'glow-magenta'),
      stat(layout.indexType, t(L(`${idxBytes} B per index`, `${idxBytes} B per index`))),
    ]),
    ticker,
    h('div.ia-stream', {}, [from > 0 ? h('span.ia-ellipsis', { text: '…' }) : null, ...groups, to < N - 1 ? h('span.ia-ellipsis', { text: '…' }) : null]),
    h('div.ia-eq', {
      html: t(
        L(
          `Triangel <b class="glow-magenta">#${tri}</b> = <code>indices[${tri * 3}…${tri * 3 + 2}]</code> · byte-offset ${tri * 3} × ${idxBytes} B = <b>${off}</b>`,
          `Triangle <b class="glow-magenta">#${tri}</b> = <code>indices[${tri * 3}…${tri * 3 + 2}]</code> · byte offset ${tri * 3} × ${idxBytes} B = <b>${off}</b>`,
        ),
      ),
    }),
  ]);

  /* ---------- Step 1: vertex fetch ---------- */
  const base = 0x1000_0000;
  const fetchRows = verts.map((v, k) => {
    const p = ctx.derived.position(v);
    return h('div.ia-fetch', {}, [
      h('div.ia-fetch-head', {}, [
        h('span.ia-k', { text: ['v0', 'v1', 'v2'][k] }),
        h('span.mem-cell.idx', { text: String(v) }),
        h('span.ia-arrow', { text: '→' }),
        h('span.mono', { html: `<b>${hex32(base + v * layout.stride)}</b>` }),
      ]),
      h('div.ia-attrs.mono', {}, [h('span.c-pos', { text: 'pos ' }), p.map((x) => f(x)).join(' ')]),
    ]);
  });
  const panel1 = ms.panel(t(L('Vertex fetch', 'Vertex fetch')), [
    h('div.stat-row', {}, [
      stat(`${layout.stride} B`, 'stride', 'glow-cyan'),
      stat(hex32(base + verts[0] * layout.stride), t(L(`adress v${verts[0]}`, `address v${verts[0]}`)), 'glow-amber'),
    ]),
    ...fetchRows,
    h('div.hint', {
      text: t(L(`adress = bas + index × stride · attributen avkodas enligt input layout (${layout.attributes.map((a) => a.name).join(', ')})`, `address = base + index × stride · attributes decoded per the input layout (${layout.attributes.map((a) => a.name).join(', ')})`)),
    }),
  ]);

  /* ---------- Step 2: post-transform cache ---------- */
  const capped = d.main.indices < mesh.indices.length;
  const maxA = 3;
  const barRow = (k: string, acmr: number, cls: string) =>
    h('div.ia-bar', {}, [
      h('span.ia-bar-k', { text: k }),
      h('span.ia-bar-track', {}, [h(`span.ia-bar-fill${cls}`, { style: { width: `${(Math.min(maxA, acmr) / maxA) * 100}%` } })]),
      h('span.ia-bar-v', { text: acmr.toFixed(2) }),
    ]);
  const bars = [
    barRow(t(L('ingen cache', 'no cache')), 3, '.naive'),
    ...d.runs.map((r) => barRow(`FIFO ${r.size}`, r.acmr, r.size === 32 ? '.main' : '')),
    barRow(t(L('∞ (unika)', '∞ (unique)')), d.unique / Math.max(1, d.main.triangles), '.ideal'),
  ];
  const live = h('div.ia-live.mono');
  const panel2 = ms.panel(t(L('Post-transform cache (FIFO 32)', 'Post-transform cache (FIFO 32)')), [
    h('div.stat-row', {}, [
      stat(d.main.misses.toLocaleString(), t(L(`VS-anrop (av ${(d.main.triangles * 3).toLocaleString()})`, `VS calls (of ${(d.main.triangles * 3).toLocaleString()})`)), 'glow-cyan'),
      stat(d.main.acmr.toFixed(2), 'ACMR', 'glow-magenta'),
      stat(`${Math.round(d.main.hitRate * 100)} %`, t(L('träffar', 'hit rate')), 'glow-amber'),
    ]),
    live,
    h('div.ia-legend', {
      html: t(
        L(
          '<span class="c-g">●</span> träff <span class="c-a">●</span> miss → VS · färg efteråt = VS-körningar: <b class="c-g">1</b> <b class="c-a">2</b> <b class="c-r">3+</b>',
          '<span class="c-g">●</span> hit <span class="c-a">●</span> miss → VS · color after = VS runs: <b class="c-g">1</b> <b class="c-a">2</b> <b class="c-r">3+</b>',
        ),
      ),
    }),
    h('div.ia-bars', {}, bars),
    ...(capped ? [h('div.hint', { text: t(L(`Första ${d.main.indices.toLocaleString()} indexen.`, `First ${d.main.indices.toLocaleString()} indices.`)) })] : []),
  ]);

  /* ---------- Step 3: topology ---------- */
  const restart = layout.indexType === 'uint16' ? '0xFFFF' : '0xFFFFFFFF';
  const reused = walk.fresh.slice(1).reduce((s, fr) => s + fr.filter((x) => !x).length, 0);
  const panel3 = ms.panel(t(L('Topologi – list vs strip', 'Topology – list vs strip')), [
    h('div.stat-row', {}, [
      stat(mesh.indices.length.toLocaleString(), t(L('index som list', 'indices as a list')), 'c-idx'),
      stat(`≥ ${(N + 2).toLocaleString()}`, t(L('som perfekt strip', 'as a perfect strip')), 'glow-amber'),
    ]),
    h('div.ia-topo', {}, [
      stripSvg(),
      h('div.ia-topo-text', {}, [
        h('div', { html: `<b>list</b> <code>0 1 2 · 2 1 3 · 2 3 4 · 4 3 5</code>` }),
        h('div', { html: `<b>strip</b> <code>0 1 2 3 4 5</code>` }),
      ]),
    ]),
    h('div.hint', {
      html: t(
        L(
          `På modellen: triangel #${tri} och de ${walk.count - 1} följande i indexordning. <span class="c-g">Grönt</span> = hörn som återanvänds (${reused} st), <span class="c-a">orange</span> = nytt hörn. Strips bryts med restart-index <code>${restart}</code>; i dag dominerar list + cache-optimerad ordning.`,
          `On the model: triangle #${tri} and the ${walk.count - 1} after it in index order. <span class="c-g">Green</span> = reused corners (${reused}), <span class="c-a">orange</span> = new corner. Strips are cut with the restart index <code>${restart}</code>; today lists + cache-optimized order dominate.`,
        ),
      ),
    }),
  ]);
  const showPanels = stepPanels([
    { el: panel0, steps: [0] },
    { el: panel1, steps: [1] },
    { el: panel2, steps: [2] },
    { el: panel3, steps: [3] },
  ]);

  /* ---------- 3D: vertex buffer box, fetch stream and beams ---------- */
  const vc = mesh.vertexCount;
  const BOX = { x: 0.15, y: -1.05, z: 0.35, len: 2.5 };
  const box = ms.box(`vertex buffer · ${formatBytes(layout.vertexBytes)}`, [BOX.x, BOX.y, BOX.z], [BOX.len, 0.1, 0.1], COLORS.violet);
  const addrX = (v: number) => BOX.x - BOX.len / 2 + ((v + 0.5) / vc) * BOX.len;
  ms.pivot.updateMatrixWorld(true);
  const toWorld = (v: number) => new Vector3(...ctx.derived.position(v)).applyMatrix4(ms.pivot.matrixWorld);
  const COUNT = Math.min(900, vc);
  const stream = ms.particles(COUNT, COLORS.cyan, 0.03, 'world');
  {
    const a = new Float32Array(COUNT * 3);
    const b = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) {
      const v = Math.floor((i / COUNT) * vc) % vc;
      a.set([addrX(v), BOX.y + (Math.random() - 0.5) * 0.06, BOX.z + (Math.random() - 0.5) * 0.06], i * 3);
      toWorld(v).toArray(b, i * 3);
    }
    stream.setTargets(a, b);
  }
  const beamMats: LineBasicMaterial[] = [];
  const beams = verts.map((v, k) => {
    const g = new BufferGeometry().setFromPoints([new Vector3(addrX(v), BOX.y, BOX.z), toWorld(v)]);
    const m = new LineBasicMaterial({ color: hdr([COLORS.cyan, COLORS.magenta, COLORS.amber][k], 2.4), transparent: true, opacity: 0, depthTest: false });
    beamMats.push(m);
    const ln = new Line(g, m);
    ln.renderOrder = 14;
    ln.frustumCulled = false;
    ms.scene.add(ln);
    return { ln, g, a: new Vector3(addrX(v), BOX.y, BOX.z), b: toWorld(v) };
  });

  /* ---------- Cache colors ---------- */
  const cOne = hdr(COLORS.green, 1.1);
  const cTwo = hdr(COLORS.amber, 1.4);
  const cMany = hdr(COLORS.red, 1.7);
  const cHit = hdr(COLORS.green, 1.7);
  const cMiss = hdr(COLORS.amber, 2.1);
  const byRuns = (v: number) => {
    const n = d.transforms[v];
    return n <= 1 ? cOne : n === 2 ? cTwo : cMany;
  };

  /* ---------- Animation state ---------- */
  const A = { snapK: 0, fetch: 0, walk: 0, pts: 0, base: 0 };
  let step = -1;
  let now = 0;
  let head = 0; // cache playhead (index position)
  let headMiss = 0;
  let walkT0 = 0;
  const idxRate = Math.max(60, d.main.indices / 6);
  let lastDrawn = -1;
  ms.onFrame((time, dt) => {
    now = time;
    const pulse = 0.5 + 0.5 * Math.sin(time * 5);
    // Step 0: the assembly cursor rides the newest triangle.
    const drawn = Math.min(N, Math.floor(ms.material.uniforms.uDrawTris.value));
    const assembling = step === 0 && drawn < N;
    cursor.visible = assembling && drawn >= 0;
    if (assembling) {
      cursor.position.copy(S.centroid(Math.max(0, Math.min(N - 1, drawn))));
      cursor.scale.setScalar(0.12 + 0.05 * pulse);
      ms.material.uniforms.uHighlightColor.value.set(COLORS.amber);
      ms.material.uniforms.uHighlightTri.value = drawn - 1;
      if (drawn !== lastDrawn) setTicker(Math.max(0, drawn - 1));
    } else if (step === 0) {
      ms.material.uniforms.uHighlightColor.value.set(COLORS.magenta);
      ms.material.uniforms.uHighlightTri.value = tri;
      if (lastDrawn !== N) setTicker(tri);
    }
    lastDrawn = step === 0 ? drawn : -1;
    snap.set(A.snapK, pulse);
    // Step 1: beams grow one after another.
    beams.forEach((bm, k) => {
      const l = clamp01(A.fetch - k);
      beamMats[k].opacity = l > 0 ? 0.9 : 0;
      bm.g.setFromPoints([bm.a, bm.a.clone().lerp(bm.b, l)]);
    });
    // Step 2: cache playhead.
    pts.alpha(A.pts);
    if (step === 2 && d.main.indices > 0) {
      const adv = Math.min(idxRate * dt, d.main.indices);
      const end = head + adv;
      const budget = mesh.vertexCount > 20000 ? 250 : 4000;
      let flashed = 0;
      for (let i = Math.floor(head); i < Math.floor(end); i++) {
        const ii = i % d.main.indices;
        if (ii === 0) headMiss = 0;
        const hit = d.hits[ii] === 1;
        if (!hit) headMiss++;
        if (flashed++ < budget) pts.flash(mesh.indices[ii], hit ? cHit : cMiss, hit ? 0.7 : 1);
      }
      head = end % d.main.indices;
      const done = Math.floor(head);
      live.innerHTML = `${t(L('index', 'index'))} <b>${done.toLocaleString()}</b> / ${d.main.indices.toLocaleString()} · VS <b class="c-a">${headMiss.toLocaleString()}</b> · ${t(L('träffar', 'hits'))} <b class="c-g">${(done - headMiss).toLocaleString()}</b>`;
    }
    pts.tick(dt);
    // Step 3: strip walk loops.
    if (step === 3) {
      const per = 0.5;
      const cycle = walk.count * per + 1.6;
      A.walk = Math.min(walk.count, ((now - walkT0) % cycle) / per);
    }
    walk.set(step === 3 ? A.walk : 0, pulse);
  });

  return {
    show(s, animate) {
      const fwd = animate && s > step;
      step = s;
      gsap.killTweensOf(A);
      killStageTweens(ms);
      showPanels(s, fwd);
      // Layers.
      ms.setMode(s === 2 ? 'ghost' : 'shaded', s === 2 ? 0.85 : 0, secs(fwd, 0.6));
      ms.setLayer('wire', s === 0 ? 0.18 : s === 3 ? 0.22 : 0.1, secs(fwd, 0.5));
      ms.setLayer('points', s === 1 ? 0.35 : 0, secs(fwd, 0.5));
      ms.uniform('uDiffuseW', s === 3 || s === 1 ? 0.55 : 1, secs(fwd, 0.5));
      ms.uniform('uSpecW', s === 3 || s === 1 ? 0.3 : 1, secs(fwd, 0.5));
      // Step 0: draw the real mesh in index order.
      ms.material.uniforms.uHighlightColor.value.set(s === 0 ? COLORS.amber : COLORS.magenta);
      ms.material.uniforms.uHighlightTri.value = s === 0 || s === 1 ? tri : -10;
      if (s === 0 && fwd) {
        const D = Math.min(3.2, 0.4 + N * 0.25);
        ms.drawTriangles(0, 0);
        ms.drawTriangles(N, D);
        A.snapK = 0;
        gsap.to(A, { snapK: 1, duration: dur(0.7), delay: dur(D), ease: 'back.out(1.6)' });
        setTicker(0);
      } else {
        ms.drawTriangles(1e9, 0);
        A.snapK = s <= 1 ? 1 : 0;
        if (s === 0) setTicker(tri);
      }
      if (s >= 2) A.snapK = 0;
      // Step 1: vertex fetch.
      box.visible = s === 1;
      stream.points.visible = s === 1;
      if (s === 1) {
        stream.progress(fwd ? 0 : 1, 0);
        if (fwd) stream.progress(1, 2.6);
        if (fwd) {
          A.fetch = 0;
          gsap.to(A, { fetch: 3, duration: dur(1.8), ease: 'none', delay: dur(0.3) });
        } else A.fetch = 3;
      } else A.fetch = 0;
      // Step 2: cache.
      pts.clear();
      if (s === 2) {
        head = 0;
        headMiss = 0;
        pts.setBase(byRuns, 0);
        A.pts = fwd ? 0 : 1;
        if (fwd) gsap.to(A, { pts: 1, duration: dur(0.6) });
        const c = { k: 0 };
        if (fwd) gsap.to(c, { k: 1, duration: dur(2.5), delay: dur(1.2), onUpdate: () => pts.setBase(byRuns, c.k) });
        else pts.setBase(byRuns, 1);
      } else A.pts = 0;
      // Step 3: strip walk.
      walkT0 = now;
      A.walk = 0;
    },
    destroy() {
      gsap.killTweensOf(A);
      ms.destroy();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Concept: a cloud of vertices, indices tick by, triangles snap       */
/* ------------------------------------------------------------------ */
function conceptVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const mesh = ctx.state.mesh;
  const N = mesh.triangleCount;
  const S = buildScene(host, ctx, true);
  const { ms, cursor, pts, walk } = S;

  // A tiny FIFO over the first indices of the real mesh, slow enough to follow.
  const CACHE = 6;
  const total = mesh.indices.length - (mesh.indices.length % 3);
  const CN = Math.min(total, 36);
  // Start a little before the showcase triangle: that part of the mesh faces the camera.
  const s0 = Math.max(0, Math.min(total - CN, ctx.derived.showcaseTriangle(ctx.state.api) * 3 - 12));
  const idxAt = (i: number) => mesh.indices[s0 + i];
  const fifo: { slots: number[]; hit: boolean }[] = [];
  {
    const q: number[] = [];
    for (let i = 0; i < CN; i++) {
      const v = idxAt(i);
      const hit = q.includes(v);
      if (!hit) {
        q.unshift(v);
        if (q.length > CACHE) q.pop();
      }
      fifo.push({ slots: q.slice(), hit });
    }
  }
  const conceptMisses = fifo.filter((s) => !s.hit).length;

  // Panels: caption at the bottom, a HUD at the top.
  const capPanel = ms.panel(t(L('Vad händer', 'What happens')), [h('p.ia-cap')], { side: 'bottom' });
  const capText = capPanel.querySelector('.ia-cap')!;
  const cellN = Math.min(CN, 36);
  const cells = Array.from({ length: cellN }, (_, i) => h(`span.iac-cell${i % 3 === 2 ? '.sep' : ''}`, { text: String(idxAt(i)) }));
  const counterV = h('div.v.glow-magenta', { text: '0' });
  const counterK = h('div.k');
  const counter = h('div.stat', {}, [counterV, counterK]);
  const slots = Array.from({ length: CACHE }, () => h('span.iac-slot', { text: '·' }));
  const cacheRow = h('div.iac-cache', {}, [h('span.iac-k', { text: `FIFO ${CACHE}` }), ...slots]);
  const hud = ms.panel(t(L('Indexbufferten', 'The index buffer')), [h('div.iac-stream', {}, cells), cacheRow, h('div.stat-row', {}, [counter])], { side: 'top' });
  const stripPanel = ms.panel(t(L('Triangle strip', 'Triangle strip')), [stripSvg(), h('div.hint', { html: '<b>list</b> <code>0 1 2 · 2 1 3 · 2 3 4 · 4 3 5</code><br><b>strip</b> <code>0 1 2 3 4 5</code>' })], { side: 'top', className: 'iac-strip-panel' });
  const showPanels = stepPanels([
    { el: hud, steps: [1, 2] },
    { el: stripPanel, steps: [3] },
    { el: capPanel, steps: [0, 1, 2, 3] },
  ]);

  const captions: Text[] = [
    L(
      `${mesh.vertexCount.toLocaleString()} vertices i en buffert – bara ett moln av punkter. Inget säger ännu vilka som hör ihop.`,
      `${mesh.vertexCount.toLocaleString()} vertices in a buffer – just a cloud of points. Nothing says yet which belong together.`,
    ),
    L('Indexen tickar förbi tre åt gången. Varje trippel knäpper ihop tre punkter till en triangel.', 'Indices tick by three at a time. Every triple snaps three points together into a triangle.'),
    L(
      `Delade vertices ligger kvar i cachen: <b class="c-g">grönt</b> = träff, <b class="c-a">orange</b> = vertex shadern körs. ${conceptMisses} VS-anrop för ${CN} index.`,
      `Shared vertices stay in the cache: <b class="c-g">green</b> = hit, <b class="c-a">orange</b> = the vertex shader runs. ${conceptMisses} VS calls for ${CN} indices.`,
    ),
    L(
      'Triangle strip: varje nytt index bildar en triangel med de två föregående. På modellen: <b class="c-g">grönt</b> hörn återanvänds, <b class="c-a">orange</b> är nytt.',
      'Triangle strip: each new index forms a triangle with the previous two. On the model: <b class="c-g">green</b> corners are reused, <b class="c-a">orange</b> is new.',
    ),
  ];

  const cHit = hdr(COLORS.green, 1.7);
  const cMiss = hdr(COLORS.amber, 2.0);
  const A = { cloud: 1, pts: 0 };
  let step = -1;
  let now = 0;
  let ci = -1; // cache cursor
  let ciT = 0;
  let walkT0 = 0;
  ms.onFrame((time, dt) => {
    now = time;
    const pulse = 0.5 + 0.5 * Math.sin(time * 5);
    const drawn = Math.min(N, Math.floor(ms.material.uniforms.uDrawTris.value));
    const assembling = step === 1 && drawn < N;
    cursor.visible = assembling;
    if (assembling) {
      cursor.position.copy(S.centroid(Math.max(0, drawn)));
      cursor.scale.setScalar(0.14 + 0.06 * pulse);
      ms.material.uniforms.uHighlightTri.value = drawn - 1;
    }
    if (step === 1) {
      const k = Math.min(N, drawn);
      counterV.textContent = `${k.toLocaleString()} / ${N.toLocaleString()}`;
      cells.forEach((c, i) => {
        const tr = s0 / 3 + Math.floor(i / 3);
        c.classList.toggle('done', tr < k - 1);
        c.classList.toggle('cur', tr === k - 1 && k < N);
      });
    }
    pts.alpha(A.pts);
    if (step === 2 && CN > 0) {
      // ~7 indices per second, then a short pause and around again.
      ciT += dt * 7;
      const ni = Math.floor(ciT);
      if (ni !== ci) {
        if (ni >= CN + 6) {
          ciT = 0;
          ci = -1;
          pts.clear();
        } else {
          ci = ni;
          if (ci < CN) pts.flash(idxAt(ci), fifo[ci].hit ? cHit : cMiss, 1);
          const cc = Math.min(ci, CN - 1);
          const st = fifo[cc];
          slots.forEach((s, i) => {
            s.textContent = st.slots[i] !== undefined ? String(st.slots[i]) : '·';
            s.classList.toggle('new', i === 0 && !st.hit && ci < CN);
          });
          let miss = 0;
          for (let i = 0; i <= cc; i++) if (!fifo[i].hit) miss++;
          counterV.textContent = `${miss} / ${cc + 1}`;
          cells.forEach((c, i) => {
            c.classList.toggle('chit', i <= cc && fifo[i].hit);
            c.classList.toggle('cmiss', i <= cc && !fifo[i].hit);
            c.classList.toggle('ccur', i === ci);
          });
        }
      }
    }
    pts.tick(dt * 0.55);
    if (step === 3) {
      const per = 0.6;
      const cycle = walk.count * per + 1.6;
      walk.set(Math.min(walk.count, ((now - walkT0) % cycle) / per), pulse);
    } else walk.set(0, pulse);
    ms.setLayer('points', 0.9 * A.cloud, 0);
  });

  return {
    show(s, animate) {
      const fwd = animate && s > step;
      step = s;
      gsap.killTweensOf(A);
      killStageTweens(ms);
      showPanels(s, fwd);
      capText.innerHTML = t(captions[s]);
      if (fwd) gsap.fromTo(capText, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: dur(0.4) });
      hud.dataset.step = String(s);
      counterK.textContent = s === 1 ? t(L('trianglar', 'triangles')) : t(L('VS-anrop / index', 'VS calls / indices'));
      cells.forEach((c) => c.classList.remove('done', 'cur', 'chit', 'cmiss', 'ccur'));
      // Step 0: only points. Step 1: triangles snap together in index order.
      (ms.layers.points.material as PointsMaterial).color.copy(hdr(COLORS.cyan, 1.6));
      if (s === 0) {
        ms.setLayer('solid', 0, secs(fwd, 0.5));
        ms.setLayer('wire', 0, secs(fwd, 0.5));
        A.cloud = 1;
      } else {
        ms.setLayer('solid', 1, 0);
        ms.setLayer('wire', s === 3 ? 0.2 : 0.14, secs(fwd, 0.5));
        A.cloud = s === 1 ? 1 : 0;
        if (s === 1 && fwd) gsap.to(A, { cloud: 0.25, duration: dur(4), delay: dur(0.5) });
        else if (s === 1) A.cloud = 0.25;
      }
      ms.material.uniforms.uHighlightColor.value.set(COLORS.amber);
      ms.material.uniforms.uHighlightTri.value = -10;
      if (s === 1 && fwd) {
        ms.drawTriangles(0, 0);
        // Slow at first (you can follow single triples), then faster.
        const u = ms.material.uniforms.uDrawTris;
        gsap.to(u, { value: N, duration: dur(Math.min(5, 1.2 + N * 0.4)), ease: 'power3.in' });
      } else ms.drawTriangles(s === 0 ? 0 : 1e9, 0);
      ms.setMode(s === 2 ? 'ghost' : 'shaded', s === 2 ? 0.85 : 0, secs(fwd, 0.6));
      ms.uniform('uDiffuseW', s === 3 ? 0.55 : 1, secs(fwd, 0.5));
      pts.clear();
      ci = -1;
      ciT = 0;
      A.pts = s === 2 ? 1 : 0;
      slots.forEach((x) => (x.textContent = '·'));
      walkT0 = now;
    },
    destroy() {
      gsap.killTweensOf(A);
      ms.destroy();
    },
  };
}

/* ------------------------------------------------------------------ */
/* API panels                                                          */
/* ------------------------------------------------------------------ */
function apis(ctx: SlideContext): Record<ApiId, ApiPanelSpec> {
  const m = ctx.state.mesh;
  const l = ctx.derived.layout;
  const count = m.indices.length;
  const u16 = l.indexType === 'uint16';
  const b = u16 ? 2 : 4;
  const tri = ctx.derived.showcaseTriangle(ctx.state.api);
  const acmr = iaData(ctx).main.acmr.toFixed(2);
  const terms = (extra: { term: string; desc: L }[]) => [
    { term: 'ACMR', desc: L('Average cache miss ratio: VS-anrop per triangel. 3.0 = ingen återanvändning.', 'Average cache miss ratio: VS invocations per triangle. 3.0 = no reuse.') },
    { term: 'post-transform cache', desc: L('Liten cache för vertex shader-resultat, nycklad på index. Fungerar bara med indexerad ritning.', 'Small cache of vertex shader results, keyed by index. Only works with indexed drawing.') },
    ...extra,
  ];
  return {
    opengl: {
      note: L(
        `Topologin anges i själva ritanropet. Indexbufferten hör till VAO:t (element array buffer). Den här modellen: ${count.toLocaleString()} index, ACMR ≈ ${acmr} med FIFO 32.`,
        `The topology is given in the draw call itself. The index buffer is part of the VAO (element array buffer). This model: ${count.toLocaleString()} indices, ACMR ≈ ${acmr} with FIFO 32.`,
      ),
      code: [
        {
          lang: 'cpp',
          src: `// The element (index) buffer is VAO state
glVertexArrayElementBuffer(vao, ibo);
glVertexArrayVertexBuffer(vao, 0, vbo, 0, ${l.stride});
glBindVertexArray(vao);

glDrawElements(GL_TRIANGLES,       // topology: triangle list
               ${count},${' '.repeat(Math.max(1, 18 - String(count).length))}// index count = 3 × ${m.triangleCount}
               ${u16 ? 'GL_UNSIGNED_SHORT' : 'GL_UNSIGNED_INT  '},  // ${b}-byte indices
               (void*)0);          // byte offset into the IBO

// Only triangle #${tri}:
glDrawElements(GL_TRIANGLES, 3, ${u16 ? 'GL_UNSIGNED_SHORT' : 'GL_UNSIGNED_INT'},
               (void*)${tri * 3 * b});

// Strips: cut with the max index value
glEnable(GL_PRIMITIVE_RESTART_FIXED_INDEX);`,
          highlight: [[1, 2, 6, 7, 8, 9], [3, 4], [6, 7, 11, 12, 13], [15, 16]],
        },
      ],
      terms: terms([{ term: 'GL_PRIMITIVE_RESTART_FIXED_INDEX', desc: L('Index 0xFFFF / 0xFFFFFFFF startar en ny strip.', 'Index 0xFFFF / 0xFFFFFFFF starts a new strip.') }]),
      you: L('väljer topologi och indexordning', 'choose topology and index order'),
      driver: L('matar IA:n, cachen är hårdvara', 'feeds the IA, the cache is hardware'),
    },
    vulkan: {
      note: L(
        `Topologin bakas in i pipelinen via VkPipelineInputAssemblyStateCreateInfo (kan göras dynamisk i 1.3). Indexbufferten binds vid inspelning. ${count.toLocaleString()} index, ACMR ≈ ${acmr}.`,
        `The topology is baked into the pipeline via VkPipelineInputAssemblyStateCreateInfo (can be dynamic in 1.3). The index buffer is bound while recording. ${count.toLocaleString()} indices, ACMR ≈ ${acmr}.`,
      ),
      code: [
        {
          lang: 'cpp',
          src: `VkPipelineInputAssemblyStateCreateInfo ia{
    .sType = VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO,
    .topology = VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST,
    .primitiveRestartEnable = VK_FALSE,
};
pipelineInfo.pInputAssemblyState = &ia;

// While recording the command buffer:
VkDeviceSize offset = 0;
vkCmdBindVertexBuffers(cmd, 0, 1, &vertexBuffer, &offset);
vkCmdBindIndexBuffer(cmd, indexBuffer, 0, ${u16 ? 'VK_INDEX_TYPE_UINT16' : 'VK_INDEX_TYPE_UINT32'});
// indexCount, instanceCount, firstIndex, vertexOffset, firstInstance
vkCmdDrawIndexed(cmd, ${count}, 1, 0, 0, 0);
// Only triangle #${tri}:
vkCmdDrawIndexed(cmd, 3, 1, ${tri * 3}, 0, 0);`,
          highlight: [[3, 11, 13], [9, 10], [12, 13, 14, 15], [3, 4]],
        },
      ],
      terms: terms([
        { term: 'VK_PRIMITIVE_TOPOLOGY_TRIANGLE_STRIP', desc: L('Strip-topologi; restart kräver primitiveRestartEnable.', 'Strip topology; restart needs primitiveRestartEnable.') },
        { term: 'vkCmdSetPrimitiveTopology', desc: L('Dynamiskt tillstånd i 1.3 – inom samma topologiklass.', 'Dynamic state in 1.3 – within the same topology class.') },
      ]),
      you: L('bakar in topologin i pipelinen', 'bake the topology into the pipeline'),
      driver: L('matar IA:n, cachen är hårdvara', 'feeds the IA, the cache is hardware'),
    },
    d3d12: {
      note: L(
        `PSO:n bestämmer topologitypen (triangel), kommandolistan den exakta topologin. ${count.toLocaleString()} index, ACMR ≈ ${acmr}.`,
        `The PSO fixes the topology type (triangle), the command list the exact topology. ${count.toLocaleString()} indices, ACMR ≈ ${acmr}.`,
      ),
      code: [
        {
          lang: 'cpp',
          src: `psoDesc.PrimitiveTopologyType = D3D12_PRIMITIVE_TOPOLOGY_TYPE_TRIANGLE;
psoDesc.IBStripCutValue = D3D12_INDEX_BUFFER_STRIP_CUT_VALUE_DISABLED;

D3D12_INDEX_BUFFER_VIEW ibv{
    indexBuffer->GetGPUVirtualAddress(),
    ${count * b},                          // SizeInBytes
    ${u16 ? 'DXGI_FORMAT_R16_UINT' : 'DXGI_FORMAT_R32_UINT'} };

cmd->IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
cmd->IASetVertexBuffers(0, 1, &vbv);
cmd->IASetIndexBuffer(&ibv);
// IndexCount, InstanceCount, StartIndex, BaseVertex, StartInstance
cmd->DrawIndexedInstanced(${count}, 1, 0, 0, 0);
// Only triangle #${tri}:
cmd->DrawIndexedInstanced(3, 1, ${tri * 3}, 0, 0);`,
          highlight: [[1, 4, 5, 6, 7, 9, 11, 13], [10], [12, 13, 14, 15], [2, 9]],
        },
      ],
      terms: terms([
        { term: 'IBStripCutValue', desc: L('Restart-värde för strips (0xFFFF / 0xFFFFFFFF) i PSO:n.', 'Strip restart value (0xFFFF / 0xFFFFFFFF) in the PSO.') },
        { term: 'D3D_PRIMITIVE_TOPOLOGY_TRIANGLESTRIP', desc: L('Strip-topologi, sätts med IASetPrimitiveTopology.', 'Strip topology, set with IASetPrimitiveTopology.') },
      ]),
      you: L('sätter topologi och indexbuffert', 'set topology and index buffer'),
      driver: L('matar IA:n, cachen är hårdvara', 'feeds the IA, the cache is hardware'),
    },
  };
}

export default standardSlide({
  id: 'input-assembly',
  group: 'gpu-fixed',
  short: L('Input assembly', 'Input assembly'),
  title: L('Input assembly – index blir trianglar', 'Input assembly – indices become triangles'),
  lead: L(
    'Första steget på GPU:n. <b>Input assemblern</b> läser indexbufferten, hämtar vertexdata och bygger primitiver – och ser till att delade hörn inte räknas om i onödan.',
    'The first stage on the GPU. The <b>input assembler</b> reads the index buffer, fetches vertex data and builds primitives – making sure shared corners are not recomputed needlessly.',
  ),
  bullets: [
    L(
      'Med topologin <b>triangle list</b> läses indexbufferten tre index i taget. Varje trippel blir en triangel – index pekar ut vertices.',
      'With the <b>triangle list</b> topology the index buffer is read three indices at a time. Each triple becomes one triangle – indices point at vertices.',
    ),
    L(
      'För varje index görs en <b>vertex fetch</b>: adress = bas + index × stride. Attributen avkodas enligt input layout och blir vertex shaderns indata.',
      'For each index a <b>vertex fetch</b> happens: address = base + index × stride. The attributes are decoded per the input layout and become the vertex shader inputs.',
    ),
    L(
      'Delade vertices återanvänds ur en <b>post-transform cache</b> – vertex shadern körs bara vid miss. Måttet <b>ACMR</b> (VS-anrop per triangel) går från 3,0 utan cache mot ~0,5 för bra indexordning.',
      'Shared vertices are reused from a <b>post-transform cache</b> – the vertex shader only runs on a miss. <b>ACMR</b> (VS calls per triangle) goes from 3.0 without a cache towards ~0.5 with a good index order.',
    ),
    L(
      'Sidonot: <b>strip</b> återanvänder de två senaste indexen (1 index per ny triangel), <i>primitive restart</i> bryter en strip. I dag dominerar indexerade listor.',
      'Side note: a <b>strip</b> reuses the two previous indices (1 index per new triangle), <i>primitive restart</i> cuts a strip. Today indexed lists dominate.',
    ),
  ],
  api: apis,
  data: dataVisual,
  concept: conceptVisual,
});
