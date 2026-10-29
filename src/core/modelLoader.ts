import { API_LIST, type ApiId, type AppState, type Store } from './state';
import { Derived } from './derived';
import { workers } from './workers';
import { BlendFileError, parseModel } from '../model/loadModel';
import type { LoadStage } from '../model/normalize';
import type { MeshData } from '../model/types';
import type { LoadingOverlay } from '../views/LoadingOverlay';

/**
 * Loads models without freezing the page: parsing and every heavy per-mesh computation run in
 * workers (falling back to the main thread if workers are unavailable), and the new model is
 * only switched in once its views are ready. Also defers API switches until that API's renders
 * are prepared.
 */
export class ModelLoader {
  private job = 0;
  derived: Derived;

  constructor(
    private store: Store,
    private overlay: LoadingOverlay,
  ) {
    this.derived = new Derived(store.state.mesh);
    // Anything else that swaps the mesh (e.g. the XR palette) still gets a fresh Derived.
    store.on((s, changed) => {
      if (changed.includes('mesh') && this.derived.mesh !== s.mesh) this.swapDerived(new Derived(s.mesh));
    });
    this.gateApiSwitches();
    // Warm the start model in the background.
    void this.derived.prepare(store.state.api).then(() => this.warmOthers(this.derived));
  }

  private swapDerived(d: Derived): void {
    const old = this.derived;
    this.derived = d;
    if (old !== d) old.dispose();
  }

  /** Switching API waits (briefly, in the background) until that API's renders exist. */
  private gateApiSwitches(): void {
    const raw = this.store.set.bind(this.store);
    this.store.set = (partial: Partial<AppState>) => {
      const api = partial.api;
      const d = this.derived;
      if (api && api !== this.store.state.api && !partial.mesh && !d.isReady(api)) {
        document.body.classList.add('busy');
        void d.prepare(api).then(() => {
          document.body.classList.remove('busy');
          if (this.derived === d) raw(partial);
        });
        return;
      }
      raw(partial);
    };
  }

  private warmOthers(d: Derived): void {
    // One API at a time so the current one's work isn't slowed down.
    const rest = API_LIST.map((a) => a.id).filter((a) => a !== this.store.state.api);
    void rest.reduce<Promise<void>>((p, api) => p.then(() => (this.derived === d ? d.prepare(api) : undefined)), Promise.resolve());
  }

  async loadFile(file: File): Promise<MeshData> {
    const job = ++this.job;
    this.overlay.start(file.name, true);
    try {
      this.overlay.stage('read');
      const bytes = await file.arrayBuffer();
      const onStage = (s: LoadStage) => job === this.job && this.overlay.stage(s);
      let mesh: MeshData;
      const pool = workers();
      if (pool.available && !/\.blend$/i.test(file.name)) {
        try {
          mesh = await pool.parse(file.name, bytes.slice(0), onStage);
        } catch (err) {
          console.warn('worker parse failed, parsing on the main thread', err);
          mesh = await parseModel(file.name, bytes, onStage);
        }
      } else {
        mesh = await parseModel(file.name, bytes, onStage);
      }
      if (job !== this.job) throw new Error('superseded');
      await this.switchTo(mesh, job);
      return mesh;
    } catch (err) {
      if (job === this.job) this.overlay.finish();
      if (err instanceof BlendFileError) throw err;
      throw err;
    }
  }

  async loadMesh(mesh: MeshData, label: string): Promise<void> {
    const job = ++this.job;
    this.overlay.start(label, false);
    await this.switchTo(mesh, job);
  }

  private async switchTo(mesh: MeshData, job: number): Promise<void> {
    const d = new Derived(mesh);
    const api = this.store.state.api;
    await d.prepare(api, (done, total) => job === this.job && this.overlay.prepareProgress(done, total));
    if (job !== this.job) {
      d.dispose();
      throw new Error('superseded');
    }
    this.swapDerived(d);
    this.store.set({ mesh });
    this.overlay.finish();
    this.warmOthers(d);
  }

  /** For tests: whether `api` is fully prepared for the current model. */
  isReady(api: ApiId): boolean {
    return this.derived.isReady(api);
  }
}
