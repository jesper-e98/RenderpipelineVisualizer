import gsap from 'gsap';
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  Group,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Points,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  WireframeGeometry,
} from 'three';
import { dur, escapeHtml, h } from '../core/dom';
import { SHOWCASE_ROT_X, SHOWCASE_ROT_Y } from '../core/derived';
import { L, type Text } from '../core/i18n';
import type { ApiId } from '../core/state';
import type { MeshData } from '../model/types';
import { formatBytes } from '../pipeline/layout';
import { COLORS, disposeScene, makeScene, starfield } from '../views/three-helpers';
import { card, stat } from '../views/widgets';
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
          `<div class="ps-bits">${escapeHtml(String(nums[0]))} → float32 <b>${f32hex(nums[0])}</b>${exact[0] !== nums[0] ? ` <span class="ps-dim">= ${exact[0].toPrecision(9)}</span>` : ''}</div>`,
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
          '<div class="ps-bits">%IDX%</div>',
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
    const head = readAscii(map, 0, 40);
    rows.push({ src: 'bytes 0–79', cls: 'b-head', label: L('header (ignoreras)', 'header (ignored)'), out: `<span class="mono ps-dim">"${escapeHtml((head ?? '').replace(/\.+$/, ''))}…"</span>` });
    rows.push({
      src: 'bytes 80–83',
      cls: 'b-len',
      label: L('uint32 antal trianglar', 'uint32 triangle count'),
      out: `<b>${m.triangleCount.toLocaleString('en-US')}</b> <span class="ps-dim">→ 84 + 50 × ${m.triangleCount} = ${(84 + 50 * m.triangleCount).toLocaleString('en-US')} B ${84 + 50 * m.triangleCount === m.fileSize ? '✓' : ''}</span>`,
    });
    const n = readF32s(map, 84, 3);
    if (n) rows.push({ src: 'bytes 84–95', cls: 'b-nrm', label: L('normal, 3 × float32', 'normal, 3 × float32'), out: v3(n) });
    for (let k = 0; k < 3; k++) {
      const p = readF32s(map, 96 + k * 12, 3);
      if (p) rows.push({ src: `bytes ${96 + k * 12}–${107 + k * 12}`, cls: k === 1 ? 'b-pos2' : 'b-pos', label: L(`hörn ${k}, 3 × float32`, `corner ${k}, 3 × float32`), out: v3(p) });
    }
    rows.push({ src: 'bytes 132–133', cls: 'b-attr', label: L('uint16 attribut', 'uint16 attribute'), out: '<span class="ps-dim">%ATTR%</span>' });
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
    rows.push({ src: 'bytes 0–3', cls: 'b-magic', label: L('magic', 'magic'), out: `"${magic}" <span class="ps-dim">0x46546C67</span>` });
    rows.push({ src: 'bytes 4–7', cls: 'b-ver', label: L('version', 'version'), out: String(ver) });
    rows.push({ src: 'bytes 8–11', cls: 'b-len', label: L('total längd', 'total length'), out: `${len?.toLocaleString('en-US')} B ${len === m.fileSize ? '✓' : ''}` });
    rows.push({ src: 'bytes 12–19', cls: 'b-clen', label: L('chunk 0: längd + typ', 'chunk 0: length + type'), out: `${clen?.toLocaleString('en-US')} B · "${ctype}"` });
    rows.push({
      src: `bytes 20–${20 + (clen ?? 0) - 1}`,
      cls: 'b-json',
      label: L('JSON: accessors → bufferViews', 'JSON: accessors → bufferViews'),
      out: '<span class="ps-dim">%BIN%</span>',
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
/* Real data                                                           */
/* ------------------------------------------------------------------ */
function dataVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const m = ctx.state.mesh;
  const kind = kindOf(m);
  const demo = parseDemo(m);
  const fileName = `${m.name}.${m.format === 'builtin' ? 'obj' : m.format.toLowerCase()}`;

  // ---- Left: the file as the parser sees it ----
  const lineEls = m.sourcePreview.map((line) => {
    if (m.sourceIsBinary && /^[0-9a-f]{8} {2}/.test(line)) {
      const off = parseInt(line.slice(0, 8), 16);
      const bytes = line.slice(10, 57).trim().split(/\s+/);
      return h('div.ps-line.hex', {}, [
        h('span.ps-off', { text: line.slice(0, 8) }),
        ...bytes.map((b, i) => h(`span.ps-b.${byteClass(kind, off + i)}`, { text: b })),
        h('span.ps-ascii', { text: line.slice(59) }),
      ]);
    }
    return h(`div.ps-line${lineClass(kind, line) ? '.' + lineClass(kind, line) : ''}`, { text: line || ' ' });
  });
  const srcBox = h('div.ps-src.v-scroll', {}, lineEls);
  const left = h('div.card.ps-file', {}, [
    h('div.ps-file-head', {}, [
      h('span.ps-file-name', { text: fileName }),
      h('span.ps-chip', { text: m.sourceIsBinary ? 'binary' : 'text' }),
      h('span.ps-chip', { text: formatBytes(m.fileSize) }),
    ]),
    srcBox,
  ]);

  // ---- Right: one card per step ----
  const firstLine = m.sourcePreview.find((l) => l.trim().length) ?? '';
  const headBytes = m.sourceIsBinary
    ? Array.from(readBytes(hexBytes(m.sourcePreview), 0, 16) ?? new Uint8Array())
    : Array.from(new TextEncoder().encode(firstLine).slice(0, 16));
  const bytesCard = card(t(L('1 · Filen är bara bytes', '1 · The file is just bytes')), [
    h('div.stat-row', {}, [
      stat(formatBytes(m.fileSize), t(L('på disk', 'on disk')), 'glow-amber'),
      stat(m.format === 'builtin' ? 'OBJ' : m.format, t(L('format', 'format')), 'glow-cyan'),
      stat(m.sourceIsBinary ? 'binary' : 'UTF-8', t(L('kodning', 'encoding'))),
    ]),
    h('div.ps-bytes', {}, [
      h('div.ps-bytes-row', {}, headBytes.map((b) => h('span.ps-byte', { text: b.toString(16).padStart(2, '0') }))),
      h('div.ps-bytes-row.ascii', {}, headBytes.map((b) => h('span.ps-byte', { text: b >= 32 && b < 127 ? String.fromCharCode(b) : '·' }))),
    ]),
    h('p.ps-note', {
      html: t(
        m.sourceIsBinary
          ? L('Läst med <code>std::ifstream(…, std::ios::binary)</code> eller <code>fread</code>. Binära format kan ofta kopieras direkt – siffrorna ligger redan som float32.', 'Read with <code>std::ifstream(…, std::ios::binary)</code> or <code>fread</code>. Binary formats can often be copied directly – the numbers are already float32.')
          : L('Även text är bytes: varje tecken är en byte (ASCII/UTF-8). För GPU:n betyder <code>"0.5"</code> ingenting – texten måste tolkas till riktiga tal.', 'Text is bytes too: each character is one byte (ASCII/UTF-8). To a GPU, <code>"0.5"</code> means nothing – the text has to be parsed into real numbers.'),
      ),
    }),
  ]);

  const parseCard = card(t(L('2 · Tolka posterna', '2 · Parse the records')), [
    h(
      'div.ps-demo.v-scroll',
      {},
      demo.rows.map((r) =>
        h('div.ps-row', {}, [
          h(`code.ps-in.${r.cls}`, { text: r.src }),
          h('span.ps-arrow', { text: '→' }),
          h('div.ps-out', {}, [
            h('div.ps-lab', { text: t(r.label) }),
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
    h('p.ps-note', { html: t(demo.note) }),
  ]);

  const corners = m.triangleCount * 3;
  const reuse = corners / Math.max(1, m.vertexCount);
  const flag = (had: boolean, yes: Text, no: Text, cls: string) =>
    h(`div.ps-flag.${had ? 'yes' : 'gen'}`, {}, [h(`span.${cls}`, { text: had ? '✓' : '✳' }), h('span', { html: t(had ? yes : no) })]);
  const weldCard = card(t(L('3 · Svetsa och komplettera', '3 · Weld and fill in')), [
    h('div.ps-flags', {}, [
      flag(m.had.indices, L('<b>index</b> fanns i filen', '<b>indices</b> were in the file'), L('<b>index</b> skapade genom svetsning: identiska hörn slås ihop (tolerans 1e-5)', '<b>indices</b> created by welding: identical corners are merged (tolerance 1e-5)'), 'c-idx'),
      flag(m.had.normals, L('<b>normaler</b> fanns i filen', '<b>normals</b> were in the file'), L('<b>normaler</b> genererade: ytnormaler viktade med area, medelvärde per vertex', '<b>normals</b> generated: face normals weighted by area, averaged per vertex'), 'c-nrm'),
      flag(m.had.uvs, L('<b>UV</b> fanns i filen', '<b>UVs</b> were in the file'), L('<b>UV</b> saknas – vertexen blir 24 B i stället för 32 B', '<b>UVs</b> missing – the vertex becomes 24 B instead of 32 B'), 'c-uv'),
    ]),
    h('div.ps-bars', {}, [
      h('div.ps-bar-row', {}, [h('span.ps-bar-k', { text: t(L('triangelhörn', 'triangle corners')) }), h('div.ps-bar', {}, [h('i', { style: { width: '100%' } })]), h('b.mono', { text: corners.toLocaleString('en-US') })]),
      h('div.ps-bar-row', {}, [
        h('span.ps-bar-k', { text: t(L('unika vertices', 'unique vertices')) }),
        h('div.ps-bar.c', {}, [h('i', { style: { width: `${Math.max(1, Math.min(100, (100 * m.vertexCount) / corners))}%` } })]),
        h('b.mono.glow-cyan', { text: m.vertexCount.toLocaleString('en-US') }),
      ]),
    ]),
    h('p.ps-note', {
      html: t(
        L(
          `Varje vertex används i snitt av <b>${reuse.toFixed(2)}</b> triangelhörn. ${kind === 'obj' ? 'I OBJ blir varje unik kombination (position, UV, normal) en egen vertex.' : kind === 'stl-ascii' || kind === 'stl-bin' ? 'STL upprepar delade hörn, så svetsningen sparar mycket.' : 'glTF är redan indexerat på samma sätt som GPU:n vill ha det.'}`,
          `Each vertex is used by <b>${reuse.toFixed(2)}</b> triangle corners on average. ${kind === 'obj' ? 'In OBJ, every unique (position, UV, normal) combination becomes its own vertex.' : kind === 'stl-ascii' || kind === 'stl-bin' ? 'STL repeats shared corners, so welding saves a lot.' : 'glTF is already indexed the way the GPU wants it.'}`,
        ),
      ),
    }),
  ]);

  const s0 = m.normalizeScale;
  const c0 = m.originalCenter;
  const pN = Array.from(m.positions.subarray(0, 3));
  const pO = pN.map((x, i) => x / s0 + c0[i]);
  const arr = (name: string, type: string, n: number, bytes: number, cls: string) =>
    h('tr', {}, [h(`td.${cls}`, { text: name }), h('td.mono', { text: `${type}(${n.toLocaleString('en-US')})` }), h('td.mono', { text: formatBytes(bytes) })]);
  const total = m.positions.byteLength + m.normals.byteLength + (m.uvs?.byteLength ?? 0) + m.indices.byteLength;
  const normCard = card(t(L('4 · Normalisera och packa i arrayer', '4 · Normalize and pack into arrays')), [
    h('div.ps-formula', {
      html: `p′ = (p − c) · s &nbsp; <span class="ps-dim">c = ${v3(c0, 3)}, s = 1 / r = ${s0.toPrecision(4)}</span>`,
    }),
    h('div.ps-row.ps-v0', {}, [
      h('code.ps-in.c-pos', { text: `v0 ${v3(pO, 3)}` }),
      h('span.ps-arrow', { text: '→' }),
      h('div.ps-out', {}, [h('div.ps-lab', { text: t(L('i enhetssfären', 'inside the unit sphere')) }), h('div.mono.glow-cyan', { text: v3(pN, 4) })]),
    ]),
    h('table.layout-table.ps-arrays', {}, [
      h('tbody', {}, [
        arr('positions', 'Float32Array', m.positions.length, m.positions.byteLength, 'c-pos'),
        arr('normals', 'Float32Array', m.normals.length, m.normals.byteLength, 'c-nrm'),
        m.uvs ? arr('uvs', 'Float32Array', m.uvs.length, m.uvs.byteLength, 'c-uv') : h('tr', {}, [h('td.c-uv', { text: 'uvs' }), h('td.mono.ps-dim', { text: '—' }), h('td')]),
        arr('indices', 'Uint32Array', m.indices.length, m.indices.byteLength, 'c-idx'),
        h('tr.ps-total', {}, [h('td', { text: t(L('totalt i RAM', 'total in RAM')) }), h('td'), h('td.mono.glow-amber', { text: formatBytes(total) })]),
      ]),
    ]),
  ]);

  const cards = [bytesCard, parseCard, weldCard, normCard];
  const right = h('div.ps-right', {}, cards);
  const grid = h('div.ps-grid', {}, [left, right]);
  host.append(grid);

  return {
    show(step, animate) {
      cards.forEach((c, i) => (c.style.display = i === step ? '' : 'none'));
      lineEls.forEach((el, i) => el.classList.toggle('hl', step === 1 && demo.lines.includes(i)));
      srcBox.classList.toggle('dimmed', step === 1 && demo.lines.length > 0);
      left.classList.toggle('faded', step >= 2);
      if (step === 1 && demo.lines.length) {
        const first = lineEls[demo.lines[0]];
        srcBox.scrollTo({ top: Math.max(0, first.offsetTop - srcBox.offsetTop - 40), behavior: animate ? 'smooth' : 'auto' });
      } else if (step === 0) srcBox.scrollTop = 0;
      if (!animate) return;
      const c = cards[step];
      gsap.fromTo(c, { opacity: 0, x: 24 }, { opacity: 1, x: 0, duration: dur(0.45), ease: 'power2.out' });
      if (step === 0) gsap.from(c.querySelectorAll('.ps-byte'), { opacity: 0, y: -10, stagger: 0.02, duration: dur(0.3) });
      if (step === 1) gsap.from(c.querySelectorAll('.ps-row'), { opacity: 0, x: -16, stagger: 0.09, duration: dur(0.35), delay: dur(0.1) });
      if (step === 2) {
        gsap.from(c.querySelectorAll('.ps-flag'), { opacity: 0, y: 8, stagger: 0.1, duration: dur(0.3) });
        gsap.from(c.querySelectorAll('.ps-bar i'), { width: 0, duration: dur(0.9), ease: 'power3.out', stagger: 0.25 });
      }
      if (step === 3) gsap.from(c.querySelectorAll('tr'), { opacity: 0, x: 12, stagger: 0.06, duration: dur(0.3) });
    },
    destroy() {
      gsap.killTweensOf(cards);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Concept: characters melt into points that assemble into the model   */
/* ------------------------------------------------------------------ */
const PARTICLE_VS = /* glsl */ `
attribute vec3 aStart;
attribute vec3 aEnd;
attribute vec3 aColor;
attribute float aDelay;
uniform float uMix;
uniform float uTime;
uniform float uSize;
uniform float uDim;
uniform mat4 uEnd;
varying vec3 vColor;
varying float vAlpha;
void main() {
  float k = clamp((uMix * 1.5 - aDelay * 0.5), 0.0, 1.0);
  float e = k * k * (3.0 - 2.0 * k);
  vec3 endW = (uEnd * vec4(aEnd, 1.0)).xyz;
  vec3 p = mix(aStart, endW, e);
  // swirl while in flight
  float arc = sin(e * 3.14159);
  p += vec3(sin(aDelay * 40.0 + uTime) * 0.5, cos(aDelay * 23.0) * 0.6, 0.9) * arc * (0.35 + aDelay * 0.4);
  p += vec3(sin(uTime * 2.0 + aDelay * 90.0), cos(uTime * 1.7 + aDelay * 60.0), 0.0) * 0.006;
  vec3 endColor = mix(vec3(0.22, 0.88, 1.0), vec3(1.0, 0.25, 0.82), clamp(aEnd.y * 0.5 + 0.5, 0.0, 1.0));
  vColor = mix(aColor, endColor, e) * (1.0 + arc * 0.8);
  vAlpha = mix(1.0, uDim, e);
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_PointSize = uSize * (1.0 + arc * 1.5) * (3.2 / -mv.z);
  gl_Position = projectionMatrix * mv;
}`;
const PARTICLE_FS = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d);
  if (r > 0.5) discard;
  float a = smoothstep(0.5, 0.0, r);
  gl_FragColor = vec4(vColor * a, a * vAlpha);
}`;

/** Area-weighted random points on the mesh surface (plus every vertex if there are few). */
function surfaceSamples(m: MeshData, n: number): Float32Array {
  const P = m.positions;
  const I = m.indices;
  const T = m.triangleCount;
  const cdf = new Float64Array(T);
  let acc = 0;
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  for (let t = 0; t < T; t++) {
    a.fromArray(P, I[t * 3] * 3);
    b.fromArray(P, I[t * 3 + 1] * 3).sub(a);
    c.fromArray(P, I[t * 3 + 2] * 3).sub(a);
    acc += b.cross(c).length();
    cdf[t] = acc;
  }
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    if (i < Math.min(m.vertexCount, n / 3)) {
      out.set(P.subarray(i * 3, i * 3 + 3), i * 3);
      continue;
    }
    const r = Math.random() * acc;
    let lo = 0;
    let hi = T - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    const t = lo;
    let u = Math.random();
    let v = Math.random();
    if (u + v > 1) {
      u = 1 - u;
      v = 1 - v;
    }
    for (let k = 0; k < 3; k++) {
      const p0 = P[I[t * 3] * 3 + k];
      out[i * 3 + k] = p0 + (P[I[t * 3 + 1] * 3 + k] - p0) * u + (P[I[t * 3 + 2] * 3 + k] - p0) * v;
    }
  }
  return out;
}

function conceptVisual(host: HTMLElement, ctx: SlideContext): Visual {
  const { t } = ctx;
  const m = ctx.state.mesh;
  const { scene, camera } = makeScene();
  const stars = starfield(600);
  scene.add(stars);

  // ---- The "page": the file's own text, drawn into a texture ----
  const CW = 1024;
  const CH = 512;
  const page = document.createElement('canvas');
  page.width = CW;
  page.height = CH;
  const pg = page.getContext('2d')!;
  const kind = kindOf(m);
  const src = m.sourcePreview.slice(0, 22);
  const lh = Math.min(26, (CH - 30) / src.length);
  pg.font = `600 ${Math.round(lh * 0.78)}px JetBrains Mono, ui-monospace, monospace`;
  pg.textBaseline = 'top';
  const colorOf = (line: string) => {
    if (m.sourceIsBinary) return '#9fdcff';
    const c = lineClass(kind, line);
    return { 'c-pos': '#38e1ff', 'c-nrm': '#ff3fd2', 'c-uv': '#ffb547', 'c-idx': '#5cf08f', 'l-com': '#6f78a8', 'l-meta': '#9b7bff' }[c] ?? '#cfd6ff';
  };
  src.forEach((line, i) => {
    pg.fillStyle = colorOf(line);
    pg.fillText(line.slice(0, 74), 24, 16 + i * lh);
  });
  const PW = 4.4;
  const PH = (PW * CH) / CW;
  const tex = new CanvasTexture(page);
  const pageMat = new MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.35, depthWrite: false, blending: AdditiveBlending });
  const pageMesh = new Mesh(new PlaneGeometry(PW, PH), pageMat);
  pageMesh.lookAt(camera.position);
  scene.add(pageMesh);

  // ---- Particles: start on lit text pixels, end on the mesh surface ----
  const N = Math.min(6000, Math.max(2500, m.vertexCount * 2));
  const img = pg.getImageData(0, 0, CW, CH).data;
  const lit: number[] = [];
  for (let y = 0; y < CH; y += 2) for (let x = 0; x < CW; x += 2) if (img[(y * CW + x) * 4 + 3] > 120) lit.push(x, y);
  const start = new Float32Array(N * 3);
  const col = new Float32Array(N * 3);
  const delay = new Float32Array(N);
  const tmp = new Vector3();
  const color = new Color();
  for (let i = 0; i < N; i++) {
    const k = lit.length ? Math.floor(Math.random() * (lit.length / 2)) * 2 : 0;
    const px = lit[k] ?? Math.random() * CW;
    const py = lit[k + 1] ?? Math.random() * CH;
    tmp.set((px / CW - 0.5) * PW, (0.5 - py / CH) * PH, 0).applyQuaternion(pageMesh.quaternion);
    start.set([tmp.x, tmp.y, tmp.z], i * 3);
    const o = ((py | 0) * CW + (px | 0)) * 4;
    color.setRGB(img[o] / 255, img[o + 1] / 255, img[o + 2] / 255);
    col.set([color.r, color.g, color.b], i * 3);
    delay[i] = px / CW * 0.7 + Math.random() * 0.3; // melt left → right, like reading
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(start, 3));
  geo.setAttribute('aStart', new BufferAttribute(start, 3));
  geo.setAttribute('aEnd', new BufferAttribute(surfaceSamples(m, N), 3));
  geo.setAttribute('aColor', new BufferAttribute(col, 3));
  geo.setAttribute('aDelay', new BufferAttribute(delay, 1));
  const uniforms = {
    uMix: { value: 0 },
    uTime: { value: 0 },
    uSize: { value: 5.5 * Math.min(window.devicePixelRatio || 1, 2) },
    uDim: { value: 1 },
    uEnd: { value: new Matrix4() },
  };
  const particles = new Points(
    geo,
    new ShaderMaterial({ vertexShader: PARTICLE_VS, fragmentShader: PARTICLE_FS, uniforms, transparent: true, depthWrite: false, blending: AdditiveBlending }),
  );
  particles.frustumCulled = false;
  scene.add(particles);

  // ---- The model group: unique vertices, normals, and a unit-sphere gizmo ----
  const pivot = new Group();
  const tilt = new Group();
  tilt.rotation.set(SHOWCASE_ROT_X, SHOWCASE_ROT_Y, 0);
  pivot.add(tilt);
  scene.add(pivot);
  const stepV = Math.max(1, Math.ceil(m.vertexCount / 3000));
  const nv = Math.ceil(m.vertexCount / stepV);
  const vpos = new Float32Array(nv * 3);
  const npos = new Float32Array(nv * 6);
  for (let i = 0, j = 0; i < m.vertexCount && j < nv; i += stepV, j++) {
    const p = m.positions.subarray(i * 3, i * 3 + 3);
    const n = m.normals.subarray(i * 3, i * 3 + 3);
    vpos.set(p, j * 3);
    npos.set([p[0], p[1], p[2], p[0] + n[0] * 0.1, p[1] + n[1] * 0.1, p[2] + n[2] * 0.1], j * 6);
  }
  const vg = new BufferGeometry();
  vg.setAttribute('position', new BufferAttribute(vpos, 3));
  const vMat = new ShaderMaterial({
    uniforms: { uOpacity: { value: 0 }, uSize: { value: 7 * Math.min(window.devicePixelRatio || 1, 2) } },
    vertexShader: 'uniform float uSize; void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = uSize * (3.2 / -mv.z); gl_Position = projectionMatrix * mv; }',
    fragmentShader: 'uniform float uOpacity; void main(){ float r = length(gl_PointCoord-0.5); if (r>0.5) discard; float a = smoothstep(0.5,0.1,r); gl_FragColor = vec4(vec3(1.0,0.95,0.8)*a, a*uOpacity); }',
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  const verts = new Points(vg, vMat);
  const ng = new BufferGeometry();
  ng.setAttribute('position', new BufferAttribute(npos, 3));
  const nMat = new LineBasicMaterial({ color: COLORS.magenta, transparent: true, opacity: 0, depthWrite: false, blending: AdditiveBlending });
  const normals = new LineSegments(ng, nMat);
  tilt.add(verts, normals);

  const gizmoMat = new LineBasicMaterial({ color: COLORS.green, transparent: true, opacity: 0, depthWrite: false });
  const gizmo = new LineSegments(new WireframeGeometry(new SphereGeometry(1, 24, 12)), gizmoMat);
  const axesGeo = new BufferGeometry();
  axesGeo.setAttribute('position', new BufferAttribute(new Float32Array([-1.3, 0, 0, 1.3, 0, 0, 0, -1.3, 0, 0, 1.3, 0, 0, 0, -1.3, 0, 0, 1.3]), 3));
  const axesMat = new LineBasicMaterial({ color: COLORS.amber, transparent: true, opacity: 0, depthWrite: false });
  const axes = new LineSegments(axesGeo, axesMat);
  scene.add(gizmo, axes);

  // "Raw" placement before normalization: offset + scaled like the file's own coordinates.
  const inv = 1 / m.normalizeScale;
  const rawScale = Math.min(1.45, Math.max(0.6, inv));
  const cLen = Math.hypot(...m.originalCenter);
  const rawOffset = cLen > 1e-6
    ? new Vector3(...m.originalCenter).multiplyScalar(Math.min(0.9, cLen * m.normalizeScale) / cLen)
    : new Vector3(0, 0, 0);
  if (rawOffset.length() < 0.05 && Math.abs(rawScale - 1) < 0.05) rawOffset.set(0, 0, 0);

  const state = { mix: 0, page: 0.35, dim: 1, verts: 0, nrm: 0, gizmo: 0, norm: 0 };
  const apply = () => {
    uniforms.uMix.value = state.mix;
    uniforms.uDim.value = state.dim;
    pageMat.opacity = state.page;
    vMat.uniforms.uOpacity.value = state.verts;
    nMat.opacity = state.nrm;
    gizmoMat.opacity = state.gizmo * 0.22;
    axesMat.opacity = state.gizmo * 0.6;
    const sc = rawScale + (1 - rawScale) * state.norm;
    pivot.scale.setScalar(sc);
    pivot.position.copy(rawOffset).multiplyScalar(1 - state.norm);
  };

  // HUD
  const hud = h('div.ps-hud');
  const view = {
    scene,
    camera,
    bloom: 0.9,
    bloomThreshold: 0.12,
    orbit: true,
    onFrame: (time: number, dt: number) => {
      stars.tick(time);
      uniforms.uTime.value = time;
      if (state.mix > 0.98) pivot.rotation.y += dt * 0.25;
      pivot.updateMatrixWorld(true);
      uniforms.uEnd.value.copy(tilt.matrixWorld);
    },
  };
  const stage = h('div.v-fill');
  host.append(stage, hud);
  ctx.stage.attach(stage, view);

  const targets = [
    { mix: 0, page: 0.35, dim: 1, verts: 0, nrm: 0, gizmo: 0, norm: 0 },
    { mix: 1, page: 0.0, dim: 0.85, verts: 0, nrm: 0, gizmo: 0, norm: 0 },
    { mix: 1, page: 0.0, dim: 0.22, verts: 1, nrm: 0.75, gizmo: 0, norm: 0 },
    { mix: 1, page: 0.0, dim: 0.3, verts: 0.9, nrm: 0.35, gizmo: 1, norm: 1 },
  ];
  const hudText = [
    L(`<b>${formatBytes(m.fileSize)}</b> text och bytes – ännu inga tal`, `<b>${formatBytes(m.fileSize)}</b> of text and bytes – no numbers yet`),
    L('Tecknen tolkas till <b>float32</b> – punkterna hittar sina platser', 'Characters are parsed into <b>float32</b> – the points find their places'),
    L(`<b>${m.vertexCount.toLocaleString('en-US')}</b> unika vertices · normaler <span class="c-nrm">${m.had.normals ? 'från filen' : 'genererade'}</span>`, `<b>${m.vertexCount.toLocaleString('en-US')}</b> unique vertices · normals <span class="c-nrm">${m.had.normals ? 'from the file' : 'generated'}</span>`),
    L(`Centrerad och skalad ×${m.normalizeScale.toPrecision(3)} in i <span style="color:var(--green)">enhetssfären</span>`, `Centered and scaled ×${m.normalizeScale.toPrecision(3)} into the <span style="color:var(--green)">unit sphere</span>`),
  ];
  let tween: gsap.core.Tween | null = null;

  return {
    show(step, animate) {
      tween?.kill();
      const target = targets[step];
      if (animate) {
        tween = gsap.to(state, { ...target, duration: dur(step === 1 ? 2.6 : 1.4), ease: step === 1 ? 'none' : 'power2.inOut', onUpdate: apply });
        gsap.fromTo(hud, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: dur(0.4) });
      } else {
        Object.assign(state, target);
        apply();
        if (step === 0) pivot.rotation.y = 0;
      }
      hud.innerHTML = t(hudText[step]);
    },
    destroy() {
      tween?.kill();
      gsap.killTweensOf(hud);
      if (ctx.stage.isAttachedTo(view)) ctx.stage.detach();
      disposeScene(scene);
      tex.dispose();
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
  data: dataVisual,
  concept: conceptVisual,
});
