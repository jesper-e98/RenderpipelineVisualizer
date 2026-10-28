import type { Text } from '../core/i18n';
import type { ApiId, AppState } from '../core/state';
import type { Derived } from '../core/derived';
import type { ThreeStage } from '../views/ThreeStage';

/** Where in the pipeline a stage runs. Drives colors in the mini-map and badges. */
export type StageGroup = 'cpu' | 'api' | 'gpu-prog' | 'gpu-fixed';

export interface SlideContext {
  state: AppState;
  t: (text: Text) => string;
  stage: ThreeStage;
  derived: Derived;
  /** Change app state (model, API, mode, language). The slide is rebuilt afterwards. */
  set: (partial: Partial<AppState>) => void;
}

/** A live slide. Created fresh whenever the slide is entered or app state changes. */
export interface SlideInstance {
  el: HTMLElement;
  /** Show sub-step `step`. `animate` is false when jumping straight to a step. */
  show(step: number, animate: boolean): void;
  destroy(): void;
}

export interface SlideDef {
  id: string;
  group: StageGroup;
  /** Short label for the pipeline mini-map. */
  short: Text;
  title: Text;
  steps: number;
  create(ctx: SlideContext): SlideInstance;
}

/** A code snippet in the API panel. `highlight[step]` lists 1-based line numbers to emphasize. */
export interface CodeSnippet {
  title?: Text;
  lang: 'cpp' | 'glsl' | 'hlsl';
  src: string;
  highlight?: number[][];
}

export interface ApiPanelSpec {
  /** One short paragraph: how this API handles the stage. */
  note: Text;
  code: CodeSnippet[];
  terms?: { term: string; desc: Text }[];
  /** Who does the work here – shown as chips. */
  you?: Text;
  driver?: Text;
}

/** The visual part of a slide, one per mode. */
export interface Visual {
  show(step: number, animate: boolean): void;
  destroy(): void;
}

export type VisualFactory = (host: HTMLElement, ctx: SlideContext) => Visual;

export interface StandardSlideSpec {
  id: string;
  group: StageGroup;
  short: Text;
  title: Text;
  lead: Text;
  /** Bullet i becomes visible at step i. The slide has max(bullets.length, 1) steps unless `steps` is set. */
  bullets: Text[];
  steps?: number;
  /** Per-API panel. May be a function so code can include the loaded model's real numbers. */
  api?: Record<ApiId, ApiPanelSpec> | ((ctx: SlideContext) => Record<ApiId, ApiPanelSpec>);
  /** Hide the API panel in this mode (for slides that are all visual). */
  apiPanel?: 'both' | 'data' | 'concept' | 'none';
  data: VisualFactory;
  concept: VisualFactory;
}
