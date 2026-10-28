import type { ApiId, Lang, Mode } from '../core/state';

/** Everything the floating XR panel shows. */
export interface PanelInfo {
  group: string;
  title: string;
  bullet: string;
  step: number;
  steps: number;
  index: number;
  total: number;
  api: ApiId;
  mode: Mode;
  lang: Lang;
  facts: string[];
}

export type PanelAction = 'prev' | 'next' | 'api:opengl' | 'api:vulkan' | 'api:d3d12' | 'mode' | 'exit';

export interface Region {
  action: PanelAction;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Canvas size of the panel texture (pixels). The mesh keeps the same aspect ratio. */
export const PANEL_W = 1024;
export const PANEL_H = 640;

/** The button row at the bottom of the panel. */
export function panelRegions(info: Pick<PanelInfo, 'lang' | 'mode'>): Region[] {
  const sv = info.lang === 'sv';
  const y = PANEL_H - 96;
  const hgt = 72;
  const defs: [PanelAction, string, number][] = [
    ['prev', '‹', 90],
    ['next', '›', 90],
    ['api:opengl', 'OpenGL', 150],
    ['api:vulkan', 'Vulkan', 140],
    ['api:d3d12', 'DX12', 110],
    ['mode', info.mode === 'data' ? (sv ? 'Koncept' : 'Concept') : sv ? 'Data' : 'Data', 150],
    ['exit', sv ? 'Avsluta' : 'Exit', 140],
  ];
  const gap = 12;
  const total = defs.reduce((a, d) => a + d[2], 0) + gap * (defs.length - 1);
  let x = (PANEL_W - total) / 2;
  return defs.map(([action, label, w]) => {
    const r = { action, label, x, y, w, h: hgt };
    x += w + gap;
    return r;
  });
}

/** Which button is at texture coordinate (u, v)? `v` = 0 at the bottom, like three.js UVs. */
export function hitTest(regions: Region[], u: number, v: number): PanelAction | null {
  const x = u * PANEL_W;
  const y = (1 - v) * PANEL_H;
  const r = regions.find((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
  return r ? r.action : null;
}

/** Greedy word wrap with a pluggable text measurer (canvas in the app, char count in tests). */
export function wrapText(text: string, maxWidth: number, measure: (s: string) => number, maxLines = 5): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (measure(test) <= maxWidth || !line) line = test;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const cut = lines.slice(0, maxLines);
    cut[maxLines - 1] = cut[maxLines - 1].replace(/\s*\S*$/, '') + ' …';
    return cut;
  }
  return lines;
}

/**
 * Thumbstick → action, with a latch so holding the stick fires once.
 * Left/right switches API, up/down switches mode.
 */
export function axisAction(x: number, y: number, latched: boolean): { action: 'api-next' | 'api-prev' | 'mode' | null; latched: boolean } {
  const mag = Math.max(Math.abs(x), Math.abs(y));
  if (mag < 0.35) return { action: null, latched: false };
  if (latched || mag < 0.75) return { action: null, latched };
  if (Math.abs(x) >= Math.abs(y)) return { action: x > 0 ? 'api-next' : 'api-prev', latched: true };
  return { action: 'mode', latched: true };
}
