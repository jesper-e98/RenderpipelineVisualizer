import type { ApiId, Lang, Mode } from '../core/state';

/** Everything the console's info screen shows. */
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

/** Canvas width of the info screen texture (pixels); the height follows the mesh's aspect ratio. */
export const PANEL_W = 1024;

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
