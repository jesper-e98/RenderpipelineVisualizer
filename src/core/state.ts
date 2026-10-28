import type { MeshData } from '../model/types';

export type ApiId = 'opengl' | 'vulkan' | 'd3d12';
export type Mode = 'data' | 'concept';
export type Lang = 'sv' | 'en';

export const API_LIST: { id: ApiId; label: string; version: string }[] = [
  { id: 'opengl', label: 'OpenGL', version: '4.6' },
  { id: 'vulkan', label: 'Vulkan', version: '1.3' },
  { id: 'd3d12', label: 'DirectX 12', version: 'Ultimate' },
];

export interface AppState {
  mesh: MeshData;
  api: ApiId;
  mode: Mode;
  lang: Lang;
}

type Listener = (state: AppState, changed: (keyof AppState)[]) => void;

/** Tiny observable store. Slides subscribe through the SlideEngine. */
export class Store {
  private listeners = new Set<Listener>();
  constructor(public state: AppState) {}

  set(partial: Partial<AppState>): void {
    const changed = (Object.keys(partial) as (keyof AppState)[]).filter(
      (k) => partial[k] !== this.state[k],
    );
    if (!changed.length) return;
    this.state = { ...this.state, ...partial };
    for (const k of changed) if (k !== 'mesh') savePref(k, String(this.state[k]));
    this.listeners.forEach((fn) => fn(this.state, changed));
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export function loadPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem('rpv.' + key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function savePref(key: string, value: string): void {
  try {
    localStorage.setItem('rpv.' + key, value);
  } catch {
    /* storage may be unavailable (private mode); preferences are optional */
  }
}
