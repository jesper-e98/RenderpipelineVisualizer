import { PerspectiveCamera, Scene, Timer, Vector2, WebGLRenderer, type Camera } from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export interface StageView {
  scene: Scene;
  camera: PerspectiveCamera;
  /** Bloom strength (0 or undefined = off). */
  bloom?: number;
  /** Luminance above which pixels glow (0..1, default 0.2). Use ~0.7 for lit, solid meshes. */
  bloomThreshold?: number;
  /** Let the user orbit the camera by dragging. */
  orbit?: boolean;
  /** Called every frame before rendering. `t` = seconds since attach. */
  onFrame?: (t: number, dt: number) => void;
  /** Called when the host is resized. */
  onResize?: (width: number, height: number) => void;
}

/**
 * One shared WebGL renderer for the whole app (browsers limit WebGL contexts). The canvas is
 * moved into whichever slide is active; the slide that leaves keeps a frozen snapshot so the
 * slide transition still looks right.
 */
export class ThreeStage {
  readonly renderer: WebGLRenderer | null;
  private composer?: EffectComposer;
  private renderPass?: RenderPass;
  private bloomPass?: UnrealBloomPass;
  private labels = new CSS2DRenderer();
  private clock = new Timer();
  private current: { host: HTMLElement; view: StageView; ro: ResizeObserver; controls?: OrbitControls; t: number } | null = null;
  private wrap = document.createElement('div');

  constructor() {
    let renderer: WebGLRenderer | null = null;
    try {
      renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setClearColor(0x000000, 0);
      this.renderPass = new RenderPass(new Scene(), new PerspectiveCamera());
      this.bloomPass = new UnrealBloomPass(new Vector2(256, 256), 0.8, 0.5, 0.15);
      this.composer = new EffectComposer(renderer);
      this.composer.addPass(this.renderPass);
      this.composer.addPass(this.bloomPass);
      this.composer.addPass(new OutputPass());
    } catch (err) {
      console.warn('WebGL unavailable – 3D views are disabled', err);
    }
    this.renderer = renderer;
    this.wrap.className = 'three-wrap';
    if (renderer) this.wrap.append(renderer.domElement);
    this.labels.domElement.className = 'three-labels';
    this.wrap.append(this.labels.domElement);
    renderer?.setAnimationLoop(() => this.frame());
  }

  /** Put the 3D canvas into `host` and start rendering `view`. */
  attach(host: HTMLElement, view: StageView): void {
    this.detach();
    if (!this.renderer) {
      host.append(Object.assign(document.createElement('div'), { className: 'no-webgl', textContent: 'WebGL 2 is not available in this browser.' }));
      return;
    }
    host.append(this.wrap);
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(host);
    let controls: OrbitControls | undefined;
    if (view.orbit) {
      controls = new OrbitControls(view.camera, this.labels.domElement);
      controls.enableDamping = true;
      controls.enablePan = false;
      controls.minDistance = 1.5;
      controls.maxDistance = 12;
    }
    this.current = { host, view, ro, controls, t: 0 };
    this.renderPass!.scene = view.scene;
    this.renderPass!.camera = view.camera;
    this.bloomPass!.enabled = !!view.bloom;
    this.bloomPass!.strength = view.bloom ?? 0;
    this.bloomPass!.threshold = view.bloomThreshold ?? 0.2;
    this.clock.update();
    this.resize();
    this.frame();
  }

  /** Stop rendering into the current host, leaving a still image behind. */
  detach(): void {
    const cur = this.current;
    if (!cur) return;
    this.current = null;
    cur.ro.disconnect();
    cur.controls?.dispose();
    const canvas = this.renderer!.domElement;
    try {
      // Render once more and copy synchronously (the drawing buffer is still valid).
      this.render(cur.view);
      const snap = document.createElement('canvas');
      snap.className = 'three-snapshot';
      snap.width = canvas.width;
      snap.height = canvas.height;
      snap.getContext('2d')?.drawImage(canvas, 0, 0);
      cur.host.append(snap);
    } catch {
      /* snapshot is cosmetic */
    }
    this.wrap.remove();
    this.labels.domElement.replaceChildren();
  }

  isAttachedTo(view: StageView): boolean {
    return this.current?.view === view;
  }

  private resize(): void {
    const cur = this.current;
    if (!cur || !this.renderer) return;
    const w = Math.max(1, cur.host.clientWidth);
    const h = Math.max(1, cur.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.composer!.setSize(w, h);
    this.labels.setSize(w, h);
    cur.view.camera.aspect = w / h;
    cur.view.camera.updateProjectionMatrix();
    cur.view.onResize?.(w, h);
  }

  private render(view: StageView): void {
    if (view.bloom) this.composer!.render();
    else this.renderer!.render(view.scene, view.camera as Camera);
    this.labels.render(view.scene, view.camera);
  }

  private frame(): void {
    const cur = this.current;
    this.clock.update();
    const dt = Math.min(this.clock.getDelta(), 0.1);
    if (!cur) return;
    cur.t += dt;
    cur.view.onFrame?.(cur.t, dt);
    cur.controls?.update();
    this.render(cur.view);
  }
}
