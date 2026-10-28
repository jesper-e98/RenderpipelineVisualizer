import type { Matrix4 } from 'three';
import { h, num } from '../core/dom';
import { rows } from '../pipeline/transform';
import type { VertexLayout } from '../pipeline/layout';

/** A 4×4 matrix as a bracketed grid. */
export function matrixEl(m: Matrix4, digits = 3, cls = ''): HTMLElement {
  return h(`div.matrix${cls ? '.' + cls : ''}`, {}, rows(m).flat().map((v) => h('span', { text: num(v, digits) })));
}

/** A vector like ( 0.123  0.456 −0.789  1.000 ). */
export function vecEl(v: readonly number[], digits = 3, cls = ''): HTMLElement {
  return h(`span.vec${cls ? '.' + cls : ''}`, {}, ['(', ...v.map((x) => h('span', { text: num(x, digits) })), ')']);
}

export function stat(value: string, key: string, cls = ''): HTMLElement {
  return h('div.stat', {}, [h(`div.v${cls ? '.' + cls : ''}`, { text: value }), h('div.k', { text: key })]);
}

export function card(title: string, children: (Node | string)[], cls = ''): HTMLElement {
  return h(`div.card${cls ? '.' + cls : ''}`, {}, [h('h4', { text: title }), ...children]);
}

const ATTR_CLASS = { position: 'pos', normal: 'nrm', uv: 'uv' } as const;

/**
 * Hex view of the interleaved vertex buffer: one row per vertex, bytes colored by attribute.
 * Returns the rows so callers can animate them.
 */
export function memoryView(layout: VertexLayout, count: number, baseAddress = 0x1000_0000): { el: HTMLElement; rows: HTMLElement[] } {
  const bytes = new Uint8Array(layout.vertexBuffer);
  const n = Math.min(count, bytes.length / layout.stride);
  const rowEls: HTMLElement[] = [];
  for (let v = 0; v < n; v++) {
    const cells: HTMLElement[] = [];
    for (const a of layout.attributes) {
      for (let b = 0; b < a.components * 4; b++) {
        const off = v * layout.stride + a.offset + b;
        cells.push(h(`span.mem-cell.${ATTR_CLASS[a.name]}`, { text: bytes[off].toString(16).padStart(2, '0') }));
      }
    }
    rowEls.push(
      h('div.mem-row', {}, [h('span.mem-addr', { text: '0x' + (baseAddress + v * layout.stride).toString(16).padStart(8, '0') }), ...cells]),
    );
  }
  return { el: h('div.mem', {}, rowEls), rows: rowEls };
}

/** The index buffer as a row of colored cells. */
export function indexView(indices: Uint32Array, count: number): HTMLElement {
  const n = Math.min(count, indices.length);
  const cells: HTMLElement[] = [];
  for (let i = 0; i < n; i++) {
    const cell = h('span.mem-cell.idx', { text: String(indices[i]) });
    if (i % 3 === 2) cell.style.marginRight = '8px';
    cells.push(cell);
  }
  return h('div.mem.idx-row', { style: { display: 'flex', flexWrap: 'wrap', gap: '2px' } }, cells);
}
