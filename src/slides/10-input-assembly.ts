import gsap from 'gsap';
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  Points,
  PointsMaterial,
  Sprite,
  SpriteMaterial,
  Vector3,
} from 'three';
import type { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import '../styles/slides/input-assembly.css';
import { SHOWCASE_ROT_X, SHOWCASE_ROT_Y } from '../core/derived';
import { dur, h } from '../core/dom';
import { L } from '../core/i18n';
import type { ApiId } from '../core/state';
import { formatBytes } from '../pipeline/layout';
import { modelMatrix } from '../pipeline/transform';
import type { StageView } from '../views/ThreeStage';
import { BASE_COLOR } from '../pipeline/shade';
import { COLORS, disposeScene, label, makeScene, shadedMesh, starfield, wireframe } from '../views/three-helpers';
import { card, stat } from '../views/widgets';
import { standardSlide } from './standard';
import type { ApiPanelSpec, SlideContext, Visual } from './types';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Soft round sprite used for glowing dots. */
function glowTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.22, 'rgba(255,255,255,0.85)');
  gr.addColorStop(0.5, 'rgba(255,255,255,0.25)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  return new CanvasTexture(c);
}

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

/** Keep a perspective camera framing a unit-sphere object when the host gets narrow. */
function fitCamera(camera: import('three').PerspectiveCamera, base: Vector3, aspect: number, target = new Vector3()) {
  const k = Math.max(1, 1.25 / Math.max(0.3, aspect));
  camera.position.copy(base.clone().sub(target).multiplyScalar(k).add(target));
  camera.lookAt(target);
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

  /* ---------- 3D view ---------- */
  const { scene, camera } = makeScene();
  const tex = glowTexture();
  const model = new Group();
  model.matrixAutoUpdate = false;
  model.matrix.copy(modelMatrix(SHOWCASE_ROT_Y, SHOWCASE_ROT_X));
  // Re-center the world on the showcase triangle so the orbit pivots around it.
  const pivot = new Group();
  pivot.add(model);
  scene.add(pivot, starfield(500));

  const solid = shadedMesh(mesh, [BASE_COLOR[0] * 0.3, BASE_COLOR[1] * 0.3, BASE_COLOR[2] * 0.4]);
  const wire = wireframe(mesh, COLORS.cyan, 0.16);
  model.add(solid, wire);

  // All vertices as points – colored later by how often the vertex shader ran for them.
  const pg = new BufferGeometry();
  pg.setAttribute('position', new BufferAttribute(mesh.positions, 3));
  const pColors = new Float32Array(mesh.vertexCount * 3);
  const cBase = new Color(COLORS.cyan).multiplyScalar(0.55);
  const cOne = hdr(COLORS.green, 0.9);
  const cTwo = hdr(COLORS.amber, 1.2);
  const cMany = hdr(COLORS.red, 1.5);
  const pAttr = new BufferAttribute(pColors, 3);
  pg.setAttribute('color', pAttr);
  const pointSize = Math.max(0.018, Math.min(0.05, 0.35 / Math.sqrt(mesh.vertexCount)));
  const points = new Points(
    pg,
    new PointsMaterial({ size: pointSize * 1.6, map: tex, vertexColors: true, transparent: true, depthWrite: false, blending: AdditiveBlending }),
  );
  model.add(points);
  const setPointColors = (k: number) => {
    for (let i = 0; i < mesh.vertexCount; i++) {
      const n = d.transforms[i];
      const target = n === 0 ? cBase : n === 1 ? cOne : n === 2 ? cTwo : cMany;
      pColors[i * 3] = cBase.r + (target.r - cBase.r) * k;
      pColors[i * 3 + 1] = cBase.g + (target.g - cBase.g) * k;
      pColors[i * 3 + 2] = cBase.b + (target.b - cBase.b) * k;
    }
    pAttr.needsUpdate = true;
  };
  setPointColors(0);

  // Showcase triangle: fill, glowing edges, three vertex sprites with labels.
  const P = verts.map((v) => new Vector3(...ctx.derived.position(v)));
  const centroid = P[0].clone().add(P[1]).add(P[2]).multiplyScalar(1 / 3);
  const triGeo = new BufferGeometry().setFromPoints(P);
  const triFill = new Mesh(
    triGeo,
    new MeshBasicMaterial({ color: hdr(COLORS.magenta, 1.2), transparent: true, opacity: 0.0, side: DoubleSide, depthTest: false, blending: AdditiveBlending }),
  );
  triFill.renderOrder = 10;
  const edgeGeo = new BufferGeometry().setFromPoints([...P, P[0]]);
  const triEdge = new Line(edgeGeo, new LineBasicMaterial({ color: hdr(COLORS.magenta, 2.6), transparent: true, depthTest: false }));
  triEdge.renderOrder = 11;
  const triGroup = new Group();
  triGroup.add(triFill, triEdge);
  model.add(triGroup);
  const vSprites = P.map((p) => {
    const sp = new Sprite(new SpriteMaterial({ map: tex, color: hdr(COLORS.cyan, 2.4), transparent: true, depthTest: false, blending: AdditiveBlending }));
    sp.position.copy(p);
    sp.renderOrder = 12;
    model.add(sp);
    return sp;
  });
  const vLabels: CSS2DObject[] = verts.map((v, k) => {
    const lb = label(`v${v}`, 'cyan');
    // Push labels slightly away from the centroid so they don't cover the triangle.
    lb.position.copy(P[k].clone().sub(centroid).multiplyScalar(0.9).add(P[k]));
    model.add(lb);
    return lb;
  });
  const worldCentroid = centroid.clone().applyMatrix4(model.matrix);
  pivot.position.copy(worldCentroid).multiplyScalar(-1);

  // The triangles that follow the showcase triangle in the index buffer (stream order).
  const NB = Math.min(10, mesh.triangleCount - tri - 1);
  const nbPos = new Float32Array(Math.max(1, NB) * 9);
  const nbCol = new Float32Array(Math.max(1, NB) * 9);
  for (let k = 0; k < NB; k++) {
    const ids = ctx.derived.triangleVertices(tri + 1 + k);
    const c = new Color(COLORS.amber).lerp(new Color(COLORS.violet), k / Math.max(1, NB - 1)).multiplyScalar(1.1);
    ids.forEach((v, j) => {
      nbPos.set(ctx.derived.position(v), k * 9 + j * 3);
      nbCol.set([c.r, c.g, c.b], k * 9 + j * 3);
    });
  }
  const nbGeo = new BufferGeometry();
  nbGeo.setAttribute('position', new BufferAttribute(nbPos, 3));
  nbGeo.setAttribute('color', new BufferAttribute(nbCol, 3));
  nbGeo.setDrawRange(0, 0);
  const nbMesh = new Mesh(nbGeo, new MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.75, side: DoubleSide, depthTest: false, blending: AdditiveBlending }));
  nbMesh.renderOrder = 9;
  model.add(nbMesh);

  const P0 = { tri: 0, fetch: 0, cache: 0, order: 0 };
  // Look at the triangle from the default camera direction, but closer.
  const baseEye = camera.position.clone().normalize().multiplyScalar(1.65);
  camera.position.copy(baseEye);
  camera.lookAt(0, 0, 0);
  const view: StageView = {
    scene,
    camera,
    bloom: 0.9,
    bloomThreshold: 0.82,
    orbit: true,
    onResize: (w, hh) => fitCamera(camera, baseEye, w / hh),
    onFrame: (time) => {
      const pulse = 0.5 + 0.5 * Math.sin(time * 4);
      // Lines "snap" together from the centroid.
      const s = 0.2 + 0.8 * P0.tri;
      triGroup.position.copy(centroid.clone().multiplyScalar(1 - s));
      triGroup.scale.setScalar(s);
      (triEdge.material as LineBasicMaterial).opacity = P0.tri;
      (triFill.material as MeshBasicMaterial).opacity = P0.tri * (0.25 + 0.12 * pulse) * (1 - 0.6 * P0.cache);
      vSprites.forEach((sp, k) => {
        const local = clamp01(P0.fetch * 3 - k);
        const glow = Math.max(P0.tri * 0.6, local);
        sp.scale.setScalar(0.06 + 0.07 * glow + 0.03 * local * pulse);
        (sp.material as SpriteMaterial).opacity = glow;
      });
      vLabels.forEach((lb, k) => {
        lb.element.style.opacity = String(clamp01(P0.fetch * 3 - k));
      });
      nbGeo.setDrawRange(0, Math.round(P0.order * NB) * 3);
      (wire.material as LineBasicMaterial).opacity = 0.16 * (1 - 0.6 * P0.cache);
      (points.material as PointsMaterial).size = pointSize * (1.6 + 1.2 * P0.cache);
    },
  };
  const stageHost = h('div.ia-3d');
  const hud = h('div.ia-hud');
  stageHost.append(hud);

  /* ---------- Cards ---------- */
  // Step 0: index buffer → triangles.
  const from = Math.max(0, tri - 3);
  const to = Math.min(mesh.triangleCount - 1, tri + 3);
  const groups: HTMLElement[] = [];
  for (let k = from; k <= to; k++) {
    const ids = ctx.derived.triangleVertices(k);
    groups.push(
      h(`div.ia-tri${k === tri ? '.hot' : ''}`, {}, [
        h('div.ia-tri-n', { text: `#${k}` }),
        h('div.ia-tri-ix', {}, ids.map((v) => h('span.mem-cell.idx', { text: String(v) }))),
      ]),
    );
  }
  const off = tri * 3 * idxBytes;
  const card0 = card(t(L('Indexbuffert → trianglar', 'Index buffer → triangles')), [
    h('div.ia-stream', {}, [from > 0 ? h('span.ia-ellipsis', { text: '…' }) : null, ...groups, to < mesh.triangleCount - 1 ? h('span.ia-ellipsis', { text: '…' }) : null]),
    h('div.ia-eq', {
      html: t(
        L(
          `Triangel <b class="glow-magenta">#${tri}</b> = <code>indices[${tri * 3}…${tri * 3 + 2}]</code> = <b class="c-idx">${verts.join(', ')}</b> · byte-offset ${tri * 3} × ${idxBytes} B = <b>${off}</b>`,
          `Triangle <b class="glow-magenta">#${tri}</b> = <code>indices[${tri * 3}…${tri * 3 + 2}]</code> = <b class="c-idx">${verts.join(', ')}</b> · byte offset ${tri * 3} × ${idxBytes} B = <b>${off}</b>`,
        ),
      ),
    }),
    h('div.stat-row', {}, [
      stat(mesh.indices.length.toLocaleString(), t(L('index', 'indices')), 'c-idx'),
      stat((mesh.indices.length / 3).toLocaleString(), t(L('trianglar (÷ 3)', 'triangles (÷ 3)')), 'glow-magenta'),
      stat(layout.indexType, t(L(`${idxBytes} B per index`, `${idxBytes} B per index`))),
    ]),
  ]);

  // Step 1: vertex fetch.
  const base = 0x1000_0000;
  const attrCls = { position: 'c-pos', normal: 'c-nrm', uv: 'c-uv' } as const;
  const fetchRows = verts.map((v, k) =>
    h('div.ia-fetch', {}, [
      h('div.ia-fetch-head', {}, [
        h('span.mem-cell.idx', { text: String(v) }),
        h('span.ia-arrow', { text: '→' }),
        h('span.mono', { html: `${hex32(base)} + ${v} × ${layout.stride} = <b>${hex32(base + v * layout.stride)}</b>` }),
        h('span.ia-k', { text: ['v0', 'v1', 'v2'][k] }),
      ]),
      h(
        'div.ia-attrs',
        {},
        layout.attributes.map((a) => {
          const vals = a.name === 'position' ? ctx.derived.position(v) : a.name === 'normal' ? ctx.derived.normal(v) : ctx.derived.uv(v) ?? [];
          return h('div.mono', {}, [
            h(`span.${attrCls[a.name]}`, { text: `${a.name.padEnd(8)} +${String(a.offset).padStart(2)} ` }),
            h('span', { text: vals.map((x) => f(x)).join(' ') }),
          ]);
        }),
      ),
    ]),
  );
  const card1 = card(t(L('Vertex fetch – tre index, tre vertices', 'Vertex fetch – three indices, three vertices')), [
    ...fetchRows,
    h('div.hint', {
      text: t(L(`adress = bas + index × stride (${layout.stride} B) · attribut avkodas enligt input layout`, `address = base + index × stride (${layout.stride} B) · attributes decoded per the input layout`)),
    }),
  ]);

  // Step 2: post-transform vertex cache.
  const naive = d.main.triangles * 3;
  const capped = d.main.indices < mesh.indices.length;
  const maxA = 3;
  const bars = [...d.runs, { size: Infinity, acmr: d.unique / Math.max(1, d.main.triangles), misses: d.unique } as CacheRun].map((r) =>
    h('div.ia-bar', {}, [
      h('span.ia-bar-k', { text: r.size === Infinity ? t(L('∞ (unika)', '∞ (unique)')) : `FIFO ${r.size}` }),
      h('span.ia-bar-track', {}, [h(`span.ia-bar-fill${r.size === 32 ? '.main' : r.size === Infinity ? '.ideal' : ''}`, { style: { width: `${(Math.min(maxA, r.acmr) / maxA) * 100}%` } })]),
      h('span.ia-bar-v', { text: r.acmr.toFixed(2) }),
    ]),
  );
  bars.unshift(
    h('div.ia-bar', {}, [
      h('span.ia-bar-k', { text: t(L('ingen cache', 'no cache')) }),
      h('span.ia-bar-track', {}, [h('span.ia-bar-fill.naive', { style: { width: '100%' } })]),
      h('span.ia-bar-v', { text: '3.00' }),
    ]),
  );
  const STRIP = 64;
  const sStart = Math.max(0, Math.min(tri * 3 - 48, d.main.indices - STRIP));
  const stripCells: HTMLElement[] = [];
  for (let i = sStart; i < Math.min(d.main.indices, sStart + STRIP); i++) {
    const hot = i >= tri * 3 && i < tri * 3 + 3;
    stripCells.push(h(`span.ia-hm${d.hits[i] ? '.hit' : '.miss'}${hot ? '.hot' : ''}`, { attrs: { title: `#${i}: ${mesh.indices[i]}` } }));
  }
  const showHits = verts.map((v, k) => {
    const hit = d.hits[tri * 3 + k] === 1;
    return h(`span.ia-pill.${hit ? 'hit' : 'miss'}`, { text: `${v}: ${hit ? 'hit' : 'miss → VS'}` });
  });
  const card2 = card(t(L('Post-transform vertex cache (FIFO-modell)', 'Post-transform vertex cache (FIFO model)')), [
    h('div.stat-row', {}, [
      stat(d.main.misses.toLocaleString(), t(L('VS-anrop', 'VS calls')), 'glow-cyan'),
      stat(naive.toLocaleString(), t(L('utan cache', 'no cache'))),
      stat(d.main.acmr.toFixed(2), 'ACMR', 'glow-magenta'),
      stat(`${Math.round(d.main.hitRate * 100)} %`, t(L('träffar', 'hit rate')), 'glow-amber'),
    ]),
    h('div.ia-bars', {}, bars),
    h('div.ia-pills', {}, [h('div.ia-hm-row', {}, stripCells), h('span.hint', { text: `#${tri}:` }), ...showHits]),
    h('div.hint', {
      text: t(
        L(
          `Undre gräns = unika vertices / trianglar = ${(d.unique / Math.max(1, d.main.triangles)).toFixed(2)}. Riktiga GPU:er batchar vertices i stället för en ren FIFO – indexordningen spelar lika stor roll.${capped ? ` (Första ${d.main.indices.toLocaleString()} indexen.)` : ''}`,
          `Lower bound = unique vertices / triangles = ${(d.unique / Math.max(1, d.main.triangles)).toFixed(2)}. Real GPUs batch vertices instead of a pure FIFO – index order matters just as much.${capped ? ` (First ${d.main.indices.toLocaleString()} indices.)` : ''}`,
        ),
      ),
    }),
  ]);

  // Step 3: topology side note.
  const strip = stripSvg();
  const restart = layout.indexType === 'uint16' ? '0xFFFF' : '0xFFFFFFFF';
  const card3 = card(t(L('Topologi – list vs strip', 'Topology – list vs strip')), [
    h('div.ia-topo', {}, [
      strip,
      h('div.ia-topo-text', {}, [
        h('div', { html: `<b>list</b> <code>0 1 2 · 2 1 3 · 2 3 4 · 4 3 5</code> <span class="hint">12</span>` }),
        h('div', { html: `<b>strip</b> <code>0 1 2 3 4 5</code> <span class="hint">6</span>` }),
        h('div.hint', {
          html: t(
            L(
              `Den här modellen som list: <b>${mesh.indices.length.toLocaleString()}</b> index (${formatBytes(layout.indexBytes)}). En perfekt strip skulle behöva ≥ ${(mesh.triangleCount + 2).toLocaleString()}; i praktiken bryts strips med restart-index <code>${restart}</code>. Moderna motorer använder nästan alltid list + cache-optimerad indexordning.`,
              `This model as a list: <b>${mesh.indices.length.toLocaleString()}</b> indices (${formatBytes(layout.indexBytes)}). A perfect strip would need ≥ ${(mesh.triangleCount + 2).toLocaleString()}; in practice strips are cut with the restart index <code>${restart}</code>. Modern engines almost always use lists + cache-optimized index order.`,
            ),
          ),
        }),
      ]),
    ]),
  ]);

  const cards = [card0, card1, card2, card3];
  const side = h('div.ia-side.v-scroll', {}, cards);
  const root = h('div.ia-data', {}, [stageHost, side]);
  host.append(root);
  ctx.stage.attach(stageHost, view);

  const hudText = [
    L(`Triangel #${tri} av ${mesh.triangleCount.toLocaleString()}`, `Triangle #${tri} of ${mesh.triangleCount.toLocaleString()}`),
    L(`Hämtar v${verts.join(', v')}`, `Fetching v${verts.join(', v')}`),
    L(
      'Vertexfärg = antal VS-körningar: <b class="c-g">1</b> · <b class="c-a">2</b> · <b class="c-r">3+</b>',
      'Vertex color = VS runs: <b class="c-g">1</b> · <b class="c-a">2</b> · <b class="c-r">3+</b>',
    ),
    L(`Trianglarna efter #${tri} i indexordning`, `Triangles after #${tri} in index order`),
  ];

  let colorK = -1;
  let last = -1;
  return {
    show(step, animate) {
      const fwd = animate && step > last;
      last = step;
      cards.forEach((c, i) => (c.style.display = i === step ? '' : 'none'));
      hud.innerHTML = t(hudText[step]);
      const target = { tri: 1, fetch: step === 1 || step === 2 ? 1 : 0, cache: step === 2 ? 1 : 0, order: step === 3 ? 1 : 0 };
      gsap.killTweensOf(P0);
      if (fwd) {
        if (step === 0) P0.tri = 0;
        if (step === 1) P0.fetch = 0;
        if (step === 3) P0.order = 0;
        gsap.to(P0, { ...target, duration: dur(step === 3 ? 1.6 : step === 1 ? 1.4 : 0.9), ease: step === 3 || step === 1 ? 'none' : 'power2.out' });
      } else Object.assign(P0, target);
      const k = step === 2 ? 1 : 0;
      if (k !== colorK) {
        colorK = k;
        if (fwd && k === 1) {
          const c = { k: 0 };
          gsap.to(c, { k: 1, duration: dur(0.9), onUpdate: () => setPointColors(c.k) });
        } else setPointColors(k);
      }
      if (!fwd) return;
      const c = cards[step];
      gsap.fromTo(c, { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: dur(0.45), ease: 'power2.out' });
      if (step === 0) gsap.fromTo(groups, { opacity: 0, x: -10 }, { opacity: 1, x: 0, stagger: 0.07, duration: dur(0.35) });
      if (step === 1) gsap.fromTo(fetchRows, { opacity: 0, x: 20 }, { opacity: 1, x: 0, stagger: 0.45, duration: dur(0.4) });
      if (step === 2) {
        gsap.fromTo(c.querySelectorAll('.ia-bar-fill'), { scaleX: 0 }, { scaleX: 1, transformOrigin: 'left', stagger: 0.1, duration: dur(0.7), ease: 'power3.out' });
        gsap.fromTo(stripCells, { opacity: 0 }, { opacity: 1, stagger: 0.006, duration: dur(0.2) });
      }
    },
    destroy() {
      gsap.killTweensOf(P0);
      if (ctx.stage.isAttachedTo(view)) ctx.stage.detach();
      disposeScene(scene);
      tex.dispose();
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
/* Concept: a cloud of vertices, indices tick by, triangles snap       */
/* ------------------------------------------------------------------ */
const GW = 4;
const GH = 4;

function conceptVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const { scene, camera } = makeScene();
  camera.position.set(0, 0.35, 6.4);
  camera.lookAt(0, 0.78, 0);
  const tex = glowTexture();
  const stars = starfield(700);
  const world = new Group();
  world.rotation.set(-0.35, 0.25, 0);
  scene.add(stars, world);

  // Vertex positions: a jittered, gently waving sheet = "just a cloud" until indices connect it.
  const rnd = mulberry(7);
  const pos: Vector3[] = [];
  for (let j = 0; j < GH; j++) {
    for (let i = 0; i < GW; i++) {
      pos.push(
        new Vector3((i - (GW - 1) / 2) * 0.82 + (rnd() - 0.5) * 0.28, (j - (GH - 1) / 2) * 0.68 + (rnd() - 0.5) * 0.24, Math.sin(i * 1.3 + j) * 0.22 + (rnd() - 0.5) * 0.2),
      );
    }
  }
  // Triangle list, CCW, row by row.
  const listIdx: number[] = [];
  for (let j = 0; j < GH - 1; j++) {
    for (let i = 0; i < GW - 1; i++) {
      const a = j * GW + i;
      const b = a + 1;
      const c = a + GW;
      const e = c + 1;
      listIdx.push(a, b, e, a, e, c);
    }
  }
  const NT = listIdx.length / 3;
  // Strip along the bottom row pair: 0 4 1 5 2 6 3 7.
  const stripIdx: number[] = [];
  for (let i = 0; i < GW; i++) stripIdx.push(i + GW, i);
  const stripTris: [number, number, number][] = [];
  for (let k = 0; k + 2 < stripIdx.length; k++) {
    const [a, b, c] = [stripIdx[k], stripIdx[k + 1], stripIdx[k + 2]];
    stripTris.push(k % 2 === 0 ? [a, b, c] : [b, a, c]);
  }

  // FIFO cache states for the concept stream.
  const CACHE = 6;
  const fifoStates: { slots: number[]; hit: boolean }[] = [];
  {
    const q: number[] = [];
    for (const v of listIdx) {
      const hit = q.includes(v);
      if (!hit) {
        q.unshift(v);
        if (q.length > CACHE) q.pop();
      }
      fifoStates.push({ slots: q.slice(), hit });
    }
  }
  const conceptMisses = fifoStates.filter((s) => !s.hit).length;

  // Dots.
  const dots = pos.map((p) => {
    const sp = new Sprite(new SpriteMaterial({ map: tex, color: hdr(COLORS.cyan, 2), transparent: true, depthWrite: false, blending: AdditiveBlending }));
    sp.position.copy(p);
    sp.scale.setScalar(0.16);
    world.add(sp);
    return sp;
  });
  const rings = pos.map((p) => {
    const sp = new Sprite(new SpriteMaterial({ map: tex, color: hdr(COLORS.amber, 2.5), transparent: true, opacity: 0, depthWrite: false, blending: AdditiveBlending }));
    sp.position.copy(p);
    world.add(sp);
    return sp;
  });
  const labels = pos.map((p, i) => {
    const lb = label(String(i), 'cyan');
    lb.position.copy(p).add(new Vector3(0.11, 0.12, 0));
    world.add(lb);
    return lb;
  });

  // Triangles: fill + edge polyline that grows vertex to vertex.
  const makeTri = (ids: [number, number, number], color: number) => {
    const P = ids.map((k) => pos[k]);
    const fill = new Mesh(
      new BufferGeometry().setFromPoints(P),
      new MeshBasicMaterial({ color: hdr(color, 0.9), transparent: true, opacity: 0, side: DoubleSide, depthWrite: false, blending: AdditiveBlending }),
    );
    const lg = new BufferGeometry();
    const lp = new Float32Array(4 * 3);
    lg.setAttribute('position', new BufferAttribute(lp, 3));
    const line = new Line(lg, new LineBasicMaterial({ color: hdr(color, 2.4), transparent: true, opacity: 0 }));
    world.add(fill, line);
    const per = [P[0].distanceTo(P[1]), P[1].distanceTo(P[2]), P[2].distanceTo(P[0])];
    const total = per[0] + per[1] + per[2];
    let lastG = -1;
    return {
      ids,
      fill,
      line,
      /** g: edge growth 0..1, a: overall alpha, flash: extra glow. */
      set(g: number, a: number, flash: number) {
        (fill.material as MeshBasicMaterial).opacity = a * (0.13 + 0.35 * flash);
        (line.material as LineBasicMaterial).opacity = a;
        if (Math.abs(g - lastG) < 1e-4) return;
        lastG = g;
        let len = g * total;
        const out: Vector3[] = [P[0].clone()];
        for (let e = 0; e < 3; e++) {
          const A = P[e];
          const B = P[(e + 1) % 3];
          if (len >= per[e]) {
            out.push(B.clone());
            len -= per[e];
          } else {
            out.push(A.clone().lerp(B, len / per[e]));
            len = 0;
          }
        }
        out.forEach((v, i) => lp.set([v.x, v.y, v.z], i * 3));
        lg.attributes.position.needsUpdate = true;
        lg.computeBoundingSphere();
      },
    };
  };
  const tris = Array.from({ length: NT }, (_, k) => makeTri([listIdx[k * 3], listIdx[k * 3 + 1], listIdx[k * 3 + 2]], k % 2 ? COLORS.magenta : COLORS.violet));
  const sTris = stripTris.map((ids) => makeTri(ids, COLORS.amber));

  /* ---------- HUD ---------- */
  const idxCells = listIdx.map((v, i) => h(`span.iac-cell${i % 3 === 2 ? '.sep' : ''}`, { text: String(v) }));
  const stream = h('div.iac-stream', {}, idxCells);
  const slots = Array.from({ length: CACHE }, () => h('span.iac-slot', { text: '·' }));
  const cacheRow = h('div.iac-cache', {}, [h('span.iac-k', { text: `FIFO ${CACHE}` }), ...slots]);
  const counter = h('div.iac-counter');
  const stripRow = h('div.iac-striprow', {}, [
    h('div', {}, [h('span.iac-k', { text: 'STRIP' }), ...stripIdx.map((v) => h('span.iac-cell.amber', { text: String(v) }))]),
  ]);
  const caption = h('div.iac-caption');
  const hud = h('div.iac-hud', {}, [stream, h('div.iac-row2', {}, [cacheRow, stripRow, counter])]);
  const stageHost = h('div.v-fill');
  host.append(stageHost, hud, caption);

  const P0 = { asm: 0, cache: -1, strip: 0, dim: 0 };
  const view: StageView = {
    scene,
    camera,
    bloom: 1.15,
    bloomThreshold: 0.1,
    orbit: true,
    onFrame: (time) => {
      stars.tick(time);
      world.rotation.y = 0.25 + Math.sin(time * 0.3) * 0.22;
      world.position.y = Math.sin(time * 0.7) * 0.04;
      const cur = Math.floor(P0.asm);
      const pulse = 0.5 + 0.5 * Math.sin(time * 5);
      // Dots: bob a little; light up when part of the current triangle or cache event.
      const cacheI = Math.floor(P0.cache);
      const cacheFrac = P0.cache - cacheI;
      dots.forEach((sp, i) => {
        sp.position.z = pos[i].z + Math.sin(time * 1.3 + i) * 0.03;
        let k = 0.15 + 0.05 * pulse;
        if (P0.asm > 0 && P0.asm < NT) {
          const ids = tris[Math.min(NT - 1, cur)].ids;
          if (ids.includes(i)) k = 0.3 + 0.08 * pulse;
        }
        sp.scale.setScalar(k);
        const ring = rings[i];
        let ro = 0;
        if (cacheI >= 0 && cacheI < listIdx.length && listIdx[cacheI] === i) {
          ro = 1 - cacheFrac;
          (ring.material as SpriteMaterial).color.copy(fifoStates[cacheI].hit ? hdr(COLORS.green, 2.5) : hdr(COLORS.amber, 3));
          ring.scale.setScalar(0.2 + cacheFrac * (fifoStates[cacheI].hit ? 0.3 : 0.75));
        }
        (ring.material as SpriteMaterial).opacity = ro;
        ring.position.z = sp.position.z;
        labels[i].element.style.opacity = P0.strip > 0 && !stripIdx.includes(i) ? '0.3' : '1';
      });
      tris.forEach((tr, k) => {
        const local = clamp01(P0.asm - k);
        const flash = local > 0 && local < 1 ? 1 - local : 0;
        tr.set(Math.min(1, local * 1.6), (local > 0 ? 1 : 0) * (1 - 0.75 * P0.dim), flash);
      });
      sTris.forEach((tr, k) => {
        const local = clamp01(P0.strip - k);
        tr.set(Math.min(1, local * 1.6), local > 0 ? 1 : 0, local > 0 && local < 1 ? 1 - local : 0);
      });
      // HUD: current index cells.
      const asmIdx = P0.asm >= NT ? -1 : cur;
      idxCells.forEach((c, i) => {
        const tri = Math.floor(i / 3);
        c.classList.toggle('done', P0.asm > 0 && tri < cur);
        c.classList.toggle('cur', tri === asmIdx && P0.asm > 0);
        c.classList.toggle('chit', cacheI >= 0 && i <= cacheI && fifoStates[i].hit);
        c.classList.toggle('cmiss', cacheI >= 0 && i <= cacheI && !fifoStates[i].hit);
        c.classList.toggle('ccur', i === cacheI);
      });
      if (cacheI >= 0) {
        const st = fifoStates[Math.min(cacheI, fifoStates.length - 1)];
        slots.forEach((s, i) => {
          s.textContent = st.slots[i] !== undefined ? String(st.slots[i]) : '·';
          s.classList.toggle('new', i === 0 && !st.hit && cacheI < listIdx.length);
        });
        let miss = 0;
        for (let i = 0; i <= Math.min(cacheI, fifoStates.length - 1); i++) if (!fifoStates[i].hit) miss++;
        counter.innerHTML = `VS: <b class="glow-amber">${miss}</b> · ${t(L('index', 'indices'))}: <b>${Math.min(cacheI + 1, listIdx.length)}</b> · ${t(L('träffar', 'hits'))}: <b class="c-idx">${Math.min(cacheI + 1, listIdx.length) - miss}</b>`;
      } else {
        slots.forEach((s) => (s.textContent = '·'));
        counter.innerHTML = `${t(L('trianglar', 'triangles'))}: <b class="glow-magenta">${Math.min(NT, Math.max(0, Math.floor(P0.asm + 0.001)))}</b> / ${NT} · ${t(L('index', 'indices'))}: <b>${Math.min(listIdx.length, Math.max(0, Math.floor(P0.asm + 0.001)) * 3)}</b> / ${listIdx.length}`;
      }
      if (P0.strip > 0) counter.innerHTML = `strip: <b class="glow-amber">${stripIdx.length}</b> ${t(L('index', 'indices'))} → <b>${Math.floor(P0.strip + 0.001)}</b> ${t(L('trianglar', 'triangles'))} · list: ${stripTris.length * 3}`;
    },
  };
  ctx.stage.attach(stageHost, view);

  const captions = [
    L('16 vertices i en buffert – bara ett moln av punkter. Inget säger ännu vilka som hör ihop.', '16 vertices in a buffer – just a cloud of points. Nothing says yet which belong together.'),
    L('Indexen tickar förbi tre åt gången. Varje trippel knäpper ihop tre punkter till en triangel.', 'Indices tick by three at a time. Every triple snaps three points together into a triangle.'),
    L(
      `Delade vertices ligger kvar i cachen: <b class="c-idx">grönt</b> = träff, <b class="glow-amber">orange</b> = vertex shadern körs. ${conceptMisses} VS-anrop för ${listIdx.length} index.`,
      `Shared vertices stay in the cache: <b class="c-idx">green</b> = hit, <b class="glow-amber">orange</b> = the vertex shader runs. ${conceptMisses} VS calls for ${listIdx.length} indices.`,
    ),
    L('Triangle strip: varje nytt index bildar en ny triangel med de två föregående – varannan med omvänd ordning.', 'Triangle strip: each new index forms a new triangle with the previous two – every other one with flipped order.'),
  ];

  let last = -1;
  return {
    show(step, animate) {
      const fwd = animate && step > last;
      last = step;
      caption.innerHTML = t(captions[step]);
      hud.dataset.step = String(step);
      gsap.killTweensOf(P0);
      const target = { asm: step >= 1 ? NT : 0, cache: step === 2 ? listIdx.length : -1, strip: step === 3 ? stripTris.length : 0, dim: step >= 2 ? 1 : 0 };
      if (fwd && step === 1) {
        P0.asm = 0;
        gsap.to(P0, { asm: NT, duration: dur(NT * 0.32), ease: 'none' });
      } else if (fwd && step === 2) {
        P0.cache = 0;
        gsap.to(P0, { dim: 1, duration: dur(0.5) });
        gsap.to(P0, { cache: listIdx.length, duration: dur(listIdx.length * 0.13), ease: 'none' });
      } else if (fwd && step === 3) {
        Object.assign(P0, { cache: -1 });
        gsap.to(P0, { strip: stripTris.length, duration: dur(stripTris.length * 0.55), ease: 'none', delay: dur(0.3) });
      } else Object.assign(P0, target);
      if (fwd) gsap.fromTo(caption, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: dur(0.4) });
      if (fwd && step === 0) gsap.fromTo(dots.map((d) => d.scale), { x: 0, y: 0 }, { x: 0.18, y: 0.18, stagger: 0.04, duration: dur(0.5), ease: 'back.out' });
    },
    destroy() {
      gsap.killTweensOf(P0);
      if (ctx.stage.isAttachedTo(view)) ctx.stage.detach();
      disposeScene(scene);
      tex.dispose();
    },
  };
}

function mulberry(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
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
