import {
  BufferGeometry,
  Group,
  HemisphereLight,
  GridHelper,
  Line,
  LineBasicMaterial,
  Raycaster,
  Scene,
  Vector3,
  type XRTargetRaySpace,
} from 'three';
import { h } from '../core/dom';
import { L, tr } from '../core/i18n';
import { API_LIST, type Store } from '../core/state';
import type { SlideEngine } from '../core/SlideEngine';
import { shadedMesh, starfield } from '../views/three-helpers';
import type { ThreeStage } from '../views/ThreeStage';
import { axisAction, hitTest, type PanelAction, type PanelInfo } from './panelLayout';
import { XRPanel } from './XRPanel';

type XRMode = 'immersive-vr' | 'immersive-ar';

/** Model scale in XR: the normalized model (radius 1) becomes ~0.5 m across. */
const MODEL_SCALE = 0.25;

/**
 * WebXR support: VR/AR buttons, placing the current slide's 3D scene in front of the user,
 * a floating text panel, and controller / hand input for navigating the slides.
 */
export class XRController {
  private session: XRSession | null = null;
  private mode: XRMode = 'immersive-vr';
  private panel = new XRPanel();
  private env = new Group();
  private controllers: XRTargetRaySpace[] = [];
  private raycaster = new Raycaster();
  private placed = false;
  private latch = new Map<number, boolean>();
  private fallbackScene: Scene | null = null;
  private fallbackMesh: unknown = null;
  private buttons: HTMLButtonElement[] = [];

  constructor(
    private stage: ThreeStage,
    private engine: SlideEngine,
    private store: Store,
  ) {
    const world = stage.xrWorld;
    stage.xrAnchor.scale.setScalar(MODEL_SCALE);
    world.add(this.panel.mesh, this.env);
    this.panel.mesh.visible = false;
    this.env.visible = false;
    const floor = new GridHelper(16, 32, 0x9b7bff, 0x2a2f5a);
    (floor.material as LineBasicMaterial).transparent = true;
    (floor.material as LineBasicMaterial).opacity = 0.5;
    const stars = starfield(1400, 30);
    stars.position.y = 1.5;
    this.env.add(floor, stars, new HemisphereLight(0xffffff, 0x223, 1));
    stage.xrFrame = (dt) => this.frame(dt);
    stage.xrFallback = () => this.fallback();
    engine.onChange(() => this.refreshSoon());
    store.on(() => this.refreshSoon());
  }

  /** Add VR / AR buttons to `container` for the session types this browser supports. */
  async mountButtons(container: HTMLElement): Promise<void> {
    const xr = (navigator as Navigator & { xr?: XRSystem }).xr;
    if (!xr || !this.stage.renderer) return;
    for (const mode of ['immersive-vr', 'immersive-ar'] as XRMode[]) {
      let ok = false;
      try {
        ok = await xr.isSessionSupported(mode);
      } catch {
        ok = false;
      }
      if (!ok) continue;
      const b = h('button.btn.xr-btn', {
        text: mode === 'immersive-vr' ? 'VR' : 'AR',
        dataset: { mode },
        attrs: { title: mode === 'immersive-vr' ? 'Virtual reality' : 'Augmented reality' },
        on: { click: () => (this.session ? this.session.end() : this.start(mode)) },
      });
      this.buttons.push(b);
      container.append(b);
    }
  }

  async start(mode: XRMode): Promise<void> {
    const xr = (navigator as Navigator & { xr?: XRSystem }).xr;
    const renderer = this.stage.renderer;
    if (!xr || !renderer || this.session) return;
    try {
      const session = await xr.requestSession(mode, { optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'] });
      this.mode = mode;
      this.session = session;
      renderer.xr.setReferenceSpaceType('local-floor');
      await renderer.xr.setSession(session);
      session.addEventListener('end', () => this.onEnd());
      this.onStart();
    } catch (err) {
      console.warn('Could not start XR session', err);
      window.dispatchEvent(new CustomEvent('rpv:toast', { detail: String((err as Error).message ?? err) }));
    }
  }

  private onStart(): void {
    const renderer = this.stage.renderer!;
    this.placed = false;
    this.env.visible = this.mode === 'immersive-vr';
    this.stage.xrHideTagged = this.mode === 'immersive-ar';
    this.panel.mesh.visible = true;
    for (let i = 0; i < 2; i++) {
      const c = renderer.xr.getController(i);
      const ray = new Line(
        new BufferGeometry().setFromPoints([new Vector3(0, 0, 0), new Vector3(0, 0, -1)]),
        new LineBasicMaterial({ color: 0x38e1ff, transparent: true, opacity: 0.8 }),
      );
      ray.scale.z = 3;
      c.add(ray);
      c.addEventListener('select', () => this.onSelect(c));
      c.addEventListener('squeeze', () => this.engine.prev());
      this.stage.xrWorld.add(c);
      this.controllers.push(c);
    }
    this.buttons.forEach((b) => b.classList.toggle('on', b.dataset.mode === this.mode));
    document.body.classList.add('xr-presenting');
    this.refresh();
  }

  private onEnd(): void {
    this.session = null;
    for (const c of this.controllers) c.removeFromParent();
    this.controllers = [];
    this.panel.mesh.visible = false;
    this.env.visible = false;
    this.stage.xrHideTagged = false;
    this.stage.endXR();
    this.buttons.forEach((b) => b.classList.remove('on'));
    document.body.classList.remove('xr-presenting');
  }

  private onSelect(c: XRTargetRaySpace): void {
    const action = this.panelActionFor(c);
    if (action) this.run(action);
    else this.engine.next();
  }

  private panelActionFor(c: XRTargetRaySpace): PanelAction | null {
    this.raycaster.setFromXRController(c);
    const hit = this.raycaster.intersectObject(this.panel.mesh, false)[0];
    if (!hit?.uv) return null;
    return hitTest(this.panel.regions, hit.uv.x, hit.uv.y);
  }

  private run(action: PanelAction): void {
    if (action === 'next') this.engine.next();
    else if (action === 'prev') this.engine.prev();
    else if (action === 'mode') this.store.set({ mode: this.store.state.mode === 'data' ? 'concept' : 'data' });
    else if (action === 'exit') this.session?.end();
    else this.store.set({ api: action.slice(4) as never });
  }

  /** Place the model and panel in front of the user on the first XR frame. */
  private place(): void {
    const cam = this.stage.renderer!.xr.getCamera();
    const head = new Vector3();
    cam.getWorldPosition(head);
    const dir = new Vector3();
    cam.getWorldDirection(dir);
    dir.y = 0;
    if (dir.lengthSq() < 1e-4) dir.set(0, 0, -1);
    dir.normalize();
    const anchor = this.stage.xrAnchor;
    const y = Math.max(0.9, head.y - 0.2);
    anchor.position.copy(head).addScaledVector(dir, 1.0).setY(y);
    anchor.lookAt(head.x, y, head.z);
    // Panel to the left of the model, turned towards the user.
    const left = new Vector3().crossVectors(new Vector3(0, 1, 0), dir).normalize();
    this.panel.mesh.position.copy(anchor.position).addScaledVector(left, 0.72).addScaledVector(dir, -0.2).setY(y + 0.05);
    this.panel.mesh.lookAt(head.x, y + 0.05, head.z);
    this.env.position.set(head.x, 0, head.z);
    this.placed = true;
  }

  private frame(_dt: number): void {
    if (!this.placed) this.place();
    // Hover feedback on the panel.
    let hover: PanelAction | null = null;
    for (const c of this.controllers) hover ??= this.panelActionFor(c);
    this.panel.setHover(hover);
    // Thumbsticks.
    const sources = this.session?.inputSources ?? [];
    let i = 0;
    for (const src of sources) {
      const gp = src.gamepad;
      if (!gp || gp.axes.length < 4) continue;
      const res = axisAction(gp.axes[2], gp.axes[3], this.latch.get(i) ?? false);
      this.latch.set(i, res.latched);
      if (res.action === 'mode') this.run('mode');
      else if (res.action) {
        const idx = API_LIST.findIndex((a) => a.id === this.store.state.api);
        const next = API_LIST[(idx + (res.action === 'api-next' ? 1 : API_LIST.length - 1)) % API_LIST.length];
        this.store.set({ api: next.id });
      }
      i++;
    }
  }

  private refreshT = 0;
  private refreshSoon(): void {
    if (!this.session) return;
    clearTimeout(this.refreshT);
    this.refresh();
    // The new slide's DOM appears a moment later; draw again once it's there.
    this.refreshT = window.setTimeout(() => this.refresh(), 250);
  }

  private refresh(): void {
    if (!this.session) return;
    this.panel.draw(this.info());
  }

  /** Read what the panel should show from the live slide DOM. */
  private info(): PanelInfo {
    const s = this.store.state;
    const slide = document.querySelector('.slide:not(.leaving)');
    const def = this.engine.slides[this.engine.index];
    const facts = Array.from(slide?.querySelectorAll<HTMLElement>('.ms-panel:not(.collapsed) .stat') ?? [])
      .filter((st) => st.offsetParent !== null)
      .slice(0, 3)
      .map((st) => `${st.querySelector('.v')?.textContent ?? ''}  ${st.querySelector('.k')?.textContent ?? ''}`.trim());
    return {
      group: def.group,
      title: slide?.querySelector('.title')?.textContent ?? tr(def.title, s.lang),
      bullet: slide?.querySelector('.bullet.current')?.textContent ?? tr(L('Tryck på avtryckaren för att gå vidare.', 'Pull the trigger to continue.'), s.lang),
      step: this.engine.step,
      steps: def.steps,
      index: this.engine.index,
      total: this.engine.slides.length,
      api: s.api,
      mode: s.mode,
      lang: s.lang,
      facts,
    };
  }

  /** Shown when the current slide has no 3D scene of its own. */
  private fallback(): Scene {
    if (this.fallbackScene && this.fallbackMesh === this.store.state.mesh) return this.fallbackScene;
    const scene = new Scene();
    scene.add(shadedMesh(this.store.state.mesh));
    this.fallbackScene = scene;
    this.fallbackMesh = this.store.state.mesh;
    return scene;
  }
}
