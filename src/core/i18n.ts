import type { Lang } from './state';

/** A bilingual string. Slides keep their own text inline as `L` values. */
export interface L {
  sv: string;
  en: string;
}

export type Text = L | string;

export const L = (sv: string, en: string): L => ({ sv, en });

export function tr(text: Text, lang: Lang): string {
  return typeof text === 'string' ? text : text[lang];
}

/** Shared UI strings (top bar, bottom bar, common labels). */
export const UI = {
  loadFile: L('Ladda fil…', 'Load file…'),
  dropHint: L('Släpp en OBJ-, glTF/GLB- eller STL-fil här', 'Drop an OBJ, glTF/GLB or STL file here'),
  builtin: L('Inbyggda', 'Built-in'),
  api: L('API', 'API'),
  modeData: L('Verklig data', 'Real data'),
  modeConcept: L('Koncept', 'Concept'),
  prev: L('Föregående', 'Previous'),
  next: L('Nästa', 'Next'),
  step: L('Steg', 'Step'),
  vertices: L('Vertices', 'Vertices'),
  triangles: L('Trianglar', 'Triangles'),
  attributes: L('Attribut', 'Attributes'),
  fileSize: L('Filstorlek', 'File size'),
  loading: L('Laddar modell…', 'Loading model…'),
  loadError: L('Kunde inte ladda filen', 'Could not load the file'),
  youWrite: L('Du skriver', 'You write'),
  driverDoes: L('Drivrutinen gör', 'The driver does'),
  gpuDoes: L('GPU:n gör', 'The GPU does'),
  stageCpu: L('Applikation (CPU)', 'Application (CPU)'),
  stageApi: L('API / drivrutin', 'API / driver'),
  stageGpuProg: L('GPU – programmerbar', 'GPU – programmable'),
  stageGpuFixed: L('GPU – fast funktion', 'GPU – fixed function'),
  code: L('Kod', 'Code'),
  terms: L('Begrepp', 'Terms'),
  keysHint: L('← → bläddra · M byt läge · 1/2/3 byt API', '← → navigate · M switch mode · 1/2/3 switch API'),
};
