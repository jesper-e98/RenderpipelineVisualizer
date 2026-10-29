import gsap from 'gsap';
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Group,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  WireframeGeometry,
  type ShaderMaterial,
} from 'three';
import { dur, escapeHtml, h } from '../core/dom';
import { SHOWCASE_ROT_X, SHOWCASE_ROT_Y } from '../core/derived';
import { L, type Text } from '../core/i18n';
import type { ApiId } from '../core/state';
import type { MeshData } from '../model/types';
import { formatBytes } from '../pipeline/layout';
import { createModelStage, secs, type ModelStage, type Particles } from '../views/ModelStage';
import { COLORS, label } from '../views/three-helpers';
import { stat } from '../views/widgets';
import { standardSlide } from './standard';
import type { ApiPanelSpec, CodeSnippet, SlideContext, Visual } from './types';
import '../styles/slides/parse.css';

/* ------------------------------------------------------------------ */
/* Helpers: number formatting, float bits, hex dump decoding           */
/* ------------------------------------------------------------------ */
const fx = (n: number, d = 4) => (Math.abs(n) < 0.5 * 10 ** -d ? 0 : n).toFixed(d);
const v3 = (v: ArrayLike<number>, d = 4) => `(${Array.from(v, (x) => fx(x, d)).join(', ')})`;

/** Little-endian bytes of a float32, e.g. "cd cc cc 3d". */
function f32hex(x: number): string {
  const b = new Uint8Array(new Float32Array([x]).buffer);
  return Array.from(b, (v) => v.toString(16).padStart(2, '0')).join(' ');
}

/** Bytes recovered from the hex-dump lines of a binary source preview. */
function hexBytes(preview: string[]): Map<number, number> {
  const map = new Map<number, number>();
  for (const line of preview) {
    if (!/^[0-9a-f]{8} {2}/.test(line)) continue;
    const off = parseInt(line.slice(0, 8), 16);
    line
      .slice(10, 57)
      .trim()
      .split(/\s+/)
      .forEach((b, i) => map.set(off + i, parseInt(b, 16)));
  }
  return map;
}

function readBytes(map: Map<number, number>, off: number, n: number): Uint8Array | null {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const b = map.get(off + i);
    if (b === undefined) return null;
    out[i] = b;
  }
  return out;
}
const readF32s = (map: Map<number, number>, off: number, n: number) => {
  const b = readBytes(map, off, n * 4);
  return b ? Array.from(new Float32Array(b.buffer)) : null;
};
const readU32 = (map: Map<number, number>, off: number) => {
  const b = readBytes(map, off, 4);
  return b ? new DataView(b.buffer).getUint32(0, true) : null;
};
const readAscii = (map: Map<number, number>, off: number, n: number) => {
  const b = readBytes(map, off, n);
  return b ? Array.from(b, (c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '.')).join('') : null;
};

type Kind = 'obj' | 'stl-ascii' | 'stl-bin' | 'glb' | 'gltf';
function kindOf(m: MeshData): Kind {
  if (m.format === 'OBJ' || m.format === 'builtin') return 'obj';
  if (m.format === 'STL') return m.sourceIsBinary ? 'stl-bin' : 'stl-ascii';
  return m.format === 'GLB' ? 'glb' : 'gltf';
}

/** CSS class for a byte at `off` in the binary preview (what that byte means). */
function byteClass(kind: Kind, off: number): string {
  if (kind === 'glb') {
    if (off < 4) return 'b-magic';
    if (off < 8) return 'b-ver';
    if (off < 12) return 'b-len';
    if (off < 16) return 'b-clen';
    if (off < 20) return 'b-ctype';
    return 'b-json';
  }
  if (off < 80) return 'b-head';
  if (off < 84) return 'b-len';
  if (off < 96) return 'b-nrm';
  if (off < 132) return ['b-pos', 'b-pos2', 'b-pos'][Math.floor((off - 96) / 12)];
  return 'b-attr';
}

/** Class for a text line of the source (OBJ / STL / JSON). */
function lineClass(kind: Kind, line: string): string {
  const l = line.trimStart();
  if (kind === 'obj') {
    if (l.startsWith('#')) return 'l-com';
    if (l.startsWith('vn ')) return 'c-nrm';
    if (l.startsWith('vt ')) return 'c-uv';
    if (l.startsWith('v ')) return 'c-pos';
    if (l.startsWith('f ')) return 'c-idx';
    if (/^(o|g|s|mtllib|usemtl) /.test(l)) return 'l-meta';
    return '';
  }
  if (kind === 'stl-ascii') {
    if (l.startsWith('facet normal')) return 'c-nrm';
    if (l.startsWith('vertex')) return 'c-pos';
    return 'l-meta';
  }
  if (/"(POSITION|NORMAL|TEXCOORD_0)"/.test(l)) return 'c-pos';
  if (/"(componentType|accessors|bufferViews|byteOffset|count)"/.test(l)) return 'c-uv';
  return '';
}

/* ------------------------------------------------------------------ */
/* What the parser does with the first records of this file            */
/* ------------------------------------------------------------------ */
interface DemoRow {
  src: string;
  out: string; // HTML
  cls: string;
  label: Text;
}
interface Demo {
  rows: DemoRow[];
  lines: number[]; // preview lines to highlight
  note: Text;
}

function parseDemo(m: MeshData): Demo {
  const kind = kindOf(m);
  const pv = m.sourcePreview;
  const rows: DemoRow[] = [];
  const lines: number[] = [];

  if (kind === 'obj') {
    const vec = (tag: string, n: number, cls: string, label: Text) => {
      const i = pv.findIndex((l) => l.startsWith(tag + ' '));
      if (i < 0) return;
      const nums = pv[i].trim().split(/\s+/).slice(1, 1 + n).map(Number);
      const exact = nums.map((x) => Math.fround(x));
      lines.push(i);
      rows.push({
        src: pv[i],
        cls,
        label,
        out:
          `<span class="mono">float${n}</span> ${v3(exact, 4)}` +
          `<div class="pa-bits">${escapeHtml(String(nums[0]))} → float32 <b>${f32hex(nums[0])}</b>${exact[0] !== nums[0] ? ` <span class="pa-dim">= ${exact[0].toPrecision(9)}</span>` : ''}</div>`,
      });
    };
    vec('v', 3, 'c-pos', L('position', 'position'));
    vec('vt', 2, 'c-uv', L('texturkoordinat', 'texture coordinate'));
    vec('vn', 3, 'c-nrm', L('normal', 'normal'));
    const fi = pv.findIndex((l) => l.startsWith('f '));
    if (fi >= 0) {
      lines.push(fi);
      const refs = pv[fi].trim().split(/\s+/).slice(1);
      const parts = refs.map((r) => r.split('/').map((x) => (x === '' ? null : Number(x))));
      const col = (k: number) => parts.map((p) => (p[k] == null ? '–' : p[k]! < 0 ? `${p[k]}` : String(p[k]! - 1)));
      const names = ['pos', 'uv', 'nrm'];
      const has = [0, 1, 2].filter((k) => parts.some((p) => p[k] != null));
      rows.push({
        src: pv[fi],
        cls: 'c-idx',
        label: L(`yta med ${refs.length} hörn`, `face with ${refs.length} corners`),
        out:
          has.map((k) => `<span class="mono">${names[k]}</span> [${col(k).join(', ')}]`).join('<br>') +
          '<div class="pa-bits">%IDX%</div>',
      });
    }
    return {
      rows,
      lines,
      note: L(
        'OBJ är text: varje rad börjar med en tagg. Talen tolkas från decimaltext till 32-bitars float (ofta med en liten avrundning). <code>f</code> pekar på positioner, UV:n och normaler med <i>separata</i> 1-baserade index.',
        'OBJ is text: every line starts with a tag. Numbers are converted from decimal text to 32-bit floats (often with a tiny rounding). <code>f</code> points at positions, UVs and normals with <i>separate</i> 1-based indices.',
      ),
    };
  }

  if (kind === 'stl-ascii') {
    const fi = pv.findIndex((l) => l.trim().startsWith('facet normal'));
    if (fi >= 0) {
      const n = pv[fi].trim().split(/\s+/).slice(2, 5).map(Number);
      lines.push(fi);
      rows.push({ src: pv[fi].trim(), cls: 'c-nrm', label: L('facettnormal', 'facet normal'), out: `<span class="mono">float3</span> ${v3(n.map(Math.fround))}` });
      let c = 0;
      for (let i = fi + 1; i < pv.length && c < 3; i++) {
        if (!pv[i].trim().startsWith('vertex')) continue;
        const p = pv[i].trim().split(/\s+/).slice(1, 4).map(Number);
        lines.push(i);
        rows.push({ src: pv[i].trim(), cls: 'c-pos', label: L(`hörn ${c}`, `corner ${c}`), out: `<span class="mono">float3</span> ${v3(p.map(Math.fround))}` });
        c++;
      }
    }
    return {
      rows,
      lines,
      note: L(
        'ASCII-STL: varje triangel (<code>facet</code>) har en egen normal och tre egna hörn. Inga index – hörn som delas av grannar upprepas.',
        'ASCII STL: every triangle (<code>facet</code>) has its own normal and three corners of its own. No indices – corners shared with neighbours are repeated.',
      ),
    };
  }

  const map = hexBytes(pv);
  if (kind === 'stl-bin') {
    const head = (readAscii(map, 0, 40) ?? '').replace(/\.+$/, '');
    rows.push({ src: 'bytes 0–79', cls: 'b-head', label: L('header (ignoreras)', 'header (ignored)'), out: `<span class="mono pa-dim">${head ? `"${escapeHtml(head)}…"` : '00 00 00 …'}</span>` });
    rows.push({
      src: 'bytes 80–83',
      cls: 'b-len',
      label: L('uint32 antal trianglar', 'uint32 triangle count'),
      out: `<b>${m.triangleCount.toLocaleString('en-US')}</b> <span class="pa-dim">→ 84 + 50 × ${m.triangleCount} = ${(84 + 50 * m.triangleCount).toLocaleString('en-US')} B ${84 + 50 * m.triangleCount === m.fileSize ? '✓' : ''}</span>`,
    });
    const n = readF32s(map, 84, 3);
    if (n) rows.push({ src: 'bytes 84–95', cls: 'b-nrm', label: L('normal, 3 × float32', 'normal, 3 × float32'), out: v3(n) });
    for (let k = 0; k < 3; k++) {
      const p = readF32s(map, 96 + k * 12, 3);
      if (p) rows.push({ src: `bytes ${96 + k * 12}–${107 + k * 12}`, cls: k === 1 ? 'b-pos2' : 'b-pos', label: L(`hörn ${k}, 3 × float32`, `corner ${k}, 3 × float32`), out: v3(p) });
    }
    rows.push({ src: 'bytes 132–133', cls: 'b-attr', label: L('uint16 attribut', 'uint16 attribute'), out: '<span class="pa-dim">%ATTR%</span>' });
    return {
      rows,
      lines: [],
      note: L(
        'Binär STL: 80 bytes header, ett uint32 med antalet trianglar och sedan 50 bytes per triangel – normal + tre hörn som little-endian float32, plus två bytes attribut. Inget att tolka: bytesen <i>är</i> talen.',
        'Binary STL: an 80-byte header, a uint32 triangle count, then 50 bytes per triangle – normal + three corners as little-endian float32, plus two attribute bytes. Nothing to parse: the bytes <i>are</i> the numbers.',
      ),
    };
  }

  if (kind === 'glb') {
    const magic = readAscii(map, 0, 4);
    const ver = readU32(map, 4);
    const len = readU32(map, 8);
    const clen = readU32(map, 12);
    const ctype = readAscii(map, 16, 4);
    rows.push({ src: 'bytes 0–3', cls: 'b-magic', label: L('magic', 'magic'), out: `"${magic}" <span class="pa-dim">0x46546C67</span>` });
    rows.push({ src: 'bytes 4–7', cls: 'b-ver', label: L('version', 'version'), out: String(ver) });
    rows.push({ src: 'bytes 8–11', cls: 'b-len', label: L('total längd', 'total length'), out: `${len?.toLocaleString('en-US')} B ${len === m.fileSize ? '✓' : ''}` });
    rows.push({ src: 'bytes 12–19', cls: 'b-clen', label: L('chunk 0: längd + typ', 'chunk 0: length + type'), out: `${clen?.toLocaleString('en-US')} B · "${ctype}"` });
    rows.push({
      src: `bytes 20–${20 + (clen ?? 0) - 1}`,
      cls: 'b-json',
      label: L('JSON: accessors → bufferViews', 'JSON: accessors → bufferViews'),
      out: '<span class="pa-dim">%BIN%</span>',
    });
    return {
      rows,
      lines: [],
      note: L(
        'GLB = 12 bytes header + en JSON-chunk som beskriver scenen + en BIN-chunk. Varje <code>accessor</code> säger var i BIN-chunken datan ligger (bufferView + byteOffset), typ (5126 = FLOAT) och antal – datan kopieras rakt av, ingen texttolkning.',
        'GLB = a 12-byte header + a JSON chunk describing the scene + a BIN chunk. Each <code>accessor</code> says where in the BIN chunk its data lives (bufferView + byteOffset), the type (5126 = FLOAT) and count – the data is copied as-is, no text parsing.',
      ),
    };
  }

  // glTF (JSON text)
  pv.forEach((l, i) => {
    if (lineClass('gltf', l) && lines.length < 6) lines.push(i);
  });
  rows.push({ src: '"componentType": 5126', cls: 'c-pos', label: L('FLOAT (4 B)', 'FLOAT (4 B)'), out: 'float32' });
  rows.push({ src: '"componentType": 5123', cls: 'c-idx', label: L('UNSIGNED_SHORT (2 B)', 'UNSIGNED_SHORT (2 B)'), out: 'uint16' });
  rows.push({ src: '"componentType": 5125', cls: 'c-idx', label: L('UNSIGNED_INT (4 B)', 'UNSIGNED_INT (4 B)'), out: 'uint32' });
  rows.push({ src: '"type": "VEC3"', cls: 'c-nrm', label: L('3 komponenter', '3 components'), out: 'float3' });
  return {
    rows,
    lines,
    note: L(
      'glTF är JSON som <i>beskriver</i> datan; själva talen ligger binärt i en .bin-fil eller en base64-data-URI. Parsern läser JSON:en, slår upp accessor → bufferView → buffer och kopierar bytesen rakt in i arrayer.',
      'glTF is JSON that <i>describes</i> the data; the numbers themselves are binary, in a .bin file or a base64 data URI. The parser reads the JSON, follows accessor → bufferView → buffer and copies the bytes straight into arrays.',
    ),
  };
}

/* ------------------------------------------------------------------ */
/* The file's first lines as a glowing page in 3D                      */
/* ------------------------------------------------------------------ */
const LINE_HEX: Record<string, string> = { 'c-pos': '#38e1ff', 'c-nrm': '#ff3fd2', 'c-uv': '#ffb547', 'c-idx': '#5cf08f', 'l-com': '#6f78a8', 'l-meta': '#9b7bff' };

function textPage(m: MeshData, width: number) {
  const CW = 1024;
  const CH = 512;
  const c = document.createElement('canvas');
  c.width = CW;
  c.height = CH;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  const kind = kindOf(m);
  const lines = m.sourcePreview.slice(0, 20);
  const lh = Math.min(26, (CH - 24) / Math.max(1, lines.length));
  g.font = `600 ${Math.round(lh * 0.8)}px JetBrains Mono, ui-monospace, monospace`;
  g.textBaseline = 'top';
  lines.forEach((line, i) => {
    g.fillStyle = m.sourceIsBinary ? '#9fdcff' : LINE_HEX[lineClass(kind, line)] ?? '#cfd6ff';
    g.fillText(line.slice(0, 70), 18, 12 + i * lh);
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
    /** n positions on glyph pixels (local plane space), read left → right, top → bottom when `ordered`. */
    sample(n: number, ordered: boolean): Float32Array {
      const out = new Float32Array(n * 3);
      const pairs = lit.length / 2;
      for (let i = 0; i < n; i++) {
        const k = pairs ? (ordered ? Math.floor((i / n) * pairs) : Math.floor(Math.random() * pairs)) * 2 : 0;
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
/* Both modes: the model is built up in 3D as the file is parsed       */
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
function parseVisual(host: HTMLElement, ctx: SlideContext, concept: boolean): Visual {
  const { t } = ctx;
  const m = ctx.state.mesh;
  const kind = kindOf(m);
  const ms = createModelStage(host, ctx, {
    shift: concept ? 0 : -0.19,
    eye: [0, 1.05, 4.5],
    autoRotate: 0,
    bloom: 0.45,
    bloomThreshold: 0.86,
    layers: { solid: 0, wire: 0, points: 0, normals: 0 },
  });
  ms.overlay.classList.add('pa-ms');
  fitWidth(ms, 1.45);
  const u = ms.material.uniforms;
  const v = new Vector3();

  // "Raw" placement before normalization: offset + scaled like the file's own coordinates.
  const inv = 1 / m.normalizeScale;
  const rawScale = Math.min(1.25, Math.max(0.6, inv));
  const cLen = Math.hypot(...m.originalCenter);
  const rawOffset = cLen > 1e-6 ? new Vector3(...m.originalCenter).multiplyScalar(Math.min(0.6, cLen * m.normalizeScale) / cLen) : new Vector3();
  if (rawOffset.length() < 0.05 && Math.abs(rawScale - 1) < 0.05) rawOffset.set(0, 0, 0);
  const norm = { k: 0 }; // 0 = raw file coordinates, 1 = normalized
  const applyNorm = () => {
    ms.pivot.scale.setScalar(rawScale + (1 - rawScale) * norm.k);
    ms.pivot.position.copy(rawOffset).multiplyScalar(1 - norm.k);
  };
  applyNorm();

  /* ---- 3D props ---- */
  const page = textPage(m, 2.6);
  page.mesh.position.set(0, 0.05, 0.6);
  page.mesh.lookAt(ms.camera.position);
  ms.scene.add(page.mesh);
  page.mesh.updateMatrixWorld(true);

  // Step 1: characters → numbers → vertices, in the order the parser emits them.
  const NV = Math.min(2400, m.vertexCount);
  const vstep = m.vertexCount / NV;
  const vHome = new Float32Array(NV * 3);
  for (let i = 0; i < NV; i++) vHome.set(m.positions.subarray(Math.floor(i * vstep) * 3, Math.floor(i * vstep) * 3 + 3), i * 3);
  const read = ms.particles(NV, COLORS.cyan, 0.032, 'model');
  const readMat = read.points.material as ShaderMaterial;
  readMat.uniforms.uArc.value = 0.25;
  if (!concept) {
    // File order: particle i leaves the page and lands at vertex i, one after another.
    const d = read.points.geometry.attributes.aDelay.array as Float32Array;
    for (let i = 0; i < NV; i++) d[i] = (i / NV) * 0.65;
    read.points.geometry.attributes.aDelay.needsUpdate = true;
  }
  const pageInModel = () => {
    ms.pivot.updateMatrixWorld(true);
    const toModel = new Matrix4().copy(ms.pivot.matrixWorld).invert().multiply(page.mesh.matrixWorld);
    const out = page.sample(NV, !concept);
    for (let i = 0; i < NV; i++) v.fromArray(out, i * 3).applyMatrix4(toModel).toArray(out, i * 3);
    return out;
  };

  // Step 2: every triangle corner on its own (pushed out along its face), then welded together.
  const T = m.triangleCount;
  const NC = Math.min(3000, T * 3);
  const cornerFrom = new Float32Array(NC * 3);
  const cornerTo = new Float32Array(NC * 3);
  const P = m.positions;
  const I = m.indices;
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  for (let i = 0; i < NC; i++) {
    const tri = Math.min(T - 1, Math.floor((Math.floor(i / 3) * 3 * T) / NC));
    a.fromArray(P, I[tri * 3] * 3);
    b.fromArray(P, I[tri * 3 + 1] * 3);
    c.fromArray(P, I[tri * 3 + 2] * 3);
    const n = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
    const corner = [a, b, c][i % 3];
    const centroid = a.clone().add(b).add(c).divideScalar(3);
    // Shrunk toward the face centre and pushed out: three separate corners per triangle.
    v.copy(corner).lerp(centroid, 0.25).addScaledVector(n, 0.14).toArray(cornerFrom, i * 3);
    corner.toArray(cornerTo, i * 3);
  }
  const weld = ms.particles(NC, COLORS.amber, 0.03, 'model');
  weld.setTargets(cornerFrom, cornerTo);
  (weld.points.material as ShaderMaterial).uniforms.uArc.value = 0;

  // Step 3: the unit sphere every model is scaled into.
  const gizmo = new Group();
  const sphereMat = new LineBasicMaterial({ color: COLORS.green, transparent: true, opacity: 0, depthWrite: false });
  const ringMat = new MeshBasicMaterial({ color: COLORS.green, transparent: true, opacity: 0, depthWrite: false, blending: AdditiveBlending });
  const axesMat = new LineBasicMaterial({ color: COLORS.amber, transparent: true, opacity: 0, depthWrite: false });
  const ring = new Mesh(new TorusGeometry(1, 0.01, 8, 160), ringMat);
  ring.lookAt(ms.camera.position);
  const axesGeo = new BufferGeometry();
  axesGeo.setAttribute('position', new BufferAttribute(new Float32Array([-1.25, 0, 0, 1.25, 0, 0, 0, -1.25, 0, 0, 1.25, 0, 0, 0, -1.25, 0, 0, 1.25]), 3));
  gizmo.add(new LineSegments(new WireframeGeometry(new SphereGeometry(1, 24, 12)), sphereMat), ring, new LineSegments(axesGeo, axesMat));
  const rLbl = label(t(L('enhetssfär · r = 1 · centrum (0, 0, 0)', 'unit sphere · r = 1 · centre (0, 0, 0)')), 'green');
  rLbl.position.set(0, 1.18, 0);
  gizmo.add(rLbl);
  ms.scene.add(gizmo);
  const gz = { k: 0 };
  const applyGizmo = () => {
    sphereMat.opacity = gz.k * 0.16;
    ringMat.opacity = gz.k * 0.9;
    axesMat.opacity = gz.k * 0.55;
    rLbl.visible = gz.k > 0.5;
  };
  applyGizmo();

  /* ---- panels ---- */
  const demo = parseDemo(m);
  const fileName = `${m.name}.${m.format === 'builtin' ? 'obj' : m.format.toLowerCase()}`;
  const corners = T * 3;
  const reuse = corners / Math.max(1, m.vertexCount);
  const total = m.positions.byteLength + m.normals.byteLength + (m.uvs?.byteLength ?? 0) + m.indices.byteLength;
  const keyStats: HTMLElement[][] = [
    [stat(formatBytes(m.fileSize), t(L('på disk', 'on disk')), 'glow-amber'), stat(m.format === 'builtin' ? 'OBJ' : m.format, m.sourceIsBinary ? 'binary' : 'text', 'glow-cyan')],
    [stat(m.vertexCount.toLocaleString('en-US'), 'vertices', 'glow-cyan'), stat(T.toLocaleString('en-US'), t(L('trianglar', 'triangles')), 'glow-magenta')],
    [stat(corners.toLocaleString('en-US'), t(L('hörn', 'corners'))), stat(m.vertexCount.toLocaleString('en-US'), t(L('unika vertices', 'unique vertices')), 'glow-cyan'), stat(`×${reuse.toFixed(2)}`, t(L('återanvändning', 'reuse')), 'glow-amber')],
    [stat(`×${m.normalizeScale.toPrecision(3)}`, t(L('skala', 'scale')), 'glow-green'), stat(formatBytes(total), t(L('i RAM', 'in RAM')), 'glow-amber')],
  ];
  const keyPanel = ms.panel(t(L('Nyckeltal', 'Key numbers')), [h('div.stat-row.pa-keys')], { side: 'right', className: 'pa-key' });
  const keyRow = keyPanel.querySelector('.pa-keys')!;

  const detail: HTMLElement[] = [];
  let lineEls: HTMLElement[] = [];
  let srcBox: HTMLElement | null = null;
  let caption: Element | null = null;
  if (!concept) {
    // The file as the parser sees it.
    lineEls = m.sourcePreview.map((line) => {
      if (m.sourceIsBinary && /^[0-9a-f]{8} {2}/.test(line)) {
        const off = parseInt(line.slice(0, 8), 16);
        const bytes = line.slice(10, 57).trim().split(/\s+/);
        return h('div.pa-line.hex', {}, [
          h('span.pa-off', { text: line.slice(0, 8) }),
          ...bytes.map((bb, i) => h(`span.pa-b.${byteClass(kind, off + i)}`, { text: bb })),
          h('span.pa-ascii', { text: line.slice(59) }),
        ]);
      }
      return h(`div.pa-line${lineClass(kind, line) ? '.' + lineClass(kind, line) : ''}`, { text: line || ' ' });
    });
    srcBox = h('div.pa-src.v-scroll', {}, lineEls);
    const filePanel = ms.panel(`${fileName} · ${formatBytes(m.fileSize)}`, [srcBox], { side: 'right', className: 'pa-file' });

    const firstLine = m.sourcePreview.find((x) => x.trim().length) ?? '';
    const headBytes = m.sourceIsBinary ? Array.from(readBytes(hexBytes(m.sourcePreview), 0, 16) ?? new Uint8Array()) : Array.from(new TextEncoder().encode(firstLine).slice(0, 16));
    const bytesBody = [
      h('div.pa-bytes', {}, [
        h('div.pa-bytes-row', {}, headBytes.map((x) => h('span.pa-byte', { text: x.toString(16).padStart(2, '0') }))),
        h('div.pa-bytes-row.ascii', {}, headBytes.map((x) => h('span.pa-byte', { text: x >= 32 && x < 127 ? String.fromCharCode(x) : '·' }))),
      ]),
      h('p.pa-note', {
        html: t(
          m.sourceIsBinary
            ? L('Läst med <code>std::ifstream(…, std::ios::binary)</code>. Binära format kan ofta kopieras direkt – siffrorna ligger redan som float32.', 'Read with <code>std::ifstream(…, std::ios::binary)</code>. Binary formats can often be copied directly – the numbers are already float32.')
            : L('Även text är bytes: ett tecken = en byte (ASCII/UTF-8). För GPU:n betyder <code>"0.5"</code> ingenting – texten måste tolkas till tal.', 'Text is bytes too: one character = one byte (ASCII/UTF-8). To a GPU, <code>"0.5"</code> means nothing – the text has to be parsed into numbers.'),
        ),
      }),
    ];
    const parseBody = [
      h(
        'div.pa-demo',
        {},
        demo.rows.map((r) =>
          h('div.pa-row', {}, [
            h(`code.pa-in.${r.cls}`, { text: r.src }),
            h('span.pa-arrow', { text: '→' }),
            h('div.pa-out', {}, [
              h('div.pa-lab', { text: t(r.label) }),
              h('div', {
                html: r.out
                  .replace('%IDX%', t(L('1-baserat i filen → 0-baserat i minnet', '1-based in the file → 0-based in memory')))
                  .replace('%ATTR%', t(L('oftast 0 (ibland färg)', 'usually 0 (sometimes colour)')))
                  .replace('%BIN%', t(L('sedan chunk 1 "BIN\\0" med rå float32-/uint-data', 'then chunk 1 "BIN\\0" with raw float32/uint data'))),
              }),
            ]),
          ]),
        ),
      ),
      h('p.pa-note', { html: t(demo.note) }),
    ];
    const flag = (had: boolean, yes: Text, no: Text, cls: string) => h(`div.pa-flag.${had ? 'yes' : 'gen'}`, {}, [h(`span.${cls}`, { text: had ? '✓' : '✳' }), h('span', { html: t(had ? yes : no) })]);
    const weldBody = [
      h('div.pa-flags', {}, [
        flag(m.had.indices, L('<b>index</b> fanns i filen', '<b>indices</b> were in the file'), L('<b>index</b> skapade genom svetsning: identiska hörn slås ihop', '<b>indices</b> created by welding: identical corners are merged'), 'c-idx'),
        flag(m.had.normals, L('<b>normaler</b> fanns i filen', '<b>normals</b> were in the file'), L('<b>normaler</b> genererade: ytnormaler viktade med area, medel per vertex', '<b>normals</b> generated: area-weighted face normals, averaged per vertex'), 'c-nrm'),
        flag(m.had.uvs, L('<b>UV</b> fanns i filen', '<b>UVs</b> were in the file'), L('<b>UV</b> saknas – vertexen blir 24 B i stället för 32 B', '<b>UVs</b> missing – the vertex becomes 24 B instead of 32 B'), 'c-uv'),
      ]),
      h('div.pa-bars', {}, [
        h('div.pa-bar-row', {}, [h('span.pa-bar-k', { text: t(L('triangelhörn', 'triangle corners')) }), h('div.pa-bar', {}, [h('i', { style: { width: '100%' } })]), h('b.mono', { text: corners.toLocaleString('en-US') })]),
        h('div.pa-bar-row', {}, [
          h('span.pa-bar-k', { text: t(L('unika vertices', 'unique vertices')) }),
          h('div.pa-bar.c', {}, [h('i', { style: { width: `${Math.max(1, Math.min(100, (100 * m.vertexCount) / corners))}%` } })]),
          h('b.mono.glow-cyan', { text: m.vertexCount.toLocaleString('en-US') }),
        ]),
      ]),
      h('p.pa-note', {
        html: t(
          L(
            `Varje vertex används i snitt av <b>${reuse.toFixed(2)}</b> hörn. ${kind === 'obj' ? 'I OBJ blir varje unik kombination (position, UV, normal) en egen vertex.' : kind.startsWith('stl') ? 'STL upprepar delade hörn, så svetsningen sparar mycket.' : 'glTF är redan indexerat som GPU:n vill ha det.'}`,
            `Each vertex is used by <b>${reuse.toFixed(2)}</b> corners on average. ${kind === 'obj' ? 'In OBJ, every unique (position, UV, normal) combination becomes its own vertex.' : kind.startsWith('stl') ? 'STL repeats shared corners, so welding saves a lot.' : 'glTF is already indexed the way the GPU wants it.'}`,
          ),
        ),
      }),
    ];
    const s0 = m.normalizeScale;
    const c0 = m.originalCenter;
    const pN = Array.from(m.positions.subarray(0, 3));
    const pO = pN.map((x, i) => x / s0 + c0[i]);
    const arr = (name: string, type: string, n: number, bytes: number, cls: string) =>
      h('tr', {}, [h(`td.${cls}`, { text: name }), h('td.mono', { text: `${type}(${n.toLocaleString('en-US')})` }), h('td.mono', { text: formatBytes(bytes) })]);
    const normBody = [
      h('div.pa-formula', { html: `p′ = (p − c) · s <br><span class="pa-dim">c = ${v3(c0, 3)}, s = 1/r = ${s0.toPrecision(4)}</span>` }),
      h('div.pa-row.pa-v0', {}, [
        h('code.pa-in.c-pos', { text: `v0 ${v3(pO, 3)}` }),
        h('span.pa-arrow', { text: '→' }),
        h('div.pa-out', {}, [h('div.pa-lab', { text: t(L('i enhetssfären', 'inside the unit sphere')) }), h('div.mono.glow-cyan', { text: v3(pN, 4) })]),
      ]),
      h('table.layout-table.pa-arrays', {}, [
        h('tbody', {}, [
          arr('positions', 'Float32Array', m.positions.length, m.positions.byteLength, 'c-pos'),
          arr('normals', 'Float32Array', m.normals.length, m.normals.byteLength, 'c-nrm'),
          m.uvs ? arr('uvs', 'Float32Array', m.uvs.length, m.uvs.byteLength, 'c-uv') : h('tr', {}, [h('td.c-uv', { text: 'uvs' }), h('td.mono.pa-dim', { text: '—' }), h('td')]),
          arr('indices', 'Uint32Array', m.indices.length, m.indices.byteLength, 'c-idx'),
        ]),
      ]),
    ];
    const titles = [L('1 · Filen är bara bytes', '1 · The file is just bytes'), L('2 · Tolka posterna', '2 · Parse the records'), L('3 · Svetsa och komplettera', '3 · Weld and fill in'), L('4 · Normalisera och packa', '4 · Normalize and pack')];
    [bytesBody, parseBody, weldBody, normBody].forEach((body, i) => detail.push(ms.panel(t(titles[i]), body, { side: 'right', className: 'pa-detail' })));
    detail.push(filePanel);
  } else {
    const cap = ms.panel(t(L('Vad händer', 'What happens')), [h('p.pa-cap')], { side: 'bottom' });
    caption = cap.querySelector('.pa-cap');
  }
  const captions: Text[] = [
    L(`<b>${formatBytes(m.fileSize)}</b> text och bytes – ännu inga tal. Modellen finns bara som tecken.`, `<b>${formatBytes(m.fileSize)}</b> of text and bytes – no numbers yet. The model exists only as characters.`),
    L('Tecknen tolkas till <b>float32</b>: punkterna lämnar texten och hittar sina platser, sedan fylls ytorna i.', 'Characters are parsed into <b>float32</b>: the points leave the text and find their places, then the faces fill in.'),
    L(`Hörn som är identiska <b>svetsas</b> ihop – ${corners.toLocaleString('en-US')} hörn blir ${m.vertexCount.toLocaleString('en-US')} vertices. Normaler <span class="c-nrm">${m.had.normals ? 'från filen' : 'genereras'}</span>.`, `Identical corners are <b>welded</b> – ${corners.toLocaleString('en-US')} corners become ${m.vertexCount.toLocaleString('en-US')} vertices. Normals <span class="c-nrm">${m.had.normals ? 'from the file' : 'are generated'}</span>.`),
    L(`Centrerad och skalad ×${m.normalizeScale.toPrecision(3)} in i <span style="color:var(--green)">enhetssfären</span>.`, `Centered and scaled ×${m.normalizeScale.toPrecision(3)} into the <span style="color:var(--green)">unit sphere</span>.`),
  ];

  /* ---- animation ---- */
  let step = -1;
  let spin = false;
  const timers: gsap.core.Tween[] = [];
  const later = (animate: boolean, s: number, fn: () => void) => {
    if (!animate) fn();
    else timers.push(gsap.delayedCall(dur(s), fn));
  };
  ms.onFrame((time, dt) => {
    if (spin) ms.pivot.rotation.y += dt * 0.25;
    if (step === 0) page.mat.opacity = 0.75 + 0.1 * Math.sin(time * 2.4);
  });
  const uProg = (p: Particles) => (p.points.material as ShaderMaterial).uniforms.uProgress;

  return {
    show(stp, animate) {
      step = stp;
      const S = (s: number) => secs(animate, s);
      timers.splice(0).forEach((x) => x.kill());
      gsap.killTweensOf([...Object.values(u), ...Object.values(ms.layers).map((x) => x.material), page.mat, uProg(read), uProg(weld), norm, gz]);
      u.uSweep.value = 100;
      spin = false;
      if (step < 3) ms.pivot.rotation.set(SHOWCASE_ROT_X, SHOWCASE_ROT_Y, 0);

      // Panels
      keyRow.replaceChildren(...keyStats[step]);
      if (caption) caption.innerHTML = t(captions[step]);
      detail.forEach((el, i) => {
        if (i === 4) {
          el.classList.toggle('collapsed', step >= 2);
          return;
        }
        el.style.display = i === step ? '' : 'none';
      });
      if (srcBox) {
        lineEls.forEach((el, i) => el.classList.toggle('hl', step === 1 && demo.lines.includes(i)));
        srcBox.classList.toggle('dimmed', step === 1 && demo.lines.length > 0);
        if (step === 1 && demo.lines.length) {
          const first = lineEls[demo.lines[0]];
          srcBox.scrollTop = Math.max(0, first.offsetTop - srcBox.offsetTop - 30);
        } else if (step === 0) srcBox.scrollTop = 0;
      }
      if (animate) {
        const cur = concept ? caption?.parentElement : detail[step];
        if (cur) gsap.fromTo(cur, { opacity: 0, x: concept ? 0 : 16 }, { opacity: 1, x: 0, duration: dur(0.4), ease: 'power2.out' });
      }

      // 3D: normalization happens only in the last step.
      if (step < 3) {
        norm.k = 0;
        gz.k = 0;
      }
      applyNorm();
      applyGizmo();
      page.mesh.visible = step <= 1;
      read.points.visible = false;
      weld.points.visible = false;
      ms.drawTriangles(1e9, 0);
      ms.explode(0, 0);
      ms.setMode('shaded', 0, 0);

      if (step === 0) {
        // Only text: the particles ride on the glyphs; the model is a faint promise behind.
        read.setTargets(pageInModel(), vHome);
        read.progress(0, 0);
        read.points.visible = true;
        ms.setMode('ghost', 1, 0);
        ms.setLayer('solid', 0.18, S(0.5));
        ms.setLayer('wire', 0, S(0.4));
        ms.setLayer('points', 0, S(0.4));
        ms.setLayer('normals', 0, S(0.4));
      } else if (step === 1) {
        // Vertices appear in parse order, then the faces fill in, in index order.
        ms.setLayer('normals', 0, S(0.3));
        ms.setLayer('wire', 0, S(0.3));
        const faces = () => {
          ms.setLayer('points', 0.75, S(0.3));
          ms.setLayer('wire', 0.18, S(0.6));
          ms.setLayer('solid', 1, 0);
          if (animate) {
            ms.drawTriangles(0, 0);
            ms.drawTriangles(T, 2.4);
          }
        };
        if (animate) {
          ms.setLayer('solid', 0, 0);
          ms.setLayer('points', 0, 0);
          read.setTargets(pageInModel(), vHome);
          read.points.visible = true;
          read.progress(0, 0);
          read.progress(1, 3.2);
          ms.tween(page.mat, { opacity: 0.08, duration: dur(2.8), ease: 'power1.in' });
          later(true, 3.3, () => {
            read.points.visible = false;
            faces();
          });
        } else {
          page.mat.opacity = 0.08;
          faces();
        }
      } else if (step === 2) {
        // Weld: every triangle's own corners slide together into shared vertices.
        ms.setLayer('solid', 0.9, S(0.4));
        ms.setLayer('wire', 0.25, S(0.4));
        ms.setLayer('points', animate ? 0 : 0.8, S(0.3));
        ms.setLayer('normals', 0.75, S(1.2));
        weld.points.visible = animate;
        weld.progress(0, 0);
        if (animate) {
          ms.explode(0.14, 0);
          ms.explode(0, 2.2);
          weld.progress(1, 2.2);
          later(true, 2.4, () => {
            weld.points.visible = false;
            ms.setLayer('points', 0.8, 0.4);
          });
        }
      } else {
        // Normalize: centre on the origin and scale into the unit sphere.
        ms.setLayer('solid', 1, S(0.5));
        ms.setLayer('wire', 0.08, S(0.5));
        ms.setLayer('points', 0.25, S(0.5));
        ms.setLayer('normals', 0, S(0.5));
        if (animate) {
          ms.tween(norm, { k: 1, duration: dur(1.8), ease: 'power2.inOut', onUpdate: applyNorm });
          ms.tween(gz, { k: 1, duration: dur(1.0), onUpdate: applyGizmo });
        } else {
          norm.k = 1;
          gz.k = 1;
          applyNorm();
          applyGizmo();
        }
        spin = concept;
      }
    },
    destroy() {
      timers.forEach((x) => x.kill());
      gsap.killTweensOf([...detail, caption?.parentElement ?? {}]);
      page.tex.dispose();
      ms.destroy();
    },
  };
}

/* ------------------------------------------------------------------ */
/* API panel: parsing is the same no matter which API comes next       */
/* ------------------------------------------------------------------ */
type Line = [string, ...number[]];
function snippet(lang: CodeSnippet['lang'], lines: Line[], steps: number, title?: Text): CodeSnippet {
  const highlight = Array.from({ length: steps }, (_, st) => lines.flatMap(([, ...on], i) => (on.includes(st) ? [i + 1] : [])));
  return { lang, title, src: lines.map((l) => l[0]).join('\n'), highlight };
}

function parserLines(m: MeshData, next: string): Line[] {
  const kind = kindOf(m);
  const file = `${m.name}.${m.format === 'builtin' ? 'obj' : m.format.toLowerCase()}`;
  const s0 = m.normalizeScale.toPrecision(4);
  const tail: Line[] = [
    ['// weld: one vertex per unique corner → index buffer', 2],
    ['std::unordered_map<Corner, uint32_t, CornerHash> unique;', 2],
    ['for (const Corner& c : corners) {', 2],
    ['    auto [it, isNew] = unique.try_emplace(c, uint32_t(vertices.size()));', 2],
    ['    if (isNew) vertices.push_back(makeVertex(c));', 2],
    ['    indices.push_back(it->second);', 2],
    ['}'],
    [m.had.normals ? '// normals came from the file' : 'computeSmoothNormals(vertices, indices);  // none in file', 2],
    [`for (Vertex& v : vertices) v.pos = (v.pos - center) * ${s0}f; // 1/radius`, 3],
    [`// next: ${next}(vertices.data(), …)`, 3],
  ];
  if (kind === 'obj') {
    return [
      [`std::ifstream file("${file}");`, 0],
      ['std::vector<float3> pos, nrm;  std::vector<float2> uv;  std::vector<Corner> corners;'],
      ['for (std::string line; std::getline(file, line); ) {', 0],
      ['    std::istringstream in(line);  std::string tag;  in >> tag;', 1],
      ['    if      (tag == "v")  { float3 p; in >> p.x >> p.y >> p.z; pos.push_back(p); }', 1],
      ['    else if (tag == "vt") { float2 t; in >> t.x >> t.y;        uv.push_back(t);  }', 1],
      ['    else if (tag == "vn") { float3 n; in >> n.x >> n.y >> n.z; nrm.push_back(n); }', 1],
      ['    else if (tag == "f") {                          // "p/t/n" per corner', 1],
      ['        std::vector<Corner> face;', 1],
      ['        for (std::string ref; in >> ref; ) face.push_back(parseRef(ref)); // 1-based → 0-based', 1],
      ['        for (size_t k = 1; k + 1 < face.size(); ++k)  // fan-triangulate', 1],
      ['            corners.insert(corners.end(), { face[0], face[k], face[k + 1] });', 1],
      ['    }'],
      ['}'],
      ...tail,
    ];
  }
  if (kind === 'stl-bin') {
    return [
      [`std::ifstream file("${file}", std::ios::binary);`, 0],
      ['char header[80];    file.read(header, 80);                 // ignored', 0, 1],
      [`uint32_t count;     file.read((char*)&count, 4);           // ${m.triangleCount}`, 1],
      ['std::vector<Corner> corners;'],
      ['for (uint32_t i = 0; i < count; ++i) {', 1],
      ['    float rec[12];  uint16_t attr;    // 50 B on disk: no struct (padding!)', 1],
      ['    file.read((char*)rec, 48);  file.read((char*)&attr, 2);  // little-endian', 1],
      ['    for (int k = 0; k < 3; ++k)', 1],
      ['        corners.push_back({ float3{ rec[3 + 3*k], rec[4 + 3*k], rec[5 + 3*k] } });', 1],
      ['}'],
      ...tail,
    ];
  }
  if (kind === 'stl-ascii') {
    return [
      [`std::ifstream file("${file}");`, 0],
      ['std::vector<Corner> corners;'],
      ['for (std::string tok; file >> tok; ) {', 0, 1],
      ['    if (tok == "vertex") {             // "vertex x y z"', 1],
      ['        float3 p;  file >> p.x >> p.y >> p.z;', 1],
      ['        corners.push_back({ p });', 1],
      ['    }                                  // facet normal / loop: skipped', 1],
      ['}'],
      ...tail,
    ];
  }
  return [
    ['cgltf_options opts{};  cgltf_data* data = nullptr;'],
    [`cgltf_parse_file(&opts, "${file}", &data);    // JSON (+ GLB chunk headers)`, 0, 1],
    [`cgltf_load_buffers(&opts, data, "${file}");   // BIN chunk / .bin / data: URI`, 0, 1],
    ['for (cgltf_size i = 0; i < data->meshes_count; ++i)', 1],
    ['  for (cgltf_size j = 0; j < data->meshes[i].primitives_count; ++j) {', 1],
    ['    const cgltf_primitive& prim = data->meshes[i].primitives[j];', 1],
    ['    for (cgltf_size a = 0; a < prim.attributes_count; ++a) {', 1],
    ['      const cgltf_attribute& at = prim.attributes[a];', 1],
    ['      if (at.type == cgltf_attribute_type_position) {   // FLOAT VEC3', 1],
    ['        pos.resize(at.data->count);', 1],
    ['        cgltf_accessor_unpack_floats(at.data, &pos[0].x, at.data->count * 3);', 1],
    ['      }                               // NORMAL, TEXCOORD_0: the same way', 1],
    ['    }'],
    ['    for (cgltf_size k = 0; k < prim.indices->count; ++k)', 1],
    ['      indices.push_back(uint32_t(cgltf_accessor_read_index(prim.indices, k)));', 1],
    ['  }'],
    ['cgltf_free(data);   // + apply each node\'s world matrix (cgltf_node_transform_world)'],
    [m.had.normals ? '// normals came from the file' : 'computeSmoothNormals(vertices, indices);  // none in file', 2],
    [`for (Vertex& v : vertices) v.pos = (v.pos - center) * ${s0}f; // 1/radius`, 3],
    [`// next: ${next}(vertices.data(), …)`, 3],
  ];
}

function apis(ctx: SlideContext): Record<ApiId, ApiPanelSpec> {
  const m = ctx.state.mesh;
  const kind = kindOf(m);
  const lib = kind === 'glb' || kind === 'gltf' ? 'cgltf' : L('egen parser', 'hand-written parser');
  const terms = [
    { term: kind === 'obj' ? '1-based index' : kind.startsWith('stl') ? 'little-endian' : 'accessor', desc: kind === 'obj' ? L('OBJ räknar från 1; i minnet räknar vi från 0.', 'OBJ counts from 1; in memory we count from 0.') : kind.startsWith('stl') ? L('Minst signifikanta byte först – samma som x86, ARM och GPU:er.', 'Least significant byte first – same as x86, ARM and GPUs.') : L('Beskriver typ, antal och position för en array i en buffer.', 'Describes type, count and location of an array inside a buffer.') },
    { term: 'weld', desc: L('Slå ihop identiska hörn till en vertex och ersätt dem med index.', 'Merge identical corners into one vertex and refer to it by index.') },
    { term: 'float32', desc: L('IEEE-754 med 24 bitars mantissa ≈ 7 decimala siffror.', 'IEEE 754 with a 24-bit mantissa ≈ 7 decimal digits.') },
    { term: 'normalize', desc: L('Flytta till origo och skala in i enhetssfären så att kameran passar alla modeller.', 'Move to the origin and scale into the unit sphere so one camera fits every model.') },
  ];
  const note = (api: string) =>
    L(
      `Parsningen är ren C++ på CPU:n – ${api} är inte inblandat än, så koden är densamma för alla tre API:erna. Här: ${typeof lib === 'string' ? lib : lib.sv}. Först när arrayerna är klara tar API:t över (nästa bilder).`,
      `Parsing is plain C++ on the CPU – ${api} is not involved yet, so the code is the same for all three APIs. Here: ${typeof lib === 'string' ? lib : lib.en}. Only once the arrays are ready does the API take over (next slides).`,
    );
  const mk = (api: string, next: string): ApiPanelSpec => ({
    note: note(api),
    code: [snippet('cpp', parserLines(m, next), 4, L('Ladda modell', 'Load model'))],
    terms,
    you: L('läser, tolkar, svetsar, normaliserar', 'read, parse, weld, normalize'),
  });
  return {
    opengl: mk('OpenGL', 'glNamedBufferStorage'),
    vulkan: mk('Vulkan', 'memcpy into a staging VkBuffer'),
    d3d12: mk('D3D12', 'memcpy into an UPLOAD-heap resource'),
  };
}

export default standardSlide({
  id: 'parse',
  group: 'cpu',
  short: L('Fil → CPU', 'File → CPU'),
  title: L('Fil → CPU – läsa och tolka modellen', 'File → CPU – reading and parsing the model'),
  lead: L(
    'Innan något API är inblandat måste programmet läsa filen och göra om text eller råa bytes till arrayer av tal som GPU:n kan förstå.',
    'Before any API is involved, the program has to read the file and turn text or raw bytes into arrays of numbers the GPU can understand.',
  ),
  bullets: [
    L('Filen läses in i RAM som en lång rad <b>bytes</b>. Text (OBJ, glTF, ASCII-STL) eller binärt (GLB, binär STL) – för datorn är allt bytes.', 'The file is read into RAM as one long run of <b>bytes</b>. Text (OBJ, glTF, ASCII STL) or binary (GLB, binary STL) – to the computer it is all bytes.'),
    L('Parsern tolkar posterna: <code>v x y z</code> blir tre float32, <code>f a/b/c</code> blir index. Binära format läses med fasta offset – headern säger var datan finns.', 'The parser interprets the records: <code>v x y z</code> becomes three float32s, <code>f a/b/c</code> becomes indices. Binary formats are read at fixed offsets – the header says where the data is.'),
    L('Identiska hörn <b>svetsas</b> ihop till en vertex med index. Saknas normaler genereras de från ytornas riktning.', 'Identical corners are <b>welded</b> into one vertex with an index. Missing normals are generated from the faces\' orientation.'),
    L('Modellen <b>normaliseras</b> – centreras och skalas in i enhetssfären – och hamnar i tätt packade <code>Float32Array</code> och <code>Uint32Array</code>.', 'The model is <b>normalized</b> – centered and scaled into the unit sphere – and ends up in tightly packed <code>Float32Array</code> and <code>Uint32Array</code>.'),
  ],
  api: apis,
  data: (host, ctx) => parseVisual(host, ctx, false),
  concept: (host, ctx) => parseVisual(host, ctx, true),
});
